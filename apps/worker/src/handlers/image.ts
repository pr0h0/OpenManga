import type { ImageAIProvider, ImageInputFile, ImageResult } from "@openmanga/ai-image";
import {
  and,
  asc,
  assetVariants,
  eq,
  generationInputs,
  generationJobs,
  generationOutputs,
  panels,
  projects,
  type ReferenceKind,
  referenceAssets,
} from "@openmanga/db";
import { ProviderError } from "@openmanga/domain";
import { probeImage, type ReferenceParams, toEditMask } from "@openmanga/image-utils";
import type { AssetType } from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";
import { type GenerationJob, InputError, isCancelRequested, JobCancelledError } from "../lib/runner.ts";
import { maybeQueuePanelCheck } from "./qa.ts";

type Input = typeof generationInputs.$inferSelect;

/** Load the exact bytes that were planned: small derivatives for refs, full resolution for target/mask. */
export async function loadInputFile(deps: WorkerDeps, input: Input): Promise<ImageInputFile> {
  if (!input.assetId) throw new InputError(`Input ${input.label} has no asset`);
  const asset = await deps.assets.get(input.assetId);
  if (!asset) throw new InputError(`Reference asset for ${input.label} was deleted`);
  if (!input.variantId) return { data: await deps.assets.read(asset), mime: asset.mimeType, label: input.label };
  const [variant] = await deps.db.select().from(assetVariants).where(eq(assetVariants.id, input.variantId));
  if (variant && (await deps.assets.storage.exists(variant.storageKey))) {
    return { data: await deps.assets.readVariant(variant), mime: variant.mimeType, label: input.label };
  }
  // Derivatives are disposable: recreate deterministically from the canonical asset.
  const m = input.metadata as Partial<ReferenceParams>;
  const params = deps.assets.referenceParams({ maxWidth: m.maxWidth, maxHeight: m.maxHeight });
  const v = await deps.assets.ensurePromptReference(asset, {
    ...params,
    fit: m.fit ?? params.fit,
    format: m.format ?? params.format,
  });
  return { data: await deps.assets.readVariant(v), mime: v.mimeType, label: input.label };
}

/** BYOK / model override stored on the job, or the server default. */
const imageProviderFor = (deps: WorkerDeps, job: GenerationJob) =>
  deps.resolver.forJob("image", job) as Promise<ImageAIProvider>;

export async function recordImageUsage(deps: WorkerDeps, job: GenerationJob, r: ImageResult, inputs: Input[]) {
  const refs = inputs.filter((i) => i.variantId);
  await deps.usage.record({
    provider: r.provider,
    model: r.model,
    operation: job.kind,
    requestId: r.requestId,
    projectId: job.projectId,
    generationJobId: job.id,
    userId: job.userId,
    textInputTokens: r.usage.textInputTokens,
    imageInputTokens: r.usage.imageInputTokens,
    imageOutputTokens: r.usage.imageOutputTokens,
    textOutputTokens: r.usage.textOutputTokens ?? 0,
    images: 1,
    cachedInputTokens: r.usage.cachedInputTokens,
    rawUsage: r.usage.raw,
    latencyMs: r.latencyMs,
    metadata: {
      quality: r.quality,
      size: r.request.size,
      endpoint: r.request.endpoint,
      referenceCount: refs.length,
      referenceDimensions: refs.map((i) => ({ role: i.role, width: i.width, height: i.height })),
      referenceMaxWidth: (refs[0]?.metadata as { maxWidth?: number } | undefined)?.maxWidth ?? null,
      referenceMaxHeight: (refs[0]?.metadata as { maxHeight?: number } | undefined)?.maxHeight ?? null,
    },
  });
}

export async function finalizeOutput(
  deps: WorkerDeps,
  job: GenerationJob,
  r: ImageResult,
  type: AssetType,
  extraMeta: Record<string, unknown>,
  parentAssetId: string | null,
) {
  const probed = await probeImage(r.data);
  const cancelled = await isCancelRequested(deps, job.id);
  const asset = await deps.assets.store({
    projectId: job.projectId,
    ownerUserId: job.userId,
    type,
    data: r.data,
    mimeType: probed.mime,
    width: probed.width,
    height: probed.height,
    parentAssetId,
    generationJobId: job.id,
    metadata: {
      ...extraMeta,
      jobId: job.id,
      provider: r.provider,
      model: r.model,
      quality: r.quality,
      size: r.request.size,
      promptHash: job.promptHash,
      templateName: job.templateName,
      templateVersion: job.templateVersion,
      providerRequestId: r.requestId,
      cancelled,
    },
  });
  await deps.db.insert(generationOutputs).values({
    jobId: job.id,
    assetId: asset.id,
    activated: false,
    metadata: { width: probed.width, height: probed.height },
  });
  await deps.db
    .update(generationJobs)
    .set({ providerRequestId: r.requestId, provider: r.provider, model: r.model })
    .where(eq(generationJobs.id, job.id));
  await deps.assets
    .ensureThumbnail(asset)
    .catch((e) => deps.logger.warn("thumbnail failed", { assetId: asset.id, error: String(e) }));
  return { asset, cancelled };
}

export async function inputsOf(deps: WorkerDeps, jobId: string) {
  return deps.db
    .select()
    .from(generationInputs)
    .where(eq(generationInputs.jobId, jobId))
    .orderBy(asc(generationInputs.order));
}

export async function panelGeneration(deps: WorkerDeps, job: GenerationJob) {
  const panelId = job.targetId!;
  const [panel] = await deps.db.select().from(panels).where(eq(panels.id, panelId));
  if (!panel) throw new InputError("Panel no longer exists");
  if (!job.compiledPrompt) throw new InputError("Job has no compiled prompt");
  const inputs = await inputsOf(deps, job.id);
  const references: ImageInputFile[] = [];
  for (const i of inputs) references.push(await loadInputFile(deps, i));
  if (await isCancelRequested(deps, job.id)) throw new JobCancelledError();
  const request = {
    prompt: job.compiledPrompt,
    aspectRatio: Number(job.parameters.aspectRatio ?? 1),
    quality: String(job.parameters.quality ?? deps.config.IMAGE_QUALITY),
    references,
    label: `panel ${panelId.slice(0, 8)}`,
  };
  const primary = await imageProviderFor(deps, job);
  let r: ImageResult;
  let review: NonNullable<typeof panels.$inferSelect.review> | null = null;
  try {
    r = await primary.generate(request);
  } catch (e) {
    const alt =
      e instanceof ProviderError && e.code === "content_policy"
        ? await contentPolicyFallback(deps, job, primary)
        : null;
    if (!alt) throw e;
    deps.logger.warn("content policy block, retrying once on fallback provider", {
      jobId: job.id,
      panelId,
      from: `${primary.provider}/${primary.model}`,
      to: `${alt.provider}/${alt.model}`,
    });
    r = await alt.generate(request);
    review = {
      reason: "content_policy_fallback",
      message: `${primary.provider} (${primary.model}) blocked this panel with its content filter, so it was generated once on ${alt.provider} (${alt.model}). Check it matches the neighbouring panels.`,
      from: { provider: primary.provider, model: primary.model },
      to: { provider: alt.provider, model: alt.model },
      blockedBy: (e as Error).message.slice(0, 300),
      at: new Date().toISOString(),
    };
  }
  if (r.softened?.length)
    deps.logger.info("prompt softened by provider policy", { jobId: job.id, provider: r.provider, words: r.softened });
  await recordImageUsage(deps, job, r, inputs);
  const parent = (job.parameters.parentAssetId as string | null) ?? null;
  const { asset, cancelled } = await finalizeOutput(
    deps,
    job,
    r,
    "panel_art",
    {
      panelId,
      pageId: panel.pageId,
      operation: job.parameters.operation ?? null,
      promptSoftened: r.softened ?? null,
      contentPolicyFallback: review ? { from: review.from, to: review.to } : null,
      referenceInputs: inputs.map((i) => ({
        role: i.role,
        assetId: i.assetId,
        variantId: i.variantId,
        width: i.width,
        height: i.height,
      })),
    },
    parent,
  );
  if (cancelled) throw new JobCancelledError();
  await activatePanelArt(deps, job, panelId, asset.id, review);
  await maybeQueuePanelCheck(deps, job, panelId, asset.id).catch((e) =>
    deps.logger.warn("panel check not queued", { panelId, error: (e as Error).message }),
  );
  return { assetId: asset.id, width: asset.width, height: asset.height, references: inputs.length };
}

/**
 * The alternate image provider for ONE retry after a content-policy block: the project's configured fallback, or the
 * server default. None when disabled or when it would be the same provider/model that just refused.
 */
async function contentPolicyFallback(deps: WorkerDeps, job: GenerationJob, failed: ImageAIProvider) {
  const [project] = await deps.db
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, job.projectId));
  const cfg = project?.settings.contentPolicyFallback;
  // Opt-in, and it must name one of the user's own keys: there is no shared server key to fall back to.
  if (!cfg?.enabled || !(cfg.credentialId || deps.config.AI_MOCK_MODE)) return null;
  let alt: ImageAIProvider | null;
  try {
    alt = cfg.credentialId
      ? await deps.resolver.image({ credentialId: cfg.credentialId, model: cfg.model || null }, job.userId)
      : deps.resolver.defaultImage;
  } catch (e) {
    deps.logger.warn("content policy fallback unavailable", { jobId: job.id, error: (e as Error).message });
    return null;
  }
  return !alt || (alt.provider === failed.provider && alt.model === failed.model) ? null : alt;
}

export async function activatePanelArt(
  deps: WorkerDeps,
  job: GenerationJob,
  panelId: string,
  assetId: string,
  review: (typeof panels.$inferSelect)["review"] = null,
) {
  await deps.db.transaction(async (tx) => {
    // Cancellation may have been requested while we were storing; re-check inside the transaction.
    const [j] = await tx
      .select({ status: generationJobs.status })
      .from(generationJobs)
      .where(eq(generationJobs.id, job.id))
      .for("update");
    if (j?.status === "cancel_requested" || j?.status === "cancelled") throw new JobCancelledError();
    await tx
      .update(panels)
      .set({ activeArtworkAssetId: assetId, status: "ready", review })
      .where(eq(panels.id, panelId));
    await tx
      .update(generationOutputs)
      .set({ activated: true })
      .where(and(eq(generationOutputs.jobId, job.id), eq(generationOutputs.assetId, assetId)));
  });
  const [pn] = await deps.db.select({ pageId: panels.pageId }).from(panels).where(eq(panels.id, panelId));
  await deps.events.publish(job.projectId, {
    type: "panel.updated",
    panelId,
    pageId: pn?.pageId ?? "",
    status: "ready",
    activeArtworkAssetId: assetId,
  });
}

export async function panelEdit(deps: WorkerDeps, job: GenerationJob) {
  const panelId = job.targetId!;
  const inputs = await inputsOf(deps, job.id);
  const targetInput = inputs.find((i) => i.role === "target");
  const maskInput = inputs.find((i) => i.role === "mask");
  if (!targetInput || !maskInput) throw new InputError("Edit job is missing its target or mask");
  const target = await loadInputFile(deps, targetInput);
  const maskFile = await loadInputFile(deps, maskInput);
  const t = await probeImage(target.data);
  const mask = await toEditMask(maskFile.data, t.width, t.height);
  const references: ImageInputFile[] = [];
  for (const i of inputs.filter((x) => x.variantId)) references.push(await loadInputFile(deps, i));
  if (await isCancelRequested(deps, job.id)) throw new JobCancelledError();
  const r = await (await imageProviderFor(deps, job)).edit({
    prompt: job.compiledPrompt ?? "",
    target,
    mask: { data: mask, mime: "image/png", label: "mask" },
    references,
    quality: String(job.parameters.quality ?? deps.config.IMAGE_QUALITY),
    label: `edit ${panelId.slice(0, 8)}`,
  });
  await recordImageUsage(deps, job, r, inputs);
  const { asset, cancelled } = await finalizeOutput(
    deps,
    job,
    r,
    "panel_art",
    {
      panelId,
      operation: job.parameters.operation ?? "masked_edit",
      maskAssetId: maskInput.assetId,
      targetWidth: t.width,
      targetHeight: t.height,
    },
    targetInput.assetId,
  );
  if (cancelled) throw new JobCancelledError();
  await activatePanelArt(deps, job, panelId, asset.id);
  await maybeQueuePanelCheck(deps, job, panelId, asset.id).catch((e) =>
    deps.logger.warn("panel check not queued", { panelId, error: (e as Error).message }),
  );
  return { assetId: asset.id, parentAssetId: targetInput.assetId };
}

const SUBJECT_ASSET: Record<string, AssetType> = {
  character_reference: "character_reference",
  location_reference: "location_reference",
  prop_reference: "prop_reference",
  style_reference: "style_reference",
};

/** Canonical references are generated at full provider resolution and never downscaled. */
export async function referenceGeneration(deps: WorkerDeps, job: GenerationJob) {
  const kind = String(job.input.kind) as ReferenceKind;
  if (!job.compiledPrompt) throw new InputError("Job has no compiled prompt");
  // An outfit reference is drawn from the approved design, and its prompt says so: "reference image 1 is this
  // character's approved design — reproduce that same person". That image is recorded as the job's input, and it has
  // to be sent; without it the model is told to copy a face it never sees, and every outfit drifts into a stranger.
  const inputs = await inputsOf(deps, job.id);
  const references: ImageInputFile[] = [];
  for (const i of inputs) references.push(await loadInputFile(deps, i));
  const r = await (await imageProviderFor(deps, job)).generate({
    prompt: job.compiledPrompt,
    aspectRatio: Number(job.parameters.aspectRatio ?? 1),
    quality: String(job.parameters.quality ?? deps.config.IMAGE_QUALITY),
    references,
    label: String(job.parameters.label ?? kind),
  });
  await recordImageUsage(deps, job, r, inputs);
  const out = await attachReference(deps, job, r);
  if (out.cancelled) throw new JobCancelledError();
  return { assetId: out.asset.id, referenceId: out.referenceId, width: out.asset.width, height: out.asset.height };
}

/**
 * Everything that happens once a reference image exists: store it, add it to the version as a draft reference —
 * primary if it is the first — and tell the page. Shared by a direct run and a provider batch, so a reference that
 * came back in a batch is indistinguishable from one generated on the spot.
 */
export async function attachReference(deps: WorkerDeps, job: GenerationJob, r: ImageResult) {
  const subject = String(job.input.subject) as "character" | "location" | "prop" | "style";
  const versionId = String(job.input.versionId);
  const kind = String(job.input.kind) as ReferenceKind;
  const { asset, cancelled } = await finalizeOutput(
    deps,
    job,
    r,
    SUBJECT_ASSET[job.kind]!,
    { subject, subjectVersionId: versionId, referenceKind: kind, canonical: true },
    null,
  );
  if (cancelled) return { asset, cancelled, referenceId: null };
  const col =
    subject === "character"
      ? referenceAssets.characterVersionId
      : subject === "location"
        ? referenceAssets.locationVersionId
        : subject === "prop"
          ? referenceAssets.propVersionId
          : referenceAssets.projectStyleId;
  const [primary] = await deps.db
    .select({ id: referenceAssets.id })
    .from(referenceAssets)
    .where(and(eq(col, versionId), eq(referenceAssets.isPrimary, true)));
  const [ref] = await deps.db
    .insert(referenceAssets)
    .values({
      projectId: job.projectId,
      subjectType: subject,
      characterVersionId: subject === "character" ? versionId : null,
      locationVersionId: subject === "location" ? versionId : null,
      propVersionId: subject === "prop" ? versionId : null,
      projectStyleId: subject === "style" ? versionId : null,
      outfitId: (job.input.outfitId as string | null) ?? null,
      kind,
      assetId: asset.id,
      isPrimary: !primary && kind !== "expression_sheet",
      sourceFingerprint: (job.input.sourceFingerprint as string | null | undefined) ?? null,
    })
    .returning();
  await deps.db.update(generationOutputs).set({ activated: true }).where(eq(generationOutputs.assetId, asset.id));
  await deps.events.publish(job.projectId, {
    type: "reference.updated",
    subjectType: subject,
    subjectVersionId: versionId,
    assetId: asset.id,
  });
  return { asset, cancelled, referenceId: ref!.id };
}

export async function coverGeneration(deps: WorkerDeps, job: GenerationJob) {
  const inputs = await inputsOf(deps, job.id);
  const references: ImageInputFile[] = [];
  for (const i of inputs) references.push(await loadInputFile(deps, i));
  const r = await (await imageProviderFor(deps, job)).generate({
    prompt: job.compiledPrompt ?? "",
    aspectRatio: 2 / 3,
    quality: String(job.parameters.quality ?? deps.config.IMAGE_QUALITY),
    references,
    label: "cover",
  });
  await recordImageUsage(deps, job, r, inputs);
  const { asset, cancelled } = await finalizeOutput(
    deps,
    job,
    r,
    "cover",
    { title: job.parameters.title, subtitle: job.parameters.subtitle },
    null,
  );
  if (cancelled) throw new JobCancelledError();
  await deps.db.update(projects).set({ coverAssetId: asset.id }).where(eq(projects.id, job.projectId));
  await deps.db.update(generationOutputs).set({ activated: true }).where(eq(generationOutputs.assetId, asset.id));
  return { assetId: asset.id };
}
