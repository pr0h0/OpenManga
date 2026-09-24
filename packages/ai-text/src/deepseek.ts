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

type DeepSeekChunk = {
  id?: string;
  model?: string;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: DeepSeekResponse["usage"] | null;
  error?: { message?: string };
};

type DeepSeekResponse = {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
    [k: string]: unknown;
  };
  error?: { message?: string; code?: string; type?: string };
};

/** Official DeepSeek API (OpenAI-compatible chat completions). No gateways. */
export class DeepSeekTextProvider implements TextAIProvider {
  readonly provider = "deepseek";
  readonly model: string;
  private readonly limiter: ConcurrencyLimiter;

  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      model: string;
      timeoutMs: number;
      maxConcurrency: number;
      retries?: number;
      logger?: Logger;
      fetch?: typeof fetch;
    },
  ) {
    if (!opts.apiKey) throw new Error("DEEPSEEK_API_KEY is not configured");
    this.model = opts.model;
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrency);
  }

  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return runStructured(this, req);
  }

  async generateText(req: TextRequest): Promise<TextResult> {
    return withRetry(() => this.limiter.run(() => this.once(req)), {
      retries: this.opts.retries ?? 2,
      onRetry: (e, attempt, delay) => {
        if (e.code === "rate_limited") this.limiter.cooldown(delay);
        this.opts.logger?.warn("deepseek retry", {
          code: e.code,
          attempt,
          delayMs: Math.round(delay),
          providerRequestId: e.requestId,
        });
      },
    });
  }

  private async once(req: TextRequest): Promise<TextResult> {
    if (req.messages.some((m) => m.images?.length))
      throw new ProviderError(
        this.provider,
        "invalid_request",
        "DeepSeek models can't read images; choose a vision model",
        {
          retryable: false,
        },
      );
    const started = performance.now();
    const f = this.opts.fetch ?? fetch;
    const signal = req.signal
      ? AbortSignal.any([req.signal, AbortSignal.timeout(this.opts.timeoutMs)])
      : AbortSignal.timeout(this.opts.timeoutMs);
    let res: Response;
    try {
      res = await f(`${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
          temperature: req.temperature ?? (req.json ? 0.3 : 0.7),
          max_tokens: req.maxTokens ?? 8192,
          // Streamed only when the caller shows the answer as it arrives; everything else keeps the plain request.
          stream: Boolean(req.onText),
          ...(req.onText ? { stream_options: { include_usage: true } } : {}),
          ...(req.json ? { response_format: { type: "json_object" } } : {}),
        }),
        signal,
        redirect: "manual",
      });
    } catch (e) {
      throw classifyFetchError(this.provider, e);
    }
    refuseRedirect(this.provider, res);
    const headerRequestId = res.headers.get("x-request-id") ?? res.headers.get("x-ds-trace-id");
    if (req.onText && res.ok) return this.readStream(res, req, started, headerRequestId);
    let bodyText: string;
    try {
      bodyText = await res.text();
    } catch (e) {
      throw classifyFetchError(this.provider, e);
    }
    let body: DeepSeekResponse = {};
    try {
      body = JSON.parse(bodyText) as DeepSeekResponse;
    } catch {
      if (res.ok)
        throw new ProviderError(this.provider, "invalid_response", "DeepSeek returned a non-JSON HTTP body", {
          requestId: headerRequestId ?? undefined,
        });
    }
    if (!res.ok) {
      const code = classifyHttpStatus(res.status);
      throw new ProviderError(
        this.provider,
        code,
        `DeepSeek HTTP ${res.status}: ${body.error?.message ?? bodyText.slice(0, 200)}`,
        {
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
          requestId: headerRequestId ?? undefined,
        },
      );
    }
    return this.result(req, {
      id: body.id,
      model: body.model,
      text: body.choices?.[0]?.message?.content ?? "",
      finish: body.choices?.[0]?.finish_reason ?? null,
      usage: body.usage ?? {},
      started,
      headerRequestId,
    });
  }

  /** A streamed answer: content deltas are passed on as they arrive; usage comes in the last event. */
  private async readStream(res: Response, req: TextRequest, started: number, headerRequestId: string | null) {
    let text = "";
    let finish: string | null = null;
    let usage: NonNullable<DeepSeekResponse["usage"]> = {};
    let id: string | undefined;
    let model: string | undefined;
    try {
      await readSseData(res, (payload) => {
        if (!payload || payload === "[DONE]") return;
        let c: DeepSeekChunk;
        try {
          c = JSON.parse(payload) as DeepSeekChunk;
        } catch {
          throw new ProviderError(this.provider, "invalid_response", "DeepSeek stream sent a malformed event", {
            requestId: id ?? headerRequestId ?? undefined,
          });
        }
        if (c.error)
          throw new ProviderError(
            this.provider,
            "server_error",
            `DeepSeek stream error: ${c.error.message ?? "unknown"}`,
            {
              requestId: id ?? headerRequestId ?? undefined,
            },
          );
        id ??= c.id;
        model ??= c.model;
        const ch = c.choices?.[0];
        if (ch?.delta?.content) {
          text += ch.delta.content;
          req.onText?.(text);
        }
        if (ch?.finish_reason) finish = ch.finish_reason;
        if (c.usage) usage = c.usage;
      });
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw classifyFetchError(this.provider, e);
    }
    if (!finish && !text)
      throw new ProviderError(this.provider, "invalid_response", "DeepSeek stream ended without a completion", {
        requestId: id ?? headerRequestId ?? undefined,
      });
    return this.result(req, { id, model, text, finish, usage, started, headerRequestId });
  }

  private result(
    req: TextRequest,
    r: {
      id: string | undefined;
      model: string | undefined;
      text: string;
      finish: string | null;
      usage: NonNullable<DeepSeekResponse["usage"]>;
      started: number;
      headerRequestId: string | null;
    },
  ): TextResult {
    if (r.finish === "length")
      throw new ProviderError(
        this.provider,
        "invalid_json",
        `DeepSeek output was truncated at the max token limit (${req.maxTokens ?? 8192}); try a shorter input`,
        { requestId: r.id, retryable: false },
      );
    if (!r.text && !req.json)
      throw new ProviderError(this.provider, "invalid_response", "DeepSeek returned empty content", {
        requestId: r.id,
      });
    return {
      text: r.text,
      finishReason: r.finish,
      call: {
        provider: this.provider,
        model: r.model ?? this.model,
        requestId: r.id ?? r.headerRequestId ?? null,
        purpose: "primary",
        inputTokens: r.usage.prompt_tokens ?? 0,
        outputTokens: r.usage.completion_tokens ?? 0,
        cachedTokens: r.usage.prompt_cache_hit_tokens ?? 0,
        latencyMs: Math.round(performance.now() - r.started),
        rawUsage: r.usage as Record<string, unknown>,
        success: true,
      },
    };
  }
}
