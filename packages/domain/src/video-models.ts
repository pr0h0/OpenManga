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
  provider: "local" | "fal";
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
};

/**
 * The free model every server has: the shot's own image with a slow camera move, made by ffmpeg on the worker. No key,
 * no cost. It is also what tests and the demo use in place of a paid model.
 */
export const LOCAL_VIDEO_MODEL = "still-motion";

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
];

export const videoModel = (id: string) => VIDEO_MODELS.find((m) => m.id === id);
export const videoModelsOf = (provider: VideoModel["provider"]) => VIDEO_MODELS.filter((m) => m.provider === provider);

/** The duration a model will make for a wanted length: the shortest it offers at or above it, else its longest. */
export function clipDuration(m: VideoModel, wantedSec: number) {
  const sorted = [...m.durations].sort((a, b) => a - b);
  return sorted.find((d) => d >= wantedSec - 0.05) ?? sorted.at(-1)!;
}

/** The resolution to ask for: the wanted one if the model has it, else its closest lower one, else its lowest. */
export function clipResolution(m: VideoModel, wanted: VideoResolution): VideoResolution {
  const order: VideoResolution[] = ["480p", "720p", "1080p"];
  if (m.resolutions.includes(wanted)) return wanted;
  const lower = order.slice(0, order.indexOf(wanted)).reverse().find((r) => m.resolutions.includes(r));
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
  return Math.round(rate * seconds * 10000) / 10000;
}

/** Rate snapshots for every priced video model, seeded like the other models' rates. */
export const VIDEO_RATE_SNAPSHOTS = VIDEO_MODELS.filter((m) => m.provider !== "local").flatMap((m) =>
  Object.entries(m.pricePerSecond).flatMap(([res, p]) => [
    { model: videoRateModel(m.id, res as VideoResolution, false), rate: p!.silent, provider: m.provider },
    ...(m.audio && p!.audio !== undefined
      ? [{ model: videoRateModel(m.id, res as VideoResolution, true), rate: p!.audio, provider: m.provider }]
      : []),
  ]),
);
