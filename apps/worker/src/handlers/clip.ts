import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { VideoInputImage, VideoResult } from "@openmanga/ai-video";
import { eq, generationJobs, generationOutputs, panels } from "@openmanga/db";
import { ProviderError, type VideoClipAspect, type VideoResolution, videoRateModel } from "@openmanga/domain";
import type { ShotVideo } from "@openmanga/schemas";
import type { WorkerDeps } from "../context.ts";
import { InputError, isCancelRequested, JobCancelledError, type ProjectJob } from "../lib/runner.ts";
import { run } from "../lib/video.ts";

/** What a panel_clip job asks for (set by POST /api/panels/:id/clips). */
export type ClipInput = {
  panelId: string;
  pageId: string;
  /** The first frame: the panel's artwork, or null for text-to-video. */
  sourceAssetId: string | null;
  endAssetId: string | null;
  seconds: number;
  resolution: VideoResolution;
  aspect: VideoClipAspect;
  audio: boolean;
  seed: number | null;
  motion: string;
  /** Make it the shot's clip when it lands. */
  activate: boolean;
};

/** How long a clip may wait on its provider before the job gives up (a retry then resumes the same request). */
const MAX_WAIT_MS = 30 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function image(deps: WorkerDeps, assetId: string | null): Promise<VideoInputImage | null> {
  if (!assetId) return null;
  const a = await deps.assets.get(assetId);
  if (!a) throw new InputError("The shot's image was deleted");
  return { data: await deps.assets.read(a), mime: a.mimeType };
}

/**
 * Generates a shot's video clip. The provider's request id is stored on the job as soon as it is submitted, so a
 * worker that restarts (or a retry after a network error) polls the same request instead of paying for another.
 * The clip becomes a panel_clip asset of the panel, with its first frame as parent, and the shot's clip when asked.
 */
export async function panelClip(deps: WorkerDeps, job: ProjectJob) {
  const input = job.input as unknown as ClipInput;
  const [panel] = await deps.db.select().from(panels).where(eq(panels.id, input.panelId));
  if (!panel) throw new InputError("Panel no longer exists");
  const provider = await deps.resolver.video(
    (job.parameters.ai as { credentialId: string | null; model?: string | null } | undefined) ?? null,
    job.userId,
  );
  const prompt = job.compiledPrompt ?? "";
  let result: VideoResult | null = null;
  let requestId = job.providerRequestId;
  if (!requestId) {
    if (await isCancelRequested(deps, job.id)) throw new JobCancelledError();
    const sub = await provider.submit({
      prompt,
      image: await image(deps, input.sourceAssetId),
      endImage: await image(deps, input.endAssetId),
      seconds: input.seconds,
      resolution: input.resolution,
      aspect: input.aspect,
      audio: input.audio,
      seed: input.seed,
      motion: input.motion,
    });
    requestId = sub.id;
    result = sub.result ?? null;
    // Only a request still running is worth resuming: a finished one is stored below, in this same attempt.
    if (!result)
      await deps.db.update(generationJobs).set({ providerRequestId: requestId }).where(eq(generationJobs.id, job.id));
  }
  const started = Date.now();
  let wait = 3000;
  while (!result) {
    if (await isCancelRequested(deps, job.id)) {
      await provider.cancel(requestId).catch(() => {});
      throw new JobCancelledError();
    }
    if (Date.now() - started > MAX_WAIT_MS)
      throw new ProviderError(provider.provider, "timeout", `The clip was not ready after ${MAX_WAIT_MS / 60_000} min`);
    await sleep(wait);
    wait = Math.min(15_000, Math.round(wait * 1.5));
    const p = await provider.poll(requestId);
    if (p.state === "done") result = p;
    // Still running: the row's updated_at shows the runner is alive, so a redelivery does not start a second one.
    else await deps.db.update(generationJobs).set({ updatedAt: new Date() }).where(eq(generationJobs.id, job.id));
  }

  // What came back: its real length and size, from the file.
  const tmp = join(deps.config.TEMP_ROOT, `clip-${job.id}.mp4`);
  await Bun.write(tmp, result.data);
  let probe: { durationMs: number; width: number; height: number; audio: boolean };
  try {
    const out = await run(
      [
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration:stream=codec_type,width,height",
        "-of",
        "json",
        tmp,
      ],
      "clip probe",
    );
    const j = JSON.parse(out.stdout) as {
      format?: { duration?: string };
      streams?: { codec_type?: string; width?: number; height?: number }[];
    };
    const v = j.streams?.find((s) => s.codec_type === "video");
    probe = {
      durationMs: Math.round(Number(j.format?.duration ?? 0) * 1000),
      width: v?.width ?? 0,
      height: v?.height ?? 0,
      audio: Boolean(j.streams?.some((s) => s.codec_type === "audio")),
    };
  } finally {
    await rm(tmp, { force: true });
  }
  if (!probe.durationMs || !probe.width)
    throw new ProviderError(provider.provider, "invalid_response", "The provider returned a file that is not a video");

  await deps.usage.record({
    provider: provider.provider,
    model: videoRateModel(provider.model, input.resolution, input.audio),
    operation: job.kind,
    requestId,
    projectId: job.projectId,
    generationJobId: job.id,
    userId: job.userId,
    videoSeconds: input.seconds,
    rawUsage: { seconds: input.seconds, resolution: input.resolution, audio: input.audio },
    metadata: { panelId: input.panelId, aspect: input.aspect },
  });

  const cancelled = await isCancelRequested(deps, job.id);
  const asset = await deps.assets.store({
    projectId: job.projectId,
    ownerUserId: job.userId,
    type: "panel_clip",
    data: result.data,
    mimeType: result.mime || "video/mp4",
    width: probe.width,
    height: probe.height,
    durationMs: probe.durationMs,
    parentAssetId: input.sourceAssetId,
    generationJobId: job.id,
    metadata: {
      panelId: input.panelId,
      jobId: job.id,
      provider: provider.provider,
      model: provider.model,
      seconds: input.seconds,
      resolution: input.resolution,
      aspect: input.aspect,
      audio: input.audio && probe.audio,
      seed: result.seed,
      motion: input.motion,
      endAssetId: input.endAssetId,
      promptHash: job.promptHash,
      templateName: job.templateName,
      templateVersion: job.templateVersion,
      providerRequestId: requestId,
      cancelled,
    },
  });
  const activate = input.activate && !cancelled;
  await deps.db.insert(generationOutputs).values({
    jobId: job.id,
    assetId: asset.id,
    activated: activate,
    metadata: { durationMs: probe.durationMs, width: probe.width, height: probe.height },
  });
  if (cancelled) throw new JobCancelledError();
  if (activate) {
    const video = { ...((panel.video ?? {}) as Partial<ShotVideo>), clipAssetId: asset.id } as ShotVideo;
    await deps.db.update(panels).set({ video }).where(eq(panels.id, input.panelId));
  }
  await deps.events.publish(job.projectId, {
    type: "panel.updated",
    panelId: input.panelId,
    pageId: input.pageId,
    status: panel.status,
  });
  return { assetId: asset.id, durationMs: probe.durationMs, activated: activate, requestId };
}
