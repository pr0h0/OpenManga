import { and, desc, eq, sql, storyAnalyses, storyRevisions } from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { storyAnalysisV2, storyRewriteV1 } from "@openmanga/prompts";
import { StoryAnalysis } from "@openmanga/schemas";
import { applyStoryAnalysis, recordAudit } from "@openmanga/services";
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
const NewRevision = z.object({
  content: z.string().min(1).max(500_000),
  title: z.string().max(200).default(""),
  inputKind: InputKind.default("story"),
});
const PatchRevision = z.object({
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
storyRoutes.post("/projects/:projectId/story/revisions", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, NewRevision);
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
  return c.json({ revision: rev }, 201);
});

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
        templateName: storyAnalysisV2.name,
        templateVersion: storyAnalysisV2.version,
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

const RewriteInput = z.object({
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
  summary: "Create cast, world and chapters from the (edited) analysis",
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
