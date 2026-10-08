import { readingOrder } from "@openmanga/domain";
import { renderPanelArt, sharp } from "@openmanga/image-utils";
import type { Frame } from "@openmanga/schemas";
import {
  type LetteringPart,
  letteringParts,
  maskToFrame,
  panelBox,
  panelFrameSvg,
  type RenderPage,
  renderPageImage,
} from "@openmanga/services";
import type { PsdLayer, PsdNode } from "./psd.ts";

/** Raw RGBA pixels placed on the page. */
export type Raster = { left: number; top: number; width: number; height: number; rgba: Uint8Array };

export type PageLayers = {
  width: number;
  height: number;
  panels: { id: string; number: number; art: Raster | null; frame: Raster | null; guide: Raster | null }[];
  lettering: (LetteringPart & { raster: Raster | null })[];
  /** The page's lettering alone, vector, page-sized, each element a `<g>` with its kind and id. */
  letteringSvg: string;
  /** PNGs of the lettered page and of the page without lettering. */
  composite: Uint8Array;
  textFree: Uint8Array;
};

const svgDoc = (W: number, H: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${body}</svg>`;

/** A transparent, page-sized SVG fragment drawn and cropped to the pixels it covers; null when it covers none. */
export async function rasterizeFragment(body: string, W: number, H: number): Promise<Raster | null> {
  const { data, info } = await sharp(Buffer.from(svgDoc(W, H, body)))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let [x0, y0, x1, y1] = [info.width, info.height, -1, -1];
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++)
      if (data[(y * info.width + x) * 4 + 3]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  return crop(data, info.width, { left: x0, top: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 });
}

function crop(rgba: Uint8Array, stride: number, box: Omit<Raster, "rgba">): Raster {
  const out = new Uint8Array(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++)
    out.set(
      rgba.subarray(((box.top + y) * stride + box.left) * 4, ((box.top + y) * stride + box.left + box.width) * 4),
      y * box.width * 4,
    );
  return { ...box, rgba: out };
}

/** An image drawn into a panel's box the way the page draws its art, clipped to the page. */
async function panelRaster(
  image: Uint8Array,
  box: ReturnType<typeof panelBox>,
  t: { focalX: number; focalY: number; scale: number },
  W: number,
  H: number,
  /** A shaped panel's frame: its art is cut to the outline, as on the page. */
  frame?: Frame,
): Promise<Raster | null> {
  const left = Math.round(box.x);
  const top = Math.round(box.y);
  const [w, h] = [Math.round(box.w), Math.round(box.h)];
  const art = await renderPanelArt(image, w, h, t);
  const png = frame ? await maskToFrame(art, frame, w, h) : art;
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const width = Math.min(info.width, W - left);
  const height = Math.min(info.height, H - top);
  if (left < 0 || top < 0 || width <= 0 || height <= 0) return null;
  return { ...crop(new Uint8Array(data), info.width, { left: 0, top: 0, width, height }), left, top };
}

/**
 * A page taken apart the way the compositor puts it together, at `scale`: each panel's art, frame and layout guide,
 * every lettering element on its own (vector and drawn), and the page with and without its lettering.
 */
export async function pageLayers(p: RenderPage, scale: number, guides: Map<string, Uint8Array>): Promise<PageLayers> {
  const W = Math.round(p.width * scale);
  const H = Math.round(p.height * scale);
  const panels: PageLayers["panels"] = [];
  for (const [i, panel] of readingOrder(p.panels, p.readingDirection).entries()) {
    const box = panelBox(panel.frame, W, H);
    const guide = guides.get(panel.id);
    panels.push({
      id: panel.id,
      number: i + 1,
      art: panel.art ? await panelRaster(panel.art, box, panel.imageTransform, W, H, panel.frame) : null,
      frame: await rasterizeFragment(panelFrameSvg(panel.frame, W, H, scale), W, H),
      guide: guide ? await panelRaster(guide, box, { focalX: 0.5, focalY: 0.5, scale: 1 }, W, H) : null,
    });
  }
  const parts = letteringParts(p, W, H, scale);
  const lettering = [];
  for (const part of parts) lettering.push({ ...part, raster: await rasterizeFragment(part.svg, W, H) });
  return {
    width: W,
    height: H,
    panels,
    lettering,
    letteringSvg: svgDoc(W, H, parts.map((l) => `<g id="${l.kind}-${l.id}">${l.svg}</g>`).join("\n")),
    composite: (await renderPageImage(p, "png", { scale })).data,
    textFree: (await renderPageImage({ ...p, bubbles: [], sfx: [] }, "png", { scale })).data,
  };
}

const short = (text: string) => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > 40 ? `${t.slice(0, 39)}…` : t || "(empty)";
};
const layer = (name: string, r: Raster, extra: Partial<PsdLayer> = {}): PsdLayer => ({ name, ...r, ...extra });

/**
 * The PSD layer tree, bottom to top: a white background, the panels (each a group of its hidden layout guide, art and
 * frame), then effects, captions and dialogue, each element its own layer named by its text.
 */
export function psdTree(l: PageLayers): PsdNode[] {
  const white: Raster = {
    left: 0,
    top: 0,
    width: l.width,
    height: l.height,
    rgba: new Uint8Array(l.width * l.height * 4).fill(255),
  };
  const panels: PsdNode[] = l.panels.map((p) => ({
    name: `Panel ${p.number}`,
    children: [
      ...(p.guide ? [layer("Layout guide", p.guide, { hidden: true, opacity: 0.5 })] : []),
      ...(p.art ? [layer("Art", p.art)] : []),
      ...(p.frame ? [layer("Frame", p.frame)] : []),
    ],
  }));
  const group = (name: string, kind: LetteringPart["kind"]): PsdNode[] => {
    const children = l.lettering.filter((x) => x.kind === kind && x.raster).map((x) => layer(short(x.text), x.raster!));
    return children.length ? [{ name, children }] : [];
  };
  return [
    layer("Background", white),
    ...(panels.length ? [{ name: "Panels", children: panels }] : []),
    ...group("Effects", "sfx"),
    ...group("Captions", "narration"),
    ...group("Dialogue", "dialogue"),
  ];
}

/** Raw RGB of a PNG, for the PSD's flattened image. */
export async function rgbPixels(png: Uint8Array) {
  return new Uint8Array(
    await sharp(png, { limitInputPixels: false }).flatten({ background: "#ffffff" }).removeAlpha().raw().toBuffer(),
  );
}

/** A raster as PNG, for the separated-layers archive. */
export async function rasterPng(r: Raster) {
  return new Uint8Array(
    await sharp(r.rgba, { raw: { width: r.width, height: r.height, channels: 4 } })
      .png()
      .toBuffer(),
  );
}
