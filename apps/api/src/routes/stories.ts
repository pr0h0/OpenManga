import { and, desc, eq, generationJobs, inArray, sql, storyAnalyses, storyRevisions } from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { storyAnalysisV3, storyCoverageV1, storyRewriteV1 } from "@openmanga/prompts";
import { StoryAnalysis } from "@openmanga/schemas";
import { analysisDiff, applyStoryAnalysis, recordAudit } from "@openmanga/services";
import { sha256Hex } from "@openmanga/storage";
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
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

export const storyRoutes = new Hono<AppEnv>();

const InputKind = z.enum(["story", "chapter", "outline", "screenplay", "idea"]);
export const NewRevision = z.object({
  content: z.string().min(1).max(500_000),
  title: z.string().max(200).default(""),
  inputKind: InputKind.default("story"),
});
export const PatchRevision = z.object({
  content: z.string().min(1).max(500_000).optional(),
  title: z.string().max(200).optional(),
  inputKind: InputKind.optional(),
  baseSha256: z.string().optional(),
});

async function revisionWithAccess(
  c: Parameters<typeof projectAccess>[0],
  id: string,
  action: "read" | "write" | "generate",
) {
  const [rev] = await c.get("deps").db.select().from(storyRevisions).where(eq(storyRevisions.id, id));
  if (!rev) throw notFound("Story revision");
  const project = await projectAccess(c, rev.projectId, action);
  return { rev, project };
}

async function nextRevisionNumber(c: Parameters<typeof projectAccess>[0], projectId: string) {
  const [r] = await c
    .get("deps")
    .db.select({ n: sql<number>`coalesce(max(${storyRevisions.revisionNumber}),0)::int` })
    .from(storyRevisions)
    .where(eq(storyRevisions.projectId, projectId));
  return (r?.n ?? 0) + 1;
}

doc({
  method: "GET",
  path: "/api/projects/:projectId/story",
  summary: "Story revisions (latest content) and analyses",
  tag: "stories",
});
storyRoutes.get("/projects/:projectId/story", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const revisions = await db
    .select({
      id: storyRevisions.id,
      revisionNumber: storyRevisions.revisionNumber,
      source: storyRevisions.source,
      inputKind: storyRevisions.inputKind,
      title: storyRevisions.title,
      lockedAt: storyRevisions.lockedAt,
      createdAt: storyRevisions.createdAt,
      updatedAt: storyRevisions.updatedAt,
      contentSha256: storyRevisions.contentSha256,
      length: sql<number>`length(${storyRevisions.content})`,
    })
    .from(storyRevisions)
    .where(eq(storyRevisions.projectId, p.id))
    .orderBy(desc(storyRevisions.revisionNumber));
  const [latest] = revisions.length
    ? await db.select().from(storyRevisions).where(eq(storyRevisions.id, revisions[0]!.id))
    : [];
  const analyses = await db
    .select()
    .from(storyAnalyses)
    .where(eq(storyAnalyses.projectId, p.id))
    .orderBy(desc(storyAnalyses.createdAt))
    .limit(20);
  return c.json({ revisions, latest: latest ?? null, analyses });
});

doc({ method: "GET", path: "/api/story-revisions/:id", summary: "Get a story revision", tag: "stories" });
storyRoutes.get("/story-revisions/:id", async (c) => {
  const { rev } = await revisionWithAccess(c, uuidParam(c, "id"), "read");
  return c.json({ revision: rev });
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/story/revisions",
  summary: "Create a new story revision",
  tag: "stories",
  body: NewRevision,
});
storyRoutes.post("/projects/:projectId/story/revisions", async (c) =>
  c.json({ revision: await createRevision(c, uuidParam(c, "projectId"), await body(c, NewRevision)) }, 201),
);

/** A new story revision: the route, and an expert's outline once the user applies it. */
export async function createRevision(
  c: Parameters<typeof projectAccess>[0],
  projectId: string,
  input: z.infer<typeof NewRevision>,
) {
  const p = await projectAccess(c, projectId, "write");
  const n = await nextRevisionNumber(c, p.id);
  const [rev] = await c
    .get("deps")
    .db.insert(storyRevisions)
    .values({
      projectId: p.id,
      revisionNumber: n,
      source: n === 1 ? "initial" : "user_edit",
      inputKind: input.inputKind,
      title: input.title,
      content: input.content,
      contentSha256: sha256Hex(input.content),
      createdByUserId: user(c).id,
    })
    .returning();
  return rev!;
}

doc({
  method: "PATCH",
  path: "/api/story-revisions/:id",
  summary: "Autosave. Locked revisions fork into a new revision instead of being overwritten.",
  tag: "stories",
  body: PatchRevision,
});
storyRoutes.patch("/story-revisions/:id", async (c) => {
  const { rev, project } = await revisionWithAccess(c, uuidParam(c, "id"), "write");
  const input = await body(c, PatchRevision);
  const content = input.content ?? rev.content;
  const { db } = c.get("deps");
  if (input.baseSha256 && input.baseSha256 !== rev.contentSha256 && !rev.lockedAt) {
    throw conflict("This story was changed elsewhere. Reload to get the latest version before saving.");
  }
  if (rev.lockedAt) {
    if (content === rev.content && (input.title ?? rev.title) === rev.title)
      return c.json({ revision: rev, forked: false });
    const n = await nextRevisionNumber(c, project.id);
    const [created] = await db
      .insert(storyRevisions)
      .values({
        projectId: project.id,
        revisionNumber: n,
        source: "user_edit",
        inputKind: input.inputKind ?? rev.inputKind,
        title: input.title ?? rev.title,
        content,
        contentSha256: sha256Hex(content),
        createdByUserId: user(c).id,
      })
      .returning();
    return c.json({ revision: created, forked: true });
  }
  const [updated] = await db
    .update(storyRevisions)
    .set({
      content,
      title: input.title ?? rev.title,
      inputKind: input.inputKind ?? rev.inputKind,
      contentSha256: sha256Hex(content),
    })
    .where(and(eq(storyRevisions.id, rev.id)))
    .returning();
  return c.json({ revision: updated, forked: false });
});

doc({
  method: "POST",
  path: "/api/story-revisions/:id/analyze",
  summary: "Queue DeepSeek story analysis for this revision (locks it)",
  tag: "stories",
});
storyRoutes.post("/story-revisions/:id/analyze", async (c) => {
  const { rev, project } = await revisionWithAccess(c, uuidParam(c, "id"), "generate");
  const { ai, batch } = await body(c, z.object({ ai: AiChoiceInput, batch: BatchInput }));
  const deps = c.get("deps");
  await assertBudget(c, project.id);
  const run = await textRun(c, ai);
  assertBatchable(c, batch, run.provider);
  const analysisBatchId = batch ? crypto.randomUUID() : null;
  const result = await deps.db.transaction(async (tx) => {
    await tx
      .update(storyRevisions)
      .set({ lockedAt: rev.lockedAt ?? new Date() })
      .where(eq(storyRevisions.id, rev.id));
    const [analysis] = await tx
      .insert(storyAnalyses)
      .values({ projectId: project.id, storyRevisionId: rev.id })
      .returning();
    const job = await deps.jobs.createGenerationJob(
      tx,
      {
        projectId: project.id,
        userId: user(c).id,
        kind: "story_analysis",
        priority: PRIORITY.single,
        targetType: "story_analysis",
        targetId: analysis!.id,
        batchId: analysisBatchId,
        templateName: storyAnalysisV3.name,
        templateVersion: storyAnalysisV3.version,
        provider: run.provider,
        model: run.model,
        parameters: { ...run.parameters, ...batchParameters(batch) },
        input: { storyRevisionId: rev.id, analysisId: analysis!.id },
      },
      { enqueue: !batch },
    );
    await tx.update(storyAnalyses).set({ generationJobId: job.id }).where(eq(storyAnalyses.id, analysis!.id));
    return { analysis: { ...analysis!, generationJobId: job.id }, job };
  });
  if (analysisBatchId) await queueTextBatchSubmit(c, { projectId: project.id, batchId: analysisBatchId, ai });
  await deps.jobs.kick();
  return c.json(result, 202);
});

export const RewriteInput = z.object({
  instruction: z.string().trim().min(3).max(4000),
  batch: BatchInput,
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/story-revisions/:id/rewrite",
  summary: "Queue an AI rewrite producing a new revision",
  tag: "stories",
  body: RewriteInput,
});
storyRoutes.post("/story-revisions/:id/rewrite", async (c) => {
  const { rev, project } = await revisionWithAccess(c, uuidParam(c, "id"), "generate");
  const { instruction, ai, batch } = await body(c, RewriteInput);
  const deps = c.get("deps");
  await assertBudget(c, project.id);
  const run = await textRun(c, ai);
  assertBatchable(c, batch, run.provider);
  const rewriteBatchId = batch ? crypto.randomUUID() : null;
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(
      tx,
      {
        projectId: project.id,
        userId: user(c).id,
        kind: "story_rewrite",
        priority: PRIORITY.single,
        targetType: "story_revision",
        targetId: rev.id,
        batchId: rewriteBatchId,
        templateName: storyRewriteV1.name,
        templateVersion: storyRewriteV1.version,
        provider: run.provider,
        model: run.model,
        parameters: { ...run.parameters, ...batchParameters(batch) },
        input: { storyRevisionId: rev.id, instruction },
      },
      { enqueue: !batch },
    ),
  );
  if (rewriteBatchId) await queueTextBatchSubmit(c, { projectId: project.id, batchId: rewriteBatchId, ai });
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

async function analysisWithAccess(c: Parameters<typeof projectAccess>[0], id: string, action: "read" | "write") {
  const [a] = await c.get("deps").db.select().from(storyAnalyses).where(eq(storyAnalyses.id, id));
  if (!a) throw notFound("Analysis");
  await projectAccess(c, a.projectId, action);
  return a;
}

doc({ method: "GET", path: "/api/story-analyses/:id", summary: "Get analysis result", tag: "stories" });
storyRoutes.get("/story-analyses/:id", async (c) =>
  c.json({ analysis: await analysisWithAccess(c, uuidParam(c, "id"), "read") }),
);

doc({
  method: "GET",
  path: "/api/story-analyses/:id/diff",
  summary:
    "What applying this analysis would change in the project: chapters kept (and whether their source text changed), renamed, added and removed, with each one's pages and drawn panels; characters, locations and props added or removed. Applying never removes anything: removed items are listed so their deletion can be confirmed separately.",
  tag: "stories",
});
storyRoutes.get("/story-analyses/:id/diff", async (c) => {
  const a = await analysisWithAccess(c, uuidParam(c, "id"), "read");
  if (!a.result) throw badRequest("Analysis has not completed");
  return c.json({ diff: await analysisDiff(c.get("deps").db, a.id) });
});

const PatchAnalysis = z.object({ result: StoryAnalysis });
doc({
  method: "PATCH",
  path: "/api/story-analyses/:id",
  summary: "Edit analysis result before applying",
  tag: "stories",
  body: PatchAnalysis,
});
storyRoutes.patch("/story-analyses/:id", async (c) => {
  const a = await analysisWithAccess(c, uuidParam(c, "id"), "write");
  if (a.status === "pending" || a.status === "failed") throw badRequest("Analysis has no result to edit");
  const { result } = await body(c, PatchAnalysis);
  const [row] = await c
    .get("deps")
    .db.update(storyAnalyses)
    .set({ result })
    .where(eq(storyAnalyses.id, a.id))
    .returning();
  return c.json({ analysis: row });
});

const ApplyAnalysis = z.object({ result: StoryAnalysis.optional() });
doc({
  method: "POST",
  path: "/api/story-analyses/:id/apply",
  summary:
    "Create cast, world and chapters from the (edited) analysis. On a project that already has them it is additive: chapters are matched by title (else renamed by position) and keep their pages, new chapters are inserted in place, and nothing is removed (see the diff route).",
  tag: "stories",
  body: ApplyAnalysis,
});
storyRoutes.post("/story-analyses/:id/apply", async (c) => {
  const a = await analysisWithAccess(c, uuidParam(c, "id"), "write");
  if (!a.result) throw badRequest("Analysis has not completed");
  const { result } = await body(c, ApplyAnalysis);
  const created = await applyStoryAnalysis(c.get("deps").db, a.id, user(c).id, result);
  await recordAudit(c.get("deps").db, {
    userId: user(c).id,
    projectId: a.projectId,
    action: "story.analysis_applied",
    targetType: "story_analysis",
    targetId: a.id,
    metadata: created,
    requestId: c.get("requestId"),
  });
  return c.json({ created });
});

// ---------------------------------------------------------------- story coverage

/** The revision the plan was built from: the one the newest applied analysis read. */
async function appliedRevisionId(c: Parameters<typeof projectAccess>[0], projectId: string) {
  const [a] = await c
    .get("deps")
    .db.select({ id: storyAnalyses.storyRevisionId })
    .from(storyAnalyses)
    .where(and(eq(storyAnalyses.projectId, projectId), eq(storyAnalyses.status, "applied")))
    .orderBy(sql`${storyAnalyses.appliedAt} desc nulls last`)
    .limit(1);
  return a?.id ?? null;
}

export const CoverageInput = z.object({
  /** Another revision of this project to compare with the plan; the applied one when omitted. */
  storyRevisionId: z.string().uuid().optional(),
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/story/coverage",
  summary:
    "Queue a story coverage check (story_coverage job): maps the applied story revision, part by part, to the chapters and scenes, and reports what was left out, told twice, or given far more or less room than its weight",
  tag: "stories",
  body: CoverageInput,
});
storyRoutes.post("/projects/:projectId/story/coverage", async (c) => {
  const project = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  const input = await body(c, CoverageInput);
  const deps = c.get("deps");
  const revisionId = input.storyRevisionId ?? (await appliedRevisionId(c, project.id));
  if (!revisionId) throw conflict("Analyse the story and apply the analysis first: coverage compares the plan with it");
  const [rev] = await deps.db
    .select({ p: storyRevisions.projectId })
    .from(storyRevisions)
    .where(eq(storyRevisions.id, revisionId));
  if (rev?.p !== project.id) throw notFound("Story revision");
  await assertBudget(c, project.id);
  const run = await textRun(c, input.ai);
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(tx, {
      projectId: project.id,
      userId: user(c).id,
      kind: "story_coverage",
      priority: PRIORITY.single,
      targetType: "story_revision",
      targetId: revisionId,
      templateName: storyCoverageV1.name,
      templateVersion: storyCoverageV1.version,
      provider: run.provider,
      model: run.model,
      parameters: run.parameters,
      input: { storyRevisionId: revisionId, language: project.language },
    }),
  );
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

type CoverageResult = {
  storyRevisionId: string;
  findings: { spans: { start: number; end: number; paragraphs: string[] }[] }[];
};
doc({
  method: "GET",
  path: "/api/projects/:projectId/story/coverage",
  summary:
    "The newest story coverage report: findings with their source spans (offsets and an excerpt) and chapters/scenes, source vs panel vs narration share per chapter, whether the story or the plan changed since, and any check still running",
  tag: "stories",
});
storyRoutes.get("/projects/:projectId/story/coverage", async (c) => {
  const project = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const coverageJobs = and(eq(generationJobs.projectId, project.id), eq(generationJobs.kind, "story_coverage"));
  const [last] = await db
    .select()
    .from(generationJobs)
    .where(and(coverageJobs, eq(generationJobs.status, "completed")))
    .orderBy(desc(generationJobs.finishedAt))
    .limit(1);
  const [running] = await db
    .select({ id: generationJobs.id, status: generationJobs.status })
    .from(generationJobs)
    .where(and(coverageJobs, inArray(generationJobs.status, ["queued", "processing", "awaiting_input", "submitted"])))
    .orderBy(desc(generationJobs.createdAt))
    .limit(1);
  const chapters = [
    ...(await db.execute<{ id: string; order: number; title: string }>(
      sql`select id, "order", title from chapters where project_id = ${project.id} order by "order"`,
    )),
  ];
  const scenes = (
    await db.execute<{ id: string; chapter_id: string; title: string }>(
      sql`select id, chapter_id, title from scenes where project_id = ${project.id} order by chapter_id, "order"`,
    )
  ).map((s) => ({ id: s.id, chapterId: s.chapter_id, title: s.title }));
  if (!last?.result) return c.json({ report: null, stale: null, running: running ?? null, chapters, scenes });
  const result = last.result as CoverageResult;
  const [rev] = await db
    .select({ content: storyRevisions.content })
    .from(storyRevisions)
    .where(eq(storyRevisions.id, result.storyRevisionId));
  // The plan moved on when anything it is made of was edited after the report.
  const [plan] = await db.execute<{ changed: boolean }>(sql`
    select coalesce(greatest(
      (select max(updated_at) from chapters where project_id = ${project.id}),
      (select max(updated_at) from scenes where project_id = ${project.id}),
      (select max(updated_at) from pages where project_id = ${project.id}),
      (select max(updated_at) from panels where project_id = ${project.id})
    ) > ${last.finishedAt?.toISOString() ?? null}::timestamptz, false) as changed`);
  const applied = await appliedRevisionId(c, project.id);
  return c.json({
    report: {
      ...result,
      jobId: last.id,
      finishedAt: last.finishedAt,
      findings: result.findings.map((f) => ({
        ...f,
        spans: f.spans.map((s) => ({
          ...s,
          excerpt: rev ? rev.content.slice(s.start, Math.min(s.end, s.start + 400)) : "",
        })),
      })),
    },
    stale: { story: Boolean(applied && applied !== result.storyRevisionId), plan: Boolean(plan?.changed) },
    running: running ?? null,
    chapters,
    scenes,
  });
});
