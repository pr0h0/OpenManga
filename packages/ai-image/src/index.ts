import {
  ConcurrencyLimiter,
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  parseRetryAfter,
  refuseRedirect,
  withRetry,
} from "@openmanga/domain/browser";
import { chooseImageDimensions, probeImage, type SizeOption } from "@openmanga/image-utils";
import type { Logger } from "@openmanga/logger";
import { mockImagePng, scenarioFromText } from "@openmanga/testing";

export * from "./batch.ts";
export { MetaImageProvider, OpenRouterImageProvider } from "./compat.ts";
export { GEMINI_ASPECTS, GeminiImageProvider, geminiAspectFor } from "./gemini.ts";

export type ImageInputFile = { data: Uint8Array; mime: string; label: string };

export type ImageUsage = {
  textInputTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  /** Text/thinking tokens some image models bill alongside the image. */
  textOutputTokens?: number;
  cachedInputTokens: number;
  raw: Record<string, unknown>;
};

export type ImageResult = {
  data: Uint8Array;
  mime: string;
  width: number;
  height: number;
  provider: string;
  model: string;
  quality: string;
  requestId: string | null;
  latencyMs: number;
  usage: ImageUsage;
  request: { endpoint: string; size: string; referenceCount: number };
  /** Words the provider's prompt policy replaced before sending (strict moderators only). */
  softened?: string[];
};

export type GenerateImageRequest = {
  prompt: string;
  aspectRatio: number;
  quality?: string;
  /** Small auxiliary reference derivatives. */
  references: ImageInputFile[];
  label?: string;
  signal?: AbortSignal;
};

export type EditImageRequest = {
  prompt: string;
  /** FULL resolution image being edited. */
  target: ImageInputFile;
  /** FULL resolution mask in provider convention (transparent = editable). */
  mask?: ImageInputFile;
  references: ImageInputFile[];
  quality?: string;
  label?: string;
  signal?: AbortSignal;
};

export interface ImageAIProvider {
  readonly provider: string;
  readonly model: string;
  /** Provider-specific supported sizes; the domain only deals in aspect ratios. */
  sizeFor(aspectRatio: number): SizeOption;
  generate(input: GenerateImageRequest): Promise<ImageResult>;
  edit(input: EditImageRequest): Promise<ImageResult>;
}

type OpenAIImageResponse = {
  created?: number;
  data?: { b64_json?: string; url?: string; revised_prompt?: string }[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_tokens?: number };
    [k: string]: unknown;
  };
  error?: { message?: string; code?: string; type?: string };
};

const extFor = (mime: string) => (mime === "image/webp" ? "webp" : mime === "image/jpeg" ? "jpg" : "png");

/** OpenAI Images API (gpt-image-2). The only module that knows OpenAI request formats. */
export class OpenAIImageProvider implements ImageAIProvider {
  readonly provider = "openai";
  readonly model: string;
  private readonly limiter: ConcurrencyLimiter;

  constructor(
    private readonly opts: {
      apiKey: string;
      baseUrl: string;
      model: string;
      quality: string;
      sizes: SizeOption[];
      timeoutMs: number;
      maxConcurrency: number;
      retries?: number;
      logger?: Logger;
      fetch?: typeof fetch;
    },
  ) {
    if (!opts.apiKey) throw new Error("OPENAI_API_KEY is not configured");
    this.model = opts.model;
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrency);
  }

  sizeFor(aspectRatio: number) {
    return chooseImageDimensions(aspectRatio, this.opts.sizes);
  }

  generate(input: GenerateImageRequest) {
    const size = this.sizeFor(input.aspectRatio);
    const quality = input.quality ?? this.opts.quality;
    const sizeStr = `${size.width}x${size.height}`;
    if (!input.references.length) {
      return this.call("/images/generations", input.signal, sizeStr, quality, 0, () => ({
        body: JSON.stringify({
          model: this.model,
          prompt: input.prompt,
          size: sizeStr,
          quality,
          n: 1,
          output_format: "png",
        }),
        headers: { "content-type": "application/json" },
      }));
    }
    return this.call("/images/edits", input.signal, sizeStr, quality, input.references.length, () => {
      const form = new FormData();
      form.set("model", this.model);
      form.set("prompt", input.prompt);
      form.set("size", sizeStr);
      form.set("quality", quality);
      form.set("n", "1");
      form.set("output_format", "png");
      for (const [i, r] of input.references.entries()) {
        form.append("image[]", new Blob([r.data.slice()], { type: r.mime }), `ref-${i + 1}.${extFor(r.mime)}`);
      }
      return { body: form, headers: {} };
    });
  }

  async edit(input: EditImageRequest) {
    const { width, height } = await probeImage(input.target.data);
    const size = this.sizeFor(width / height);
    const quality = input.quality ?? this.opts.quality;
    const sizeStr = `${size.width}x${size.height}`;
    return this.call("/images/edits", input.signal, sizeStr, quality, input.references.length, () => {
      const form = new FormData();
      form.set("model", this.model);
      form.set("prompt", input.prompt);
      form.set("size", sizeStr);
      form.set("quality", quality);
      form.set("n", "1");
      form.set("output_format", "png");
      form.append(
        "image[]",
        new Blob([input.target.data.slice()], { type: input.target.mime }),
        `target.${extFor(input.target.mime)}`,
      );
      for (const [i, r] of input.references.entries()) {
        form.append("image[]", new Blob([r.data.slice()], { type: r.mime }), `ref-${i + 1}.${extFor(r.mime)}`);
      }
      if (input.mask) form.set("mask", new Blob([input.mask.data.slice()], { type: "image/png" }), "mask.png");
      return { body: form, headers: {} };
    });
  }

  private call(
    endpoint: string,
    signal: AbortSignal | undefined,
    size: string,
    quality: string,
    referenceCount: number,
    build: () => { body: BodyInit; headers: Record<string, string> },
  ): Promise<ImageResult> {
    return withRetry(() => this.limiter.run(() => this.once(endpoint, signal, size, quality, referenceCount, build)), {
      retries: this.opts.retries ?? 2,
      baseMs: 2000,
      onRetry: (e, attempt, delay) => {
        if (e.code === "rate_limited") this.limiter.cooldown(delay);
        this.opts.logger?.warn("openai image retry", {
          code: e.code,
          attempt,
          delayMs: Math.round(delay),
          providerRequestId: e.requestId,
        });
      },
    });
  }

  private async once(
    endpoint: string,
    signal: AbortSignal | undefined,
    size: string,
    quality: string,
    referenceCount: number,
    build: () => { body: BodyInit; headers: Record<string, string> },
  ): Promise<ImageResult> {
    const started = performance.now();
    const { body, headers } = build();
    const s = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs)])
      : AbortSignal.timeout(this.opts.timeoutMs);
    let res: Response;
    try {
      res = await (this.opts.fetch ?? fetch)(`${this.opts.baseUrl.replace(/\/$/, "")}${endpoint}`, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${this.opts.apiKey}` },
        body,
        signal: s,
        redirect: "manual",
      });
    } catch (e) {
      throw classifyFetchError(this.provider, e);
    }
    refuseRedirect(this.provider, res);
    const requestId = res.headers.get("x-request-id");
    const text = await res.text().catch(() => "");
    let json: OpenAIImageResponse = {};
    try {
      json = JSON.parse(text) as OpenAIImageResponse;
    } catch {
      if (res.ok)
        throw new ProviderError(this.provider, "invalid_response", "OpenAI returned non-JSON body", {
          requestId: requestId ?? undefined,
        });
    }
    if (!res.ok) {
      const msg = json.error?.message ?? text.slice(0, 300);
      const isPolicy =
        json.error?.code === "moderation_blocked" ||
        json.error?.code === "content_policy_violation" ||
        /safety system|content policy|moderation/i.test(msg);
      throw new ProviderError(
        this.provider,
        isPolicy ? "content_policy" : classifyHttpStatus(res.status),
        `OpenAI HTTP ${res.status}: ${msg}`,
        {
          status: res.status,
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
          requestId: requestId ?? undefined,
        },
      );
    }
    const u = json.usage ?? {};
    const imageIn = u.input_tokens_details?.image_tokens ?? 0;
    const textIn = u.input_tokens_details?.text_tokens ?? Math.max(0, (u.input_tokens ?? 0) - imageIn);
    // The request was answered, so it was billed: carry what it cost even when the answer is unusable.
    const billed = {
      textInputTokens: textIn,
      imageInputTokens: imageIn,
      imageOutputTokens: u.output_tokens ?? 0,
    };
    const b64 = json.data?.[0]?.b64_json;
    if (!b64)
      throw new ProviderError(this.provider, "invalid_response", "OpenAI response had no image data", {
        requestId: requestId ?? undefined,
        usage: billed,
      });
    const data = new Uint8Array(Buffer.from(b64, "base64"));
    let probed: Awaited<ReturnType<typeof probeImage>>;
    try {
      probed = await probeImage(data);
    } catch {
      throw new ProviderError(this.provider, "invalid_response", "OpenAI returned an invalid image", {
        requestId: requestId ?? undefined,
        usage: billed,
      });
    }
    return {
      data,
      mime: probed.mime,
      width: probed.width,
      height: probed.height,
      provider: this.provider,
      model: this.model,
      quality,
      requestId,
      latencyMs: Math.round(performance.now() - started),
      usage: {
        textInputTokens: textIn,
        imageInputTokens: imageIn,
        imageOutputTokens: u.output_tokens ?? 0,
        cachedInputTokens: u.input_tokens_details?.cached_tokens ?? 0,
        raw: u as Record<string, unknown>,
      },
      request: { endpoint, size, referenceCount },
    };
  }
}

/** Placeholder image generator. Only when AI_MOCK_MODE=true or in tests. Honors [[mock:scenario]] markers. */
export class FakeImageAIProvider implements ImageAIProvider {
  readonly provider = "mock";
  readonly model = "mock-image";
  calls: { endpoint: string; referenceCount: number; targetBytes?: number; maskBytes?: number }[] = [];

  constructor(
    private readonly sizes: SizeOption[] = [
      { width: 1024, height: 1024 },
      { width: 1536, height: 1024 },
      { width: 1024, height: 1536 },
    ],
  ) {}

  sizeFor(aspectRatio: number) {
    return chooseImageDimensions(aspectRatio, this.sizes);
  }

  private check(prompt: string) {
    const sc = scenarioFromText(prompt);
    const fail = (code: ConstructorParameters<typeof ProviderError>[1]) =>
      new ProviderError(this.provider, code, `mock ${sc}`, { requestId: `mock-img-${this.calls.length}` });
    if (sc === "429") throw fail("rate_limited");
    if (sc === "500" || sc === "502" || sc === "503") throw fail("server_error");
    if (sc === "timeout") throw fail("timeout");
    if (sc === "policy") throw fail("content_policy");
    if (sc === "auth") throw fail("auth");
    if (sc === "bad-image") throw fail("invalid_response");
  }

  private async result(
    prompt: string,
    size: SizeOption,
    endpoint: string,
    refs: number,
    label: string | undefined,
    edited: boolean,
  ): Promise<ImageResult> {
    const data = await mockImagePng({ width: size.width, height: size.height, prompt, label, edited });
    return {
      data,
      mime: "image/png",
      width: size.width,
      height: size.height,
      provider: this.provider,
      model: this.model,
      quality: "low",
      requestId: `mock-img-${this.calls.length}`,
      latencyMs: 5,
      usage: {
        textInputTokens: Math.ceil(prompt.length / 4),
        imageInputTokens: refs * 65,
        imageOutputTokens: 272,
        cachedInputTokens: 0,
        raw: { mock: true, input_tokens: Math.ceil(prompt.length / 4) + refs * 65, output_tokens: 272 },
      },
      request: { endpoint, size: `${size.width}x${size.height}`, referenceCount: refs },
    };
  }

  async generate(input: GenerateImageRequest) {
    this.calls.push({
      endpoint: input.references.length ? "/images/edits" : "/images/generations",
      referenceCount: input.references.length,
    });
    this.check(input.prompt);
    return this.result(
      input.prompt,
      this.sizeFor(input.aspectRatio),
      this.calls.at(-1)!.endpoint,
      input.references.length,
      input.label,
      false,
    );
  }

  async edit(input: EditImageRequest) {
    this.calls.push({
      endpoint: "/images/edits",
      referenceCount: input.references.length,
      targetBytes: input.target.data.byteLength,
      maskBytes: input.mask?.data.byteLength,
    });
    this.check(input.prompt);
    const { width, height } = await probeImage(input.target.data);
    return this.result(
      input.prompt,
      this.sizeFor(width / height),
      "/images/edits",
      input.references.length,
      input.label,
      true,
    );
  }
}
