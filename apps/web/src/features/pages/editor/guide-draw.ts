/** Pure parts of the layout-guide drawing: canvas size, the stick-figure rig and undo history. */

export type Pt = [number, number];
export type Mark = { tool: "pen" | "eraser" | "line"; width: number; points: Pt[] };
export const JOINTS = [
  "head",
  "lShoulder",
  "rShoulder",
  "lElbow",
  "rElbow",
  "lHand",
  "rHand",
  "lHip",
  "rHip",
  "lKnee",
  "rKnee",
  "lFoot",
  "rFoot",
] as const;
export type Joint = (typeof JOINTS)[number];
export type Figure = Record<Joint, Pt>;
/** `base` is the guide the drawing started from; Clear drops it with everything else. */
export type Drawing = { marks: Mark[]; figures: Figure[]; base: boolean };

/** The guide is drawn at the panel's own shape, long side 1024 px: plenty for a layout sketch, small to upload. */
export function canvasSize(aspect: number, long = 1024) {
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return a >= 1
    ? { width: long, height: Math.max(1, Math.round(long / a)) }
    : { width: Math.max(1, Math.round(long * a)), height: long };
}

/** Where an image of w×h sits when fitted inside the canvas without cropping. */
export function containRect(w: number, h: number, cw: number, ch: number) {
  const s = Math.min(cw / w, ch / h);
  return { x: (cw - w * s) / 2, y: (ch - h * s) / 2, width: w * s, height: h * s };
}

const mid = (a: Pt, b: Pt): Pt => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const neck = (f: Figure) => mid(f.lShoulder, f.rShoulder);
export const pelvis = (f: Figure) => mid(f.lHip, f.rHip);
/** Middle of the torso: dragging it moves the whole figure. */
export const torso = (f: Figure) => mid(neck(f), pelvis(f));

/** Lines of a figure, head excluded (drawn as a circle). */
export const bones = (f: Figure): [Pt, Pt][] => [
  [f.head, neck(f)],
  [f.lShoulder, f.rShoulder],
  [neck(f), pelvis(f)],
  [f.lHip, f.rHip],
  [f.lShoulder, f.lElbow],
  [f.lElbow, f.lHand],
  [f.rShoulder, f.rElbow],
  [f.rElbow, f.rHand],
  [f.lHip, f.lKnee],
  [f.lKnee, f.lFoot],
  [f.rHip, f.rKnee],
  [f.rKnee, f.rFoot],
];

/** Head radius: a figure is eight heads tall, so it scales with how tall the figure has been dragged. */
export const headRadius = (f: Figure) => Math.max(8, Math.hypot(f.head[0] - neck(f)[0], f.head[1] - neck(f)[1]) * 0.6);

/** A standing figure about 70% of the canvas tall, centred on `cx`. */
export function standingFigure(cx: number, height: number): Figure {
  const u = (height * 0.7) / 8;
  const y = height * 0.15;
  const p = (dx: number, dy: number): Pt => [cx + dx * u, y + dy * u];
  return {
    head: p(0, 0.5),
    lShoulder: p(-0.9, 1.5),
    rShoulder: p(0.9, 1.5),
    lElbow: p(-1.2, 3),
    rElbow: p(1.2, 3),
    lHand: p(-1.3, 4.3),
    rHand: p(1.3, 4.3),
    lHip: p(-0.5, 4.2),
    rHip: p(0.5, 4.2),
    lKnee: p(-0.6, 6),
    rKnee: p(0.6, 6),
    lFoot: p(-0.7, 7.8),
    rFoot: p(0.7, 7.8),
  };
}

/** The handle under a point (a joint, or the torso to move the whole figure), nearest first within `radius`. */
export function hitHandle(figures: Figure[], at: Pt, radius: number) {
  let best: { figure: number; joint: Joint | "torso"; d: number } | null = null;
  for (const [i, f] of figures.entries())
    for (const joint of [...JOINTS, "torso" as const]) {
      const p = joint === "torso" ? torso(f) : f[joint];
      const d = Math.hypot(p[0] - at[0], p[1] - at[1]);
      if (d <= radius && (!best || d < best.d)) best = { figure: i, joint, d };
    }
  return best && { figure: best.figure, joint: best.joint };
}

/** A figure with one joint moved to `to`, or the whole figure shifted when the handle is the torso. */
export function moveHandle(f: Figure, joint: Joint | "torso", to: Pt): Figure {
  if (joint !== "torso") return { ...f, [joint]: to };
  const c = torso(f);
  const dx = to[0] - c[0];
  const dy = to[1] - c[1];
  return Object.fromEntries(JOINTS.map((j) => [j, [f[j][0] + dx, f[j][1] + dy]])) as Figure;
}

export type History = { stack: Drawing[]; at: number };
export const history = (start: Drawing): History => ({ stack: [start], at: 0 });
/** A new state drops anything that was undone, like every editor's redo. */
export const commit = (h: History, d: Drawing): History => ({
  stack: [...h.stack.slice(0, h.at + 1), d],
  at: h.at + 1,
});
export const undo = (h: History): History => ({ ...h, at: Math.max(0, h.at - 1) });
export const redo = (h: History): History => ({ ...h, at: Math.min(h.stack.length - 1, h.at + 1) });
export const isEmpty = (d: Drawing) => !d.base && !d.figures.length && !d.marks.some((m) => m.tool !== "eraser");
