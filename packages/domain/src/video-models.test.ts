import { expect, test } from "bun:test";
import { DEFAULT_RATE_SNAPSHOTS, estimateCostUsd, selectRate } from "./cost.ts";
import { providerCatalog, providerSupports } from "./providers.ts";
import {
  clipDuration,
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
