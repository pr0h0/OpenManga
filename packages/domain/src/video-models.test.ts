import { expect, test } from "bun:test";
import { DEFAULT_RATE_SNAPSHOTS, estimateCostUsd, estimateImageBatchUsd, imageUnitUsage, selectRate } from "./cost.ts";
import { providerCatalog, providerSupports } from "./providers.ts";
import {
  clipDuration,
  clipPlan,
  clipResolution,
  estimateClipUsd,
  LOCAL_VIDEO_MODEL,
  VIDEO_MODELS,
  videoModel,
  videoRateModel,
} from "./video-models.ts";

test("a wanted length becomes the shortest the model offers at or above it, else its longest", () => {
  const kling = videoModel("fal-ai/kling-video/v2.5-turbo/pro/image-to-video")!;
  expect(clipDuration(kling, 3)).toBe(5);
  expect(clipDuration(kling, 7)).toBe(10);
  expect(clipDuration(kling, 30)).toBe(10);
});

test("a wanted resolution falls back to the closest lower one the model has", () => {
  const hailuo = videoModel("fal-ai/minimax/hailuo-02/standard/image-to-video")!;
  expect(clipResolution(hailuo, "1080p")).toBe("720p");
  const kling = videoModel("fal-ai/kling-video/v2.5-turbo/pro/image-to-video")!;
  expect(clipResolution(kling, "480p")).toBe("1080p");
});

test("clip prices: per second by resolution and sound, plus a per-clip fee; the free model costs nothing", () => {
  expect(estimateClipUsd(videoModel(LOCAL_VIDEO_MODEL)!, 10, "1080p", false)).toBe(0);
  const veo = videoModel("fal-ai/veo3.1/fast/image-to-video")!;
  expect(estimateClipUsd(veo, 8, "720p", false)).toBeCloseTo(0.8, 6);
  expect(estimateClipUsd(veo, 8, "720p", true)).toBeCloseTo(1.2, 6);
  const grok = videoModel("xai/grok-imagine-video/v1.5/lite/image-to-video")!;
  expect(estimateClipUsd(grok, 5, "720p", false)).toBeCloseTo(0.16, 6);
  // Seedance 1.0 Pro Fast: about 5 cents for 5 s at 480p.
  const seedance = videoModel("fal-ai/bytedance/seedance/v1/pro/fast/image-to-video")!;
  expect(estimateClipUsd(seedance, 5, "480p", false)).toBeCloseTo(0.0486, 3);
});

test("every priced model is seeded as a rate, and usage is costed from it like any other model", () => {
  for (const m of VIDEO_MODELS.filter((x) => x.provider !== "local"))
    for (const res of Object.keys(m.pricePerSecond))
      expect(DEFAULT_RATE_SNAPSHOTS.some((r) => r.model === videoRateModel(m.id, res as "720p", false))).toBe(true);
  const at = new Date("2026-10-13T00:00:00Z");
  const rate = selectRate(
    DEFAULT_RATE_SNAPSHOTS.map((r) => ({ ...r })),
    "fal",
    videoRateModel("fal-ai/veo3.1/fast/image-to-video", "720p", true),
    at,
  );
  const usage = {
    textInputTokens: 0,
    cachedInputTokens: 0,
    textOutputTokens: 0,
    imageInputTokens: 0,
    imageOutputTokens: 0,
  };
  expect(estimateCostUsd({ ...usage, videoSeconds: 8, images: 1 }, rate)).toBeCloseTo(1.2, 6);
  const grok = selectRate(
    DEFAULT_RATE_SNAPSHOTS.map((r) => ({ ...r })),
    "fal",
    videoRateModel("xai/grok-imagine-video/v1.5/lite/image-to-video", "720p", false),
    at,
  );
  expect(estimateCostUsd({ ...usage, videoSeconds: 5, images: 1 }, grok)).toBeCloseTo(0.16, 6);
});

test("fal is a video-only provider; a custom endpoint is never offered for video", () => {
  expect(providerSupports("fal", "video")).toBe(true);
  expect(providerSupports("fal", "image")).toBe(false);
  expect(providerSupports("openai_compatible", "video")).toBe(false);
  expect(providerCatalog("fal")!.videoModels).toEqual(
    VIDEO_MODELS.filter((m) => m.provider === "fal").map((m) => m.id),
  );
});

test("a long shot is made in parts of the model's longest clip, or of the part length asked for", () => {
  const kling = videoModel("fal-ai/kling-video/v2.5-turbo/pro/image-to-video")!;
  expect(clipPlan(kling, 8)).toEqual({ parts: 1, part: 10, total: 10 });
  expect(clipPlan(kling, 20)).toEqual({ parts: 2, part: 10, total: 20 });
  expect(clipPlan(kling, 20, 5)).toEqual({ parts: 4, part: 5, total: 20 });
  expect(clipPlan(kling, 22, 5)).toEqual({ parts: 5, part: 5, total: 25 });
  // Never more than a minute or twelve parts.
  expect(clipPlan(videoModel(LOCAL_VIDEO_MODEL)!, 200, 3).parts).toBeLessThanOrEqual(12);
});

test("every direct provider's models are in its catalog entry, and unknown to the others", () => {
  for (const kind of ["google", "kling", "runway", "minimax", "byteplus"] as const) {
    const ids = VIDEO_MODELS.filter((m) => m.provider === kind).map((m) => m.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(providerCatalog(kind)!.videoModels).toEqual(ids);
  }
});

test("image estimates follow the quality: low, medium and high gpt-image-2 images are priced like real runs", () => {
  const rate = DEFAULT_RATE_SNAPSHOTS.find((r) => r.provider === "openai" && r.model === "gpt-image-2")!;
  const one = (q: string) => estimateImageBatchUsd(1, imageUnitUsage("openai", q), rate)!;
  // Measured on real runs: about $0.015 at low and $0.067 at medium.
  expect(one("low")).toBeCloseTo(0.015, 2);
  expect(one("medium")).toBeCloseTo(0.0685, 2);
  expect(one("high")).toBeGreaterThan(one("medium") * 3);
  expect(estimateImageBatchUsd(11, imageUnitUsage("openai", "low"), rate)!).toBeCloseTo(11 * one("low"), 6);
  // Gemini's cost does not change with the quality setting; flat-priced providers bill per image.
  expect(imageUnitUsage("google", "low")).toEqual(imageUnitUsage("google", "high"));
});
