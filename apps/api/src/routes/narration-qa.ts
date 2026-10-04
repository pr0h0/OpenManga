import {
  and,
  asc,
  audioJobs,
  desc,
  eq,
  generationJobs,
  inArray,
  narrationFindings,
  narrationLines,
  narrationSegments,
  sql,
} from "@openmanga/db";
import { narrationDensity, PRIORITY } from "@openmanga/domain";
import { narrationFixV1, narrationLintV1 } from "@openmanga/prompts";
import { isAudioKind, isRuleKind, lintNarrationChapters, loadNarrationQa, UNFIXABLE_KINDS } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, type ProjectRecord, projectAccess } from "../lib/access.ts";
import { AiChoiceInput, assertBudget, textRun, ttsRun } from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { resegment } from "./audio.ts";

export const narrationQaRoutes = new Hono<AppEnv>();

const Language = z.string().trim().min(2).max(16).optional();

/** Queues the semantic lint of some chapters, one text job each. */
async function queueSemantic(
  c: Context<AppEnv>,
  project: ProjectRecord,
  chapterIds: string[],
  language: string,
  ai: AiChoiceInput,
) {
  const deps = c.get("deps");
  await assertBudget(c, project.id);
  const run = await textRun(c, ai);
  const jobs = await deps.db.transaction(async (tx) => {
    const out = [];
    for (const chapterId of chapterIds)
      out.push(
        await deps.jobs.createGenerationJob(tx, {
          projectId: project.id,
          userId: user(c).id,
          kind: "narration_lint",
          priority: PRIORITY.single,
          targetType: "chapter",
          targetId: chapterId,
          templateName: narrationLintV1.name,
          templateVersion: narrationLintV1.version,
          provider: run.provider,
          model: run.model,
          parameters: run.parameters,
          input: { chapterId, language },
        }),
      );
    return out;
  });
  await deps.jobs.kick();
  return jobs;
}

/** Queues the audio check of some chapters (all voiced ones when none are named): one job, no model, nothing spent. */
async function queueAudio(c: Context<AppEnv>, project: ProjectRecord, chapterId: string | null, language: string) {
  const deps = c.get("deps");
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(tx, {
      projectId: project.id,
      userId: user(c).id,
      kind: "audio_check",
      priority: PRIORITY.single,
      targetType: chapterId ? "chapter" : "project",
      targetId: chapterId ?? project.id,
      input: { language, ...(chapterId ? { chapterIds: [chapterId] } : {}) },
    }),
  );
  await deps.jobs.kick();
  return job;
}

export const LintInput = z.object({
  language: Language,
  /** Also queue the semantic checks (a text job per chapter) on the chosen text model or in paste mode. */
  semantic: z.boolean().default(false),
  /**
   * Also queue the audio check: silent, clipped or stalled segments, lines much louder or quieter than their chapter,
   * and each chapter's loudness and true peak. One audio_check job; no model, nothing spent.
   */
  audio: z.boolean().default(false),
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/chapters/:id/narration/lint",
  summary:
    "Check a chapter's narration: the deterministic checks run now and are stored as findings (with how they compare to the last run); semantic=true also queues the AI check as a narration_lint job; audio=true also queues the audio check (audio_check job) of its voiced audio",
  tag: "narration",
  body: LintInput,
});
narrationQaRoutes.post("/chapters/:id/narration/lint", async (c) => {
  const chapterId = uuidParam(c, "id");
  const input = await body(c, LintInput);
  const project = await entityAccess(c, "chapter", chapterId, input.semantic ? "generate" : "write");
  const language = input.language || project.language;
  const [rules] = await lintNarrationChapters(c.get("deps").db, project, language, [chapterId]);
  const jobs = input.semantic ? await queueSemantic(c, project, [chapterId], language, input.ai) : [];
  const audioJob = input.audio ? await queueAudio(c, project, chapterId, language) : null;
  return c.json({ language, rules, job: jobs[0] ?? null, audioJob }, input.semantic || input.audio ? 202 : 200);
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/narration/lint",
  summary:
    "Check the narration of every chapter that has some: deterministic checks now; semantic=true also queues one narration_lint job per chapter; audio=true also queues one audio_check job for every voiced chapter",
  tag: "narration",
  body: LintInput,
});
narrationQaRoutes.post("/projects/:projectId/narration/lint", async (c) => {
  const input = await body(c, LintInput);
  const project = await projectAccess(c, uuidParam(c, "projectId"), input.semantic ? "generate" : "write");
  const language = input.language || project.language;
  const rules = await lintNarrationChapters(c.get("deps").db, project, language);
  const jobs = input.semantic
    ? await queueSemantic(
        c,
        project,
        rules.map((r) => r.chapterId),
        language,
        input.ai,
      )
    : [];
  const audioJob = input.audio ? await queueAudio(c, project, null, language) : null;
  return c.json({ language, rules, jobs, audioJob }, input.semantic || input.audio ? 202 : 200);
});

/**
 * Each chapter's loudness from the newest completed audio check that measured it: integrated LUFS, loudness range and
 * true peak, with when it was measured.
 */
async function latestAudioReport(db: AppEnv["Variables"]["deps"]["db"], projectId: string, language: string) {
  const jobs = await db
    .select({ result: generationJobs.result, finishedAt: generationJobs.finishedAt })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.projectId, projectId),
        eq(generationJobs.kind, "audio_check"),
        eq(generationJobs.status, "completed"),
        sql`${generationJobs.input} ->> 'language' = ${language}`,
      ),
    )
    .orderBy(desc(generationJobs.finishedAt))
    .limit(20);
  type Row = { chapterId: string; lufs: number | null; lra: number | null; truePeakDb: number | null };
  const out = new Map<string, Row & { measuredAt: Date | null }>();
  for (const j of jobs)
    for (const r of (j.result as { chapters?: Row[] } | null)?.chapters ?? [])
      if (!out.has(r.chapterId)) out.set(r.chapterId, { ...r, measuredAt: j.finishedAt });
  return [...out.values()];
}

const FindingsQuery = z.object({
  language: Language,
  chapterId: z.string().uuid().optional(),
  status: z.enum(["open", "ignored", "fixed"]).optional(),
  kind: z.string().max(40).optional(),
});
doc({
  method: "GET",
  path: "/api/projects/:projectId/narration/findings",
  summary:
    "Narration QA findings with counts by kind, status and chapter, and the text of the lines they point at (each finding's `check`: rule, ai or audio), plus `audio`: each chapter's loudness (integrated LUFS, loudness range, true peak) from the newest audio check that measured it. Filter by chapter, status or kind.",
  tag: "narration",
  query: FindingsQuery,
});
narrationQaRoutes.get("/projects/:projectId/narration/findings", async (c) => {
  const project = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, FindingsQuery);
  const language = q.language || project.language;
  const { db } = c.get("deps");
  const all = await db
    .select()
    .from(narrationFindings)
    .where(
      and(
        eq(narrationFindings.projectId, project.id),
        eq(narrationFindings.language, language),
        q.chapterId ? eq(narrationFindings.chapterId, q.chapterId) : undefined,
      ),
    )
    .orderBy(asc(narrationFindings.createdAt));
  const count = (key: (f: (typeof all)[number]) => string, rows = all) =>
    rows.reduce<Record<string, number>>((m, f) => {
      m[key(f)] = (m[key(f)] ?? 0) + 1;
      return m;
    }, {});
  const open = all.filter((f) => f.status === "open");
  const findings = all.filter((f) => (!q.status || f.status === q.status) && (!q.kind || f.kind === q.kind));
  const lineIds = [...new Set(findings.flatMap((f) => f.lineIds))];
  const lines = lineIds.length
    ? await db
        .select({
          id: narrationLines.id,
          chapterId: narrationLines.chapterId,
          order: narrationLines.order,
          text: narrationLines.text,
        })
        .from(narrationLines)
        .where(inArray(narrationLines.id, lineIds))
    : [];
  return c.json({
    language,
    findings: findings.map((f) => ({
      ...f,
      fixable: !UNFIXABLE_KINDS.includes(f.kind),
      check: isRuleKind(f.kind) ? "rule" : isAudioKind(f.kind) ? "audio" : "ai",
    })),
    audio: await latestAudioReport(db, project.id, language),
    lines,
    counts: {
      byStatus: count((f) => f.status),
      openByKind: count((f) => f.kind, open),
      openByChapter: count((f) => f.chapterId, open),
    },
  });
});

const PatchFinding = z.object({ status: z.enum(["open", "ignored"]) });
doc({
  method: "PATCH",
  path: "/api/narration-findings/:id",
  summary: "Ignore a narration finding (it stays ignored while later runs find the same thing) or reopen it",
  tag: "narration",
  body: PatchFinding,
});
narrationQaRoutes.patch("/narration-findings/:id", async (c) => {
  const { db } = c.get("deps");
  const [f] = await db
    .select()
    .from(narrationFindings)
    .where(eq(narrationFindings.id, uuidParam(c, "id")));
  if (!f) throw notFound("Finding");
  await projectAccess(c, f.projectId, "write");
  const { status } = await body(c, PatchFinding);
  const [row] = await db.update(narrationFindings).set({ status }).where(eq(narrationFindings.id, f.id)).returning();
  return c.json({ finding: row });
});

const DensityQuery = z.object({ language: Language, chapterId: z.string().uuid().optional() });
doc({
  method: "GET",
  path: "/api/projects/:projectId/narration/density",
  summary:
    "Narration density per chapter (words, words per shot, silent shots, words per minute from current audio); with chapterId, also shot by shot",
  tag: "narration",
  query: DensityQuery,
});
narrationQaRoutes.get("/projects/:projectId/narration/density", async (c) => {
  const project = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, DensityQuery);
  const language = q.language || project.language;
  const chapters = await loadNarrationQa(c.get("deps").db, project.id, language);
  if (q.chapterId && !chapters.some((ch) => ch.id === q.chapterId)) throw notFound("Chapter");
  return c.json({
    language,
    target: {
      wordsPerShot: project.settings.narrationWordsPerPanel ?? 21,
      wordsPerMinute: project.settings.targetRuntime?.wordsPerMinute ?? 150,
    },
    chapters: chapters.map((ch) => {
      const { shots, totals } = narrationDensity(ch);
      const { shots: shotCount, ...rest } = totals;
      return {
        id: ch.id,
        order: ch.order,
        title: ch.title,
        shotCount,
        ...rest,
        shots:
          ch.id === q.chapterId ? shots.map(({ id, words, covered }) => ({ id, words, silent: !covered })) : undefined,
      };
    }),
  });
});

export const FixInput = z.object({
  findingIds: z.array(z.string().uuid()).min(1).max(100),
  language: Language,
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/chapters/:id/narration/fix",
  summary:
    "Queue a narration_fix job: rewrites of only the lines the chosen findings flag, returned in the job result as before/after pairs. Nothing changes until the fix is applied.",
  tag: "narration",
  body: FixInput,
});
narrationQaRoutes.post("/chapters/:id/narration/fix", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "generate");
  const input = await body(c, FixInput);
  const deps = c.get("deps");
  const findings = await deps.db
    .select()
    .from(narrationFindings)
    .where(and(inArray(narrationFindings.id, input.findingIds), eq(narrationFindings.chapterId, chapterId)));
  const usable = findings.filter((f) => !UNFIXABLE_KINDS.includes(f.kind) && f.lineIds.length);
  if (!usable.length)
    throw badRequest("None of these findings can be fixed by rewriting lines (silences and pace need lines added)");
  await assertBudget(c, project.id);
  const run = await textRun(c, input.ai);
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(tx, {
      projectId: project.id,
      userId: user(c).id,
      kind: "narration_fix",
      priority: PRIORITY.single,
      targetType: "chapter",
      targetId: chapterId,
      templateName: narrationFixV1.name,
      templateVersion: narrationFixV1.version,
      provider: run.provider,
      model: run.model,
      parameters: run.parameters,
      input: { chapterId, language: input.language || findings[0]!.language, findingIds: usable.map((f) => f.id) },
    }),
  );
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

export const ApplyFixInput = z.object({
  jobId: z.string().uuid(),
  /** Apply only these lines' rewrites; all of the proposal when omitted. */
  lineIds: z.array(z.string().uuid()).optional(),
  /** Queue synthesis for the changed segments of lines that were voiced. */
  revoice: z.boolean().default(true),
  /** Speech provider for the re-voicing; the server's local voice when omitted. */
  ai: AiChoiceInput,
  /** Also queue the AI check again on the chapter, on the same model the fix used, to compare its findings. */
  recheck: z.boolean().default(false),
});
type Proposal = { lineId: string; before: string; after: string };
doc({
  method: "POST",
  path: "/api/chapters/:id/narration/fix/apply",
  summary:
    "Apply a narration_fix proposal: rewrites the chosen lines (lines edited since are skipped), marks the findings fixed, re-voices only the changed segments, and re-runs the deterministic checks on the chapter to compare before and after",
  tag: "narration",
  body: ApplyFixInput,
});
narrationQaRoutes.post("/chapters/:id/narration/fix/apply", async (c) => {
  const chapterId = uuidParam(c, "id");
  const input = await body(c, ApplyFixInput);
  const project = await entityAccess(c, "chapter", chapterId, input.revoice || input.recheck ? "generate" : "write");
  const deps = c.get("deps");
  const [job] = await deps.db.select().from(generationJobs).where(eq(generationJobs.id, input.jobId));
  if (job?.kind !== "narration_fix" || job.projectId !== project.id || job.input.chapterId !== chapterId)
    throw notFound("Narration fix");
  if (job.status !== "completed" || !job.result)
    throw conflict(`The fix is ${job.status}; apply it once it has completed`);
  const language = String(job.input.language);
  const proposals = ((job.result.proposals ?? []) as Proposal[]).filter(
    (p) => !input.lineIds || input.lineIds.includes(p.lineId),
  );
  const voice = input.revoice ? await ttsRun(c, input.ai) : null;
  const applied: string[] = [];
  const skipped: string[] = [];
  const toVoice: string[] = [];
  for (const p of proposals) {
    const [line] = await deps.db.select().from(narrationLines).where(eq(narrationLines.id, p.lineId));
    // Edited (or deleted) since the proposal was written: the proposal no longer describes it.
    if (!line || line.text !== p.before) {
      skipped.push(p.lineId);
      continue;
    }
    const before = await deps.db
      .select({ audio: narrationSegments.activeAudioAssetId })
      .from(narrationSegments)
      .where(eq(narrationSegments.narrationLineId, line.id));
    await deps.db.update(narrationLines).set({ text: p.after }).where(eq(narrationLines.id, line.id));
    // Unchanged sentences keep their segment and audio; only the rewritten ones lose it.
    const segments = await resegment(c, line.id, project.id, p.after, deps.config.NARRATION_SEGMENT_MAX_CHARS);
    if (before.some((s) => s.audio)) toVoice.push(...segments.filter((s) => !s.activeAudioAssetId).map((s) => s.id));
    applied.push(line.id);
  }
  const fixed = ((job.result.findingIds ?? []) as string[]).filter(Boolean);
  if (applied.length && fixed.length)
    await deps.db
      .update(narrationFindings)
      .set({ status: "fixed" })
      .where(and(inArray(narrationFindings.id, fixed), eq(narrationFindings.status, "open")));
  // The deterministic checks again, at once, so the answer shows whether the fix brought new findings.
  const [rules] = await lintNarrationChapters(deps.db, project, language, [chapterId]);
  let revoiced = 0;
  if (voice && toVoice.length) {
    const busy = new Set(
      (
        await deps.db
          .select({ id: audioJobs.segmentId })
          .from(audioJobs)
          .where(and(inArray(audioJobs.segmentId, toVoice), inArray(audioJobs.status, ["queued", "processing"])))
      ).map((r) => r.id),
    );
    const segs = await deps.db.select().from(narrationSegments).where(inArray(narrationSegments.id, toVoice));
    await deps.db.transaction(async (tx) => {
      for (const s of segs) {
        if (busy.has(s.id)) continue;
        await deps.jobs.createAudioJob(tx, {
          projectId: project.id,
          userId: user(c).id,
          segmentId: s.id,
          voice: voice.voice ?? s.voice ?? project.settings.narrationVoice,
          speed: s.speed ?? project.settings.narrationSpeed,
          priority: PRIORITY.interactive,
          options: voice.options,
        });
        revoiced++;
      }
    });
    await deps.jobs.kick();
  }
  const recheck =
    input.recheck && applied.length
      ? ((
          await queueSemantic(c, project, [chapterId], language, (job.parameters.ai ?? undefined) as AiChoiceInput)
        )[0] ?? null)
      : null;
  return c.json({ applied, skipped, revoiced, rules, recheckJob: recheck });
});
