export type ProviderErrorCode =
  | "timeout"
  | "rate_limited"
  | "server_error"
  | "network"
  | "auth"
  | "quota"
  | "invalid_request"
  | "content_policy"
  | "invalid_response"
  | "invalid_json"
  | "offline"
  | "model_loading"
  | "synthesis_error"
  | "cancelled"
  /** The provider refused a batch because the account already has as much batch work queued as it allows. */
  | "batch_queue_full";

const RETRYABLE: ProviderErrorCode[] = [
  "timeout",
  "rate_limited",
  "server_error",
  "network",
  "invalid_response",
  "offline",
  "model_loading",
];

const USER_MESSAGES: Record<ProviderErrorCode, string> = {
  timeout: "The AI provider took too long to respond. The job will be retried.",
  rate_limited: "The AI provider is rate limiting requests. The job will be retried shortly.",
  server_error: "The AI provider had a temporary server error.",
  network: "Could not reach the AI provider (network error).",
  auth: "The AI provider rejected our credentials. An administrator must check the API key.",
  quota: "The AI provider account has insufficient balance or quota.",
  invalid_request: "The AI provider rejected the request as invalid.",
  content_policy: "The request was blocked by the provider's content policy. Adjust the prompt and try again.",
  invalid_response: "The AI provider returned an unusable response.",
  invalid_json: "The AI returned malformed structured data that could not be repaired.",
  offline: "The local speech service is offline.",
  model_loading: "The local speech model is still loading. Try again in a moment.",
  synthesis_error: "Speech synthesis failed for this text.",
  cancelled: "The job was cancelled.",
  batch_queue_full:
    "The provider's batch queue for this model is full. The batch is submitted once earlier batches finish.",
};

export class ProviderError extends Error {
  readonly retryable: boolean;
  /** See `opts.usage`. */
  get usage() {
    return this.opts.usage;
  }
  constructor(
    readonly provider: string,
    readonly code: ProviderErrorCode,
    message: string,
    readonly opts: {
      status?: number;
      retryAfterMs?: number;
      requestId?: string;
      raw?: unknown;
      retryable?: boolean;
      /**
       * Quantities the provider says it billed. Present when a request was answered (and charged) but the answer
       * was unusable — an HTTP 200 with no image, say — so the spend is recorded rather than lost.
       */
      usage?: {
        textInputTokens?: number;
        textOutputTokens?: number;
        imageInputTokens?: number;
        imageOutputTokens?: number;
        images?: number;
      };
    } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.retryable = opts.retryable ?? RETRYABLE.includes(code);
  }
  get userMessage() {
    return USER_MESSAGES[this.code];
  }
  get status() {
    return this.opts.status;
  }
  get requestId() {
    return this.opts.requestId;
  }
  get retryAfterMs() {
    return this.opts.retryAfterMs;
  }
}

export function classifyHttpStatus(status: number): ProviderErrorCode {
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "quota";
  if (status === 408) return "timeout";
  if (status >= 500) return "server_error";
  return "invalid_request";
}

/**
 * Whether a provider's batch refusal means "too much batch work is already queued for this model", which clears
 * by itself as earlier batches finish. OpenAI says `token_limit_exceeded` / "Enqueued token limit reached" (on
 * the create call, or as the failed batch's error); Gemini names the "enqueued tokens" quota.
 */
export function isBatchQueueFull(text: string) {
  return /token_limit_exceeded|enqueued[ _-]?tokens?\b/i.test(text);
}

export function parseRetryAfter(h: string | null | undefined, now = Date.now()): number | undefined {
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(h);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/**
 * Provider endpoints must answer directly. Outbound calls use `redirect: "manual"`, so a validated host cannot
 * answer 302 and send the request somewhere we would never have allowed — cloud metadata, or anything internal.
 */
export function refuseRedirect(provider: string, res: Response) {
  if (res.status >= 300 && res.status < 400)
    throw new ProviderError(provider, "invalid_request", `${provider} answered with a redirect (HTTP ${res.status})`, {
      status: res.status,
      retryable: false,
    });
}

/** Map fetch-level failures (abort, reset, DNS) to ProviderError. */
export function classifyFetchError(provider: string, e: unknown): ProviderError {
  if (e instanceof ProviderError) return e;
  const err = e as { name?: string; code?: string; message?: string };
  if (err?.name === "TimeoutError" || err?.name === "AbortError")
    return new ProviderError(provider, "timeout", `${provider} request timed out`);
  return new ProviderError(provider, "network", `${provider} network error: ${err?.code ?? err?.message ?? "unknown"}`);
}

export const backoffMs = (attempt: number, base = 1000, max = 30_000, rand = Math.random) =>
  Math.min(max, base * 2 ** attempt) * (0.5 + rand() * 0.5);

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts: {
    retries: number;
    baseMs?: number;
    maxMs?: number;
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (e: ProviderError, attempt: number, delay: number) => void;
  },
): Promise<T> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (e) {
      if (!(e instanceof ProviderError) || !e.retryable || attempt >= opts.retries) throw e;
      const delay = Math.max(e.retryAfterMs ?? 0, backoffMs(attempt, opts.baseMs, opts.maxMs));
      opts.onRetry?.(e, attempt, delay);
      await sleep(delay);
    }
  }
}

/** Concurrency limiter with a shared cooldown honoring Retry-After. Queues rather than drops. */
export class ConcurrencyLimiter {
  private active = 0;
  private waiters: (() => void)[] = [];
  private cooldownUntil = 0;
  constructor(private readonly max: number) {}

  cooldown(ms: number) {
    this.cooldownUntil = Math.max(this.cooldownUntil, Date.now() + ms);
  }

  get stats() {
    return {
      active: this.active,
      waiting: this.waiters.length,
      cooldownMs: Math.max(0, this.cooldownUntil - Date.now()),
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try {
      const wait = this.cooldownUntil - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}
