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

type AnthropicEvent = {
  type?: string;
  message?: { id?: string; model?: string; usage?: Usage };
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  usage?: Usage;
  error?: { type?: string; message?: string };
};
type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
};

/**
 * Anthropic Messages API, streamed (long structured outputs exceed the non-streaming time budget).
 * JSON is requested by the prompts themselves; extract -> validate -> repair handles the rest.
 */
export class AnthropicTextProvider implements TextAIProvider {
  readonly provider = "anthropic";
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
    if (!opts.apiKey) throw new Error("Anthropic API key is not configured");
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
        this.opts.logger?.warn("anthropic retry", {
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
    const system = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const messages = req.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role,
        content: m.images?.length
          ? [
              ...m.images.map((img) => ({
                type: "image",
                source: { type: "base64", media_type: img.mime, data: Buffer.from(img.data).toString("base64") },
              })),
              { type: "text", text: m.content },
            ]
          : m.content,
      }));
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.opts.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.model,
          ...(system ? { system } : {}),
          messages,
          max_tokens: req.maxTokens ?? 8192,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          stream: true,
        }),
        signal,
        redirect: "manual",
      });
    } catch (e) {
      throw classifyFetchError(this.provider, e);
    }
    refuseRedirect(this.provider, res);
    const headerId = res.headers.get("request-id") ?? undefined;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      let msg = body.slice(0, 300);
      let type = "";
      try {
        const e = (JSON.parse(body) as AnthropicEvent).error;
        msg = e?.message ?? msg;
        type = e?.type ?? "";
      } catch {}
      const code =
        type === "overloaded_error"
          ? "server_error"
          : res.status === 400 && /credit|billing/i.test(msg)
            ? "quota"
            : classifyHttpStatus(res.status);
      throw new ProviderError(this.provider, code, `Anthropic HTTP ${res.status}: ${msg}`, {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        requestId: headerId,
      });
    }

    let text = "";
    let stop: string | null = null;
    let id: string | undefined;
    let model: string | undefined;
    const usage: Usage = {};
    const handle = (payload: string) => {
      let ev: AnthropicEvent;
      try {
        ev = JSON.parse(payload) as AnthropicEvent;
      } catch {
        throw new ProviderError(this.provider, "invalid_response", "Anthropic stream sent a malformed event", {
          requestId: id ?? headerId,
        });
      }
      if (ev.type === "error") {
        const retryable = ev.error?.type === "overloaded_error" || ev.error?.type === "api_error";
        throw new ProviderError(
          this.provider,
          retryable ? "server_error" : "invalid_response",
          `Anthropic stream error: ${ev.error?.message ?? ev.error?.type ?? "unknown"}`,
          { requestId: id ?? headerId },
        );
      }
      if (ev.type === "message_start") {
        id = ev.message?.id;
        model = ev.message?.model;
        Object.assign(usage, ev.message?.usage ?? {});
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        text += ev.delta.text ?? "";
        req.onText?.(text);
      } else if (ev.type === "message_delta") {
        stop = ev.delta?.stop_reason ?? stop;
        if (ev.usage?.output_tokens !== undefined) usage.output_tokens = ev.usage.output_tokens;
      }
    };
    try {
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line.startsWith("data:")) handle(line.slice(5).trim());
          nl = buf.indexOf("\n");
        }
      }
      if (buf.trim().startsWith("data:")) handle(buf.trim().slice(5).trim());
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw classifyFetchError(this.provider, e);
    }

    const requestId = id ?? headerId;
    if (stop === "max_tokens")
      throw new ProviderError(
        this.provider,
        "invalid_json",
        `Anthropic output was truncated at the max token limit (${req.maxTokens ?? 8192}); try a shorter input`,
        { requestId, retryable: false },
      );
    if (stop === "refusal")
      throw new ProviderError(this.provider, "content_policy", "Anthropic declined the request", { requestId });
    if (!stop && !text)
      throw new ProviderError(this.provider, "invalid_response", "Anthropic stream ended without a completion", {
        requestId,
      });
    return {
      text,
      finishReason: stop,
      call: {
        provider: this.provider,
        model: model ?? this.model,
        requestId: requestId ?? null,
        purpose: "primary",
        inputTokens:
          (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
        cachedTokens: usage.cache_read_input_tokens ?? 0,
        latencyMs: Math.round(performance.now() - started),
        rawUsage: usage as Record<string, unknown>,
        success: true,
      },
    };
  }
}
