import type { GenerationKind } from "@openmanga/db";
import type { Job } from "@openmanga/queue";
import type { WorkerDeps } from "./context.ts";
import { processExport } from "./handlers/export.ts";
import { coverGeneration, panelEdit, panelGeneration, referenceGeneration } from "./handlers/image.ts";
import { imageBatchSubmit, pollProviderBatches } from "./handlers/image-batch.ts";
import { runMaintenance } from "./handlers/maintenance.ts";
import { panelCheck } from "./handlers/qa.ts";
import {
  chapterPlan,
  imageDescribe,
  narrationText,
  pagePrompts,
  storyAnalysis,
  storyRewrite,
} from "./handlers/text.ts";
import { textBatchSubmit } from "./handlers/text-batch.ts";
import { TEXT_HANDLERS } from "./handlers/text-handlers.ts";
import { processTts } from "./handlers/tts.ts";
import { type GenerationJob, runGenerationJob } from "./lib/runner.ts";

const GENERATION_HANDLERS: Record<
  GenerationKind,
  (deps: WorkerDeps, job: GenerationJob) => Promise<Record<string, unknown>>
> = {
  ...(TEXT_HANDLERS as Record<string, (deps: WorkerDeps, job: GenerationJob) => Promise<Record<string, unknown>>>),
  story_analysis: storyAnalysis,
  story_rewrite: storyRewrite,
  chapter_plan: chapterPlan,
  page_prompts: pagePrompts,
  narration_text: narrationText,
  character_reference: referenceGeneration,
  location_reference: referenceGeneration,
  prop_reference: referenceGeneration,
  style_reference: referenceGeneration,
  panel_generation: panelGeneration,
  panel_edit: panelEdit,
  panel_check: panelCheck,
  image_describe: imageDescribe,
  cover: coverGeneration,
  image_batch_submit: imageBatchSubmit,
  text_batch_submit: textBatchSubmit,
};

export function generationProcessor(deps: WorkerDeps) {
  return (job: Job) =>
    runGenerationJob(deps, job, (g) => {
      const handler = GENERATION_HANDLERS[g.kind];
      if (!handler) throw new Error(`No handler for ${g.kind}`);
      return handler(deps, g);
    });
}

export const ttsProcessor = (deps: WorkerDeps) => (job: Job) => processTts(deps, job);
export const exportProcessor = (deps: WorkerDeps) => (job: Job) => processExport(deps, job);

/** asset-processing: thumbnails/derivatives on demand; maintenance: cleanup. */
export function assetProcessor(deps: WorkerDeps) {
  return async (job: Job) => {
    const asset = await deps.assets.get(String(job.data.assetId));
    if (!asset) return;
    if (job.name === "thumbnail") await deps.assets.ensureThumbnail(asset);
    if (job.name === "prompt_ref") await deps.assets.ensurePromptReference(asset, deps.assets.referenceParams());
  };
}
/** The maintenance queue hosts two schedulers: the hourly cleanup, and the provider-batch poll. */
export const maintenanceProcessor = (deps: WorkerDeps) => (job: Job) =>
  job.name === "batch-poll" ? pollProviderBatches(deps) : runMaintenance(deps);
