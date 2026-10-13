import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig } from "@openmanga/config";
import {
  announceWorker,
  type Capability,
  createWorker,
  forgetWorker,
  OutboxDispatcher,
  parseWorkerQueues,
  QUEUE_PREFIX,
  Queue,
  type QueueName,
  servableQueues,
  type WorkerInfo,
  workerCapabilities,
} from "@openmanga/queue";
import { buildWorkerDeps } from "./deps.ts";
import {
  assetProcessor,
  exportProcessor,
  generationProcessor,
  maintenanceProcessor,
  ttsProcessor,
} from "./processors.ts";

const config = getConfig();
const { deps, redis, close } = buildWorkerDeps(config);
const log = deps.logger;
// What this machine can do decides which of its queues it takes: a queue it cannot serve waits for a worker that can.
const detected: Capability[] = [
  ...(Bun.which("ffmpeg") && Bun.which("ffprobe") ? (["ffmpeg"] as const) : []),
  ...(config.TTS_ENABLED ? (["tts"] as const) : []),
];
const capabilities = workerCapabilities(config.WORKER_CAPABILITIES, detected);
const { consumed, refused } = servableQueues(parseWorkerQueues(config.WORKER_QUEUES), capabilities);
for (const r of refused) log.warn("worker leaves a queue it cannot serve", { queue: r.queue, missing: r.missing });
await mkdir(config.TEMP_ROOT, { recursive: true }).catch(() => {});

// Separate queues + concurrency per provider so text planning never blocks image generation.
const gen = generationProcessor(deps);
const exports = exportProcessor(deps);
const start: Record<QueueName, () => ReturnType<typeof createWorker>> = {
  "text-ai": () => createWorker("text-ai", redis, gen, { concurrency: config.TEXT_WORKER_CONCURRENCY }),
  "image-generation": () =>
    createWorker("image-generation", redis, gen, {
      concurrency: config.IMAGE_WORKER_CONCURRENCY,
      lockDuration: 10 * 60_000,
    }),
  "image-edit": () =>
    createWorker("image-edit", redis, gen, {
      concurrency: config.IMAGE_EDIT_WORKER_CONCURRENCY,
      lockDuration: 10 * 60_000,
    }),
  tts: () =>
    createWorker("tts", redis, ttsProcessor(deps), {
      concurrency: config.TTS_WORKER_CONCURRENCY,
      lockDuration: 10 * 60_000,
    }),
  // The processor takes any export kind, so renders and imports queued here before the `render` queue existed
  // still run after an upgrade.
  export: () =>
    createWorker("export", redis, exports, {
      concurrency: config.EXPORT_WORKER_CONCURRENCY,
      lockDuration: 30 * 60_000,
    }),
  render: () =>
    createWorker("render", redis, exports, {
      concurrency: config.RENDER_WORKER_CONCURRENCY,
      lockDuration: 30 * 60_000,
    }),
  "asset-processing": () => createWorker("asset-processing", redis, assetProcessor(deps), { concurrency: 2 }),
  // One at a time, with a long lock: a submit reads every panel's references and uploads them.
  "image-batch": () => createWorker("image-batch", redis, gen, { concurrency: 1, lockDuration: 30 * 60_000 }),
  maintenance: () => createWorker("maintenance", redis, maintenanceProcessor(deps), { concurrency: 1 }),
  // A clip polls its provider for minutes; the lock is renewed while it runs.
  "video-generation": () =>
    createWorker("video-generation", redis, gen, {
      concurrency: config.VIDEO_WORKER_CONCURRENCY,
      lockDuration: 10 * 60_000,
    }),
};
const workers = consumed.map((q) => start[q]());
for (const w of workers) {
  w.on("failed", (job, err) =>
    log.warn("queue job failed", {
      queue: w.name,
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      error: err.message,
    }),
  );
  w.on("error", (err) => log.error("worker error", { queue: w.name, error: err.message }));
}

// Transactional outbox publisher + reconciliation loop.
const dispatcher = new OutboxDispatcher(deps.db, deps.queue, log);
const stopOutbox = dispatcher.start(1000);

// Redis loss recovery: re-publish queued jobs whose Redis entry vanished (startup + every 5 min).
const reconcile = async () => {
  const r = await deps.jobs.reconcileQueue().catch((e) => {
    log.error("queue reconcile failed", { error: e instanceof Error ? e.message : String(e) });
    return { republished: 0 };
  });
  if (r.republished) log.warn("re-published jobs missing from Redis", r);
};
setTimeout(() => void reconcile(), 15_000);
const reconcileTimer = setInterval(() => void reconcile(), 5 * 60_000);
// Liveness file for the container health check. Container-local rather than in the shared TEMP_ROOT volume, so a
// second worker container (a render-only one) cannot keep a dead one looking healthy.
const self: WorkerInfo = {
  id: `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`,
  host: hostname(),
  queues: consumed,
  capabilities,
  refused,
  version: (() => {
    try {
      return (JSON.parse(readFileSync("build-info.json", "utf8")) as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  })(),
  startedAt: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
};
// Liveness for the container health check, and the worker's entry in the registry Admin reads.
const heartbeat = () => {
  void Bun.write(join(tmpdir(), "worker-heartbeat"), String(Date.now())).catch(() => {});
  void announceWorker(redis, { ...self, lastSeen: new Date().toISOString() }).catch(() => {});
};
heartbeat();
const heartbeatTimer = setInterval(heartbeat, 30_000);

const maintenance = new Queue("maintenance", { connection: redis, prefix: QUEUE_PREFIX });
await maintenance.upsertJobScheduler(
  "hourly-cleanup",
  { every: 3600_000 },
  { name: "cleanup", data: {}, opts: { priority: 10, attempts: 1 } },
);

await maintenance.upsertJobScheduler(
  "batch-poll",
  { every: config.BATCH_POLL_INTERVAL_SECONDS * 1000 },
  { name: "batch-poll", data: {}, opts: { priority: 9, attempts: 1 } },
);

await maintenance.upsertJobScheduler(
  "youtube-hourly",
  { every: 3600_000 },
  { name: "youtube", data: {}, opts: { priority: 9, attempts: 1 } },
);

log.info("worker started", {
  mockMode: config.AI_MOCK_MODE,
  textProvider: deps.text?.provider ?? "byok",
  imageProvider: deps.image?.provider ?? "byok",
  tts: deps.tts?.provider ?? "disabled",
  queues: consumed,
  capabilities,
  concurrency: {
    image: config.IMAGE_WORKER_CONCURRENCY,
    text: config.TEXT_WORKER_CONCURRENCY,
    tts: config.TTS_WORKER_CONCURRENCY,
  },
});

const shutdown = async (signal: string) => {
  log.info("worker shutting down", { signal });
  stopOutbox();
  clearInterval(reconcileTimer);
  clearInterval(heartbeatTimer);
  await forgetWorker(redis, self.id).catch(() => {});
  await Promise.allSettled(workers.map((w) => w.close()));
  await maintenance.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
