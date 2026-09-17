/**
 * Async provider batches for image generation: submit many panels at once, collect them within 24h, pay half.
 *
 * The two providers differ in ways that leak into the design, so both are handled explicitly rather than behind a
 * lowest-common-denominator wrapper:
 *   - OpenAI takes a JSONL file of request lines and will not accept multipart, so reference images have to be
 *     uploaded to the Files API first and named by `file_id`. Its binding limit is *enqueued input tokens* per
 *     model (org-specific, commonly 1M), so batches are chunked by estimated tokens.
 *   - Gemini takes the same GenerateContentRequest bodies it takes synchronously, references inline as base64.
 *     Its binding limit is payload size (20 MB inline), so batches are chunked by bytes.
 * Both are 50% of the interactive price and target 24h; Gemini expires a job that is still pending at 48h.
 */
import { classifyFetchError, classifyHttpStatus, ProviderError, refuseRedirect } from "@openmanga/domain/browser";
import { probeImage } from "@openmanga/image-utils";
import type { Logger } from "@openmanga/logger";
import { geminiAspectFor } from "./gemini.ts";
import type { ImageInputFile, ImageResult, ImageUsage } from "./index.ts";

/**
 * A reference inside a batch, carrying a stable id (the asset variant it came from) so a provider that has to
 * upload references can upload each distinct file once and reuse it across every request that names it.
 */
export type BatchReferenceFile = ImageInputFile & { id: string };

/** One panel's request inside a batch. `key` is echoed back by the provider so results map to jobs. */
export type BatchRequestSpec = {
  key: string;
  prompt: string;
  /** Provider-resolved output size, as the synchronous path would have asked for it. */
  size: { width: number; height: number };
  aspectRatio: number;
  quality: string;
  references: BatchReferenceFile[];
};

export type BatchState = "pending" | "running" | "succeeded" | "partial" | "failed" | "expired" | "cancelled";

export type BatchItemResult =
  | { key: string; ok: true; result: ImageResult }
  | { key: string; ok: false; code: string; message: string; usage?: Partial<ImageUsage> };

export type BatchHandle = {
  /** The provider's id for the batch: OpenAI batch id, or Gemini `batches/...` name. */
  handle: string;
  keys: string[];
  /** Provider-side files we own and must delete once the batch is ingested. */
  ownedFileIds?: string[];
  /** Echoed so a redelivered submit can find a batch it already created instead of paying twice. */
  idempotencyKey: string;
};

export type BatchStatus = {
  state: BatchState;
  counts: { total: number; completed: number; failed: number };
  /** Present once terminal. Items the provider failed carry `ok: false` and are retried synchronously. */
  items?: BatchItemResult[];
  error?: string;
};

export interface ImageBatchProvider {
  readonly provider: string;
  readonly model: string;
  /** Largest number of requests to put in one batch, per this provider's binding limit. */
  chunk(reqs: BatchRequestSpec[]): BatchRequestSpec[][];
  submitBatch(reqs: BatchRequestSpec[], idempotencyKey: string): Promise<BatchHandle>;
  pollBatch(h: BatchHandle): Promise<BatchStatus>;
  cancelBatch(h: BatchHandle): Promise<void>;
  /** Best-effort cleanup of provider-side files after ingest. */
  releaseBatch(h: BatchHandle): Promise<void>;
  /** Finds a batch this key already created (crash between submit and persist). */
  findByIdempotencyKey(key: string): Promise<BatchHandle | null>;
}

/**
 * Input tokens a request will be billed for. Measured against 1,390 real gpt-image-2 calls: ~1,049 text and ~295
 * image input tokens typically, but 1,704 and 2,961 at the tail — so a request count alone would misjudge a batch
 * by 3x. Prompt tokens use the conventional 4-chars-per-token estimate; a reference derivative is charged as a
 * tile count, over-estimated deliberately since overshooting the queue limit rejects the whole batch.
 */
export function estimateInputTokens(r: BatchRequestSpec): number {
  const prompt = Math.ceil(r.prompt.length / 4);
  const perReference = r.references.reduce((sum, ref) => {
    // 32px tiles of a ≤192px derivative, plus the label text; rounded up generously.
    const tiles = Math.ceil((ref.data.byteLength / 1024) * 1.5) + 16;
    return sum + Math.min(tiles, 3_000);
  }, 0);
  return prompt + perReference + 64;
}

const byteSizeOf = (r: BatchRequestSpec) =>
  r.prompt.length + r.references.reduce((s, ref) => s + Math.ceil((ref.data.byteLength * 4) / 3) + 128, 0);

/** Greedy chunker: fills a batch until any budget would be exceeded. A single request over budget goes alone. */
export function chunkByBudget<T>(items: T[], budgets: { limit: number; cost: (item: T) => number }[]): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let running = budgets.map(() => 0);
  for (const item of items) {
    const costs = budgets.map((b) => b.cost(item));
    const wouldExceed = budgets.some((b, i) => running[i]! + costs[i]! > b.limit);
    if (wouldExceed && current.length) {
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

const extFor = (mime: string) => (mime === "image/webp" ? "webp" : mime === "image/jpeg" ? "jpg" : "png");

type OpenAIBatchOpts = {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Per-model enqueued input-token ceiling for batches; org-specific, so configured rather than assumed. */
  maxEnqueuedTokens: number;
  logger?: Logger;
  fetch?: typeof fetch;
};

/** OpenAI Batch API. Reference images are uploaded first: a batch line is JSON, and multipart is refused. */
export class OpenAIImageBatchProvider implements ImageBatchProvider {
  readonly provider = "openai";
  readonly model: string;
  constructor(private readonly opts: OpenAIBatchOpts) {
    this.model = opts.model;
  }

  chunk(reqs: BatchRequestSpec[]) {
    return chunkByBudget(reqs, [
      // 20% headroom: the estimate is per-request and the whole batch is rejected if the queue limit is passed.
      { limit: Math.floor(this.opts.maxEnqueuedTokens * 0.8), cost: estimateInputTokens },
      { limit: 50_000, cost: () => 1 },
      // 200 MB input file; the JSONL carries only ids, so this is generous, but keep it honest.
      { limit: 180 * 1024 * 1024, cost: (r) => r.prompt.length + 512 },
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
      throw new ProviderError(this.provider, classifyHttpStatus(res.status), `OpenAI HTTP ${res.status}: ${msg}`, {
        status: res.status,
        requestId: res.headers.get("x-request-id") ?? undefined,
      });
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  private async uploadFile(data: Uint8Array, name: string, mime: string, purpose: string) {
    const form = new FormData();
    form.set("file", new Blob([data.slice()], { type: mime }), name);
    form.set("purpose", purpose);
    const r = await this.api<{ id: string }>("/files", { method: "POST", form });
    return r.id;
  }

  async submitBatch(reqs: BatchRequestSpec[], idempotencyKey: string): Promise<BatchHandle> {
    if (!reqs.length) throw new Error("submitBatch called with no requests");
    // A batch names one endpoint, so every request in it must take the same shape. Panels always carry
    // references, and the caller groups by that before chunking.
    const withRefs = reqs.some((r) => r.references.length);
    if (withRefs && !reqs.every((r) => r.references.length))
      throw new Error("An OpenAI batch cannot mix requests with and without reference images");
    const endpoint = withRefs ? "/v1/images/edits" : "/v1/images/generations";
    const owned: string[] = [];
    try {
      const lines: string[] = [];
      // Panels in a chapter share reference derivatives (the same character sheet, location, style), so each
      // distinct file is uploaded once and reused. A 600-panel batch uploads a handful of files, not thousands.
      const uploaded = new Map<string, string>();
      for (const r of reqs) {
        const fileIds: string[] = [];
        for (const [i, ref] of r.references.entries()) {
          let id = uploaded.get(ref.id);
          if (!id) {
            id = await this.uploadFile(ref.data, `${ref.id}-${i + 1}.${extFor(ref.mime)}`, ref.mime, "vision");
            uploaded.set(ref.id, id);
            owned.push(id);
          }
          fileIds.push(id);
        }
        lines.push(
          JSON.stringify({
            custom_id: r.key,
            method: "POST",
            url: endpoint,
            body: {
              model: this.model,
              prompt: r.prompt,
              size: `${r.size.width}x${r.size.height}`,
              quality: r.quality,
              n: 1,
              output_format: "png",
              // Order is load-bearing: the compiled prompt refers to "reference image N".
              // `images: [{file_id}]` is what /v1/images/edits takes as JSON — verified against the live API.
              // The documented `input_reference` is rejected here, and a bare file-id string is too.
              ...(fileIds.length ? { images: fileIds.map((id) => ({ file_id: id })) } : {}),
            },
          }),
        );
      }
      const inputFileId = await this.uploadFile(
        new TextEncoder().encode(`${lines.join("\n")}\n`),
        `${idempotencyKey}.jsonl`,
        "application/jsonl",
        "batch",
      );
      owned.push(inputFileId);
      const batch = await this.api<{ id: string }>("/batches", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          input_file_id: inputFileId,
          endpoint,
          completion_window: "24h",
          metadata: { openmanga_batch: idempotencyKey },
        }),
      });
      return { handle: batch.id, keys: reqs.map((r) => r.key), ownedFileIds: owned, idempotencyKey };
    } catch (e) {
      // Never leave uploads behind for a batch that was not created.
      for (const id of owned) await this.api(`/files/${id}`, { method: "DELETE" }).catch(() => {});
      throw e;
    }
  }

  async findByIdempotencyKey(key: string): Promise<BatchHandle | null> {
    const list = await this.api<{ data?: { id: string; metadata?: Record<string, string> | null }[] }>(
      "/batches?limit=100",
      { method: "GET" },
    );
    const found = (list.data ?? []).find((b) => b.metadata?.openmanga_batch === key);
    return found ? { handle: found.id, keys: [], idempotencyKey: key } : null;
  }

  async pollBatch(h: BatchHandle): Promise<BatchStatus> {
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
    const state: BatchState =
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
    const items: BatchItemResult[] = [];
    for (const [fileId, isError] of [
      [b.output_file_id, false],
      [b.error_file_id, true],
    ] as const) {
      if (!fileId) continue;
      const body = await this.fileText(fileId);
      for (const line of body.split("\n").filter(Boolean)) {
        items.push(await this.itemFrom(line, isError));
      }
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
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
      signal: AbortSignal.timeout(this.opts.timeoutMs),
    });
    if (!res.ok) throw new ProviderError(this.provider, classifyHttpStatus(res.status), `Could not read batch output`);
    return await res.text();
  }

  private async itemFrom(line: string, isErrorFile: boolean): Promise<BatchItemResult> {
    const parsed = JSON.parse(line) as {
      custom_id?: string;
      response?: { status_code?: number; body?: Record<string, unknown> } | null;
      error?: { message?: string; code?: string } | null;
    };
    const key = parsed.custom_id ?? "";
    const body = parsed.response?.body as
      | {
          data?: { b64_json?: string }[];
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_tokens?: number };
          };
          error?: { message?: string; code?: string };
        }
      | undefined;
    const u = body?.usage ?? {};
    const imageIn = u.input_tokens_details?.image_tokens ?? 0;
    const billed = {
      textInputTokens: u.input_tokens_details?.text_tokens ?? Math.max(0, (u.input_tokens ?? 0) - imageIn),
      imageInputTokens: imageIn,
      imageOutputTokens: u.output_tokens ?? 0,
    };
    const failure = parsed.error ?? body?.error;
    const b64 = body?.data?.[0]?.b64_json;
    if (isErrorFile || failure || !b64) {
      const message = failure?.message ?? "The batch returned no image for this request";
      const policy = /safety system|content policy|moderation/i.test(message) ? "content_policy" : "invalid_response";
      return { key, ok: false, code: failure?.code ?? policy, message, usage: billed };
    }
    const data = new Uint8Array(Buffer.from(b64, "base64"));
    const probed = await probeImage(data);
    return {
      key,
      ok: true,
      result: {
        data,
        mime: probed.mime,
        width: probed.width,
        height: probed.height,
        provider: this.provider,
        model: this.model,
        quality: "batch",
        requestId: null,
        latencyMs: 0,
        usage: { ...billed, cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0, raw: u },
        request: { endpoint: "/v1/batches", size: `${probed.width}x${probed.height}`, referenceCount: 0 },
      },
    };
  }

  async cancelBatch(h: BatchHandle) {
    await this.api(`/batches/${h.handle}/cancel`, { method: "POST" }).catch(() => {});
  }

  async releaseBatch(h: BatchHandle) {
    for (const id of h.ownedFileIds ?? []) await this.api(`/files/${id}`, { method: "DELETE" }).catch(() => {});
  }
}

type GeminiBatchOpts = {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** "1K" (default), "2K", "4K" — the model has to support it; the lite model refuses anything above 1K. */
  imageSize: string;
  timeoutMs: number;
  logger?: Logger;
  fetch?: typeof fetch;
};

type GeminiItem = {
  metadata?: { key?: string };
  error?: { code?: number; message?: string; status?: string };
  response?: {
    candidates?: {
      content?: { parts?: { text?: string; thought?: boolean; inlineData?: { mimeType?: string; data?: string } }[] };
      finishReason?: string;
      finishMessage?: string;
    }[];
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      promptTokensDetails?: { modality?: string; tokenCount?: number }[];
      candidatesTokensDetails?: { modality?: string; tokenCount?: number }[];
    };
  };
};

const modality = (d: { modality?: string; tokenCount?: number }[] | undefined, m: string) =>
  d?.find((x) => x.modality === m)?.tokenCount;

/**
 * Gemini batch mode. The request bodies are exactly the synchronous ones — references stay inline as base64 —
 * so the binding limit is payload size (20 MB inline), not tokens. Note a batch reports SUCCEEDED even when
 * individual requests failed, so per-item errors are read from the response rather than inferred from the state.
 */
export class GeminiImageBatchProvider implements ImageBatchProvider {
  readonly provider = "google";
  readonly model: string;
  constructor(private readonly opts: GeminiBatchOpts) {
    this.model = opts.model;
  }

  chunk(reqs: BatchRequestSpec[]) {
    // 15 MB against a 20 MB inline ceiling: base64 inflation is already counted, the headroom covers the envelope.
    return chunkByBudget(reqs, [
      { limit: 15 * 1024 * 1024, cost: byteSizeOf },
      { limit: 5_000, cost: () => 1 },
    ]);
  }

  private body(r: BatchRequestSpec) {
    const parts: Record<string, unknown>[] = [{ text: r.prompt }];
    for (const [i, ref] of r.references.entries()) {
      parts.push({ text: `Reference image ${i + 1}: ${ref.label}` });
      parts.push({ inline_data: { mime_type: ref.mime, data: Buffer.from(ref.data).toString("base64") } });
    }
    return {
      contents: [{ parts }],
      generationConfig: {
        responseModalities: ["IMAGE"],
        imageConfig: { aspectRatio: geminiAspectFor(r.aspectRatio).ratio, imageSize: this.opts.imageSize },
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

  async submitBatch(reqs: BatchRequestSpec[], idempotencyKey: string): Promise<BatchHandle> {
    if (!reqs.length) throw new Error("submitBatch called with no requests");
    const created = await this.api<{ name?: string }>(`/models/${this.model}:batchGenerateContent`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        batch: {
          // Doubles as the idempotency marker: findByIdempotencyKey looks it up by this name.
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

  async findByIdempotencyKey(key: string): Promise<BatchHandle | null> {
    const list = await this.api<{ batches?: { name?: string; metadata?: { displayName?: string } }[] }>(
      "/batches?pageSize=100",
      { method: "GET" },
    );
    const found = (list.batches ?? []).find((b) => b.metadata?.displayName === key);
    return found?.name ? { handle: found.name, keys: [], idempotencyKey: key } : null;
  }

  async pollBatch(h: BatchHandle): Promise<BatchStatus> {
    const j = await this.api<{
      metadata?: {
        state?: string;
        batchStats?: { requestCount?: string; successfulRequestCount?: string; failedRequestCount?: string };
        output?: { inlinedResponses?: { inlinedResponses?: GeminiItem[] } | GeminiItem[] };
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
    if (!terminal.includes(m.state ?? "")) {
      return { state: m.state === "BATCH_STATE_RUNNING" ? "running" : "pending", counts };
    }
    const raw = m.output?.inlinedResponses;
    const list = (Array.isArray(raw) ? raw : raw?.inlinedResponses) ?? [];
    const items: BatchItemResult[] = [];
    for (const item of list) items.push(await this.itemFrom(item));
    const state: BatchState =
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

  private async itemFrom(item: GeminiItem): Promise<BatchItemResult> {
    const key = item.metadata?.key ?? "";
    const um = item.response?.usageMetadata ?? {};
    const imageIn = modality(um.promptTokensDetails, "IMAGE") ?? 0;
    const billed = {
      textInputTokens: modality(um.promptTokensDetails, "TEXT") ?? Math.max(0, (um.promptTokenCount ?? 0) - imageIn),
      imageInputTokens: imageIn,
      imageOutputTokens: modality(um.candidatesTokensDetails, "IMAGE") ?? um.candidatesTokenCount ?? 0,
    };
    if (item.error)
      return {
        key,
        ok: false,
        code: item.error.status ?? String(item.error.code ?? "error"),
        message: item.error.message ?? "Gemini failed this batch request",
        usage: billed,
      };
    const cand = item.response?.candidates?.[0];
    const img = cand?.content?.parts?.find((p) => p.inlineData?.data && !p.thought)?.inlineData;
    if (!img?.data) {
      const reason = cand?.finishReason ?? "NO_CANDIDATE";
      const policy = /SAFETY|PROHIBITED|BLOCK|RECITATION/i.test(reason);
      return {
        key,
        ok: false,
        code: policy ? "content_policy" : "invalid_response",
        message: `Gemini returned no image (${reason}${cand?.finishMessage ? `: ${cand.finishMessage}` : ""})`,
        usage: billed,
      };
    }
    const data = new Uint8Array(Buffer.from(img.data, "base64"));
    const probed = await probeImage(data);
    return {
      key,
      ok: true,
      result: {
        data,
        mime: probed.mime,
        width: probed.width,
        height: probed.height,
        provider: this.provider,
        model: this.model,
        quality: this.opts.imageSize,
        requestId: null,
        latencyMs: 0,
        usage: { ...billed, cachedInputTokens: 0, raw: um as Record<string, unknown> },
        request: { endpoint: ":batchGenerateContent", size: `${probed.width}x${probed.height}`, referenceCount: 0 },
      },
    };
  }

  async cancelBatch(h: BatchHandle) {
    await this.api(`/${h.handle.replace(/^\//, "")}:cancel`, { method: "POST" }).catch(() => {});
  }

  async releaseBatch() {
    // Nothing to clean up: references are inline, and results expire on Google's side after six weeks.
  }
}
