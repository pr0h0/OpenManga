import {
  and,
  asc,
  assets,
  chapters,
  characters,
  characterVersions,
  type Database,
  desc,
  dialogueLines,
  eq,
  generationJobs,
  generationOutputs,
  inArray,
  isNull,
  locations,
  locationVersions,
  narrationLines,
  pages,
  panelSpecs,
  panels,
  props,
  propVersions,
  soundEffects,
  sql,
} from "@openmanga/db";
import {
  applySfxDefaults,
  applyTypeStyle,
  clampFrame,
  defaultTailTarget,
  draftBubble,
  faceAvoidZone,
  layoutByKey,
  PRIORITY,
  placeBubble,
  refitBubble,
  resolveLettering,
  splitFrame,
  swapTemplate,
  templateFrames,
} from "@openmanga/domain";
import { panelCheckV1, panelPromptsV3 } from "@openmanga/prompts";
import {
  asPatch,
  Bubble,
  CameraAngle,
  Frame,
  ImageTransform,
  PanelSeam,
  PanelSpec,
  SfxStyle,
  ShotType,
} from "@openmanga/schemas";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import {
  AiChoiceInput,
  assertBatchable,
  assertBudget,
  BatchInput,
  batchParameters,
  checkImageChoice,
  queueTextBatchSubmit,
  textRun,
} from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { readImageUpload } from "../lib/uploads.ts";

export const pageRoutes = new Hono<AppEnv>();

const emptySpec = (beat = ""): PanelSpec =>
  PanelSpec.parse({ beat: beat || "New panel", shotType: "medium", cameraAngle: "eye-level" });

async function loadPageProject(
  c: Parameters<typeof projectAccess>[0],
  pageId: string,
  action: "read" | "write" | "generate",
) {
  const project = await entityAccess(c, "page", pageId, action);
  const [page] = await c.get("deps").db.select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw notFound("Page");
  return { project, page };
}

async function loadPanel(
  c: Parameters<typeof projectAccess>[0],
  panelId: string,
  action: "read" | "write" | "generate",
) {
  const project = await entityAccess(c, "panel", panelId, action);
  const [row] = await c
    .get("deps")
    .db.select({ panel: panels, page: pages })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .where(eq(panels.id, panelId));
  if (!row) throw notFound("Panel");
  return { project, ...row };
}

const CreatePage = z.object({
  layoutTemplate: z.string().max(64).default("four-grid"),
  sceneId: z.string().uuid().nullable().default(null),
  afterPageId: z.string().uuid().optional(),
});
doc({
  method: "POST",
  path: "/api/chapters/:id/pages",
  summary: "Add a page with a deterministic layout template",
  tag: "pages",
  body: CreatePage,
});
pageRoutes.post("/chapters/:id/pages", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "write");
  const input = await body(c, CreatePage);
  if (!layoutByKey(input.layoutTemplate)) throw badRequest("Unknown layout template");
  const { db } = c.get("deps");
  const s = project.settings;
  const page = await db.transaction(async (tx) => {
    const existing = await tx.select().from(pages).where(eq(pages.chapterId, chapterId)).orderBy(asc(pages.order));
    const after = input.afterPageId ? existing.find((p) => p.id === input.afterPageId) : existing.at(-1);
    const order = (after?.order ?? 0) + 1;
    await tx
      .update(pages)
      .set({ order: sql`${pages.order} + 1` })
      .where(and(eq(pages.chapterId, chapterId), sql`${pages.order} >= ${order}`));
    const [pg] = await tx
      .insert(pages)
      .values({
        projectId: project.id,
        chapterId,
        sceneId: input.sceneId,
        order,
        layoutTemplate: input.layoutTemplate,
        width: s.pageWidth,
        height: s.pageHeight,
      })
      .returning();
    const frames = templateFrames(input.layoutTemplate, {
      margin: s.pageMargin,
      gutter: s.pageGutter,
      readingDirection: project.readingDirection,
    });
    for (const [i, frame] of frames.entries()) {
      const [pn] = await tx
        .insert(panels)
        .values({ projectId: project.id, pageId: pg!.id, sceneId: input.sceneId, order: i + 1, frame })
        .returning();
      await tx.insert(panelSpecs).values({ panelId: pn!.id, versionNumber: 1, spec: emptySpec(), source: "user" });
    }
    return pg!;
  });
  return c.json({ page }, 201);
});

doc({
  method: "GET",
  path: "/api/pages/:id",
  summary: "Page editor document: panels, specs, bubbles, SFX, narration boxes",
  tag: "pages",
});
pageRoutes.get("/pages/:id", async (c) => {
  const { page, project } = await loadPageProject(c, uuidParam(c, "id"), "read");
  const { db } = c.get("deps");
  const pns = await db.select().from(panels).where(eq(panels.pageId, page.id)).orderBy(asc(panels.order));
  const ids = pns.map((p) => p.id);
  const specs = ids.length
    ? await db.execute<{ panel_id: string; spec: PanelSpec; version_number: number }>(
        sql`select distinct on (panel_id) panel_id, spec, version_number from panel_specs where panel_id in (${sql.join(
          ids.map((i) => sql`${i}`),
          sql`, `,
        )}) order by panel_id, version_number desc`,
      )
    : [];
  const artIds = pns.map((p) => p.activeArtworkAssetId).filter((x): x is string => Boolean(x));
  const arts = artIds.length
    ? await db
        .select({ id: assets.id, width: assets.width, height: assets.height, createdAt: assets.createdAt })
        .from(assets)
        .where(inArray(assets.id, artIds))
    : [];
  const dialogue = await db
    .select()
    .from(dialogueLines)
    .where(eq(dialogueLines.pageId, page.id))
    .orderBy(asc(dialogueLines.order));
  const sfx = await db.select().from(soundEffects).where(eq(soundEffects.pageId, page.id));
  const narration = await db
    .select()
    .from(narrationLines)
    .where(eq(narrationLines.pageId, page.id))
    .orderBy(asc(narrationLines.order));
  const activeJobs = ids.length
    ? await db
        .select({
          id: generationJobs.id,
          targetId: generationJobs.targetId,
          status: generationJobs.status,
          kind: generationJobs.kind,
          failureReason: generationJobs.failureReason,
        })
        .from(generationJobs)
        .where(
          and(
            inArray(generationJobs.targetId, ids),
            inArray(generationJobs.status, ["queued", "processing", "cancel_requested", "failed"]),
          ),
        )
        .orderBy(desc(generationJobs.createdAt))
    : [];
  const siblings = await db
    .select({ id: pages.id, order: pages.order })
    .from(pages)
    .where(eq(pages.chapterId, page.chapterId))
    .orderBy(asc(pages.order));
  const [chapter] = await db
    .select({ id: chapters.id, title: chapters.title, order: chapters.order })
    .from(chapters)
    .where(eq(chapters.id, page.chapterId));
  const cast = await db
    .select({ id: characters.id, name: characters.name, currentVersionId: characters.currentVersionId })
    .from(characters)
    .where(and(eq(characters.projectId, project.id), isNull(characters.deletedAt)));
  return c.json({
    page,
    chapter,
    siblings,
    readingDirection: page.readingDirection ?? project.readingDirection,
    panels: pns.map((p) => ({
      ...p,
      spec: [...specs].find((s) => s.panel_id === p.id)?.spec ?? null,
      specVersion: [...specs].find((s) => s.panel_id === p.id)?.version_number ?? 0,
      artwork: arts.find((a) => a.id === p.activeArtworkAssetId) ?? null,
      latestJob: activeJobs.find((j) => j.targetId === p.id) ?? null,
    })),
    dialogue,
    sfx,
    narration,
    cast,
  });
});

const PatchPage = z.object({
  purpose: z.string().max(2000).optional(),
  pacing: z.string().max(500).optional(),
  visualEmphasis: z.string().max(2000).optional(),
  pageTurnHook: z.string().max(2000).optional(),
  width: z.number().int().min(256).max(8000).optional(),
  height: z.number().int().min(256).max(20000).optional(),
  readingDirection: z.enum(["ltr", "rtl", "vertical"]).nullable().optional(),
  status: z.enum(["draft", "approved", "locked", "superseded"]).optional(),
  sceneId: z.string().uuid().nullable().optional(),
  order: z.number().int().min(1).optional(),
});
doc({
  method: "PATCH",
  path: "/api/pages/:id",
  summary: "Edit page plan / approve page",
  tag: "pages",
  body: PatchPage,
});
pageRoutes.patch("/pages/:id", async (c) => {
  const { page } = await loadPageProject(c, uuidParam(c, "id"), "write");
  const input = await body(c, PatchPage);
  if (page.status === "locked" && input.status !== "superseded" && Object.keys(input).some((k) => k !== "status"))
    throw conflict("Page is locked");
  const { db } = c.get("deps");
  const row = await db.transaction(async (tx) => {
    if (input.order && input.order !== page.order) {
      const all = await tx.select().from(pages).where(eq(pages.chapterId, page.chapterId)).orderBy(asc(pages.order));
      const without = all.filter((p) => p.id !== page.id);
      without.splice(Math.min(input.order - 1, without.length), 0, page);
      for (const [i, p] of without.entries())
        await tx
          .update(pages)
          .set({ order: i + 1 })
          .where(eq(pages.id, p.id));
    }
    const { order: _o, ...rest } = input;
    const [r] = await tx.update(pages).set(rest).where(eq(pages.id, page.id)).returning();
    return r;
  });
  return c.json({ page: row });
});

doc({ method: "DELETE", path: "/api/pages/:id", summary: "Delete page", tag: "pages" });
pageRoutes.delete("/pages/:id", async (c) => {
  const { page, project } = await loadPageProject(c, uuidParam(c, "id"), "write");
  const { db } = c.get("deps");
  await db.transaction(async (tx) => {
    await tx.delete(pages).where(eq(pages.id, page.id));
    const rest = await tx.select().from(pages).where(eq(pages.chapterId, page.chapterId)).orderBy(asc(pages.order));
    for (const [i, p] of rest.entries())
      await tx
        .update(pages)
        .set({ order: i + 1 })
        .where(eq(pages.id, p.id));
  });
  await recordAudit(db, {
    userId: user(c).id,
    projectId: project.id,
    action: "page.delete",
    targetId: page.id,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

const SwapLayout = z.object({ layoutTemplate: z.string().max(64) });
doc({
  method: "POST",
  path: "/api/pages/:id/layout",
  summary: "Swap layout template (keeps panels, adds empty ones if needed)",
  tag: "pages",
  body: SwapLayout,
});
pageRoutes.post("/pages/:id/layout", async (c) => {
  const { page, project } = await loadPageProject(c, uuidParam(c, "id"), "write");
  const { layoutTemplate } = await body(c, SwapLayout);
  const tpl = layoutByKey(layoutTemplate);
  if (!tpl) throw badRequest("Unknown layout template");
  const { db } = c.get("deps");
  const s = project.settings;
  const opts = {
    margin: s.pageMargin,
    gutter: s.pageGutter,
    readingDirection: page.readingDirection ?? project.readingDirection,
  };
  await db.transaction(async (tx) => {
    const pns = await tx.select().from(panels).where(eq(panels.pageId, page.id)).orderBy(asc(panels.order));
    const frames = swapTemplate(pns, layoutTemplate, opts);
    for (const [i, p] of pns.entries()) await tx.update(panels).set({ frame: frames[i]! }).where(eq(panels.id, p.id));
    const all = templateFrames(layoutTemplate, opts);
    for (let i = pns.length; i < all.length; i++) {
      const [pn] = await tx
        .insert(panels)
        .values({ projectId: project.id, pageId: page.id, sceneId: page.sceneId, order: i + 1, frame: all[i]! })
        .returning();
      await tx.insert(panelSpecs).values({ panelId: pn!.id, versionNumber: 1, spec: emptySpec(), source: "user" });
    }
    await tx.update(pages).set({ layoutTemplate }).where(eq(pages.id, page.id));
  });
  return c.json({ ok: true });
});

const DocumentPatch = z.object({
  panels: z
    .array(
      z.object({
        id: z.string().uuid(),
        frame: Frame.optional(),
        imageTransform: ImageTransform.optional(),
        order: z.number().int().min(1).optional(),
      }),
    )
    .max(50)
    .default([]),
  dialogue: z
    .array(
      z.object({
        id: z.string().uuid(),
        bubble: Bubble.optional(),
        text: z.string().max(2000).optional(),
        panelId: z.string().uuid().nullable().optional(),
      }),
    )
    .max(200)
    .default([]),
  sfx: z
    .array(z.object({ id: z.string().uuid(), style: SfxStyle.optional(), text: z.string().max(100).optional() }))
    .max(200)
    .default([]),
  narration: z
    .array(
      z.object({ id: z.string().uuid(), box: Bubble.nullable().optional(), text: z.string().max(5000).optional() }),
    )
    .max(200)
    .default([]),
});
doc({
  method: "PATCH",
  path: "/api/pages/:id/document",
  summary: "Persist editor changes (drag/resize/reorder/text commit) atomically",
  tag: "pages",
  body: DocumentPatch,
});
pageRoutes.patch("/pages/:id/document", async (c) => {
  const { page } = await loadPageProject(c, uuidParam(c, "id"), "write");
  if (page.status === "locked") throw conflict("Page is locked");
  const input = await body(c, DocumentPatch);
  const { db } = c.get("deps");
  await db.transaction(async (tx) => {
    for (const p of input.panels) {
      const set: Partial<typeof panels.$inferInsert> = {};
      if (p.frame) set.frame = clampFrame(p.frame);
      if (p.imageTransform) set.imageTransform = p.imageTransform;
      if (p.order) set.order = p.order;
      if (Object.keys(set).length)
        await tx
          .update(panels)
          .set(set)
          .where(and(eq(panels.id, p.id), eq(panels.pageId, page.id)));
    }
    for (const d of input.dialogue) {
      const set: Partial<typeof dialogueLines.$inferInsert> = {};
      if (d.bubble) set.bubble = d.bubble;
      if (d.text !== undefined) set.text = d.text;
      if (d.panelId !== undefined) set.panelId = d.panelId;
      if (Object.keys(set).length)
        await tx
          .update(dialogueLines)
          .set(set)
          .where(and(eq(dialogueLines.id, d.id), eq(dialogueLines.pageId, page.id)));
    }
    for (const s of input.sfx) {
      const set: Partial<typeof soundEffects.$inferInsert> = {};
      if (s.style) set.style = s.style;
      if (s.text !== undefined) set.text = s.text;
      if (Object.keys(set).length)
        await tx
          .update(soundEffects)
          .set(set)
          .where(and(eq(soundEffects.id, s.id), eq(soundEffects.pageId, page.id)));
    }
    for (const n of input.narration) {
      const set: Partial<typeof narrationLines.$inferInsert> = {};
      if (n.box !== undefined) set.box = n.box;
      if (n.text !== undefined) set.text = n.text;
      if (Object.keys(set).length)
        await tx
          .update(narrationLines)
          .set(set)
          .where(and(eq(narrationLines.id, n.id), eq(narrationLines.pageId, page.id)));
    }
    await tx.update(pages).set({ updatedAt: new Date() }).where(eq(pages.id, page.id));
  });
  return c.json({ ok: true });
});

const AddPanel = z.object({ frame: Frame.optional(), duplicateOf: z.string().uuid().optional() });
doc({
  method: "POST",
  path: "/api/pages/:id/panels",
  summary: "Add or duplicate a panel",
  tag: "panels",
  body: AddPanel,
});
pageRoutes.post("/pages/:id/panels", async (c) => {
  const { page, project } = await loadPageProject(c, uuidParam(c, "id"), "write");
  const input = await body(c, AddPanel);
  const { db } = c.get("deps");
  const created = await db.transaction(async (tx) => {
    const [max] = await tx
      .select({ n: sql<number>`coalesce(max(${panels.order}),0)::int` })
      .from(panels)
      .where(eq(panels.pageId, page.id));
    const order = (max?.n ?? 0) + 1;
    if (input.duplicateOf) {
      const [src] = await tx
        .select()
        .from(panels)
        .where(and(eq(panels.id, input.duplicateOf), eq(panels.projectId, project.id)));
      if (!src) throw notFound("Panel");
      const [spec] = await tx
        .select()
        .from(panelSpecs)
        .where(eq(panelSpecs.panelId, src.id))
        .orderBy(desc(panelSpecs.versionNumber))
        .limit(1);
      const f = src.frame;
      const frame = input.frame ?? clampFrame({ ...f, x: f.x + 0.03, y: f.y + 0.03 });
      const [pn] = await tx
        .insert(panels)
        .values({
          ...src,
          id: undefined,
          pageId: page.id,
          order,
          frame,
          status: src.activeArtworkAssetId ? "ready" : "planned",
          approvalStatus: "draft",
          createdAt: undefined,
          updatedAt: undefined,
        })
        .returning();
      await tx.insert(panelSpecs).values({
        panelId: pn!.id,
        versionNumber: 1,
        spec: { ...(spec?.spec ?? emptySpec()), dialogueIds: [], narrationIds: [], sfxIds: [] },
        source: "user",
      });
      return pn!;
    }
    const frame = input.frame ?? { x: 0.3, y: 0.4, width: 0.4, height: 0.2 };
    const [pn] = await tx
      .insert(panels)
      .values({ projectId: project.id, pageId: page.id, sceneId: page.sceneId, order, frame: clampFrame(frame) })
      .returning();
    await tx.insert(panelSpecs).values({ panelId: pn!.id, versionNumber: 1, spec: emptySpec(), source: "user" });
    await tx.update(pages).set({ layoutTemplate: null }).where(eq(pages.id, page.id));
    return pn!;
  });
  return c.json({ panel: created }, 201);
});

const Reorder = z.object({ panelIds: z.array(z.string().uuid()).min(1).max(50) });
doc({
  method: "POST",
  path: "/api/pages/:id/reorder-panels",
  summary: "Set panel reading order",
  tag: "panels",
  body: Reorder,
});
pageRoutes.post("/pages/:id/reorder-panels", async (c) => {
  const { page } = await loadPageProject(c, uuidParam(c, "id"), "write");
  const { panelIds } = await body(c, Reorder);
  const { db } = c.get("deps");
  await db.transaction(async (tx) => {
    for (const [i, id] of panelIds.entries())
      await tx
        .update(panels)
        .set({ order: i + 1 })
        .where(and(eq(panels.id, id), eq(panels.pageId, page.id)));
  });
  return c.json({ ok: true });
});

doc({
  method: "POST",
  path: "/api/pages/:id/prepare-prompts",
  summary: "Queue DeepSeek prompt preparation for all panels on the page",
  tag: "panels",
});
pageRoutes.post("/pages/:id/prepare-prompts", async (c) => {
  const { page, project } = await loadPageProject(c, uuidParam(c, "id"), "generate");
  const { ai, batch } = await body(c, z.object({ ai: AiChoiceInput, batch: BatchInput }));
  const deps = c.get("deps");
  await assertBudget(c, project.id);
  const run = await textRun(c, ai);
  assertBatchable(c, batch, run.provider);
  const promptsBatchId = batch ? crypto.randomUUID() : null;
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(
      tx,
      {
        projectId: project.id,
        userId: user(c).id,
        kind: "page_prompts",
        priority: PRIORITY.single,
        targetType: "page",
        targetId: page.id,
        batchId: promptsBatchId,
        templateName: panelPromptsV3.name,
        templateVersion: panelPromptsV3.version,
        provider: run.provider,
        model: run.model,
        parameters: { ...run.parameters, ...batchParameters(batch) },
        input: { pageId: page.id },
      },
      { enqueue: !batch },
    ),
  );
  if (promptsBatchId) await queueTextBatchSubmit(c, { projectId: project.id, batchId: promptsBatchId, ai });
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

// ---------------------------------------------------------------- panels

doc({
  method: "GET",
  path: "/api/panels/:id",
  summary: "Panel detail: spec history, artwork versions, jobs",
  tag: "panels",
});
pageRoutes.get("/panels/:id", async (c) => {
  const { panel, page } = await loadPanel(c, uuidParam(c, "id"), "read");
  const { db } = c.get("deps");
  const specs = await db
    .select()
    .from(panelSpecs)
    .where(eq(panelSpecs.panelId, panel.id))
    .orderBy(desc(panelSpecs.versionNumber));
  const jobs = await db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.targetId, panel.id))
    .orderBy(desc(generationJobs.createdAt))
    .limit(50);
  const versions = await artworkVersions(db, panel.id, panel.projectId);
  const charVersions = panel.characterVersionIds.length
    ? await db
        .select({
          id: characterVersions.id,
          versionNumber: characterVersions.versionNumber,
          status: characterVersions.status,
          characterId: characters.id,
          name: characters.name,
        })
        .from(characterVersions)
        .innerJoin(characters, eq(characters.id, characterVersions.characterId))
        .where(inArray(characterVersions.id, panel.characterVersionIds))
    : [];
  return c.json({ panel, page, specs, jobs, versions, characters: charVersions });
});

async function artworkVersions(db: Database, panelId: string, projectId: string) {
  const rows = await db
    .select({
      asset: assets,
      jobKind: generationJobs.kind,
      jobId: generationJobs.id,
      operation: sql<string | null>`${generationJobs.parameters}->>'operation'`,
      prompt: generationJobs.compiledPrompt,
    })
    .from(assets)
    .leftJoin(generationJobs, eq(generationJobs.id, assets.generationJobId))
    .where(
      and(
        eq(assets.projectId, projectId),
        eq(assets.type, "panel_art"),
        isNull(assets.deletedAt),
        sql`${assets.metadata}->>'panelId' = ${panelId}`,
      ),
    )
    .orderBy(desc(assets.createdAt));
  return rows.map((r, i) => ({
    versionNumber: rows.length - i,
    assetId: r.asset.id,
    width: r.asset.width,
    height: r.asset.height,
    parentAssetId: r.asset.parentAssetId,
    createdAt: r.asset.createdAt,
    status: r.asset.status,
    generationJobId: r.jobId,
    kind: r.jobKind,
    operation: r.operation,
    cancelled: r.asset.metadata.cancelled === true,
  }));
}

const PatchPanel = z.object({
  frame: Frame.optional(),
  imageTransform: ImageTransform.optional(),
  shotType: ShotType.optional(),
  cameraAngle: CameraAngle.nullable().optional(),
  storyBeat: z.string().max(2000).optional(),
  locationVersionId: z.string().uuid().nullable().optional(),
  characterVersionIds: z.array(z.string().uuid()).max(12).optional(),
  propVersionIds: z.array(z.string().uuid()).max(12).optional(),
  promptOverride: z.string().max(32_000).nullable().optional(),
  /** Vertical strips: how this panel meets the one before it. Null clears it back to the project's plain gap. */
  seam: PanelSeam.nullable().optional(),
  /** Clear-only: prepared prompt text is written by the text model, never authored by hand through this route. */
  promptDraft: z.null().optional(),
  approvalStatus: z.enum(["draft", "approved", "locked", "superseded"]).optional(),
  sceneId: z.string().uuid().nullable().optional(),
});
doc({
  method: "PATCH",
  path: "/api/panels/:id",
  summary: "Edit panel fields, cast, location, prompt override, approval",
  tag: "panels",
  body: PatchPanel,
});
pageRoutes.patch("/panels/:id", async (c) => {
  const { panel, project } = await loadPanel(c, uuidParam(c, "id"), "write");
  const input = await body(c, PatchPanel);
  if (panel.approvalStatus === "locked" && (input.approvalStatus === undefined || Object.keys(input).length > 1))
    throw conflict("Panel is locked");
  const { db } = c.get("deps");
  if (input.characterVersionIds?.length) {
    const found = await db
      .select({ id: characterVersions.id })
      .from(characterVersions)
      .innerJoin(characters, eq(characters.id, characterVersions.characterId))
      .where(and(inArray(characterVersions.id, input.characterVersionIds), eq(characters.projectId, project.id)));
    if (found.length !== new Set(input.characterVersionIds).size) throw badRequest("Unknown character version");
  }
  // Same check for the other two: an unscoped id here ends up in the compiled prompt (and in the references sent
  // to the model), which would read another project's location or prop description back to the caller.
  if (input.locationVersionId) {
    const [found] = await db
      .select({ id: locationVersions.id })
      .from(locationVersions)
      .innerJoin(locations, eq(locations.id, locationVersions.locationId))
      .where(and(eq(locationVersions.id, input.locationVersionId), eq(locations.projectId, project.id)));
    if (!found) throw badRequest("Unknown location version");
  }
  if (input.propVersionIds?.length) {
    const found = await db
      .select({ id: propVersions.id })
      .from(propVersions)
      .innerJoin(props, eq(props.id, propVersions.propId))
      .where(and(inArray(propVersions.id, input.propVersionIds), eq(props.projectId, project.id)));
    if (found.length !== new Set(input.propVersionIds).size) throw badRequest("Unknown prop version");
  }
  const set: Partial<typeof panels.$inferInsert> = {
    ...input,
    frame: input.frame ? clampFrame(input.frame) : undefined,
  };
  if (input.promptOverride !== undefined && panel.status === "planned" && input.promptOverride)
    set.status = "prompt-ready";
  const [row] = await db.update(panels).set(set).where(eq(panels.id, panel.id)).returning();
  return c.json({ panel: row });
});

const PutSpec = z.object({ spec: PanelSpec });
doc({
  method: "PUT",
  path: "/api/panels/:id/spec",
  summary: "Save a new PanelSpec version (user edit)",
  tag: "panels",
  body: PutSpec,
});
pageRoutes.put("/panels/:id/spec", async (c) => {
  const { panel } = await loadPanel(c, uuidParam(c, "id"), "write");
  if (panel.approvalStatus === "locked") throw conflict("Panel is locked");
  const { spec } = await body(c, PutSpec);
  const { db } = c.get("deps");
  const row = await db.transaction(async (tx) => {
    const [max] = await tx
      .select({ n: sql<number>`coalesce(max(${panelSpecs.versionNumber}),0)::int` })
      .from(panelSpecs)
      .where(eq(panelSpecs.panelId, panel.id));
    const [s] = await tx
      .insert(panelSpecs)
      .values({ panelId: panel.id, versionNumber: (max?.n ?? 0) + 1, spec, source: "user" })
      .returning();
    await tx
      .update(panels)
      .set({ shotType: spec.shotType, cameraAngle: spec.cameraAngle, storyBeat: spec.beat, promptDraft: null })
      .where(eq(panels.id, panel.id));
    return s;
  });
  return c.json({ spec: row });
});

doc({ method: "DELETE", path: "/api/panels/:id", summary: "Remove panel", tag: "panels" });
pageRoutes.delete("/panels/:id", async (c) => {
  const { panel } = await loadPanel(c, uuidParam(c, "id"), "write");
  const { db } = c.get("deps");
  await db.transaction(async (tx) => {
    await tx.delete(panels).where(eq(panels.id, panel.id));
    const rest = await tx.select().from(panels).where(eq(panels.pageId, panel.pageId)).orderBy(asc(panels.order));
    for (const [i, p] of rest.entries())
      await tx
        .update(panels)
        .set({ order: i + 1 })
        .where(eq(panels.id, p.id));
    await tx.update(pages).set({ layoutTemplate: null }).where(eq(pages.id, panel.pageId));
  });
  return c.json({ ok: true });
});

const Split = z.object({ direction: z.enum(["horizontal", "vertical"]) });
doc({ method: "POST", path: "/api/panels/:id/split", summary: "Split panel into two", tag: "panels", body: Split });
pageRoutes.post("/panels/:id/split", async (c) => {
  const { panel, project } = await loadPanel(c, uuidParam(c, "id"), "write");
  const { direction } = await body(c, Split);
  const { db } = c.get("deps");
  const [a, b] = splitFrame(panel.frame, direction, project.settings.pageGutter);
  const created = await db.transaction(async (tx) => {
    await tx
      .update(panels)
      .set({ order: sql`${panels.order} + 1` })
      .where(and(eq(panels.pageId, panel.pageId), sql`${panels.order} > ${panel.order}`));
    await tx.update(panels).set({ frame: a }).where(eq(panels.id, panel.id));
    const [spec] = await tx
      .select()
      .from(panelSpecs)
      .where(eq(panelSpecs.panelId, panel.id))
      .orderBy(desc(panelSpecs.versionNumber))
      .limit(1);
    const [pn] = await tx
      .insert(panels)
      .values({
        projectId: project.id,
        pageId: panel.pageId,
        sceneId: panel.sceneId,
        order: panel.order + 1,
        frame: b,
        shotType: panel.shotType,
        cameraAngle: panel.cameraAngle,
        storyBeat: panel.storyBeat,
        locationVersionId: panel.locationVersionId,
        characterVersionIds: panel.characterVersionIds,
        propVersionIds: panel.propVersionIds,
      })
      .returning();
    await tx.insert(panelSpecs).values({
      panelId: pn!.id,
      versionNumber: 1,
      spec: { ...(spec?.spec ?? emptySpec()), dialogueIds: [], narrationIds: [], sfxIds: [] },
      source: "user",
    });
    await tx.update(pages).set({ layoutTemplate: null }).where(eq(pages.id, panel.pageId));
    return pn!;
  });
  return c.json({ panel: created }, 201);
});

const StripQuery = z.object({ width: z.coerce.number().int().min(320).max(1600).default(800) });
doc({
  method: "GET",
  path: "/api/chapters/:id/strip",
  summary: "A chapter as one vertical strip: each page's block height and the seam that precedes it",
  tag: "pages",
  query: StripQuery,
});
pageRoutes.get("/chapters/:id/strip", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "read");
  const { width } = query(c, StripQuery);
  const { db } = c.get("deps");
  const rows = await db
    .select({ page: pages, panel: panels })
    .from(pages)
    .leftJoin(panels, eq(panels.pageId, pages.id))
    .where(eq(pages.chapterId, chapterId))
    .orderBy(asc(pages.order), asc(panels.order));
  // One block per page: a vertical project plans one panel per page, and the page renderer already composes that
  // panel with its lettering, so the reader can stack the same images the export stitches.
  const seen = new Set<string>();
  const blocks = [];
  for (const { page, panel } of rows) {
    if (seen.has(page.id)) continue;
    seen.add(page.id);
    blocks.push({
      pageId: page.id,
      order: page.order,
      panelId: panel?.id ?? null,
      height: Math.max(1, Math.round((page.height * width) / page.width)),
      hasArt: Boolean(panel?.activeArtworkAssetId),
      seam: panel?.seam ?? null,
      updatedAt: page.updatedAt,
    });
  }
  return c.json({
    width,
    gap: project.settings.webtoonGap,
    background: "#ffffff",
    format: project.settings.format,
    blocks,
  });
});

const PreviewQuery = z.object({ credentialId: z.string().uuid().optional(), model: z.string().max(200).optional() });
doc({
  method: "GET",
  path: "/api/panels/:id/prompt-preview",
  summary: "Prompt inspector before generation: compiled prompt + reference plan",
  tag: "panels",
  query: PreviewQuery,
});
pageRoutes.get("/panels/:id/prompt-preview", async (c) => {
  const { panel } = await loadPanel(c, uuidParam(c, "id"), "read");
  // The picked key travels in the query so the preview names the model this user's run would use, not the default.
  const q = query(c, PreviewQuery);
  const ai = q.credentialId || q.model ? { credentialId: q.credentialId ?? null, model: q.model ?? null } : null;
  return c.json(await c.get("deps").planner.previewPanel(panel.id, ai, user(c).id));
});

const REGEN_OPERATIONS = [
  "same_prompt",
  "edited_prompt",
  "change_expression",
  "change_pose",
  "change_camera",
  "change_background",
  "change_outfit",
  "remove_object",
  "add_object",
  "reframe",
] as const;
const GenerateInput = z.object({
  operation: z.enum(REGEN_OPERATIONS).default("same_prompt"),
  instruction: z.string().max(2000).optional(),
  promptOverride: z.string().max(32_000).optional(),
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/panels/:id/generate",
  summary: "Generate / regenerate a panel (always creates a new artwork version)",
  tag: "panels",
  body: GenerateInput,
});
pageRoutes.post("/panels/:id/generate", async (c) => {
  const { panel } = await loadPanel(c, uuidParam(c, "id"), "generate");
  // Invariant: an approved/locked panel is immutable. Bulk generation already filters these out; these routes
  // wrote new artwork over a locked panel and reset its review state while it still read as locked.
  if (panel.approvalStatus === "locked") throw conflict("Panel is locked");
  const input = await body(c, GenerateInput);
  const deps = c.get("deps");
  // Keyed on a job that is actually in flight rather than the panel's status column, which stays behind when a
  // job is cancelled: two clicks used to queue two paid generations for one panel, both activating their output.
  const [inFlight] = await deps.db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.targetId, panel.id),
        eq(generationJobs.kind, "panel_generation"),
        // "submitted" counts as in flight: the panel is waiting in a provider batch we have already paid for.
        inArray(generationJobs.status, ["queued", "submitted", "processing"]),
      ),
    )
    .limit(1);
  if (inFlight) throw conflict("This panel is already generating; wait for it or cancel that job");
  await assertBudget(c, panel.projectId);
  await checkImageChoice(c, input.ai);
  let override = input.promptOverride ?? null;
  if (input.operation !== "same_prompt" && input.operation !== "edited_prompt" && input.instruction) {
    const base = override ?? (await deps.planner.previewPanel(panel.id)).compiledPrompt;
    override = `${base}\n\nREVISION REQUEST (${input.operation.replace(/_/g, " ")}):\n${input.instruction.trim()}\nKeep everything else consistent with the requirements above.`;
  }
  if (input.operation === "edited_prompt" && input.promptOverride) {
    await deps.db.update(panels).set({ promptOverride: input.promptOverride }).where(eq(panels.id, panel.id));
  }
  const job = await deps.planner.enqueuePanel(panel.id, user(c).id, {
    priority: PRIORITY.single,
    promptOverride: override,
    regenerationOf: panel.activeArtworkAssetId,
    operation: input.operation,
    ai: input.ai,
  });
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

doc({
  method: "POST",
  path: "/api/panels/:id/mask",
  summary: "Upload a painted mask (PNG, same size as artwork)",
  tag: "panels",
});
pageRoutes.post("/panels/:id/mask", async (c) => {
  const { panel, project } = await loadPanel(c, uuidParam(c, "id"), "write");
  const up = await readImageUpload(c);
  if (up.mime !== "image/png") throw badRequest("Mask must be a PNG");
  const deps = c.get("deps");
  const asset = await deps.assets.store({
    projectId: project.id,
    ownerUserId: user(c).id,
    type: "panel_mask",
    data: up.data,
    mimeType: up.mime,
    width: up.width,
    height: up.height,
    metadata: { panelId: panel.id, sourceAssetId: panel.activeArtworkAssetId },
  });
  return c.json({ asset: { id: asset.id, width: asset.width, height: asset.height } }, 201);
});

const EditInput = z.object({
  maskAssetId: z.string().uuid(),
  instruction: z.string().trim().min(3).max(2000),
  operation: z.string().max(64).optional(),
  sourceAssetId: z.string().uuid().optional(),
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/panels/:id/edit",
  summary: "Masked edit: full-res panel + full-res mask + small refs",
  tag: "panels",
  body: EditInput,
});
pageRoutes.post("/panels/:id/edit", async (c) => {
  const { panel } = await loadPanel(c, uuidParam(c, "id"), "generate");
  // Invariant: an approved/locked panel is immutable. Bulk generation already filters these out; these routes
  // wrote new artwork over a locked panel and reset its review state while it still read as locked.
  if (panel.approvalStatus === "locked") throw conflict("Panel is locked");
  const input = await body(c, EditInput);
  const deps = c.get("deps");
  await assertBudget(c, panel.projectId);
  await checkImageChoice(c, input.ai);
  const job = await deps.planner.enqueueEdit(panel.id, user(c).id, input);
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

doc({ method: "GET", path: "/api/panels/:id/versions", summary: "Artwork version history", tag: "panels" });
pageRoutes.get("/panels/:id/versions", async (c) => {
  const { panel } = await loadPanel(c, uuidParam(c, "id"), "read");
  return c.json({
    activeAssetId: panel.activeArtworkAssetId,
    versions: await artworkVersions(c.get("deps").db, panel.id, panel.projectId),
  });
});

doc({
  method: "POST",
  path: "/api/panels/:id/versions/:assetId/activate",
  summary: "Activate / revert to an artwork version",
  tag: "panels",
});
pageRoutes.post("/panels/:id/versions/:assetId/activate", async (c) => {
  const { panel, project } = await loadPanel(c, uuidParam(c, "id"), "write");
  if (panel.approvalStatus === "locked") throw conflict("Panel is locked");
  const assetId = uuidParam(c, "assetId");
  const { db } = c.get("deps");
  const [a] = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.id, assetId),
        eq(assets.projectId, project.id),
        eq(assets.type, "panel_art"),
        isNull(assets.deletedAt),
      ),
    );
  if (!a || a.metadata.panelId !== panel.id) throw notFound("Artwork version");
  await db.transaction(async (tx) => {
    await tx.update(panels).set({ activeArtworkAssetId: a.id, status: "ready" }).where(eq(panels.id, panel.id));
    if (a.generationJobId)
      await tx
        .update(generationOutputs)
        .set({ activated: true })
        .where(and(eq(generationOutputs.jobId, a.generationJobId), eq(generationOutputs.assetId, a.id)));
  });
  await recordAudit(db, {
    userId: user(c).id,
    projectId: project.id,
    action: "panel.activate_version",
    targetType: "panel",
    targetId: panel.id,
    metadata: { from: panel.activeArtworkAssetId, to: a.id },
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

doc({
  method: "DELETE",
  path: "/api/panels/:id/versions/:assetId",
  summary: "Move an old artwork version to trash (not the active one)",
  tag: "panels",
});
pageRoutes.delete("/panels/:id/versions/:assetId", async (c) => {
  const { panel, project } = await loadPanel(c, uuidParam(c, "id"), "write");
  const assetId = uuidParam(c, "assetId");
  if (panel.activeArtworkAssetId === assetId) throw conflict("Activate another version before deleting the active one");
  const { db } = c.get("deps");
  const [a] = await db
    .update(assets)
    .set({ deletedAt: new Date() })
    .where(
      and(eq(assets.id, assetId), eq(assets.projectId, project.id), sql`${assets.metadata}->>'panelId' = ${panel.id}`),
    )
    .returning();
  if (!a) throw notFound("Artwork version");
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- dialogue & sfx

const NewDialogue = z.object({
  panelId: z.string().uuid().nullable().default(null),
  characterId: z.string().uuid().nullable().default(null),
  text: z.string().trim().min(1).max(2000),
  bubble: Bubble.optional(),
  type: z.enum(["normal", "thought", "shout", "whisper", "narration", "system"]).default("normal"),
});
doc({
  method: "POST",
  path: "/api/pages/:id/dialogue",
  summary: "Add a speech bubble (auto-placed if no geometry given). Zero image calls.",
  tag: "lettering",
  body: NewDialogue,
});
pageRoutes.post("/pages/:id/dialogue", async (c) => {
  const { page, project } = await loadPageProject(c, uuidParam(c, "id"), "write");
  const input = await body(c, NewDialogue);
  const { db } = c.get("deps");
  let bubble = input.bubble;
  if (!bubble) {
    const [pn] = input.panelId
      ? await db
          .select()
          .from(panels)
          .where(and(eq(panels.id, input.panelId), eq(panels.pageId, page.id)))
      : [];
    const frame = pn?.frame ?? { x: 0.05, y: 0.05, width: 0.9, height: 0.9 };
    const [latestSpec] =
      pn && input.characterId
        ? await db
            .select({ spec: panelSpecs.spec })
            .from(panelSpecs)
            .where(eq(panelSpecs.panelId, pn.id))
            .orderBy(desc(panelSpecs.versionNumber))
            .limit(1)
        : [];
    const speakerPosition = latestSpec?.spec.characters.find((ch) => ch.characterId === input.characterId)?.position;
    const existing = await db
      .select({ b: dialogueLines.bubble })
      .from(dialogueLines)
      .where(eq(dialogueLines.pageId, page.id));
    const draft = draftBubble(
      input.text,
      input.type,
      resolveLettering(project.settings),
      page.width,
      page.height,
      frame.width,
    );
    const rect = placeBubble({
      panel: frame,
      text: input.text,
      fontSize: draft.bubble.fontSize,
      pageW: page.width,
      pageH: page.height,
      avoid: [...faceAvoidZone(frame, pn?.shotType ?? "medium"), ...existing.map((e) => e.b)],
      readingDirection: page.readingDirection ?? project.readingDirection,
      size: draft.size,
    });
    bubble = Bubble.parse({
      ...draft.bubble,
      ...rect,
      tailTarget: defaultTailTarget(rect, frame, speakerPosition),
      tail: input.type !== "narration" && input.type !== "system",
    });
  }
  const [max] = await db
    .select({ n: sql<number>`coalesce(max(${dialogueLines.order}),-1)::int` })
    .from(dialogueLines)
    .where(eq(dialogueLines.pageId, page.id));
  const [row] = await db
    .insert(dialogueLines)
    .values({
      projectId: project.id,
      pageId: page.id,
      panelId: input.panelId,
      characterId: input.characterId,
      order: (max?.n ?? -1) + 1,
      text: input.text,
      bubble,
    })
    .returning();
  return c.json({ dialogue: row }, 201);
});

const PatchDialogue = z.object({
  text: z.string().max(2000).optional(),
  bubble: Bubble.optional(),
  characterId: z.string().uuid().nullable().optional(),
  panelId: z.string().uuid().nullable().optional(),
  order: z.number().int().optional(),
});
doc({
  method: "PATCH",
  path: "/api/dialogue/:id",
  summary: "Edit bubble text/style/geometry",
  tag: "lettering",
  body: PatchDialogue,
});
pageRoutes.patch("/dialogue/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [d] = await db.select().from(dialogueLines).where(eq(dialogueLines.id, id));
  if (!d) throw notFound("Dialogue");
  await projectAccess(c, d.projectId, "write");
  const input = await body(c, PatchDialogue);
  const [row] = await db.update(dialogueLines).set(input).where(eq(dialogueLines.id, id)).returning();
  return c.json({ dialogue: row });
});
pageRoutes.delete("/dialogue/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [d] = await db.select().from(dialogueLines).where(eq(dialogueLines.id, id));
  if (!d) throw notFound("Dialogue");
  await projectAccess(c, d.projectId, "write");
  await db.delete(dialogueLines).where(eq(dialogueLines.id, id));
  return c.json({ ok: true });
});

const NewSfx = z.object({
  panelId: z.string().uuid().nullable().default(null),
  text: z.string().trim().min(1).max(100),
  style: asPatch(SfxStyle).optional(),
});
doc({
  method: "POST",
  path: "/api/pages/:id/sfx",
  summary: "Add a vector sound effect",
  tag: "lettering",
  body: NewSfx,
});
pageRoutes.post("/pages/:id/sfx", async (c) => {
  const { page, project } = await loadPageProject(c, uuidParam(c, "id"), "write");
  const input = await body(c, NewSfx);
  const { db } = c.get("deps");
  const [pn] = input.panelId
    ? await db
        .select()
        .from(panels)
        .where(and(eq(panels.id, input.panelId), eq(panels.pageId, page.id)))
    : [];
  const f = pn?.frame ?? { x: 0.3, y: 0.4, width: 0.4, height: 0.2 };
  const style = SfxStyle.parse({
    ...resolveLettering(project.settings).sfx,
    x: f.x + f.width * 0.55,
    y: f.y + f.height * 0.6,
    ...input.style,
  });
  const [row] = await db
    .insert(soundEffects)
    .values({ projectId: project.id, pageId: page.id, panelId: input.panelId, text: input.text, style })
    .returning();
  return c.json({ sfx: row }, 201);
});
const PatchSfx = z.object({
  text: z.string().max(100).optional(),
  style: SfxStyle.optional(),
  panelId: z.string().uuid().nullable().optional(),
});
pageRoutes.patch("/sfx/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [s] = await db.select().from(soundEffects).where(eq(soundEffects.id, id));
  if (!s) throw notFound("SFX");
  await projectAccess(c, s.projectId, "write");
  const input = await body(c, PatchSfx);
  const [row] = await db.update(soundEffects).set(input).where(eq(soundEffects.id, id)).returning();
  return c.json({ sfx: row });
});
pageRoutes.delete("/sfx/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [s] = await db.select().from(soundEffects).where(eq(soundEffects.id, id));
  if (!s) throw notFound("SFX");
  await projectAccess(c, s.projectId, "write");
  await db.delete(soundEffects).where(eq(soundEffects.id, id));
  return c.json({ ok: true });
});

const ApplyLettering = z.object({
  scope: z.enum(["page", "chapter", "project"]).default("page"),
  types: z
    .array(z.enum(["normal", "thought", "shout", "whisper", "narration", "system", "sfx"]))
    .min(1)
    .optional(),
  restyle: z.boolean().default(true),
  fit: z.boolean().default(true),
});
doc({
  method: "POST",
  path: "/api/pages/:id/lettering/apply-defaults",
  summary: "Apply project lettering defaults (style and/or fit-to-text) to existing text on a page, chapter or project",
  tag: "lettering",
  body: ApplyLettering,
});
pageRoutes.post("/pages/:id/lettering/apply-defaults", async (c) => {
  const { page, project } = await loadPageProject(c, uuidParam(c, "id"), "write");
  const input = await body(c, ApplyLettering);
  const { db } = c.get("deps");
  const lettering = resolveLettering(project.settings);
  const wants = (t: string) => !input.types || input.types.includes(t as "normal");
  const scopePages =
    input.scope === "page"
      ? [page]
      : input.scope === "chapter"
        ? await db.select().from(pages).where(eq(pages.chapterId, page.chapterId))
        : await db.select().from(pages).where(eq(pages.projectId, project.id));
  const pageIds = scopePages.map((p) => p.id);
  const size = new Map(scopePages.map((p) => [p.id, { w: p.width, h: p.height }]));
  const counts = { bubbles: 0, narration: 0, sfx: 0 };
  await db.transaction(async (tx) => {
    const restyle = (text: string, b: Bubble, pageId: string) => {
      const dims = size.get(pageId)!;
      let next = input.restyle ? applyTypeStyle(b, lettering) : b;
      if (input.fit) next = refitBubble(text, next, dims.w, dims.h, lettering.maxWidth);
      return Bubble.parse(next);
    };
    for (const d of await tx.select().from(dialogueLines).where(inArray(dialogueLines.pageId, pageIds))) {
      if (!wants(d.bubble.type)) continue;
      await tx
        .update(dialogueLines)
        .set({ bubble: restyle(d.text, d.bubble, d.pageId) })
        .where(eq(dialogueLines.id, d.id));
      counts.bubbles++;
    }
    for (const n of await tx.select().from(narrationLines).where(inArray(narrationLines.pageId, pageIds))) {
      if (!n.box || !n.pageId || !wants(n.box.type)) continue;
      await tx
        .update(narrationLines)
        .set({ box: restyle(n.text, n.box, n.pageId) })
        .where(eq(narrationLines.id, n.id));
      counts.narration++;
    }
    if (input.restyle && wants("sfx")) {
      for (const sf of await tx.select().from(soundEffects).where(inArray(soundEffects.pageId, pageIds))) {
        await tx
          .update(soundEffects)
          .set({ style: SfxStyle.parse(applySfxDefaults(sf.style, lettering)) })
          .where(eq(soundEffects.id, sf.id));
        counts.sfx++;
      }
    }
  });
  return c.json({ ok: true, pages: pageIds.length, ...counts });
});

const ClearLettering = z.object({ scope: z.enum(["page", "chapter", "project"]).default("page") });
doc({
  method: "POST",
  path: "/api/pages/:id/lettering/clear",
  summary:
    "Remove app lettering (speech bubbles, SFX, on-page narration captions) from a page, chapter or project. Narration lines and audio are kept.",
  tag: "lettering",
  body: ClearLettering,
});
pageRoutes.post("/pages/:id/lettering/clear", async (c) => {
  const { page, project } = await loadPageProject(c, uuidParam(c, "id"), "write");
  const { scope } = await body(c, ClearLettering);
  const { db } = c.get("deps");
  const where =
    scope === "page"
      ? eq(pages.id, page.id)
      : scope === "chapter"
        ? eq(pages.chapterId, page.chapterId)
        : eq(pages.projectId, project.id);
  const pageIds = (await db.select({ id: pages.id }).from(pages).where(where)).map((r) => r.id);
  if (!pageIds.length) return c.json({ ok: true, pages: 0, bubbles: 0, sfx: 0, captions: 0 });
  const result = await db.transaction(async (tx) => {
    const bubbles = await tx
      .delete(dialogueLines)
      .where(inArray(dialogueLines.pageId, pageIds))
      .returning({ id: dialogueLines.id });
    const sfx = await tx
      .delete(soundEffects)
      .where(inArray(soundEffects.pageId, pageIds))
      .returning({ id: soundEffects.id });
    const captions = await tx
      .update(narrationLines)
      .set({ showOnPage: false, box: null })
      .where(and(inArray(narrationLines.pageId, pageIds), eq(narrationLines.showOnPage, true)))
      .returning({ id: narrationLines.id });
    return { bubbles: bubbles.length, sfx: sfx.length, captions: captions.length };
  });
  await recordAudit(db, {
    userId: user(c).id,
    projectId: project.id,
    action: "lettering.clear",
    targetId: page.id,
    metadata: { scope, ...result },
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true, pages: pageIds.length, ...result });
});

doc({
  method: "POST",
  path: "/api/panels/:id/review/dismiss",
  summary: "Clear the panel's review flag (e.g. after checking art generated on a content-policy fallback provider)",
  tag: "panels",
});
pageRoutes.post("/panels/:id/review/dismiss", async (c) => {
  const { panel } = await loadPanel(c, uuidParam(c, "id"), "write");
  const deps = c.get("deps");
  await deps.db.update(panels).set({ review: null }).where(eq(panels.id, panel.id));
  return c.json({ ok: true });
});

const CheckInput = z.object({ ai: AiChoiceInput, batch: BatchInput });
doc({
  method: "POST",
  path: "/api/panels/:id/check",
  summary: "Queue a vision consistency check of the panel's active artwork (expected cast and headcount)",
  tag: "panels",
  body: CheckInput,
});
pageRoutes.post("/panels/:id/check", async (c) => {
  const { panel, project } = await loadPanel(c, uuidParam(c, "id"), "generate");
  const { ai, batch } = await body(c, CheckInput);
  if (!panel.activeArtworkAssetId) throw conflict("Panel has no artwork to check");
  const cc = project.settings.consistencyCheck;
  // The project's own vision key wins: it was picked for this job, while `ai` is whatever the page's text picker
  // happens to hold, which may well be a model that cannot read images.
  const choice = cc?.credentialId ? { credentialId: cc.credentialId, model: cc.model || null } : (ai ?? null);
  await assertBudget(c, project.id);
  const run = await textRun(c, choice ?? null);
  const deps = c.get("deps");
  assertBatchable(c, batch, run.provider);
  const checkBatchId = batch ? crypto.randomUUID() : null;
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(
      tx,
      {
        projectId: project.id,
        userId: user(c).id,
        kind: "panel_check",
        priority: PRIORITY.single,
        targetType: "panel",
        targetId: panel.id,
        batchId: checkBatchId,
        templateName: panelCheckV1.name,
        templateVersion: panelCheckV1.version,
        provider: run.provider,
        model: run.model,
        parameters: { ...run.parameters, assetId: panel.activeArtworkAssetId, ...batchParameters(batch) },
        input: { panelId: panel.id, assetId: panel.activeArtworkAssetId },
      },
      { enqueue: !batch },
    ),
  );
  if (checkBatchId) await queueTextBatchSubmit(c, { projectId: project.id, batchId: checkBatchId, ai: choice ?? null });
  await deps.jobs.kick();
  return c.json({ job }, 202);
});
