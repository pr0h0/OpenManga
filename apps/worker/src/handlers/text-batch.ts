/**
 * Text (and vision-text) jobs through a provider batch: planning, analysis, rewrites, page prompts, narration
 * and the panel consistency check, all at half price.
 *
 * The submit pass runs each job's own handler with a collector installed, which harvests the messages the handler
 * would have sent and parks the job. Ingest writes the answer onto the job and puts it back on its normal queue,
 * so the handler runs again and its validation, appliers, events and usage accounting all happen exactly as in a
 * synchronous run. Nothing about the handlers had to be split apart to make this work.
 */
import { batchCallRecord, type TextBatchItemResult, type TextBatchRequestSpec } from "@openmanga/ai-text";
import { and, eq, generationJobs, inArray, providerBatches, sql } from "@openmanga/db";
import { batchModel, hashOf } from "@openmanga/domain";
import type { AiChoice } from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";
import { withBatchClaim } from "../lib/batch-claim.ts";
import type { GenerationJob } from "../lib/runner.ts";
import { recordTextCalls } from "../lib/runner.ts";
import { BatchCollector, ParkedForBatch } from "../lib/text-batch-provider.ts";

import { TEXT_HANDLERS } from "./text-handlers.ts";

type BatchRow = typeof providerBatches.$inferSelect;

const choiceOf = (job: { parameters: Record<string, unknown> }) => (job.parameters.ai as AiChoice | undefined) ?? null;

/** Runs a job's handler only far enough to capture the request it would have made. */
async function collectFrom(deps: WorkerDeps, job: GenerationJob): Promise<TextBatchRequestSpec | null> {
  const handler = TEXT_HANDLERS[job.kind];
  if (!handler) return null;
  const collector = new BatchCollector();
  try {
    await handler({ ...deps, batchCollector: collector }, job);
    // A handler that returned without calling the provider has nothing to batch (nothing to do, or it failed
    // its own preconditions); it stays queued and runs normally.
    deps.logger.warn("batch collect: handler returned without calling a provider", { jobId: job.id, kind: job.kind });
    return null;
  } catch (e) {
    if (e instanceof ParkedForBatch) return collector.specs[0] ?? null;
    throw e;
  }
}

/** Puts jobs back on their ordinary queue and clears the batch marker, so no sweep tries to batch them again. */
async function runSynchronously(deps: WorkerDeps, jobs: GenerationJob[]) {
  for (const j of jobs) {
    await deps.db
      .update(generationJobs)
      .set({ parameters: sql`${generationJobs.parameters} - 'batchMode'` })
      .where(eq(generationJobs.id, j.id));
    await deps.jobs.enqueueGeneration(j);
  }
  await deps.jobs.kick();
}

export async function textBatchSubmit(deps: WorkerDeps, job: GenerationJob) {
  const batchId = job.batchId ?? String(job.input.batchId ?? "");
  if (!batchId) throw new Error("text_batch_submit has no batchId");
  const pending = await deps.db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.batchId, batchId),
        eq(generationJobs.status, "queued"),
        sql`${generationJobs.parameters}->>'batchMode' = 'true'`,
        sql`${generationJobs.queue} = 'text-ai'`,
      ),
    );
  if (!pending.length) return { submitted: 0, batches: 0, fellBack: 0 };

  const provider = await deps.resolver.textBatch(choiceOf(pending[0]!), pending[0]!.userId);
  if (!provider) {
    await runSynchronously(deps, pending);
    deps.logger.info("text batch unavailable, running synchronously", { batchId, jobs: pending.length });
    return { submitted: 0, batches: 0, fellBack: pending.length };
  }

  const specs: TextBatchRequestSpec[] = [];
  const byKey = new Map<string, GenerationJob>();
  for (const p of pending) {
    const spec = await collectFrom(deps, p).catch((e) => {
      deps.logger.warn("batch collect failed", { jobId: p.id, error: e instanceof Error ? e.message : String(e) });
      return null;
    });
    if (!spec) continue;
    specs.push(spec);
    byKey.set(spec.key, p);
  }
  if (!specs.length) {
    // Nothing could be collected: run them the ordinary way rather than leaving them stuck.
    await runSynchronously(deps, pending);
    return { submitted: 0, batches: 0, fellBack: pending.length };
  }

  let submitted = 0;
  const chunks = provider.chunk(specs);
  for (const chunk of chunks) {
    const keys = chunk.map((c) => c.key);
    const idempotencyKey = `${batchId}:text:${hashOf([...keys].sort()).slice(0, 16)}`;
    await withBatchClaim(deps, idempotencyKey, async () => {
      const [known] = await deps.db
        .select()
        .from(providerBatches)
        .where(eq(providerBatches.idempotencyKey, idempotencyKey));
      let handle = known
        ? { handle: known.handle, keys, idempotencyKey, ownedFileIds: known.ownedFileIds }
        : ((await provider.findByIdempotencyKey(idempotencyKey).catch(() => null)) ?? null);
      if (!handle) handle = await provider.submitBatch(chunk, idempotencyKey);

      await deps.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(providerBatches)
          .values({
            projectId: job.projectId,
            userId: job.userId,
            batchId,
            capability: "text",
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
            parameters: sql`${generationJobs.parameters} || ${JSON.stringify({ providerBatchId: batchRowId })}::jsonb`,
          })
          .where(and(inArray(generationJobs.id, keys), eq(generationJobs.status, "queued")));
      });
      submitted += keys.length;
      for (const key of keys) {
        const target = byKey.get(key);
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
  }
  deps.logger.info("submitted text batches", { batchId, jobs: submitted, batches: chunks.length });
  return { submitted, batches: chunks.length, fellBack: 0 };
}

/**
 * Hands a finished text batch back to the ordinary pipeline: the answer is stored on the job, the job goes back
 * to `queued`, and its own handler replays it.
 */
export async function ingestTextBatch(deps: WorkerDeps, row: BatchRow, jobs: GenerationJob[]) {
  const provider = await deps.resolver.textBatch(choiceOf(jobs[0]!), jobs[0]!.userId);
  if (!provider) throw new Error(`no text batch provider for ${row.provider}/${row.model}`);
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
  if (status.state === "pending" || status.state === "running") return { ingested: 0, failed: 0 };

  const byId = new Map(jobs.map((j) => [j.id, j]));
  let ingested = 0;
  let failed = 0;
  for (const item of status.items ?? []) {
    const job = byId.get(item.key);
    if (job?.status === "cancel_requested" || job?.status === "cancelled") {
      await deps.db
        .update(generationJobs)
        .set({ status: "cancelled", finishedAt: new Date(), failureReason: "Cancelled while waiting in a batch" })
        .where(and(eq(generationJobs.id, job.id), inArray(generationJobs.status, ["cancel_requested", "submitted"])));
      continue;
    }
    if (job?.status !== "submitted") continue;
    if (item.ok) {
      await replay(deps, job, item);
      ingested++;
    } else {
      await failText(deps, job, item);
      failed++;
    }
  }
  // Anything the batch did not answer for, whatever its overall state.
  const stranded = await deps.db
    .select()
    .from(generationJobs)
    .where(
      and(sql`${generationJobs.parameters}->>'providerBatchId' = ${row.id}`, eq(generationJobs.status, "submitted")),
    );
  for (const job of stranded) {
    await failText(deps, job, {
      key: job.id,
      ok: false,
      code: status.state === "succeeded" ? "missing_result" : status.state,
      message: status.error ?? `The provider batch ${status.state} without a result for this request`,
    });
    failed++;
  }
  await provider
    .releaseBatch({ handle: row.handle, keys: [], idempotencyKey: row.idempotencyKey, ownedFileIds: row.ownedFileIds })
    .catch(() => {});
  await deps.db
    .update(providerBatches)
    .set({ ingestedAt: new Date(), ownedFileIds: [] })
    .where(eq(providerBatches.id, row.id));
  return { ingested, failed };
}

async function replay(deps: WorkerDeps, job: GenerationJob, item: Extract<TextBatchItemResult, { ok: true }>) {
  await deps.db
    .update(generationJobs)
    .set({
      status: "queued",
      // `batchMode` is dropped here: the job is no longer waiting to be submitted, and leaving the marker would
      // let the submit sweep pick it up again and pay for a second batch of a job that already has its answer.
      parameters: sql`(${generationJobs.parameters} - 'batchMode') || ${JSON.stringify({
        batchAnswer: { text: item.text, usage: item.usage },
      })}::jsonb`,
    })
    .where(eq(generationJobs.id, job.id));
  // Back on its own queue: the handler runs again and the replay provider answers with the batched text.
  await deps.jobs.enqueueGeneration(job);
  await deps.jobs.kick();
}

async function failText(deps: WorkerDeps, job: GenerationJob, item: Extract<TextBatchItemResult, { ok: false }>) {
  // Billed-but-unusable is still billed: record it before failing, as the synchronous path does.
  if (item.usage && (item.usage.inputTokens || item.usage.outputTokens))
    await recordTextCalls(deps, job, [
      {
        ...batchCallRecord(job.provider ?? "", batchModel(job.model ?? ""), item.usage),
        success: false,
      },
    ]).catch(() => {});
  await deps.db
    .update(generationJobs)
    .set({ status: "failed", failureCode: item.code, failureReason: item.message, finishedAt: new Date() })
    .where(eq(generationJobs.id, job.id));
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
