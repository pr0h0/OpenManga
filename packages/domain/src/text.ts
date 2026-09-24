import type { Bubble, Frame } from "@openmanga/schemas";

/** Approximate glyph advance as a fraction of font size. Shared by editor + compositor so wraps match. */
const WIDE = /[MWmw@%#]/;
const NARROW = /[il.,;:!'|1 ]/;
export function measureText(text: string, fontSize: number) {
  let w = 0;
  for (const ch of text) w += WIDE.test(ch) ? 0.82 : NARROW.test(ch) ? 0.32 : /[A-Z]/.test(ch) ? 0.64 : 0.54;
  return w * fontSize;
}

export function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const lines: string[] = [];
  for (const para of text.split(/\r?\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (measureText(candidate, fontSize) <= maxWidth || !line) {
        if (!line && measureText(word, fontSize) > maxWidth) {
          // hard-break very long words
          let chunk = "";
          for (const ch of word) {
            if (measureText(chunk + ch, fontSize) > maxWidth && chunk) {
              lines.push(chunk);
              chunk = "";
            }
            chunk += ch;
          }
          line = chunk;
        } else line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Page-pixel layout of bubble text. */
export function layoutBubbleText(text: string, b: Bubble, pageW: number, pageH: number) {
  const w = b.width * pageW;
  const h = b.height * pageH;
  const inset = b.type === "normal" || b.type === "thought" || b.type === "whisper" || b.type === "shout" ? 0.15 : 0;
  const maxWidth = Math.max(10, w * (1 - inset) - b.padding * 2);
  const lines = wrapText(text, maxWidth, b.fontSize);
  const lineH = b.fontSize * b.lineHeight;
  const blockH = lines.length * lineH;
  const top = (h - blockH) / 2 + b.fontSize * 0.85;
  return { lines, lineH, top, maxWidth, w, h };
}

type Rect = { x: number; y: number; width: number; height: number };
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

export type Quadrant = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top" | "bottom";

/**
 * Deterministic bubble placement inside a panel. Tries candidate positions (preferred quadrant first),
 * scoring overlap with avoid-rects (faces/objects/existing bubbles) and keeping inside the panel.
 */
export function placeBubble(opts: {
  panel: Frame;
  text: string;
  fontSize: number;
  pageW: number;
  pageH: number;
  preferred?: Quadrant;
  avoid: Rect[];
  readingDirection?: "ltr" | "rtl" | "vertical";
  /** Pre-computed box size (e.g. from fitBubbleBox); otherwise a rough estimate from text length. */
  size?: { width: number; height: number };
}): Rect {
  const { panel, pageW, pageH } = opts;
  const charsPerLine = 16;
  const lines = Math.max(1, Math.ceil(opts.text.length / charsPerLine));
  const width = opts.size
    ? Math.min(1, opts.size.width)
    : Math.min(
        panel.width * 0.9,
        Math.max(0.12, (Math.min(opts.text.length, charsPerLine) * opts.fontSize * 0.6 + 60) / pageW),
      );
  const height = opts.size
    ? Math.min(1, opts.size.height)
    : Math.min(panel.height * 0.8, (lines * opts.fontSize * 1.25 + 50) / pageH);
  const pad = 0.012;
  const xs = {
    left: panel.x + pad,
    center: panel.x + (panel.width - width) / 2,
    right: panel.x + panel.width - width - pad,
  };
  const ys = {
    top: panel.y + pad,
    middle: panel.y + (panel.height - height) / 2,
    bottom: panel.y + panel.height - height - pad,
  };
  const firstSide = opts.readingDirection === "rtl" ? "right" : "left";
  const secondSide = firstSide === "left" ? "right" : "left";
  const order: [keyof typeof xs, keyof typeof ys][] = [
    [firstSide, "top"],
    [secondSide, "top"],
    ["center", "top"],
    [firstSide, "bottom"],
    [secondSide, "bottom"],
    ["center", "bottom"],
    [firstSide, "middle"],
    [secondSide, "middle"],
  ];
  const pref: Record<Quadrant, [keyof typeof xs, keyof typeof ys]> = {
    "top-left": ["left", "top"],
    "top-right": ["right", "top"],
    "bottom-left": ["left", "bottom"],
    "bottom-right": ["right", "bottom"],
    top: ["center", "top"],
    bottom: ["center", "bottom"],
  };
  if (opts.preferred) order.unshift(pref[opts.preferred]);
  let r: Rect = { x: xs.left, y: ys.top, width, height };
  let bestScore = Number.POSITIVE_INFINITY;
  for (const [i, [hx, vy]] of order.entries()) {
    const cand = { x: xs[hx], y: ys[vy], width, height };
    const collision = opts.avoid.reduce((s, a) => s + overlap(cand, a), 0) / (width * height);
    const score = collision * 100 + i * 0.01;
    if (score < bestScore) {
      bestScore = score;
      r = cand;
    }
  }
  return {
    x: Math.max(0, Math.min(1 - r.width, r.x)),
    y: Math.max(0, Math.min(1 - r.height, r.y)),
    width: r.width,
    height: r.height,
  };
}

/** Default avoid zones from shot type: faces tend to sit centrally in close shots. */
/** The quadrant a free-text area names ("upper-left", "top right corner", "the sky at the top"), if it names one. */
export function quadrantFromArea(area: string | null | undefined): Quadrant | undefined {
  const a = (area ?? "").toLowerCase();
  const top = /\b(top|upper|above|sky|ceiling)\b/.test(a);
  const bottom = /\b(bottom|lower|below|ground|floor)\b/.test(a);
  if (top === bottom) return undefined;
  const side = /\bleft\b/.test(a) ? "-left" : /\bright\b/.test(a) ? "-right" : "";
  return `${top ? "top" : "bottom"}${side}` as Quadrant;
}

export function faceAvoidZone(panel: Frame, shotType: string): Rect[] {
  const close = ["close", "extreme-close", "medium-close"].includes(shotType);
  const w = panel.width * (close ? 0.55 : 0.35);
  const h = panel.height * (close ? 0.55 : 0.3);
  return [
    { x: panel.x + (panel.width - w) / 2, y: panel.y + panel.height * (close ? 0.2 : 0.25), width: w, height: h },
  ];
}
