import { z } from "zod";

const bool = z
  .union([z.boolean(), z.string()])
  .transform((v) => (typeof v === "boolean" ? v : ["1", "true", "yes", "on"].includes(v.toLowerCase())));

const int = (def: number) => z.coerce.number().int().default(def);

const EnvSchema = z.object({
  /** Defaults to production: the relaxed modes (insecure cookies, the dev mailbox) have to be asked for. */
  NODE_ENV: z.enum(["development", "test", "production"]).default("production"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),

  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),

  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  /** 32 bytes (hex or base64) for encrypting user API keys; derived from SESSION_SECRET when empty. */
  CREDENTIALS_ENCRYPTION_KEY: z.string().optional().default(""),
  /** Comma-separated previous keys, still accepted for decryption while credentials are re-encrypted. */
  CREDENTIALS_ENCRYPTION_OLD_KEYS: z.string().optional().default(""),
  SESSION_TTL_DAYS: int(30),
  /** Empty means unset (compose always defines the variable), so it falls back to "secure in production". */
  COOKIE_SECURE: z.preprocess((v) => (v === "" ? undefined : v), bool.optional()),

  AI_MOCK_MODE: bool.default(false),
  /**
   * Default ceiling on the whole server's AI spend per calendar month (UTC), in USD. Empty means none. An admin can
   * override it in Admin → Usage; the stored value wins over this one.
   */
  INSTANCE_BUDGET_USD_MONTHLY: z.preprocess((v) => (v === "" ? undefined : v), z.coerce.number().min(0).optional()),
  /**
   * Development only: lets an `openai_compatible` credential point at a private address, which is how the bundled
   * `mock-ai` service is reached. Leave false on anything reachable from the internet — it is the check that stops
   * a saved endpoint from being aimed at cloud metadata or a neighbouring container.
   */
  AI_ALLOW_PRIVATE_BASE_URLS: bool.default(false),
  AI_MOCK_ALLOW_IN_PRODUCTION: bool.default(false),

  // No server-level provider keys: every text/image run uses a key the user added (BYOK). The only
  // server-side AI path is AI_MOCK_MODE (in-process fakes) and local Kokoro TTS.
  /** Applied to BYOK providers built per run. */
  AI_TEXT_TIMEOUT_MS: int(900_000),
  AI_TEXT_MAX_CONCURRENCY: int(4),
  AI_IMAGE_TIMEOUT_MS: int(300_000),
  AI_IMAGE_MAX_CONCURRENCY: int(8),
  /** Default image quality and the candidate sizes offered to image providers. */
  IMAGE_QUALITY: z.enum(["low", "medium", "high", "auto"]).default("low"),
  // ~2 MP candidates; at quality low gpt-image-2 bills these no more than 1024x1024 (except 1408x1408, +30%).
  IMAGE_SIZES: z.string().default("2048x1152,1152x2048,1792x1024,1024x1792,1536x1024,1024x1536,1408x1408"),

  REFERENCE_MAX_WIDTH: int(192),
  REFERENCE_MAX_HEIGHT: int(288),
  /** Flat-rate image providers (Meta Muse bills per image, not input tokens): references can be much larger. */
  FLAT_RATE_REFERENCE_MAX_WIDTH: int(768),
  FLAT_RATE_REFERENCE_MAX_HEIGHT: int(1152),
  REFERENCE_FIT: z.enum(["inside", "cover", "contain"]).default("inside"),
  REFERENCE_ALLOW_UPSCALE: bool.default(false),
  REFERENCE_FORMAT: z.enum(["webp", "png", "jpeg"]).default("webp"),
  REFERENCE_QUALITY: int(85),

  /** Where asset files live: `local` (ASSET_ROOT, served by nginx) or `s3` (any S3-compatible bucket). */
  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  ASSET_ROOT: z.string().default("/data/assets"),
  /** Empty for AWS; e.g. `http://minio:9000` or `https://<account>.r2.cloudflarestorage.com`. Without the bucket. */
  S3_ENDPOINT: z.string().default(""),
  /** The endpoint browsers download from, when the server reaches the bucket under another name. Default: S3_ENDPOINT. */
  S3_PUBLIC_ENDPOINT: z.string().default(""),
  S3_BUCKET: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  /** Only for temporary credentials (STS, an assumed IAM role); they stop working when the token expires. */
  S3_SESSION_TOKEN: z.string().default(""),
  /** `https://endpoint/bucket/key` instead of `https://bucket.endpoint/key`. MinIO usually needs true. */
  S3_FORCE_PATH_STYLE: bool.default(false),
  /** Prepended to every object key, e.g. `openmanga/`, to share a bucket. */
  S3_PREFIX: z.string().default(""),
  /** Lifetime of the signed download URLs `/cdn` redirects to. */
  S3_PRESIGN_EXPIRES_SECONDS: z.coerce.number().int().min(60).max(604_800).default(900),
  TEMP_ROOT: z.string().default("/data/tmp"),
  UPLOAD_MAX_BYTES: int(15 * 1024 * 1024),
  /**
   * Project import ceilings. The package is streamed to disk, so these bound disk and time rather than memory.
   * Packages run about 4.3 MB per panel, so 4 GB covers a very large project. If you raise this, raise
   * `client_max_body_size` on the import route in `deploy/nginx/default.conf` to match, or nginx rejects the
   * upload before the app sees it.
   */
  IMPORT_MAX_UPLOAD_MB: int(4096),
  IMPORT_MAX_ENTRY_MB: int(512),
  /** Uncompressed-to-compressed ceiling; a legitimate package measures 1.0, a zip bomb is orders of magnitude up. */
  IMPORT_MAX_COMPRESSION_RATIO: z.coerce.number().min(1.5).max(100).default(5),

  TTS_ENABLED: bool.default(true),
  TTS_PROVIDER: z.enum(["kokoro", "fake"]).default("kokoro"),
  KOKORO_URL: z.string().default("http://kokoro:8000"),
  KOKORO_DEFAULT_VOICE: z.string().default("af_heart"),
  KOKORO_DEFAULT_SPEED: z.coerce.number().default(1.0),
  NARRATION_SEGMENT_MAX_CHARS: int(400),

  APP_PUBLIC_URL: z.string().url().default("http://localhost:3480/app"),
  API_PUBLIC_URL: z.string().url().default("http://localhost:3480/api"),
  CDN_PUBLIC_URL: z.string().url().default("http://localhost:3480/cdn"),

  /** Off by default: a self-hosted instance opens registration deliberately, or creates users with `bun admin:create`. */
  REGISTRATION_ENABLED: bool.default(false),
  DEV_MAILBOX_ENABLED: bool.default(false),
  API_DOCS_ENABLED: bool.default(false),

  INITIAL_ADMIN_USERNAME: z.string().optional(),
  INITIAL_ADMIN_EMAIL: z.string().optional(),
  INITIAL_ADMIN_PASSWORD: z.string().optional(),

  IMAGE_WORKER_CONCURRENCY: int(24),
  IMAGE_EDIT_WORKER_CONCURRENCY: int(6),
  TEXT_WORKER_CONCURRENCY: int(4),
  /** Match KOKORO_WORKERS: more worker concurrency than Kokoro processes only queues requests at Kokoro. */
  TTS_WORKER_CONCURRENCY: int(4),
  /** Trim leading/trailing silence from synthesized segments (TTS voices pad ~0.3s/0.7s, which stacks at every cut). */
  TTS_TRIM_SILENCE: bool.default(true),
  TTS_TRIM_THRESHOLD_DB: z.coerce.number().min(-90).max(-10).default(-45),
  TTS_TRIM_KEEP_MS: int(25),
  EXPORT_WORKER_CONCURRENCY: int(1),
  /** Video renders and imports, on their own `render` queue. Each render already encodes VIDEO_ENCODE_CONCURRENCY clips. */
  RENDER_WORKER_CONCURRENCY: int(1),
  /**
   * Comma-separated queues this worker consumes; empty means all. Lets a second worker container take only `render`
   * (see docs/DEPLOYMENT.md). Every worker still runs the outbox publisher and the Redis reconcile loop.
   */
  WORKER_QUEUES: z.string().default(""),
  /** Page clips a video export renders/encodes in parallel (each ffmpeg is roughly one core at veryfast). */
  VIDEO_ENCODE_CONCURRENCY: int(4),
  /**
   * Per-model ceiling on input tokens queued in OpenAI batches at once. Org-specific (the Platform settings page
   * shows yours), so it is configured rather than assumed; a batch past the ceiling is rejected whole, and the
   * submitter keeps 20% headroom under this figure.
   */
  OPENAI_BATCH_MAX_ENQUEUED_TOKENS: int(1_000_000),
  /**
   * Most provider batches one key may have in flight per model at once; more chunks wait as "waiting for room"
   * and go as earlier ones finish, instead of being submitted and refused over the provider's enqueued limit.
   * 0 = no limit. Images are the heavy ones (four 80%-of-limit chunks already overshoot a 1M-token queue).
   */
  BATCH_MAX_IN_FLIGHT_IMAGE: int(4),
  BATCH_MAX_IN_FLIGHT_TEXT: int(16),
  /** Poll interval for submitted provider batches. They target 24h, so there is nothing to gain from seconds. */
  BATCH_POLL_INTERVAL_SECONDS: int(300),
  /**
   * How long a job may go without touching its row before maintenance calls it stalled. Measured from the last
   * write, not from the start, so long work that reports progress is never failed for taking its time — it has to
   * exceed the quietest stretch of a healthy run (the longest is a video export's two-pass loudnorm).
   */
  STALLED_JOB_TIMEOUT_MINUTES: int(120),

  /**
   * MCP server for AI agents (ChatGPT connectors over OAuth, other agents over personal access tokens) at `/mcp`.
   * Every URL below is derived from API_PUBLIC_URL's origin when left empty, which is right for the bundled nginx.
   */
  MCP_ENABLED: bool.default(true),
  /** The MCP resource URL agents connect to, e.g. https://manga.example.com/mcp. Default: <API origin>/mcp. */
  MCP_PUBLIC_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  /** The OAuth issuer (authorization server identifier). Default: the API origin. */
  MCP_AUTH_ISSUER: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  /** Extra Host names accepted on /mcp (comma-separated), e.g. a tunnel's hostname. The public URLs' hosts are always accepted. */
  MCP_ALLOWED_HOSTS: z.string().default(""),
  /** Secret for hashing MCP tokens. Default: derived from SESSION_SECRET with domain separation. */
  MCP_TOKEN_SECRET: z.string().default(""),
  MCP_ACCESS_TOKEN_TTL_MINUTES: int(15),
  MCP_REFRESH_TOKEN_TTL_DAYS: int(30),
  MCP_AUTH_CODE_TTL_SECONDS: int(300),
  /** How long a parked approval request waits for a decision before it expires. */
  MCP_APPROVAL_TTL_MINUTES: int(1440),
  /** A mutation expected to touch more entities than this needs approval under REQUIRE_APPROVAL, even if it is an ordinary write. */
  MCP_BULK_APPROVAL_THRESHOLD: int(25),
  MCP_RATE_LIMIT_PER_MINUTE: int(750),
  /**
   * Allow Client ID Metadata Documents from private, loopback or link-local addresses. Only for local development:
   * the server fetches these URLs, so allowing private addresses in production is an SSRF hole.
   */
  MCP_CIMD_ALLOW_PRIVATE: bool.default(false),

  /**
   * YouTube stats (docs/DEPLOYMENT.md#youtube-stats): the instance's own Google Cloud OAuth client. Both empty turns
   * channel connections off (AI_MOCK_MODE uses a built-in fake Google instead). The redirect URI to register is
   * <API_PUBLIC_URL>/youtube/oauth/callback.
   */
  GOOGLE_OAUTH_CLIENT_ID: z.string().default(""),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().default(""),
  /** Optional: reads public counters of videos on channels nobody connected. Without it a connected channel's token is used. */
  YOUTUBE_API_KEY: z.string().default(""),

  /** Requests to /api per minute for a signed-in user. */
  RATE_LIMIT_PER_MINUTE: int(2000),
  /** Requests to /api per minute from one client address with no session: reader links, sign-in, probes. */
  RATE_LIMIT_ANON_PER_MINUTE: int(300),
  LOGIN_MAX_ATTEMPTS: int(10),

  API_PORT: int(3000),
});

export type AppConfig = z.infer<typeof EnvSchema> & {
  COOKIE_SECURE: boolean;
  devMailboxEnabled: boolean;
  imageSizes: { width: number; height: number }[];
};

export class ConfigError extends Error {}

export function parseConfig(env: Record<string, string | undefined>): AppConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new ConfigError(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  const prod = c.NODE_ENV === "production";

  // The example file ships a placeholder long enough to satisfy min(32); accepting it would mean every BYOK key
  // on the instance is encrypted under a string published in this repository.
  for (const [name, value] of [
    ["SESSION_SECRET", c.SESSION_SECRET],
    ["POSTGRES_PASSWORD", process.env.POSTGRES_PASSWORD ?? ""],
  ] as const)
    if (/^change-me/i.test(value))
      throw new ConfigError(`${name} is still the .env.example placeholder. Generate one: openssl rand -hex 32`);

  if (prod && c.AI_MOCK_MODE && !c.AI_MOCK_ALLOW_IN_PRODUCTION) {
    throw new ConfigError(
      "AI_MOCK_MODE=true is refused in production. Set AI_MOCK_ALLOW_IN_PRODUCTION=true to override explicitly.",
    );
  }
  if (c.STORAGE_DRIVER === "s3") {
    const missing = (["S3_BUCKET", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"] as const).filter((k) => !c[k]);
    if (missing.length) throw new ConfigError(`STORAGE_DRIVER=s3 needs ${missing.join(", ")}`);
    for (const k of ["S3_ENDPOINT", "S3_PUBLIC_ENDPOINT"] as const)
      if (c[k] && !(/^https?:\/\//.test(c[k]) && URL.canParse(c[k])))
        throw new ConfigError(`${k} must be a URL, e.g. https://s3.example.com`);
  }
  if (Boolean(c.GOOGLE_OAUTH_CLIENT_ID) !== Boolean(c.GOOGLE_OAUTH_CLIENT_SECRET))
    throw new ConfigError("GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET are set together, or neither");
  const imageSizes = c.IMAGE_SIZES.split(",").map((s) => {
    const [w, h] = s.trim().split("x").map(Number);
    if (!w || !h) throw new ConfigError(`Invalid IMAGE_SIZES entry: ${s}`);
    return { width: w, height: h };
  });

  return {
    ...c,
    COOKIE_SECURE: c.COOKIE_SECURE ?? prod,
    devMailboxEnabled: c.DEV_MAILBOX_ENABLED,
    imageSizes,
  };
}

let cached: AppConfig | undefined;
export function getConfig(): AppConfig {
  cached ??= parseConfig(process.env);
  return cached;
}

/** Test hook: replace the process config. */
export function setConfig(c: AppConfig) {
  cached = c;
}

export { PublicUrlService } from "./urls.ts";
