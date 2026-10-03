/**
 * Waiting out a provider's batch queue limit. OpenAI caps how many tokens an organisation may have enqueued per
 * model across all its unfinished batches (1M for gpt-image-2 on a low tier), and refuses any batch past it —
 * either on the create call or, more often, by accepting the batch and failing it during validation. Nothing ran
 * and nothing was billed, and the limit clears by itself as earlier batches finish, so the right answer is to
 * wait: the jobs stay `queued` with a time to try again, and the batch poller resubmits them when it comes.
 */
import { and, eq, generationJobs, inArray, isNull, panels, providerBatches, sql } from "@openmanga/db";
import { ProviderError } from "@openmanga/domain";
import type { WorkerDeps } from "../context.ts";
import type { GenerationJob } from "./runner.ts";

/** Minutes between tries: 5, 10, 20, then every 30 until the deadline. */
const WAIT_STEPS_MIN = [5, 10, 20, 30];
/**
 * A batch completes within 24h or expires, so after a day of waiting whatever holds the queue is not a batch of
 * ours finishing — another tool on the same key, or a limit lower than one chunk. Past this the jobs fail.
 */
export const QUEUE_WAIT_DEADLINE_MS = 24 * 3600_000;

export type QueueWait = {
  /** First refusal by the provider; the 24h deadline counts from here. Absent while only held back by our limit. */
  since?: string;
  nextAt: string;
  tries: number;
  reason: string;
  /** Held back by the in-flight limit rather than refused: due at every poll, and never failed for waiting. */
  held?: boolean;
};

export const queueWaitOf = (job: { parameters: Record<string, unknown> }) =>
  job.parameters.queueWait as QueueWait | undefined;

export const isQueueFull = (e: unknown) => e instanceof ProviderError && e.code === "batch_queue_full";

/**
 * Suffix for a chunk's idempotency key. A batch the provider accepted and then refused still exists under its
 * key, so a retry under the same key would find it and adopt the refusal again instead of submitting. Each wait
 * is a new round with its own key; within a round the key is stable, so a crash mid-submit still finds its batch.
 */
export function roundSuffix(jobs: { parameters: Record<string, unknown> }[]) {
  const round = Math.max(0, ...jobs.map((j) => queueWaitOf(j)?.tries ?? 0));
  return round ? `:w${round}` : "";
}

/**
 * Puts jobs the provider had no room for back to `queued`, marked with when to try again, or fails them once
 * they have waited past the deadline. Accepts jobs that are `queued` (refused on submit) or `submitted` (accepted
 * and then refused); anything else — cancelled meanwhile, say — is left alone.
 */
export async function waitForBatchRoom(deps: WorkerDeps, jobs: GenerationJob[], reason: string, now = new Date()) {
  if (!jobs.length) return { waiting: 0, failed: 0, nextAt: null };
  const ids = jobs.map((j) => j.id);
  const earlier = jobs.map(queueWaitOf).filter((w): w is QueueWait & { since: string } => Boolean(w?.since));
  const since = earlier.length ? new Date(Math.min(...earlier.map((w) => Date.parse(w.since)))) : now;
  const tries = Math.max(0, ...earlier.map((w) => w.tries)) + 1;

  if (now.getTime() - since.getTime() >= QUEUE_WAIT_DEADLINE_MS) {
    const message =
      "The provider's batch queue for this model stayed full for 24 hours, so this was never submitted. " +
      "Retry it once your other batches on this key have finished.";
    const failed = await deps.db
      .update(generationJobs)
      .set({ status: "failed", failureCode: "batch_queue_full", failureReason: message, finishedAt: now })
      .where(and(inArray(generationJobs.id, ids), inArray(generationJobs.status, ["queued", "submitted"])))
      .returning();
    const panelIds = failed.filter((j) => j.kind === "panel_generation" && j.targetId).map((j) => j.targetId!);
    if (panelIds.length)
      await deps.db
        .update(panels)
        .set({
          status: sql`case when ${panels.activeArtworkAssetId} is null then 'failed'::panel_status else 'ready'::panel_status end`,
        })
        .where(and(inArray(panels.id, panelIds), inArray(panels.status, ["queued", "generating"])));
    for (const j of failed)
      await deps.events.publish(j.projectId, {
        type: "job.updated",
        jobId: j.id,
        kind: j.kind,
        status: "failed",
        targetType: j.targetType,
        targetId: j.targetId,
        batchId: j.batchId,
        failureReason: message,
      });
    deps.logger.warn("gave up waiting for room in the provider batch queue", { jobs: failed.length });
    return { waiting: 0, failed: failed.length, nextAt: null };
  }

  const step = WAIT_STEPS_MIN[Math.min(tries, WAIT_STEPS_MIN.length) - 1]!;
  const nextAt = new Date(now.getTime() + step * 60_000);
  const wait: QueueWait = {
    since: since.toISOString(),
    nextAt: nextAt.toISOString(),
    tries,
    reason: reason.slice(0, 300),
  };
  const rows = await deps.db
    .update(generationJobs)
    .set({
      status: "queued",
      // The refused batch is finished with; the next round submits these afresh.
      parameters: sql`(${generationJobs.parameters} - 'providerBatchId') || ${JSON.stringify({ queueWait: wait })}::jsonb`,
    })
    .where(and(inArray(generationJobs.id, ids), inArray(generationJobs.status, ["queued", "submitted"])))
    .returning();
  for (const j of rows)
    await deps.events.publish(j.projectId, {
      type: "job.updated",
      jobId: j.id,
      kind: j.kind,
      status: "queued",
      targetType: j.targetType,
      targetId: j.targetId,
      batchId: j.batchId,
    });
  deps.logger.info("provider batch queue full; waiting", { jobs: rows.length, tries, nextAt: wait.nextAt });
  return { waiting: rows.length, failed: 0, nextAt: wait.nextAt };
}

/**
 * Provider batches this user has at the provider for one model and that are still queued or running there: what
 * counts against the provider's enqueued limit.
 */
export async function inFlightBatches(deps: WorkerDeps, userId: string | null, provider: string, model: string) {
  const [row] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(providerBatches)
    .where(
      and(
        userId ? eq(providerBatches.userId, userId) : isNull(providerBatches.userId),
        eq(providerBatches.provider, provider),
        eq(providerBatches.model, model),
        isNull(providerBatches.ingestedAt),
        inArray(providerBatches.state, ["pending", "running"]),
      ),
    );
  return row?.n ?? 0;
}

/**
 * Holds jobs back because this key already has `limit` batches in flight for the model, rather than submitting
 * and being refused. They show as waiting like a refusal does, but the poller retries them on every pass (a slot
 * frees whenever an earlier batch finishes) and they never time out: a run of thirty chunks four at a time is
 * expected to take a while. A refusal's round and first-refusal time are kept.
 */
export async function holdForSlot(
  deps: WorkerDeps,
  jobs: GenerationJob[],
  limit: number,
  now = new Date(),
): Promise<{ waiting: number; failed: number; nextAt: string | null }> {
  if (!jobs.length) return { waiting: 0, failed: 0, nextAt: null };
  const earlier = jobs.map(queueWaitOf).filter((w): w is QueueWait => Boolean(w));
  const since = earlier
    .map((w) => w.since)
    .filter((s): s is string => Boolean(s))
    .sort()[0];
  const wait: QueueWait = {
    ...(since ? { since } : {}),
    // Shown as the next try; the poller runs on this interval.
    nextAt: new Date(now.getTime() + deps.config.BATCH_POLL_INTERVAL_SECONDS * 1000).toISOString(),
    tries: Math.max(0, ...earlier.map((w) => w.tries)),
    reason: `${limit} batch${limit === 1 ? "" : "es"} for this model already in flight on this key`,
    held: true,
  };
  const rows = await deps.db
    .update(generationJobs)
    .set({ parameters: sql`${generationJobs.parameters} || ${JSON.stringify({ queueWait: wait })}::jsonb` })
    .where(
      and(
        inArray(
          generationJobs.id,
          jobs.map((j) => j.id),
        ),
        eq(generationJobs.status, "queued"),
      ),
    )
    .returning({ id: generationJobs.id });
  deps.logger.info("holding batch work for a free slot", { jobs: rows.length, limit });
  return { waiting: rows.length, failed: 0, nextAt: wait.nextAt };
}

/** Jobs of a batch run whose wait is over: what the poller resubmits. */
export async function dueWaitingJobs(deps: WorkerDeps, now = new Date()) {
  return deps.db
    .select()
    .from(generationJobs)
    .where(
      sql`${generationJobs.status} = 'queued' and ${generationJobs.batchId} is not null
        and ${generationJobs.parameters}->>'batchMode' = 'true'
        and (${generationJobs.parameters}->'queueWait'->>'held' = 'true'
          or (${generationJobs.parameters}->'queueWait'->>'nextAt')::timestamptz <= ${now.toISOString()}::timestamptz)`,
    )
    .limit(2000);
}
