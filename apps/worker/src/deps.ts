import { type AppConfig, PublicUrlService } from "@openmanga/config";
import { createDb } from "@openmanga/db";
import { createLogger } from "@openmanga/logger";
import { BullJobQueue, createRedis, EventBus } from "@openmanga/queue";
import {
  AssetService,
  CredentialService,
  createImageProvider,
  createTextProvider,
  createTTSProvider,
  JobService,
  ProviderResolver,
  UsageService,
} from "@openmanga/services";
import { LocalAssetStorage } from "@openmanga/storage";
import type { WorkerDeps } from "./context.ts";

export function buildWorkerDeps(config: AppConfig) {
  const logger = createLogger({ service: "worker" }, config.LOG_LEVEL);
  // One connection per concurrent job plus headroom for the outbox loop and event bookkeeping.
  const poolSize =
    config.IMAGE_WORKER_CONCURRENCY +
    config.IMAGE_EDIT_WORKER_CONCURRENCY +
    config.TEXT_WORKER_CONCURRENCY +
    config.TTS_WORKER_CONCURRENCY +
    config.EXPORT_WORKER_CONCURRENCY +
    config.RENDER_WORKER_CONCURRENCY +
    8;
  const { db, client } = createDb(config.DATABASE_URL, { max: Math.min(80, poolSize) });
  const redis = createRedis(config.REDIS_URL, true);
  const pub = createRedis(config.REDIS_URL);
  const storage = new LocalAssetStorage(config.ASSET_ROOT);
  const queue = new BullJobQueue(redis);
  const events = new EventBus(pub);
  const text = createTextProvider(config);
  const image = createImageProvider(config);
  const tts = createTTSProvider(config);
  const deps: WorkerDeps = {
    config,
    db,
    logger,
    assets: new AssetService(db, storage, config),
    usage: new UsageService(db),
    events,
    queue,
    jobs: new JobService(db, { queue, events }),
    text,
    image,
    resolver: new ProviderResolver(config, new CredentialService(db, config), logger, { text, image, tts }),
    tts,
    urls: new PublicUrlService({
      appUrl: config.APP_PUBLIC_URL,
      apiUrl: config.API_PUBLIC_URL,
      cdnUrl: config.CDN_PUBLIC_URL,
    }),
  };
  return {
    deps,
    redis,
    async close() {
      await deps.queue.close().catch(() => {});
      pub.disconnect();
      redis.disconnect();
      await client.end({ timeout: 5 });
    },
  };
}
