import { videoModelsOf } from "./video-models.ts";

/** Providers users can bring their own key for. Browser-safe: drives the settings form and model pickers. */
export type ProviderKind =
  | "deepseek"
  | "openai"
  | "anthropic"
  | "google"
  | "meta"
  | "openrouter"
  | "elevenlabs"
  | "fal"
  | "openai_compatible";
export type AiCapability = "text" | "image" | "tts" | "video";

export type ProviderCatalogEntry = {
  kind: ProviderKind;
  label: string;
  baseUrl: string | null;
  keyUrl: string | null;
  /** Suggested models; any model id the provider accepts can also be typed in. */
  textModels: string[];
  imageModels: string[];
  ttsModels: string[];
  /** Video models (image-to-video / text-to-video): ids of `VIDEO_MODELS` for this provider. */
  videoModels: string[];
};

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  {
    kind: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com",
    keyUrl: "https://platform.deepseek.com/api_keys",
    textModels: ["deepseek-flash", "deepseek-v4-pro"],
    imageModels: [],
    ttsModels: [],
    videoModels: [],
  },
  {
    kind: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    textModels: ["gpt-5.6-luna", "gpt-5", "gpt-5-mini"],
    imageModels: ["gpt-image-2", "gpt-image-1-mini"],
    ttsModels: ["gpt-4o-mini-tts", "tts-1-hd", "tts-1"],
    videoModels: [],
  },
  {
    kind: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com",
    keyUrl: "https://console.anthropic.com/settings/keys",
    textModels: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"],
    imageModels: [],
    ttsModels: [],
    videoModels: [],
  },
  {
    kind: "google",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    keyUrl: "https://aistudio.google.com/apikey",
    textModels: ["gemini-3.6-flash"],
    imageModels: ["gemini-3.1-flash-lite-image", "gemini-2.5-flash-image", "gemini-3.1-flash-image"],
    ttsModels: ["gemini-2.5-flash-preview-tts", "gemini-2.5-pro-preview-tts"],
    videoModels: [],
  },
  {
    kind: "meta",
    label: "Meta Muse",
    baseUrl: "https://api.meta.ai/v1",
    keyUrl: "https://dev.meta.ai",
    textModels: ["muse-spark-1.3-contributor", "muse-spark-1.3"],
    imageModels: ["muse-image-1.0"],
    ttsModels: [],
    videoModels: [],
  },
  {
    kind: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/settings/keys",
    textModels: ["deepseek/deepseek-chat"],
    imageModels: ["google/gemini-2.5-flash-image"],
    ttsModels: [],
    videoModels: [],
  },
  {
    kind: "elevenlabs",
    label: "ElevenLabs",
    baseUrl: "https://api.elevenlabs.io",
    keyUrl: "https://elevenlabs.io/app/settings/api-keys",
    textModels: [],
    imageModels: [],
    ttsModels: ["eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"],
    videoModels: [],
  },
  {
    kind: "fal",
    label: "fal.ai (video)",
    baseUrl: "https://queue.fal.run",
    keyUrl: "https://fal.ai/dashboard/keys",
    textModels: [],
    imageModels: [],
    ttsModels: [],
    // From the video model catalog, so the picker and the adapter never disagree.
    videoModels: videoModelsOf("fal").map((m) => m.id),
  },
  {
    kind: "openai_compatible",
    label: "OpenAI-compatible (custom URL)",
    baseUrl: null,
    keyUrl: null,
    textModels: [],
    imageModels: [],
    ttsModels: [],
    videoModels: [],
  },
];

export const providerCatalog = (kind: string) => PROVIDER_CATALOG.find((p) => p.kind === kind);
/** A provider's suggested models for a capability. */
export const catalogModels = (p: ProviderCatalogEntry, cap: AiCapability) =>
  cap === "text" ? p.textModels : cap === "image" ? p.imageModels : cap === "tts" ? p.ttsModels : p.videoModels;
export const providerSupports = (kind: string, cap: AiCapability) => {
  const p = providerCatalog(kind);
  if (!p) return false;
  // Custom endpoints may serve text, images or voices; the call fails clearly if the model can't. Never video.
  if (p.kind === "openai_compatible") return cap !== "video";
  return catalogModels(p, cap).length > 0;
};
