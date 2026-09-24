import type { TTSProvider } from "@openmanga/audio";
import type { AuthService, SessionUser } from "@openmanga/auth";
import type { AppConfig, PublicUrlService } from "@openmanga/config";
import type { Database } from "@openmanga/db";
import type { Logger } from "@openmanga/logger";
import type { MailProvider } from "@openmanga/mail";
import type { EventBus, JobQueue, OutboxDispatcher, Redis } from "@openmanga/queue";
import type {
  AssetService,
  CredentialService,
  GenerationPlanner,
  JobService,
  ProviderResolver,
  UsageService,
} from "@openmanga/services";
import type { ServiceRestriction } from "./mcp/context.ts";

export type Deps = {
  config: AppConfig;
  db: Database;
  redis: Redis;
  logger: Logger;
  urls: PublicUrlService;
  auth: AuthService;
  mail: MailProvider;
  queue: JobQueue;
  dispatcher: OutboxDispatcher;
  events: EventBus;
  assets: AssetService;
  usage: UsageService;
  jobs: JobService;
  planner: GenerationPlanner;
  credentials: CredentialService;
  resolver: ProviderResolver;
  tts: TTSProvider | null;
  providers: {
    /** null unless AI_MOCK_MODE: keys are the user's own (BYOK). */
    image: { provider: string; model: string; quality: string } | null;
    text: { provider: string; model: string } | null;
    tts: { provider: string } | null;
  };
};

export type AppEnv = {
  Variables: {
    deps: Deps;
    requestId: string;
    log: Logger;
    user: SessionUser | null;
    sessionId: string | null;
    /** Set when an MCP connection is acting: its project restriction applies on top of membership. */
    service: ServiceRestriction | null;
  };
};
