import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegConvert, parseWav, pcmToWav } from "@openmanga/audio";
import { and, assets, eq, inArray, isNull, sql } from "@openmanga/db";
import {
  ConcurrencyLimiter,
  cardFrames,
  cropsToFrame,
  fadeFrames,
  frameSizeFor,
  type Motion,
  motionPath,
  type PageFraming,
  pageShotBox,
  panelShotBox,
  scrollPlan,
  shotGroups,
  timeGroup,
  type VideoAspect,
  watermarkBox,
} from "@openmanga/domain";
import { renderPanelArt, sharp } from "@openmanga/image-utils";
import {
  type BrandedProject,
  backdrop,
  loadRenderPage,
  narrationSegmentsFor,
  pageRenderFingerprint,
  panelAspect,
  planVideoShots,
  renderPageImage,
  renderProjectVideoCard,
  type VideoScope,
} from "@openmanga/services";
import { sha256Hex } from "@openmanga/storage";
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
  /** Frame shape: landscape (default), vertical or square. */
  aspect?: VideoAspect;
  /** A hard length limit (a Shorts cut): the film ends before the shot that would pass it. */
  capMs?: number;
  /** video_shorts: the requested length in seconds, which becomes `capMs`. */
  shortsSeconds?: number;
  /** Intro and outro cards, when the project has them (default true; a Shorts cut has none). */
  cards?: boolean;
};

type Project = Parameters<typeof planVideoShots>[1] & BrandedProject & { language: string };

const SAMPLE_RATE = 24_000;

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

/** A title card prepared for the render: its PNG at frame size, its length in frames and its section key. */
type Card = { path: string; frames: number; key: string };
/** The logo prepared for the render: scaled to its box, placed at x/y over every clip; `key` is what it looks like. */
type Watermark = { path: string; x: number; y: number; opacity: number; key: string };
type Branding = { intro: Card | null; outro: Card | null; watermark: Watermark | null };

/**
 * The project's video branding as files in the temp dir: intro and outro cards drawn by the same
 * `renderProjectVideoCard` the preview loads, and the logo scaled to its `watermarkBox`. A logo whose asset is gone
 * is left out rather than failing the render.
 */
async function prepareBranding(
  deps: WorkerDeps,
  project: Project,
  frameW: number,
  frameH: number,
  fps: number,
  dir: string,
  cards = true,
): Promise<Branding> {
  const video = project.settings.video;
  const card = async (which: "intro" | "outro") => {
    if (!cards) return null;
    const png = await renderProjectVideoCard(deps.db, deps.assets, project, which, frameW, frameH);
    if (!png || !video?.[which]) return null;
    const path = join(dir, `${which}.png`);
    await Bun.write(path, png);
    const frames = cardFrames(video[which].durationMs, fps);
    return { path, frames, key: sha256Hex(JSON.stringify({ card: sha256Hex(png), frames })) };
  };
  const wm = video?.watermark;
  const logo = wm ? await deps.assets.get(wm.assetId) : null;
  let watermark: Watermark | null = null;
  if (wm && logo?.width && logo.height && !logo.deletedAt && logo.projectId === project.id) {
    const box = watermarkBox(frameW, frameH, { width: logo.width, height: logo.height }, wm.corner, wm.size);
    const path = join(dir, "watermark.png");
    const png = await sharp(await deps.assets.read(logo))
      .resize(box.w, box.h, { fit: "fill" })
      .png()
      .toBuffer();
    await Bun.write(path, new Uint8Array(png));
    watermark = { path, ...box, opacity: wm.opacity, key: `${logo.sha256}:${JSON.stringify(box)}:${wm.opacity}` };
  }
  return { intro: await card("intro"), outro: await card("outro"), watermark };
}

/**
 * The zoompan filter for a camera move over `frames` output frames, at box size `w`×`h`. `motionPath` is the same
 * curve the preview plays: zoom, and where the window sits in the slack the zoom leaves.
 */
export function zoompanFor(
  motion: Motion,
  zoom: number,
  focus: { x: number; y: number },
  frames: number,
  w: number,
  h: number,
  fps: number,
) {
  const n = Math.max(1, frames);
  const path = motionPath(motion, zoom, focus);
  const lerp = ([a, b]: [number, number]) =>
    a === b ? a.toFixed(4) : `(${a.toFixed(4)}${b > a ? "+" : "-"}${Math.abs(b - a).toFixed(4)}*on/${n})`;
  return `zoompan=z='${lerp(path.z)}':x='(iw-iw/zoom)*${lerp(path.x)}':y='(ih-ih/zoom)*${lerp(path.y)}':d=1:s=${w}x${h}:fps=${fps}`;
}

/** ffmpeg fades for a scene break at either end of a clip (fadeOpacity is the same ramp for the preview). */
export function fadeFilter(fade: { in: boolean; out: boolean }, frames: number, fps: number) {
  const n = fadeFrames(frames, fps);
  if (!n) return "";
  return `${fade.in ? `,fade=t=in:s=0:n=${n}` : ""}${fade.out ? `,fade=t=out:s=${frames - n}:n=${n}` : ""}`;
}

const srtTime = (ms: number) => {
  const t = Math.max(0, Math.round(ms));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(t / 3_600_000))}:${p(Math.floor(t / 60_000) % 60)}:${p(Math.floor(t / 1000) % 60)},${p(t % 1000, 3)}`;
};

export function toSrt(cues: { startMs: number; endMs: number; text: string }[]) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.startMs)} --> ${srtTime(c.endMs)}\n${c.text.trim()}\n`).join("\n");
}

type Narration = {
  byLine: Awaited<ReturnType<typeof narrationSegmentsFor>>;
  /** Each line's start and end offsets. */
  offsets: Map<string, { startOffsetMs: number; endOffsetMs: number }>;
};

type Shot = {
  /** Narration line ids spoken over this shot, in order. */
  lineIds: string[];
  /** Shares one hold with the next shot (a narration line spans the cut). */
  joinNext: boolean;
  fade: { in: boolean; out: boolean };
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
 * Bump when a clip's pixels change for the same inputs (the encoder settings, a filter, the compositor), so cached
 * sections are encoded again.
 */
const SECTION_VERSION = 1;

/** What a render needs besides its shots: the frame, the branding, and how to describe a shot for the section cache. */
type FilmSetup<S extends Shot> = {
  projectId: string;
  frameW: number;
  frameH: number;
  branding: Branding;
  /** Everything besides the common frame, fps and logo that decides a shot clip's pixels: hashed into its key. */
  describe: (shot: S, frames: number) => Promise<Record<string, unknown>>;
  /** Told every section key of the film before any clip is encoded, so the export can claim them. */
  onSections?: (keys: string[]) => Promise<void>;
};

/**
 * Shared film pipeline. Pass 1 in shot order, one hold group at a time (a shot, or the run of shots a narration line
 * spans): narration audio written to disk at its place on the film clock (never the whole film in memory),
 * frame-exact holds from `timeGroup` (narration + breath, at least minHold) and subtitle cues. Pass 2: shots encoded
 * in parallel.
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
  film: FilmSetup<S>,
  encodeShot: EncodeShot<S>,
) {
  const { branding } = film;
  const audioPath = join(dir, "narration.wav");
  const audioFile = await open(audioPath, "w");
  let audioBytes = 0;
  const appendPcm = async (data: Uint8Array, offset: number, length: number) => {
    await audioFile.write(data, offset, length, 44 + audioBytes);
    audioBytes += length;
  };
  // Silence up to a sample position on the film clock. Positions are absolute, so rounding never accumulates.
  const padTo = async (sample: number) => {
    const bytes = Math.max(0, sample * 2 - audioBytes);
    if (bytes) await appendPcm(new Uint8Array(bytes), 0, bytes);
  };
  const sampleAt = (ms: number) => Math.round((ms / 1000) * SAMPLE_RATE);
  const cues: { startMs: number; endMs: number; text: string }[] = [];
  const holds: { frames: number; holdSec: number }[] = [];
  /** Where each shot starts in the film, for chapter timestamps. */
  const startsMs: number[] = [];
  let totalFrames = 0;
  // A card is silence on the audio track; everything after it (cues, chapter marks) starts that much later.
  const holdCard = async (card: Card) => {
    totalFrames += card.frames;
    await padTo(sampleAt((totalFrames * 1000) / opts.fps));
  };
  let partial = false;
  const groups = shotGroups(shots.map((s) => s.joinNext));
  try {
    if (branding.intro) await holdCard(branding.intro);
    for (const [gi, g] of groups.entries()) {
      const members = shots.slice(g.first, g.last + 1);
      const lines: { wav: Uint8Array; text: string; pauseAfterMs: number; ms: number }[][] = [];
      const ownLines: number[] = [];
      for (const [m, shot] of members.entries()) {
        let missing = 0;
        for (const lineId of shot.lineIds) {
          const parts: (typeof lines)[number] = [];
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
            parts.push({ wav, text: seg.text, pauseAfterMs: seg.pauseAfterMs, ms: parseWav(wav).durationMs });
          }
          lines.push(parts);
          ownLines.push(m);
        }
        Object.assign(shot.report, {
          segments: lines.filter((_, k) => ownLines[k] === m).reduce((n, l) => n + l.length, 0),
          missingAudio: missing,
        });
      }
      const lineIds = members.flatMap((s) => s.lineIds);
      // Whole frames, so the clips and their padded audio are exactly the same length (no -shortest, no drift).
      const timing = timeGroup(
        lines.map((parts, k) => ({
          startOffsetMs: narration.offsets.get(lineIds[k]!)?.startOffsetMs ?? 0,
          endOffsetMs: narration.offsets.get(lineIds[k]!)?.endOffsetMs ?? 0,
          segments: parts,
        })),
        members.length,
        { minHoldMs: opts.minHoldMs, fps: opts.fps, breathMs: opts.breathMs },
      );
      // A capped film (a Shorts cut) ends before the first shot that would run past the limit.
      if (opts.capMs && gi > 0 && ((totalFrames + timing.totalFrames) * 1000) / opts.fps > opts.capMs) {
        shots.splice(g.first);
        partial = true;
        break;
      }
      const groupMs = (totalFrames * 1000) / opts.fps;
      for (const [k, parts] of lines.entries()) {
        for (const [j, part] of parts.entries()) {
          const at = groupMs + timing.starts[k]![j]!;
          cues.push({ startMs: at, endMs: at + part.ms, text: part.text });
          await padTo(sampleAt(at));
          const info = parseWav(part.wav);
          await appendPcm(part.wav, info.dataOffset, info.dataLength);
        }
      }
      for (const [m, shot] of members.entries()) {
        const frames = timing.frames[m]!;
        startsMs.push((totalFrames * 1000) / opts.fps);
        totalFrames += frames;
        holds.push({ frames, holdSec: frames / opts.fps });
        Object.assign(shot.report, {
          holdMs: Math.round((frames * 1000) / opts.fps),
          ...(m === 0 ? { narrationMs: timing.narrationMs } : {}),
          ...(members.length > 1 ? { spanShots: members.length } : {}),
          ...(shot.fade.in || shot.fade.out ? { fade: shot.fade } : {}),
        });
      }
      await padTo(sampleAt((totalFrames * 1000) / opts.fps));
      await progress(0.02 + ((gi + 1) / groups.length) * 0.08);
      // A partial render ends on a whole shot (or span) once the requested length is reached.
      const clockMs = (totalFrames * 1000) / opts.fps;
      if (opts.maxDurationMs && clockMs >= opts.maxDurationMs && g.last < shots.length - 1) {
        shots.splice(g.last + 1);
        partial = true;
        break;
      }
    }
    // A partial render is for checking the film itself, so it ends without the outro.
    if (branding.outro && !partial) await holdCard(branding.outro);
  } catch (e) {
    await audioFile.close().catch(() => {});
    throw e;
  }

  // Clips in film order: the intro card, the shots, the outro card. Each is a section: its key hashes everything that
  // decides its pixels and length, and a clip a previous render stored under the same key is reused, not encoded.
  const clipPath = (n: number) => join(dir, `clip-${String(n).padStart(5, "0")}.mp4`);
  const common = {
    v: SECTION_VERSION,
    frame: [film.frameW, film.frameH],
    fps: opts.fps,
    watermark: branding.watermark?.key ?? null,
  };
  const keyOf = (part: unknown) => sha256Hex(JSON.stringify({ ...common, part }));
  const cardJob = (card: Card, n: number) => ({
    clip: clipPath(n),
    key: keyOf(card.key),
    encode: (clip: string) =>
      encodeClip(null, card.path, "[0:v]null", card.frames, opts.fps, clip, "card", true, branding.watermark),
  });
  const jobs = [
    ...(branding.intro ? [cardJob(branding.intro, 0)] : []),
    ...(await Promise.all(
      shots.map(async (shot, i) => ({
        clip: clipPath(i + 1),
        key: keyOf(await film.describe(shot, holds[i]!.frames)),
        encode: (clip: string) => encodeShot(shot, i, holds[i]!.frames, holds[i]!.holdSec, clip),
      })),
    )),
    ...(branding.outro && !partial ? [cardJob(branding.outro, shots.length + 1)] : []),
  ];
  const clips = jobs.map((j) => j.clip);
  const keys = [...new Set(jobs.map((j) => j.key))];
  await film.onSections?.(keys);
  const cached = new Map(
    (
      await deps.db
        .select()
        .from(assets)
        .where(
          and(
            eq(assets.projectId, film.projectId),
            isNull(assets.deletedAt),
            inArray(sql<string>`${assets.metadata}->'renderSection'->>'key'`, keys),
          ),
        )
    ).map((a) => [(a.metadata.renderSection as { key: string }).key, a]),
  );
  let reused = 0;
  const limiter = new ConcurrencyLimiter(Math.max(1, opts.concurrency ?? 1));
  let failed: unknown = null;
  let done = 0;
  // A cached section is copied in; anything else is encoded and stored for the next render.
  const section = async (job: (typeof jobs)[number]) => {
    const hit = cached.get(job.key);
    if (hit) {
      const copied = await Bun.write(job.clip, new Response(deps.assets.storage.stream(hit.storageKey))).catch(() => 0);
      if (copied > 0) {
        reused++;
        return;
      }
    }
    await job.encode(job.clip);
    if (cached.has(job.key)) return;
    cached.set(
      job.key,
      await deps.assets.store({
        projectId: film.projectId,
        ownerUserId: null,
        type: "export",
        filePath: job.clip,
        mimeType: "video/mp4",
        metadata: { renderSection: { key: job.key } },
      }),
    );
  };
  // Wait for every running encode before surfacing the first error, so nothing writes into a removed temp dir.
  await Promise.all(
    jobs.map((job) =>
      limiter.run(async () => {
        if (failed) return;
        try {
          await section(job);
          done++;
          await progress(0.1 + (done / jobs.length) * 0.55);
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
  const header = pcmToWav(new Uint8Array(0), SAMPLE_RATE);
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
    startsMs,
    stats: {
      audioMs,
      videoMs,
      driftMs: drift,
      driftPerClipMs: Math.round((videoMs - audioMs) / clips.length),
      clips: clips.length,
      sections: { reused, encoded: clips.length - reused },
      subtitleCues: cues.length,
      loudness: m,
    },
  };
}

type Scoped = VideoOptions & {
  language?: string;
  scope?: VideoScope;
  onSections?: (keys: string[]) => Promise<void>;
};

/** The first shot of each chapter and where it starts, in film order. */
function chapterStarts(shots: { page: { chapterId: string } }[], startsMs: number[]) {
  const out: { chapterId: string; startMs: number }[] = [];
  shots.forEach((s, i) => {
    if (out.at(-1)?.chapterId !== s.page.chapterId)
      out.push({ chapterId: s.page.chapterId, startMs: startsMs[i] ?? 0 });
  });
  return out;
}

async function plan(deps: WorkerDeps, project: Project, chapterId: string | null, opts: Scoped, cut: "page" | "panel") {
  const language = opts.language || project.language;
  const { frameW, frameH } = frameSizeFor(opts.height, opts.aspect);
  const planned = await planVideoShots(deps.db, project, opts.scope ?? { chapterId }, cut, language, {
    cropAspect: cropsToFrame(opts.aspect ?? "16:9") ? frameW / frameH : undefined,
  });
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
  const offsets = new Map(
    planned.lines.map((l) => [
      l.id,
      { startOffsetMs: l.video?.startOffsetMs ?? 0, endOffsetMs: l.video?.endOffsetMs ?? 0 },
    ]),
  );
  return {
    language,
    shots,
    narration: { byLine, offsets },
    unplacedLines: planned.unplacedLines,
    disabledPanels: planned.disabledPanels,
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
  const { frameW, frameH } = frameSizeFor(opts.height, opts.aspect);
  const { language, shots, narration, unplacedLines, disabledPanels } = await plan(
    deps,
    project,
    chapterId,
    opts,
    "page",
  );
  const branding = await prepareBranding(deps, project, frameW, frameH, opts.fps, dir, opts.cards !== false);
  const film = await buildFilm(
    deps,
    shots,
    narration,
    opts,
    dir,
    progress,
    {
      projectId: project.id,
      frameW,
      frameH,
      branding,
      onSections: opts.onSections,
      // The lettered page (its render fingerprint), its framing and scroll, its length and its fades.
      describe: async (shot, frames) => ({
        cut: "page",
        page: await pageRenderFingerprint(deps.db, shot.page.id, project.readingDirection),
        size: [shot.page.width, shot.page.height],
        framing: [opts.framing, opts.pageWidthRatio, opts.pageHeightRatio, opts.maxScrollPxPerSec],
        frames,
        fade: shot.fade,
      }),
    },
    async (shot, i, frames, holdSec, clip) => {
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
      const filter = fg + fadeFilter(shot.fade, frames, opts.fps);
      await encodeClip(bgPath, fgPath, filter, frames, opts.fps, clip, shot.label, true, branding.watermark);
      await Promise.all([rm(bgPath), rm(fgPath)]);
    },
  );
  return {
    path: film.path,
    srt: film.srt,
    width: frameW,
    height: frameH,
    durationMs: film.durationMs,
    chapterStarts: chapterStarts(shots, film.startsMs),
    report: { language, ...film.stats, pages: shots.map((s) => s.report), unplacedLines, disabledPanels },
  };
}

/**
 * Panel cut (reference cut B): every panel gets the frame to itself for its own narration, with a slow camera move
 * — by default wide shots push in and close shots pull out, varied so neighbours differ; each shot can set its own —
 * anchored on the image focus, over a blurred backdrop of the same art. Shots already in the frame's 16:9 shape
 * (film projects) fill the frame. Uses the clean artwork cropped exactly as on the page, no bubbles; a panel with
 * no artwork falls back to its lettered crop of the rendered page.
 */
export async function renderPanelCutVideo(
  deps: WorkerDeps,
  project: Project,
  chapterId: string | null,
  opts: Scoped,
  dir: string,
  progress: (p: number) => Promise<void>,
) {
  const { frameW, frameH } = frameSizeFor(opts.height, opts.aspect);
  const zoom = opts.zoom ?? 0.06;
  const { language, shots, narration, unplacedLines, disabledPanels } = await plan(
    deps,
    project,
    chapterId,
    opts,
    "panel",
  );
  const branding = await prepareBranding(deps, project, frameW, frameH, opts.fps, dir, opts.cards !== false);
  const film = await buildFilm(
    deps,
    shots,
    narration,
    opts,
    dir,
    progress,
    {
      projectId: project.id,
      frameW,
      frameH,
      branding,
      onSections: opts.onSections,
      // The artwork (its hash) and how it is cropped, or the lettered page when there is none; the move, its length
      // and its fades.
      describe: async (shot, frames) => {
        const pn = shot.panel!;
        return {
          cut: "panel",
          art: shot.art?.sha256 ?? null,
          lettered: shot.art ? null : await pageRenderFingerprint(deps.db, shot.page.id, project.readingDirection),
          transform: pn.imageTransform,
          frame: pn.frame,
          size: [shot.page.width, shot.page.height],
          motion: shot.motion,
          focus: shot.focus,
          zoom,
          frames,
          fade: shot.fade,
        };
      },
    },
    async (shot, i, frames, _holdSec, clip) => {
      const pg = shot.page;
      const pn = shot.panel!;
      const n = String(i + 1).padStart(5, "0");
      const { art, focus } = shot;
      // Vertical and square frames crop the art to their own shape around its focal point; landscape keeps the panel.
      const fill = Boolean(art) && cropsToFrame(opts.aspect ?? "16:9");
      const aspect = fill ? frameW / frameH : panelAspect(pn, pg);
      const box = fill ? { full: true, w: frameW, h: frameH } : panelShotBox(aspect, frameW, frameH);
      // Supersample 3x before zoompan: zooming at display size quantises the crop and visibly shakes.
      const superW = box.w * 3;
      const superH = Math.max(2, Math.round(superW / aspect / 2) * 2);
      let fgPng: Uint8Array;
      if (art) {
        fgPng = await renderPanelArt(await deps.assets.read(art), superW, superH, pn.imageTransform);
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
      const motion = shot.motion ?? "static";
      Object.assign(shot.report, { motion, fullFrame: box.full, cropped: fill, focus });
      const move = zoompanFor(motion, zoom, focus, frames, box.w, box.h, opts.fps);
      const filter = bgPath ? `[1:v]${move}[fg];[0:v][fg]overlay=(W-w)/2:(H-h)/2` : `[0:v]${move}`;
      const fade = fadeFilter(shot.fade, frames, opts.fps);
      await encodeClip(bgPath, fgPath, filter + fade, frames, opts.fps, clip, shot.label, false, branding.watermark);
      await Promise.all([bgPath ? rm(bgPath) : null, rm(fgPath)]);
    },
  );
  return {
    path: film.path,
    srt: film.srt,
    width: frameW,
    height: frameH,
    durationMs: film.durationMs,
    chapterStarts: chapterStarts(shots, film.startsMs),
    report: { language, ...film.stats, panels: shots.map((s) => s.report), unplacedLines, disabledPanels },
  };
}

/**
 * Encodes one clip. `filter` ends on the picture's stream (no label); the watermark (over any fade, so the logo stays
 * up through a scene break), the pixel format and the output label are added here.
 */
async function encodeClip(
  bgPath: string | null,
  fgPath: string,
  filter: string,
  frames: number,
  fps: number,
  clip: string,
  label: string,
  still = true,
  watermark: Watermark | null = null,
) {
  const logo = bgPath ? 2 : 1;
  const graph = watermark
    ? `${filter}[base];[${logo}:v]format=rgba,colorchannelmixer=aa=${watermark.opacity.toFixed(3)}[wm];[base][wm]overlay=${watermark.x}:${watermark.y},format=yuv420p[v]`
    : `${filter},format=yuv420p[v]`;
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
      ...(watermark ? ["-loop", "1", "-framerate", String(fps), "-i", watermark.path] : []),
      "-filter_complex",
      graph,
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
