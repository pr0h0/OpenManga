import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type { VideoAIProvider, VideoInputImage, VideoResult } from "@openmanga/ai-video";
import { assets, eq, generationJobs, generationOutputs, inArray, panels } from "@openmanga/db";
import { ProviderError, type VideoClipAspect, type VideoResolution, videoRateModel } from "@openmanga/domain";
import { sharp } from "@openmanga/image-utils";
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
  /** One clip's length, or one part's for a long shot. */
  seconds: number;
  /** Parts of a long shot (absent or 1: a single clip); each continues from the last frame of the one before. */
  partCount?: number;
  /** Each part's prompt (the job's compiledPrompt holds them all). */
  prompts?: string[];
  resolution: VideoResolution;
  aspect: VideoClipAspect;
  audio: boolean;
  seed: number | null;
  motion: string;
  /** The project's look, for models with a style switch. */
  style?: "anime" | "cartoon" | "realistic" | null;
  /** Make it the shot's clip when it lands. */
  activate: boolean;
};

/** A long shot's progress, kept on the job while it runs: the parts already made, in order. */
type Progress = { parts?: string[] };

/** How long one clip may wait on its provider before the job gives up (a retry then resumes the same request). */
const MAX_WAIT_MS = 30 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Polling errors that say nothing about the request itself: it is still worth polling after a retry. */
const TRANSIENT = new Set(["timeout", "rate_limited", "server_error", "network", "offline"]);

/**
 * A frame for the video model: fitted inside 1920 px as a high-quality JPEG. Video models work at 1080p at most, and a
 * smaller upload keeps the request quick; the canonical image is never touched.
 */
async function frame(data: Uint8Array): Promise<VideoInputImage> {
  const out = await sharp(data)
    .resize(1920, 1920, { fit: "inside", withoutEnlargement: true })
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92 })
    .toBuffer();
  return { data: new Uint8Array(out), mime: "image/jpeg" };
}

async function image(deps: WorkerDeps, assetId: string | null): Promise<VideoInputImage | null> {
  if (!assetId) return null;
  const a = await deps.assets.get(assetId);
  if (!a) throw new InputError("The shot's image was deleted");
  return frame(await deps.assets.read(a));
}

type Probe = { durationMs: number; width: number; height: number; fps: number; audio: boolean };

async function probe(path: string): Promise<Probe> {
  const out = await run(
    [
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,width,height,r_frame_rate",
      "-of",
      "json",
      path,
    ],
    "clip probe",
  );
  const j = JSON.parse(out.stdout) as {
    format?: { duration?: string };
    streams?: { codec_type?: string; width?: number; height?: number; r_frame_rate?: string }[];
  };
  const v = j.streams?.find((s) => s.codec_type === "video");
  const [num, den] = (v?.r_frame_rate ?? "24/1").split("/").map(Number);
  return {
    durationMs: Math.round(Number(j.format?.duration ?? 0) * 1000),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: num && den ? num / den : 24,
    audio: Boolean(j.streams?.some((s) => s.codec_type === "audio")),
  };
}

/** The last frame of a video, as the first frame of the next part. */
async function lastFrame(dir: string, video: string) {
  const out = join(dir, "last.png");
  await run(
    ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-sseof", "-1", "-i", video, "-update", "1", out],
    "last frame",
  );
  return frame(new Uint8Array(await Bun.file(out).arrayBuffer()));
}

/**
 * Joins a long shot's parts into one clip: every part at the first one's size and frame rate, each continuation's first
 * frame dropped (it is the previous part's last frame), and their sound joined when every part has some.
 */
async function joinParts(dir: string, files: string[], probes: Probe[]) {
  const { width, height, fps } = probes[0]!;
  const sound = probes.every((p) => p.audio);
  const frameSec = (1 / fps).toFixed(4);
  const graph = files
    .map((_, k) => {
      const v = `[${k}:v]fps=${fps.toFixed(3)},scale=${width}:${height},setsar=1${k ? ",trim=start_frame=1,setpts=PTS-STARTPTS" : ""}[v${k}]`;
      const a = sound
        ? `;[${k}:a]aresample=48000${k ? `,atrim=start=${frameSec},asetpts=PTS-STARTPTS` : ""}[a${k}]`
        : "";
      return v + a;
    })
    .join(";");
  const order = files.map((_, k) => `[v${k}]${sound ? `[a${k}]` : ""}`).join("");
  const out = join(dir, "joined.mp4");
  await run(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...files.flatMap((f) => ["-i", f]),
      "-filter_complex",
      `${graph};${order}concat=n=${files.length}:v=1:a=${sound ? 1 : 0}[v]${sound ? "[a]" : ""}`,
      "-map",
      "[v]",
      ...(sound ? ["-map", "[a]", "-c:a", "aac", "-b:a", "160k"] : []),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      out,
    ],
    "join parts",
  );
  return out;
}

/** One clip from a provider: submitted (or resumed from the request stored on the job) and polled until it is done. */
async function makeOne(
  deps: WorkerDeps,
  job: ProjectJob,
  provider: VideoAIProvider,
  req: Parameters<VideoAIProvider["submit"]>[0],
  resumeId: string | null,
) {
  let result: VideoResult | null = null;
  let requestId = resumeId;
  if (!requestId) {
    if (await isCancelRequested(deps, job.id)) throw new JobCancelledError();
    const sub = await provider.submit(req);
    requestId = sub.id;
    result = sub.result ?? null;
    // Only a request still running is worth resuming: a finished one is stored by the caller, in this attempt.
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
    let p: Awaited<ReturnType<VideoAIProvider["poll"]>>;
    try {
      p = await provider.poll(requestId);
    } catch (e) {
      // A request that ended (refused, unusable) is not resumed: the retry submits a new one. A network or provider
      // hiccup while polling keeps it, so the retry polls the same request instead of paying again.
      if (!(e instanceof ProviderError) || !TRANSIENT.has(e.code))
        await deps.db.update(generationJobs).set({ providerRequestId: null }).where(eq(generationJobs.id, job.id));
      throw e;
    }
    if (p.state === "done") result = p;
    // Still running: the row's updated_at shows the runner is alive, so a redelivery does not start a second one.
    else await deps.db.update(generationJobs).set({ updatedAt: new Date() }).where(eq(generationJobs.id, job.id));
  }
  return { result, requestId };
}

/**
 * Generates a shot's video clip. A shot longer than the model's longest clip is made in parts: each starts from the
 * last frame of the part before, with its own prompt saying what happens in its seconds, and the parts are joined into
 * one clip. The provider's request id is stored on the job as soon as a part is submitted, and every finished part is
 * kept, so a restarted worker carries on from the part it was waiting for instead of paying again. The clip becomes a
 * panel_clip asset of the panel, with its first frame as parent, and the shot's clip when asked.
 */
export async function panelClip(deps: WorkerDeps, job: ProjectJob) {
  const input = job.input as unknown as ClipInput;
  const [panel] = await deps.db.select().from(panels).where(eq(panels.id, input.panelId));
  if (!panel) throw new InputError("Panel no longer exists");
  const provider = await deps.resolver.video(
    (job.parameters.ai as { credentialId: string | null; model?: string | null } | undefined) ?? null,
    job.userId,
  );
  const count = Math.max(1, input.partCount ?? 1);
  const prompts = input.prompts?.length ? input.prompts : [job.compiledPrompt ?? ""];
  const done = [...((job.result as Progress | null)?.parts ?? [])];
  const dir = await mkdtemp(join(deps.config.TEMP_ROOT, `clip-${job.id}-`));
  try {
    const files: string[] = [];
    const probes: Probe[] = [];
    // Parts made before a restart: back on disk, to take the next frame from and to join.
    for (const [k, id] of done.entries()) {
      const a = await deps.assets.get(id);
      if (!a) throw new InputError("A finished part of this shot was deleted");
      const f = join(dir, `part-${k}.mp4`);
      await Bun.write(f, new Response(deps.assets.storage.stream(a.storageKey)));
      files.push(f);
      probes.push(await probe(f));
    }
    let requestId = job.providerRequestId;
    let seed: number | null = null;
    for (let k = done.length; k < count; k++) {
      const first = k === 0 ? await image(deps, input.sourceAssetId) : await lastFrame(dir, files[k - 1]!);
      const { result, requestId: rid } = await makeOne(
        deps,
        job,
        provider,
        {
          prompt: prompts[k] ?? prompts.at(-1)!,
          image: first,
          endImage: k === count - 1 ? await image(deps, input.endAssetId) : null,
          seconds: input.seconds,
          resolution: input.resolution,
          aspect: input.aspect,
          audio: input.audio,
          seed: input.seed,
          motion: k === 0 ? input.motion : "auto",
          style: input.style ?? null,
        },
        requestId,
      );
      requestId = null;
      seed ??= result.seed;
      const f = join(dir, `part-${k}.mp4`);
      await Bun.write(f, result.data);
      const pr = await probe(f);
      if (!pr.durationMs || !pr.width)
        throw new ProviderError(
          provider.provider,
          "invalid_response",
          "The provider returned a file that is not a video",
        );
      // Each part is billed as it lands, so a shot that fails half-way still records what was spent.
      await deps.usage.record({
        provider: provider.provider,
        model: videoRateModel(provider.model, input.resolution, input.audio),
        operation: job.kind,
        requestId: rid,
        projectId: job.projectId,
        generationJobId: job.id,
        userId: job.userId,
        videoSeconds: input.seconds,
        // A model's flat per-clip fee is priced as an image (imageUnitRate) on its rate snapshot.
        images: 1,
        rawUsage: { seconds: input.seconds, resolution: input.resolution, audio: input.audio, part: k + 1, of: count },
        metadata: { panelId: input.panelId, aspect: input.aspect },
      });
      files.push(f);
      probes.push(pr);
      if (count > 1 && k < count - 1) {
        const part = await deps.assets.store({
          projectId: job.projectId,
          ownerUserId: job.userId,
          type: "panel_clip",
          filePath: f,
          mimeType: "video/mp4",
          width: pr.width,
          height: pr.height,
          durationMs: pr.durationMs,
          generationJobId: job.id,
          metadata: { panelId: input.panelId, partOf: job.id, part: k + 1, of: count, provider: provider.provider },
        });
        done.push(part.id);
        await deps.db
          .update(generationJobs)
          .set({ providerRequestId: null, result: { parts: done } })
          .where(eq(generationJobs.id, job.id));
      }
    }

    const out = count > 1 ? await joinParts(dir, files, probes) : files[0]!;
    const final = count > 1 ? await probe(out) : probes[0]!;
    const cancelled = await isCancelRequested(deps, job.id);
    const asset = await deps.assets.store({
      projectId: job.projectId,
      ownerUserId: job.userId,
      type: "panel_clip",
      filePath: out,
      mimeType: "video/mp4",
      width: final.width,
      height: final.height,
      durationMs: final.durationMs,
      parentAssetId: input.sourceAssetId,
      generationJobId: job.id,
      metadata: {
        panelId: input.panelId,
        jobId: job.id,
        provider: provider.provider,
        model: provider.model,
        seconds: input.seconds * count,
        ...(count > 1 ? { parts: count, partSeconds: input.seconds } : {}),
        resolution: input.resolution,
        aspect: input.aspect,
        audio: input.audio && final.audio,
        seed,
        motion: input.motion,
        endAssetId: input.endAssetId,
        promptHash: job.promptHash,
        templateName: job.templateName,
        templateVersion: job.templateVersion,
        cancelled,
      },
    });
    // The parts live on in the joined clip.
    if (done.length) await deps.db.update(assets).set({ deletedAt: new Date() }).where(inArray(assets.id, done));
    const activate = input.activate && !cancelled;
    await deps.db.insert(generationOutputs).values({
      jobId: job.id,
      assetId: asset.id,
      activated: activate,
      metadata: { durationMs: final.durationMs, width: final.width, height: final.height, parts: count },
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
    return { assetId: asset.id, durationMs: final.durationMs, activated: activate, parts: count };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
