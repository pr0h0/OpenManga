import { and, audioJobs, eq, exportJobs, generationJobs } from "@openmanga/db";
import { z } from "zod";
import { CoverInput } from "../../routes/generations.ts";
import { defineMcpTool, IdempotencyKey, Passthrough, type ToolContext } from "../registry.ts";
import { argsHash, toolError } from "../runtime.ts";
import { cls, ImageAiInput, jobView, links, projectOf, restAi, Uuid } from "./common.ts";

const MAX_IMAGES = 4;

const BulkScope = z
  .object({
    pageId: Uuid.optional(),
    sceneId: Uuid.optional(),
    chapterId: Uuid.optional(),
    panelIds: z.array(Uuid).max(500).optional(),
    references: z
      .enum(["location", "prop"])
      .optional()
      .describe("One reference image for every location or every prop"),
  })
  .describe("Exactly one of pageId, sceneId, chapterId, panelIds, references.");

const BulkArgs = {
  projectId: Uuid,
  scope: BulkScope,
  onlyMissing: z.boolean().default(true).describe("Skip panels that already have artwork (default true)."),
  batch: z.boolean().default(false).describe("Provider batch API: half price, results within 24h."),
  ai: ImageAiInput,
};

type Estimate = {
  count: number;
  estimatedUsd: number | null;
  provider: { provider: string; model: string };
  batch: boolean;
  budget?: unknown;
};

/** The facts a spend decision was made on; the token is their hash, so a run can prove it saw the same numbers. */
const estimateToken = (projectId: string, scope: unknown, e: Estimate) =>
  argsHash({ projectId, scope, count: e.count, usd: e.estimatedUsd, provider: e.provider, batch: e.batch }).slice(
    0,
    32,
  );

async function estimate(
  ctx: ToolContext,
  a: { projectId: string; scope: unknown; onlyMissing: boolean; batch: boolean; ai?: unknown },
) {
  const e = await ctx.invoke<Estimate & Record<string, unknown>>(
    "POST",
    `/api/projects/${a.projectId}/generations/bulk`,
    {
      body: {
        scope: a.scope,
        onlyMissing: a.onlyMissing,
        batch: a.batch,
        ai: await restAi(ctx, a.ai as never),
        confirm: false,
      },
    },
  );
  return { ...e, estimateToken: estimateToken(a.projectId, a.scope, e) };
}

/** The project a job, audio job or export belongs to, and which kind of job it is. */
async function jobKind(ctx: ToolContext, id: string) {
  const db = ctx.deps.db;
  const [g] = await db
    .select({
      p: generationJobs.projectId,
      manual: generationJobs.parameters,
      status: generationJobs.status,
      kind: generationJobs.kind,
    })
    .from(generationJobs)
    .where(eq(generationJobs.id, id));
  if (g)
    return {
      type: "generation" as const,
      projectId: g.p,
      manual: g.manual.manual === true,
      status: g.status,
      kind: g.kind,
    };
  const [a] = await db
    .select({ p: audioJobs.projectId, status: audioJobs.status })
    .from(audioJobs)
    .where(eq(audioJobs.id, id));
  if (a) return { type: "audio" as const, projectId: a.p, manual: false, status: a.status, kind: "tts" };
  const [x] = await db
    .select({ p: exportJobs.projectId, status: exportJobs.status, kind: exportJobs.kind })
    .from(exportJobs)
    .where(eq(exportJobs.id, id));
  if (x) return { type: "export" as const, projectId: x.p, manual: false, status: x.status, kind: x.kind };
  throw toolError(404, "not_found", "Job not found");
}

async function batchProject(ctx: ToolContext, batchId: string) {
  const [j] = await ctx.deps.db
    .select({ p: generationJobs.projectId })
    .from(generationJobs)
    .where(eq(generationJobs.batchId, batchId))
    .limit(1);
  if (!j) throw toolError(404, "not_found", "Batch not found");
  return j.p;
}

export const generationTools = [
  defineMcpTool({
    name: "list_jobs",
    title: "List jobs",
    description:
      "A project's AI generation jobs, newest first, with status counts. Filter by status (comma-separated: queued, awaiting_input, processing, completed, failed, cancelled), kind, targetId or batchId. Paginate with `cursor` (nextCursor from the previous page). Prompts are not included (get_manual_prompt / get_job detail). Read-only.",
    input: z.object({
      projectId: Uuid,
      status: z.string().max(100).optional(),
      kind: z.string().max(100).optional(),
      targetId: Uuid.optional(),
      batchId: Uuid.optional(),
      limit: z.number().int().min(1).max(100).default(25),
      cursor: z.string().max(100).optional(),
    }),
    output: z.object({ jobs: z.array(Passthrough), counts: Passthrough, nextCursor: z.string().nullable() }),
    scopes: ["generations:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/generations"],
    actionKeys: [],
    handler: async ({ projectId, ...q }, ctx) => {
      const r = await ctx.invoke<{ jobs: Record<string, unknown>[]; counts: unknown; nextCursor: string | null }>(
        "GET",
        `/api/projects/${projectId}/generations`,
        { query: q },
      );
      return { data: { ...r, jobs: r.jobs.map(jobView) }, links: { queue: links(ctx).jobs(projectId) } };
    },
  }),

  defineMcpTool({
    name: "get_job",
    title: "Get job",
    description:
      "Poll any job by id: generation (text or image), narration audio, or export/import. status: queued/submitted/processing = still running (poll again after a few seconds, not in a tight loop); awaiting_input = a manual job waiting for your answer (get_manual_prompt); completed/failed/cancelled = final. Completed exports include their files. detail=true adds a generation's inputs, outputs, usage and cost. Read-only.",
    input: z.object({ jobId: Uuid, detail: z.boolean().default(false) }),
    output: z.object({ type: z.string(), job: Passthrough }).passthrough(),
    scopes: ["generations:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/jobs/:id", "GET /api/generations/:id"],
    actionKeys: [],
    handler: async ({ jobId, detail }, ctx) => {
      const r = await ctx.invoke<{ type: string; job: Record<string, unknown> & { projectId: string } }>(
        "GET",
        `/api/jobs/${jobId}`,
      );
      const extra =
        detail && r.type === "generation"
          ? await ctx
              .invoke<Record<string, unknown>>("GET", `/api/generations/${jobId}`)
              .then(({ job: _j, ...rest }) => rest)
          : {};
      return {
        data: { type: r.type, job: jobView(r.job), ...extra },
        links: {
          job: r.type === "export" ? links(ctx).exports(r.job.projectId) : links(ctx).job(r.job.projectId, jobId),
        },
      };
    },
  }),

  defineMcpTool({
    name: "get_manual_prompt",
    title: "Get manual prompt",
    description:
      "For a manual (paste-mode) job that is awaiting_input: the exact compiled prompt a provider would have been sent, the answer format for this question (a commented interface with every field), a valid example answer, how many answers were given so far, the last validation error if the previous answer was rejected, and the images the question is about (as image content). Write your answer as ONE JSON object matching the format and send it with submit_manual_answer. Read-only.",
    input: z.object({ jobId: Uuid, includeImages: z.boolean().default(true) }),
    output: Passthrough,
    scopes: ["generations:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/generations/:id/manual"],
    actionKeys: [],
    handler: async ({ jobId, includeImages }, ctx) => {
      const m = await ctx.invoke<Record<string, unknown> & { attachments: string[] }>(
        "GET",
        `/api/generations/${jobId}/manual`,
      );
      const projectId = await projectOf(ctx, "generation", jobId);
      const content: { type: "image"; data: string; mimeType: string }[] = [];
      if (includeImages)
        for (const id of m.attachments.slice(0, MAX_IMAGES)) {
          const asset = await ctx.deps.assets.get(id);
          // Only the job's own project's images, and a preview-size copy: enough to judge, small to send.
          if (!asset || asset.projectId !== projectId) continue;
          const v = await ctx.deps.assets.ensureResized(asset, "preview");
          if (!v) continue;
          content.push({
            type: "image",
            data: Buffer.from(await ctx.deps.assets.readVariant(v)).toString("base64"),
            mimeType: v.mimeType,
          });
        }
      return {
        data: {
          ...m,
          imagesIncluded: content.length,
          next: m.awaitingAnswer
            ? "Answer with submit_manual_answer (one JSON object matching `format`)."
            : "This job is not waiting for an answer; check get_job.",
        },
        content,
      };
    },
  }),

  defineMcpTool({
    name: "submit_manual_answer",
    title: "Submit manual answer",
    description:
      "Answer the question a manual (paste-mode) job is waiting for. OpenManga validates it exactly as a provider's reply (schema and the job's own checks) and applies it. Asynchronous: the job is requeued; poll get_job. It then completes, asks the next question (awaiting_input again — a chapter plan asks one per scene), or goes back to awaiting_input with lastError when the answer was rejected: fix only what the error names and resubmit. No provider is used and nothing is spent.",
    input: z.object({
      jobId: Uuid,
      answer: z
        .union([z.string().min(1).max(2_000_000), z.record(z.string(), z.unknown())])
        .describe("The answer JSON, as an object or as its text."),
    }),
    output: z.object({ accepted: z.boolean(), jobId: z.string() }),
    scopes: ["generations:run"],
    sensitivity: "write",
    idempotent: false,
    routes: ["POST /api/generations/:id/manual"],
    actionKeys: ["generation.manual_answer"],
    classify: async ({ jobId }, ctx) =>
      cls("write", "generation.manual_answer", await projectOf(ctx, "generation", jobId), "Answer a manual job"),
    handler: async ({ jobId, answer }, ctx) => ({
      data: await ctx.invoke("POST", `/api/generations/${jobId}/manual`, {
        body: { text: typeof answer === "string" ? answer : JSON.stringify(answer) },
      }),
    }),
  }),

  defineMcpTool({
    name: "control_job",
    title: "Cancel or retry job",
    description:
      "cancel: stop a queued job (a running one is asked to stop). Works for generation, narration audio and export jobs. retry: run a failed or cancelled generation again as a NEW job (follow the returned job); retrying a provider job spends credits again (may need approval), retrying a manual job does not.",
    input: z.object({ jobId: Uuid, action: z.enum(["cancel", "retry"]), idempotencyKey: IdempotencyKey }),
    output: Passthrough,
    scopes: ["generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: [
      "POST /api/generations/:id/cancel",
      "POST /api/generations/:id/retry",
      "POST /api/audio-jobs/:id/cancel",
      "POST /api/exports/:id/cancel",
    ],
    actionKeys: ["job.cancel", "generation.retry"],
    classify: async ({ jobId, action }, ctx) => {
      const j = await jobKind(ctx, jobId);
      if (action === "retry")
        return cls(
          j.manual ? "write" : "spend",
          "generation.retry",
          j.projectId,
          `Retry the ${j.kind} job${j.manual ? " (manual)" : "; spends provider credits"}`,
          {
            target: { status: j.status },
          },
        );
      return cls("write", "job.cancel", j.projectId, `Cancel the ${j.kind} job`);
    },
    handler: async ({ jobId, action }, ctx) => {
      const j = await jobKind(ctx, jobId);
      if (action === "retry") {
        if (j.type !== "generation") throw toolError(409, "conflict", "Only generation jobs can be retried here.");
        const r = await ctx.invoke<{ job: Record<string, unknown> }>("POST", `/api/generations/${jobId}/retry`);
        return { data: { job: jobView(r.job) } };
      }
      const path =
        j.type === "generation"
          ? `/api/generations/${jobId}/cancel`
          : j.type === "audio"
            ? `/api/audio-jobs/${jobId}/cancel`
            : `/api/exports/${jobId}/cancel`;
      return { data: await ctx.invoke("POST", path) };
    },
  }),

  defineMcpTool({
    name: "estimate_bulk_generation",
    title: "Estimate bulk image generation",
    description:
      "Count and price image generation for a page, scene, chapter, list of panels, or every location/prop reference, WITHOUT starting anything: how many would run, how many are skipped and why, estimated USD, the provider/model, the project budget, a preflight report and credential readiness. Returns an estimateToken: pass it to run_bulk_generation to start exactly this. Read-only.",
    input: z.object(BulkArgs),
    output: z
      .object({ count: z.number(), estimatedUsd: z.number().nullable(), estimateToken: z.string() })
      .passthrough(),
    scopes: ["generations:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["POST /api/projects/:projectId/generations/bulk (confirm=false)"],
    actionKeys: [],
    handler: async (a, ctx) => ({ data: await estimate(ctx, a) }),
  }),

  defineMcpTool({
    name: "run_bulk_generation",
    title: "Run bulk image generation",
    description:
      "Start the image generation you estimated with estimate_bulk_generation (same arguments plus its estimateToken). Spends the user's image-provider credits: always a spend action (may need approval). Re-estimates first; if the count, price, provider or model changed it refuses with estimate_changed and the new estimate, so nothing more is spent than was shown. Respects the project budget (402 budget_exceeded); allowOverBudget only when the user explicitly chose to exceed it. Asynchronous: returns a batchId and jobs; follow with manage_batch status or list_jobs.",
    input: z.object({
      ...BulkArgs,
      estimateToken: z.string().min(8).max(64),
      allowOverBudget: z
        .boolean()
        .default(false)
        .describe("Only when the user explicitly chose to go over the project budget."),
      idempotencyKey: IdempotencyKey,
    }),
    output: z.object({ batchId: z.string().nullable(), jobs: z.array(Passthrough) }).passthrough(),
    scopes: ["generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/generations/bulk (confirm=true)"],
    actionKeys: ["generation.bulk", "generation.bulk_over_budget"],
    classify: async (a, ctx) => {
      const e = await estimate(ctx, a);
      if (e.estimateToken !== a.estimateToken)
        throw toolError(
          409,
          "estimate_changed",
          "The estimate changed since you read it. Review the new estimate and run again with its token.",
          e,
        );
      return cls(
        "spend",
        a.allowOverBudget ? "generation.bulk_over_budget" : "generation.bulk",
        a.projectId,
        `Generate ${e.count} image${e.count === 1 ? "" : "s"} with ${e.provider.provider}/${e.provider.model}${e.batch ? " (batch, half price)" : ""}${e.estimatedUsd != null ? `, about $${e.estimatedUsd.toFixed(2)}` : ""}${a.allowOverBudget ? ", ALLOWED TO EXCEED THE PROJECT BUDGET" : ""}`,
        {
          target: { estimateToken: e.estimateToken },
          estimate: { estimatedUsd: e.estimatedUsd, count: e.count, provider: e.provider },
        },
      );
    },
    // classify has just re-estimated and compared the token (and does again before an approved run), so the
    // numbers the user saw are the numbers that run.
    handler: async (a, ctx) => {
      const r = await ctx.invoke<Record<string, unknown>>("POST", `/api/projects/${a.projectId}/generations/bulk`, {
        body: {
          scope: a.scope,
          onlyMissing: a.onlyMissing,
          batch: a.batch,
          ai: await restAi(ctx, a.ai),
          confirm: true,
        },
        headers: a.allowOverBudget ? { "x-allow-over-budget": "1" } : undefined,
      });
      return { data: r, links: { queue: links(ctx).jobs(a.projectId) } };
    },
  }),

  defineMcpTool({
    name: "manage_batch",
    title: "Bulk batches",
    description:
      "list: a project's active and recent bulk batches (needs projectId). status: one batch's progress. pause: not-yet-started jobs stop, running ones finish. resume: continue a paused batch (resumes spending; may need approval). poll: ask the worker to check provider batches now. cancel: cancel all not-yet-started jobs of the batch (sensitive when many would be lost).",
    input: z.object({
      action: z.enum(["list", "status", "pause", "resume", "poll", "cancel"]),
      projectId: Uuid.optional(),
      batchId: Uuid.optional(),
    }),
    output: Passthrough,
    scopes: ["generations:read", "generations:run"],
    scopesFor: (a) => (a.action === "list" || a.action === "status" ? ["generations:read"] : ["generations:run"]),
    sensitivity: "spend",
    idempotent: false,
    routes: [
      "GET /api/projects/:projectId/generations/batches",
      "GET /api/generations/batches/:batchId",
      "POST /api/generations/batches/:batchId/pause",
      "POST /api/generations/batches/:batchId/resume",
      "POST /api/generations/batches/:batchId/poll",
      "POST /api/generations/batches/:batchId/cancel",
    ],
    actionKeys: ["batch.pause", "batch.resume", "batch.poll", "batch.cancel"],
    classify: async ({ action, projectId, batchId }, ctx) => {
      if (action === "list") {
        if (!projectId) throw toolError(400, "bad_request", "projectId is required for list");
        return cls("read", "batch.list", projectId, "List batches");
      }
      if (!batchId) throw toolError(400, "bad_request", "batchId is required");
      const p = await batchProject(ctx, batchId);
      if (action === "status") return cls("read", "batch.status", p, "Batch status");
      if (action === "resume")
        return cls("spend", "batch.resume", p, "Resume a paused bulk batch; spends provider credits");
      if (action === "cancel") {
        const pending = await ctx.deps.db
          .select({ id: generationJobs.id })
          .from(generationJobs)
          .where(and(eq(generationJobs.batchId, batchId), eq(generationJobs.status, "queued")));
        const big = pending.length > ctx.deps.config.MCP_BULK_APPROVAL_THRESHOLD;
        return cls(
          big ? "sensitive-write" : "write",
          "batch.cancel",
          p,
          `Cancel ${pending.length} not-yet-started jobs of a batch`,
          {
            target: big ? { queued: pending.length } : undefined,
          },
        );
      }
      return cls("write", `batch.${action}`, p, `${action} a bulk batch`);
    },
    handler: async ({ action, projectId, batchId }, ctx) => {
      if (action === "list") return { data: await ctx.invoke("GET", `/api/projects/${projectId}/generations/batches`) };
      if (action === "status") return { data: await ctx.invoke("GET", `/api/generations/batches/${batchId}`) };
      return { data: await ctx.invoke("POST", `/api/generations/batches/${batchId}/${action}`) };
    },
  }),

  defineMcpTool({
    name: "generate_cover",
    title: "Generate cover",
    description:
      "Queue cover artwork for a project (the title is composited by the app, not drawn by the model). Spends image-provider credits (may need approval). Asynchronous: returns a job; poll get_job.",
    input: CoverInput.omit({ ai: true }).extend({ projectId: Uuid, ai: ImageAiInput, idempotencyKey: IdempotencyKey }),
    output: z.object({ job: Passthrough }).passthrough(),
    scopes: ["generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/cover"],
    actionKeys: ["project.cover"],
    classify: async ({ projectId }) =>
      cls("spend", "project.cover", projectId, "Generate cover artwork; spends image-provider credits"),
    handler: async ({ projectId, ai, idempotencyKey: _k, ...body }, ctx) => {
      const r = await ctx.invoke<{ job: Record<string, unknown> }>("POST", `/api/projects/${projectId}/cover`, {
        body: { ...body, ai: await restAi(ctx, ai) },
      });
      return { data: { ...r, job: jobView(r.job) } };
    },
  }),
];
