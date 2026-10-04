/** Pure video-cut maths shared by the final ffmpeg render and the in-browser preview. */

import type { ShotMotion } from "@openmanga/schemas";

/**
 * Silence added after a shot's narration so a cut doesn't clip the last word. Segments are silence-trimmed when
 * stored, so this is the only pause at a cut besides the segment's own pauseAfterMs; 400 ms on top of untrimmed
 * voice padding made every shot change an audible ~1.2 s hole.
 */
export const VIDEO_BREATH_MS = 150;

/**
 * How far a rendered video may run from its narration: frame-exact holds leave only encoder rounding (AAC priming,
 * last-frame duration), a few ms per clip. Anything larger is a real mapping defect.
 */
export const videoDriftToleranceMs = (clips: number) => 80 + 10 * clips;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

/**
 * Frame size of a video profile. `height` is the short side (720, 1080, 1440): 1080 gives 1920×1080 landscape,
 * 1080×1920 vertical and 1080×1080 square.
 */
export function frameSizeFor(height: number, aspect: VideoAspect = "16:9") {
  const long = Math.round((height * 16) / 9 / 2) * 2;
  return aspect === "9:16"
    ? { frameW: height, frameH: long }
    : { frameW: aspect === "1:1" ? height : long, frameH: height };
}

/**
 * Whether panels fill a frame of this shape by cropping their art around its focal point. Landscape keeps the whole
 * panel (fitted over a blurred copy when its shape differs); vertical and square frames crop, since a fitted panel
 * would be a small stripe in the middle. Art is never generated at these shapes.
 */
export const cropsToFrame = (aspect: VideoAspect) => aspect !== "16:9";

/**
 * Vertical camera travel for a page taller than the frame: at most `maxPxPerSec`; when the hold is too short to
 * cover the overflow at that rate, the visible window is centred instead of showing only the top.
 */
/** Page framings: 3/5 width with a capped scroll, the whole page, or 3/5 width scrolling the whole page top to bottom. */
export type PageFraming = "width" | "height" | "scroll";

/** Travel over a hold: capped at `maxPxPerSec`, or the whole overflow for the continuous scroll framing. */
export function scrollPlan(overflowPx: number, holdSec: number, maxPxPerSec: number, framing?: PageFraming) {
  if (overflowPx <= 0) return { y0: 0, travel: 0 };
  if (framing === "scroll") return { y0: 0, travel: Math.round(overflowPx) };
  const travel = Math.min(overflowPx, maxPxPerSec * holdSec);
  return { y0: Math.round((overflowPx - travel) / 2), travel: Math.round(travel) };
}

/** Wide shots push in, close shots pull out (reference cut B). */
export const kenBurnsPullsOut = (shotType: string) =>
  shotType === "close" || shotType === "extreme-close" || shotType === "insert";

/** A camera move as rendered: a shot's motion with "auto" resolved. */
export type Motion = Exclude<ShotMotion, "auto">;

/**
 * Resolves each shot's motion in film order. "auto" is the push or pull its shot type calls for, but never the
 * same move as the shot before: a repeat becomes a pan towards the image focus (sideways, else up or down), so a
 * run of wide shots does not read as one long zoom. An explicit motion is always kept as set.
 */
export function resolveMotions(
  shots: { motion?: ShotMotion | null; shotType: string; focus: { x: number; y: number } }[],
) {
  const out: Motion[] = [];
  for (const s of shots) {
    if (s.motion && s.motion !== "auto") {
      out.push(s.motion);
      continue;
    }
    const base: Motion = kenBurnsPullsOut(s.shotType) ? "pull-out" : "push-in";
    const options: Motion[] = [
      base,
      s.focus.x >= 0.5 ? "pan-right" : "pan-left",
      s.focus.y >= 0.5 ? "pan-down" : "pan-up",
    ];
    out.push(options.find((m) => m !== out.at(-1)) ?? base);
  }
  return out;
}

type Span = [number, number];

/**
 * Where a move starts and ends: zoom factor `z`, and where the visible window sits in the slack the zoom leaves
 * (`x`, `y`: 0 = left/top edge, 1 = right/bottom). Zooms stay anchored on the focus; pans travel the whole slack
 * at `1 + zoom` and keep the focus on the other axis. The render's zoompan and the preview both read this.
 */
export function motionPath(m: Motion, zoom: number, focus: { x: number; y: number }) {
  const z = 1 + zoom;
  const at = (v: number): Span => [v, v];
  const path = (zs: Span, xs: Span, ys: Span) => ({ z: zs, x: xs, y: ys });
  switch (m) {
    case "static":
      return path(at(1), at(focus.x), at(focus.y));
    case "push-in":
      return path([1, z], at(focus.x), at(focus.y));
    case "pull-out":
      return path([z, 1], at(focus.x), at(focus.y));
    case "pan-left":
      return path(at(z), [1, 0], at(focus.y));
    case "pan-right":
      return path(at(z), [0, 1], at(focus.y));
    case "pan-up":
      return path(at(z), at(focus.x), [1, 0]);
    case "pan-down":
      return path(at(z), at(focus.x), [0, 1]);
  }
}

/** A move at `t` (0..1 of the hold). */
export function motionAt(path: ReturnType<typeof motionPath>, t: number) {
  const lerp = ([a, b]: Span) => a + (b - a) * t;
  return { z: lerp(path.z), x: lerp(path.x), y: lerp(path.y) };
}

/** Fade to black at a scene break: half a second each side of the cut, never more than a third of a shot. */
export const VIDEO_FADE_MS = 500;
export const fadeFrames = (frames: number, fps: number) =>
  Math.min(Math.round((VIDEO_FADE_MS * fps) / 1000), Math.floor(frames / 3));

/** Black over the picture at frame `k` (may be fractional) of a shot: 1 = black. The same ramps as ffmpeg's fade. */
export function fadeOpacity(k: number, frames: number, fps: number, fade: { in: boolean; out: boolean }) {
  const n = fadeFrames(frames, fps);
  if (!n) return 0;
  return Math.min(1, Math.max(0, fade.in ? 1 - k / n : 0, fade.out ? (k - (frames - n)) / n : 0));
}

/**
 * Which cuts fade through black: where the scene changes, when the project asks for it, unless the shot after the
 * cut overrides it ("on" fades even inside a scene, "off" never). Index i is the cut into shot i; never the first.
 */
export function fadeCuts(shots: { sceneId: string | null; fade?: "auto" | "on" | "off" }[], atSceneBreaks: boolean) {
  return shots.map((s, i) => {
    if (i === 0) return false;
    if (s.fade === "on" || s.fade === "off") return s.fade === "on";
    return atSceneBreaks && s.sceneId !== shots[i - 1]!.sceneId;
  });
}

/** An intro or outro card's length in whole frames. */
export const cardFrames = (durationMs: number, fps: number) => Math.max(1, Math.round((durationMs * fps) / 1000));

/**
 * Where a logo watermark sits: `size` of the frame width, its own aspect, in a corner with a margin of 3% of the
 * frame's short side. Even sizes, so the render's overlay and the preview's box are the same pixels.
 */
export function watermarkBox(
  frameW: number,
  frameH: number,
  logo: { width: number; height: number },
  corner: "top-left" | "top-right" | "bottom-left" | "bottom-right",
  size: number,
) {
  const w = even(frameW * size);
  const h = even((w * logo.height) / Math.max(1, logo.width));
  const m = Math.round(Math.min(frameW, frameH) * 0.03);
  return {
    x: corner.endsWith("left") ? m : frameW - m - w,
    y: corner.startsWith("top") ? m : frameH - m - h,
    w,
    h,
  };
}

/** Largest even-sized box of `aspect` inside `maxW`×`maxH`. */
export function fitBox(aspect: number, maxW: number, maxH: number) {
  const floorEven = (n: number) => Math.max(2, Math.floor(n / 2) * 2);
  const w = floorEven(Math.min(maxW, maxH * aspect));
  return { w, h: Math.min(floorEven(maxH), floorEven(w / aspect)) };
}

/** Panel-cut geometry: a shot already in the frame's shape fills it; otherwise it sits inside a 3% margin. */
export function panelShotBox(aspect: number, frameW: number, frameH: number) {
  const full = Math.abs(aspect - frameW / frameH) < 0.02;
  return { full, ...(full ? { w: frameW, h: frameH } : fitBox(aspect, frameW * 0.94, frameH * 0.94)) };
}

/**
 * Page-cut geometry for a page of `pageW`×`pageH`. A page already in the frame's shape (a film project's 16:9
 * shots) fills the frame: at 3/5 width it would sit pillarboxed on a blurred wash with no overflow to scroll,
 * i.e. a completely static video.
 */
export function pageShotBox(
  pageW: number,
  pageH: number,
  frameW: number,
  frameH: number,
  o: { framing: PageFraming; pageWidthRatio: number; pageHeightRatio: number },
) {
  if (Math.abs(pageW / pageH - frameW / frameH) < 0.02) return { w: frameW, h: frameH };
  const w =
    o.framing !== "height" ? even(frameW * o.pageWidthRatio) : even((pageW / pageH) * frameH * o.pageHeightRatio);
  return { w, h: even((pageH / pageW) * w) };
}

/** Frame-exact hold: narration plus a breath (when there is any), at least `minHoldMs`, rounded up to whole frames. */
export function holdFor(
  narrationMs: number,
  hasNarration: boolean,
  minHoldMs: number,
  fps: number,
  breathMs: number = VIDEO_BREATH_MS,
) {
  const frames = Math.ceil((Math.max(minHoldMs, narrationMs + (hasNarration ? breathMs : 0)) * fps) / 1000);
  return { frames, holdMs: (frames * 1000) / fps };
}

/**
 * Runs of shots that share one hold because a narration line spans the cut between them: `joinNext[i]` joins shot
 * i to shot i + 1. Most groups are a single shot.
 */
export function shotGroups(joinNext: boolean[]) {
  const groups: { first: number; last: number }[] = [];
  joinNext.forEach((_, i) => {
    const g = groups.at(-1);
    if (g && joinNext[i - 1]) g.last = i;
    else groups.push({ first: i, last: i });
  });
  return groups;
}

/** A narration line for timing: its offsets and the durations of its voiced segments (silent ones are left out). */
export type TimedLine = {
  startOffsetMs: number;
  endOffsetMs: number;
  segments: { ms: number; pauseAfterMs: number }[];
};

/**
 * Timing of one hold group (see `shotGroups`). Its lines play one after another: the start offset, the segments
 * with their pauses between them, the end offset, then the line's last pause before the next line. The group holds
 * that plus a breath, at least `minHoldMs` per shot, in whole frames split evenly over its shots (earlier shots take
 * the odd frames). A single shot without offsets times exactly as `holdFor`. `starts[line][segment]` is where each
 * voiced segment begins, from the start of the group.
 */
export function timeGroup(
  lines: TimedLine[],
  shotCount: number,
  o: {
    minHoldMs: number;
    fps: number;
    breathMs?: number;
    /** Per-shot minimum holds that replace `minHoldMs` for that shot (a shot's own hold setting). */
    minHolds?: (number | null | undefined)[];
  },
) {
  let t = 0;
  let voiced = 0;
  let pause = 0;
  const starts = lines.map((line) => {
    if (!line.segments.length) return [];
    if (voiced) t += pause;
    t += line.startOffsetMs;
    const at = line.segments.map((s, k) => {
      if (k) t += line.segments[k - 1]!.pauseAfterMs;
      const start = t;
      t += s.ms;
      return start;
    });
    t += line.endOffsetMs;
    pause = line.segments.at(-1)!.pauseAfterMs;
    voiced += line.segments.length;
    return at;
  });
  // Each shot gets at least its minimum; the rest of the group's length is shared evenly (earlier shots take the odd
  // frames). With equal minimums this is the even split of the whole.
  const mins = Array.from(
    { length: shotCount },
    (_, i) => holdFor(0, false, o.minHolds?.[i] ?? o.minHoldMs, o.fps).frames,
  );
  const base = mins.reduce((a, b) => a + b, 0);
  const totalFrames = Math.max(base, holdFor(t, voiced > 0, 0, o.fps, o.breathMs).frames);
  const extra = totalFrames - base;
  const frames = mins.map((m, i) => m + Math.floor(extra / shotCount) + (i < extra % shotCount ? 1 : 0));
  return { narrationMs: t, voiced, starts, frames, totalFrames, holdMs: (totalFrames * 1000) / o.fps };
}

/**
 * A whole timeline: every hold group in order (see `shotGroups`, `timeGroup`), with where each shot and each voiced
 * segment starts on the film clock. The preview, the timing report and the render all time a film this way.
 */
export function timeShots(
  shots: { joinNext: boolean; minHoldMs?: number | null; lines: TimedLine[] }[],
  o: { minHoldMs: number; fps: number; breathMs?: number; capMs?: number },
) {
  let frames = 0;
  const at = (f: number) => (f * 1000) / o.fps;
  const out: { startMs: number; frames: number; holdMs: number; group: number }[] = [];
  const groups: (ReturnType<typeof timeGroup> & { first: number; last: number; startMs: number })[] = [];
  for (const g of shotGroups(shots.map((s) => s.joinNext))) {
    const members = shots.slice(g.first, g.last + 1);
    const timing = timeGroup(
      members.flatMap((s) => s.lines),
      members.length,
      { ...o, minHolds: members.map((s) => s.minHoldMs) },
    );
    // A length limit (a Shorts cut) ends before the group that would pass it, as the render does.
    if (o.capMs && out.length && at(frames + timing.totalFrames) > o.capMs) break;
    groups.push({ ...timing, first: g.first, last: g.last, startMs: at(frames) });
    for (const n of timing.frames) {
      out.push({ startMs: at(frames), frames: n, holdMs: at(n), group: groups.length - 1 });
      frames += n;
    }
  }
  return { shots: out, groups, totalFrames: frames, totalMs: at(frames) };
}

/** A YouTube-style timestamp: m:ss, or h:mm:ss from an hour on. */
export function youtubeTimestamp(ms: number) {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = String(t % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * Chapter list for a video description, from where each chapter starts in the render. YouTube reads it when the
 * first entry is 0:00, so the first mark is pinned there. Null for fewer than two chapters (nothing to navigate).
 */
export function youtubeChapters(marks: { startMs: number; title: string }[]) {
  if (marks.length < 2) return null;
  return marks.map((m, i) => `${youtubeTimestamp(i === 0 ? 0 : m.startMs)} ${m.title}`).join("\n");
}

/** Video frame shapes: landscape for YouTube, vertical for Shorts and Reels, square for feeds. */
export type VideoAspect = "16:9" | "9:16" | "1:1";

/** How dramatic a shot type reads in a trailer: close-ups and inserts first, establishing wides next. */
const SHOT_DRAMA: Record<string, number> = {
  "extreme-close": 3,
  close: 2.5,
  insert: 2,
  "medium-close": 1.5,
  "extreme-wide": 1.5,
  wide: 1,
  full: 0.8,
  medium: 0.5,
};

/** How dramatic a narration line reads: exclamations, questions, a short punch, words of sudden action. */
export function lineDrama(text: string) {
  const t = text.trim();
  if (!t) return 0;
  let s = Math.min(2, (t.match(/!/g)?.length ?? 0) * 0.7) + Math.min(1, (t.match(/\?/g)?.length ?? 0) * 0.5);
  if (t.split(/\s+/).length <= 12) s += 0.5;
  if (
    /\b(sudden|scream|blood|explo|crash|attack|kill|dead|death|shatter|fire|gun|sword|truth|never|secret|run)/i.test(t)
  )
    s += 1;
  return s;
}

/**
 * A Shorts cut's length: at least 30 s, 3 minutes by default (YouTube's Shorts limit), and up to 10 minutes when the
 * user asks for a longer cut. The picker fills up to the chosen length and the render never runs past it.
 */
export const SHORTS_MIN_MS = 30_000;
export const SHORTS_DEFAULT_MS = 180_000;
export const SHORTS_LIMIT_MS = 600_000;
/** YouTube takes Shorts of up to 3 minutes; anything longer uploads as a regular video. */
export const YOUTUBE_SHORTS_MAX_MS = 180_000;
export const SHORTS_TOO_LONG_WARNING =
  "YouTube doesn't accept Shorts over 3 minutes; this will upload as a regular video.";
/** The warning to show for a Shorts length (the chosen setting or the pick's total), or null within YouTube's limit. */
export const shortsLengthWarning = (ms: number) => (ms > YOUTUBE_SHORTS_MAX_MS ? SHORTS_TOO_LONG_WARNING : null);

/** A shot that could go into a Shorts cut, in story order. */
export type ShortsCandidate = { id: string; shotType: string; text: string; holdMs: number; hasArt: boolean };

export const shortsScore = (c: Pick<ShortsCandidate, "shotType" | "text">) =>
  (SHOT_DRAMA[c.shotType] ?? 0.5) + lineDrama(c.text);

/**
 * The shots of a Shorts cut, in story order. The story is split into as many stretches as shots fit in `targetMs`
 * and the most dramatic shot of each is taken, so the trailer spans the whole story rather than its opening; then
 * the weakest are dropped until it fits `maxMs`, and the strongest left over are added until it reaches `minMs`.
 * Shots without artwork are never picked. A story shorter than `minMs` gives every usable shot.
 */
export function pickShorts(cands: ShortsCandidate[], o: { targetMs: number; minMs: number; maxMs: number }) {
  const usable = cands
    .map((c, i) => ({ c, i, score: shortsScore(c) }))
    .filter((x) => x.c.hasArt && x.c.holdMs <= o.maxMs);
  if (!usable.length) return [];
  const avg = usable.reduce((n, x) => n + x.c.holdMs, 0) / usable.length;
  const stretches = Math.max(1, Math.min(usable.length, Math.round(o.targetMs / avg)));
  const picked = new Set<(typeof usable)[number]>();
  for (let b = 0; b < stretches; b++) {
    const part = usable.slice(
      Math.floor((b * usable.length) / stretches),
      Math.floor(((b + 1) * usable.length) / stretches),
    );
    const best = part.reduce((a, x) => (x.score > a.score ? x : a), part[0]!);
    picked.add(best);
  }
  const total = () => [...picked].reduce((n, x) => n + x.c.holdMs, 0);
  const byScore = [...usable].sort((a, b) => b.score - a.score || a.i - b.i);
  while (total() > o.maxMs && picked.size > 1) picked.delete(byScore.filter((x) => picked.has(x)).at(-1)!);
  for (const x of byScore) {
    if (total() >= o.minMs) break;
    if (!picked.has(x) && total() + x.c.holdMs <= o.maxMs) picked.add(x);
  }
  return [...picked].sort((a, b) => a.i - b.i).map((x) => x.c.id);
}

/**
 * Narration languages whose script the render image has no font for (it ships DejaVu Sans): captions in them would be
 * empty boxes, so they are refused. Installing a font that covers them (e.g. Noto CJK) is what would lift this.
 */
export const CAPTION_FONTLESS_LANGUAGES = ["ja", "ko", "zh", "hi", "th"];
export const captionsSupported = (language: string) =>
  !CAPTION_FONTLESS_LANGUAGES.includes(language.toLowerCase().split(/[-_]/)[0]!);
