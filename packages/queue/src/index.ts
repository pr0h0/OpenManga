import { type Database, type DbOrTx, outbox, sql } from "@openmanga/db";
import type { Logger } from "@openmanga/logger";
import { type Job, Queue, type QueueEvents, Worker, type WorkerOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";

/** BullMQ key namespace. Everything that touches these queues must use it, including schedulers. */
export const QUEUE_PREFIX = "om";

export const QUEUES = [
  "text-ai",
  "image-generation",
  "image-edit",
  "asset-processing",
  "tts",
  "export",
  "maintenance",
  /** Submits provider batches: one job collects many panels into one submission, then parks them. */
  "image-batch",
] as const;
export type QueueName = (typeof QUEUES)[number];

export type EnqueueOptions = { jobId: string; priority?: number; attempts?: number; delayMs?: number };

export interface JobQueue {
  enqueue(queue: QueueName, name: string, payload: Record<string, unknown>, opts: EnqueueOptions): Promise<void>;
  /** Remove a job that has not started. Returns true if it was removed. */
  removeWaiting(queue: QueueName, jobId: string): Promise<boolean>;
  /** Whether Redis still holds this job (any state). */
  has(queue: QueueName, jobId: string): Promise<boolean>;
  /** BullMQ's state for this job ("active", "waiting", "prioritized", …), or null if Redis has no such job. */
  state(queue: QueueName, jobId: string): Promise<string | null>;
  counts(): Promise<Record<QueueName, Record<string, number>>>;
  close(): Promise<void>;
}

export function createRedis(url: string, forWorker = false): Redis {
  return new IORedis(url, { maxRetriesPerRequest: forWorker ? null : 3, enableReadyCheck: true, lazyConnect: false });
}

export class BullJobQueue implements JobQueue {
  private queues = new Map<QueueName, Queue>();
  constructor(private readonly connection: Redis) {}

  queue(name: QueueName) {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: this.connection, prefix: QUEUE_PREFIX });
      this.queues.set(name, q);
    }
    return q;
  }

  async enqueue(queue: QueueName, name: string, payload: Record<string, unknown>, opts: EnqueueOptions) {
    await this.queue(queue).add(name, payload, {
      jobId: opts.jobId,
      priority: opts.priority,
      attempts: opts.attempts ?? 3,
      delay: opts.delayMs,
      backoff: { type: "exponential", delay: 5000, jitter: 0.5 },
      removeOnComplete: { age: 7 * 24 * 3600, count: 5000 },
      removeOnFail: { age: 30 * 24 * 3600, count: 1000 },
    });
  }

  async removeWaiting(queue: QueueName, jobId: string) {
    const job = await this.queue(queue).getJob(jobId);
    if (!job) return true;
    const state = await job.getState();
    if (state === "active" || state === "completed") return false;
    try {
      await job.remove();
      return true;
    } catch {
      return false;
    }
  }

  async has(queue: QueueName, jobId: string) {
    return Boolean(await this.queue(queue).getJob(jobId));
  }

  async state(queue: QueueName, jobId: string) {
    const job = await this.queue(queue).getJob(jobId);
    return job ? await job.getState() : null;
  }

  async counts() {
    const out = {} as Record<QueueName, Record<string, number>>;
    for (const name of QUEUES)
      out[name] = await this.queue(name).getJobCounts(
        "waiting",
        "active",
        "delayed",
        "failed",
        "completed",
        "prioritized",
        "paused",
      );
    return out;
  }

  async close() {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

export function createWorker(
  name: QueueName,
  connection: Redis,
  processor: (job: Job) => Promise<unknown>,
  opts: Partial<WorkerOptions> = {},
) {
  return new Worker(name, processor, { connection, prefix: QUEUE_PREFIX, concurrency: 1, ...opts });
}

/** Insert an outbox row inside the caller's transaction. Publishing happens after commit. */
export async function addToOutbox(
  tx: DbOrTx,
  row: { queue: QueueName; jobName: string; jobId: string; payload: Record<string, unknown>; priority?: number },
) {
  await tx
    .insert(outbox)
    .values({
      queue: row.queue,
      jobName: row.jobName,
      jobId: row.jobId,
      payload: row.payload,
      priority: row.priority ?? 5,
    })
    .onConflictDoNothing();
}

/**
 * Publishes pending outbox rows to Redis. Safe to run concurrently (SKIP LOCKED) and idempotent
 * (BullMQ dedupes by jobId), so a crash between publish and mark just republishes the same jobId.
 */
export class OutboxDispatcher {
  constructor(
    private readonly db: Database,
    private readonly queue: JobQueue,
    private readonly logger?: Logger,
  ) {}

  async flush(limit = 100): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.execute<{
        id: string;
        queue: QueueName;
        job_name: string;
        job_id: string;
        payload: Record<string, unknown>;
        priority: number;
      }>(
        sql`select id, queue, job_name, job_id, payload, priority from outbox where status = 'pending' order by created_at limit ${limit} for update skip locked`,
      );
      let published = 0;
      for (const r of rows) {
        try {
          await this.queue.enqueue(r.queue, r.job_name, r.payload, { jobId: r.job_id, priority: r.priority });
          await tx.execute(
            sql`update outbox set status = 'published', published_at = now(), attempts = attempts + 1 where id = ${r.id}`,
          );
          published++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await tx.execute(sql`update outbox set attempts = attempts + 1, last_error = ${msg} where id = ${r.id}`);
          this.logger?.error("outbox publish failed", { outboxId: r.id, jobId: r.job_id, error: msg });
        }
      }
      return published;
    });
  }

  start(intervalMs = 1000) {
    let stopped = false;
    let running = false;
    const timer = setInterval(async () => {
      if (stopped || running) return;
      running = true;
      try {
        await this.flush();
      } catch (e) {
        this.logger?.error("outbox loop error", { error: e instanceof Error ? e.message : String(e) });
      } finally {
        running = false;
      }
    }, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }
}

export type AppEvent =
  | {
      type: "job.updated";
      jobId: string;
      kind: string;
      status: string;
      targetType?: string | null;
      targetId?: string | null;
      batchId?: string | null;
      failureReason?: string | null;
      /** False when a completed job deliberately applied nothing (a plan that would not replace existing pages). */
      applied?: boolean | null;
    }
  | { type: "panel.updated"; panelId: string; pageId: string; status: string; activeArtworkAssetId?: string | null }
  | { type: "reference.updated"; subjectType: string; subjectVersionId: string; assetId: string }
  | { type: "analysis.updated"; analysisId: string; status: string }
  | { type: "chapter.updated"; chapterId: string }
  | { type: "audio.updated"; segmentId: string; status: string; audioJobId: string; failureReason?: string | null }
  | { type: "export.updated"; exportJobId: string; status: string; progress: number; failureReason?: string | null }
  | { type: "narration.updated"; chapterId: string };

const channel = (projectId: string) => `om:events:project:${projectId}`;

export class EventBus {
  constructor(private readonly pub: Redis) {}

  async publish(projectId: string, event: AppEvent) {
    await this.pub.publish(channel(projectId), JSON.stringify({ ...event, projectId, at: new Date().toISOString() }));
  }

  /** Each subscription uses a dedicated connection (Redis pub/sub requirement). */
  subscribe(redisUrl: string, projectId: string, onEvent: (json: string) => void) {
    return this.subscribeTo(redisUrl, channel(projectId), onEvent);
  }

  /** A channel of its own, outside any project: an expert chat's reply as it is written. */
  async publishTo(name: string, payload: unknown) {
    await this.pub.publish(name, JSON.stringify(payload));
  }

  subscribeTo(redisUrl: string, name: string, onEvent: (json: string) => void) {
    const sub = createRedis(redisUrl);
    sub.subscribe(name).catch(() => {});
    sub.on("message", (_c, msg) => onEvent(msg));
    return async () => {
      await sub.unsubscribe().catch(() => {});
      sub.disconnect();
    };
  }
}

export { Queue, UnrecoverableError } from "bullmq";
export type { Job, QueueEvents, Redis };
