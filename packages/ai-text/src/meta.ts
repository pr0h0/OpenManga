import {
  ConcurrencyLimiter,
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  parseRetryAfter,
  refuseRedirect,
  withRetry,
} from "@openmanga/domain/browser";
import type { Logger } from "@openmanga/logger";
import {
  runStructured,
  type StructuredRequest,
  type StructuredResult,
  type TextAIProvider,
  type TextRequest,
  type TextResult,
} from "./index.ts";
import { readSseData } from "./sse.ts";

type Usage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  completion_tokens_details?: { reasoning_tokens?: number };
  prompt_tokens_details?: { cached_tokens?: number };
  [k: string]: unknown;
};
type Chunk = {
  id?: string;
  model?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: Usage | null;
  error?: { message?: string; code?: string | number; type?: string };
};

export type OpenAIChatOptions = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  maxConcurrency: number;
  reasoningEffort?: string;
  /** Extra request headers (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
  retries?: number;
  logger?: Logger;
  fetch?: typeof fetch;
};

/**
 * Streaming OpenAI-style chat completions (OpenAI, OpenRouter, Meta, Gemini's OpenAI endpoint, custom servers).
 * Streams because long non-streaming requests may time out upstream; deltas are assembled into one TextResult.
 */
export class OpenAIChatTextProvider implements TextAIProvider {
  readonly model: string;
  private readonly limiter: ConcurrencyLimiter;

  constructor(
    readonly provider: string,
    private readonly label: string,
    private readonly opts: OpenAIChatOptions,
  ) {
    if (!opts.apiKey) throw new Error(`${label} API key is not configured`);
    this.model = opts.model;
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrency);
  }

  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return runStructured(this, req);
  }

  generateText(req: TextRequest): Promise<TextResult> {
    return withRetry(() => this.limiter.run(() => this.once(req)), {
      retries: this.opts.retries ?? 2,
      onRetry: (e, attempt, delay) => {
        if (e.code === "rate_limited") this.limiter.cooldown(delay);
        this.opts.logger?.warn(`${this.provider} retry`, {
          code: e.code,
          attempt,
          delayMs: Math.round(delay),
          providerRequestId: e.requestId,
        });
      },
    });
  }

  private async once(req: TextRequest): Promise<TextResult> {
    const started = performance.now();
    const signal = req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(this.opts.timeoutMs)])
      : AbortSignal.timeout(this.opts.timeoutMs);
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.opts.apiKey}`,
          ...this.opts.headers,
        },
        body: JSON.stringify({
          model: this.model,
          messages: req.messages.map((m) =>
            m.images?.length
              ? {
                  role: m.role,
                  content: [
                    { type: "text", text: m.content },
                    ...m.images.map((img) => ({
                      type: "image_url",
                      image_url: { url: `data:${img.mime};base64,${Buffer.from(img.data).toString("base64")}` },
                    })),
                  ],
                }
              : { role: m.role, content: m.content },
          ),
          // Reasoning models (Muse Spark, GPT-5) reject or ignore non-default temperature; only send an explicit override.
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          max_completion_tokens: req.maxTokens ?? 8192,
          stream: true,
          stream_options: { include_usage: true },
          ...(this.opts.reasoningEffort ? { reasoning_effort: this.opts.reasoningEffort } : {}),
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal,
        redirect: "manual",
      });
    } catch (e) {
      throw classifyFetchError(this.provider, e);
    }
    refuseRedirect(this.provider, res);
    const headerId = res.headers.get("x-request-id") ?? undefined;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as Chunk).error?.message ?? msg;
      } catch {}
      throw new ProviderError(
        this.provider,
        classifyHttpStatus(res.status),
        `${this.label} HTTP ${res.status}: ${msg}`,
        {
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
          requestId: headerId,
        },
      );
    }

    let text = "";
    let finish: string | null = null;
    let usage: Usage = {};
    let id: string | undefined;
    let model: string | undefined;
    const handle = (payload: string) => {
      if (!payload || payload === "[DONE]") return;
      let c: Chunk;
      try {
        c = JSON.parse(payload) as Chunk;
      } catch {
        throw new ProviderError(this.provider, "invalid_response", `${this.label} stream sent a malformed event`, {
          requestId: id ?? headerId,
        });
      }
      if (c.error) {
        const m = c.error.message ?? "stream error";
        const policy = /safety|policy|refus/i.test(`${c.error.type} ${c.error.code} ${m}`);
        throw new ProviderError(
          this.provider,
          policy ? "content_policy" : "server_error",
          `${this.label} stream error: ${m}`,
          {
            requestId: id ?? headerId,
          },
        );
      }
      id ??= c.id;
      model ??= c.model;
      const ch = c.choices?.[0];
      if (ch?.delta?.content) {
        text += ch.delta.content;
        req.onText?.(text);
      }
      if (ch?.finish_reason) finish = ch.finish_reason;
      if (c.usage) usage = c.usage;
    };
    try {
      await readSseData(res, handle);
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw classifyFetchError(this.provider, e);
    }

    const requestId = id ?? headerId;
    if (finish === "length")
      throw new ProviderError(
        this.provider,
        "invalid_json",
        `${this.label} output was truncated at the max token limit (${req.maxTokens ?? 8192}); try a shorter input`,
        { requestId, retryable: false },
      );
    if (finish === "content_filter")
      throw new ProviderError(this.provider, "content_policy", `${this.label} refused the request (content_filter)`, {
        requestId,
      });
    if (!finish && !text)
      throw new ProviderError(this.provider, "invalid_response", `${this.label} stream ended without a completion`, {
        requestId,
      });
    if (!text && !req.json)
      throw new ProviderError(this.provider, "invalid_response", `${this.label} returned empty content`, { requestId });
    return {
      text,
      finishReason: finish,
      call: {
        provider: this.provider,
        model: model ?? this.model,
        requestId: requestId ?? null,
        purpose: "primary",
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
        cachedTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
        latencyMs: Math.round(performance.now() - started),
        rawUsage: usage as Record<string, unknown>,
        success: true,
      },
    };
  }
}

/** Meta Model API (Muse Spark). */
export class MetaMuseTextProvider extends OpenAIChatTextProvider {
  constructor(opts: OpenAIChatOptions) {
    super("meta", "Meta", opts);
  }
}
