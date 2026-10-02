import { eq, productionRuns } from "@openmanga/db";
import { z } from "zod";
import { defineMcpTool, IdempotencyKey, Passthrough, type ToolContext } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { AiInput, cls, ImageAiInput, restAi, Uuid } from "./common.ts";

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
      "What is out of date in a project along story → plan → prompts → art → narration → audio → render, stage by stage: a count and a note each (a story revised after its analysis, chapters without a plan, pages without prepared prompts, panels without artwork or edited after it, chapters without narration, segments without current audio, a whole-project video older than what it is drawn from). update_production runs only these steps. Read-only.",
    input: z.object({ projectId: Uuid }),
    output: z.object({ stages: z.array(Passthrough) }).passthrough(),
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/staleness"],
    actionKeys: [],
    handler: async ({ projectId }, ctx) => ({
      data: await ctx.invoke<{ stages: Record<string, unknown>[] }>("GET", `/api/projects/${projectId}/staleness`),
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
      "Run only what is out of date (see get_staleness), from the first stale stage on: missing plans, prompts and artwork, artwork whose panel was edited after it was drawn, narration, audio and the video, which re-encodes only the shots that changed. Spends the user's provider credits up to the project's budget cap: always a spend action (may need approval). Refused with 409 when nothing is out of date or a run is already going.",
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
      "A project's recent production runs (newest first), or one run by runId: its status (running, waiting at a review, paused at the budget cap, completed, failed, cancelled), the reason, and every step with its status and note. Read-only.",
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
      "Stop a production run. Jobs it already queued finish on their own (cancel them with control_job if needed); nothing made so far is removed.",
    input: z.object({ runId: Uuid }),
    output: Passthrough,
    scopes: ["generations:run"],
    sensitivity: "write",
    idempotent: true,
    routes: ["POST /api/production-runs/:id/cancel"],
    actionKeys: ["production.cancel"],
    classify: async ({ runId }, ctx) =>
      cls("write", "production.cancel", (await runProject(ctx, runId)).projectId, "Stop the production run"),
    handler: async ({ runId }, ctx) => ({
      data: await ctx.invoke<Record<string, unknown>>("POST", `/api/production-runs/${runId}/cancel`),
    }),
  }),
];
