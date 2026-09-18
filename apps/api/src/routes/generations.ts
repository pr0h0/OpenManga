import {
  aiUsage,
  and,
  assetVariants,
  desc,
  eq,
  generationInputs,
  generationJobs,
  generationOutputs,
  inArray,
  panels,
  sql,
} from "@openmanga/db";
import {
  BATCH_CAPABLE_PROVIDERS,
  batchModel,
  estimateImageBatchUsd,
  PRIORITY,
  providerSupports,
} from "@openmanga/domain";
import { generationPreflight, projectBudget, recordAudit } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { AiChoiceInput, assertBudget, checkImageChoice } from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

export const generationRoutes = new Hono<AppEnv>();

/** Matches the `panelIds` array cap, so every bulk scope is bounded the same way. */
const MAX_BULK_PANELS = 500;

const ListQuery = z.object({
  status: z.string().optional(),
  kind: z.string().optional(),
  targetId: z.string().uuid().optional(),
  batchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime().optional(),
  /** `nextCursor` from a previous page: "<createdAt ISO>|<job id>". Keyed on the pair because a bulk enqueue
   *  gives hundreds of jobs the same createdAt, which a timestamp-only cursor would skip past. */
  cursor: z
    .string()
    .regex(/^[^|]+\|[0-9a-f-]{36}$/)
    .optional(),
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/generations",
  summary: "Generation queue and history",
  tag: "generations",
  query: ListQuery,
});
generationRoutes.get("/projects/:projectId/generations", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, ListQuery);
  const { db } = c.get("deps");
  const [at, id] = q.cursor?.split("|") ?? [];
  const cursor = at && id ? { at, id } : null;
  const where = and(
    eq(generationJobs.projectId, p.id),
    q.status ? inArray(generationJobs.status, q.status.split(",") as ("queued" | "failed")[]) : undefined,
    q.kind ? inArray(generationJobs.kind, q.kind.split(",") as "cover"[]) : undefined,
    q.targetId ? eq(generationJobs.targetId, q.targetId) : undefined,
    q.batchId ? eq(generationJobs.batchId, q.batchId) : undefined,
    q.before ? sql`${generationJobs.createdAt} < ${q.before}` : undefined,
    cursor ? sql`(${generationJobs.createdAt}, ${generationJobs.id}) < (${cursor.at}, ${cursor.id}::uuid)` : undefined,
  );
  const jobs = await db
    .select({
      job: generationJobs,
      costUsd: sql<number>`(select coalesce(sum(estimated_cost_usd),0)::float from ai_usage where generation_job_id = "generation_jobs"."id")`,
      outputAssetId: sql<
        string | null
      >`(select asset_id from generation_outputs where job_id = "generation_jobs"."id" order by created_at desc limit 1)`,
    })
    .from(generationJobs)
    .where(where)
    .orderBy(desc(generationJobs.createdAt), desc(generationJobs.id))
    .limit(q.limit);
  const last = jobs.at(-1);
  const [counts] = await db.execute<Record<string, number>>(sql`select
    count(*) filter (where status = 'queued')::int as queued,
    count(*) filter (where status = 'processing')::int as processing,
    count(*) filter (where status = 'completed')::int as completed,
    count(*) filter (where status = 'failed')::int as failed,
    count(*) filter (where status in ('cancelled','cancel_requested'))::int as cancelled
    from generation_jobs where project_id = ${p.id}`);
  return c.json({
    jobs: jobs.map((j) => ({
      ...j.job,
      compiledPrompt: undefined,
      input: undefined,
      costUsd: j.costUsd,
      outputAssetId: j.outputAssetId,
    })),
    counts,
    /** Pass back as ?cursor= for the next page. Null on the last page. */
    nextCursor: jobs.length === q.limit && last ? `${last.job.createdAt.toISOString()}|${last.job.id}` : null,
  });
});

async function jobWithAccess(c: Context<AppEnv>, id: string, action: "read" | "generate") {
  const [job] = await c.get("deps").db.select().from(generationJobs).where(eq(generationJobs.id, id));
  if (!job) throw notFound("Job");
  await projectAccess(c, job.projectId, action);
  return job;
}

doc({
  method: "GET",
  path: "/api/generations/:id",
  summary: "Prompt & reference inspector for a generation",
  tag: "generations",
});
generationRoutes.get("/generations/:id", async (c) => {
  const job = await jobWithAccess(c, uuidParam(c, "id"), "read");
  const { db } = c.get("deps");
  const inputs = await db
    .select()
    .from(generationInputs)
    .where(eq(generationInputs.jobId, job.id))
    .orderBy(generationInputs.order);
  const variantIds = inputs.map((i) => i.variantId).filter((x): x is string => Boolean(x));
  const variants = variantIds.length
    ? await db.select().from(assetVariants).where(inArray(assetVariants.id, variantIds))
    : [];
  const outputs = await db.select().from(generationOutputs).where(eq(generationOutputs.jobId, job.id));
  const usage = await db.select().from(aiUsage).where(eq(aiUsage.generationJobId, job.id)).orderBy(aiUsage.createdAt);
  const retries = await db
    .select({ id: generationJobs.id, status: generationJobs.status, createdAt: generationJobs.createdAt })
    .from(generationJobs)
    .where(sql`${generationJobs.parameters}->>'retryOf' = ${job.id}`);
  return c.json({
    job,
    inputs: inputs.map((i) => ({
      ...i,
      variant: variants.find((v) => v.id === i.variantId) ?? null,
      sentAs: i.variantId ? "prompt_ref_derivative" : "full_resolution",
    })),
    outputs,
    usage,
    retries,
    totals: {
      costUsd: usage.reduce((s, u) => s + Number(u.estimatedCostUsd), 0),
      textInputTokens: usage.reduce((s, u) => s + u.textInputTokens, 0),
      textOutputTokens: usage.reduce((s, u) => s + u.textOutputTokens, 0),
      imageInputTokens: usage.reduce((s, u) => s + u.imageInputTokens, 0),
      imageOutputTokens: usage.reduce((s, u) => s + u.imageOutputTokens, 0),
    },
  });
});

doc({
  method: "POST",
  path: "/api/generations/:id/cancel",
  summary: "Cancel a queued job, or request cancellation of a running one",
  tag: "generations",
});
generationRoutes.post("/generations/:id/cancel", async (c) => {
  const job = await jobWithAccess(c, uuidParam(c, "id"), "generate");
  const deps = c.get("deps");
  const result = await deps.jobs.cancelGeneration(job.id);
  if (result === "not_cancellable") throw conflict(`Job is already ${job.status}`);
  if (result === "cancelled" && job.targetType === "panel" && job.targetId) {
    const [pn] = await deps.db.select().from(panels).where(eq(panels.id, job.targetId));
    if (pn && (pn.status === "queued" || pn.status === "generating"))
      await deps.db
        .update(panels)
        .set({ status: pn.activeArtworkAssetId ? "ready" : "planned" })
        .where(eq(panels.id, pn.id));
  }
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: job.projectId,
    action: `generation.${result}`,
    targetType: "generation_job",
    targetId: job.id,
    requestId: c.get("requestId"),
  });
  return c.json({ result });
});

doc({
  method: "POST",
  path: "/api/generations/:id/retry",
  summary: "Retry a failed/cancelled job as a new job",
  tag: "generations",
});
generationRoutes.post("/generations/:id/retry", async (c) => {
  const job = await jobWithAccess(c, uuidParam(c, "id"), "generate");
  const deps = c.get("deps");
  // A retry is a fresh paid call, so it goes through the same budget gate as the route that queued the original.
  await assertBudget(c, job.projectId);
  const created = await deps.jobs.retryGeneration(job.id, user(c).id);
  if (!created)
    throw conflict(
      job.retriedByJobId
        ? "This job was already retried; follow the replacement job instead."
        : "Only failed or cancelled jobs can be retried",
    );
  if (created.targetType === "panel" && created.targetId)
    await deps.db.update(panels).set({ status: "queued" }).where(eq(panels.id, created.targetId));
  return c.json({ job: created }, 202);
});

const Scope = z.object({
  pageId: z.string().uuid().optional(),
  sceneId: z.string().uuid().optional(),
  chapterId: z.string().uuid().optional(),
  panelIds: z.array(z.string().uuid()).max(500).optional(),
});
const BulkInput = z.object({
  scope: Scope,
  onlyMissing: z.boolean().default(true),
  confirm: z.boolean().default(false),
  /**
   * Send the panels to the provider's batch API instead of generating them now: half price, and the results
   * arrive within 24h (often much sooner). Refused for a provider without a batch API.
   */
  batch: z.boolean().default(false),
  ai: AiChoiceInput,
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/generations/bulk",
  summary: "Bulk generate selected/page/scene/chapter. Without confirm=true returns count + estimate only.",
  tag: "generations",
  body: BulkInput,
});
generationRoutes.post("/projects/:projectId/generations/bulk", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  const input = await body(c, BulkInput);
  const deps = c.get("deps");
  const { scope } = input;
  const scopeKinds = [scope.pageId, scope.sceneId, scope.chapterId, scope.panelIds].filter(Boolean).length;
  if (scopeKinds !== 1) throw badRequest("Provide exactly one of pageId, sceneId, chapterId, panelIds");
  if (scope.pageId) await entityAccess(c, "page", scope.pageId, "generate");
  if (scope.sceneId) await entityAccess(c, "scene", scope.sceneId, "generate");
  if (scope.chapterId) await entityAccess(c, "chapter", scope.chapterId, "generate");
  let ids = await deps.planner.panelIdsFor(scope);
  // `panelIds` is capped by the schema, but a chapter or scene scope is only as small as the project: each panel
  // costs several queries plus a Sharp resize in this request, so an unbounded chapter stalls the whole API.
  if (ids.length > MAX_BULK_PANELS)
    throw badRequest(`This scope has ${ids.length} panels; generate at most ${MAX_BULK_PANELS} at a time.`);
  const rows = ids.length
    ? await deps.db
        .select()
        .from(panels)
        .where(and(inArray(panels.id, ids), eq(panels.projectId, p.id)))
    : [];
  const eligible = rows.filter(
    (r) =>
      r.approvalStatus !== "locked" &&
      r.status !== "queued" &&
      r.status !== "generating" &&
      (!input.onlyMissing || !r.activeArtworkAssetId),
  );
  ids = ids.filter((id) => eligible.some((r) => r.id === id));
  const chosen = await checkImageChoice(c, input.ai);
  // Demo mode has no real provider, so a batch run there simply falls back to generating normally.
  if (input.batch && !BATCH_CAPABLE_PROVIDERS.has(chosen.provider) && !deps.config.AI_MOCK_MODE)
    throw badRequest(
      `${chosen.provider} has no batch API, so this run cannot be batched. Generate it normally, or pick an OpenAI or Google key.`,
    );
  // Batch spend is recorded against the ":batch" model, which is priced at half; estimate from the same row.
  const rate = await deps.usage.rateFor(chosen.provider, input.batch ? batchModel(chosen.model) : chosen.model);
  const estimate = {
    count: ids.length,
    skipped: rows.length - ids.length,
    total: rows.length,
    skippedReasons: {
      inProgress: rows.filter((r) => r.status === "queued" || r.status === "generating").length,
      hasArtwork: rows.filter(
        (r) => input.onlyMissing && r.activeArtworkAssetId && r.status !== "queued" && r.status !== "generating",
      ).length,
      locked: rows.filter((r) => r.approvalStatus === "locked").length,
    },
    estimatedUsd: estimateImageBatchUsd(ids.length, chosen.provider === "google" ? 1120 : 400, rate),
    provider: { provider: chosen.provider, model: chosen.model },
    batch: input.batch,
    rateSnapshot: rate ? { provider: rate.provider, model: rate.model, effectiveFrom: rate.effectiveFrom } : null,
  };
  const budget = await projectBudget(deps.db, p.id);
  if (!input.confirm)
    return c.json({
      confirmRequired: true,
      ...estimate,
      budget,
      preflight: await generationPreflight(deps.db, ids),
      credentials: await credentialReadiness(c),
    });
  await assertBudget(c, p.id, estimate.estimatedUsd ?? 0);
  // Recorded on the jobs, so the worker honours the same confirmation instead of pausing the batch it queued.
  const allowOverBudget = c.req.header("x-allow-over-budget") === "1";
  if (!ids.length) return c.json({ batchId: null, jobs: [], ...estimate });
  const priority = scope.panelIds ? PRIORITY.single : scope.pageId ? PRIORITY.page : PRIORITY.chapter;
  const batchId = crypto.randomUUID();
  const jobs = [];
  const failures: { panelId: string; error: string }[] = [];
  for (const id of ids) {
    try {
      jobs.push(
        await deps.planner.enqueuePanel(id, user(c).id, {
          priority,
          batchId,
          ai: input.ai,
          allowOverBudget,
          batchMode: input.batch,
        }),
      );
    } catch (e) {
      failures.push({ panelId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // The panels above were written but not queued; this job collects them into provider batches and parks them.
  if (input.batch && jobs.length)
    await deps.db.transaction(async (tx) => {
      await deps.jobs.createGenerationJob(tx, {
        projectId: p.id,
        userId: user(c).id,
        kind: "image_batch_submit",
        priority,
        batchId,
        // Without the caller's confirmation the submitter is the one job that still trips the budget gate, and
        // pausing it converts the whole run back to interactive pricing on resume.
        parameters: { ai: input.ai ?? null, ...(allowOverBudget ? { allowOverBudget: true } : {}) },
        input: { batchId },
      });
    });
  await deps.jobs.kick();
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "generation.bulk",
    metadata: { batchId, count: jobs.length, scope },
    requestId: c.get("requestId"),
  });
  return c.json({ batchId, jobs: jobs.map((j) => ({ id: j.id, targetId: j.targetId })), failures, ...estimate }, 202);
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/preflight",
  summary:
    "Dry run before generating: harm vocabulary in bibles/panel text, lone-figure distress lighting, stale or missing references (?chapterId=&pageId=)",
  tag: "generations",
});
/** BYOK: a run needs one of the caller's own keys, so "no usable key" is the cheapest thing to catch up front. */
async function credentialReadiness(c: Context<AppEnv>) {
  const deps = c.get("deps");
  const creds = await deps.credentials.list(user(c).id);
  const has = (cap: "text" | "image") => creds.some((x) => providerSupports(x.kind, cap));
  return {
    text: Boolean(deps.providers.text) || has("text"),
    image: Boolean(deps.providers.image) || has("image"),
    mockMode: deps.config.AI_MOCK_MODE,
  };
}

generationRoutes.get("/projects/:projectId/preflight", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, z.object({ chapterId: z.string().uuid().optional(), pageId: z.string().uuid().optional() }));
  if (q.chapterId) await entityAccess(c, "chapter", q.chapterId, "read");
  if (q.pageId) await entityAccess(c, "page", q.pageId, "read");
  const deps = c.get("deps");
  const ids =
    q.chapterId || q.pageId
      ? await deps.planner.panelIdsFor({ chapterId: q.chapterId, pageId: q.pageId })
      : (await deps.db.select({ id: panels.id }).from(panels).where(eq(panels.projectId, p.id))).map((r) => r.id);
  return c.json({ preflight: await generationPreflight(deps.db, ids), credentials: await credentialReadiness(c) });
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/generations/batches",
  summary: "Active and recently finished bulk batches with chapter/page, progress and queue position",
  tag: "generations",
});
generationRoutes.get("/projects/:projectId/generations/batches", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const batches = await db.execute<{
    batch_id: string;
    created_at: string;
    finished_at: string | null;
    first_queued_at: string | null;
    priority: number;
    total: number;
    completed: number;
    generating: number;
    queued: number;
    failed: number;
    cancelled: number;
    paused: number;
    pause_reason: string | null;
  }>(sql`
    select batch_id, min(created_at) as created_at, max(finished_at) as finished_at,
      min(created_at) filter (where status = 'queued') as first_queued_at, min(priority)::int as priority,
      count(*)::int as total,
      count(*) filter (where status = 'completed')::int as completed,
      count(*) filter (where status = 'processing')::int as generating,
      count(*) filter (where status = 'queued')::int as queued,
      count(*) filter (where status = 'failed')::int as failed,
      count(*) filter (where status in ('cancelled', 'cancel_requested'))::int as cancelled,
      count(*) filter (where status = 'paused')::int as paused,
      max(failure_reason) filter (where status = 'paused') as pause_reason
    from generation_jobs
    where project_id = ${p.id} and batch_id is not null
    group by batch_id
    having count(*) filter (where status in ('queued', 'submitted', 'processing', 'cancel_requested', 'paused')) > 0
      or max(finished_at) > now() - interval '15 minutes'
    order by min(created_at)`);
  const list = [...batches];
  if (!list.length) return c.json({ batches: [], imageQueue: { queued: 0, generating: 0 } });
  const ids = list.map((b) => b.batch_id);
  const places = await db.execute<{
    batch_id: string;
    chapter_id: string;
    chapter_title: string;
    chapter_order: number;
    page_ids: string[];
    page_orders: number[];
  }>(sql`
    select g.batch_id, pg.chapter_id, ch.title as chapter_title, ch."order" as chapter_order,
      array_agg(distinct pg.id) as page_ids, array_agg(distinct pg."order") as page_orders
    from generation_jobs g
    join panels pn on pn.id = g.target_id
    join pages pg on pg.id = pn.page_id
    join chapters ch on ch.id = pg.chapter_id
    where g.batch_id in (${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    )})
    group by g.batch_id, pg.chapter_id, ch.title, ch."order"`);
  // The image queue is shared by every project on this server, so position counts all queued image jobs ahead.
  const [global] = await db.execute<{ queued: number; generating: number }>(sql`
    select count(*) filter (where status = 'queued')::int as queued, count(*) filter (where status = 'processing')::int as generating
    from generation_jobs where queue in ('image-generation', 'image-edit')`);
  const out = [];
  for (const b of list) {
    let ahead = 0;
    if (b.queued > 0 && b.first_queued_at) {
      const [r] = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from generation_jobs
        where queue in ('image-generation', 'image-edit') and status = 'queued' and batch_id is distinct from ${b.batch_id}
          and (priority < ${b.priority} or (priority = ${b.priority} and created_at < ${b.first_queued_at}))`);
      ahead = r?.n ?? 0;
    }
    const where = [...places].filter((x) => x.batch_id === b.batch_id);
    const active = b.queued + b.generating + b.paused > 0;
    out.push({
      batchId: b.batch_id,
      createdAt: b.created_at,
      finishedAt: active ? null : b.finished_at,
      state: active ? (b.generating > 0 ? "running" : b.queued > 0 ? "queued" : "paused") : "finished",
      pauseReason: b.pause_reason,
      progress: {
        total: b.total,
        completed: b.completed,
        generating: b.generating,
        queued: b.queued,
        failed: b.failed,
        cancelled: b.cancelled,
        paused: b.paused,
      },
      queuedAhead: ahead,
      chapters: where.map((w) => ({ id: w.chapter_id, title: w.chapter_title, order: w.chapter_order })),
      pageIds: where.flatMap((w) => w.page_ids),
      pageOrders: where.flatMap((w) => w.page_orders).sort((a, b2) => a - b2),
    });
  }
  return c.json({ batches: out, imageQueue: global ?? { queued: 0, generating: 0 } });
});

doc({
  method: "GET",
  path: "/api/generations/batches/:batchId",
  summary: "Batch progress (completed / generating / queued / failed)",
  tag: "generations",
});
generationRoutes.get("/generations/batches/:batchId", async (c) => {
  const batchId = uuidParam(c, "batchId");
  const { db } = c.get("deps");
  const [first] = await db
    .select({ projectId: generationJobs.projectId })
    .from(generationJobs)
    .where(eq(generationJobs.batchId, batchId))
    .limit(1);
  if (!first) throw notFound("Batch");
  await projectAccess(c, first.projectId, "read");
  const [row] = await db.execute<Record<string, number>>(sql`select count(*)::int as total,
    count(*) filter (where status='completed')::int as completed, count(*) filter (where status='processing')::int as generating,
    count(*) filter (where status='queued')::int as queued, count(*) filter (where status='failed')::int as failed,
    count(*) filter (where status in ('cancelled','cancel_requested'))::int as cancelled from generation_jobs where batch_id = ${batchId}`);
  return c.json({ batchId, progress: row });
});

async function batchProject(c: Parameters<typeof projectAccess>[0], batchId: string) {
  const [first] = await c
    .get("deps")
    .db.select({ projectId: generationJobs.projectId })
    .from(generationJobs)
    .where(eq(generationJobs.batchId, batchId))
    .limit(1);
  if (!first) throw notFound("Batch");
  return projectAccess(c, first.projectId, "generate");
}

doc({
  method: "POST",
  path: "/api/generations/batches/:batchId/pause",
  summary: "Pause a batch: not-yet-started jobs stop; running jobs finish",
  tag: "generations",
});
generationRoutes.post("/generations/batches/:batchId/pause", async (c) => {
  const batchId = uuidParam(c, "batchId");
  await batchProject(c, batchId);
  const paused = await c.get("deps").jobs.pauseBatch(batchId, "paused by user");
  return c.json({ paused });
});

doc({
  method: "POST",
  path: "/api/generations/batches/:batchId/resume",
  summary: "Resume a paused batch (checks the project budget first)",
  tag: "generations",
});
generationRoutes.post("/generations/batches/:batchId/resume", async (c) => {
  const batchId = uuidParam(c, "batchId");
  const p = await batchProject(c, batchId);
  await assertBudget(c, p.id);
  const resumed = await c.get("deps").jobs.resumeBatch(batchId, {
    allowOverBudget: c.req.header("x-allow-over-budget") === "1",
  });
  return c.json({ resumed });
});

doc({
  method: "POST",
  path: "/api/generations/batches/:batchId/cancel",
  summary: "Cancel all not-yet-started jobs of a batch",
  tag: "generations",
});
generationRoutes.post("/generations/batches/:batchId/cancel", async (c) => {
  const batchId = uuidParam(c, "batchId");
  const deps = c.get("deps");
  const jobs = await deps.db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.batchId, batchId),
        inArray(generationJobs.status, ["queued", "submitted", "processing", "paused"]),
      ),
    );
  if (!jobs.length) return c.json({ cancelled: 0 });
  await projectAccess(c, jobs[0]!.projectId, "generate");
  let cancelled = 0;
  for (const j of jobs) if ((await deps.jobs.cancelGeneration(j.id)) !== "not_cancellable") cancelled++;
  await deps.db.execute(sql`update panels set status = case when active_artwork_asset_id is null then 'planned'::panel_status else 'ready'::panel_status end
    where id in (select target_id from generation_jobs where batch_id = ${batchId} and status = 'cancelled') and status = 'queued'`);
  return c.json({ cancelled });
});

const CoverInput = z.object({
  title: z.string().max(200),
  subtitle: z.string().max(300).default(""),
  composition: z.string().max(2000).default(""),
  characterIds: z.array(z.string().uuid()).max(6).default([]),
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/cover",
  summary: "Generate cover artwork (title composited by app, not the model)",
  tag: "generations",
  body: CoverInput,
});
generationRoutes.post("/projects/:projectId/cover", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  const input = await body(c, CoverInput);
  await assertBudget(c, p.id);
  await checkImageChoice(c, input.ai);
  const deps = c.get("deps");
  const job = await deps.planner.enqueueCover(p.id, user(c).id, input);
  await deps.jobs.kick();
  return c.json({ job }, 202);
});
