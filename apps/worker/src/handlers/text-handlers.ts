/**
 * The text-producing handlers, in one map. Kept apart from `processors.ts` so the batch submitter can run them
 * (it harvests the request each would have made) without importing the module that registers *it* — the two
 * would otherwise form an import cycle whose resolution order decided whether batching worked.
 */
import type { WorkerDeps } from "../context.ts";
import type { ProjectJob } from "../lib/runner.ts";
import { continuityCheck } from "./continuity.ts";
import { narrationFix, narrationLint } from "./narration-qa.ts";
import { panelCheck } from "./qa.ts";
import { storyCoverage } from "./story-coverage.ts";
import {
  adScript,
  bibleExtract,
  chapterPlan,
  imageDescribe,
  letteringTranslate,
  narrationText,
  pagePrompts,
  storyAnalysis,
  storyRewrite,
  timelineExtract,
  videoEdit,
  youtubePackage,
} from "./text.ts";

export type GenerationHandler = (deps: WorkerDeps, job: ProjectJob) => Promise<Record<string, unknown>>;

export const TEXT_HANDLERS: Record<string, GenerationHandler> = {
  story_analysis: storyAnalysis,
  story_rewrite: storyRewrite,
  ad_script: adScript,
  chapter_plan: chapterPlan,
  page_prompts: pagePrompts,
  narration_text: narrationText,
  panel_check: panelCheck,
  image_describe: imageDescribe,
  youtube_package: youtubePackage,
  bible_extract: bibleExtract,
  timeline_extract: timelineExtract,
  lettering_translate: letteringTranslate,
  video_edit: videoEdit,
  continuity_check: continuityCheck,
  narration_lint: narrationLint,
  narration_fix: narrationFix,
  story_coverage: storyCoverage,
};
