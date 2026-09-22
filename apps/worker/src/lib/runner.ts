import { StructuredOutputError, type TextCallRecord } from "@openmanga/ai-text";
import { and, asc, eq, generationJobs, generationOutputs, panels, sql } from "@openmanga/db";
import { ProviderError, policyCategories } from "@openmanga/domain";
import { type Job, UnrecoverableError } from "@openmanga/queue";
import { projectBudget, recordError } from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";

export type GenerationJob = typeof generationJobs.$inferSelect;

export class JobCancelledError extends Error {}

/**
 * How quiet a `processing` row has to be before another runner may take it over. Tied to the queue's lock
 * duration (`apps/worker/src/main.ts`), which is the soonest BullMQ will redeliver a job whose runner died.
 */
const RECLAIM_AFTER_MS = 10 * 60_000;

/** Final/visible failure message: never a stack trace. */
export function userFacingError(e: unknown): { code: string; message: string } {
  if (e instanceof ProviderError)
    return { code: e.code, message: `${e.userMessage}${e.requestId ? ` (request ${e.requestId})` : ""}` };
  if (e instanceof JobCancelledError) return { code: "cancelled", message: "Cancelled" };
  if (e instanceof Error && e.name === "InputError") return { code: "invalid_input", message: e.message };
  return { code: "internal", message: "Unexpected processing error. The details were logged for administrators." };
}

export class InputError extends Error {
  override name = "InputError";
}

export async function recordTextCalls(deps: WorkerDeps, job: GenerationJob, calls: TextCallRecord[]) {
  for (const call of calls) {
    await deps.usage.record({
      provider: call.provider,
      model: call.model,
      operation: job.kind,
      requestId: call.requestId,
      projectId: job.projectId,
      generationJobId: job.id,
      userId: job.userId,
      textInputTokens: call.inputTokens,
      textOutputTokens: call.outputTokens,
      cachedInputTokens: call.cachedTokens,
      rawUsage: call.rawUsage,
      latencyMs: call.latencyMs,
      success: call.success,
      metadata: { purpose: call.purpose, templateName: job.templateName, templateVersion: job.templateVersion },
    });
  }
}

export async function isCancelRequested(deps: WorkerDeps, jobId: string) {
  const [row] = await deps.db
    .select({ status: generationJobs.status })
    .from(generationJobs)
    .where(eq(generationJobs.id, jobId));
  return row?.status === "cancel_requested" || row?.status === "cancelled";
}

/**
 * Shared lifecycle for generation jobs: idempotent start, attempts, cancellation, retry classification,
 * failure recording and SSE broadcasts. Handlers only implement the work.
 */
export async function runGenerationJob(
  deps: WorkerDeps,
  bullJob: Job,
  handler: (job: GenerationJob) => Promise<Record<string, unknown>>,
) {
  const jobId = String(bullJob.data.jobId);
  const log = deps.logger.child({ jobId, queue: bullJob.queueName });
  const [job] = await deps.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  if (!job) {
    log.warn("generation job row missing; dropping");
    return;
  }
  if (job.status === "completed") return job.result;
  if (job.status === "cancelled" || job.status === "paused") return;
  // Parked in a provider batch that is already paid for. Only the batch poller may resurrect it: running the
  // handler here would buy the same panel a second time and the poller would then discard the batched one.
  if (job.status === "submitted") {
    log.info("job is waiting in a provider batch; not running it");
    return;
  }
  if (job.status === "cancel_requested") {
    await finishCancelled(deps, job);
    return;
  }
  // Redelivery of a job that was already running: the process died between the provider call and the completion
  // write (an OOM kill, a deploy, a stalled-job reclaim). If an output row exists the image was produced and paid
  // for, so re-running the handler would buy it a second time — finish from what is already stored instead.
  if (job.status === "processing") {
    const [produced] = await deps.db
      .select()
      .from(generationOutputs)
      .where(eq(generationOutputs.jobId, jobId))
      .orderBy(asc(generationOutputs.outputIndex))
      .limit(1);
    if (produced) {
      const [done] = await deps.db
        .update(generationJobs)
        .set({
          status: "completed",
          finishedAt: new Date(),
          result: { assetId: produced.assetId, recoveredAfterRestart: true, activated: produced.activated },
          failureCode: null,
          failureReason: null,
        })
        .where(eq(generationJobs.id, jobId))
        .returning();
      await publishJob(deps, done!);
      log.warn("recovered a job that had already produced its output", {
        kind: job.kind,
        assetId: produced.assetId,
        // Not activated means the crash landed between storing the asset and attaching it: the version is in the
        // panel's history for the user to activate, and nothing was charged twice.
        activated: produced.activated,
      });
      return done!.result;
    }
    // Nothing to recover from, so this would re-run the work. Only take the job over once its previous runner
    // cannot still be alive: BullMQ renews a running job's lock and redelivers only after it expires (ten minutes
    // on the shortest queue here), so a row written moments ago belongs to a runner that is still working. A
    // second arrival that fast is a duplicate delivery, not a recovery, and running it buys the same work twice.
    const quietMs = Date.now() - (job.updatedAt ?? job.startedAt ?? new Date(0)).getTime();
    if (quietMs < RECLAIM_AFTER_MS) {
      log.info("job is already running elsewhere; not running it twice", { kind: job.kind, quietMs });
      return;
    }
  }

  if (job.batchId && !(job.parameters as { allowOverBudget?: boolean } | null)?.allowOverBudget) {
    const budget = await projectBudget(deps.db, job.projectId);
    if (budget.exceeded) {
      const reason = `project budget of $${budget.limitUsd!.toFixed(2)} reached ($${budget.spentUsd.toFixed(2)} spent)`;
      await deps.db
        .update(generationJobs)
        .set({ status: "paused", failureReason: `Paused: ${reason}` })
        .where(eq(generationJobs.id, jobId));
      await publishJob(deps, { ...job, status: "paused", failureReason: `Paused: ${reason}` });
      await deps.jobs.pauseBatch(job.batchId, reason);
      log.warn("batch paused by budget", { batchId: job.batchId, ...budget });
      return;
    }
  }

  // Claim the job, rather than simply announcing that we are running it. Everything above this line was read
  // from a row that any other runner could also have read: a batch poller republishing a parked job, a stalled-job
  // reclaim, a manual replay. Two readers both seeing "queued" used to mean two handlers, two provider calls and
  // two usage rows for one job. The compare-and-swap is on the exact (status, attempts) that were read, so only
  // the first writer proceeds and the loser leaves the work to whoever won.
  const [started] = await deps.db
    .update(generationJobs)
    .set({
      status: "processing",
      startedAt: job.startedAt ?? new Date(),
      attempts: sql`${generationJobs.attempts} + 1`,
    })
    .where(
      and(
        eq(generationJobs.id, jobId),
        eq(generationJobs.status, job.status),
        eq(generationJobs.attempts, job.attempts),
      ),
    )
    .returning();
  if (!started) {
    log.info("another runner claimed this job first; not running it twice", { kind: job.kind });
    return;
  }
  await publishJob(deps, started);
  if (job.targetType === "panel" && job.targetId) {
    await deps.db.update(panels).set({ status: "generating" }).where(eq(panels.id, job.targetId));
    await deps.events.publish(job.projectId, {
      type: "panel.updated",
      panelId: job.targetId,
      pageId: String(job.input.pageId ?? ""),
      status: "generating",
    });
  }

  const t0 = performance.now();
  try {
    const result = await handler(started!);
    const [done] = await deps.db
      .update(generationJobs)
      .set({
        status: "completed",
        finishedAt: new Date(),
        result,
        latencyMs: Math.round(performance.now() - t0),
        failureCode: null,
        failureReason: null,
      })
      .where(eq(generationJobs.id, jobId))
      .returning();
    await publishJob(deps, done!);
    log.info("generation completed", {
      kind: job.kind,
      latencyMs: Math.round(performance.now() - t0),
      providerRequestId: done?.providerRequestId,
    });
    return result;
  } catch (e) {
    if (e instanceof JobCancelledError) {
      await finishCancelled(deps, started!);
      return;
    }
    if (e instanceof StructuredOutputError) await recordTextCalls(deps, started!, e.calls).catch(() => {});
    // A provider that answered and charged for an unusable response (an HTTP 200 with no image) reports what it
    // billed on the error; without this the money is spent and invisible, and the retry spends it again.
    if (e instanceof ProviderError && e.usage)
      await deps.usage
        .record({
          provider: job.provider ?? e.provider,
          model: job.model ?? "unknown",
          operation: job.kind,
          projectId: job.projectId,
          generationJobId: job.id,
          userId: job.userId,
          requestId: e.requestId,
          ...e.usage,
          success: false,
          metadata: { failureCode: e.code, templateName: job.templateName, templateVersion: job.templateVersion },
        })
        .catch(() => {});
    const { code, message } = userFacingError(e);
    // Measured across 50 projects: every content_policy and invalid_json failure succeeded on a plain manual
    // retry (the filter is nondeterministic, and the repair path just needs another sample), so they use their
    // attempt budget instead of failing the job on the first try.
    const RETRY_ANYWAY: string[] = ["content_policy", "invalid_json", "invalid_response"];
    // ...except when the provider named what it objected to. `safety_violations=[self-harm]` is a verdict on the
    // prompt, not a sampling accident: it repeats identically on every attempt, so retrying only spends the
    // budget and the money three times over to arrive at the same refusal.
    const categories = code === "content_policy" ? policyCategories(e instanceof Error ? e.message : String(e)) : [];
    const retryable =
      (e instanceof ProviderError && e.retryable) || (RETRY_ANYWAY.includes(code) && categories.length === 0);
    const attemptsLeft = bullJob.attemptsMade + 1 < (bullJob.opts.attempts ?? 1);
    const requestId = e instanceof ProviderError ? e.requestId : undefined;
    log.error("generation failed", {
      kind: job.kind,
      code,
      retryable,
      attemptsLeft,
      ...(categories.length ? { policyCategories: categories } : {}),
      error: e instanceof Error ? e.message : String(e),
      providerRequestId: requestId,
    });
    if (retryable && attemptsLeft) {
      const [row] = await deps.db
        .update(generationJobs)
        .set({
          status: "queued",
          failureCode: code,
          failureReason: `${message} Retrying…`,
          providerRequestId: requestId ?? job.providerRequestId,
        })
        .where(eq(generationJobs.id, jobId))
        .returning();
      if (job.targetType === "panel" && job.targetId)
        await deps.db.update(panels).set({ status: "queued" }).where(eq(panels.id, job.targetId));
      await publishJob(deps, row!);
      throw e;
    }
    const [row] = await deps.db
      .update(generationJobs)
      .set({
        status: "failed",
        finishedAt: new Date(),
        failureCode: code,
        failureReason: message,
        providerRequestId: requestId ?? job.providerRequestId,
        latencyMs: Math.round(performance.now() - t0),
      })
      .where(eq(generationJobs.id, jobId))
      .returning();
    if (job.targetType === "panel" && job.targetId) {
      const [pn] = await deps.db.select().from(panels).where(eq(panels.id, job.targetId));
      if (pn) {
        await deps.db
          .update(panels)
          .set({ status: pn.activeArtworkAssetId ? "ready" : "failed" })
          .where(eq(panels.id, pn.id));
        await deps.events.publish(job.projectId, {
          type: "panel.updated",
          panelId: pn.id,
          pageId: pn.pageId,
          status: pn.activeArtworkAssetId ? "ready" : "failed",
        });
      }
    }
    await publishJob(deps, row!);
    // A rejected key or exhausted quota will fail every remaining job the same way: pause the batch and ask.
    if (job.batchId && (code === "auth" || code === "quota")) {
      const paused = await deps.jobs.pauseBatch(
        job.batchId,
        `provider ${code === "auth" ? "rejected the API key" : "quota or billing limit reached"}`,
      );
      if (paused) log.warn("batch paused after provider failure", { batchId: job.batchId, code, paused });
    }
    if (code === "internal")
      await recordError(deps.db, {
        source: "worker",
        code,
        message: e instanceof Error ? `${e.message}\n${e.stack ?? ""}` : String(e),
        jobId,
      });
    throw new UnrecoverableError(message);
  }
}

async function finishCancelled(deps: WorkerDeps, job: GenerationJob) {
  const [row] = await deps.db
    .update(generationJobs)
    .set({ status: "cancelled", finishedAt: new Date() })
    .where(eq(generationJobs.id, job.id))
    .returning();
  if (job.targetType === "panel" && job.targetId) {
    const [pn] = await deps.db.select().from(panels).where(eq(panels.id, job.targetId));
    if (pn && (pn.status === "generating" || pn.status === "queued")) {
      await deps.db
        .update(panels)
        .set({ status: pn.activeArtworkAssetId ? "ready" : "planned" })
        .where(eq(panels.id, pn.id));
      await deps.events.publish(job.projectId, {
        type: "panel.updated",
        panelId: pn.id,
        pageId: pn.pageId,
        status: pn.activeArtworkAssetId ? "ready" : "planned",
      });
    }
  }
  await publishJob(deps, row!);
}

export async function publishJob(deps: WorkerDeps, j: GenerationJob | undefined) {
  // The row can be gone by the time we publish: a deleted description, a project removed mid-run. Every caller
  // reaches here through an `update(...).returning()` that then yields nothing, so guard once, here.
  if (!j) return;
  await deps.events.publish(j.projectId, {
    type: "job.updated",
    jobId: j.id,
    kind: j.kind,
    status: j.status,
    targetType: j.targetType,
    targetId: j.targetId,
    batchId: j.batchId,
    failureReason: j.failureReason,
    // A plan that declined to replace existing pages completes without applying anything; without this the
    // client sees a plain "completed" and cannot tell the difference from a plan that took effect.
    applied: (j.result as { applied?: boolean } | null)?.applied ?? null,
  });
}
