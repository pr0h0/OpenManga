/**
 * The text-producing handlers, in one map. Kept apart from `processors.ts` so the batch submitter can run them
 * (it harvests the request each would have made) without importing the module that registers *it* — the two
 * would otherwise form an import cycle whose resolution order decided whether batching worked.
 */
import type { WorkerDeps } from "../context.ts";
import type { ProjectJob } from "../lib/runner.ts";
import { continuityCheck } from "./continuity.ts";
import { panelCheck } from "./qa.ts";
import {
  bibleExtract,
  chapterPlan,
  imageDescribe,
  narrationText,
  pagePrompts,
  storyAnalysis,
  storyRewrite,
  youtubePackage,
} from "./text.ts";

export type GenerationHandler = (deps: WorkerDeps, job: ProjectJob) => Promise<Record<string, unknown>>;

export const TEXT_HANDLERS: Record<string, GenerationHandler> = {
  story_analysis: storyAnalysis,
  story_rewrite: storyRewrite,
  chapter_plan: chapterPlan,
  page_prompts: pagePrompts,
  narration_text: narrationText,
  panel_check: panelCheck,
  image_describe: imageDescribe,
  youtube_package: youtubePackage,
  bible_extract: bibleExtract,
  continuity_check: continuityCheck,
};
