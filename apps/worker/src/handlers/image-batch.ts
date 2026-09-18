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
import { and, eq, generationJobs, inArray, lt, panels, providerBatches, sql } from "@openmanga/db";
import { batchModel, hashOf } from "@openmanga/domain";
import type { AiChoice } from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";
import type { GenerationJob } from "../lib/runner.ts";
import { activatePanelArt, finalizeOutput, inputsOf, loadInputFile, recordImageUsage } from "./image.ts";
import { ingestTextBatch, textBatchSubmit } from "./text-batch.ts";

type BatchRow = typeof providerBatches.$inferSelect;

const choiceOf = (job: { parameters: Record<string, unknown> }) => (job.parameters.ai as AiChoice | undefined) ?? null;

/** Rebuilds the batch provider for a stored batch from one of its jobs, since the key lives with the user. */
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
        eq(generationJobs.kind, "panel_generation"),
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

  const specs: BatchRequestSpec[] = [];
  for (const p of pending) specs.push(await specFor(deps, p));
  const chunks = provider.chunk(specs);
  let submitted = 0;
  for (const chunk of chunks) {
    const keys = chunk.map((c) => c.key);
    const idempotencyKey = `${batchId}:${hashOf([...keys].sort()).slice(0, 16)}`;
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
          projectId: job.projectId,
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
  }
  deps.logger.info("submitted image batches", { batchId, panels: submitted, batches: chunks.length });
  return { submitted, batches: chunks.length, fellBack: 0 };
}

/**
 * Submits text jobs that were parked for a batch but never handed to a submitter — the automatic consistency
 * checks, which are created one at a time as panels are ingested. Grouped by run so each becomes one submission.
 */
async function sweepUnsubmittedTextJobs(deps: WorkerDeps) {
  const waiting = await deps.db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.status, "queued"),
        sql`${generationJobs.parameters}->>'batchMode' = 'true'`,
        sql`${generationJobs.queue} = 'text-ai'`,
        sql`${generationJobs.batchId} is not null`,
        // A moment's grace so a run still creating its jobs is submitted once, not once per job.
        lt(generationJobs.createdAt, new Date(Date.now() - 60_000)),
      ),
    )
    .limit(500);
  const byBatch = new Map<string, (typeof waiting)[number]>();
  for (const job of waiting) if (job.batchId && !byBatch.has(job.batchId)) byBatch.set(job.batchId, job);
  let submitted = 0;
  for (const [batchId, sample] of byBatch) {
    try {
      const out = await textBatchSubmit(deps, { ...sample, input: { batchId } });
      submitted += out.submitted;
    } catch (e) {
      deps.logger.error("text batch sweep failed", {
        batchId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return submitted;
}

/** Polls every unfinished batch and ingests the ones that are done. Called from the scheduler. */
export async function pollProviderBatches(deps: WorkerDeps) {
  const swept = await sweepUnsubmittedTextJobs(deps).catch(() => 0);
  const rows = await deps.db
    .select()
    .from(providerBatches)
    .where(inArray(providerBatches.state, ["pending", "running"]));
  const result = { polled: 0, ingested: 0, failed: 0, swept };
  for (const row of rows) {
    try {
      await pollOne(deps, row, result);
    } catch (e) {
      deps.logger.error("batch poll failed", { batchId: row.id, error: e instanceof Error ? e.message : String(e) });
    }
    result.polled++;
  }
  return result;
}

async function pollOne(deps: WorkerDeps, row: BatchRow, result: { ingested: number; failed: number }) {
  const jobs = await deps.db
    .select()
    .from(generationJobs)
    .where(sql`${generationJobs.parameters}->>'providerBatchId' = ${row.id}`);
  if (row.capability === "text" && jobs.length) {
    const out = await ingestTextBatch(deps, row, jobs);
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

  const byId = new Map(jobs.map((j) => [j.id, j]));
  for (const item of status.items ?? []) {
    const job = byId.get(item.key);
    if (!job) {
      deps.logger.warn("batch returned an unknown key", { batchId: row.id, key: item.key });
      continue;
    }
    if (job.status !== "submitted") continue; // already ingested, or cancelled meanwhile
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
  // A batch that ended without per-item results (expired, cancelled, or a provider-level failure) leaves its
  // jobs parked forever otherwise.
  if (!status.items?.length && status.state !== "succeeded") {
    for (const job of jobs.filter((j) => j.status === "submitted"))
      await failOne(deps, job, {
        key: job.id,
        ok: false,
        code: status.state,
        message: status.error ?? `The provider batch ${status.state}`,
      });
  }
  await provider
    .releaseBatch({ handle: row.handle, keys: [], idempotencyKey: row.idempotencyKey, ownedFileIds: row.ownedFileIds })
    .catch(() => {});
  await deps.db
    .update(providerBatches)
    .set({ ingestedAt: new Date(), ownedFileIds: [] })
    .where(eq(providerBatches.id, row.id));
}

async function ingestOne(deps: WorkerDeps, job: GenerationJob, item: Extract<BatchItemResult, { ok: true }>) {
  const inputs = await inputsOf(deps, job.id);
  const { asset, cancelled } = await finalizeOutput(deps, job, item.result, "panel_art", { batch: true }, null);
  // Recorded against the ":batch" model so the discounted price is what the run is charged.
  await recordImageUsage(deps, job, { ...item.result, model: batchModel(item.result.model) }, inputs);
  if (!cancelled && job.targetId) await activatePanelArt(deps, job, job.targetId, asset.id, null);
  await deps.db
    .update(generationJobs)
    .set({
      status: cancelled ? "cancelled" : "completed",
      finishedAt: new Date(),
      result: { assetId: asset.id, width: item.result.width, height: item.result.height, batch: true },
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

async function failOne(deps: WorkerDeps, job: GenerationJob, item: Extract<BatchItemResult, { ok: false }>) {
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
