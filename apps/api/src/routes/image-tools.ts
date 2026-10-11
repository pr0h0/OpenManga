import { eq, panels } from "@openmanga/db";
import {
  cleanSketch,
  extendCanvas,
  fullMask,
  InvalidImageError,
  lineArt,
  paletteTransfer,
  upscale,
} from "@openmanga/image-utils";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess } from "../lib/access.ts";
import { AiChoiceInput, assertBudget, checkImageChoice } from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * Image tools on a panel's artwork. Upscale, line art and palette transfer run here, without AI and at no cost.
 * Repair, relight, background removal, colourising, expression edits and outpainting are masked edits (panel_edit
 * jobs) with a mask made for the tool. Every tool makes a new artwork version; the one before stays in the history.
 */
export const imageToolRoutes = new Hono<AppEnv>();

const ASPECTS = { "9:16": 9 / 16, "16:9": 16 / 9, "1:1": 1, "4:5": 4 / 5, "2:3": 2 / 3 } as const;

export const ToolInput = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("upscale") }),
  z.object({ tool: z.literal("lineart") }),
  z.object({
    tool: z.literal("palette"),
    paletteAssetId: z.string().uuid(),
    strength: z.number().min(0.1).max(1).default(1),
  }),
  z.object({ tool: z.literal("repair"), ai: AiChoiceInput }),
  z.object({ tool: z.literal("relight"), light: z.string().trim().min(3).max(300), ai: AiChoiceInput }),
  z.object({ tool: z.literal("background"), ai: AiChoiceInput }),
  z.object({ tool: z.literal("colorize"), ai: AiChoiceInput }),
  z.object({
    tool: z.literal("expression"),
    character: z.string().trim().min(1).max(120),
    expression: z.string().trim().min(2).max(200),
    ai: AiChoiceInput,
  }),
  z.object({
    tool: z.literal("outpaint"),
    aspect: z.enum(Object.keys(ASPECTS) as [keyof typeof ASPECTS]),
    ai: AiChoiceInput,
  }),
]);
export type ToolInput = z.infer<typeof ToolInput>;

/** The edit instruction each AI tool sends (inside the panel-edit template, which keeps identity and style). */
function instruction(t: Exclude<ToolInput, { tool: "upscale" | "lineart" | "palette" }>) {
  switch (t.tool) {
    case "repair":
      return "Repair the faces, hands and small details: fix malformed features, fused or extra fingers, smudged eyes and broken small objects. Keep every pose, expression, outfit, colour and the composition exactly as they are.";
    case "relight":
      return `Relight the whole image: ${t.light}. Keep every figure, pose, expression, outfit, object and the composition unchanged; change only the light, the shadows and the colour of the light.`;
    case "background":
      return "Remove the background: replace everything behind the figures and foreground objects with a plain flat white background. Keep the figures and objects exactly as they are, with clean edges.";
    case "colorize":
      return "Colourise this black-and-white artwork in full colour: skin, hair, eye and outfit colours as in the character references, and light colour that fits the scene. Keep every line, shape and the composition exactly as they are.";
    case "expression":
      return `Change ${t.character}'s facial expression to: ${t.expression}. Keep their identity, pose and outfit and everything else in the image unchanged.`;
    case "outpaint":
      return "Extend the scene into the grey areas around the original picture: continue the setting, the light and the perspective seamlessly, with no new characters and no frame or border. The original picture in the middle stays exactly as it is.";
  }
}

doc({
  method: "POST",
  path: "/api/panels/:id/tools",
  summary:
    "Run an image tool on the panel's active artwork; the result is a new artwork version, made active. Without AI (returns the new version at once): upscale (2x), lineart (black lines on white), palette (the colours of another project image, paletteAssetId). As a masked edit (returns a panel_edit job; spends image credits): repair (faces, hands, details), relight (light), background (plain white), colorize, expression (character, expression), outpaint (aspect 9:16, 16:9, 1:1, 4:5 or 2:3: the picture widened instead of cropped).",
  tag: "panels",
  body: ToolInput,
});
imageToolRoutes.post("/panels/:id/tools", async (c) => {
  const panelId = uuidParam(c, "id");
  const input = await body(c, ToolInput);
  const ai = "ai" in input;
  const project = await entityAccess(c, "panel", panelId, ai ? "generate" : "write");
  const deps = c.get("deps");
  const [panel] = await deps.db.select().from(panels).where(eq(panels.id, panelId));
  if (!panel) throw notFound("Panel");
  if (panel.approvalStatus === "locked") throw conflict("Panel is locked");
  if (!panel.activeArtworkAssetId) throw conflict("The panel has no artwork yet");
  const source = await deps.assets.get(panel.activeArtworkAssetId);
  if (!source || source.deletedAt) throw notFound("Artwork");
  const data = await deps.assets.read(source);
  const store = async (
    img: { data: Uint8Array; mime: string; width: number; height: number },
    type: "panel_art" | "panel_mask" | "source_image",
    meta: Record<string, unknown>,
  ) =>
    deps.assets.store({
      projectId: project.id,
      ownerUserId: user(c).id,
      type,
      data: img.data,
      mimeType: img.mime,
      width: img.width,
      height: img.height,
      parentAssetId: source.id,
      metadata: meta,
    });

  try {
    if (input.tool === "upscale" || input.tool === "lineart" || input.tool === "palette") {
      let out: Awaited<ReturnType<typeof upscale>>;
      if (input.tool === "palette") {
        const pal = await deps.assets.get(input.paletteAssetId);
        if (!pal || pal.projectId !== project.id || pal.deletedAt || !pal.mimeType.startsWith("image/"))
          throw notFound("Palette image");
        out = await paletteTransfer(data, await deps.assets.read(pal), input.strength);
      } else out = input.tool === "upscale" ? await upscale(data) : await lineArt(data);
      const asset = await store(out, "panel_art", { panelId, tool: input.tool, uploaded: false });
      await deps.assets.ensureThumbnail(asset).catch(() => {});
      await deps.db
        .update(panels)
        .set({ activeArtworkAssetId: asset.id, status: "ready" })
        .where(eq(panels.id, panelId));
      await recordAudit(deps.db, {
        userId: user(c).id,
        projectId: project.id,
        action: `panel.tool.${input.tool}`,
        targetType: "panel",
        targetId: panelId,
        metadata: { assetId: asset.id, from: source.id },
        requestId: c.get("requestId"),
      });
      return c.json({ asset: { id: asset.id, width: asset.width, height: asset.height } }, 201);
    }

    // A masked edit: the whole picture, or for outpainting a wider canvas with only the new area to paint.
    await assertBudget(c, project.id);
    await checkImageChoice(c, input.ai);
    let sourceAssetId = source.id;
    let mask: Awaited<ReturnType<typeof fullMask>>;
    if (input.tool === "outpaint") {
      const ext = await extendCanvas(data, ASPECTS[input.aspect]);
      const canvas = await store(ext.canvas, "source_image", {
        panelId,
        role: "outpaint_canvas",
        aspect: input.aspect,
      });
      sourceAssetId = canvas.id;
      mask = ext.mask;
    } else mask = await fullMask(source.width ?? 1024, source.height ?? 1024);
    const maskAsset = await store(mask, "panel_mask", { panelId, tool: input.tool });
    const job = await deps.planner.enqueueEdit(panelId, user(c).id, {
      maskAssetId: maskAsset.id,
      instruction: instruction(input),
      operation: input.tool,
      sourceAssetId,
      ai: input.ai,
    });
    await deps.jobs.kick();
    return c.json({ job }, 202);
  } catch (e) {
    if (e instanceof InvalidImageError) throw badRequest(e.message);
    throw e;
  }
});

const GuideTool = z.object({ tool: z.enum(["clean", "lineart"]) });
doc({
  method: "POST",
  path: "/api/panels/:id/guide/tools",
  summary:
    "Tidy the panel's layout guide without AI: clean (a rough sketch to solid black strokes on white) or lineart (the lines of a picture used as a guide). The guide then points at the new image; the old one stays in the project.",
  tag: "panels",
  body: GuideTool,
});
imageToolRoutes.post("/panels/:id/guide/tools", async (c) => {
  const panelId = uuidParam(c, "id");
  const project = await entityAccess(c, "panel", panelId, "write");
  const { tool } = await body(c, GuideTool);
  const deps = c.get("deps");
  const [panel] = await deps.db.select().from(panels).where(eq(panels.id, panelId));
  if (!panel?.guide) throw conflict("The panel has no layout guide");
  if (panel.approvalStatus === "locked") throw conflict("Panel is locked");
  const g = await deps.assets.get(panel.guide.assetId);
  if (!g || g.deletedAt) throw notFound("Guide image");
  const out =
    tool === "clean" ? await cleanSketch(await deps.assets.read(g)) : await lineArt(await deps.assets.read(g));
  const asset = await deps.assets.store({
    projectId: project.id,
    ownerUserId: user(c).id,
    type: "source_image",
    data: out.data,
    mimeType: out.mime,
    width: out.width,
    height: out.height,
    parentAssetId: g.id,
    metadata: { role: "panel_guide", panelId, tool },
  });
  await deps.assets.ensureThumbnail(asset).catch(() => {});
  const [next] = await deps.db
    .update(panels)
    .set({ guide: { ...panel.guide, assetId: asset.id } })
    .where(eq(panels.id, panelId))
    .returning();
  return c.json({ panel: next }, 201);
});
