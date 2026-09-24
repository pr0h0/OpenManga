import { storyAnalyses } from "@openmanga/db";
import { z } from "zod";
import { NewRevision, PatchRevision } from "../../routes/stories.ts";
import { defineMcpTool, IdempotencyKey, Passthrough } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { AiInput, aiLabel, cls, jobView, links, projectOf, restAi, stamp, textSpend, Uuid } from "./common.ts";

const CHUNK = 50_000;

const JobResult = z.object({ job: Passthrough }).passthrough();

export const storyTools = [
  defineMcpTool({
    name: "get_story",
    title: "Get story overview",
    description:
      "A project's story revisions (metadata and length, newest first) and its analyses (status and ids, without their full results). Read the text itself with get_story_revision and an analysis with get_story_analysis. Read-only.",
    input: z.object({ projectId: Uuid }),
    output: z.object({
      revisions: z.array(Passthrough),
      analyses: z.array(Passthrough),
      latestRevisionId: z.string().nullable(),
    }),
    scopes: ["story:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/story"],
    actionKeys: [],
    handler: async ({ projectId }, ctx) => {
      const r = await ctx.invoke<{
        revisions: Record<string, unknown>[];
        latest: { id: string } | null;
        analyses: Record<string, unknown>[];
      }>("GET", `/api/projects/${projectId}/story`);
      return {
        data: {
          revisions: r.revisions,
          latestRevisionId: r.latest?.id ?? null,
          analyses: r.analyses.map(({ result, ...a }) => ({ ...a, hasResult: Boolean(result) })),
        },
        links: { story: ctx.deps.urls.appUrl(`projects/${projectId}/story`) },
      };
    },
  }),

  defineMcpTool({
    name: "get_story_revision",
    title: "Read story revision",
    description: `The text of one story revision, in chunks of up to ${CHUNK} characters (use offset to read on). Read-only.`,
    input: z.object({ revisionId: Uuid, offset: z.number().int().min(0).default(0) }),
    output: Passthrough,
    scopes: ["story:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/story-revisions/:id"],
    actionKeys: [],
    handler: async ({ revisionId, offset }, ctx) => {
      const { revision } = await ctx.invoke<{ revision: Record<string, unknown> & { content: string } }>(
        "GET",
        `/api/story-revisions/${revisionId}`,
      );
      const { content, ...meta } = revision;
      const text = content.slice(offset, offset + CHUNK);
      return {
        data: {
          revision: meta,
          length: content.length,
          offset,
          content: text,
          nextOffset: offset + text.length < content.length ? offset + text.length : null,
        },
      };
    },
  }),

  defineMcpTool({
    name: "save_story_revision",
    title: "Save story revision",
    description:
      "Create a new story revision in a project (projectId), or edit an existing one (revisionId). Editing a revision that is locked (it was analysed) forks a new revision instead of overwriting it; the result says `forked`. Pass baseSha256 from the revision you read to refuse overwriting someone else's newer edit. Not asynchronous. Next: run_story_analysis.",
    input: z.object({
      projectId: Uuid.optional().describe("Create a new revision in this project."),
      revisionId: Uuid.optional().describe("Edit this revision instead."),
      content: NewRevision.shape.content.optional(),
      title: NewRevision.shape.title.optional(),
      inputKind: PatchRevision.shape.inputKind,
      baseSha256: PatchRevision.shape.baseSha256,
      idempotencyKey: IdempotencyKey,
    }),
    output: z.object({ revision: Passthrough }).passthrough(),
    scopes: ["story:write"],
    sensitivity: "write",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/story/revisions", "PATCH /api/story-revisions/:id"],
    actionKeys: ["story_revision.create", "story_revision.edit"],
    classify: async (a, ctx) =>
      a.revisionId
        ? cls(
            "write",
            "story_revision.edit",
            await projectOf(ctx, "story_revision", a.revisionId),
            "Edit a story revision",
          )
        : cls("write", "story_revision.create", a.projectId ?? null, "Create a story revision"),
    handler: async ({ projectId, revisionId, idempotencyKey: _k, ...rest }, ctx) => {
      const trim = (r: { revision: Record<string, unknown> }) => {
        const { content, ...meta } = r.revision as { content?: string };
        return { ...r, revision: { ...meta, length: content?.length } };
      };
      if (revisionId)
        return { data: trim(await ctx.invoke("PATCH", `/api/story-revisions/${revisionId}`, { body: rest })) };
      if (!projectId || !rest.content)
        throw toolError(400, "bad_request", "projectId and content are required to create a revision");
      return { data: trim(await ctx.invoke("POST", `/api/projects/${projectId}/story/revisions`, { body: rest })) };
    },
  }),

  defineMcpTool({
    name: "run_story_analysis",
    title: "Analyse story",
    description:
      "Queue a story analysis of a revision: it proposes the cast, locations, props and chapters (a StoryAnalysis) and locks the revision. Asynchronous: returns a job immediately; poll get_job. With ai.manual=true (no provider key needed, no spending) the job becomes awaiting_input: get_manual_prompt, answer with a StoryAnalysis JSON via submit_manual_answer. With a provider it spends the user's credits (may need approval). When the job completes, review with get_story_analysis, optionally edit_story_analysis, then apply_story_analysis.",
    input: z.object({ revisionId: Uuid, ai: AiInput, batch: z.boolean().optional(), idempotencyKey: IdempotencyKey }),
    output: z.object({ analysis: Passthrough, job: Passthrough }),
    scopes: ["story:write", "generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/story-revisions/:id/analyze"],
    actionKeys: ["story.analyze"],
    classify: async ({ revisionId, ai }, ctx) =>
      cls(
        textSpend(ai, "write"),
        "story.analyze",
        await projectOf(ctx, "story_revision", revisionId),
        `Analyse the story ${aiLabel(ai)}`,
      ),
    handler: async ({ revisionId, ai, batch }, ctx) => {
      const r = await ctx.invoke<{
        analysis: unknown;
        job: Record<string, unknown> & { id: string; projectId: string };
      }>("POST", `/api/story-revisions/${revisionId}/analyze`, { body: { ai: await restAi(ctx, ai), batch } });
      return {
        data: { analysis: r.analysis, job: jobView(r.job) },
        links: { job: links(ctx).job(r.job.projectId, r.job.id) },
      };
    },
  }),

  defineMcpTool({
    name: "get_story_analysis",
    title: "Get story analysis",
    description:
      "One story analysis with its full result (the proposed cast, world and chapters) once it has completed. Read-only.",
    input: z.object({ analysisId: Uuid }),
    output: z.object({ analysis: Passthrough }),
    scopes: ["story:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/story-analyses/:id"],
    actionKeys: [],
    handler: async ({ analysisId }, ctx) => ({ data: await ctx.invoke("GET", `/api/story-analyses/${analysisId}`) }),
  }),

  defineMcpTool({
    name: "edit_story_analysis",
    title: "Edit story analysis",
    description:
      "Replace a completed analysis's result before applying it (the whole StoryAnalysis object; see get_answer_schema StoryAnalysis). Validated exactly as a provider's answer is. Does not create anything yet; apply_story_analysis does.",
    input: z.object({
      analysisId: Uuid,
      result: z
        .record(z.string(), z.unknown())
        .describe("The complete StoryAnalysis object (get_answer_schema StoryAnalysis)."),
    }),
    output: z.object({ analysis: Passthrough }),
    scopes: ["story:write"],
    sensitivity: "write",
    idempotent: true,
    routes: ["PATCH /api/story-analyses/:id"],
    actionKeys: ["story_analysis.edit"],
    classify: async ({ analysisId }, ctx) =>
      cls(
        "write",
        "story_analysis.edit",
        await projectOf(ctx, "story_analysis", analysisId),
        "Edit the story analysis",
      ),
    handler: async ({ analysisId, result }, ctx) => ({
      data: await ctx.invoke("PATCH", `/api/story-analyses/${analysisId}`, { body: { result } }),
    }),
  }),

  defineMcpTool({
    name: "apply_story_analysis",
    title: "Apply story analysis",
    description:
      "Create the cast (characters with versions and outfits), locations, props and chapters proposed by a completed analysis. Creates many entities at once, so it is sensitive (may need the user's approval). Not asynchronous. Next: list_chapters, then run_chapter_plan per chapter.",
    input: z.object({ analysisId: Uuid, idempotencyKey: IdempotencyKey }),
    output: z.object({ created: Passthrough }),
    scopes: ["story:write", "library:write", "chapters:write"],
    sensitivity: "sensitive-write",
    idempotent: false,
    routes: ["POST /api/story-analyses/:id/apply"],
    actionKeys: ["story_analysis.apply"],
    classify: async ({ analysisId }, ctx) => {
      const projectId = await projectOf(ctx, "story_analysis", analysisId);
      const target = await stamp(ctx, storyAnalyses, analysisId, ["status", "result"]);
      const r = (target.result ?? {}) as { characters?: unknown[]; chapters?: unknown[]; locations?: unknown[] };
      return cls(
        "sensitive-write",
        "story_analysis.apply",
        projectId,
        `Apply the story analysis: create ${r.characters?.length ?? 0} characters, ${r.locations?.length ?? 0} locations and ${r.chapters?.length ?? 0} chapters`,
        { target },
      );
    },
    handler: async ({ analysisId }, ctx) => ({
      data: await ctx.invoke("POST", `/api/story-analyses/${analysisId}/apply`, { body: {} }),
    }),
  }),

  defineMcpTool({
    name: "run_story_rewrite",
    title: "Rewrite story",
    description:
      "Queue an AI rewrite of a revision following `instruction`; the result is a new revision (the original is kept). Asynchronous: returns a job; poll get_job. Manual mode (ai.manual=true) asks you for a StoryRewrite answer via get_manual_prompt / submit_manual_answer; a provider run spends credits (may need approval).",
    input: z.object({
      revisionId: Uuid,
      instruction: z.string().trim().min(3).max(4000),
      ai: AiInput,
      batch: z.boolean().optional(),
      idempotencyKey: IdempotencyKey,
    }),
    output: JobResult,
    scopes: ["story:write", "generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/story-revisions/:id/rewrite"],
    actionKeys: ["story.rewrite"],
    classify: async ({ revisionId, ai, instruction }, ctx) =>
      cls(
        textSpend(ai, "write"),
        "story.rewrite",
        await projectOf(ctx, "story_revision", revisionId),
        `Rewrite the story (${instruction.slice(0, 120)}) ${aiLabel(ai)}`,
      ),
    handler: async ({ revisionId, instruction, ai, batch }, ctx) => {
      const r = await ctx.invoke<{ job: Record<string, unknown> }>(
        "POST",
        `/api/story-revisions/${revisionId}/rewrite`,
        {
          body: { instruction, ai: await restAi(ctx, ai), batch },
        },
      );
      return { data: { ...r, job: jobView(r.job) } };
    },
  }),
];
