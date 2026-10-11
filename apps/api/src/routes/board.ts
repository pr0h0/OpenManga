import {
  and,
  asc,
  assets,
  boardItems,
  characterOutfits,
  characterVersions,
  desc,
  eq,
  generationJobs,
  inArray,
  locationStates,
  locationVersions,
  panels,
  projectStyles,
  propVersions,
  sql,
} from "@openmanga/db";
import { recordAudit } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { readImageUpload } from "../lib/uploads.ts";
import { storeReference } from "./references.ts";

/**
 * The reference board: a project's collected images for mood and look. Each can become a draft reference (character,
 * outfit, location or one of its states, prop, style) or a panel's layout guide, and can be described for one aspect
 * through POST /api/assets/:id/describe.
 */
export const boardRoutes = new Hono<AppEnv>();

const MAX_ITEMS = 300;

const items = (c: Context<AppEnv>, projectId: string) =>
  c
    .get("deps")
    .db.select({ item: boardItems, width: assets.width, height: assets.height, mimeType: assets.mimeType })
    .from(boardItems)
    .innerJoin(assets, eq(assets.id, boardItems.assetId))
    .where(and(eq(boardItems.projectId, projectId), sql`${assets.deletedAt} is null`))
    .orderBy(asc(boardItems.order), asc(boardItems.createdAt));

doc({
  method: "GET",
  path: "/api/projects/:projectId/board",
  summary:
    "The project's reference board: its images in order, each with its note and the newest description of it (an image_describe job: status, aspects and, once done, the description).",
  tag: "assets",
});
boardRoutes.get("/projects/:projectId/board", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const rows = await items(c, p.id);
  const ids = rows.map((r) => r.item.assetId);
  const described = ids.length
    ? await c
        .get("deps")
        .db.selectDistinctOn([generationJobs.targetId], {
          assetId: generationJobs.targetId,
          jobId: generationJobs.id,
          status: generationJobs.status,
          input: generationJobs.input,
          result: generationJobs.result,
        })
        .from(generationJobs)
        .where(and(eq(generationJobs.kind, "image_describe"), inArray(generationJobs.targetId, ids)))
        .orderBy(generationJobs.targetId, desc(generationJobs.createdAt))
    : [];
  return c.json({
    items: rows.map((r) => {
      const d = described.find((x) => x.assetId === r.item.assetId);
      return {
        ...r.item,
        width: r.width,
        height: r.height,
        described: d
          ? {
              jobId: d.jobId,
              status: d.status,
              aspects: (d.input as { aspects?: string[] }).aspects ?? [],
              description: (d.result as { description?: unknown } | null)?.description ?? null,
            }
          : null,
      };
    }),
  });
});

const AddExisting = z.object({ assetId: z.string().uuid(), note: z.string().trim().max(1000).default("") });
doc({
  method: "POST",
  path: "/api/projects/:projectId/board",
  summary:
    "Add an image to the board: upload one (multipart: file, optional note), or name an image already in the project ({ assetId, note }).",
  tag: "assets",
  body: AddExisting,
});
boardRoutes.post("/projects/:projectId/board", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const deps = c.get("deps");
  const [n] = await deps.db
    .select({ n: sql<number>`count(*)::int`, max: sql<number>`coalesce(max(${boardItems.order}), 0)::int` })
    .from(boardItems)
    .where(eq(boardItems.projectId, p.id));
  if ((n?.n ?? 0) >= MAX_ITEMS) throw badRequest(`A board holds at most ${MAX_ITEMS} images`);
  let assetId: string;
  let note = "";
  if (c.req.header("content-type")?.includes("multipart/form-data")) {
    const up = await readImageUpload(c);
    note = String(up.form.get("note") ?? "").slice(0, 1000);
    const asset = await deps.assets.store({
      projectId: p.id,
      ownerUserId: user(c).id,
      type: "source_image",
      data: up.data,
      mimeType: up.mime,
      width: up.width,
      height: up.height,
      metadata: { uploaded: true, originalName: up.originalName, role: "board" },
    });
    await deps.assets.ensureThumbnail(asset).catch(() => {});
    assetId = asset.id;
  } else {
    const input = await body(c, AddExisting);
    const a = await deps.assets.get(input.assetId);
    if (!a || a.projectId !== p.id || a.deletedAt) throw notFound("Image");
    if (!a.mimeType.startsWith("image/")) throw badRequest("That asset is not an image");
    assetId = a.id;
    note = input.note;
  }
  const [row] = await deps.db
    .insert(boardItems)
    .values({ projectId: p.id, assetId, note, order: (n?.max ?? 0) + 1, createdByUserId: user(c).id })
    .returning();
  return c.json({ item: row }, 201);
});

async function itemFor(c: Context<AppEnv>, id: string, action: "write" | "read" = "write") {
  const [row] = await c.get("deps").db.select().from(boardItems).where(eq(boardItems.id, id));
  if (!row) throw notFound("Board item");
  return { row, project: await projectAccess(c, row.projectId, action) };
}

const Patch = z.object({ note: z.string().trim().max(1000) });
doc({
  method: "PATCH",
  path: "/api/board-items/:id",
  summary: "Edit a board image's note",
  tag: "assets",
  body: Patch,
});
boardRoutes.patch("/board-items/:id", async (c) => {
  const { row } = await itemFor(c, uuidParam(c, "id"));
  const { note } = await body(c, Patch);
  const [next] = await c.get("deps").db.update(boardItems).set({ note }).where(eq(boardItems.id, row.id)).returning();
  return c.json({ item: next });
});

doc({
  method: "DELETE",
  path: "/api/board-items/:id",
  summary: "Take an image off the board (the image itself stays in the project's assets).",
  tag: "assets",
});
boardRoutes.delete("/board-items/:id", async (c) => {
  const { row } = await itemFor(c, uuidParam(c, "id"));
  await c.get("deps").db.delete(boardItems).where(eq(boardItems.id, row.id));
  return c.json({ ok: true });
});

const OrderInput = z.object({ ids: z.array(z.string().uuid()).min(1).max(MAX_ITEMS) });
doc({
  method: "POST",
  path: "/api/projects/:projectId/board/order",
  summary: "Put the board in this order: every item id, once.",
  tag: "assets",
  body: OrderInput,
});
boardRoutes.post("/projects/:projectId/board/order", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const { ids } = await body(c, OrderInput);
  const { db } = c.get("deps");
  const have = (await db.select({ id: boardItems.id }).from(boardItems).where(eq(boardItems.projectId, p.id))).map(
    (r) => r.id,
  );
  if (ids.length !== have.length || new Set(ids).size !== ids.length || ids.some((id) => !have.includes(id)))
    throw badRequest("Send every board item exactly once");
  await db.execute(
    sql`update board_items b set "order" = v.o from (values ${sql.join(
      ids.map((id, i) => sql`(${id}::uuid, ${i + 1}::int)`),
      sql`, `,
    )}) as v(id, o) where b.id = v.id`,
  );
  return c.json({ ok: true });
});

export const UseInput = z.discriminatedUnion("target", [
  z.object({ target: z.literal("character"), versionId: z.string().uuid() }),
  z.object({ target: z.literal("outfit"), versionId: z.string().uuid(), outfitId: z.string().uuid() }),
  z.object({
    target: z.literal("location"),
    versionId: z.string().uuid(),
    locationStateId: z.string().uuid().optional(),
  }),
  z.object({ target: z.literal("prop"), versionId: z.string().uuid() }),
  z.object({ target: z.literal("style"), styleId: z.string().uuid() }),
  z.object({
    target: z.literal("guide"),
    panelId: z.string().uuid(),
    strength: z.enum(["loose", "strict"]).default("loose"),
  }),
]);
doc({
  method: "POST",
  path: "/api/board-items/:id/use",
  summary:
    "Drop a board image onto something: a draft reference of a character version, of one of its outfits, of a location version (or one of its states), of a prop version or of a project style — approve it like any reference — or a panel's layout guide (loose or strict). The board keeps the image.",
  tag: "assets",
  body: UseInput,
});
boardRoutes.post("/board-items/:id/use", async (c) => {
  const { row, project } = await itemFor(c, uuidParam(c, "id"));
  const input = await body(c, UseInput);
  const deps = c.get("deps");
  const a = await deps.assets.get(row.assetId);
  if (!a || a.deletedAt) throw notFound("Image");
  const same = (projectId: string) => {
    if (projectId !== project.id) throw badRequest("That belongs to another project");
  };
  if (input.target === "guide") {
    const p = await entityAccess(c, "panel", input.panelId, "write");
    same(p.id);
    const [pn] = await deps.db.select().from(panels).where(eq(panels.id, input.panelId));
    if (pn!.approvalStatus === "locked") throw conflict("Panel is locked");
    const [next] = await deps.db
      .update(panels)
      .set({ guide: { assetId: a.id, strength: input.strength, pose: pn!.guide?.pose ?? "" } })
      .where(eq(panels.id, pn!.id))
      .returning();
    await recordAudit(deps.db, {
      userId: user(c).id,
      projectId: project.id,
      action: "panel.guide",
      targetType: "panel",
      targetId: pn!.id,
      metadata: { fromBoard: row.id },
      requestId: c.get("requestId"),
    });
    return c.json({ panel: next });
  }
  // A reference: checked against its version (live, this project) and stored as its own asset of the subject's type.
  const subject = input.target === "outfit" ? "character" : input.target;
  let versionId: string;
  if (input.target === "style") {
    const [s] = await deps.db.select().from(projectStyles).where(eq(projectStyles.id, input.styleId));
    if (!s) throw notFound("Style");
    same(s.projectId);
    versionId = s.id;
  } else {
    const kind =
      subject === "character" ? "character_version" : subject === "location" ? "location_version" : "prop_version";
    same((await entityAccess(c, kind, input.versionId, "write")).id);
    const table =
      subject === "character" ? characterVersions : subject === "location" ? locationVersions : propVersions;
    const [v] = await deps.db.select({ status: table.status }).from(table).where(eq(table.id, input.versionId));
    if (v?.status === "superseded") throw conflict("That version is superseded");
    versionId = input.versionId;
  }
  if (input.target === "outfit") {
    const [o] = await deps.db
      .select({ id: characterOutfits.id })
      .from(characterOutfits)
      .innerJoin(characterVersions, eq(characterVersions.characterId, characterOutfits.characterId))
      .where(and(eq(characterOutfits.id, input.outfitId), eq(characterVersions.id, input.versionId)));
    if (!o) throw badRequest("That outfit belongs to another character");
  }
  if (input.target === "location" && input.locationStateId) {
    const [s] = await deps.db
      .select({ id: locationStates.id })
      .from(locationStates)
      .innerJoin(locationVersions, eq(locationVersions.locationId, locationStates.locationId))
      .where(and(eq(locationStates.id, input.locationStateId), eq(locationVersions.id, input.versionId)));
    if (!s) throw badRequest("That state belongs to another location");
  }
  const { ref } = await storeReference(
    c,
    subject,
    versionId,
    project.id,
    {
      data: await deps.assets.read(a),
      mime: a.mimeType,
      width: a.width ?? 0,
      height: a.height ?? 0,
      originalName: (a.metadata as { originalName?: string } | null)?.originalName ?? null,
    },
    {
      kind: input.target === "outfit" ? "outfit" : "uploaded",
      outfitId: input.target === "outfit" ? input.outfitId : null,
      locationStateId: input.target === "location" ? (input.locationStateId ?? null) : null,
      from: { fromBoard: row.id, boardAssetId: a.id },
    },
  );
  return c.json({ reference: ref }, 201);
});
