/**
 * Two-phase image generation through a provider's async batch API: half the price, up to 24h of waiting.
 *
 * Phase one (`imageBatchSubmit`) collects a bulk run's panels into as few provider batches as the provider's
 * limits allow, then parks each panel job at `submitted`. Nothing holds a worker slot while the provider works —
 * a 24h await inside a handler would lose its BullMQ lock and starve the image queue.
 *
 * Phase two (`pollProviderBatches`, run from the scheduler) ingests finished batches through the same
 * finalize/activate/record path the synchronous handler uses, so a batched panel is indistinguishable afterwards
 * apart from its recorded price.
 */

import type { BatchItemResult, BatchRequestSpec, ImageBatchProvider } from "@openmanga/ai-image";
import { and, eq, generationJobs, inArray, isNull, lt, panels, providerBatches, sql } from "@openmanga/db";
import { batchModel, hashOf } from "@openmanga/domain";
import type { AiChoice } from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";
import { withBatchClaim } from "../lib/batch-claim.ts";
import {
  dueWaitingJobs,
  holdForSlot,
  inFlightBatches,
  isQueueFull,
  roundSuffix,
  waitForBatchRoom,
} from "../lib/batch-wait.ts";
import { type GenerationJob, inProject, pausedByBudget } from "../lib/runner.ts";
import {
  activatePanelArt,
  attachReference,
  finalizeOutput,
  inputsOf,
  loadInputFile,
  recordImageUsage,
} from "./image.ts";
import { maybeQueuePanelCheck } from "./qa.ts";
import { ingestTextBatch, textBatchSubmit } from "./text-batch.ts";

type BatchRow = typeof providerBatches.$inferSelect;

const choiceOf = (job: { parameters: Record<string, unknown> }) => (job.parameters.ai as AiChoice | undefined) ?? null;

/** Rebuilds the batch provider for a stored batch from one of its jobs, since the key lives with the user. */
/**
 * Image jobs a provider batch can carry. Each is fully compiled when it is written — prompt, aspect, quality and
 * input images are on the row — which is all a batch request is made of.
 */
const BATCHABLE_IMAGE_KINDS = [
  "panel_generation",
  "character_reference",
  "location_reference",
  "prop_reference",
] as const;

async function providerFor(deps: WorkerDeps, job: GenerationJob): Promise<ImageBatchProvider | null> {
  return deps.resolver.imageBatch(choiceOf(job), job.userId);
}

async function specFor(deps: WorkerDeps, job: GenerationJob): Promise<BatchRequestSpec> {
  const inputs = await inputsOf(deps, job.id);
  const references = [];
  for (const i of inputs) {
    const file = await loadInputFile(deps, i);
    // The variant id is stable and shared across panels, which is what lets a provider upload it once.
    references.push({ ...file, id: i.variantId ?? i.assetId ?? `${job.id}-${i.order}` });
  }
  return {
    key: job.id,
    prompt: job.compiledPrompt ?? "",
    aspectRatio: Number(job.parameters.aspectRatio ?? 1),
    quality: String(job.parameters.quality ?? deps.config.IMAGE_QUALITY),
    references,
  };
}

/**
 * Collects the run's still-unsubmitted panels into provider batches. Re-running this job is safe: jobs already
 * parked are no longer `queued`, and each chunk's idempotency key is derived from the job ids it contains, so a
 * retry after a crash finds the batch it already created rather than paying for a second one.
 */
export async function imageBatchSubmit(deps: WorkerDeps, job: GenerationJob) {
  const batchId = job.batchId ?? String(job.input.batchId ?? "");
  if (!batchId) throw new Error("image_batch_submit has no batchId");
  const pending = await deps.db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.batchId, batchId),
        inArray(generationJobs.kind, [...BATCHABLE_IMAGE_KINDS]),
        eq(generationJobs.status, "queued"),
      ),
    );
  if (!pending.length) return { submitted: 0, batches: 0, fellBack: 0 };

  const provider = await providerFor(deps, pending[0]!);
  if (!provider) {
    // No batch API for this key (or mock mode): run the panels the ordinary way rather than leaving them parked.
    for (const p of pending) await deps.jobs.enqueueGeneration(p);
    await deps.jobs.kick();
    deps.logger.info("batch unavailable, fell back to synchronous generation", { batchId, panels: pending.length });
    return { submitted: 0, batches: 0, fellBack: pending.length };
  }

  // Checked before building any request: a held run would otherwise read every reference file on every poll.
  const limit = deps.config.BATCH_MAX_IN_FLIGHT_IMAGE;
  const free = limit ? limit - (await inFlightBatches(deps, job.userId, provider.provider, provider.model)) : Infinity;
  if (free <= 0) return { submitted: 0, batches: 0, fellBack: 0, ...(await holdForSlot(deps, pending, limit)) };

  const specs: BatchRequestSpec[] = [];
  for (const p of pending) specs.push(await specFor(deps, p));
  const chunks = provider.chunk(specs);
  const byId = new Map(pending.map((p) => [p.id, p]));
  let submitted = 0;
  let accepted = 0;
  let refused: unknown = null;
  for (const chunk of chunks) {
    if (accepted >= free) break;
    const keys = chunk.map((c) => c.key);
    const idempotencyKey = `${batchId}:${hashOf([...keys].sort()).slice(0, 16)}${roundSuffix(keys.map((k) => byId.get(k)!))}`;
    try {
      await withBatchClaim(deps, idempotencyKey, async () => {
        const [known] = await deps.db
          .select()
          .from(providerBatches)
          .where(eq(providerBatches.idempotencyKey, idempotencyKey));
        let handle = known
          ? { handle: known.handle, keys, idempotencyKey, ownedFileIds: known.ownedFileIds }
          : // A crash between submitting and persisting would otherwise pay twice: ask the provider first.
            ((await provider.findByIdempotencyKey(idempotencyKey).catch(() => null)) ?? null);
        if (!handle) handle = await provider.submitBatch(chunk, idempotencyKey);

        await deps.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(providerBatches)
            .values({
              projectId: inProject(job).projectId,
              userId: job.userId,
              batchId,
              capability: "image",
              provider: provider.provider,
              model: provider.model,
              handle: handle.handle,
              idempotencyKey,
              state: "pending",
              requestCount: keys.length,
              ownedFileIds: handle.ownedFileIds ?? [],
              submittedAt: new Date(),
            })
            .onConflictDoNothing({ target: providerBatches.idempotencyKey })
            .returning();
          const batchRowId =
            row?.id ??
            (await tx.select().from(providerBatches).where(eq(providerBatches.idempotencyKey, idempotencyKey)))[0]!.id;
          await tx
            .update(generationJobs)
            .set({
              status: "submitted",
              provider: provider.provider,
              model: provider.model,
              parameters: sql`${generationJobs.parameters} || ${JSON.stringify({ providerBatchId: batchRowId })}::jsonb`,
            })
            .where(and(inArray(generationJobs.id, keys), eq(generationJobs.status, "queued")));
        });
        submitted += keys.length;
        for (const key of keys) {
          const target = pending.find((p) => p.id === key);
          if (target)
            await deps.events.publish(job.projectId, {
              type: "job.updated",
              jobId: key,
              kind: target.kind,
              status: "submitted",
              targetType: target.targetType,
              targetId: target.targetId,
              batchId,
            });
        }
      });
      accepted++;
    } catch (e) {
      if (!isQueueFull(e)) throw e;
      // The rest would be refused the same way: stop here, and keep what was already accepted.
      refused = e;
      break;
    }
  }
  deps.logger.info("submitted image batches", { batchId, panels: submitted, batches: accepted });
  if (accepted < chunks.length) {
    const done = new Set(chunks.slice(0, accepted).flatMap((c) => c.map((r) => r.key)));
    const left = pending.filter((p) => !done.has(p.id));
    const wait = refused
      ? await waitForBatchRoom(deps, left, refused instanceof Error ? refused.message : String(refused))
      : await holdForSlot(deps, left, limit);
    return { submitted, batches: accepted, fellBack: 0, ...wait };
  }
  return { submitted, batches: chunks.length, fellBack: 0 };
}

/**
 * Submits batch-mode jobs that no submit job is coming for: the automatic consistency checks, which are created
 * one at a time as panels are ingested, and any job whose wait for room in the provider's batch queue is over.
 * Grouped by run so each becomes one submission.
 */
async function sweepUnsubmittedJobs(deps: WorkerDeps) {
  const fresh = await deps.db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.status, "queued"),
        sql`${generationJobs.parameters}->>'batchMode' = 'true'`,
        sql`${generationJobs.parameters}->'queueWait' is null`,
        sql`${generationJobs.queue} = 'text-ai'`,
        sql`${generationJobs.batchId} is not null`,
        // A moment's grace so a run still creating its jobs is submitted once, not once per job.
        lt(generationJobs.createdAt, new Date(Date.now() - 60_000)),
      ),
    )
    .limit(500);
  const groups = new Map<string, GenerationJob>();
  for (const job of [...fresh, ...(await dueWaitingJobs(deps))]) {
    const key = `${job.batchId}:${job.queue}`;
    if (job.batchId && !groups.has(key)) groups.set(key, job);
  }
  let submitted = 0;
  for (const sample of groups.values()) {
    const batchId = sample.batchId!;
    try {
      // These skip the runner, so they take its budget gate here: a provider batch is paid for once submitted.
      if (await pausedByBudget(deps, sample)) continue;
      const run = sample.queue === "text-ai" ? textBatchSubmit : imageBatchSubmit;
      const out = await run(deps, { ...sample, input: { batchId } });
      submitted += out.submitted;
    } catch (e) {
      deps.logger.error("batch submit sweep failed", {
        batchId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return submitted;
}

/** Polls every unfinished batch and ingests the ones that are done. Called from the scheduler. */
export async function pollProviderBatches(deps: WorkerDeps) {
  const rows = await deps.db
    .select()
    .from(providerBatches)
    .where(
      and(
        isNull(providerBatches.ingestedAt),
        // Keyed on "not yet ingested" rather than "not yet terminal": a crash, a deploy or one throwing ingest
        // between the state write and the end of the item loop would otherwise strand the rest of the batch.
        inArray(providerBatches.state, ["pending", "running", "succeeded", "partial", "failed", "expired"]),
      ),
    );
  const result = { polled: 0, ingested: 0, failed: 0, swept: 0, expired: 0 };
  // A batch nothing can poll any more (the credential is gone, or the provider dropped the handle) would park its
  // jobs indefinitely: nothing else watches "submitted". Gemini expires at 48h, so 50h is past every live batch.
  const tooOld = new Date(Date.now() - 50 * 3600_000);
  for (const row of rows) {
    try {
      await pollOne(deps, row, result);
    } catch (e) {
      deps.logger.error("batch poll failed", { batchId: row.id, error: e instanceof Error ? e.message : String(e) });
      if ((row.submittedAt ?? row.createdAt) < tooOld) {
        await abandon(deps, row, `Gave up polling this batch: ${e instanceof Error ? e.message : String(e)}`);
        result.expired++;
      }
    }
    result.polled++;
  }
  // After the polls, so a slot freed by a batch that just finished is filled in the same pass.
  result.swept = await sweepUnsubmittedJobs(deps).catch(() => 0);
  return result;
}

/** Fails every job still parked on a row and closes it, so nothing waits on a batch that will never arrive. */
export async function abandon(deps: WorkerDeps, row: BatchRow, reason: string) {
  const jobs = await deps.db
    .select()
    .from(generationJobs)
    .where(
      and(sql`${generationJobs.parameters}->>'providerBatchId' = ${row.id}`, eq(generationJobs.status, "submitted")),
    );
  for (const job of jobs)
    await failOne(deps, job, { key: job.id, ok: false, code: "batch_abandoned", message: reason });
  await deps.db
    .update(providerBatches)
    .set({ state: "expired", failureReason: reason, ingestedAt: new Date() })
    .where(eq(providerBatches.id, row.id));
  deps.logger.warn("abandoned a provider batch", { batchId: row.id, jobs: jobs.length, reason });
}

async function pollOne(deps: WorkerDeps, row: BatchRow, result: { ingested: number; failed: number }) {
  const jobs = await deps.db
    .select()
    .from(generationJobs)
    .where(sql`${generationJobs.parameters}->>'providerBatchId' = ${row.id}`);
  if (row.capability === "text" && jobs.length) {
    const out = await ingestTextBatch(deps, row, jobs);
    if (out.refused !== undefined) return requeueRefused(deps, row, jobs, out.refused);
    result.ingested += out.ingested;
    result.failed += out.failed;
    return;
  }
  if (!jobs.length) {
    await deps.db
      .update(providerBatches)
      .set({ state: "failed", failureReason: "No jobs reference this batch", polledAt: new Date() })
      .where(eq(providerBatches.id, row.id));
    return;
  }
  const provider = await providerFor(deps, jobs[0]!);
  if (!provider) throw new Error(`no batch provider for ${row.provider}/${row.model}`);
  const status = await provider.pollBatch({
    handle: row.handle,
    keys: jobs.map((j) => j.id),
    idempotencyKey: row.idempotencyKey,
    ownedFileIds: row.ownedFileIds,
  });
  await deps.db
    .update(providerBatches)
    .set({
      state: status.state,
      completedCount: status.counts.completed,
      failedCount: status.counts.failed,
      polledAt: new Date(),
      failureReason: status.error ?? null,
    })
    .where(eq(providerBatches.id, row.id));
  if (status.state === "pending" || status.state === "running") return;
  if (status.queueFull) {
    await provider
      .releaseBatch({
        handle: row.handle,
        keys: [],
        idempotencyKey: row.idempotencyKey,
        ownedFileIds: row.ownedFileIds,
      })
      .catch(() => {});
    return requeueRefused(deps, row, jobs, status.error ?? "batch queue full");
  }

  const byId = new Map(jobs.map((j) => [j.id, j]));
  for (const item of status.items ?? []) {
    const job = byId.get(item.key);
    if (!job) {
      deps.logger.warn("batch returned an unknown key", { batchId: row.id, key: item.key });
      continue;
    }
    if (job.status === "cancel_requested" || job.status === "cancelled") {
      await finishCancelledBatchJob(deps, job);
      continue;
    }
    if (job.status !== "submitted") continue; // already ingested by an overlapping poll
    try {
      if (item.ok) {
        await ingestOne(deps, job, item);
        result.ingested++;
      } else {
        await failOne(deps, job, item);
        result.failed++;
      }
    } catch (e) {
      deps.logger.error("batch ingest failed", { jobId: job.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  // Whatever the batch did not answer for — an expired or cancelled batch still returns the requests that did
  // finish, so a non-empty item list is no proof every key came back.
  const stranded = await deps.db
    .select()
    .from(generationJobs)
    .where(
      and(sql`${generationJobs.parameters}->>'providerBatchId' = ${row.id}`, eq(generationJobs.status, "submitted")),
    );
  for (const job of stranded) {
    await failOne(deps, job, {
      key: job.id,
      ok: false,
      code: status.state === "succeeded" ? "missing_result" : status.state,
      message: status.error ?? `The provider batch ${status.state} without a result for this request`,
    });
    result.failed++;
  }
  await provider
    .releaseBatch({ handle: row.handle, keys: [], idempotencyKey: row.idempotencyKey, ownedFileIds: row.ownedFileIds })
    .catch(() => {});
  await deps.db
    .update(providerBatches)
    .set({ ingestedAt: new Date(), ownedFileIds: [] })
    .where(eq(providerBatches.id, row.id));
}

/**
 * A batch the provider accepted and then refused for lack of room in its queue. Nothing in it ran, so its jobs go
 * back to waiting rather than failing; the next round submits them under a new key. Closes the row either way.
 */
async function requeueRefused(deps: WorkerDeps, row: BatchRow, jobs: GenerationJob[], reason: string) {
  for (const job of jobs)
    if (job.status === "cancel_requested" || job.status === "cancelled") await finishCancelledBatchJob(deps, job);
  await waitForBatchRoom(
    deps,
    jobs.filter((j) => j.status === "submitted"),
    reason,
  );
  await deps.db
    .update(providerBatches)
    .set({ ingestedAt: new Date(), ownedFileIds: [], failureReason: `Refused, queue full: ${reason}`.slice(0, 500) })
    .where(eq(providerBatches.id, row.id));
}

/**
 * A job cancelled while it was parked: the batch was already paid for, so its result is simply not activated.
 * Without this the job sits at cancel_requested for good and its panel never leaves "queued".
 */
async function finishCancelledBatchJob(deps: WorkerDeps, job: GenerationJob) {
  await deps.db
    .update(generationJobs)
    .set({ status: "cancelled", finishedAt: new Date(), failureReason: "Cancelled while waiting in a batch" })
    .where(and(eq(generationJobs.id, job.id), inArray(generationJobs.status, ["cancel_requested", "submitted"])));
  if (job.targetId) {
    const [panel] = await deps.db.select().from(panels).where(eq(panels.id, job.targetId));
    if (panel && (panel.status === "queued" || panel.status === "generating"))
      await deps.db
        .update(panels)
        .set({ status: panel.activeArtworkAssetId ? "ready" : "planned" })
        .where(eq(panels.id, panel.id));
  }
  await deps.events.publish(job.projectId, {
    type: "job.updated",
    jobId: job.id,
    kind: job.kind,
    status: "cancelled",
    targetType: job.targetType,
    targetId: job.targetId,
    batchId: job.batchId,
  });
}

async function ingestOne(deps: WorkerDeps, row: GenerationJob, item: Extract<BatchItemResult, { ok: true }>) {
  const job = inProject(row);
  const inputs = await inputsOf(deps, job.id);
  // Recorded against the ":batch" model so the discounted price is what the run is charged.
  const usage = () => recordImageUsage(deps, job, { ...item.result, model: batchModel(item.result.model) }, inputs);
  if (job.kind !== "panel_generation") {
    // A reference: the same finishing step as a direct run, so it lands as a draft reference on its version.
    await usage();
    const { asset, cancelled } = await attachReference(deps, job, item.result);
    return finishIngested(deps, job, asset.id, item.result, cancelled);
  }
  // The same panel metadata a direct run records: the Versions tab finds a panel's artwork by `panelId`, so without it
  // a batched first draw never showed up there.
  const [panel] = job.targetId
    ? await deps.db.select({ pageId: panels.pageId }).from(panels).where(eq(panels.id, job.targetId))
    : [];
  const { asset, cancelled } = await finalizeOutput(
    deps,
    job,
    item.result,
    "panel_art",
    {
      batch: true,
      panelId: job.targetId,
      pageId: panel?.pageId ?? null,
      operation: job.parameters.operation ?? null,
      referenceInputs: inputs.map((i) => ({
        role: i.role,
        assetId: i.assetId,
        variantId: i.variantId,
        width: i.width,
        height: i.height,
      })),
    },
    (job.parameters.parentAssetId as string | null) ?? null,
  );
  await usage();
  if (!cancelled && job.targetId) {
    await activatePanelArt(deps, job, job.targetId, asset.id, null);
    // Same follow-up as the synchronous handler: without this a batched project silently loses its vision QA.
    await maybeQueuePanelCheck(deps, job, job.targetId, asset.id).catch((e) =>
      deps.logger.warn("panel check not queued", { jobId: job.id, error: e instanceof Error ? e.message : String(e) }),
    );
  }
  await finishIngested(deps, job, asset.id, item.result, cancelled);
}

/** Closes a batched job once its image has been stored, whatever kind of image it was. */
async function finishIngested(
  deps: WorkerDeps,
  job: GenerationJob,
  assetId: string,
  result: { width: number; height: number },
  cancelled: boolean,
) {
  await deps.db
    .update(generationJobs)
    .set({
      status: cancelled ? "cancelled" : "completed",
      finishedAt: new Date(),
      result: { assetId, width: result.width, height: result.height, batch: true },
    })
    .where(eq(generationJobs.id, job.id));
  await deps.events.publish(job.projectId, {
    type: "job.updated",
    jobId: job.id,
    kind: job.kind,
    status: cancelled ? "cancelled" : "completed",
    targetType: job.targetType,
    targetId: job.targetId,
    batchId: job.batchId,
  });
}

async function failOne(deps: WorkerDeps, row: GenerationJob, item: Extract<BatchItemResult, { ok: false }>) {
  const job = inProject(row);
  // Billed-but-unusable is still billed: record what the provider charged before failing the job.
  if (item.usage?.imageOutputTokens || item.usage?.textInputTokens)
    await recordImageUsage(
      deps,
      job,
      {
        data: new Uint8Array(),
        mime: "image/png",
        width: 0,
        height: 0,
        provider: job.provider ?? "",
        model: batchModel(job.model ?? ""),
        quality: String(job.parameters.quality ?? ""),
        requestId: null,
        latencyMs: 0,
        usage: {
          textInputTokens: item.usage.textInputTokens ?? 0,
          imageInputTokens: item.usage.imageInputTokens ?? 0,
          imageOutputTokens: item.usage.imageOutputTokens ?? 0,
          cachedInputTokens: 0,
          raw: {},
        },
        request: { endpoint: "batch", size: "", referenceCount: 0 },
      },
      [],
    ).catch(() => {});
  await deps.db
    .update(generationJobs)
    .set({ status: "failed", failureCode: item.code, failureReason: item.message, finishedAt: new Date() })
    .where(eq(generationJobs.id, job.id));
  if (job.targetId) {
    const [panel] = await deps.db.select().from(panels).where(eq(panels.id, job.targetId));
    if (panel && (panel.status === "queued" || panel.status === "generating"))
      await deps.db
        .update(panels)
        .set({ status: panel.activeArtworkAssetId ? "ready" : "failed" })
        .where(eq(panels.id, panel.id));
  }
  await deps.events.publish(job.projectId, {
    type: "job.updated",
    jobId: job.id,
    kind: job.kind,
    status: "failed",
    targetType: job.targetType,
    targetId: job.targetId,
    batchId: job.batchId,
    failureReason: item.message,
  });
}
