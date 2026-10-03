import {
  and,
  asc,
  bibleFacts,
  chapters,
  characterAliases,
  characterOutfits,
  characterStates,
  characters,
  type DbOrTx,
  desc,
  eq,
  generationJobs,
  inArray,
  isNull,
  sql,
} from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { bibleExtractV1 } from "@openmanga/prompts";
import { BibleExtraction, BibleFactKind, CharacterStateKind, ProposedFact, ProposedState } from "@openmanga/schemas";
import { bibleFor, loadBible, recordAudit } from "@openmanga/services";
import type { Context } from "hono";
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
import { ApiError, badRequest, body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * The story bible: facts (with chapter ranges and a fixed flag) and per-character state timelines. Planning, panel
 * prompts, narration and panel images receive the entries in effect where they are; see docs/AI_PIPELINE.md.
 */
export const bibleRoutes = new Hono<AppEnv>();

const Uuid = z.string().uuid();
const text = z.string().trim().min(1).max(1000);
const subject = z.string().trim().max(200);

export const FactInput = z.object({
  kind: BibleFactKind,
  subject: subject.default(""),
  text,
  fixed: z.boolean().default(false),
  visual: z.boolean().default(false),
  fromChapterId: Uuid.nullable().default(null),
  untilChapterId: Uuid.nullable().default(null),
});
export const FactPatch = z.object({
  kind: BibleFactKind.optional(),
  subject: subject.optional(),
  text: text.optional(),
  fixed: z.boolean().optional(),
  visual: z.boolean().optional(),
  fromChapterId: Uuid.nullable().optional(),
  untilChapterId: Uuid.nullable().optional(),
});
export const StateInput = z.object({
  characterId: Uuid,
  kind: CharacterStateKind,
  text,
  chapterId: Uuid.nullable().default(null),
  sceneNumber: z.number().int().min(1).max(1000).nullable().default(null),
  untilChapterId: Uuid.nullable().default(null),
  outfitId: Uuid.nullable().default(null),
});
export const StatePatch = z.object({
  characterId: Uuid.optional(),
  kind: CharacterStateKind.optional(),
  text: text.optional(),
  chapterId: Uuid.nullable().optional(),
  sceneNumber: z.number().int().min(1).max(1000).nullable().optional(),
  untilChapterId: Uuid.nullable().optional(),
  outfitId: Uuid.nullable().optional(),
});

const chapterOrders = (db: DbOrTx, projectId: string) =>
  db
    .select({ id: chapters.id, order: chapters.order, title: chapters.title })
    .from(chapters)
    .where(eq(chapters.projectId, projectId))
    .orderBy(asc(chapters.order));

/** Chapter references must be this project's, and a range must not end before it starts. */
async function checkRange(db: DbOrTx, projectId: string, from: string | null, until: string | null) {
  const chs = await chapterOrders(db, projectId);
  const order = (id: string | null) => {
    if (!id) return null;
    const ch = chs.find((c) => c.id === id);
    if (!ch) throw badRequest("That chapter is not in this project");
    return ch.order;
  };
  const [a, b] = [order(from), order(until)];
  if (a !== null && b !== null && b < a) throw badRequest("The range ends before it starts");
}

async function checkState(
  db: DbOrTx,
  projectId: string,
  s: {
    characterId: string;
    chapterId: string | null;
    sceneNumber: number | null;
    untilChapterId: string | null;
    outfitId: string | null;
  },
) {
  const [ch] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, s.characterId), eq(characters.projectId, projectId), isNull(characters.deletedAt)));
  if (!ch) throw badRequest("That character is not in this project");
  if (s.sceneNumber !== null && !s.chapterId) throw badRequest("A scene number needs a chapter");
  await checkRange(db, projectId, s.chapterId, s.untilChapterId);
  if (s.outfitId) {
    const [o] = await db
      .select({ c: characterOutfits.characterId })
      .from(characterOutfits)
      .where(eq(characterOutfits.id, s.outfitId));
    if (o?.c !== s.characterId) throw badRequest("That outfit belongs to another character");
  }
}

async function factOf(c: Context<AppEnv>, action: "read" | "write") {
  const [f] = await c
    .get("deps")
    .db.select()
    .from(bibleFacts)
    .where(eq(bibleFacts.id, uuidParam(c, "id")));
  if (!f) throw notFound("Fact");
  await projectAccess(c, f.projectId, action);
  return f;
}

async function stateOf(c: Context<AppEnv>, action: "read" | "write") {
  const [s] = await c
    .get("deps")
    .db.select()
    .from(characterStates)
    .where(eq(characterStates.id, uuidParam(c, "id")));
  if (!s) throw notFound("State");
  await projectAccess(c, s.projectId, action);
  return s;
}

const BibleQuery = z.object({ chapterId: Uuid.optional(), sceneNumber: z.coerce.number().int().min(1).optional() });
doc({
  method: "GET",
  path: "/api/projects/:projectId/bible",
  summary:
    "The story bible: facts, character states, the chapters and cast they refer to, and the latest extraction job. With chapterId, also inEffect: the bible planning and narration of that chapter receive (with sceneNumber, the states in force at that scene).",
  tag: "bible",
  query: BibleQuery,
});
bibleRoutes.get("/projects/:projectId/bible", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, BibleQuery);
  const { db } = c.get("deps");
  const facts = await db
    .select()
    .from(bibleFacts)
    .where(eq(bibleFacts.projectId, p.id))
    .orderBy(asc(bibleFacts.createdAt));
  const states = await db
    .select()
    .from(characterStates)
    .where(eq(characterStates.projectId, p.id))
    .orderBy(asc(characterStates.createdAt));
  const chs = await chapterOrders(db, p.id);
  const cast = await db
    .select({ id: characters.id, name: characters.name, role: characters.role })
    .from(characters)
    .where(and(eq(characters.projectId, p.id), isNull(characters.deletedAt)))
    .orderBy(asc(characters.name));
  const outfits = cast.length
    ? await db
        .select({ id: characterOutfits.id, characterId: characterOutfits.characterId, name: characterOutfits.name })
        .from(characterOutfits)
        .where(
          inArray(
            characterOutfits.characterId,
            cast.map((x) => x.id),
          ),
        )
    : [];
  const [extraction] = await db
    .select({
      id: generationJobs.id,
      status: generationJobs.status,
      input: generationJobs.input,
      result: generationJobs.result,
      failureReason: generationJobs.failureReason,
      createdAt: generationJobs.createdAt,
    })
    .from(generationJobs)
    .where(and(eq(generationJobs.projectId, p.id), eq(generationJobs.kind, "bible_extract")))
    .orderBy(desc(generationJobs.createdAt))
    .limit(1);
  let inEffect = null;
  if (q.chapterId) {
    const ch = chs.find((x) => x.id === q.chapterId);
    if (!ch) throw notFound("Chapter");
    const [row] = await db
      .select({ summary: chapters.summary, source: chapters.sourceExcerpt, beats: chapters.beats })
      .from(chapters)
      .where(eq(chapters.id, ch.id));
    inEffect = bibleFor(
      await loadBible(db, p.id),
      { chapter: ch.order, scene: q.sceneNumber ?? null },
      { text: [ch.title, row?.summary, row?.source, ...(row?.beats ?? [])].join("\n") },
    );
  }
  return c.json({
    facts,
    states,
    chapters: chs,
    characters: cast.map((x) => ({ ...x, outfits: outfits.filter((o) => o.characterId === x.id) })),
    extraction: extraction ?? null,
    inEffect,
  });
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/bible/facts",
  summary: "Add a fact",
  tag: "bible",
  body: FactInput,
});
bibleRoutes.post("/projects/:projectId/bible/facts", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, FactInput);
  const { db } = c.get("deps");
  await checkRange(db, p.id, input.fromChapterId, input.untilChapterId);
  const [fact] = await db
    .insert(bibleFacts)
    .values({ ...input, projectId: p.id, createdByUserId: user(c).id })
    .returning();
  return c.json({ fact }, 201);
});

doc({ method: "PATCH", path: "/api/bible-facts/:id", summary: "Edit a fact", tag: "bible", body: FactPatch });
bibleRoutes.patch("/bible-facts/:id", async (c) => {
  const f = await factOf(c, "write");
  const input = await body(c, FactPatch);
  const { db } = c.get("deps");
  const keep = <T>(v: T | undefined, old: T) => (v === undefined ? old : v);
  await checkRange(
    db,
    f.projectId,
    keep(input.fromChapterId, f.fromChapterId),
    keep(input.untilChapterId, f.untilChapterId),
  );
  const [fact] = await db.update(bibleFacts).set(input).where(eq(bibleFacts.id, f.id)).returning();
  return c.json({ fact });
});

doc({ method: "DELETE", path: "/api/bible-facts/:id", summary: "Delete a fact", tag: "bible" });
bibleRoutes.delete("/bible-facts/:id", async (c) => {
  const f = await factOf(c, "write");
  await c.get("deps").db.delete(bibleFacts).where(eq(bibleFacts.id, f.id));
  return c.json({ ok: true });
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/bible/states",
  summary: "Add a character state (holds from a chapter, optionally a scene number of it, on)",
  tag: "bible",
  body: StateInput,
});
bibleRoutes.post("/projects/:projectId/bible/states", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, StateInput);
  const { db } = c.get("deps");
  await checkState(db, p.id, input);
  const [state] = await db
    .insert(characterStates)
    .values({ ...input, projectId: p.id, createdByUserId: user(c).id })
    .returning();
  return c.json({ state }, 201);
});

doc({
  method: "PATCH",
  path: "/api/character-states/:id",
  summary: "Edit a character state",
  tag: "bible",
  body: StatePatch,
});
bibleRoutes.patch("/character-states/:id", async (c) => {
  const s = await stateOf(c, "write");
  const input = await body(c, StatePatch);
  const { db } = c.get("deps");
  const next = { ...s, ...input };
  // A different character's outfit cannot carry over.
  if (input.characterId && input.characterId !== s.characterId && input.outfitId === undefined) next.outfitId = null;
  await checkState(db, s.projectId, next);
  const [state] = await db
    .update(characterStates)
    .set({ ...input, outfitId: next.outfitId })
    .where(eq(characterStates.id, s.id))
    .returning();
  return c.json({ state });
});

doc({ method: "DELETE", path: "/api/character-states/:id", summary: "Delete a character state", tag: "bible" });
bibleRoutes.delete("/character-states/:id", async (c) => {
  const s = await stateOf(c, "write");
  await c.get("deps").db.delete(characterStates).where(eq(characterStates.id, s.id));
  return c.json({ ok: true });
});

const ExtractInput = z.object({
  /** One chapter; omitted for all of them. */
  chapterId: Uuid.optional(),
  ai: AiChoiceInput,
  batch: BatchInput,
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/bible/extract",
  summary:
    "Extract bible from story: a text job that proposes facts and character states from the chapters (one, or all) and their chapter memory. Nothing is saved until POST /api/bible-extractions/:id/apply.",
  tag: "bible",
  body: ExtractInput,
});
bibleRoutes.post("/projects/:projectId/bible/extract", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  const input = await body(c, ExtractInput);
  const deps = c.get("deps");
  const chs = await chapterOrders(deps.db, p.id);
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
        kind: "bible_extract",
        priority: PRIORITY.single,
        targetType: input.chapterId ? "chapter" : "project",
        targetId: input.chapterId ?? p.id,
        batchId,
        templateName: bibleExtractV1.name,
        templateVersion: bibleExtractV1.version,
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

const ApplyExtraction = z.object({
  /** The reviewed proposal; omitted, the job's own result is applied as it is. */
  facts: z.array(ProposedFact).max(300).optional(),
  states: z.array(ProposedState).max(300).optional(),
  /** Apply a second time on purpose. */
  again: z.boolean().default(false),
});
doc({
  method: "POST",
  path: "/api/bible-extractions/:id/apply",
  summary:
    "Save a completed extraction's facts and states (or the reviewed subset sent here). Characters are matched by name or alias and chapters by number; entries that match nothing are skipped and listed. Applying twice is refused with 409 unless again=true.",
  tag: "bible",
  body: ApplyExtraction,
});
bibleRoutes.post("/bible-extractions/:id/apply", async (c) => {
  const deps = c.get("deps");
  const [job] = await deps.db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, uuidParam(c, "id")));
  if (job?.kind !== "bible_extract" || !job.projectId) throw notFound("Extraction");
  const p = await projectAccess(c, job.projectId, "write");
  if (job.status !== "completed")
    throw conflict(`This extraction is ${job.status}; only a completed one can be applied`);
  const input = await body(c, ApplyExtraction);
  const proposed = BibleExtraction.parse((job.result as { data?: unknown } | null)?.data ?? {});
  const facts = input.facts ?? proposed.facts;
  const states = input.states ?? proposed.states;
  const chs = await chapterOrders(deps.db, p.id);
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
  const outfits = cast.length
    ? await deps.db
        .select()
        .from(characterOutfits)
        .where(
          inArray(
            characterOutfits.characterId,
            cast.map((x) => x.id),
          ),
        )
    : [];
  const skipped: { entry: string; reason: string }[] = [];
  /** A chapter number to its id; `undefined` when the number names no chapter. */
  const chapter = (n: number | null | undefined) =>
    n == null ? null : (chs.find((x) => x.order === n)?.id ?? undefined);
  const lower = (s: string) => s.trim().toLowerCase();
  const characterNamed = (name: string) =>
    cast.find((x) => lower(x.name) === lower(name)) ??
    cast.find((x) => aliases.some((a) => a.characterId === x.id && lower(a.alias) === lower(name)));
  const factRows: (typeof bibleFacts.$inferInsert)[] = [];
  for (const f of facts) {
    const [from, until] = [chapter(f.fromChapter), chapter(f.untilChapter)];
    if (from === undefined || until === undefined) {
      skipped.push({ entry: f.text, reason: `no chapter ${from === undefined ? f.fromChapter : f.untilChapter}` });
      continue;
    }
    factRows.push({
      projectId: p.id,
      kind: f.kind,
      subject: f.subject,
      text: f.text,
      fixed: f.fixed,
      visual: f.visual,
      fromChapterId: from,
      untilChapterId: until,
      source: "extracted" as const,
      createdByUserId: user(c).id,
    });
  }
  const stateRows: (typeof characterStates.$inferInsert)[] = [];
  for (const s of states) {
    const who = characterNamed(s.character);
    const [from, until] = [chapter(s.fromChapter), chapter(s.untilChapter)];
    if (!who) {
      skipped.push({ entry: `${s.character}: ${s.text}`, reason: `no character named ${s.character}` });
      continue;
    }
    if (from === undefined || until === undefined) {
      skipped.push({
        entry: `${s.character}: ${s.text}`,
        reason: `no chapter ${from === undefined ? s.fromChapter : s.untilChapter}`,
      });
      continue;
    }
    const outfit = s.outfit
      ? outfits.find((o) => o.characterId === who.id && lower(o.name) === lower(s.outfit!))
      : undefined;
    stateRows.push({
      projectId: p.id,
      characterId: who.id,
      kind: s.kind,
      text: s.text,
      chapterId: from,
      sceneNumber: from ? (s.fromScene ?? null) : null,
      untilChapterId: until,
      outfitId: outfit?.id ?? null,
      source: "extracted" as const,
      createdByUserId: user(c).id,
    });
  }
  const applied = { at: new Date().toISOString(), facts: factRows.length, states: stateRows.length };
  await deps.db.transaction(async (tx) => {
    // Claimed in the same transaction as the inserts: a double click or a retried call cannot save it twice.
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
    if (factRows.length) await tx.insert(bibleFacts).values(factRows);
    if (stateRows.length) await tx.insert(characterStates).values(stateRows);
  });
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "bible.extraction.apply",
    targetType: "generation_job",
    targetId: job.id,
    metadata: { ...applied, skipped: skipped.length },
    requestId: c.get("requestId"),
  });
  return c.json({ facts: factRows.length, states: stateRows.length, skipped });
});
