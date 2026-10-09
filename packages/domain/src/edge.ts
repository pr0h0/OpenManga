import type { EdgeStyle } from "@openmanga/schemas";

type Pt = { x: number; y: number };

/** How deep each style eats into its shape at size 1, as a fraction of the page's shorter side. */
const DEPTH: Record<EdgeStyle["style"], number> = {
  straight: 0,
  wavy: 0.014,
  torn: 0.012,
  rough: 0.005,
  brush: 0.003,
  burnt: 0.016,
};

/** A small deterministic generator: the same seed always draws the same edge. */
function rng(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The depth in pixels an edge reaches on a page whose shorter side is `unit` pixels. */
export const edgeDepth = (e: EdgeStyle | undefined, unit: number) => (e ? DEPTH[e.style] * e.size * unit : 0);

/**
 * A shape's outline with a decorative edge: every side of `poly` (pixels, in drawing order) redrawn as a wave, a tear,
 * a rough cut or a brush line that only ever cuts inwards and comes back to the original corners, so neighbouring
 * panels keep their gutters and nothing spills outside the box. `unit` is the page's shorter side in pixels; `seed`
 * (a panel or page id) fixes the randomness. A straight edge (or size 0) returns the shape as it is.
 */
export function edgeOutline(poly: Pt[], e: EdgeStyle | undefined, unit: number, seed: string): Pt[] {
  const D = edgeDepth(e, unit);
  if (!e || D < 0.5 || poly.length < 3) return poly;
  const rand = rng(`${seed}:${e.style}`);
  const c = { x: poly.reduce((s, p) => s + p.x, 0) / poly.length, y: poly.reduce((s, p) => s + p.y, 0) / poly.length };
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % poly.length]!;
    const L = Math.hypot(b.x - a.x, b.y - a.y);
    if (L < 1e-6) continue;
    const d = { x: (b.x - a.x) / L, y: (b.y - a.y) / L };
    // The normal that points into the shape (towards its centroid).
    let n = { x: -d.y, y: d.x };
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    if (n.x * (c.x - mid.x) + n.y * (c.y - mid.y) < 0) n = { x: -n.x, y: -n.y };
    // Depth fades to nothing within two depths of each corner.
    const taper = (s: number) => Math.min(1, s / (2 * D), (L - s) / (2 * D));
    const at = (s: number, off: number) => {
      const k = Math.max(0, taper(s)) * off;
      return { x: a.x + d.x * s + n.x * k, y: a.y + d.y * s + n.y * k };
    };
    out.push(a);
    if (e.style === "wavy") {
      // A whole number of waves per side, so each side starts and ends at its corner.
      const waves = Math.max(1, Math.round(L / Math.max(D * 6, unit * 0.03)));
      const steps = waves * 12;
      for (let k = 1; k < steps; k++) {
        const s = (k / steps) * L;
        out.push(at(s, (D * (1 - Math.cos((2 * Math.PI * waves * s) / L))) / 2));
      }
    } else {
      // A random walk between 0 and the depth: fine-grained for torn and burnt, gentle for rough and brush.
      const step = Math.max(1.5, D * (e.style === "torn" || e.style === "burnt" ? 0.45 : 0.9));
      const jump = e.style === "torn" ? 0.95 : e.style === "burnt" ? 0.6 : 0.35;
      let v = D / 2;
      for (let s = step; s < L - step / 2; s += step * (0.6 + rand() * 0.8)) {
        v = Math.min(D, Math.max(0, v + (rand() - 0.5) * D * jump));
        out.push(at(s, v));
      }
    }
  }
  return out;
}

/** A closed polyline as an SVG path. */
export const outlinePath = (pts: Pt[]) =>
  `${pts.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")} Z`;
