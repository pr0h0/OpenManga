import type { Frame, FramePoint } from "@openmanga/schemas";

type Pt = { x: number; y: number };
const r4 = (n: number) => Math.round(n * 10_000) / 10_000;

/** The outline of a panel in page fractions: its points mapped through the box, or the box's four corners. */
export function framePolygon(f: Frame): Pt[] {
  const pts = f.points ?? [
    { x: 0, y: 0 },
    { x: 1, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ];
  return pts.map((p) => ({ x: f.x + p.x * f.width, y: f.y + p.y * f.height }));
}

/** True when the points are exactly the box's corners (in any rotation of the order): a plain rectangle. */
function isBoxCorners(pts: FramePoint[]) {
  if (pts.length !== 4) return false;
  const key = (p: FramePoint) => `${Math.round(p.x * 1000)},${Math.round(p.y * 1000)}`;
  const set = new Set(pts.map(key));
  return ["0,0", "1000,0", "1000,1000", "0,1000"].every((k) => set.has(k));
}

/**
 * A frame from an outline in page fractions: the box becomes the outline's bounds (clamped to the page) and the
 * points are stored relative to it. An outline that is just its box's four corners is stored as a plain box.
 */
export function frameFromPolygon(abs: Pt[]): Frame {
  const pts = abs.map((p) => ({ x: Math.min(1, Math.max(0, p.x)), y: Math.min(1, Math.max(0, p.y)) }));
  const x0 = Math.min(...pts.map((p) => p.x));
  const y0 = Math.min(...pts.map((p) => p.y));
  const x1 = Math.max(...pts.map((p) => p.x));
  const y1 = Math.max(...pts.map((p) => p.y));
  const width = Math.max(0.02, x1 - x0);
  const height = Math.max(0.02, y1 - y0);
  const rel = pts.map((p) => ({ x: r4((p.x - x0) / width), y: r4((p.y - y0) / height) }));
  const box = { x: r4(x0), y: r4(y0), width: r4(width), height: r4(height) };
  return isBoxCorners(rel) ? box : { ...box, points: rel };
}

/** The outline as an SVG path in page pixels at a `W`×`H` render. */
export function framePath(f: Frame, W: number, H: number) {
  return `${framePolygon(f)
    .map((p, i) => `${i ? "L" : "M"}${(p.x * W).toFixed(1)} ${(p.y * H).toFixed(1)}`)
    .join(" ")} Z`;
}

/** Inserts a point halfway along edge `i` (from point i to the next). */
export function insertFramePoint(f: Frame, i: number): Frame {
  const poly = framePolygon(f);
  if (poly.length >= 24) return f;
  const a = poly[i]!;
  const b = poly[(i + 1) % poly.length]!;
  poly.splice(i + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  return frameFromPolygon(poly);
}

/** Removes point `i`; an outline keeps at least three points. */
export function removeFramePoint(f: Frame, i: number): Frame {
  const poly = framePolygon(f);
  if (poly.length <= 3) return f;
  poly.splice(i, 1);
  return frameFromPolygon(poly);
}

/** Moves point `i` to `to` (page fractions). */
export function moveFramePoint(f: Frame, i: number, to: Pt): Frame {
  const poly = framePolygon(f);
  poly[i] = to;
  return frameFromPolygon(poly);
}

/** Whether a page-fraction point lies inside the outline (even-odd rule). */
export function inFrame(f: Frame, p: Pt) {
  const poly = framePolygon(f);
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
