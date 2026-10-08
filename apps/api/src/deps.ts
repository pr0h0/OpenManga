import { AuthService } from "@openmanga/auth";
import { type AppConfig, PublicUrlService } from "@openmanga/config";
import { createDb } from "@openmanga/db";
import { createLogger } from "@openmanga/logger";
import { DevMailProvider } from "@openmanga/mail";
import { BullJobQueue, createRedis, EventBus, OutboxDispatcher } from "@openmanga/queue";
import {
  AssetService,
  CredentialService,
  createTTSProvider,
  createYouTubeClient,
  GenerationPlanner,
  JobService,
  ProviderResolver,
  providerInfo,
  UsageService,
  YouTubeService,
} from "@openmanga/services";
import { createAssetStorage } from "@openmanga/storage";
import type { Deps } from "./context.ts";

export function buildDeps(config: AppConfig): Deps & { close(): Promise<void> } {
  const logger = createLogger({ service: "api" }, config.LOG_LEVEL);
  const { db, client } = createDb(config.DATABASE_URL, { max: 20 });
  const redis = createRedis(config.REDIS_URL);
  const queue = new BullJobQueue(createRedis(config.REDIS_URL, true));
  const events = new EventBus(redis);
  const dispatcher = new OutboxDispatcher(db, queue, logger);
  const storage = createAssetStorage(config);
  const assets = new AssetService(db, storage, config);
  const jobs = new JobService(db, { queue, dispatcher, events });
  const providers = providerInfo(config);
  const credentials = new CredentialService(db, config);
  const resolver = new ProviderResolver(config, credentials, logger);
  const urls = new PublicUrlService({
    appUrl: config.APP_PUBLIC_URL,
    apiUrl: config.API_PUBLIC_URL,
    cdnUrl: config.CDN_PUBLIC_URL,
  });
  return {
    config,
    db,
    redis,
    logger,
    urls,
    auth: new AuthService(db, { secret: config.SESSION_SECRET, sessionTtlDays: config.SESSION_TTL_DAYS }),
    mail: new DevMailProvider(db, logger),
    queue,
    dispatcher,
    events,
    assets,
    usage: new UsageService(db),
    jobs,
    planner: new GenerationPlanner(db, assets, jobs, providers.image, resolver),
    credentials,
    resolver,
    tts: createTTSProvider(config),
    youtube: new YouTubeService(db, createYouTubeClient(config, urls), credentials.ring, config, logger),
    providers,
    async close() {
      await queue.close().catch(() => {});
      redis.disconnect();
      await client.end({ timeout: 5 });
    },
  };
}
