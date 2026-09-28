import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { concatWav, ffmpegConvert, parseWav, pcmToWav } from "@openmanga/audio";
import {
  ConcurrencyLimiter,
  frameSizeFor,
  holdFor,
  kenBurnsPullsOut,
  type PageFraming,
  pageShotBox,
  panelShotBox,
  scrollPlan,
} from "@openmanga/domain";
import { computeCrop, focusInCrop, renderPanelArt, sharp } from "@openmanga/image-utils";
import {
  loadRenderPage,
  narrationSegmentsFor,
  type PlannedShot,
  planVideoShots,
  renderPageImage,
  type VideoScope,
} from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";

export type VideoOptions = {
  height: number;
  fps: number;
  minHoldMs: number;
  /**
   * Page cut. "width": page at pageWidthRatio of the frame width with a capped slow scroll; "height": whole page;
   * "scroll": the width framing, travelling the whole page from top to bottom over its hold.
   */
  framing: PageFraming;
  pageWidthRatio: number;
  pageHeightRatio: number;
  maxScrollPxPerSec: number;
  /** Panel cut: Ken Burns travel over each hold (0.06 = 6%). */
  zoom?: number;
  /** Silence after a shot's narration before the cut (default VIDEO_BREATH_MS). */
  breathMs?: number;
  /** Clips rendered and encoded at once (shots are independent until the final concat). */
  concurrency?: number;
  /** A partial render: stop after the shot that reaches this length. */
  maxDurationMs?: number;
};

type Project = { id: string; language: string; readingDirection: "ltr" | "rtl" | "vertical" };

const SAMPLE_RATE = 24_000;
const silence = (ms: number) =>
  pcmToWav(new Uint8Array(Math.max(0, Math.round((ms / 1000) * SAMPLE_RATE)) * 2), SAMPLE_RATE);

/** No ffmpeg invocation in an export should outlive this; a wedged encoder would otherwise hold the export queue. */
const FFMPEG_TIMEOUT_MS = 60 * 60 * 1000;

async function run(cmd: string[], label: string, timeoutMs = FFMPEG_TIMEOUT_MS) {
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) {
      if (proc.killed) throw new Error(`${label} timed out after ${Math.round(timeoutMs / 60000)} minutes`);
      throw new Error(`${label} failed (${code}): ${stderr.slice(-600)}`);
    }
    return { stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

/** Blurred, darkened full-frame backdrop. Blurring a small copy then scaling up is as good for a heavy wash and ~10x faster. */
export async function backdrop(png: Uint8Array, frameW: number, frameH: number) {
  const small = await sharp(png)
    .resize(Math.round(frameW / 10), Math.round(frameH / 10), { fit: "cover" })
    .blur(2)
    .modulate({ brightness: 0.55 })
    .toBuffer();
  return new Uint8Array(await sharp(small).resize(frameW, frameH, { kernel: "cubic" }).png().toBuffer());
}

/** zoompan zoom expression over `frames` output frames (kenBurnsZoomAt is the same curve for the preview). */
export function kenBurnsZoom(shotType: string, zoom: number, frames: number) {
  const n = Math.max(1, frames);
  return kenBurnsPullsOut(shotType) ? `${(1 + zoom).toFixed(4)}-${zoom}*on/${n}` : `1+${zoom}*on/${n}`;
}

const srtTime = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(t / 3_600_000))}:${p(Math.floor(t / 60_000) % 60)}:${p(Math.floor(t / 1000) % 60)},${p(t % 1000, 3)}`;
};

export function toSrt(cues: { startMs: number; endMs: number; text: string }[]) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${c.text.trim()}\n`).join("\n");
}

type Narration = { byLine: Awaited<ReturnType<typeof narrationSegmentsFor>> };

type Shot = {
  /** Narration line ids spoken over this shot, in order. */
  lineIds: string[];
  report: Record<string, unknown>;
  label: string;
};

type EncodeShot<S extends Shot> = (
  shot: S,
  i: number,
  frames: number,
  holdSec: number,
  clipPath: string,
) => Promise<void>;

/**
 * Shared film pipeline. Pass 1 in shot order: narration audio appended to disk (never the whole film in memory),
 * frame-exact holds (narration + breath, at least minHold) and subtitle cues. Pass 2: shots encoded in parallel.
 * Then concat (video copied), AAC mux, ONE two-pass loudnorm over the whole film, and a duration check against
 * the source audio rather than the build log.
 */
async function buildFilm<S extends Shot>(
  deps: WorkerDeps,
  shots: S[],
  narration: Narration,
  opts: VideoOptions,
  dir: string,
  progress: (p: number) => Promise<void>,
  encodeShot: EncodeShot<S>,
) {
  const audioPath = join(dir, "narration.wav");
  const audioFile = await open(audioPath, "w");
  let audioBytes = 0;
  const appendAudio = async (wav: Uint8Array) => {
    const info = parseWav(wav);
    await audioFile.write(wav, info.dataOffset, info.dataLength, 44 + audioBytes);
    audioBytes += info.dataLength;
  };
  const cues: { startMs: number; endMs: number; text: string }[] = [];
  const holds: { frames: number; holdSec: number }[] = [];
  let totalFrames = 0;
  let clockMs = 0;
  try {
    for (const [i, shot] of shots.entries()) {
      const parts: { wav: Uint8Array; pauseAfterMs: number; text: string; ms: number }[] = [];
      let missing = 0;
      for (const lineId of shot.lineIds) {
        for (const { s: seg, a } of narration.byLine.get(lineId) ?? []) {
          const asset = a ? await deps.assets.get(a.assetId) : null;
          if (!asset) {
            missing++;
            continue;
          }
          let wav = await deps.assets.read(asset);
          const info = parseWav(wav);
          if (info.sampleRate !== SAMPLE_RATE || info.channels !== 1 || info.bitsPerSample !== 16)
            wav = await ffmpegConvert(wav, "wav", { tempDir: dir });
          parts.push({ wav, pauseAfterMs: seg.pauseAfterMs, text: seg.text, ms: parseWav(wav).durationMs });
        }
      }
      const joined = parts.length ? concatWav(parts) : null;
      const narrationMs = joined ? parseWav(joined).durationMs : 0;
      // Whole frames, so the clip and its padded audio are exactly the same length (no -shortest, no drift).
      const { frames, holdMs } = holdFor(narrationMs, Boolean(joined), opts.minHoldMs, opts.fps, opts.breathMs);
      let t = clockMs;
      for (const [k, part] of parts.entries()) {
        cues.push({ startMs: t, endMs: t + part.ms, text: part.text });
        t += part.ms + (k < parts.length - 1 ? part.pauseAfterMs : 0);
      }
      clockMs += holdMs;
      totalFrames += frames;
      if (joined) await appendAudio(joined);
      if (holdMs > narrationMs) await appendAudio(silence(holdMs - narrationMs));
      holds.push({ frames, holdSec: holdMs / 1000 });
      Object.assign(shot.report, {
        narrationMs,
        holdMs: Math.round(holdMs),
        segments: parts.length,
        missingAudio: missing,
      });
      await progress(0.02 + ((i + 1) / shots.length) * 0.08);
      // A partial render ends on a whole shot once the requested length is reached.
      if (opts.maxDurationMs && clockMs >= opts.maxDurationMs && i < shots.length - 1) {
        shots.splice(i + 1);
        break;
      }
    }
  } catch (e) {
    await audioFile.close().catch(() => {});
    throw e;
  }

  const clips = shots.map((_, i) => join(dir, `clip-${String(i + 1).padStart(5, "0")}.mp4`));
  const limiter = new ConcurrencyLimiter(Math.max(1, opts.concurrency ?? 1));
  let failed: unknown = null;
  let done = 0;
  // Wait for every running encode before surfacing the first error, so nothing writes into a removed temp dir.
  await Promise.all(
    shots.map((shot, i) =>
      limiter.run(async () => {
        if (failed) return;
        try {
          await encodeShot(shot, i, holds[i]!.frames, holds[i]!.holdSec, clips[i]!);
          done++;
          await progress(0.1 + (done / shots.length) * 0.55);
        } catch (e) {
          failed ??= e;
        }
      }),
    ),
  );
  if (failed) {
    await audioFile.close().catch(() => {});
    throw failed;
  }
  const header = silence(0).slice(0, 44);
  const hv = new DataView(header.buffer);
  hv.setUint32(4, 36 + audioBytes, true);
  hv.setUint32(40, audioBytes, true);
  await audioFile.write(header, 0, 44, 0);
  await audioFile.close();
  const audioMs = Math.round((audioBytes / (SAMPLE_RATE * 2)) * 1000);
  const listPath = join(dir, "clips.txt");
  await Bun.write(listPath, `${clips.map((c) => `file '${c}'`).join("\n")}\n`);

  const rawPath = join(dir, "raw.mp4");
  const aac = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];
  await run(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-i",
      audioPath,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      ...aac,
      "-t",
      (totalFrames / opts.fps).toFixed(3),
      "-movflags",
      "+faststart",
      rawPath,
    ],
    "video mux",
  );
  await Promise.all([...clips, audioPath].map((f) => rm(f)));
  await progress(0.75);

  const target = "I=-14:TP=-1.5:LRA=11";
  const measure = await run(
    ["ffmpeg", "-hide_banner", "-i", rawPath, "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"],
    "loudness measure",
  );
  const m = JSON.parse(
    measure.stderr.slice(measure.stderr.lastIndexOf("{"), measure.stderr.lastIndexOf("}") + 1),
  ) as Record<string, string>;
  const outPath = join(dir, "video.mp4");
  await run(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      rawPath,
      "-c:v",
      "copy",
      "-af",
      `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true`,
      ...aac,
      "-movflags",
      "+faststart",
      outPath,
    ],
    "loudness normalise",
  );
  await rm(rawPath);
  await progress(0.92);

  const probe = await run(
    ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", outPath],
    "ffprobe",
  );
  const videoMs = Math.round(Number(probe.stdout.trim()) * 1000);
  // Frame-exact holds leave only encoder rounding (AAC priming, last-frame duration): a few ms per clip is fine,
  // anything larger is a real mapping defect.
  const drift = Math.abs(videoMs - audioMs);
  const tolerance = 80 + 10 * clips.length;
  if (!Number.isFinite(videoMs) || drift > tolerance)
    throw new Error(
      `Rendered video is ${videoMs} ms but the narration is ${audioMs} ms (drift ${drift} ms > ${tolerance} ms)`,
    );
  return {
    path: outPath,
    srt: toSrt(cues),
    durationMs: videoMs,
    stats: {
      audioMs,
      videoMs,
      driftMs: drift,
      driftPerClipMs: Math.round((videoMs - audioMs) / clips.length),
      clips: clips.length,
      subtitleCues: cues.length,
      loudness: m,
    },
  };
}

type Scoped = VideoOptions & { language?: string; scope?: VideoScope };

async function plan(deps: WorkerDeps, project: Project, chapterId: string | null, opts: Scoped, cut: "page" | "panel") {
  const language = opts.language || project.language;
  const planned = await planVideoShots(deps.db, project, opts.scope ?? { chapterId }, cut, language);
  const byLine = await narrationSegmentsFor(
    deps.db,
    planned.shots.flatMap((s) => s.lineIds),
  );
  const shots = planned.shots.map((s) => ({
    ...s,
    report: {
      chapter: s.page.chapterOrder,
      page: s.page.order,
      ...(s.panelIndex ? { panel: s.panelIndex, shotType: s.panel!.shotType } : {}),
    } as Record<string, unknown>,
  }));
  return { language, shots, narration: { byLine }, unplacedLines: planned.unplacedLines };
}

/** Where a panel's visible crop sits in its artwork, and where its focus falls inside that crop. */
export function panelCrop(art: { width: number; height: number }, shot: Pick<PlannedShot, "page" | "panel">) {
  const pn = shot.panel!;
  const aspect = (pn.frame.width * shot.page.width) / Math.max(1, pn.frame.height * shot.page.height);
  return {
    aspect,
    crop: computeCrop(art.width, art.height, aspect, pn.imageTransform),
    focus: focusInCrop(art.width, art.height, aspect, pn.imageTransform),
  };
}

/**
 * Page cut: each page stays on screen for its own narration (at least `minHoldMs`), then cuts to the next.
 * `chapterId` null renders the whole project, chapters in order, as one film.
 */
export async function renderPageCutVideo(
  deps: WorkerDeps,
  project: Project,
  chapterId: string | null,
  opts: Scoped,
  dir: string,
  progress: (p: number) => Promise<void>,
) {
  const { frameW, frameH } = frameSizeFor(opts.height);
  const { language, shots, narration, unplacedLines } = await plan(deps, project, chapterId, opts, "page");
  const film = await buildFilm(deps, shots, narration, opts, dir, progress, async (shot, i, frames, holdSec, clip) => {
    const pg = shot.page;
    const { w: fgW, h: fgH } = pageShotBox(pg.width, pg.height, frameW, frameH, opts);
    const n = String(i + 1).padStart(5, "0");
    const render = await loadRenderPage(deps.db, deps.assets.storage, pg.id, project.readingDirection);
    const png = await renderPageImage(render, "png", { scale: Math.min(3, Math.max(0.25, (fgW / pg.width) * 1.25)) });
    const bgPath = join(dir, `bg-${n}.png`);
    const fgPath = join(dir, `fg-${n}.png`);
    await Bun.write(bgPath, await backdrop(png.data, frameW, frameH));
    await Bun.write(fgPath, new Uint8Array(await sharp(png.data).resize(fgW, fgH, { fit: "fill" }).png().toBuffer()));
    const { y0, travel } = scrollPlan(fgH - frameH, holdSec, opts.maxScrollPxPerSec, opts.framing);
    shot.report.scrollPxPerSec = travel ? Math.round(travel / holdSec) : 0;
    const fg =
      fgH > frameH
        ? `[1:v]crop=${fgW}:${frameH}:0:'${y0}+${travel}*t/${holdSec.toFixed(3)}'[fg];[0:v][fg]overlay=(W-w)/2:0`
        : `[0:v][1:v]overlay=(W-w)/2:(H-h)/2`;
    await encodeClip(bgPath, fgPath, `${fg},format=yuv420p[v]`, frames, opts.fps, clip, shot.label);
    await Promise.all([rm(bgPath), rm(fgPath)]);
  });
  return {
    path: film.path,
    srt: film.srt,
    width: frameW,
    height: frameH,
    durationMs: film.durationMs,
    report: { language, ...film.stats, pages: shots.map((s) => s.report), unplacedLines },
  };
}

/**
 * Panel cut (reference cut B): every panel gets the frame to itself for its own narration, with a slow Ken Burns
 * move — wide shots push in, close shots pull out — anchored on the image focus, over a blurred backdrop of the
 * same art. Shots already in the frame's 16:9 shape (film projects) fill the frame. Uses the clean artwork cropped
 * exactly as on the page, no bubbles; a panel with no artwork falls back to its lettered crop of the rendered page.
 */
export async function renderPanelCutVideo(
  deps: WorkerDeps,
  project: Project,
  chapterId: string | null,
  opts: Scoped,
  dir: string,
  progress: (p: number) => Promise<void>,
) {
  const { frameW, frameH } = frameSizeFor(opts.height);
  const zoom = opts.zoom ?? 0.06;
  const { language, shots, narration, unplacedLines } = await plan(deps, project, chapterId, opts, "panel");
  const film = await buildFilm(deps, shots, narration, opts, dir, progress, async (shot, i, frames, _holdSec, clip) => {
    const pg = shot.page;
    const pn = shot.panel!;
    const n = String(i + 1).padStart(5, "0");
    const aspect = (pn.frame.width * pg.width) / Math.max(1, pn.frame.height * pg.height);
    const box = panelShotBox(aspect, frameW, frameH);
    // Supersample 3x before zoompan: zooming at display size quantises the crop and visibly shakes.
    const superW = box.w * 3;
    const superH = Math.max(2, Math.round(superW / aspect / 2) * 2);
    const art = pn.activeArtworkAssetId ? await deps.assets.get(pn.activeArtworkAssetId) : null;
    let fgPng: Uint8Array;
    let focus = { x: 0.5, y: 0.5 };
    if (art) {
      fgPng = await renderPanelArt(await deps.assets.read(art), superW, superH, pn.imageTransform);
      focus = panelCrop({ width: art.width ?? superW, height: art.height ?? superH }, shot).focus;
      shot.report.source = "art";
    } else {
      const render = await loadRenderPage(deps.db, deps.assets.storage, pg.id, project.readingDirection);
      const scale = Math.min(3, Math.max(0.5, superW / Math.max(1, pn.frame.width * pg.width)));
      const page = await renderPageImage(render, "png", { scale });
      const left = Math.max(0, Math.round(pn.frame.x * page.width));
      const top = Math.max(0, Math.round(pn.frame.y * page.height));
      const width = Math.max(1, Math.min(page.width - left, Math.round(pn.frame.width * page.width)));
      const height = Math.max(1, Math.min(page.height - top, Math.round(pn.frame.height * page.height)));
      fgPng = new Uint8Array(
        await sharp(page.data)
          .extract({ left, top, width, height })
          .resize(superW, superH, { fit: "fill" })
          .png()
          .toBuffer(),
      );
      shot.report.source = "lettered-page-crop";
    }
    const bgPath = box.full ? null : join(dir, `bg-${n}.png`);
    const fgPath = join(dir, `fg-${n}.png`);
    if (bgPath) await Bun.write(bgPath, await backdrop(fgPng, frameW, frameH));
    await Bun.write(fgPath, fgPng);
    const z = kenBurnsZoom(pn.shotType, zoom, frames);
    Object.assign(shot.report, { zoom: kenBurnsPullsOut(pn.shotType) ? "out" : "in", fullFrame: box.full, focus });
    const move = `zoompan=z='${z}':x='(iw-iw/zoom)*${focus.x.toFixed(3)}':y='(ih-ih/zoom)*${focus.y.toFixed(3)}':d=1:s=${box.w}x${box.h}:fps=${opts.fps}`;
    const filter = bgPath
      ? `[1:v]${move}[fg];[0:v][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`
      : `[0:v]${move},format=yuv420p[v]`;
    await encodeClip(bgPath, fgPath, filter, frames, opts.fps, clip, shot.label, false);
    await Promise.all([bgPath ? rm(bgPath) : null, rm(fgPath)]);
  });
  return {
    path: film.path,
    srt: film.srt,
    width: frameW,
    height: frameH,
    durationMs: film.durationMs,
    report: { language, ...film.stats, panels: shots.map((s) => s.report), unplacedLines },
  };
}

async function encodeClip(
  bgPath: string | null,
  fgPath: string,
  filter: string,
  frames: number,
  fps: number,
  clip: string,
  label: string,
  still = true,
) {
  await run(
    [
      "ffmpeg",
      "-y",
      "-hide_banner",
      "-loglevel",
      "error",
      ...(bgPath ? ["-loop", "1", "-framerate", String(fps), "-i", bgPath] : []),
      "-loop",
      "1",
      "-framerate",
      String(fps),
      "-i",
      fgPath,
      "-filter_complex",
      filter,
      "-map",
      "[v]",
      "-frames:v",
      String(frames),
      "-r",
      String(fps),
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "20",
      ...(still ? ["-tune", "stillimage"] : []),
      clip,
    ],
    `${label} clip`,
  );
}
