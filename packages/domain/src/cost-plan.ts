import { estimateCostUsd, type RateSnapshot, type UsageTokens } from "./cost.ts";

/** The work a production run pays for, one unit each: a job per chapter, page, panel, reference or project. */
export type PlanKind =
  | "story_analysis"
  | "chapter_plan"
  | "page_prompts"
  | "narration_text"
  | "youtube_package"
  | "panel_generation"
  | "reference"
  | "thumbnail";

const tokens = (textIn: number, textOut: number, image = 0, imageIn = 0): UsageTokens => ({
  textInputTokens: textIn,
  cachedInputTokens: 0,
  textOutputTokens: textOut,
  imageInputTokens: imageIn,
  imageOutputTokens: image,
  images: image ? 1 : 0,
});

/**
 * What one unit of each kind uses when this server has no history of it yet: typical requests from the built-in
 * templates. A real run's averages (`usageHistory`) replace them as soon as there are any.
 */
export const DEFAULT_UNIT_USAGE: Record<PlanKind, UsageTokens> = {
  story_analysis: tokens(18_000, 9_000),
  chapter_plan: tokens(14_000, 12_000),
  page_prompts: tokens(6_000, 2_500),
  narration_text: tokens(9_000, 4_000),
  youtube_package: tokens(6_000, 2_000),
  panel_generation: tokens(1_200, 0, 400, 300),
  reference: tokens(900, 0, 400, 0),
  thumbnail: tokens(1_200, 0, 400, 300),
};

/** Kinds priced with the image model; the rest use the text model. */
export const IMAGE_KINDS: ReadonlySet<PlanKind> = new Set(["panel_generation", "reference", "thumbnail"]);

/**
 * The price of `count` units of a kind with the chosen model's rate: from this server's average usage per unit when
 * it has one, else the defaults. Null when the model has no known price (the plan says so rather than guessing).
 */
export function planUnitsUsd(
  kind: PlanKind,
  count: number,
  rate: RateSnapshot | null,
  history: Partial<Record<PlanKind, UsageTokens>> = {},
): number | null {
  if (!count) return 0;
  if (!rate) return null;
  return estimateCostUsd(history[kind] ?? DEFAULT_UNIT_USAGE[kind], rate) * count;
}

/** Bytes of 24 kHz mono 16-bit WAV, the format narration is stored in, per second of speech. */
export const NARRATION_BYTES_PER_SECOND = 48_000;

/** Seconds of narration for a word count at a speaking rate. */
export const narrationSeconds = (words: number, wordsPerMinute = 150) => (words / wordsPerMinute) * 60;

/** Sum of nullable prices: null as soon as one part has no price. */
export const sumUsd = (parts: (number | null)[]) =>
  parts.some((p) => p === null) ? null : parts.reduce<number>((n, p) => n + (p ?? 0), 0);
