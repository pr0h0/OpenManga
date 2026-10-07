import type { Bubble } from "@openmanga/schemas";

export type BubbleGeometry = {
  /** page-pixel box */
  x: number;
  y: number;
  width: number;
  height: number;
  /** SVG path in local coordinates (0,0 = box top-left) */
  path: string;
  dash: number[] | null;
  innerBorder: string | null;
};

const f = (n: number) => Math.round(n * 10) / 10;

function polygon(points: [number, number][]) {
  return `${points.map(([x, y], i) => `${i ? "L" : "M"}${f(x)},${f(y)}`).join(" ")} Z`;
}

/** Deterministic vector bubble outline shared by the Konva editor and the SVG compositor. */
export function bubbleGeometry(b: Bubble, pageW: number, pageH: number): BubbleGeometry {
  const x = b.x * pageW;
  const y = b.y * pageH;
  const w = b.width * pageW;
  const h = b.height * pageH;
  const cx = w / 2;
  const cy = h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const target = b.tail && b.tailTarget ? { x: b.tailTarget.x * pageW - x, y: b.tailTarget.y * pageH - y } : null;
  const targetOutside = target && (target.x < 0 || target.x > w || target.y < 0 || target.y > h);

  if (b.type === "narration" || b.type === "system") {
    const r = b.type === "narration" ? Math.min(8, h / 6) : 0;
    const path = r
      ? `M${f(r)},0 H${f(w - r)} Q${f(w)},0 ${f(w)},${f(r)} V${f(h - r)} Q${f(w)},${f(h)} ${f(w - r)},${f(h)} H${f(r)} Q0,${f(h)} 0,${f(h - r)} V${f(r)} Q0,0 ${f(r)},0 Z`
      : `M0,0 H${f(w)} V${f(h)} H0 Z`;
    const inset = 5;
    return {
      x,
      y,
      width: w,
      height: h,
      path,
      dash: null,
      innerBorder: b.type === "system" ? `M${inset},${inset} H${f(w - inset)} V${f(h - inset)} H${inset} Z` : null,
    };
  }

  const n = 64;
  const angleTo = targetOutside ? Math.atan2((target!.y - cy) / ry, (target!.x - cx) / rx) : null;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    let r = 1;
    if (b.type === "shout") r = i % 2 === 0 ? 1 : 0.8;
    pts.push([cx + Math.cos(a) * rx * r, cy + Math.sin(a) * ry * r]);
  }

  if (b.type === "thought") {
    const bumps = 12;
    let path = "";
    for (let i = 0; i < bumps; i++) {
      const a1 = (i / bumps) * Math.PI * 2;
      const a2 = ((i + 1) / bumps) * Math.PI * 2;
      const p1 = [cx + Math.cos(a1) * rx * 0.9, cy + Math.sin(a1) * ry * 0.9];
      const p2 = [cx + Math.cos(a2) * rx * 0.9, cy + Math.sin(a2) * ry * 0.9];
      const br = Math.hypot(p2[0]! - p1[0]!, p2[1]! - p1[1]!) * 0.62;
      path += `${i ? "" : `M${f(p1[0]!)},${f(p1[1]!)} `}A${f(br)},${f(br)} 0 0,1 ${f(p2[0]!)},${f(p2[1]!)} `;
    }
    path += "Z";
    if (targetOutside) {
      for (const [k, size] of [
        [0.55, 0.09],
        [0.78, 0.055],
      ] as const) {
        const edgeX = cx + Math.cos(angleTo!) * rx;
        const edgeY = cy + Math.sin(angleTo!) * ry;
        const px = edgeX + (target!.x - edgeX) * k;
        const py = edgeY + (target!.y - edgeY) * k;
        const r = Math.min(w, h) * size;
        path += ` M${f(px - r)},${f(py)} A${f(r)},${f(r)} 0 1,0 ${f(px + r)},${f(py)} A${f(r)},${f(r)} 0 1,0 ${f(px - r)},${f(py)} Z`;
      }
    }
    return { x, y, width: w, height: h, path, dash: null, innerBorder: null };
  }

  if (targetOutside && angleTo !== null) {
    const idx = Math.round(((angleTo + Math.PI * 2) % (Math.PI * 2)) / ((Math.PI * 2) / n)) % n;
    const spread = Math.max(2, Math.round(n * 0.035));
    const out: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const d = Math.min(Math.abs(i - idx), n - Math.abs(i - idx));
      if (d < spread) {
        if (d === 0) out.push([target!.x, target!.y]);
        continue;
      }
      out.push(pts[i]!);
    }
    return {
      x,
      y,
      width: w,
      height: h,
      path: polygon(out),
      dash: b.type === "whisper" ? [10, 8] : null,
      innerBorder: null,
    };
  }
  return {
    x,
    y,
    width: w,
    height: h,
    path: polygon(pts),
    dash: b.type === "whisper" ? [10, 8] : null,
    innerBorder: null,
  };
}

export type TailDirection = "up" | "down" | "left" | "right" | "up-left" | "up-right" | "down-left" | "down-right";
const TAIL_VECTORS: Record<TailDirection, [number, number]> = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
  "up-left": [-0.7, -0.7],
  "up-right": [0.7, -0.7],
  "down-left": [-0.7, 0.7],
  "down-right": [0.7, 0.7],
};
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Tail tip a short way outside the bubble edge in a direction (normalized page coords). */
export function tailTargetToward(b: Pick<Bubble, "x" | "y" | "width" | "height">, dir: TailDirection, reach = 0.6) {
  const [dx, dy] = TAIL_VECTORS[dir];
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const len = Math.max(b.width, b.height) * reach;
  return {
    x: clamp01(cx + dx * (b.width / 2 + len * Math.abs(dx || 0.3))),
    y: clamp01(cy + dy * (b.height / 2 + len * Math.abs(dy || 0.3))),
  };
}

/**
 * Default tail: points down out of the bubble, leaning toward the speaker's side of the panel when known
 * (a position hint like "left third"), otherwise toward the panel's horizontal center. Stays inside the panel.
 */
export function defaultTailTarget(
  b: Pick<Bubble, "x" | "y" | "width" | "height">,
  frame: { x: number; y: number; width: number; height: number },
  positionHint?: string | null,
) {
  const hint = positionHint?.toLowerCase() ?? "";
  const speakerX = /\bleft\b/.test(hint)
    ? frame.x + frame.width * 0.25
    : /\bright\b/.test(hint)
      ? frame.x + frame.width * 0.75
      : /\b(center|centre|middle)\b/.test(hint)
        ? frame.x + frame.width / 2
        : null;
  const cx = b.x + b.width / 2;
  const towardX = speakerX ?? frame.x + frame.width / 2;
  const x = cx + (towardX - cx) * (speakerX === null ? 0.25 : 0.6);
  const below = b.y + b.height + Math.max(0.03, b.height * 0.7);
  const y = Math.min(below, frame.y + frame.height - 0.01);
  return { x: clamp01(Math.min(frame.x + frame.width, Math.max(frame.x, x))), y: clamp01(y) };
}

type Box = { x: number; y: number; width: number; height: number };
/** A face the consistency check found, in fractions of the artwork image; `name` is a cast name or "unknown". */
export type FaceBox = Box & { name: string };

/**
 * Faces in page coordinates: through the same crop the compositor applies to the artwork (source pixels) and
 * into the panel's frame, padded a little so text keeps clear of hair and chins. Faces cropped out are dropped.
 */
export function facesOnPage(
  faces: FaceBox[],
  frame: Box,
  src: { width: number; height: number },
  crop: { left: number; top: number; width: number; height: number },
  pad = 0.15,
): FaceBox[] {
  const out: FaceBox[] = [];
  for (const f of faces) {
    const u0 = (f.x * src.width - crop.left) / crop.width;
    const v0 = (f.y * src.height - crop.top) / crop.height;
    const u1 = ((f.x + f.width) * src.width - crop.left) / crop.width;
    const v1 = ((f.y + f.height) * src.height - crop.top) / crop.height;
    const du = (u1 - u0) * pad;
    const dv = (v1 - v0) * pad;
    const [a, b, c, d] = [Math.max(0, u0 - du), Math.max(0, v0 - dv), Math.min(1, u1 + du), Math.min(1, v1 + dv)];
    if (c <= a || d <= b) continue;
    out.push({
      name: f.name,
      x: frame.x + a * frame.width,
      y: frame.y + b * frame.height,
      width: (c - a) * frame.width,
      height: (d - b) * frame.height,
    });
  }
  return out;
}

/** Where a bubble's tail should end for a speaker whose face is known: the face's edge nearest the bubble. */
export function tailTowardFace(b: Box, face: Box) {
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  const x = Math.min(face.x + face.width, Math.max(face.x, cx));
  const y = Math.min(face.y + face.height, Math.max(face.y, cy));
  return { x: clamp01(x), y: clamp01(y) };
}

/** The faces (in page coordinates) that a bubble or caption hides by more than `share` of the face's area. */
export function coveredFaces(faces: FaceBox[], boxes: Box[], share = 0.3): FaceBox[] {
  const overlap = (a: Box, b: Box) =>
    Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
    Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return faces.filter((f) => boxes.some((b) => overlap(f, b) > share * f.width * f.height));
}
