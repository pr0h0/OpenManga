/** Pure video-cut maths shared by the final ffmpeg render and the in-browser preview. */

/**
 * Silence added after a shot's narration so a cut doesn't clip the last word. Segments are silence-trimmed when
 * stored, so this is the only pause at a cut besides the segment's own pauseAfterMs; 400 ms on top of untrimmed
 * voice padding made every shot change an audible ~1.2 s hole.
 */
export const VIDEO_BREATH_MS = 150;

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

export const frameSizeFor = (height: number) => ({ frameW: Math.round((height * 16) / 9 / 2) * 2, frameH: height });

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

/** Zoom factor at `t` (0..1) of the hold. */
export const kenBurnsZoomAt = (shotType: string, zoom: number, t: number) =>
  kenBurnsPullsOut(shotType) ? 1 + zoom - zoom * t : 1 + zoom * t;

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
