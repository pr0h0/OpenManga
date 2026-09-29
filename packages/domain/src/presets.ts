/**
 * Production presets: one choice at project creation that sets format, style, quality, runtime and how much gets
 * generated. `settings` is merged into the new project's settings; the rest fills the wizard's own fields.
 */
export type ProductionPreset = {
  key: string;
  name: string;
  description: string;
  projectType: "manga" | "manhwa" | "webtoon" | "comic" | "illustrated_story";
  format: "comic" | "film" | "vertical";
  stylePresetKey: string;
  colorMode: "full_color" | "grayscale" | "bw_manga";
  settings: {
    imageQuality: "low" | "medium" | "high";
    targetRuntime: { minutes: number; wordsPerMinute: number; minShotSeconds: number; maxShotSeconds: number } | null;
    referencePolicy: "all" | "main";
    batchPolicy: "interactive" | "images" | "hybrid" | "cheapest";
  };
};

export const PRODUCTION_PRESETS: ProductionPreset[] = [
  {
    key: "youtube-recap-30",
    name: "YouTube recap, 30 min",
    description:
      "16:9 shots narrated over a Ken Burns video, about 30 minutes. Low image quality, references for the main cast only.",
    projectType: "manhwa",
    format: "film",
    stylePresetKey: "manhwa",
    colorMode: "full_color",
    settings: {
      imageQuality: "low",
      targetRuntime: { minutes: 30, wordsPerMinute: 150, minShotSeconds: 4, maxShotSeconds: 8 },
      referencePolicy: "main",
      batchPolicy: "images",
    },
  },
  {
    key: "youtube-recap-60",
    name: "YouTube recap, 1 hour",
    description:
      "The 30-minute recap at twice the length, with longer shots, and its images through half-price provider batches.",
    projectType: "manhwa",
    format: "film",
    stylePresetKey: "manhwa",
    colorMode: "full_color",
    settings: {
      imageQuality: "low",
      targetRuntime: { minutes: 60, wordsPerMinute: 150, minShotSeconds: 5, maxShotSeconds: 10 },
      referencePolicy: "main",
      batchPolicy: "images",
    },
  },
  {
    key: "youtube-recap-120",
    name: "YouTube recap, 2 hours",
    description:
      "A long-form recap: about 2 hours in some 20 chapters, 5–10 s shots, main-cast references only, images batched.",
    projectType: "manhwa",
    format: "film",
    stylePresetKey: "manhwa",
    colorMode: "full_color",
    settings: {
      imageQuality: "low",
      targetRuntime: { minutes: 120, wordsPerMinute: 150, minShotSeconds: 5, maxShotSeconds: 10 },
      referencePolicy: "main",
      batchPolicy: "images",
    },
  },
  {
    key: "youtube-recap-180",
    name: "YouTube recap, 3 hours",
    description:
      "The longest recap: about 3 hours in some 25 chapters, 6–12 s shots so the image count stays near 1,200, main-cast references only, images batched.",
    projectType: "manhwa",
    format: "film",
    stylePresetKey: "manhwa",
    colorMode: "full_color",
    settings: {
      imageQuality: "low",
      targetRuntime: { minutes: 180, wordsPerMinute: 150, minShotSeconds: 6, maxShotSeconds: 12 },
      referencePolicy: "main",
      batchPolicy: "images",
    },
  },
  {
    key: "manga-chapter",
    name: "Manga chapters",
    description: "Black-and-white manga pages read right to left, every character and place drawn from a reference.",
    projectType: "manga",
    format: "comic",
    stylePresetKey: "shonen",
    colorMode: "bw_manga",
    settings: { imageQuality: "medium", targetRuntime: null, referencePolicy: "all", batchPolicy: "interactive" },
  },
  {
    key: "webtoon-episode",
    name: "Webtoon episodes",
    description: "A vertical scrolling strip for phones, in full colour, generated as it is reviewed.",
    projectType: "webtoon",
    format: "vertical",
    stylePresetKey: "modern-webtoon",
    colorMode: "full_color",
    settings: { imageQuality: "medium", targetRuntime: null, referencePolicy: "all", batchPolicy: "interactive" },
  },
  {
    key: "economy",
    name: "Economy draft",
    description:
      "The cheapest way to see a whole story: low quality, main-cast references only, and everything that can wait sent as a half-price batch.",
    projectType: "manhwa",
    format: "comic",
    stylePresetKey: "manhwa",
    colorMode: "full_color",
    settings: { imageQuality: "low", targetRuntime: null, referencePolicy: "main", batchPolicy: "cheapest" },
  },
];
