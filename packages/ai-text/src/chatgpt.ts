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

type Usage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };
type ResponsesEvent = {
  type?: string;
  delta?: string;
  response?: { id?: string; model?: string; usage?: Usage; status?: string; error?: { message?: string } | null };
  message?: string;
};

/**
 * A "Sign in with ChatGPT" connection: its token works only on the Responses API, and only streamed with
 * `store: false` (Chat Completions and image generation answer 401). Billed to the person's ChatGPT plan.
 */
export class ChatgptTextProvider implements TextAIProvider {
  readonly provider = "chatgpt";
  readonly model: string;
  private readonly limiter: ConcurrencyLimiter;

  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      model: string;
      timeoutMs: number;
      maxConcurrency: number;
      logger?: Logger;
      fetch?: typeof fetch;
    },
  ) {
    this.model = opts.model;
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrency);
  }

  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return runStructured(this, req);
  }

  generateText(req: TextRequest): Promise<TextResult> {
    return withRetry(() => this.limiter.run(() => this.once(req)), {
      retries: 2,
      onRetry: (e, attempt, delay) => {
        if (e.code === "rate_limited") this.limiter.cooldown(delay);
        this.opts.logger?.warn("chatgpt retry", { code: e.code, attempt, delayMs: Math.round(delay) });
      },
    });
  }

  private async once(req: TextRequest): Promise<TextResult> {
    const started = performance.now();
    const signal = AbortSignal.any([...(req.signal ? [req.signal] : []), AbortSignal.timeout(this.opts.timeoutMs)]);
    const instructions = req.messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n\n");
    const input = req.messages
      .filter((m) => m.role !== "system")
      .map((m) =>
        m.role === "assistant"
          ? { role: "assistant", content: [{ type: "output_text", text: m.content }] }
          : {
              role: "user",
              content: [
                ...(m.images ?? []).map((img) => ({
                  type: "input_image",
                  image_url: `data:${img.mime};base64,${Buffer.from(img.data).toString("base64")}`,
                })),
                { type: "input_text", text: m.content },
              ],
            },
      );
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.opts.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          ...(instructions ? { instructions } : {}),
          input,
          store: false,
          stream: true,
        }),
        signal,
        redirect: "manual",
      });
    } catch (e) {
      throw classifyFetchError(this.provider, e);
    }
    refuseRedirect(this.provider, res);
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      throw new ProviderError(this.provider, classifyHttpStatus(res.status), `ChatGPT HTTP ${res.status}: ${body}`, {
        status: res.status,
        retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
      });
    }

    let text = "";
    let done: ResponsesEvent["response"];
    try {
      await readSseData(res, (payload) => {
        let ev: ResponsesEvent;
        try {
          ev = JSON.parse(payload) as ResponsesEvent;
        } catch {
          return; // keep-alives and the like
        }
        if (ev.type === "response.output_text.delta") {
          text += ev.delta ?? "";
          req.onText?.(text);
        } else if (ev.type === "response.completed" || ev.type === "response.incomplete") done = ev.response;
        else if (ev.type === "response.failed" || ev.type === "error")
          throw new ProviderError(
            this.provider,
            /usage|limit|quota/i.test(ev.response?.error?.message ?? ev.message ?? "") ? "quota" : "server_error",
            `ChatGPT: ${ev.response?.error?.message ?? ev.message ?? "the response failed"}`,
          );
      });
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw classifyFetchError(this.provider, e);
    }
    if (!done)
      throw new ProviderError(this.provider, "invalid_response", "ChatGPT stream ended without a completed response");
    const u = done.usage ?? {};
    return {
      text,
      finishReason: done.status === "incomplete" ? "length" : "stop",
      call: {
        provider: this.provider,
        model: done.model ?? this.model,
        requestId: done.id ?? null,
        purpose: "primary",
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        cachedTokens: u.input_tokens_details?.cached_tokens ?? 0,
        latencyMs: Math.round(performance.now() - started),
        rawUsage: u as Record<string, unknown>,
        success: true,
      },
    };
  }
}
