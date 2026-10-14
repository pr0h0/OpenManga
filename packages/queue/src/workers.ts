import type { Redis } from "ioredis";
import { QUEUE_PREFIX, QUEUES, type QueueName } from "./index.ts";

/**
 * What a worker can do. `ffmpeg` and `tts` are detected (ffmpeg and ffprobe on the path; narration synthesis on);
 * `gpu` and `comfyui` are declared with WORKER_CAPABILITIES, for machines added to run them.
 */
export const CAPABILITIES = ["ffmpeg", "tts", "gpu", "comfyui"] as const;
export type Capability = (typeof CAPABILITIES)[number];

/** What a queue's jobs need from the worker that takes them. */
export const QUEUE_NEEDS: Partial<Record<QueueName, Capability[]>> = {
  render: ["ffmpeg"],
  // The free model encodes on the worker, and every clip is probed for its length.
  "video-generation": ["ffmpeg"],
  tts: ["tts"],
};

/**
 * The capabilities a worker has: detected ones plus those WORKER_CAPABILITIES declares (comma-separated; `-name`
 * takes one away, e.g. `-ffmpeg` keeps a small machine off video renders even though ffmpeg is installed).
 */
export function workerCapabilities(declared: string, detected: Capability[]): Capability[] {
  const caps = new Set<Capability>(detected);
  for (const raw of declared
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)) {
    const name = raw.replace(/^-/, "");
    if (!(CAPABILITIES as readonly string[]).includes(name))
      throw new Error(`WORKER_CAPABILITIES: unknown capability ${name} (known: ${CAPABILITIES.join(", ")})`);
    if (raw.startsWith("-")) caps.delete(name as Capability);
    else caps.add(name as Capability);
  }
  return CAPABILITIES.filter((c) => caps.has(c));
}

/** Of the queues a worker would take, those it can serve, and the rest with what is missing. */
export function servableQueues(wanted: QueueName[], caps: Capability[]) {
  const have = new Set(caps);
  const consumed: QueueName[] = [];
  const refused: { queue: QueueName; missing: Capability[] }[] = [];
  for (const q of wanted) {
    const missing = (QUEUE_NEEDS[q] ?? []).filter((c) => !have.has(c));
    if (missing.length) refused.push({ queue: q, missing });
    else consumed.push(q);
  }
  return { consumed, refused };
}

export type WorkerInfo = {
  id: string;
  host: string;
  queues: QueueName[];
  capabilities: Capability[];
  refused: { queue: QueueName; missing: Capability[] }[];
  version: string | null;
  startedAt: string;
  lastSeen: string;
};

// Read when called: index.ts re-exports this module, so its constants are not set yet while this one loads.
const key = (id = "") => `${QUEUE_PREFIX}:workers:${id}`;
/** A worker that has not checked in for this long is gone. */
export const WORKER_TTL_SECONDS = 90;

/** A worker says it is alive, what it takes and what it can do; the entry lapses unless renewed. */
export async function announceWorker(redis: Redis, info: WorkerInfo) {
  await redis.set(key(info.id), JSON.stringify(info), "EX", WORKER_TTL_SECONDS);
}

export async function forgetWorker(redis: Redis, id: string) {
  await redis.del(key(id));
}

/** The workers alive now. */
export async function listWorkers(redis: Redis): Promise<WorkerInfo[]> {
  const keys: string[] = [];
  let cursor = "0";
  do {
    const [next, batch] = await redis.scan(cursor, "MATCH", `${key()}*`, "COUNT", 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  if (!keys.length) return [];
  const values = await redis.mget(...keys);
  return values
    .flatMap((v) => (v ? [JSON.parse(v) as WorkerInfo] : []))
    .sort((a, b) => a.host.localeCompare(b.host) || a.id.localeCompare(b.id));
}

/**
 * Queues nothing alive takes: with work waiting, it waits for a worker that can (say why, from what refused it), and
 * with none it only matters once something is queued.
 */
export function uncoveredQueues(workers: WorkerInfo[], counts: Partial<Record<QueueName, Record<string, number>>>) {
  return QUEUES.filter((q) => !workers.some((w) => w.queues.includes(q))).map((q) => {
    const c = counts[q] ?? {};
    const waiting = (c.waiting ?? 0) + (c.prioritized ?? 0) + (c.delayed ?? 0);
    const refusedBy = workers.filter((w) => w.refused.some((r) => r.queue === q));
    return {
      queue: q,
      waiting,
      needs: QUEUE_NEEDS[q] ?? [],
      refusedBy: refusedBy.map((w) => ({ id: w.id, host: w.host })),
    };
  });
}
