import { and, asc, chapters, eq, generationJobs, inArray, pages, panels, scenes, sql, storyBeats } from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { chapterPlanningV6, shotPlanningV3, stripPlanningV2 } from "@openmanga/prompts";
import { asPatch } from "@openmanga/schemas";
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
  queueTextBatchSubmit,
  textRun,
} from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

export const chapterRoutes = new Hono<AppEnv>();

doc({
  method: "GET",
  path: "/api/projects/:projectId/chapters",
  summary: "Chapters with scene/page/panel counts",
  tag: "chapters",
});
chapterRoutes.get("/projects/:projectId/chapters", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const rows = await db.select().from(chapters).where(eq(chapters.projectId, p.id)).orderBy(asc(chapters.order));
  const stats = await db.execute<{
    id: string;
    scenes: number;
    pages: number;
    panels: number;
    ready: number;
    narration: number;
    narratedPanels: number;
  }>(sql`
    select ch.id,
      (select count(*)::int from scenes s where s.chapter_id = ch.id) as scenes,
      (select count(*)::int from pages pg where pg.chapter_id = ch.id) as pages,
      (select count(*)::int from panels pn join pages pg on pg.id = pn.page_id where pg.chapter_id = ch.id) as panels,
      (select count(*)::int from panels pn join pages pg on pg.id = pn.page_id where pg.chapter_id = ch.id and pn.active_artwork_asset_id is not null) as ready,
      (select count(*)::int from narration_lines nl where nl.chapter_id = ch.id and nl.language = ${p.language}) as narration,
      (select count(distinct nl.panel_id)::int from narration_lines nl where nl.chapter_id = ch.id and nl.language = ${p.language} and nl.panel_id is not null) as "narratedPanels"
    from chapters ch where ch.project_id = ${p.id}`);
  return c.json({
    chapters: rows.map((ch) => ({
      ...ch,
      lastPlan: undefined,
      sourceExcerpt: undefined,
      hasPlan: Boolean(ch.lastPlan),
      sourceLength: ch.sourceExcerpt.length,
      stats: [...stats].find((s) => s.id === ch.id),
    })),
  });
});

export const ChapterInput = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().max(10_000).default(""),
  sourceExcerpt: z.string().max(500_000).default(""),
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/chapters",
  summary: "Create chapter manually",
  tag: "chapters",
  body: ChapterInput,
});
chapterRoutes.post("/projects/:projectId/chapters", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, ChapterInput);
  const { db } = c.get("deps");
  const [max] = await db
    .select({ n: sql<number>`coalesce(max(${chapters.order}),0)::int` })
    .from(chapters)
    .where(eq(chapters.projectId, p.id));
  const [row] = await db
    .insert(chapters)
    .values({ projectId: p.id, order: (max?.n ?? 0) + 1, ...input })
    .returning();
  return c.json({ chapter: row }, 201);
});

doc({
  method: "GET",
  path: "/api/chapters/:id",
  summary: "Chapter with memory, scenes, beats and pages",
  tag: "chapters",
});
chapterRoutes.get("/chapters/:id", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "chapter", id, "read");
  const { db } = c.get("deps");
  const [ch] = await db.select().from(chapters).where(eq(chapters.id, id));
  if (!ch) throw notFound("Chapter");
  const sc = await db.select().from(scenes).where(eq(scenes.chapterId, id)).orderBy(asc(scenes.order));
  const beats = sc.length
    ? await db
        .select()
        .from(storyBeats)
        .where(
          sql`${storyBeats.sceneId} in (${sql.join(
            sc.map((s) => sql`${s.id}`),
            sql`, `,
          )})`,
        )
        .orderBy(asc(storyBeats.order))
    : [];
  const pg = await db
    .select({
      page: pages,
      panelCount: sql<number>`(select count(*)::int from panels where page_id = "pages"."id")`,
      readyCount: sql<number>`(select count(*)::int from panels where page_id = "pages"."id" and active_artwork_asset_id is not null)`,
    })
    .from(pages)
    .where(eq(pages.chapterId, id))
    .orderBy(asc(pages.order));
  // Enough of each panel to draw the page thumbnail. Without this the shots grid fetches one page document per
  // card, which is 148 requests for a feature-length film project — a quarter of a user's rate limit per visit.
  const thumbs = pg.length
    ? await db
        .select({
          id: panels.id,
          pageId: panels.pageId,
          frame: panels.frame,
          status: panels.status,
          activeArtworkAssetId: panels.activeArtworkAssetId,
          review: panels.review,
          qa: panels.qa,
        })
        .from(panels)
        .where(
          inArray(
            panels.pageId,
            pg.map((r) => r.page.id),
          ),
        )
        .orderBy(asc(panels.order))
    : [];
  return c.json({
    chapter: ch,
    scenes: sc.map((s) => ({ ...s, beats: beats.filter((b) => b.sceneId === s.id) })),
    pages: pg.map((r) => ({
      ...r.page,
      panelCount: r.panelCount,
      readyCount: r.readyCount,
      panels: thumbs.filter((t) => t.pageId === r.page.id),
    })),
  });
});

export const PatchChapter = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  summary: z.string().max(10_000).optional(),
  sourceExcerpt: z.string().max(500_000).optional(),
  openingState: z.string().max(10_000).optional(),
  closingState: z.string().max(10_000).optional(),
  characterStateChanges: z.array(z.string().max(1000)).max(100).optional(),
  locationStateChanges: z.array(z.string().max(1000)).max(100).optional(),
  revealedFacts: z.array(z.string().max(1000)).max(100).optional(),
  order: z.number().int().min(1).optional(),
  planStatus: z.enum(["draft", "approved", "locked", "superseded"]).optional(),
});
doc({
  method: "PATCH",
  path: "/api/chapters/:id",
  summary: "Edit chapter / chapter memory / approve plan",
  tag: "chapters",
  body: PatchChapter,
});
chapterRoutes.patch("/chapters/:id", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "chapter", id, "write");
  const input = await body(c, PatchChapter);
  const [row] = await c.get("deps").db.update(chapters).set(input).where(eq(chapters.id, id)).returning();
  return c.json({ chapter: row });
});

doc({
  method: "DELETE",
  path: "/api/chapters/:id",
  summary: "Delete chapter (pages/panels removed; generated assets remain in the asset library)",
  tag: "chapters",
});
chapterRoutes.delete("/chapters/:id", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "chapter", id, "delete");
  const { db } = c.get("deps");
  const [busy] = await db.execute<{ n: number }>(sql`
    select (
      (select count(*) from generation_jobs g
        where g.status in ('queued','submitted','processing','cancel_requested')
          and (g.target_id = ${id}
            or g.target_id in (select pn.id from panels pn join pages pg on pg.id = pn.page_id where pg.chapter_id = ${id})
            or g.target_id in (select pg.id from pages pg where pg.chapter_id = ${id})))
      + (select count(*) from audio_jobs a
          join narration_segments s on s.id = a.segment_id
          join narration_lines l on l.id = s.narration_line_id
        where a.status in ('queued','processing') and l.chapter_id = ${id})
    )::int as n`);
  if ((busy?.n ?? 0) > 0)
    throw conflict(`This chapter has ${busy!.n} generation(s) in progress. Cancel them or wait before deleting.`);
  await db.transaction(async (tx) => {
    await tx.delete(chapters).where(eq(chapters.id, id));
    await tx.execute(sql`
      update chapters c set "order" = r.n
      from (select id, row_number() over (order by "order", created_at)::int as n from chapters where project_id = ${p.id}) r
      where c.id = r.id and c."order" <> r.n`);
  });
  await recordAudit(c.get("deps").db, {
    userId: user(c).id,
    projectId: p.id,
    action: "chapter.delete",
    targetId: id,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

export const PlanInput = z.object({
  replace: z.boolean().default(false),
  targetPages: z.number().int().min(1).max(60).optional(),
  /** Send to the provider's batch API: half price, result within 24h instead of now. */
  batch: BatchInput,
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/chapters/:id/plan",
  summary: "Queue DeepSeek scene/page/panel planning for this chapter",
  tag: "chapters",
  body: PlanInput,
});
chapterRoutes.post("/chapters/:id/plan", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "chapter", id, "generate");
  const input = await body(c, PlanInput);
  const deps = c.get("deps");
  const [ch] = await deps.db.select().from(chapters).where(eq(chapters.id, id));
  if (!ch) throw notFound("Chapter");
  if (ch.planStatus === "locked") throw conflict("The chapter plan is locked");
  if (!ch.sourceExcerpt.trim() && !ch.summary.trim())
    throw badRequest("Chapter has no source text or summary to plan from");
  // A plan queued while another is still running has no pages to see yet, so both applied and the panels doubled
  // (47 panels against a 14-30 norm, all paid for). One plan per chapter at a time.
  const [running] = await deps.db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.kind, "chapter_plan"),
        eq(generationJobs.targetId, id),
        inArray(generationJobs.status, ["queued", "submitted", "processing", "paused"]),
      ),
    )
    .limit(1);
  if (running) throw conflict("This chapter is already being planned. Wait for that plan to finish or cancel it.");
  const [existing] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(pages).where(eq(pages.chapterId, id));
  if ((existing?.n ?? 0) > 0 && !input.replace)
    throw conflict(
      "Chapter already has pages. Pass replace=true to regenerate the plan (existing pages will be replaced).",
    );
  await assertBudget(c, p.id);
  const run = await textRun(c, input.ai);
  assertBatchable(c, input.batch, run.provider);
  const batchId = input.batch ? crypto.randomUUID() : null;
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(
      tx,
      {
        projectId: p.id,
        userId: user(c).id,
        kind: "chapter_plan",
        priority: PRIORITY.single,
        targetType: "chapter",
        targetId: id,
        batchId,
        templateName:
          p.settings.format === "film"
            ? shotPlanningV3.name
            : p.settings.format === "vertical"
              ? stripPlanningV2.name
              : chapterPlanningV6.name,
        templateVersion:
          p.settings.format === "film"
            ? shotPlanningV3.version
            : p.settings.format === "vertical"
              ? stripPlanningV2.version
              : chapterPlanningV6.version,
        provider: run.provider,
        model: run.model,
        parameters: { ...run.parameters, ...batchParameters(input.batch) },
        input: { chapterId: id, replace: input.replace, targetPages: input.targetPages ?? null },
      },
      { enqueue: !input.batch },
    ),
  );
  if (batchId) await queueTextBatchSubmit(c, { projectId: p.id, batchId, ai: input.ai });
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

export const SceneInput = z.object({
  title: z.string().trim().min(1).max(200),
  summary: z.string().max(10_000).default(""),
  locationId: z.string().uuid().nullable().default(null),
  time: z.string().max(200).default(""),
  weather: z.string().max(200).default(""),
  characterIds: z.array(z.string().uuid()).max(50).default([]),
  purpose: z.string().max(2000).default(""),
  opening: z.string().max(2000).default(""),
  progression: z.string().max(2000).default(""),
  climax: z.string().max(2000).default(""),
  ending: z.string().max(2000).default(""),
  continuityNotes: z.array(z.string().max(500)).max(100).default([]),
  initialState: z.record(z.string(), z.string().max(500)).default({}),
  finalState: z.record(z.string(), z.string().max(500)).default({}),
  continuityDeltas: z.array(z.string().max(500)).max(100).default([]),
});
doc({ method: "POST", path: "/api/chapters/:id/scenes", summary: "Add scene", tag: "chapters", body: SceneInput });
chapterRoutes.post("/chapters/:id/scenes", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "chapter", id, "write");
  const input = await body(c, SceneInput);
  const { db } = c.get("deps");
  const [max] = await db
    .select({ n: sql<number>`coalesce(max(${scenes.order}),0)::int` })
    .from(scenes)
    .where(eq(scenes.chapterId, id));
  const [row] = await db
    .insert(scenes)
    .values({ projectId: p.id, chapterId: id, order: (max?.n ?? 0) + 1, ...input })
    .returning();
  return c.json({ scene: row }, 201);
});
doc({
  method: "PATCH",
  path: "/api/scenes/:id",
  summary: "Edit scene / scene memory / continuity state",
  tag: "chapters",
  body: asPatch(SceneInput),
});
chapterRoutes.patch("/scenes/:id", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "scene", id, "write");
  const input = await body(c, asPatch(SceneInput));
  const [row] = await c.get("deps").db.update(scenes).set(input).where(eq(scenes.id, id)).returning();
  return c.json({ scene: row });
});
chapterRoutes.delete("/scenes/:id", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "scene", id, "write");
  await c.get("deps").db.delete(scenes).where(eq(scenes.id, id));
  return c.json({ ok: true });
});

export const BeatsInput = z.object({ beats: z.array(z.string().trim().min(1).max(1000)).max(200) });
doc({
  method: "PUT",
  path: "/api/scenes/:id/beats",
  summary: "Replace scene beats",
  tag: "chapters",
  body: BeatsInput,
});
chapterRoutes.put("/scenes/:id/beats", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "scene", id, "write");
  const { beats } = await body(c, BeatsInput);
  const { db } = c.get("deps");
  await db.transaction(async (tx) => {
    await tx.delete(storyBeats).where(eq(storyBeats.sceneId, id));
    if (beats.length)
      await tx
        .insert(storyBeats)
        .values(beats.map((b, i) => ({ projectId: p.id, sceneId: id, order: i + 1, description: b })));
  });
  return c.json({ ok: true });
});

doc({
  method: "GET",
  path: "/api/chapters/:id/panels",
  summary: "All panels of a chapter (for bulk generation review)",
  tag: "chapters",
});
chapterRoutes.get("/chapters/:id/panels", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "chapter", id, "read");
  const rows = await c
    .get("deps")
    .db.select({ panel: panels, pageOrder: pages.order })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .where(eq(pages.chapterId, id))
    .orderBy(asc(pages.order), asc(panels.order));
  return c.json({ panels: rows.map((r) => ({ ...r.panel, pageOrder: r.pageOrder })) });
});
