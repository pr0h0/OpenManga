/**
 * Async provider batches for text (and vision-text) generation: submit many requests, collect within 24h, pay
 * half. Same two providers as the image side, and the same shape of difference between them:
 *   - OpenAI takes JSONL lines against /v1/chat/completions, so images ride inline as data URLs, exactly as the
 *     synchronous chat body does. Its binding limit is enqueued input tokens per model.
 *   - Gemini takes GenerateContentRequest bodies through :batchGenerateContent, with images as inline_data. Its
 *     binding limit is the 20MB inline payload. Note the app's synchronous Google text path goes through
 *     Gemini's OpenAI-compatibility layer, which has no batch endpoint — batching uses the native API instead,
 *     so the same model is addressed by its native name here.
 * DeepSeek is absent: it discounts by time of day rather than exposing a batch endpoint.
 */
import { classifyFetchError, classifyHttpStatus, ProviderError, refuseRedirect } from "@openmanga/domain/browser";
import type { ChatMessage, TextCallRecord } from "./index.ts";

/** One request inside a batch. `key` is the generation job id, echoed back so results map to jobs. */
export type TextBatchRequestSpec = {
  key: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  json?: boolean;
};

export type TextBatchState = "pending" | "running" | "succeeded" | "partial" | "failed" | "expired" | "cancelled";

export type TextBatchItemResult =
  | { key: string; ok: true; text: string; finishReason: string | null; usage: TextBatchUsage }
  | { key: string; ok: false; code: string; message: string; usage?: TextBatchUsage };

export type TextBatchUsage = { inputTokens: number; outputTokens: number; cachedTokens: number };

export type TextBatchHandle = {
  handle: string;
  keys: string[];
  ownedFileIds?: string[];
  idempotencyKey: string;
};

export type TextBatchStatus = {
  state: TextBatchState;
  counts: { total: number; completed: number; failed: number };
  items?: TextBatchItemResult[];
  error?: string;
};

export interface TextBatchProvider {
  readonly provider: string;
  readonly model: string;
  chunk(reqs: TextBatchRequestSpec[]): TextBatchRequestSpec[][];
  submitBatch(reqs: TextBatchRequestSpec[], idempotencyKey: string): Promise<TextBatchHandle>;
  pollBatch(h: TextBatchHandle): Promise<TextBatchStatus>;
  cancelBatch(h: TextBatchHandle): Promise<void>;
  releaseBatch(h: TextBatchHandle): Promise<void>;
  findByIdempotencyKey(key: string): Promise<TextBatchHandle | null>;
}

/** A batched call, shaped like any other so usage accounting needs no special case. */
export const batchCallRecord = (
  provider: string,
  model: string,
  usage: TextBatchUsage,
  raw: Record<string, unknown> = {},
): TextCallRecord => ({
  provider,
  model,
  requestId: null,
  purpose: "primary",
  inputTokens: usage.inputTokens,
  outputTokens: usage.outputTokens,
  cachedTokens: usage.cachedTokens,
  latencyMs: 0,
  rawUsage: raw,
  success: true,
});

/**
 * Input tokens a request will be billed for: 4 characters per token for the prose, plus a deliberately generous
 * allowance per attached image, since overshooting a queue limit rejects the whole batch rather than one request.
 */
export function estimateTextInputTokens(r: TextBatchRequestSpec): number {
  let tokens = 32;
  for (const m of r.messages) {
    tokens += Math.ceil(m.content.length / 4) + 8;
    for (const img of m.images ?? []) tokens += Math.min(Math.ceil((img.data.byteLength / 1024) * 1.5) + 32, 3_000);
  }
  return tokens;
}

const byteSizeOf = (r: TextBatchRequestSpec) =>
  r.messages.reduce(
    (sum, m) =>
      sum + m.content.length + (m.images ?? []).reduce((s, i) => s + Math.ceil((i.data.byteLength * 4) / 3) + 128, 0),
    0,
  );

/** Greedy chunker: fills a batch until any budget would be exceeded. A single request over budget goes alone. */
export function chunkText(
  items: TextBatchRequestSpec[],
  budgets: { limit: number; cost: (item: TextBatchRequestSpec) => number }[],
) {
  const chunks: TextBatchRequestSpec[][] = [];
  let current: TextBatchRequestSpec[] = [];
  let running = budgets.map(() => 0);
  for (const item of items) {
    const costs = budgets.map((b) => b.cost(item));
    if (budgets.some((b, i) => running[i]! + costs[i]! > b.limit) && current.length) {
      chunks.push(current);
      current = [];
      running = budgets.map(() => 0);
    }
    current.push(item);
    running = running.map((v, i) => v + costs[i]!);
  }
  if (current.length) chunks.push(current);
  return chunks;
}

const chatMessage = (m: ChatMessage) =>
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
    : { role: m.role, content: m.content };

export class OpenAITextBatchProvider implements TextBatchProvider {
  readonly provider: string;
  readonly model: string;
  constructor(
    private readonly opts: {
      provider?: string;
      apiKey: string;
      baseUrl: string;
      model: string;
      timeoutMs: number;
      maxEnqueuedTokens: number;
      headers?: Record<string, string>;
      fetch?: typeof fetch;
    },
  ) {
    this.provider = opts.provider ?? "openai";
    this.model = opts.model;
  }

  chunk(reqs: TextBatchRequestSpec[]) {
    return chunkText(reqs, [
      { limit: Math.floor(this.opts.maxEnqueuedTokens * 0.8), cost: estimateTextInputTokens },
      { limit: 50_000, cost: () => 1 },
      { limit: 180 * 1024 * 1024, cost: byteSizeOf },
    ]);
  }

  private async api<T>(path: string, init: RequestInit & { form?: FormData }): Promise<T> {
    const { form, ...rest } = init;
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
        ...rest,
        headers: {
          ...(rest.headers as Record<string, string>),
          ...this.opts.headers,
          authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: form ?? rest.body,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: "manual",
      });
    } catch (e) {
      throw classifyFetchError(this.provider, e);
    }
    refuseRedirect(this.provider, res);
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let msg = text.slice(0, 300);
      try {
        msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? msg;
      } catch {}
      throw new ProviderError(this.provider, classifyHttpStatus(res.status), `Batch HTTP ${res.status}: ${msg}`, {
        status: res.status,
      });
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async submitBatch(reqs: TextBatchRequestSpec[], idempotencyKey: string): Promise<TextBatchHandle> {
    if (!reqs.length) throw new Error("submitBatch called with no requests");
    const lines = reqs.map((r) =>
      JSON.stringify({
        custom_id: r.key,
        method: "POST",
        url: "/v1/chat/completions",
        body: {
          model: this.model,
          messages: r.messages.map(chatMessage),
          ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
          max_completion_tokens: r.maxTokens ?? 8192,
          ...(r.json ? { response_format: { type: "json_object" } } : {}),
        },
      }),
    );
    const form = new FormData();
    form.set("file", new Blob([`${lines.join("\n")}\n`], { type: "application/jsonl" }), `${idempotencyKey}.jsonl`);
    form.set("purpose", "batch");
    const file = await this.api<{ id: string }>("/files", { method: "POST", form });
    try {
      const batch = await this.api<{ id: string }>("/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input_file_id: file.id,
          endpoint: "/v1/chat/completions",
          completion_window: "24h",
          metadata: { openmanga_batch: idempotencyKey },
        }),
      });
      return { handle: batch.id, keys: reqs.map((r) => r.key), ownedFileIds: [file.id], idempotencyKey };
    } catch (e) {
      await this.api(`/files/${file.id}`, { method: "DELETE" }).catch(() => {});
      throw e;
    }
  }

  async findByIdempotencyKey(key: string) {
    const list = await this.api<{ data?: { id: string; metadata?: Record<string, string> | null }[] }>(
      "/batches?limit=100",
      { method: "GET" },
    );
    const found = (list.data ?? []).find((b) => b.metadata?.openmanga_batch === key);
    return found ? { handle: found.id, keys: [], idempotencyKey: key } : null;
  }

  async pollBatch(h: TextBatchHandle): Promise<TextBatchStatus> {
    const b = await this.api<{
      status: string;
      request_counts?: { total?: number; completed?: number; failed?: number };
      output_file_id?: string | null;
      error_file_id?: string | null;
      errors?: unknown;
    }>(`/batches/${h.handle}`, { method: "GET" });
    const counts = {
      total: b.request_counts?.total ?? h.keys.length,
      completed: b.request_counts?.completed ?? 0,
      failed: b.request_counts?.failed ?? 0,
    };
    const state: TextBatchState =
      b.status === "completed"
        ? counts.failed && !counts.completed
          ? "failed"
          : counts.failed
            ? "partial"
            : "succeeded"
        : b.status === "failed"
          ? "failed"
          : b.status === "expired"
            ? "expired"
            : b.status === "cancelled" || b.status === "cancelling"
              ? "cancelled"
              : b.status === "in_progress" || b.status === "finalizing"
                ? "running"
                : "pending";
    if (state === "pending" || state === "running") return { state, counts };
    const items: TextBatchItemResult[] = [];
    for (const [fileId, isError] of [
      [b.output_file_id, false],
      [b.error_file_id, true],
    ] as const) {
      if (!fileId) continue;
      const body = await this.fileText(fileId);
      for (const line of body.split("\n").filter(Boolean)) items.push(this.itemFrom(line, isError));
    }
    return {
      state,
      counts,
      items,
      error: state === "failed" ? JSON.stringify(b.errors ?? {}).slice(0, 300) : undefined,
    };
  }

  private async fileText(fileId: string) {
    const res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}/files/${fileId}/content`, {
      headers: { authorization: `Bearer ${this.opts.apiKey}`, ...this.opts.headers },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new ProviderError(this.provider, classifyHttpStatus(res.status), "Could not read batch output");
    return await res.text();
  }

  private itemFrom(line: string, isErrorFile: boolean): TextBatchItemResult {
    const parsed = JSON.parse(line) as {
      custom_id?: string;
      response?: { status_code?: number; body?: Record<string, unknown> } | null;
      error?: { message?: string; code?: string } | null;
    };
    const key = parsed.custom_id ?? "";
    const body = parsed.response?.body as
      | {
          choices?: { message?: { content?: string }; finish_reason?: string }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
          error?: { message?: string; code?: string };
        }
      | undefined;
    const u = body?.usage ?? {};
    const usage = {
      inputTokens: u.prompt_tokens ?? 0,
      outputTokens: u.completion_tokens ?? 0,
      cachedTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
    };
    const failure = parsed.error ?? body?.error;
    const text = body?.choices?.[0]?.message?.content;
    if (isErrorFile || failure || !text) {
      const message = failure?.message ?? "The batch returned no completion for this request";
      const policy = /content policy|safety|moderation/i.test(message) ? "content_policy" : "invalid_response";
      return { key, ok: false, code: failure?.code ?? policy, message, usage };
    }
    return { key, ok: true, text, finishReason: body?.choices?.[0]?.finish_reason ?? null, usage };
  }

  async cancelBatch(h: TextBatchHandle) {
    await this.api(`/batches/${h.handle}/cancel`, { method: "POST" }).catch(() => {});
  }

  async releaseBatch(h: TextBatchHandle) {
    for (const id of h.ownedFileIds ?? []) await this.api(`/files/${id}`, { method: "DELETE" }).catch(() => {});
  }
}

type GeminiTextItem = {
  metadata?: { key?: string };
  error?: { code?: number; message?: string; status?: string };
  response?: {
    candidates?: {
      content?: { parts?: { text?: string; thought?: boolean }[] };
      finishReason?: string;
      finishMessage?: string;
    }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      cachedContentTokenCount?: number;
    };
  };
};

export class GeminiTextBatchProvider implements TextBatchProvider {
  readonly provider = "google";
  readonly model: string;
  constructor(
    private readonly opts: { apiKey: string; baseUrl: string; model: string; timeoutMs: number; fetch?: typeof fetch },
  ) {
    this.model = opts.model;
  }

  chunk(reqs: TextBatchRequestSpec[]) {
    return chunkText(reqs, [
      { limit: 15 * 1024 * 1024, cost: byteSizeOf },
      { limit: 5_000, cost: () => 1 },
    ]);
  }

  private body(r: TextBatchRequestSpec) {
    // Gemini takes the system prompt separately; everything else becomes a user/model turn in order.
    const system = r.messages.filter((m) => m.role === "system").map((m) => m.content);
    const turns = r.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [
          { text: m.content },
          ...(m.images ?? []).map((img) => ({
            inline_data: { mime_type: img.mime, data: Buffer.from(img.data).toString("base64") },
          })),
        ],
      }));
    return {
      contents: turns,
      ...(system.length ? { systemInstruction: { parts: [{ text: system.join("\n\n") }] } } : {}),
      generationConfig: {
        ...(r.temperature !== undefined ? { temperature: r.temperature } : {}),
        ...(r.maxTokens ? { maxOutputTokens: r.maxTokens } : {}),
        ...(r.json ? { responseMimeType: "application/json" } : {}),
      },
    };
  }

  private async api<T>(path: string, init: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), "x-goog-api-key": this.opts.apiKey },
        signal: AbortSignal.timeout(this.opts.timeoutMs),
        redirect: "manual",
      });
    } catch (e) {
      throw classifyFetchError(this.provider, e);
    }
    refuseRedirect(this.provider, res);
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let msg = text.slice(0, 300);
      let status: string | undefined;
      try {
        const j = JSON.parse(text) as { error?: { message?: string; status?: string } };
        msg = j.error?.message ?? msg;
        status = j.error?.status;
      } catch {}
      throw new ProviderError(
        this.provider,
        status === "RESOURCE_EXHAUSTED" || status === "FAILED_PRECONDITION" ? "quota" : classifyHttpStatus(res.status),
        `Gemini HTTP ${res.status}${status ? ` ${status}` : ""}: ${msg}`,
        { status: res.status },
      );
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  async submitBatch(reqs: TextBatchRequestSpec[], idempotencyKey: string): Promise<TextBatchHandle> {
    if (!reqs.length) throw new Error("submitBatch called with no requests");
    const created = await this.api<{ name?: string }>(`/models/${this.model}:batchGenerateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batch: {
          display_name: idempotencyKey,
          input_config: {
            requests: { requests: reqs.map((r) => ({ request: this.body(r), metadata: { key: r.key } })) },
          },
        },
      }),
    });
    if (!created.name) throw new ProviderError(this.provider, "invalid_response", "Gemini returned no batch name");
    return { handle: created.name, keys: reqs.map((r) => r.key), idempotencyKey };
  }

  async findByIdempotencyKey(key: string) {
    const list = await this.api<{
      batches?: { name?: string; displayName?: string; metadata?: { displayName?: string } }[];
    }>("/batches?pageSize=100", { method: "GET" });
    // The field has appeared both on the batch and under metadata; checking both keeps a retry from paying twice.
    const found = (list.batches ?? []).find((b) => (b.metadata?.displayName ?? b.displayName) === key);
    return found?.name ? { handle: found.name, keys: [], idempotencyKey: key } : null;
  }

  async pollBatch(h: TextBatchHandle): Promise<TextBatchStatus> {
    const j = await this.api<{
      metadata?: {
        state?: string;
        batchStats?: { requestCount?: string; successfulRequestCount?: string; failedRequestCount?: string };
        output?: { inlinedResponses?: { inlinedResponses?: GeminiTextItem[] } | GeminiTextItem[] };
      };
    }>(`/${h.handle.replace(/^\//, "")}`, { method: "GET" });
    const m = j.metadata ?? {};
    const num = (v: string | undefined) => Number(v ?? 0) || 0;
    const counts = {
      total: num(m.batchStats?.requestCount) || h.keys.length,
      completed: num(m.batchStats?.successfulRequestCount),
      failed: num(m.batchStats?.failedRequestCount),
    };
    const terminal = ["BATCH_STATE_SUCCEEDED", "BATCH_STATE_FAILED", "BATCH_STATE_CANCELLED", "BATCH_STATE_EXPIRED"];
    if (!terminal.includes(m.state ?? ""))
      return { state: m.state === "BATCH_STATE_RUNNING" ? "running" : "pending", counts };
    const raw = m.output?.inlinedResponses;
    const list = (Array.isArray(raw) ? raw : raw?.inlinedResponses) ?? [];
    const items = list.map((item) => this.itemFrom(item));
    const state: TextBatchState =
      m.state === "BATCH_STATE_CANCELLED"
        ? "cancelled"
        : m.state === "BATCH_STATE_EXPIRED"
          ? "expired"
          : m.state === "BATCH_STATE_FAILED" || (counts.failed > 0 && counts.completed === 0)
            ? "failed"
            : counts.failed > 0
              ? "partial"
              : "succeeded";
    return { state, counts, items };
  }

  private itemFrom(item: GeminiTextItem): TextBatchItemResult {
    const key = item.metadata?.key ?? "";
    const um = item.response?.usageMetadata ?? {};
    const usage = {
      inputTokens: um.promptTokenCount ?? 0,
      outputTokens: um.candidatesTokenCount ?? 0,
      cachedTokens: um.cachedContentTokenCount ?? 0,
    };
    if (item.error)
      return {
        key,
        ok: false,
        code: item.error.status ?? String(item.error.code ?? "error"),
        message: item.error.message ?? "Gemini failed this batch request",
        usage,
      };
    const cand = item.response?.candidates?.[0];
    const text = cand?.content?.parts
      ?.filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join("");
    if (!text) {
      const reason = cand?.finishReason ?? "NO_CANDIDATE";
      const policy = /SAFETY|PROHIBITED|BLOCK|RECITATION/i.test(reason);
      return {
        key,
        ok: false,
        code: policy ? "content_policy" : "invalid_response",
        message: `Gemini returned no text (${reason}${cand?.finishMessage ? `: ${cand.finishMessage}` : ""})`,
        usage,
      };
    }
    return { key, ok: true, text, finishReason: cand?.finishReason ?? null, usage };
  }

  async cancelBatch(h: TextBatchHandle) {
    await this.api(`/${h.handle.replace(/^\//, "")}:cancel`, { method: "POST" }).catch(() => {});
  }

  async releaseBatch() {
    // Inline requests, so there is nothing uploaded to delete.
  }
}
