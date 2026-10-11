import type { PanelEffect } from "@openmanga/schemas";

/**
 * Comic effects as SVG drawn over a panel's art, the same in the editor and in every render. Deterministic: the
 * random parts (line lengths, flakes) come from a generator seeded by the panel and the effect's place in the list.
 * `blend` is how the layer sits on the art; `flashback` also asks for the art to be greyed and warmed (`tint`).
 */
export type EffectLayer = { svg: string; blend: "over" | "multiply" | "screen"; tint?: boolean };

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

const f = (n: number) => n.toFixed(1);
const wrap = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="0 0 ${f(w)} ${f(h)}">${body}</svg>`;

/** One effect as an SVG layer the size of the panel box. */
export function effectLayer(e: PanelEffect, w: number, h: number, seed: string): EffectLayer {
  const r = rng(`${seed}:${e.type}`);
  const m = Math.min(w, h);
  const diag = Math.hypot(w, h);
  const cx = e.x * w;
  const cy = e.y * h;
  const op = e.strength;
  switch (e.type) {
    case "speed": {
      // Thin tapered streaks along `angle`, across the whole panel.
      const a = (e.angle * Math.PI) / 180;
      const [dx, dy] = [Math.cos(a), Math.sin(a)];
      const [nx, ny] = [-dy, dx];
      const n = Math.round(20 + e.density * 140);
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const off = (r() - 0.5) * diag;
        const along = (r() - 0.5) * diag * 0.6;
        const len = diag * (0.25 + r() * 0.6);
        const wd = m * (0.002 + r() * 0.006);
        const sx = w / 2 + nx * off + dx * (along - len / 2);
        const sy = h / 2 + ny * off + dy * (along - len / 2);
        const ex = sx + dx * len;
        const ey = sy + dy * len;
        parts.push(`M${f(sx)} ${f(sy)}L${f(ex + nx * wd)} ${f(ey + ny * wd)}L${f(ex - nx * wd)} ${f(ey - ny * wd)}Z`);
      }
      return { svg: wrap(w, h, `<path d="${parts.join("")}" fill="${e.color}" opacity="${op}"/>`), blend: "over" };
    }
    case "focus": {
      // Wedges from beyond the edge toward the centre, stopping short of a clear circle.
      const clear = e.size * m;
      const n = Math.round(40 + e.density * 160);
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + r() * 0.04;
        const inner = clear * (0.85 + r() * 0.5);
        const half = 0.004 + r() * 0.012;
        const tip = [cx + Math.cos(a) * inner, cy + Math.sin(a) * inner];
        const b1 = [cx + Math.cos(a - half) * diag, cy + Math.sin(a - half) * diag];
        const b2 = [cx + Math.cos(a + half) * diag, cy + Math.sin(a + half) * diag];
        parts.push(`M${f(tip[0]!)} ${f(tip[1]!)}L${f(b1[0]!)} ${f(b1[1]!)}L${f(b2[0]!)} ${f(b2[1]!)}Z`);
      }
      return { svg: wrap(w, h, `<path d="${parts.join("")}" fill="${e.color}" opacity="${op}"/>`), blend: "over" };
    }
    case "impact": {
      // A jagged starburst with a white flash at its heart.
      const n = Math.round(14 + e.density * 22);
      const outer = e.size * m;
      const pts: string[] = [];
      for (let i = 0; i < n * 2; i++) {
        const a = (i / (n * 2)) * Math.PI * 2;
        const rad = i % 2 ? outer * (0.35 + r() * 0.15) : outer * (0.75 + r() * 0.5);
        pts.push(`${f(cx + Math.cos(a) * rad)},${f(cy + Math.sin(a) * rad)}`);
      }
      return {
        svg: wrap(
          w,
          h,
          `<defs><radialGradient id="g" cx="${f(cx)}" cy="${f(cy)}" r="${f(outer * 1.4)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="${op}"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient></defs><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(outer * 1.4)}" fill="url(#g)"/><polygon points="${pts.join(" ")}" fill="#fff" stroke="${e.color}" stroke-width="${f(m * 0.006)}" opacity="${op}"/>`,
        ),
        blend: "over",
      };
    }
    case "tone": {
      // Halftone dots, multiplied in so they darken without hiding the lines.
      const step = Math.max(3, m * (0.008 + (1 - e.density) * 0.02));
      return {
        svg: wrap(
          w,
          h,
          `<defs><pattern id="t" width="${f(step)}" height="${f(step)}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><circle cx="${f(step / 2)}" cy="${f(step / 2)}" r="${f(step * 0.3)}" fill="${e.color}"/></pattern></defs><rect width="${f(w)}" height="${f(h)}" fill="url(#t)" opacity="${op}"/>`,
        ),
        blend: "multiply",
      };
    }
    case "rain": {
      const a = ((e.angle || 75) * Math.PI) / 180;
      const [dx, dy] = [Math.cos(a), Math.sin(a)];
      const n = Math.round(60 + e.density * 400);
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const x = r() * w * 1.2 - w * 0.1;
        const y = r() * h * 1.2 - h * 0.1;
        const len = m * (0.03 + r() * 0.06);
        parts.push(`M${f(x)} ${f(y)}l${f(dx * len)} ${f(dy * len)}`);
      }
      return {
        svg: wrap(
          w,
          h,
          `<path d="${parts.join("")}" stroke="${e.color === "#000000" ? "#dfe8f0" : e.color}" stroke-width="${f(Math.max(1, m * 0.003))}" stroke-linecap="round" opacity="${op}"/>`,
        ),
        blend: "screen",
      };
    }
    case "snow":
    case "dust": {
      const snow = e.type === "snow";
      const n = Math.round((snow ? 60 : 120) + e.density * (snow ? 260 : 500));
      const parts: string[] = [];
      for (let i = 0; i < n; i++) {
        const rad = m * (snow ? 0.003 + r() ** 2 * 0.012 : 0.0008 + r() * 0.002);
        parts.push(`<circle cx="${f(r() * w)}" cy="${f(r() * h)}" r="${f(rad)}" opacity="${f(0.4 + r() * 0.6)}"/>`);
      }
      const fill = snow ? "#ffffff" : e.color;
      return {
        svg: wrap(w, h, `<g fill="${fill}" opacity="${op}">${parts.join("")}</g>`),
        blend: snow ? "over" : "multiply",
      };
    }
    case "glow": {
      const rad = e.size * diag;
      const color = e.color === "#000000" ? "#ffd27a" : e.color;
      return {
        svg: wrap(
          w,
          h,
          `<defs><radialGradient id="g" cx="${f(cx)}" cy="${f(cy)}" r="${f(rad)}" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${color}" stop-opacity="${op}"/><stop offset="1" stop-color="${color}" stop-opacity="0"/></radialGradient></defs><rect width="${f(w)}" height="${f(h)}" fill="url(#g)"/>`,
        ),
        blend: "screen",
      };
    }
    case "flashback":
      // The art greyed and warmed by the renderer, and a soft dark vignette.
      return {
        svg: wrap(
          w,
          h,
          `<defs><radialGradient id="v" cx="50%" cy="50%" r="70%"><stop offset="0.55" stop-color="#3a2410" stop-opacity="0"/><stop offset="1" stop-color="#3a2410" stop-opacity="${op}"/></radialGradient></defs><rect width="${f(w)}" height="${f(h)}" fill="url(#v)"/>`,
        ),
        blend: "multiply",
        tint: true,
      };
  }
}

/** Every effect of a panel, in order. */
export const effectLayers = (effects: PanelEffect[] | null | undefined, w: number, h: number, panelId: string) =>
  (effects ?? []).map((e, i) => effectLayer(e, w, h, `${panelId}:${i}`));
