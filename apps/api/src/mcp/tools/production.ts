import { eq, productionRuns } from "@openmanga/db";
import { z } from "zod";
import { defineMcpTool, IdempotencyKey, Passthrough, type ToolContext } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { AiInput, cls, ImageAiInput, projectOf, restAi, Uuid } from "./common.ts";

/** The project a run belongs to, for classifying a call on it. */
async function runProject(ctx: ToolContext, id: string) {
  const [run] = await ctx.deps.db
    .select({ projectId: productionRuns.projectId, status: productionRuns.status })
    .from(productionRuns)
    .where(eq(productionRuns.id, id));
  if (!run) throw toolError(404, "not_found", "Production run not found");
  return run;
}

const RunOptions = {
  projectId: Uuid,
  reviewGates: z
    .boolean()
    .default(true)
    .describe("Pause for the user after the analysis, after the references and before the final render."),
  preparePrompts: z.boolean().default(true).describe("Prepare panel prompts with the text model before drawing."),
  render: z.boolean().default(true).describe("Render the video at the end."),
  youtube: z
    .boolean()
    .optional()
    .describe("Also write the YouTube text and export the package (default: film projects)."),
  ai: z.object({ text: AiInput, image: ImageAiInput }).optional().describe("The provider keys the run uses."),
  idempotencyKey: IdempotencyKey,
};
type StartArgs = {
  projectId: string;
  reviewGates: boolean;
  preparePrompts: boolean;
  render: boolean;
  youtube?: boolean;
  ai?: { text?: z.infer<typeof AiInput>; image?: z.infer<typeof ImageAiInput> };
};

const start = (update: boolean) => async (a: StartArgs, ctx: ToolContext) => {
  const r = await ctx.invoke<{ run: Record<string, unknown> }>("POST", `/api/projects/${a.projectId}/production-runs`, {
    body: {
      reviewGates: a.reviewGates,
      preparePrompts: a.preparePrompts,
      render: a.render,
      youtube: a.youtube,
      update,
      ai: { text: (await restAi(ctx, a.ai?.text)) ?? null, image: (await restAi(ctx, a.ai?.image)) ?? null },
    },
  });
  return { data: r };
};

export const productionTools = [
  defineMcpTool({
    name: "get_staleness",
    title: "What is out of date",
    description:
      "What is out of date in a project along story → plan → prompts → art → narration → audio → render, stage by stage: a count and a note each (a story revised after its analysis, chapters without a plan, pages without prepared prompts, panels without artwork or edited after it, chapters without narration, segments without current audio, a whole-project video older than what it is drawn from). Also stalePlans (chapters with pages whose text changed after they were planned) and staleNarration (chapters whose text or panels changed after their narration was written), with page, panel, drawn-panel and narration-line counts: these are never redone on their own; for each, keep it with keep_stale_chapter, or redo it with run_chapter_plan replace=true (replaces its pages and artwork) or run_narration_generation replace=true. Also publishing: the YouTube text and the thumbnail headline, flagged (stale, with reasons) when the title, the chapters or the rendered video changed after they were written; never regenerated on their own: the user regenerates them (Exports → YouTube package in the app; a new headline is settings.thumbnail.title via update_project) or they are kept with keep_publishing_text. update_production runs only the stale steps. Read-only.",
    input: z.object({ projectId: Uuid }),
    output: z
      .object({
        stages: z.array(Passthrough),
        stalePlans: z.array(Passthrough),
        staleNarration: z.array(Passthrough),
        publishing: z.array(Passthrough),
      })
      .passthrough(),
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/staleness"],
    actionKeys: [],
    handler: async ({ projectId }, ctx) => ({
      data: await ctx.invoke<{
        stages: Record<string, unknown>[];
        stalePlans: Record<string, unknown>[];
        staleNarration: Record<string, unknown>[];
        publishing: Record<string, unknown>[];
      }>("GET", `/api/projects/${projectId}/staleness`),
    }),
  }),

  defineMcpTool({
    name: "get_project_health",
    title: "Project health",
    description:
      "A project's health in one report: verdict.ready (ready to publish) or verdict.blocking (how many blocking issues), and items, each with a count, a severity (block: not ready while it stands; info: worth knowing) and the app page where it is fixed: export readiness (panels without artwork, chapters without or with patchy narration, segments without audio, superseded versions), a missing or out-of-date video, panels that failed a visual check, what is out of date (as get_staleness), the YouTube text and thumbnail headline, jobs still running and failed ones, open comment threads; plus spend against the budget and disk use. Read-only.",
    input: z.object({ projectId: Uuid }),
    output: z
      .object({ verdict: Passthrough, items: z.array(Passthrough), spend: Passthrough, disk: Passthrough })
      .passthrough(),
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/health"],
    actionKeys: [],
    handler: async ({ projectId }, ctx) => ({
      data: await ctx.invoke<{
        verdict: Record<string, unknown>;
        items: Record<string, unknown>[];
        spend: Record<string, unknown>;
        disk: Record<string, unknown>;
      }>("GET", `/api/projects/${projectId}/health`),
    }),
  }),

  defineMcpTool({
    name: "keep_publishing_text",
    title: "Keep the YouTube text or thumbnail headline",
    description:
      "Keep the YouTube text (item=youtube_text) or the thumbnail headline (item=thumbnail) as it is although get_staleness flags it as possibly out of date (the title, the chapters or the video changed after it was written): records what it is current for, so it is no longer flagged. Nothing is regenerated.",
    input: z.object({ projectId: Uuid, item: z.enum(["youtube_text", "thumbnail"]) }),
    output: Passthrough,
    scopes: ["projects:write"],
    sensitivity: "write",
    idempotent: true,
    routes: ["POST /api/projects/:projectId/keep-current"],
    actionKeys: ["project.keep_current"],
    classify: async ({ projectId, item }) =>
      cls(
        "write",
        "project.keep_current",
        projectId,
        `Keep the ${item === "youtube_text" ? "YouTube text" : "thumbnail headline"} as it is`,
      ),
    handler: async ({ projectId, item }, ctx) => ({
      data: await ctx.invoke<Record<string, unknown>>("POST", `/api/projects/${projectId}/keep-current`, {
        body: { item },
      }),
    }),
  }),

  defineMcpTool({
    name: "keep_stale_chapter",
    title: "Keep a chapter's plan or narration",
    description:
      "Keep a chapter's current plan (stage=plan) or narration (stage=narration) although what it was made from changed since (get_staleness lists them as stalePlans / staleNarration, and a production run waits at a review for them): it is then no longer out of date, and nothing is regenerated. The alternative is redoing it: run_chapter_plan with replace=true (replaces the chapter's pages and artwork) or run_narration_generation with replace=true. Continue the waiting run with continue_production_run when every chapter is decided.",
    input: z.object({ chapterId: Uuid, stage: z.enum(["plan", "narration"]) }),
    output: Passthrough,
    scopes: ["chapters:write"],
    sensitivity: "write",
    idempotent: true,
    routes: ["POST /api/chapters/:id/keep"],
    actionKeys: ["chapter.keep"],
    classify: async ({ chapterId, stage }, ctx) =>
      cls(
        "write",
        "chapter.keep",
        await projectOf(ctx, "chapter", chapterId),
        `Keep the chapter's current ${stage === "plan" ? "plan" : "narration"} as up to date`,
      ),
    handler: async ({ chapterId, stage }, ctx) => ({
      data: await ctx.invoke<Record<string, unknown>>("POST", `/api/chapters/${chapterId}/keep`, { body: { stage } }),
    }),
  }),

  defineMcpTool({
    name: "start_production_run",
    title: "Start a production run",
    description:
      "Run the whole pipeline for a project (analysis, references, chapter plans, prompts, artwork, narration, audio, thumbnail, the video and its YouTube package), reusing whatever exists and pausing at review steps. Spends the user's provider credits, up to the project's budget cap, unattended between reviews: always a spend action (may need approval). Needs a budget cap on the project; one run at a time per project. Follow it with get_production_run, and continue_production_run at each review.",
    input: z.object(RunOptions),
    output: z.object({ run: Passthrough }).passthrough(),
    scopes: ["generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/production-runs"],
    actionKeys: ["production.run"],
    classify: async ({ projectId, render }) =>
      cls(
        "spend",
        "production.run",
        projectId,
        `Produce the project end to end${render ? ", including the video render" : ""}, spending up to its budget cap`,
      ),
    handler: start(false),
  }),

  defineMcpTool({
    name: "update_production",
    title: "Update production",
    description:
      "Run only what is out of date (see get_staleness), from the first stale stage on: a revised story is analysed again and the run then waits for the user to review the changes (get_story_analysis diff=true shows them; continue_production_run applies them keeping all existing work); chapters whose text changed after they were planned (or after their narration was written) are never redone on their own: the run waits at a review listing them (get_staleness stalePlans / staleNarration) until each is kept (keep_stale_chapter) or redone (run_chapter_plan / run_narration_generation with replace=true) and the run is continued; then missing plans, prompts and artwork, artwork whose panel was edited after it was drawn, narration, audio and the video, which re-encodes only the shots that changed. Spends the user's provider credits up to the project's budget cap: always a spend action (may need approval). Refused with 409 when nothing is out of date or a run is already going.",
    input: z.object(RunOptions),
    output: z.object({ run: Passthrough }).passthrough(),
    scopes: ["generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/production-runs (update=true)"],
    actionKeys: ["production.update"],
    classify: async ({ projectId }) =>
      cls("spend", "production.update", projectId, "Update the out-of-date steps, spending up to the budget cap"),
    handler: start(true),
  }),

  defineMcpTool({
    name: "get_production_run",
    title: "Production runs",
    description:
      "A project's recent production runs (newest first), or one run by runId: its status (running, waiting at a review, paused at the budget cap, completed, completed_with_warnings, failed, cancelled), the reason, every step with its status and note, warnings when it finished with unresolved items (failedJobs the run queued and nobody retried — retry them with control_job —, failedExports, and the project's panelsWithoutArt, segmentsWithoutAudio and panelsNeedingReview), and pendingJobs (how many queued jobs stopping it would cancel). Read-only.",
    input: z.object({ projectId: Uuid.optional(), runId: Uuid.optional() }),
    output: Passthrough,
    scopes: ["generations:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/production-runs/:id", "GET /api/projects/:projectId/production-runs"],
    actionKeys: [],
    handler: async ({ projectId, runId }, ctx) => {
      if (runId) return { data: await ctx.invoke<Record<string, unknown>>("GET", `/api/production-runs/${runId}`) };
      if (!projectId) throw toolError(400, "invalid_input", "Give a projectId or a runId");
      return {
        data: await ctx.invoke<Record<string, unknown>>("GET", `/api/projects/${projectId}/production-runs`),
      };
    },
  }),

  defineMcpTool({
    name: "continue_production_run",
    title: "Continue a production run",
    description:
      "Continue a run: past the review step it is waiting at (only after the user has reviewed what it asks for), after the budget cap was raised, or to retry the step that failed. The run then spends the user's provider credits again: always a spend action (may need approval).",
    input: z.object({ runId: Uuid, idempotencyKey: IdempotencyKey }),
    output: Passthrough,
    scopes: ["generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/production-runs/:id/continue"],
    actionKeys: ["production.continue"],
    classify: async ({ runId }, ctx) => {
      const run = await runProject(ctx, runId);
      return cls(
        "spend",
        "production.continue",
        run.projectId,
        run.status === "waiting" ? "Continue the production run past its review step" : "Resume the production run",
        { target: { runId, status: run.status } },
      );
    },
    handler: async ({ runId }, ctx) => ({
      data: await ctx.invoke<Record<string, unknown>>("POST", `/api/production-runs/${runId}/continue`),
    }),
  }),

  defineMcpTool({
    name: "cancel_production_run",
    title: "Stop a production run",
    description:
      "Stop a production run. By default it also cancels what the run queued that has not started (generation jobs that are queued, in a provider batch, paused or waiting for an answer; queued narration audio; its export); get_production_run's pendingJobs says how many. Jobs already running at a provider finish, and the stopped run acts on nothing they return. jobs=false stops the run only and leaves its queued jobs to finish. Nothing made so far is removed.",
    input: z.object({
      runId: Uuid,
      jobs: z
        .boolean()
        .default(true)
        .describe("Also cancel the run's queued jobs (default). false stops the orchestration only."),
    }),
    output: Passthrough,
    scopes: ["generations:run"],
    sensitivity: "write",
    idempotent: true,
    routes: ["POST /api/production-runs/:id/cancel"],
    actionKeys: ["production.cancel"],
    classify: async ({ runId, jobs }, ctx) =>
      cls(
        "write",
        "production.cancel",
        (await runProject(ctx, runId)).projectId,
        jobs ? "Stop the production run and cancel its queued jobs" : "Stop the production run",
      ),
    handler: async ({ runId, jobs }, ctx) => ({
      data: await ctx.invoke<Record<string, unknown>>("POST", `/api/production-runs/${runId}/cancel`, {
        body: { jobs },
      }),
    }),
  }),
];
