import {
  and,
  asc,
  chapters,
  characterAliases,
  characterStates,
  characters,
  type DbOrTx,
  desc,
  eq,
  generationJobs,
  inArray,
  isNull,
  sql,
  timelineEvents,
} from "@openmanga/db";
import { PRIORITY, placeOnTimeline, timelineView } from "@openmanga/domain";
import { timelineExtractV1 } from "@openmanga/prompts";
import { ProposedEvent, TimelineEventKind, TimelineExtraction } from "@openmanga/schemas";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import {
  AiChoiceInput,
  assertBatchable,
  assertBudget,
  BatchInput,
  batchParameters,
  queueTextBatchSubmit,
  textRun,
} from "../lib/ai.ts";
import { ApiError, badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * The story timeline: events in story-time order (not telling order), with story days for elapsed time and ages,
 * tied to the chapter and scene that tell them. Bible character states are placed on it through their chapter.
 */
export const timelineRoutes = new Hono<AppEnv>();

const Uuid = z.string().uuid();
const Fields = {
  kind: TimelineEventKind,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000),
  when: z.string().trim().max(120),
  day: z.number().min(-10_000_000).max(10_000_000).nullable(),
  chapterId: Uuid.nullable(),
  sceneNumber: z.number().int().min(1).max(1000).nullable(),
  characterIds: z.array(Uuid).max(30),
};
export const EventInput = z.object({
  kind: Fields.kind.default("event"),
  title: Fields.title,
  description: Fields.description.default(""),
  when: Fields.when.default(""),
  day: Fields.day.default(null),
  chapterId: Fields.chapterId.default(null),
  sceneNumber: Fields.sceneNumber.default(null),
  characterIds: Fields.characterIds.default([]),
  /** Insert after this event; null for the very start; left out for the end. */
  after: Uuid.nullable().optional(),
});
export const EventPatch = z.object({
  kind: Fields.kind.optional(),
  title: Fields.title.optional(),
  description: Fields.description.optional(),
  when: Fields.when.optional(),
  day: Fields.day.optional(),
  chapterId: Fields.chapterId.optional(),
  sceneNumber: Fields.sceneNumber.optional(),
  characterIds: Fields.characterIds.optional(),
});

const events = (db: DbOrTx, projectId: string) =>
  db
    .select()
    .from(timelineEvents)
    .where(eq(timelineEvents.projectId, projectId))
    .orderBy(asc(timelineEvents.order), asc(timelineEvents.createdAt));

/** Chapter and character references must be the project's own. */
async function checkRefs(db: DbOrTx, projectId: string, chapterId?: string | null, characterIds?: string[]) {
  if (chapterId) {
    const [ch] = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(eq(chapters.id, chapterId), eq(chapters.projectId, projectId)));
    if (!ch) throw badRequest("That chapter is not in this project");
  }
  if (characterIds?.length) {
    const found = await db
      .select({ id: characters.id })
      .from(characters)
      .where(and(eq(characters.projectId, projectId), inArray(characters.id, characterIds)));
    if (found.length !== new Set(characterIds).size) throw badRequest("A character is not in this project");
  }
}

/** Rewrites `order` to 1..n in the given sequence. */
async function renumber(db: DbOrTx, ids: string[]) {
  if (!ids.length) return;
  await db.execute(sql`update timeline_events t set "order" = v.o, updated_at = now()
    from (values ${sql.join(
      ids.map((id, i) => sql`(${id}::uuid, ${i + 1}::int)`),
      sql`, `,
    )}) as v(id, o) where t.id = v.id`);
}

doc({
  method: "GET",
  path: "/api/projects/:projectId/timeline",
  summary:
    "The story timeline: events in story-time order, each with the time since the previous dated event (`since` in days and `elapsed` in words), `outOfOrder` when its day is earlier than an event listed before it, and the ages of its characters who have a dated birth event. Also the project's chapters and characters, the bible's character states each placed at the event they start from (`eventId`, null for from the start), and the newest extraction job.",
  tag: "bible",
});
timelineRoutes.get("/projects/:projectId/timeline", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const [evs, chs, cast] = await Promise.all([
    events(db, p.id),
    db
      .select({ id: chapters.id, order: chapters.order, title: chapters.title })
      .from(chapters)
      .where(eq(chapters.projectId, p.id))
      .orderBy(asc(chapters.order)),
    db
      .select({ id: characters.id, name: characters.name })
      .from(characters)
      .where(and(eq(characters.projectId, p.id), isNull(characters.deletedAt)))
      .orderBy(asc(characters.name)),
  ]);
  const chapterOrder = new Map(chs.map((ch) => [ch.id, ch.order]));
  const points = evs.map((e) => ({
    id: e.id,
    kind: e.kind,
    day: e.day,
    characterIds: e.characterIds,
    chapter: e.chapterId ? (chapterOrder.get(e.chapterId) ?? null) : null,
    scene: e.sceneNumber,
  }));
  const view = timelineView(points);
  const states = await db
    .select()
    .from(characterStates)
    .where(eq(characterStates.projectId, p.id))
    .orderBy(asc(characterStates.createdAt));
  const [extraction] = await db
    .select({
      id: generationJobs.id,
      status: generationJobs.status,
      result: generationJobs.result,
      failureReason: generationJobs.failureReason,
      createdAt: generationJobs.createdAt,
    })
    .from(generationJobs)
    .where(and(eq(generationJobs.projectId, p.id), eq(generationJobs.kind, "timeline_extract")))
    .orderBy(desc(generationJobs.createdAt))
    .limit(1);
  return c.json({
    events: evs.map((e, i) => ({ ...e, ...view[i], id: e.id })),
    chapters: chs,
    characters: cast,
    states: states.map((s) => ({
      id: s.id,
      characterId: s.characterId,
      kind: s.kind,
      text: s.text,
      eventId: placeOnTimeline(points, {
        chapter: s.chapterId ? (chapterOrder.get(s.chapterId) ?? null) : null,
        scene: s.sceneNumber,
      }),
    })),
    extraction: extraction ?? null,
  });
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/timeline/events",
  summary:
    "Add an event to the timeline: after the event `after` names (null: at the start; left out: at the end). day is a story-day number for elapsed time and ages; a birth event names one character.",
  tag: "bible",
  body: EventInput,
});
timelineRoutes.post("/projects/:projectId/timeline/events", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const { after, ...input } = await body(c, EventInput);
  const { db } = c.get("deps");
  await checkRefs(db, p.id, input.chapterId, input.characterIds);
  const list = await events(db, p.id);
  if (list.length >= 2000) throw badRequest("A timeline holds at most 2000 events");
  if (after && !list.some((e) => e.id === after)) throw notFound("Event");
  const [row] = await db
    .insert(timelineEvents)
    .values({ ...input, projectId: p.id, order: list.length + 1, createdByUserId: user(c).id })
    .returning();
  if (after !== undefined) {
    const ids = list.map((e) => e.id);
    ids.splice(after === null ? 0 : ids.indexOf(after) + 1, 0, row!.id);
    await renumber(db, ids);
  }
  return c.json({ event: row }, 201);
});

async function eventFor(c: Parameters<typeof projectAccess>[0], id: string) {
  const [row] = await c.get("deps").db.select().from(timelineEvents).where(eq(timelineEvents.id, id));
  if (!row) throw notFound("Event");
  return { row, project: await projectAccess(c, row.projectId, "write") };
}

doc({
  method: "PATCH",
  path: "/api/timeline-events/:id",
  summary: "Edit a timeline event",
  tag: "bible",
  body: EventPatch,
});
timelineRoutes.patch("/timeline-events/:id", async (c) => {
  const { row, project } = await eventFor(c, uuidParam(c, "id"));
  const input = await body(c, EventPatch);
  const { db } = c.get("deps");
  await checkRefs(db, project.id, input.chapterId, input.characterIds);
  const [next] = await db
    .update(timelineEvents)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(timelineEvents.id, row.id))
    .returning();
  return c.json({ event: next });
});

doc({ method: "DELETE", path: "/api/timeline-events/:id", summary: "Delete a timeline event", tag: "bible" });
timelineRoutes.delete("/timeline-events/:id", async (c) => {
  const { row, project } = await eventFor(c, uuidParam(c, "id"));
  const { db } = c.get("deps");
  await db.delete(timelineEvents).where(eq(timelineEvents.id, row.id));
  await renumber(
    db,
    (await events(db, project.id)).map((e) => e.id),
  );
  return c.json({ ok: true });
});

const OrderInput = z.object({ ids: z.array(Uuid).min(1).max(2000) });
doc({
  method: "POST",
  path: "/api/projects/:projectId/timeline/order",
  summary: "Put the timeline in this story-time order: every event's id, once.",
  tag: "bible",
  body: OrderInput,
});
timelineRoutes.post("/projects/:projectId/timeline/order", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const { ids } = await body(c, OrderInput);
  const { db } = c.get("deps");
  const have = (await events(db, p.id)).map((e) => e.id);
  if (ids.length !== have.length || new Set(ids).size !== ids.length || ids.some((id) => !have.includes(id)))
    throw badRequest("Send every event of the timeline exactly once");
  await renumber(db, ids);
  return c.json({ ok: true });
});

const ExtractInput = z.object({ chapterId: Uuid.optional(), ai: AiChoiceInput, batch: BatchInput });
doc({
  method: "POST",
  path: "/api/projects/:projectId/timeline/extract",
  summary:
    "Extract timeline from story: a text job that proposes events in story-time order (with story days, births and the chapters that tell them) from the chapters, one or all. Nothing is saved until POST /api/timeline-extractions/:id/apply.",
  tag: "bible",
  body: ExtractInput,
});
timelineRoutes.post("/projects/:projectId/timeline/extract", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  const input = await body(c, ExtractInput);
  const deps = c.get("deps");
  const chs = await deps.db.select({ id: chapters.id }).from(chapters).where(eq(chapters.projectId, p.id));
  if (!chs.length) throw conflict("The project has no chapters yet: analyse and apply the story first");
  if (input.chapterId && !chs.some((x) => x.id === input.chapterId)) throw notFound("Chapter");
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
        kind: "timeline_extract",
        priority: PRIORITY.single,
        targetType: input.chapterId ? "chapter" : "project",
        targetId: input.chapterId ?? p.id,
        batchId,
        templateName: timelineExtractV1.name,
        templateVersion: timelineExtractV1.version,
        provider: run.provider,
        model: run.model,
        parameters: { ...run.parameters, ...batchParameters(input.batch) },
        input: { chapterId: input.chapterId ?? null },
      },
      { enqueue: !input.batch },
    ),
  );
  if (batchId) await queueTextBatchSubmit(c, { projectId: p.id, batchId, ai: input.ai });
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

const ApplyInput = z.object({
  /** The reviewed proposal; omitted, the job's own result is applied as it is. */
  events: z.array(ProposedEvent).max(300).optional(),
  again: z.boolean().default(false),
});
doc({
  method: "POST",
  path: "/api/timeline-extractions/:id/apply",
  summary:
    "Save a completed timeline extraction's events (or the reviewed subset sent here) into the timeline. A dated event goes before the first existing event with a later day; undated ones follow the proposal before them. Characters are matched by name or alias, chapters by number; a character that matches nothing is dropped from the event and listed, a chapter number that matches nothing leaves the event untied. Applying twice is refused with 409 unless again=true.",
  tag: "bible",
  body: ApplyInput,
});
timelineRoutes.post("/timeline-extractions/:id/apply", async (c) => {
  const deps = c.get("deps");
  const [job] = await deps.db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, uuidParam(c, "id")));
  if (job?.kind !== "timeline_extract" || !job.projectId) throw notFound("Extraction");
  const p = await projectAccess(c, job.projectId, "write");
  if (job.status !== "completed")
    throw conflict(`This extraction is ${job.status}; only a completed one can be applied`);
  const input = await body(c, ApplyInput);
  const proposed =
    input.events ?? TimelineExtraction.parse((job.result as { data?: unknown } | null)?.data ?? {}).events;
  const chs = await deps.db
    .select({ id: chapters.id, order: chapters.order })
    .from(chapters)
    .where(eq(chapters.projectId, p.id));
  const cast = await deps.db
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(and(eq(characters.projectId, p.id), isNull(characters.deletedAt)));
  const aliases = cast.length
    ? await deps.db
        .select()
        .from(characterAliases)
        .where(
          inArray(
            characterAliases.characterId,
            cast.map((x) => x.id),
          ),
        )
    : [];
  const lower = (s: string) => s.trim().toLowerCase();
  const named = (name: string) =>
    cast.find((x) => lower(x.name) === lower(name)) ??
    cast.find((x) => aliases.some((a) => a.characterId === x.id && lower(a.alias) === lower(name)));
  const skipped: { entry: string; reason: string }[] = [];
  const rows = proposed.map((e) => {
    const ids: string[] = [];
    for (const n of e.characters) {
      const who = named(n);
      if (who) ids.push(who.id);
      else skipped.push({ entry: e.title, reason: `no character named ${n}` });
    }
    const ch = e.chapter == null ? null : (chs.find((x) => x.order === e.chapter)?.id ?? null);
    if (e.chapter != null && !ch) skipped.push({ entry: e.title, reason: `no chapter ${e.chapter}` });
    return {
      projectId: p.id,
      order: 0,
      kind: e.kind,
      title: e.title,
      description: e.description,
      when: e.when,
      day: e.day ?? null,
      chapterId: ch,
      sceneNumber: ch ? (e.scene ?? null) : null,
      characterIds: [...new Set(ids)],
      source: "extracted" as const,
      createdByUserId: user(c).id,
    };
  });
  const applied = { at: new Date().toISOString(), events: rows.length };
  await deps.db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(generationJobs)
      .set({
        result: sql`${generationJobs.result} || jsonb_build_object('applied', ${JSON.stringify(applied)}::jsonb)`,
      })
      .where(
        and(eq(generationJobs.id, job.id), input.again ? undefined : sql`${generationJobs.result}->'applied' is null`),
      )
      .returning({ id: generationJobs.id });
    if (!claimed)
      throw new ApiError(
        409,
        "already_applied",
        "This extraction was already applied. Apply it again only on purpose: pass again=true.",
      );
    if (!rows.length) return;
    const inserted = await tx.insert(timelineEvents).values(rows).returning({ id: timelineEvents.id });
    // Merge into story-time order: a dated proposal before the first existing event with a later day.
    const seq = (await events(tx, p.id)).filter((e) => !inserted.some((x) => x.id === e.id));
    const order: { id: string; day: number | null }[] = seq.map((e) => ({ id: e.id, day: e.day }));
    let at = order.length;
    for (const [i, r] of rows.entries()) {
      const id = inserted[i]!.id;
      if (r.day !== null) {
        const next = order.findIndex((e) => e.day !== null && e.day > r.day!);
        at = next < 0 ? order.length : next;
      }
      order.splice(at, 0, { id, day: r.day });
      at++;
    }
    await renumber(
      tx,
      order.map((e) => e.id),
    );
  });
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "timeline.extraction.apply",
    targetType: "generation_job",
    targetId: job.id,
    metadata: { ...applied, skipped: skipped.length },
    requestId: c.get("requestId"),
  });
  return c.json({ events: rows.length, skipped });
});
