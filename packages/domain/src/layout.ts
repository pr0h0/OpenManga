import type { Frame } from "@openmanga/schemas";

export type LayoutTemplate = {
  key: string;
  name: string;
  description: string;
  /** Frames in reading order for LTR. Normalized 0..1 inside the page's content box. */
  frames: Frame[];
  vertical?: boolean;
};

const f = (x: number, y: number, width: number, height: number): Frame => ({ x, y, width, height });

/** Raw cells on a unit square. Gutters/margins are applied by applyGutters(). */
export const LAYOUT_TEMPLATES: LayoutTemplate[] = [
  { key: "full-page", name: "1 full-page panel", description: "Single splash panel", frames: [f(0, 0, 1, 1)] },
  {
    key: "two-horizontal",
    name: "2 horizontal panels",
    description: "Two stacked wide panels",
    frames: [f(0, 0, 1, 0.5), f(0, 0.5, 1, 0.5)],
  },
  {
    key: "two-vertical",
    name: "2 vertical panels",
    description: "Two side-by-side tall panels",
    frames: [f(0, 0, 0.5, 1), f(0.5, 0, 0.5, 1)],
  },
  {
    key: "large-two-small",
    name: "1 large + 2 small",
    description: "Establishing panel on top, two beats below",
    frames: [f(0, 0, 1, 0.6), f(0, 0.6, 0.5, 0.4), f(0.5, 0.6, 0.5, 0.4)],
  },
  {
    key: "two-small-large",
    name: "2 small + 1 large",
    description: "Two beats building to a large payoff",
    frames: [f(0, 0, 0.5, 0.4), f(0.5, 0, 0.5, 0.4), f(0, 0.4, 1, 0.6)],
  },
  {
    key: "three-horizontal",
    name: "3 equal horizontal",
    description: "Three stacked equal strips",
    frames: [f(0, 0, 1, 1 / 3), f(0, 1 / 3, 1, 1 / 3), f(0, 2 / 3, 1, 1 / 3)],
  },
  {
    key: "three-cinematic",
    name: "3 cinematic",
    description: "Letterbox strip, tall middle, letterbox strip",
    frames: [f(0, 0, 1, 0.22), f(0, 0.22, 1, 0.56), f(0, 0.78, 1, 0.22)],
  },
  {
    key: "four-grid",
    name: "4 grid",
    description: "Classic 2x2 grid",
    frames: [f(0, 0, 0.5, 0.5), f(0.5, 0, 0.5, 0.5), f(0, 0.5, 0.5, 0.5), f(0.5, 0.5, 0.5, 0.5)],
  },
  {
    key: "four-asymmetric",
    name: "4 asymmetric",
    description: "Wide top, narrow+wide middle, wide bottom",
    frames: [f(0, 0, 1, 0.3), f(0, 0.3, 0.38, 0.4), f(0.38, 0.3, 0.62, 0.4), f(0, 0.7, 1, 0.3)],
  },
  {
    key: "five-action",
    name: "5-panel action",
    description: "Three quick beats on top, a dominant impact panel, a wide closing strip",
    frames: [
      f(0, 0, 0.34, 0.28),
      f(0.34, 0, 0.33, 0.28),
      f(0.67, 0, 0.33, 0.28),
      f(0, 0.28, 1, 0.46),
      f(0, 0.74, 1, 0.26),
    ],
  },
  {
    key: "five-feature-middle",
    name: "5 with wide middle",
    description: "Two panels, a wide feature panel, two panels",
    frames: [f(0, 0, 0.5, 0.3), f(0.5, 0, 0.5, 0.3), f(0, 0.3, 1, 0.4), f(0, 0.7, 0.5, 0.3), f(0.5, 0.7, 0.5, 0.3)],
  },
  {
    key: "five-establishing",
    name: "5 with establishing top",
    description: "Wide establishing panel over a 2×2 grid",
    frames: [
      f(0, 0, 1, 0.36),
      f(0, 0.36, 0.5, 0.32),
      f(0.5, 0.36, 0.5, 0.32),
      f(0, 0.68, 0.5, 0.32),
      f(0.5, 0.68, 0.5, 0.32),
    ],
  },
  {
    key: "webtoon-vertical",
    name: "Vertical webtoon sequence",
    description: "Full-width panels with breathing room, for vertical scrolling",
    vertical: true,
    frames: [f(0, 0, 1, 0.3), f(0, 0.35, 1, 0.28), f(0, 0.68, 1, 0.32)],
  },
];

/** Pages hold at most this many panels; longer beats continue on the next page. */
export const MAX_PANELS_PER_PAGE = 5;

export const layoutByKey = (key: string | null | undefined) => LAYOUT_TEMPLATES.find((t) => t.key === key);

export function defaultTemplateForCount(n: number): LayoutTemplate {
  const byCount: Record<number, string> = {
    1: "full-page",
    2: "two-horizontal",
    3: "large-two-small",
    4: "four-grid",
    5: "five-action",
  };
  return layoutByKey(byCount[Math.min(Math.max(n, 1), MAX_PANELS_PER_PAGE)])!;
}

const round = (n: number) => Math.round(n * 10000) / 10000;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Shrink cells to leave page margin and inter-panel gutters. Pure + deterministic. */
export function applyGutters(frames: Frame[], margin: number, gutter: number): Frame[] {
  const inner = 1 - margin * 2;
  return frames.map((fr) => {
    const x = margin + fr.x * inner + (fr.x > 0.0001 ? gutter / 2 : 0);
    const y = margin + fr.y * inner + (fr.y > 0.0001 ? gutter / 2 : 0);
    const right = margin + (fr.x + fr.width) * inner - (fr.x + fr.width < 0.9999 ? gutter / 2 : 0);
    const bottom = margin + (fr.y + fr.height) * inner - (fr.y + fr.height < 0.9999 ? gutter / 2 : 0);
    return {
      x: round(x),
      y: round(y),
      width: round(Math.max(0.01, right - x)),
      height: round(Math.max(0.01, bottom - y)),
    };
  });
}

/** Mirror a frame horizontally for RTL manga reading order. */
export const mirrorFrame = (fr: Frame): Frame => ({ ...fr, x: round(1 - fr.x - fr.width) });

export function templateFrames(
  key: string,
  opts: { margin: number; gutter: number; readingDirection: "ltr" | "rtl" | "vertical" },
) {
  const t = layoutByKey(key);
  if (!t) throw new Error(`Unknown layout template: ${key}`);
  const frames = applyGutters(t.frames, opts.margin, opts.gutter);
  return opts.readingDirection === "rtl" ? frames.map(mirrorFrame) : frames;
}

export function clampFrame(fr: Frame): Frame {
  const width = Math.min(1, Math.max(0.02, fr.width));
  const height = Math.min(1, Math.max(0.02, fr.height));
  return {
    x: round(clamp01(Math.min(fr.x, 1 - width))),
    y: round(clamp01(Math.min(fr.y, 1 - height))),
    width: round(width),
    height: round(height),
    // A shaped panel keeps its outline: its points are relative to the box, so they follow it.
    ...(fr.points ? { points: fr.points } : {}),
  };
}

/** Splitting a panel gives two rectangles: a polygon outline has no sensible halves. */
export function splitFrame(frame: Frame, direction: "horizontal" | "vertical", gutter = 0.01): [Frame, Frame] {
  const { points: _p, ...fr } = frame;
  if (direction === "horizontal") {
    const h = (fr.height - gutter) / 2;
    return [clampFrame({ ...fr, height: h }), clampFrame({ ...fr, y: fr.y + h + gutter, height: h })];
  }
  const w = (fr.width - gutter) / 2;
  return [clampFrame({ ...fr, width: w }), clampFrame({ ...fr, x: fr.x + w + gutter, width: w })];
}

/** Natural reading order: rows top->bottom, within a row LTR or RTL. */
export function readingOrder<T extends { frame: Frame }>(items: T[], dir: "ltr" | "rtl" | "vertical"): T[] {
  const rowKey = (fr: Frame) => Math.round((fr.y + fr.height / 2) * 20);
  return [...items].sort((a, b) => {
    // Vertical: top to bottom; panels side by side on the same row read left to right (deterministic ties).
    if (dir === "vertical") return a.frame.y - b.frame.y || a.frame.x - b.frame.x;
    // Row first, then across. Ordering on the row key alone keeps this transitive: mixing in raw y made the
    // comparator inconsistent, so the same geometry could sort three different ways depending on input order.
    const ra = rowKey(a.frame);
    const rb = rowKey(b.frame);
    if (ra !== rb) return ra - rb;
    return dir === "rtl" ? b.frame.x - a.frame.x : a.frame.x - b.frame.x;
  });
}

/** Remap existing panels onto a new template. Extra panels are stacked in a new row; missing frames stay unused. */
export function swapTemplate<T extends { frame: Frame }>(
  panels: T[],
  key: string,
  opts: { margin: number; gutter: number; readingDirection: "ltr" | "rtl" | "vertical" },
): Frame[] {
  const frames = templateFrames(key, opts);
  return panels.map(
    (_, i) =>
      frames[i] ?? clampFrame({ x: opts.margin, y: 1 - opts.margin - 0.1, width: 1 - opts.margin * 2, height: 0.1 }),
  );
}

export const aspectRatioOf = (fr: Frame, pageW: number, pageH: number) => (fr.width * pageW) / (fr.height * pageH);
