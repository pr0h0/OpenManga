import {
  FakeImageAIProvider,
  GeminiImageBatchProvider,
  GeminiImageProvider,
  type ImageAIProvider,
  type ImageBatchProvider,
  MetaImageProvider,
  OpenAIImageBatchProvider,
  OpenAIImageProvider,
  OpenRouterImageProvider,
} from "@openmanga/ai-image";
import {
  AnthropicTextProvider,
  DeepSeekTextProvider,
  FakeTextAIProvider,
  GeminiTextBatchProvider,
  MetaMuseTextProvider,
  OpenAIChatTextProvider,
  OpenAITextBatchProvider,
  type TextAIProvider,
  type TextBatchProvider,
} from "@openmanga/ai-text";
import {
  ElevenLabsTTSProvider,
  FakeTTSProvider,
  GeminiTTSProvider,
  KokoroTTSProvider,
  OpenAITTSProvider,
  type TTSProvider,
} from "@openmanga/audio";
import type { AppConfig } from "@openmanga/config";
import {
  type AiCapability,
  ProviderError,
  type ProviderKind,
  providerCatalog,
  providerSupports,
} from "@openmanga/domain";
import type { Logger } from "@openmanga/logger";
import { type CredentialService, credentialFingerprint } from "./credentials.ts";

/**
 * There are no server-level provider keys: text and image runs always use a key the user added. The only
 * server-side providers are the in-process fakes for AI_MOCK_MODE (the zero-key demo path) and local TTS.
 */
export function createTextProvider(c: AppConfig): TextAIProvider | null {
  return c.AI_MOCK_MODE ? new FakeTextAIProvider() : null;
}

export function createImageProvider(c: AppConfig): ImageAIProvider | null {
  return c.AI_MOCK_MODE ? new FakeImageAIProvider(c.imageSizes) : null;
}

export function createTTSProvider(c: AppConfig): TTSProvider | null {
  if (!c.TTS_ENABLED) return null;
  return c.TTS_PROVIDER === "fake" ? new FakeTTSProvider() : new KokoroTTSProvider({ url: c.KOKORO_URL });
}

/** What the server itself can run: nothing for text/image unless mocking, local TTS when enabled. */
export function providerInfo(c: AppConfig) {
  return {
    image: c.AI_MOCK_MODE ? { provider: "mock", model: "mock-image", quality: c.IMAGE_QUALITY } : null,
    text: c.AI_MOCK_MODE ? { provider: "mock", model: "mock" } : null,
    tts: c.TTS_ENABLED ? { provider: c.TTS_PROVIDER === "fake" ? "fake-tts" : "kokoro" } : null,
    /** Keys always come from the user; this build has no shared server keys. */
    byokOnly: true as const,
  };
}

/**
 * A per-run provider/model choice. `credentialId` names one of the caller's own keys; without it a run only works
 * in `AI_MOCK_MODE` (fake providers) and is otherwise refused, since this build holds no provider keys of its own.
 * `provider` and `model` are recorded alongside the run for reporting.
 */
export type AiChoice = { credentialId: string | null; provider?: ProviderKind | null; model?: string | null };

/** Shown whenever a run has no key: this build has no server-level provider keys at all. */
export const MISSING_CREDENTIAL =
  "This server has no shared API keys. Add your own provider key in Account → AI providers and pick it for this run.";

function byokText(
  kind: ProviderKind,
  cred: { apiKey: string; baseUrl: string | null },
  model: string,
  c: AppConfig,
  logger?: Logger,
): TextAIProvider {
  const common = {
    apiKey: cred.apiKey,
    model,
    timeoutMs: c.AI_TEXT_TIMEOUT_MS,
    maxConcurrency: c.AI_TEXT_MAX_CONCURRENCY,
    logger,
  };
  const base = cred.baseUrl ?? providerCatalog(kind)?.baseUrl ?? "";
  switch (kind) {
    case "deepseek":
      return new DeepSeekTextProvider({ ...common, baseUrl: base });
    case "anthropic":
      return new AnthropicTextProvider({ ...common, baseUrl: base });
    case "meta":
      return new MetaMuseTextProvider({ ...common, baseUrl: base });
    case "google":
      return new OpenAIChatTextProvider("google", "Google", { ...common, baseUrl: `${base}/openai` });
    case "openrouter":
      return new OpenAIChatTextProvider("openrouter", "OpenRouter", {
        ...common,
        baseUrl: base,
        headers: { "HTTP-Referer": c.APP_PUBLIC_URL, "X-Title": "OpenManga" },
      });
    case "openai":
      return new OpenAIChatTextProvider("openai", "OpenAI", { ...common, baseUrl: base });
    case "openai_compatible":
      return new OpenAIChatTextProvider("openai_compatible", "Custom endpoint", { ...common, baseUrl: base });
    default:
      throw new ProviderError(
        kind,
        "invalid_request",
        `${providerCatalog(kind)?.label ?? kind} does not generate text`,
        {
          retryable: false,
        },
      );
  }
}

function byokTts(kind: ProviderKind, cred: { apiKey: string; baseUrl: string | null }, model: string): TTSProvider {
  const base = cred.baseUrl ?? providerCatalog(kind)?.baseUrl ?? "";
  const common = { apiKey: cred.apiKey, baseUrl: base, model };
  switch (kind) {
    case "openai":
      return new OpenAITTSProvider(common);
    case "openai_compatible":
      return new OpenAITTSProvider(common, "openai_compatible", "Custom endpoint");
    case "google":
      return new GeminiTTSProvider(common);
    case "elevenlabs":
      return new ElevenLabsTTSProvider(common);
    default:
      throw new ProviderError(
        kind,
        "invalid_request",
        `${providerCatalog(kind)?.label ?? kind} does not offer narration voices`,
        {
          retryable: false,
        },
      );
  }
}

function byokImage(
  kind: ProviderKind,
  cred: { apiKey: string; baseUrl: string | null },
  model: string,
  c: AppConfig,
  logger?: Logger,
): ImageAIProvider {
  const base = cred.baseUrl ?? providerCatalog(kind)?.baseUrl ?? "";
  const common = {
    apiKey: cred.apiKey,
    model,
    baseUrl: base,
    timeoutMs: c.AI_IMAGE_TIMEOUT_MS,
    maxConcurrency: c.AI_IMAGE_MAX_CONCURRENCY,
    logger,
  };
  switch (kind) {
    case "openai":
    case "openai_compatible":
      return new OpenAIImageProvider({ ...common, quality: c.IMAGE_QUALITY, sizes: c.imageSizes });
    case "google":
      return new GeminiImageProvider({ ...common, imageSize: "1K" });
    case "meta":
      return new MetaImageProvider(common, c.imageSizes);
    case "openrouter":
      return new OpenRouterImageProvider(common);
    default:
      throw new ProviderError(
        kind,
        "invalid_request",
        `${providerCatalog(kind)?.label ?? kind} does not generate images`,
        {
          retryable: false,
        },
      );
  }
}

/**
 * The batch twin of `byokImage`: null when the provider has no batch API (Meta, OpenRouter, and any custom
 * OpenAI-compatible endpoint, which may or may not implement /v1/batches — we do not assume it does).
 */
export function byokImageBatch(
  kind: ProviderKind,
  cred: { apiKey: string; baseUrl: string | null },
  model: string,
  c: AppConfig,
  logger?: Logger,
): ImageBatchProvider | null {
  const common = {
    apiKey: cred.apiKey,
    model,
    baseUrl: cred.baseUrl ?? providerCatalog(kind)?.baseUrl ?? "",
    timeoutMs: c.AI_IMAGE_TIMEOUT_MS,
    logger,
  };
  switch (kind) {
    case "openai":
      return new OpenAIImageBatchProvider({
        ...common,
        sizes: c.imageSizes,
        maxEnqueuedTokens: c.OPENAI_BATCH_MAX_ENQUEUED_TOKENS,
      });
    case "google":
      // Mirrors the synchronous path: 1K is what every Gemini image run here asks for.
      return new GeminiImageBatchProvider({ ...common, imageSize: "1K" });
    default:
      return null;
  }
}

/** The batch twin of `byokText`. Null when the provider has no batch API (DeepSeek discounts by hour instead). */
export function byokTextBatch(
  kind: ProviderKind,
  cred: { apiKey: string; baseUrl: string | null },
  model: string,
  c: AppConfig,
): TextBatchProvider | null {
  const base = cred.baseUrl ?? providerCatalog(kind)?.baseUrl ?? "";
  const common = { apiKey: cred.apiKey, model, timeoutMs: c.AI_TEXT_TIMEOUT_MS };
  switch (kind) {
    case "openai":
      return new OpenAITextBatchProvider({
        ...common,
        baseUrl: base,
        maxEnqueuedTokens: c.OPENAI_BATCH_MAX_ENQUEUED_TOKENS,
      });
    case "google":
      // The synchronous path uses Gemini's OpenAI-compatibility layer, which has no batch endpoint; batching
      // goes to the native API, where the same model is addressed by its bare name.
      return new GeminiTextBatchProvider({ ...common, baseUrl: base });
    default:
      return null;
  }
}

/**
 * Builds the provider for a run. Instances are cached per credential revision + model so concurrency limiters
 * and rate-limit cooldowns are shared across jobs using the same key.
 */
export class ProviderResolver {
  private readonly cache = new Map<string, TextAIProvider | ImageAIProvider | TTSProvider>();
  private readonly defaults: { text: TextAIProvider | null; image: ImageAIProvider | null; tts: TTSProvider | null };

  constructor(
    private readonly config: AppConfig,
    private readonly credentials: CredentialService,
    private readonly logger?: Logger,
    defaults?: { text: TextAIProvider | null; image: ImageAIProvider | null; tts: TTSProvider | null },
  ) {
    this.defaults = defaults ?? {
      text: createTextProvider(config),
      image: createImageProvider(config),
      tts: createTTSProvider(config),
    };
  }

  /** Only set in AI_MOCK_MODE; there is no shared server key. */
  get defaultText() {
    return this.defaults.text;
  }
  get defaultImage() {
    return this.defaults.image;
  }

  text(choice: AiChoice | null | undefined, userId: string | null) {
    return this.resolve("text", choice, userId) as Promise<TextAIProvider>;
  }
  image(choice: AiChoice | null | undefined, userId: string | null) {
    return this.resolve("image", choice, userId) as Promise<ImageAIProvider>;
  }
  /** Narration voice provider; null only when the server default (Kokoro) is disabled and no key is chosen. */
  tts(choice: AiChoice | null | undefined, userId: string | null) {
    return this.resolve("tts", choice, userId) as Promise<TTSProvider | null>;
  }

  /**
   * Batch provider for a run's choice, or null when batching is not possible: no key (mock mode), or a provider
   * without a batch API. Callers fall back to the synchronous path rather than failing.
   */
  async imageBatch(choice: AiChoice | null | undefined, userId: string | null): Promise<ImageBatchProvider | null> {
    if (!choice?.credentialId || this.config.AI_MOCK_MODE) return null;
    const cred = await this.credentials.resolve(choice.credentialId, userId);
    if (!providerSupports(cred.kind, "image")) return null;
    const chosen = choice.model?.trim() || providerCatalog(cred.kind)?.imageModels[0];
    if (!chosen) return null;
    return byokImageBatch(cred.kind, cred, chosen, this.config, this.logger);
  }

  /** Batch text provider for a choice, or null when batching is impossible (no key, or no batch API). */
  async textBatch(choice: AiChoice | null | undefined, userId: string | null): Promise<TextBatchProvider | null> {
    if (!choice?.credentialId || this.config.AI_MOCK_MODE) return null;
    const cred = await this.credentials.resolve(choice.credentialId, userId);
    if (!providerSupports(cred.kind, "text")) return null;
    const chosen = choice.model?.trim() || providerCatalog(cred.kind)?.textModels[0];
    if (!chosen) return null;
    return byokTextBatch(cred.kind, cred, chosen, this.config);
  }

  /** Reads the choice stored on a job (parameters.ai) and resolves it for the job's user. */
  forJob(cap: AiCapability, job: { parameters: Record<string, unknown>; userId: string | null }) {
    return this.resolve(cap, (job.parameters.ai as AiChoice | undefined) ?? null, job.userId);
  }

  private async resolve(cap: AiCapability, choice: AiChoice | null | undefined, userId: string | null) {
    const model = choice?.model?.trim() || null;
    if (cap === "tts" && !choice?.credentialId) return this.defaults.tts;
    if (!choice?.credentialId) {
      // No shared server keys exist: only the in-process fakes can run without one.
      const mock = this.defaults[cap as "text" | "image"];
      if (mock) return mock;
      throw new ProviderError("openai_compatible", "invalid_request", MISSING_CREDENTIAL, { retryable: false });
    }
    const cred = await this.credentials.resolve(choice.credentialId, userId);
    if (!providerSupports(cred.kind, cap))
      throw new ProviderError(cred.kind, "invalid_request", `${cred.label} can't be used for ${cap} generation`, {
        retryable: false,
      });
    const cat = providerCatalog(cred.kind)!;
    const chosen = model ?? (cap === "text" ? cat.textModels : cap === "image" ? cat.imageModels : cat.ttsModels)[0];
    if (!chosen)
      throw new ProviderError(cred.kind, "invalid_request", `Pick a ${cap} model for ${cred.label}`, {
        retryable: false,
      });
    void this.credentials.touch(cred.id).catch(() => {});
    if (this.config.AI_MOCK_MODE)
      return cap === "tts" ? (this.defaults.tts ?? new FakeTTSProvider()) : (this.defaults[cap] ?? null);
    return this.cached(`${cap}:${credentialFingerprint(cred, chosen)}`, () =>
      cap === "text"
        ? byokText(cred.kind, cred, chosen, this.config, this.logger)
        : cap === "image"
          ? byokImage(cred.kind, cred, chosen, this.config, this.logger)
          : byokTts(cred.kind, cred, chosen),
    );
  }

  private cached<T extends TextAIProvider | ImageAIProvider | TTSProvider>(key: string, make: () => T): T {
    const hit = this.cache.get(key);
    if (hit) return hit as T;
    // ponytail: simple size cap; an LRU would keep hot keys longer if many users bring keys.
    if (this.cache.size > 200) this.cache.clear();
    const p = make();
    this.cache.set(key, p);
    return p;
  }
}
