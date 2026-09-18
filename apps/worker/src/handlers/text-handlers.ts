/**
 * The text-producing handlers, in one map. Kept apart from `processors.ts` so the batch submitter can run them
 * (it harvests the request each would have made) without importing the module that registers *it* — the two
 * would otherwise form an import cycle whose resolution order decided whether batching worked.
 */
import type { WorkerDeps } from "../context.ts";
import type { GenerationJob } from "../lib/runner.ts";
import { panelCheck } from "./qa.ts";
import { chapterPlan, narrationText, pagePrompts, storyAnalysis, storyRewrite } from "./text.ts";

export type GenerationHandler = (deps: WorkerDeps, job: GenerationJob) => Promise<Record<string, unknown>>;

export const TEXT_HANDLERS: Record<string, GenerationHandler> = {
  story_analysis: storyAnalysis,
  story_rewrite: storyRewrite,
  chapter_plan: chapterPlan,
  page_prompts: pagePrompts,
  narration_text: narrationText,
  panel_check: panelCheck,
};
