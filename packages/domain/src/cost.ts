export type RateSnapshot = {
  id?: string;
  provider: string;
  model: string;
  effectiveFrom: Date | string;
  /** USD per 1M tokens */
  textInputRate: number;
  cachedInputRate: number;
  textOutputRate: number;
  imageInputRate: number;
  imageOutputRate: number;
  /** USD per generated image (flat-priced image providers). */
  imageUnitRate?: number;
  /** USD per 1M characters (speech providers bill by input text length, not tokens). */
  characterRate?: number;
};

export type UsageTokens = {
  textInputTokens: number;
  cachedInputTokens: number;
  textOutputTokens: number;
  imageInputTokens: number;
  imageOutputTokens: number;
  /** Number of generated images, for flat per-image pricing. */
  images?: number;
  /** Characters sent to a speech provider. */
  characters?: number;
};

/** Estimated USD cost from real token counts and a rate snapshot. cachedInputTokens are a subset of textInputTokens. */
export function estimateCostUsd(u: UsageTokens, r: RateSnapshot | null): number {
  if (!r) return 0;
  const uncached = Math.max(0, u.textInputTokens - u.cachedInputTokens);
  const usd =
    (uncached * r.textInputRate +
      u.cachedInputTokens * r.cachedInputRate +
      u.textOutputTokens * r.textOutputRate +
      u.imageInputTokens * r.imageInputRate +
      u.imageOutputTokens * r.imageOutputRate +
      (u.characters ?? 0) * (r.characterRate ?? 0)) /
      1_000_000 +
    (u.images ?? 0) * (r.imageUnitRate ?? 0);
  return Math.round(usd * 1e8) / 1e8;
}

/** Pick the latest snapshot effective at `at` for provider/model. */
export function selectRate(rates: RateSnapshot[], provider: string, model: string, at: Date): RateSnapshot | null {
  let best: RateSnapshot | null = null;
  for (const r of rates) {
    if (r.provider !== provider || r.model !== model) continue;
    const eff = new Date(r.effectiveFrom);
    if (eff > at) continue;
    if (!best || eff > new Date(best.effectiveFrom)) best = r;
  }
  return best;
}

/**
 * Seed rates. These are editable configuration rows (provider_rate_snapshots), NOT authoritative prices.
 * Verify against provider pricing pages and insert a new snapshot when prices change.
 */
export const DEFAULT_RATE_SNAPSHOTS: Omit<RateSnapshot, "id">[] = [
  {
    provider: "deepseek",
    model: "deepseek-v4-flash",
    effectiveFrom: "2026-01-01T00:00:00Z",
    textInputRate: 0.27,
    cachedInputRate: 0.07,
    textOutputRate: 1.1,
    imageInputRate: 0,
    imageOutputRate: 0,
  },
  // DeepSeek prices flash by time of day (off-peak $0.15/$0.60, peak $0.30/$1.20 per 1M). A snapshot is a flat
  // rate, so the peak numbers are seeded: the dashboard may over-report off-peak spend but never under-reports.
  {
    provider: "deepseek",
    model: "deepseek-flash",
    effectiveFrom: "2026-09-16T00:00:00Z",
    textInputRate: 0.3,
    cachedInputRate: 0.006,
    textOutputRate: 1.2,
    imageInputRate: 0,
    imageOutputRate: 0,
  },
  {
    provider: "openai",
    model: "gpt-5.6-luna",
    effectiveFrom: "2026-09-16T00:00:00Z",
    textInputRate: 0.2,
    cachedInputRate: 0.02,
    textOutputRate: 1.2,
    imageInputRate: 0,
    imageOutputRate: 0,
  },
  {
    provider: "openai",
    model: "gpt-5-mini",
    effectiveFrom: "2026-09-16T00:00:00Z",
    textInputRate: 0.25,
    cachedInputRate: 0.025,
    textOutputRate: 2,
    imageInputRate: 0,
    imageOutputRate: 0,
  },
  {
    provider: "openai",
    model: "gpt-image-2",
    effectiveFrom: "2026-01-01T00:00:00Z",
    textInputRate: 5,
    cachedInputRate: 1.25,
    textOutputRate: 0,
    imageInputRate: 10,
    imageOutputRate: 40,
  },
  // Meta Muse Spark: the "-contributor" tier is cheaper because Meta may train on prompts/completions.
  {
    provider: "meta",
    model: "muse-spark-1.3-contributor",
    effectiveFrom: "2026-01-01T00:00:00Z",
    textInputRate: 0.1,
    cachedInputRate: 0.1,
    textOutputRate: 0.2,
    imageInputRate: 0,
    imageOutputRate: 0,
  },
  {
    provider: "meta",
    model: "muse-spark-1.3",
    effectiveFrom: "2026-01-01T00:00:00Z",
    textInputRate: 1.25,
    cachedInputRate: 1.25,
    textOutputRate: 4.25,
    imageInputRate: 0,
    imageOutputRate: 0,
  },
  {
    provider: "meta",
    model: "muse-image-1.0",
    effectiveFrom: "2026-01-01T00:00:00Z",
    textInputRate: 0,
    cachedInputRate: 0,
    textOutputRate: 0,
    imageInputRate: 0,
    imageOutputRate: 0,
    imageUnitRate: 0.01,
  },
  // Gemini bills image output per token (~1120 tokens for a 1K image); text/thinking output at the text rate.
  {
    provider: "google",
    model: "gemini-3.1-flash-lite-image",
    effectiveFrom: "2026-01-01T00:00:00Z",
    textInputRate: 0.25,
    cachedInputRate: 0.025,
    textOutputRate: 1.5,
    imageInputRate: 0.25,
    imageOutputRate: 30,
  },
  {
    provider: "google",
    model: "gemini-2.5-flash-image",
    effectiveFrom: "2026-01-01T00:00:00Z",
    textInputRate: 0.3,
    cachedInputRate: 0.03,
    textOutputRate: 2.5,
    imageInputRate: 0.3,
    imageOutputRate: 30,
  },
  {
    provider: "google",
    model: "gemini-3.1-flash-image",
    effectiveFrom: "2026-01-01T00:00:00Z",
    textInputRate: 0.5,
    cachedInputRate: 0.05,
    textOutputRate: 3,
    imageInputRate: 0.5,
    imageOutputRate: 60,
  },
  // The stub providers and local Kokoro bill nothing. They are priced at zero rather than left unpriced, so demo
  // runs do not show up as "spend we could not compute".
  {
    provider: "mock",
    model: "mock",
    effectiveFrom: "2020-01-01T00:00:00Z",
    textInputRate: 0,
    cachedInputRate: 0,
    textOutputRate: 0,
    imageInputRate: 0,
    imageOutputRate: 0,
  },
  {
    provider: "mock",
    model: "mock-image",
    effectiveFrom: "2020-01-01T00:00:00Z",
    textInputRate: 0,
    cachedInputRate: 0,
    textOutputRate: 0,
    imageInputRate: 0,
    imageOutputRate: 0,
  },
  {
    provider: "fake-tts",
    model: "fake",
    effectiveFrom: "2020-01-01T00:00:00Z",
    textInputRate: 0,
    cachedInputRate: 0,
    textOutputRate: 0,
    imageInputRate: 0,
    imageOutputRate: 0,
  },
];

/**
 * Providers with an asynchronous batch API: submit many requests, collect within 24h, pay half. DeepSeek is
 * absent deliberately — it discounts by time of day (off-peak windows), not through a batch endpoint, so there
 * is nothing to submit to. Meta and OpenRouter expose no batch API.
 */
export const BATCH_CAPABLE_PROVIDERS = new Set(["openai", "google", "anthropic"]);

/**
 * Batch runs are recorded against a suffixed model so their spend is priced and reported separately. The suffix
 * is applied at the single point where usage is recorded; everything upstream (catalogs, model validation, the
 * job's own provider/model columns) keeps the plain name.
 */
export const BATCH_MODEL_SUFFIX = ":batch";
export const batchModel = (model: string) => (isBatchModel(model) ? model : `${model}${BATCH_MODEL_SUFFIX}`);
export const isBatchModel = (model: string) => model.endsWith(BATCH_MODEL_SUFFIX);
export const baseModel = (model: string) => (isBatchModel(model) ? model.slice(0, -BATCH_MODEL_SUFFIX.length) : model);

/** Half-price twin of every batch-capable rate, derived so a new model or a price change needs no second edit. */
export const BATCH_RATE_SNAPSHOTS: Omit<RateSnapshot, "id">[] = DEFAULT_RATE_SNAPSHOTS.filter((r) =>
  BATCH_CAPABLE_PROVIDERS.has(r.provider),
).map((r) => ({
  ...r,
  model: batchModel(r.model),
  textInputRate: r.textInputRate / 2,
  cachedInputRate: r.cachedInputRate / 2,
  textOutputRate: r.textOutputRate / 2,
  imageInputRate: r.imageInputRate / 2,
  imageOutputRate: r.imageOutputRate / 2,
  ...(r.imageUnitRate === undefined ? {} : { imageUnitRate: r.imageUnitRate / 2 }),
  ...(r.characterRate === undefined ? {} : { characterRate: r.characterRate / 2 }),
}));

/** Rough pre-flight estimate for confirmation dialogs (not used for accounting). */
export function estimateImageBatchUsd(count: number, perImageOutputTokens = 400, rate?: RateSnapshot | null) {
  if (!rate) return null;
  return (
    estimateCostUsd(
      {
        textInputTokens: 1200,
        cachedInputTokens: 0,
        textOutputTokens: 0,
        imageInputTokens: 300,
        imageOutputTokens: perImageOutputTokens,
        images: 1,
      },
      rate,
    ) * count
  );
}
