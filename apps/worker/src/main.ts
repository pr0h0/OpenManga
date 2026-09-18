import { mkdir } from "node:fs/promises";
import { getConfig } from "@openmanga/config";
import { createWorker, OutboxDispatcher, QUEUE_PREFIX, Queue } from "@openmanga/queue";
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
await mkdir(config.TEMP_ROOT, { recursive: true }).catch(() => {});

// Separate queues + concurrency per provider so text planning never blocks image generation.
const gen = generationProcessor(deps);
const workers = [
  createWorker("text-ai", redis, gen, { concurrency: config.TEXT_WORKER_CONCURRENCY }),
  createWorker("image-generation", redis, gen, {
    concurrency: config.IMAGE_WORKER_CONCURRENCY,
    lockDuration: 10 * 60_000,
  }),
  createWorker("image-edit", redis, gen, {
    concurrency: config.IMAGE_EDIT_WORKER_CONCURRENCY,
    lockDuration: 10 * 60_000,
  }),
  createWorker("tts", redis, ttsProcessor(deps), {
    concurrency: config.TTS_WORKER_CONCURRENCY,
    lockDuration: 10 * 60_000,
  }),
  createWorker("export", redis, exportProcessor(deps), {
    concurrency: config.EXPORT_WORKER_CONCURRENCY,
    lockDuration: 30 * 60_000,
  }),
  createWorker("asset-processing", redis, assetProcessor(deps), { concurrency: 2 }),
  // One at a time, with a long lock: a submit reads every panel's references and uploads them.
  createWorker("image-batch", redis, gen, { concurrency: 1, lockDuration: 30 * 60_000 }),
  createWorker("maintenance", redis, maintenanceProcessor(deps), { concurrency: 1 }),
];
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
// Liveness file for the container health check.
const heartbeat = () => void Bun.write(`${config.TEMP_ROOT}/worker-heartbeat`, String(Date.now())).catch(() => {});
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

log.info("worker started", {
  mockMode: config.AI_MOCK_MODE,
  textProvider: deps.text?.provider ?? "byok",
  imageProvider: deps.image?.provider ?? "byok",
  tts: deps.tts?.provider ?? "disabled",
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
  await Promise.allSettled(workers.map((w) => w.close()));
  await maintenance.close();
  await close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
