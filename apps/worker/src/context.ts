import type { ImageAIProvider } from "@openmanga/ai-image";
import type { TextAIProvider } from "@openmanga/ai-text";
import type { TTSProvider } from "@openmanga/audio";
import type { AppConfig, PublicUrlService } from "@openmanga/config";
import type { Database } from "@openmanga/db";
import type { Logger } from "@openmanga/logger";
import type { EventBus, JobQueue } from "@openmanga/queue";
import type { AssetService, JobService, ProviderResolver, UsageService } from "@openmanga/services";
import type { BatchCollector } from "./lib/text-batch-provider.ts";

export type WorkerDeps = {
  config: AppConfig;
  db: Database;
  logger: Logger;
  assets: AssetService;
  usage: UsageService;
  events: EventBus;
  queue: JobQueue;
  jobs: JobService;
  /** null unless AI_MOCK_MODE: keys are the user's own (BYOK). */
  text: TextAIProvider | null;
  image: ImageAIProvider | null;
  /** Per-job provider (BYOK or model override stored in job.parameters.ai); falls back to text/image. */
  resolver: ProviderResolver;
  tts: TTSProvider | null;
  urls: PublicUrlService;
  /**
   * Set only while a batch submitter is harvesting requests: text handlers then record what they would have sent
   * and park instead of calling the provider. Absent on every ordinary run.
   */
  batchCollector?: BatchCollector;
};
