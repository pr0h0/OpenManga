/**
 * Video models a shot's clip can be generated with. Browser-safe: drives the clip picker, the cost estimate and the
 * adapter's request (which fields a model takes). Prices are list prices in USD per generated second, NOT
 * authoritative: they seed the rate table (provider_rate_snapshots) like every other model's.
 */

export type VideoResolution = "480p" | "720p" | "1080p";
export type VideoClipAspect = "16:9" | "9:16" | "1:1";

export type VideoModel = {
  /** The id runs record and the adapter calls (a fal endpoint id for fal). */
  id: string;
  /** Who runs it: this server, fal.ai, or a provider's own API (a ProviderKind with this model in its videoModels). */
  provider: "local" | "fal" | "google" | "kling" | "runway" | "minimax" | "byteplus";
  label: string;
  /** Whether it animates a starting image, writes a clip from the prompt alone, or both. */
  imageToVideo: boolean;
  textToVideo: boolean;
  /** Clip lengths it accepts, in seconds (the closest one at or above what is asked is used). */
  durations: number[];
  resolutions: VideoResolution[];
  aspects: VideoClipAspect[];
  /** Takes an end frame to land on (first-and-last-frame generation). */
  endFrame: boolean;
  /** Can generate sound with the picture. */
  audio: boolean;
  /** USD per second by resolution, without and with generated audio. */
  pricePerSecond: Partial<Record<VideoResolution, { silent: number; audio?: number }>>;
  /** What reviews say it is good at, shown next to it. */
  note: string;
  /** Endpoint for text-to-video when it differs from the image-to-video one (fal splits them). */
  textEndpoint?: string;
  /** A flat fee per clip on top of the per-second price (an input-image fee). */
  perClipUsd?: number;
};

/**
 * The free model every server has: the shot's own image with a slow camera move, made by ffmpeg on the worker. No key,
 * no cost. It is also what tests and the demo use in place of a paid model.
 */
export const LOCAL_VIDEO_MODEL = "still-motion";

// Seedance bills tokens: width × height × 24 fps × seconds / 1024, at $1 per 1M tokens for 1.0 Pro Fast.
const seedanceFast = (w: number, h: number) => Math.round(((w * h * 24) / 1024 / 1e6) * 1e6) / 1e6;

/**
 * fal models, from fal's model pages (2026-10; sources in docs/VIDEO_PROVIDERS.md). List prices: check fal's pricing
 * before relying on them, and add a new rate snapshot when they change.
 */
export const VIDEO_MODELS: VideoModel[] = [
  {
    id: LOCAL_VIDEO_MODEL,
    provider: "local",
    label: "Still motion (free, on this server)",
    imageToVideo: true,
    textToVideo: false,
    durations: [3, 4, 5, 6, 8, 10],
    resolutions: ["480p", "720p", "1080p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: false,
    audio: false,
    pricePerSecond: { "480p": { silent: 0 }, "720p": { silent: 0 }, "1080p": { silent: 0 } },
    note: "The shot's image with a slow camera move. Nothing moves inside the picture. Free, for drafts and tests.",
  },
  {
    id: "fal-ai/bytedance/seedance/v1/pro/fast/image-to-video",
    provider: "fal",
    label: "Seedance 1.0 Pro Fast",
    imageToVideo: true,
    textToVideo: false,
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    resolutions: ["480p", "720p", "1080p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: false,
    audio: false,
    pricePerSecond: {
      "480p": { silent: seedanceFast(864, 480) },
      "720p": { silent: seedanceFast(1280, 720) },
      "1080p": { silent: seedanceFast(1920, 1080) },
    },
    note: "The cheapest real motion: about $0.05 for 5 s at 480p. Realistic and anime both fine. No end frame.",
  },
  {
    id: "xai/grok-imagine-video/v1.5/lite/image-to-video",
    provider: "fal",
    label: "Grok Imagine 1.5 Lite",
    imageToVideo: true,
    textToVideo: false,
    durations: [3, 4, 5, 6, 8, 10, 12, 15],
    resolutions: ["480p", "720p", "1080p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: false,
    audio: false,
    pricePerSecond: { "480p": { silent: 0.02 }, "720p": { silent: 0.03 }, "1080p": { silent: 0.14 } },
    perClipUsd: 0.01,
    note: "Very cheap drafts (plus $0.01 per clip for the image).",
  },
  {
    id: "fal-ai/minimax/hailuo-02/standard/image-to-video",
    provider: "fal",
    label: "Hailuo 02 Standard",
    imageToVideo: true,
    textToVideo: false,
    durations: [6, 10],
    resolutions: ["480p", "720p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: true,
    audio: false,
    // 480p is MiniMax's 512P, 720p its 768P.
    pricePerSecond: { "480p": { silent: 0.017 }, "720p": { silent: 0.045 } },
    note: "Good physics, liked for stylised and anime looks. 6 or 10 s only. Lands on an end frame.",
  },
  {
    id: "fal-ai/wan-25-preview/image-to-video",
    provider: "fal",
    label: "Wan 2.5",
    imageToVideo: true,
    textToVideo: true,
    textEndpoint: "fal-ai/wan-25-preview/text-to-video",
    durations: [5, 10],
    resolutions: ["480p", "720p", "1080p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: false,
    audio: false,
    pricePerSecond: { "480p": { silent: 0.05 }, "720p": { silent: 0.1 }, "1080p": { silent: 0.15 } },
    note: "Open model, general purpose; also makes a shot from words alone.",
  },
  {
    id: "fal-ai/pixverse/v6/image-to-video",
    provider: "fal",
    label: "PixVerse v6",
    imageToVideo: true,
    textToVideo: false,
    durations: [3, 4, 5, 6, 8, 10],
    resolutions: ["480p", "720p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: false,
    audio: true,
    // 480p is PixVerse's 540p.
    pricePerSecond: { "480p": { silent: 0.036 }, "720p": { silent: 0.045, audio: 0.06 } },
    note: "Has an anime style setting, used for manga and cartoon looks.",
  },
  {
    id: "fal-ai/kling-video/v2.5-turbo/pro/image-to-video",
    provider: "fal",
    label: "Kling 2.5 Turbo Pro",
    imageToVideo: true,
    textToVideo: true,
    textEndpoint: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    durations: [5, 10],
    resolutions: ["1080p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: true,
    audio: false,
    pricePerSecond: { "1080p": { silent: 0.07 } },
    note: "Realistic, strong motion; lands on an end frame. $0.35 for 5 s.",
  },
  {
    id: "fal-ai/kling-video/v3/standard/image-to-video",
    provider: "fal",
    label: "Kling 3 Standard",
    imageToVideo: true,
    textToVideo: false,
    durations: [3, 4, 5, 6, 8, 10, 12, 15],
    resolutions: ["720p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: true,
    audio: true,
    pricePerSecond: { "720p": { silent: 0.084, audio: 0.126 } },
    note: "Cinematic, realistic and good at stylised looks; sound on request.",
  },
  {
    id: "fal-ai/veo3.1/fast/image-to-video",
    provider: "fal",
    label: "Veo 3.1 Fast",
    imageToVideo: true,
    textToVideo: true,
    textEndpoint: "fal-ai/veo3.1/fast",
    durations: [4, 6, 8],
    resolutions: ["720p", "1080p"],
    aspects: ["16:9", "9:16"],
    endFrame: false,
    audio: true,
    pricePerSecond: { "720p": { silent: 0.1, audio: 0.15 }, "1080p": { silent: 0.1, audio: 0.15 } },
    note: "Polished realism with sound. Check it is still offered on fal before relying on it.",
  },
  // Providers' own APIs (docs/VIDEO_PROVIDERS.md §2–3). Each runs on the user's key for that provider.
  {
    id: "veo-3.1-fast-generate-preview",
    provider: "google",
    label: "Veo 3.1 Fast (Google)",
    imageToVideo: true,
    textToVideo: true,
    durations: [4, 6, 8],
    // 1080p only allows 8 s on the Gemini API; 720p takes every length.
    resolutions: ["720p"],
    aspects: ["16:9", "9:16"],
    endFrame: true,
    // Always made with sound on the Gemini API, and priced with it.
    audio: true,
    pricePerSecond: { "720p": { silent: 0.1, audio: 0.1 } },
    note: "Realism with sound, on a Gemini API key; cheaper than Veo on fal. Preview model.",
  },
  {
    id: "veo-3.1-lite-generate-preview",
    provider: "google",
    label: "Veo 3.1 Lite (Google)",
    imageToVideo: true,
    textToVideo: true,
    durations: [4, 6, 8],
    resolutions: ["720p"],
    aspects: ["16:9", "9:16"],
    endFrame: true,
    audio: true,
    pricePerSecond: { "720p": { silent: 0.05, audio: 0.05 } },
    note: "Cheapest Veo, with sound, on a Gemini API key. Preview model.",
  },
  {
    id: "kling-3.0",
    provider: "kling",
    label: "Kling 3.0 (Kling)",
    imageToVideo: true,
    textToVideo: false,
    durations: [3, 4, 5, 6, 8, 10, 12, 15],
    resolutions: ["720p", "1080p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: true,
    audio: true,
    pricePerSecond: { "720p": { silent: 0.084, audio: 0.126 }, "1080p": { silent: 0.112, audio: 0.168 } },
    note: "Kling's own API: cinematic, realistic, good stylisation; sound on request.",
  },
  {
    id: "gen4_turbo",
    provider: "runway",
    label: "Runway Gen-4 Turbo (Runway)",
    imageToVideo: true,
    textToVideo: false,
    durations: [2, 3, 4, 5, 6, 7, 8, 9, 10],
    resolutions: ["720p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: false,
    audio: false,
    pricePerSecond: { "720p": { silent: 0.05 } },
    note: "Realistic. A refused (moderated) clip is still billed by Runway.",
  },
  {
    id: "MiniMax-Hailuo-02",
    provider: "minimax",
    label: "Hailuo 02 (MiniMax)",
    imageToVideo: true,
    textToVideo: false,
    durations: [6, 10],
    // 480p is MiniMax's 512P, 720p its 768P.
    resolutions: ["480p", "720p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: false,
    audio: false,
    pricePerSecond: { "480p": { silent: 0.0167 }, "720p": { silent: 0.045 } },
    note: "MiniMax's own API: stylised and anime looks, good physics. 6 or 10 s.",
  },
  {
    id: "MiniMax-Hailuo-2.3",
    provider: "minimax",
    label: "Hailuo 2.3 (MiniMax)",
    imageToVideo: true,
    textToVideo: false,
    durations: [6, 10],
    resolutions: ["720p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: false,
    audio: false,
    pricePerSecond: { "720p": { silent: 0.0467 } },
    note: "Newer Hailuo on MiniMax's own API, 768P. 6 or 10 s.",
  },
  {
    id: "seedance-1-5-pro-251215",
    provider: "byteplus",
    label: "Seedance 1.5 Pro (BytePlus)",
    imageToVideo: true,
    textToVideo: true,
    durations: [4, 5, 6, 7, 8, 9, 10, 11, 12],
    resolutions: ["480p", "720p", "1080p"],
    aspects: ["16:9", "9:16", "1:1"],
    endFrame: true,
    audio: true,
    // BytePlus bills tokens; its page could not be read, so these are fal's rates for the same model (a proxy).
    pricePerSecond: {
      "480p": { silent: 0.0117, audio: 0.0233 },
      "720p": { silent: 0.0259, audio: 0.0518 },
      "1080p": { silent: 0.0583, audio: 0.1166 },
    },
    note: "ByteDance's own API (ModelArk): realistic and anime, end frame, sound. Prices are estimates.",
  },
];

export const videoModel = (id: string) => VIDEO_MODELS.find((m) => m.id === id);
export const videoModelsOf = (provider: VideoModel["provider"]) => VIDEO_MODELS.filter((m) => m.provider === provider);

/** Longest single clip, total length and parts of a long shot (each part continues from the last one's final frame). */
export const MAX_SHOT_SECONDS = 60;
export const MAX_SHOT_PARTS = 12;

/**
 * How a shot of `seconds` is made with a model: one clip when the model can make it at once, else parts of `part`
 * seconds (the asked part length, or the longest the model makes), each continuing from the last frame of the one
 * before. 20 s on a model of 5 and 10 s is 2 × 10 s; with parts of 5 s, 4 × 5 s.
 */
export function clipPlan(m: VideoModel, seconds: number, partSeconds?: number | null) {
  const longest = Math.max(...m.durations);
  const want = Math.min(seconds, MAX_SHOT_SECONDS);
  if (!partSeconds && want <= longest + 0.05)
    return { parts: 1, part: clipDuration(m, want), total: clipDuration(m, want) };
  const part = clipDuration(m, Math.min(partSeconds ?? longest, longest));
  const parts = Math.min(MAX_SHOT_PARTS, Math.max(1, Math.ceil((want - 0.05) / part)));
  return { parts, part, total: parts * part };
}

/** The duration a model will make for a wanted length: the shortest it offers at or above it, else its longest. */
export function clipDuration(m: VideoModel, wantedSec: number) {
  const sorted = [...m.durations].sort((a, b) => a - b);
  return sorted.find((d) => d >= wantedSec - 0.05) ?? sorted.at(-1)!;
}

/** The resolution to ask for: the wanted one if the model has it, else its closest lower one, else its lowest. */
export function clipResolution(m: VideoModel, wanted: VideoResolution): VideoResolution {
  const order: VideoResolution[] = ["480p", "720p", "1080p"];
  if (m.resolutions.includes(wanted)) return wanted;
  const lower = order
    .slice(0, order.indexOf(wanted))
    .reverse()
    .find((r) => m.resolutions.includes(r));
  return lower ?? m.resolutions[0]!;
}

/**
 * How a run is priced: the model id with its resolution and sound, the key its rate snapshot is stored under (prices
 * differ by both, as batch pricing differs by the `:batch` suffix).
 */
export const videoRateModel = (id: string, resolution: VideoResolution, audio: boolean) =>
  `${id}@${resolution}${audio ? "+audio" : ""}`;

/** List price of one clip, USD. */
export function estimateClipUsd(m: VideoModel, seconds: number, resolution: VideoResolution, audio: boolean) {
  const p = m.pricePerSecond[resolution] ?? Object.values(m.pricePerSecond)[0];
  if (!p) return 0;
  const rate = audio && m.audio ? (p.audio ?? p.silent) : p.silent;
  return Math.round((rate * seconds + (m.perClipUsd ?? 0)) * 10000) / 10000;
}

/** Rate snapshots for every priced video model, seeded like the other models' rates. */
export const VIDEO_RATE_SNAPSHOTS = VIDEO_MODELS.filter((m) => m.provider !== "local").flatMap((m) =>
  Object.entries(m.pricePerSecond).flatMap(([res, p]) => {
    const base = { provider: m.provider, perClip: m.perClipUsd ?? 0 };
    return [
      { ...base, model: videoRateModel(m.id, res as VideoResolution, false), rate: p!.silent },
      ...(m.audio && p!.audio !== undefined
        ? [{ ...base, model: videoRateModel(m.id, res as VideoResolution, true), rate: p!.audio }]
        : []),
    ];
  }),
);
