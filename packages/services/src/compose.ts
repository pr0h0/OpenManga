import {
  and,
  asc,
  assets,
  type Database,
  dialogueLines,
  eq,
  inArray,
  narrationLines,
  pages,
  panels,
  soundEffects,
  sql,
} from "@openmanga/db";
import {
  bubbleGeometry,
  featherMask,
  layoutBubbleText,
  readingOrder,
  type StripBlock,
  stripLayout,
} from "@openmanga/domain";
import { renderPanelArt, sharp } from "@openmanga/image-utils";
import type { Bubble, Frame, ImageTransform, PanelSeam, SfxStyle } from "@openmanga/schemas";
import { type AssetStorage, sha256Hex } from "@openmanga/storage";
import type { AssetService } from "./assets.ts";

export type RenderPanel = {
  id: string;
  order: number;
  frame: Frame;
  imageTransform: ImageTransform;
  art: Uint8Array | null;
  /** Vertical strips: how this panel meets the one before it. Ignored by paged rendering. */
  seam?: PanelSeam | null;
};
export type RenderText = { id: string; panelId: string | null; text: string; bubble: Bubble };
export type RenderSfx = { id: string; panelId: string | null; text: string; style: SfxStyle };
export type RenderPage = {
  id: string;
  order: number;
  width: number;
  height: number;
  readingDirection: "ltr" | "rtl" | "vertical";
  panels: RenderPanel[];
  bubbles: RenderText[];
  sfx: RenderSfx[];
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const FONT_STACK = (font: string) => `'${font.replace(/'/g, "")}', 'Comic Neue', 'DejaVu Sans', sans-serif`;

export async function loadRenderPage(
  db: Database,
  storage: AssetStorage,
  pageId: string,
  readingDirection: "ltr" | "rtl" | "vertical",
): Promise<RenderPage> {
  const { render, art } = await loadRenderRows(db, pageId, readingDirection);
  return withArt(render, art, storage);
}

/** Everything a page render is drawn from except the artwork bytes, which are read only when needed. */
async function loadRenderRows(db: Database, pageId: string, readingDirection: "ltr" | "rtl" | "vertical") {
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw new Error("Page not found");
  const pns = await db.select().from(panels).where(eq(panels.pageId, pageId)).orderBy(asc(panels.order));
  const artIds = pns.map((p) => p.activeArtworkAssetId).filter((x): x is string => Boolean(x));
  const arts = artIds.length
    ? await db
        .select({ id: assets.id, storageKey: assets.storageKey, sha256: assets.sha256 })
        .from(assets)
        .where(inArray(assets.id, artIds))
    : [];
  const dialogue = await db
    .select()
    .from(dialogueLines)
    .where(eq(dialogueLines.pageId, pageId))
    .orderBy(asc(dialogueLines.order));
  const narration = await db
    .select()
    .from(narrationLines)
    .where(eq(narrationLines.pageId, pageId))
    .orderBy(asc(narrationLines.order));
  const sfx = await db.select().from(soundEffects).where(eq(soundEffects.pageId, pageId));
  const byId = new Map(arts.map((a) => [a.id, a]));
  const render: RenderPage = {
    id: page.id,
    order: page.order,
    width: page.width,
    height: page.height,
    readingDirection: page.readingDirection ?? readingDirection,
    panels: pns.map((p) => ({
      id: p.id,
      order: p.order,
      frame: p.frame,
      imageTransform: p.imageTransform,
      art: null,
      seam: p.seam,
    })),
    bubbles: [
      ...dialogue.map((d) => ({ id: d.id, panelId: d.panelId, text: d.text, bubble: d.bubble })),
      ...narration
        .filter((n) => n.showOnPage && n.box)
        .map((n) => ({ id: n.id, panelId: n.panelId, text: n.text, bubble: n.box! })),
    ],
    sfx: sfx.map((s) => ({ id: s.id, panelId: s.panelId, text: s.text, style: s.style })),
  };
  // Each panel's active artwork file, in panel order.
  const art = pns.map((p) => (p.activeArtworkAssetId ? (byId.get(p.activeArtworkAssetId) ?? null) : null));
  return { render, art };
}

async function withArt(
  render: RenderPage,
  art: ({ storageKey: string } | null)[],
  storage: AssetStorage,
): Promise<RenderPage> {
  const withBytes: RenderPanel[] = [];
  for (const [i, p] of render.panels.entries()) {
    const a = art[i];
    const bytes = a ? await storage.read(a.storageKey).catch(() => new Uint8Array()) : undefined;
    withBytes.push({ ...p, art: bytes?.byteLength ? bytes : null });
  }
  return { ...render, panels: withBytes };
}

/** Bump when the compositor's output changes, so cached page renders are drawn again. */
const PAGE_RENDER_VERSION = 1;

type PageRenderMeta = { pageId: string; fingerprint: string; width: number };

const renderFingerprint = (render: RenderPage, art: ({ sha256: string } | null)[]) =>
  sha256Hex(JSON.stringify({ v: PAGE_RENDER_VERSION, render, art: art.map((a) => a?.sha256 ?? null) }));

/** A hash of everything a lettered page is drawn from (see `cachedPageRender`): equal hashes draw equal pixels. */
export async function pageRenderFingerprint(
  db: Database,
  pageId: string,
  readingDirection: "ltr" | "rtl" | "vertical",
) {
  const { render, art } = await loadRenderRows(db, pageId, readingDirection);
  return renderFingerprint(render, art);
}

/**
 * A reader link's lettered page as a cached PNG, stored as a project asset of type `thumbnail` (so the library
 * list skips it and disk usage counts it as derived). The fingerprint covers everything the page is drawn from:
 * the page, panel frames, transforms and seams, the active artwork's hash, bubbles and SFX. Any edit is therefore a
 * miss, and writing the new render deletes the page's superseded ones. `rendered` is false on a cache hit.
 */
export async function cachedPageRender(
  db: Database,
  assetSvc: AssetService,
  projectId: string,
  pageId: string,
  readingDirection: "ltr" | "rtl" | "vertical",
  width: number,
) {
  const { render, art } = await loadRenderRows(db, pageId, readingDirection);
  const fingerprint = renderFingerprint(render, art);
  const cached = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.projectId, projectId),
        eq(assets.type, "thumbnail"),
        sql`${assets.metadata}->'pageRender'->>'pageId' = ${pageId}`,
      ),
    );
  const meta = (a: (typeof cached)[number]) => a.metadata.pageRender as PageRenderMeta;
  const hit = cached.find((a) => meta(a).fingerprint === fingerprint && meta(a).width === width);
  if (hit && (await assetSvc.storage.exists(hit.storageKey))) return { asset: hit, rendered: false };
  const img = await renderPageImage(await withArt(render, art, assetSvc.storage), "png", {
    scale: Math.min(1, width / render.width),
  });
  const asset = await assetSvc.store({
    projectId,
    ownerUserId: null,
    type: "thumbnail",
    mimeType: img.mime,
    width: img.width,
    height: img.height,
    data: img.data,
    metadata: { pageRender: { pageId, fingerprint, width } satisfies PageRenderMeta },
  });
  // Older content goes; the same content at other widths stays for other screens.
  for (const old of cached)
    if (meta(old).fingerprint !== fingerprint || meta(old).width === width) await assetSvc.hardDelete(old);
  return { asset, rendered: true };
}

function bubbleSvg(t: RenderText, W: number, H: number, fontScale: number) {
  const b = {
    ...t.bubble,
    fontSize: t.bubble.fontSize * fontScale,
    padding: t.bubble.padding * fontScale,
    borderWidth: t.bubble.borderWidth * fontScale,
  };
  const g = bubbleGeometry(b, W, H);
  const layout = layoutBubbleText(t.text, b, W, H);
  const anchor = b.align === "left" ? "start" : b.align === "right" ? "end" : "middle";
  const tx =
    b.align === "left"
      ? b.padding + (b.type === "narration" || b.type === "system" ? 0 : g.width * 0.075)
      : b.align === "right"
        ? g.width - b.padding
        : g.width / 2;
  const lines = layout.lines
    .map((l, i) => `<tspan x="${tx.toFixed(1)}" y="${(layout.top + i * layout.lineH).toFixed(1)}">${esc(l)}</tspan>`)
    .join("");
  const rot = b.rotation ? ` rotate(${b.rotation} ${(g.width / 2).toFixed(1)} ${(g.height / 2).toFixed(1)})` : "";
  return `<g transform="translate(${g.x.toFixed(1)} ${g.y.toFixed(1)})${rot}">
<path d="${g.path}" fill="${esc(b.background)}" stroke="${esc(b.borderColor)}" stroke-width="${b.borderWidth}" stroke-linejoin="round"${g.dash ? ` stroke-dasharray="${g.dash.join(" ")}"` : ""}/>
${g.innerBorder ? `<path d="${g.innerBorder}" fill="none" stroke="${esc(b.borderColor)}" stroke-width="${Math.max(1, b.borderWidth / 2)}"/>` : ""}
<text font-family="${esc(FONT_STACK(b.font))}" font-size="${b.fontSize.toFixed(1)}" font-weight="${b.type === "shout" ? 700 : 400}" fill="${esc(b.textColor)}" text-anchor="${anchor}">${lines}</text>
</g>`;
}

function sfxSvg(s: RenderSfx, W: number, H: number, fontScale: number) {
  const st = s.style;
  const size = st.fontSize * st.scale * fontScale;
  return `<text x="${(st.x * W).toFixed(1)}" y="${(st.y * H).toFixed(1)}" transform="rotate(${st.rotation} ${(st.x * W).toFixed(1)} ${(st.y * H).toFixed(1)})" font-family="${esc(FONT_STACK(st.font))}" font-weight="900" font-size="${size.toFixed(1)}" fill="${esc(st.fill)}" stroke="${esc(st.stroke)}" stroke-width="${(st.strokeWidth * fontScale).toFixed(1)}" paint-order="stroke" stroke-linejoin="round" opacity="${st.opacity}" text-anchor="middle">${esc(s.text)}</text>`;
}

type ArtLayer = { input: Buffer; left: number; top: number };

/**
 * Deterministic page composition: artwork cropped into frames, vector borders, bubbles and SFX.
 * With `rasterArt`, artwork is returned as raster layers instead of being inlined as base64 in the SVG:
 * librsvg refuses XML lines over ~10 MB, which large PNG panels exceed.
 */
export async function renderPageSvg(
  p: RenderPage,
  scale = 1,
  opts: { background?: string; borders?: boolean; fontScale?: number; rasterArt?: boolean } = {},
) {
  const W = Math.round(p.width * scale);
  const H = Math.round(p.height * scale);
  const fontScale = opts.fontScale ?? scale;
  const layers: ArtLayer[] = [];
  const parts: string[] = opts.rasterArt
    ? []
    : [`<rect width="${W}" height="${H}" fill="${opts.background ?? "#ffffff"}"/>`];
  for (const panel of readingOrder(p.panels, p.readingDirection)) {
    const x = panel.frame.x * W;
    const y = panel.frame.y * H;
    const w = Math.max(1, panel.frame.width * W);
    const h = Math.max(1, panel.frame.height * H);
    if (panel.art && opts.rasterArt) {
      // Same pixel box the SVG <image> would occupy (rounded size at the rounded origin).
      const png = await renderPanelArt(panel.art, Math.round(w), Math.round(h), panel.imageTransform);
      layers.push({ input: Buffer.from(png), left: Math.round(x), top: Math.round(y) });
    } else if (panel.art) {
      const png = await renderPanelArt(panel.art, w, h, panel.imageTransform);
      parts.push(
        `<image x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.round(w)}" height="${Math.round(h)}" preserveAspectRatio="none" href="data:image/png;base64,${Buffer.from(png).toString("base64")}"/>`,
      );
    } else {
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="#f1f1f1"/>`,
      );
    }
    if (opts.borders !== false)
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="none" stroke="#111" stroke-width="${Math.max(2, 4 * scale).toFixed(1)}"/>`,
      );
  }
  for (const s of [...p.sfx].sort((a, b) => a.style.zIndex - b.style.zIndex)) parts.push(sfxSvg(s, W, H, fontScale));
  for (const t of [...p.bubbles].sort((a, b) => a.bubble.zIndex - b.bubble.zIndex))
    parts.push(bubbleSvg(t, W, H, fontScale));
  return {
    svg: `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join("\n")}</svg>`,
    width: W,
    height: H,
    layers,
  };
}

/** Rasterize a page: background, artwork layers, then the vector overlay (borders, SFX, bubbles). */
async function rasterize(p: RenderPage, scale: number, opts: { borders?: boolean; fontScale?: number } = {}) {
  const { svg, width, height, layers } = await renderPageSvg(p, scale, { ...opts, rasterArt: true });
  const fit = layers.map((l) => ({
    ...l,
    left: Math.min(Math.max(0, l.left), width - 1),
    top: Math.min(Math.max(0, l.top), height - 1),
  }));
  const cropped = await Promise.all(
    fit.map(async (l) => {
      const meta = await sharp(l.input).metadata();
      const w = Math.min(meta.width ?? 0, width - l.left);
      const h = Math.min(meta.height ?? 0, height - l.top);
      return w === meta.width && h === meta.height
        ? l
        : { ...l, input: await sharp(l.input).extract({ left: 0, top: 0, width: w, height: h }).toBuffer() };
    }),
  );
  assertCanvasSize(width, height, "This page render");
  const data = await sharp({
    create: { width, height, channels: 4, background: "#ffffff" },
    limitInputPixels: false,
  })
    .composite([...cropped, { input: Buffer.from(svg), left: 0, top: 0 }])
    .png()
    .toBuffer();
  return { data, width, height };
}

export async function renderPageImage(
  p: RenderPage,
  format: "png" | "jpg",
  opts: { scale?: number; quality?: number } = {},
) {
  const { data: base, width, height } = await rasterize(p, opts.scale ?? 1);
  const img = sharp(base, { limitInputPixels: false });
  const data =
    format === "png"
      ? await img.png().toBuffer()
      : await img
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: opts.quality ?? 90, mozjpeg: true })
          .toBuffer();
  return { data: new Uint8Array(data), width, height, mime: format === "png" ? "image/png" : "image/jpeg" };
}

/** Webtoon: each panel becomes a full-width strip block with its own lettering, carrying its seam forward. */
export async function renderWebtoonBlocks(p: RenderPage, width: number): Promise<StripBlock[]> {
  const blocks: StripBlock[] = [];
  const centerIn = (fr: Frame, x: number, y: number) =>
    x >= fr.x && x <= fr.x + fr.width && y >= fr.y && y <= fr.y + fr.height;
  for (const panel of readingOrder(p.panels, "vertical")) {
    const fr = panel.frame;
    const pxW = fr.width * p.width;
    const pxH = fr.height * p.height;
    const k = width / pxW;
    const height = Math.max(1, Math.round(pxH * k));
    const mapRect = (b: Bubble): Bubble => ({
      ...b,
      x: (b.x - fr.x) / fr.width,
      y: (b.y - fr.y) / fr.height,
      width: b.width / fr.width,
      height: b.height / fr.height,
      tailTarget: b.tailTarget
        ? { x: (b.tailTarget.x - fr.x) / fr.width, y: (b.tailTarget.y - fr.y) / fr.height }
        : undefined,
    });
    const belongs = (panelId: string | null, cx: number, cy: number) =>
      panelId === panel.id || (!panelId && centerIn(fr, cx, cy));
    const sub: RenderPage = {
      ...p,
      width,
      height,
      panels: [{ ...panel, frame: { x: 0, y: 0, width: 1, height: 1 } }],
      bubbles: p.bubbles
        .filter((t) => belongs(t.panelId, t.bubble.x + t.bubble.width / 2, t.bubble.y + t.bubble.height / 2))
        .map((t) => ({ ...t, bubble: clampBubble(mapRect(t.bubble)) })),
      sfx: p.sfx
        .filter((s) => belongs(s.panelId, s.style.x, s.style.y))
        .map((s) => ({
          ...s,
          style: {
            ...s.style,
            x: Math.min(1, Math.max(0, (s.style.x - fr.x) / fr.width)),
            y: Math.min(1, Math.max(0, (s.style.y - fr.y) / fr.height)),
          },
        })),
    };
    // lettering sizes were authored in page pixels; scale them with the panel
    const { data: png } = await rasterize(sub, 1, { borders: false, fontScale: k });
    const data = new Uint8Array(png);
    blocks.push({ data, height, seam: panel.seam ?? null });
  }
  return blocks;
}

function clampBubble(b: Bubble): Bubble {
  const width = Math.min(1, b.width);
  const height = Math.min(1, b.height);
  return {
    ...b,
    width,
    height,
    x: Math.min(1 - width, Math.max(0, b.x)),
    y: Math.min(1 - height, Math.max(0, b.y)),
    tailTarget: b.tailTarget
      ? { x: Math.min(1, Math.max(0, b.tailTarget.x)), y: Math.min(1, Math.max(0, b.tailTarget.y)) }
      : undefined,
  };
}

/**
 * Ceiling on a single canvas. Page size, `scale` and webtoon stacking are all caller-controlled, and RGBA at
 * 4 bytes a pixel means 200 MP is already ~800 MB — past this the worker is OOM-killed and takes every other
 * queue down with it, so it fails the export instead.
 */
const MAX_CANVAS_PIXELS = 200_000_000;
export function assertCanvasSize(width: number, height: number, what: string) {
  if (width * height > MAX_CANVAS_PIXELS)
    throw new Error(
      `${what} would be ${width}x${height} (${Math.round((width * height) / 1e6)} MP), over the ${Math.round(
        MAX_CANVAS_PIXELS / 1e6,
      )} MP limit. Reduce the scale, page size or chunk height.`,
    );
}

export async function stackVertical(
  blocks: { data: Uint8Array; height: number }[],
  width: number,
  gap: number,
  background = "#ffffff",
) {
  const total = blocks.reduce((s, b) => s + b.height, 0) + gap * Math.max(0, blocks.length - 1);
  assertCanvasSize(width, Math.max(1, total), "This webtoon strip");
  let top = 0;
  const composites = blocks.map((b) => {
    const c = { input: Buffer.from(b.data), top, left: 0 };
    top += b.height + gap;
    return c;
  });
  const out = await sharp({
    create: { width, height: Math.max(1, total), channels: 3, background },
    limitInputPixels: false,
  })
    .composite(composites)
    .png()
    .toBuffer();
  return { data: new Uint8Array(out), height: total };
}

/**
 * Stacks panel blocks into one strip, honouring each block's seam: a plain gap, no gap at all, an overlap with a
 * hard or blended edge, or a fade through a flat colour. The arithmetic lives in stripLayout; this only paints.
 */
export async function renderStrip(blocks: StripBlock[], width: number, gap: number, background = "#ffffff") {
  const layout = stripLayout(blocks, { gap, background });
  const height = Math.max(1, layout.height);
  assertCanvasSize(width, height, "This webtoon strip");
  const feathers = new Map(layout.feathers.map((f) => [f.index, f]));
  type Layer = {
    input: Buffer | { create: { width: number; height: number; channels: 4; background: string } };
    top: number;
    left: number;
    blend?: "over";
  };
  const composites: Layer[] = [];
  // Bands go down first: a faded edge has to dissolve into the colour, not into whatever is behind the strip.
  for (const band of layout.bands) {
    const top = Math.max(0, band.top);
    const h = Math.max(1, Math.min(band.height, height - top));
    composites.push({
      input: { create: { width, height: h, channels: 4, background: band.color } },
      top,
      left: 0,
    });
  }
  for (const place of layout.placements) {
    const block = blocks[place.index]!;
    const f = feathers.get(place.index);
    const input = f
      ? Buffer.from(
          await sharp(block.data)
            .ensureAlpha()
            // dest-in keeps the panel only where the ramp is opaque, which is how its edge becomes translucent.
            .composite([{ input: Buffer.from(featherMask(width, block.height, f.top, f.bottom)), blend: "dest-in" }])
            .png()
            .toBuffer(),
        )
      : Buffer.from(block.data);
    composites.push({ input, top: Math.max(0, place.top), left: 0 });
  }
  const out = await sharp({ create: { width, height, channels: 4, background }, limitInputPixels: false })
    .composite(composites)
    .flatten({ background })
    .png()
    .toBuffer();
  return { data: new Uint8Array(out), height };
}

/** Split blocks into platform-safe chunks at block boundaries. */
export function chunkBlocks<T extends { height: number }>(blocks: T[], maxHeight: number, gap: number): T[][] {
  const chunks: T[][] = [];
  let cur: T[] = [];
  let h = 0;
  for (const b of blocks) {
    const add = (cur.length ? gap : 0) + b.height;
    if (cur.length && h + add > maxHeight) {
      chunks.push(cur);
      cur = [];
      h = 0;
    }
    h += (cur.length ? gap : 0) + b.height;
    cur.push(b);
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/** Greedy word wrap into at most `maxLines` lines of about `perLine` characters; the rest joins the last line. */
function wrapWords(text: string, perLine: number, maxLines: number) {
  const lines: string[] = [];
  for (const w of text.trim().split(/\s+/).filter(Boolean)) {
    const last = lines.at(-1);
    if (last !== undefined && (last.length + 1 + w.length <= perLine || lines.length === maxLines))
      lines[lines.length - 1] = `${last} ${w}`;
    else lines.push(w);
  }
  return lines;
}

/**
 * Video thumbnail, 1280×720: the model's text-free art with the headline composited on the clear side, large,
 * heavy and outlined so it reads at the size of a list entry. Rendered on request, so rewording it is free.
 */
export async function renderThumbnail(
  art: Uint8Array,
  title: string,
  subtitle: string,
  side: "left" | "right",
  width = 1280,
) {
  const height = Math.round((width * 9) / 16);
  const bg = await renderPanelArt(art, width, height, { focalX: 0.5, focalY: 0.5, scale: 1 });
  const text = title.toUpperCase().trim();
  // Up to three balanced lines: a long headline gets longer lines, not an overflowing last one.
  const lines = wrapWords(text, Math.max(10, Math.ceil(text.length / 3) + 2), 3);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  // Heavy capitals are ~0.72 em wide: size the longest line to ~55% of the width, never wider.
  const size = Math.round(Math.min(height / 4.5, (width * 0.55) / (longest * 0.72)));
  const x = side === "left" ? Math.round(width * 0.05) : Math.round(width * 0.95);
  const anchor = side === "left" ? "start" : "end";
  const blockH = lines.length * size * 1.02 + (subtitle ? size * 0.55 : 0);
  const top = (height - blockH) / 2 + size * 0.85;
  const shade = side === "left" ? `x1="0" x2="1"` : `x1="1" x2="0"`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<defs><linearGradient id="s" ${shade} y1="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.7"/><stop offset="0.6" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#s)"/>
${lines
  .map(
    (l, i) =>
      `<text x="${x}" y="${top + i * size * 1.02}" text-anchor="${anchor}" font-family="'DejaVu Sans', sans-serif" font-weight="900" font-size="${size}" fill="${i === lines.length - 1 ? "#ffd400" : "#fff"}" stroke="#000" stroke-width="${size / 9}" paint-order="stroke" stroke-linejoin="round">${esc(l)}</text>`,
  )
  .join("\n")}
${subtitle ? `<text x="${x}" y="${top + lines.length * size * 1.02 + size * 0.15}" text-anchor="${anchor}" font-family="'DejaVu Sans', sans-serif" font-weight="700" font-size="${Math.round(size * 0.4)}" fill="#fff" stroke="#000" stroke-width="${size / 30}" paint-order="stroke">${esc(subtitle)}</text>` : ""}
</svg>`;
  return new Uint8Array(
    await sharp(bg)
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer(),
  );
}

/** Blurred, darkened full-frame backdrop. Blurring a small copy then scaling up is as good for a heavy wash and ~10x faster. */
export async function backdrop(png: Uint8Array, frameW: number, frameH: number, brightness = 0.55) {
  const small = await sharp(png)
    .resize(Math.max(1, Math.round(frameW / 10)), Math.max(1, Math.round(frameH / 10)), { fit: "cover" })
    .blur(2)
    .modulate({ brightness })
    .toBuffer();
  return new Uint8Array(await sharp(small).resize(frameW, frameH, { kernel: "cubic" }).png().toBuffer());
}

/**
 * An intro or outro card at `width`×`height`: the project's art as a dark wash behind the title and subtitle, set in
 * the project's narration lettering font. Deterministic, so the preview shows the pixels the render encodes.
 */
export async function renderVideoCard(
  card: { title: string; subtitle: string },
  width: number,
  height: number,
  art: Uint8Array | null,
  font: string,
) {
  const bg = art
    ? await backdrop(art, width, height, 0.4)
    : new Uint8Array(
        await sharp({ create: { width, height, channels: 3, background: "#111111" } })
          .png()
          .toBuffer(),
      );
  const short = Math.min(width, height);
  const title = card.title.trim();
  const lines = wrapWords(title, Math.max(12, Math.round(width / short) * 14), 3);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const size = Math.round(Math.min(short / 8, (width * 0.84) / (longest * 0.6)));
  const sub = card.subtitle.trim();
  const subSize = Math.round(size * 0.42);
  const blockH = lines.length * size * 1.1 + (sub ? subSize * 1.6 : 0);
  const top = (height - blockH) / 2 + size * 0.85;
  const family = esc(FONT_STACK(font));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
${lines
  .map(
    (l, i) =>
      `<text x="${width / 2}" y="${(top + i * size * 1.1).toFixed(1)}" text-anchor="middle" font-family="${family}" font-weight="700" font-size="${size}" fill="#fff" stroke="#000" stroke-width="${(size / 16).toFixed(1)}" paint-order="stroke">${esc(l)}</text>`,
  )
  .join("\n")}
${sub ? `<text x="${width / 2}" y="${(top + lines.length * size * 1.1 + subSize * 0.6).toFixed(1)}" text-anchor="middle" font-family="${family}" font-size="${subSize}" fill="#ddd">${esc(sub)}</text>` : ""}
</svg>`;
  return new Uint8Array(
    await sharp(bg)
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer(),
  );
}

/**
 * A quote image: `art` already cropped to `width`×`height` (the panel's own framing), darkened towards the bottom, with
 * the line set there in the lettering font and the project title under it.
 */
export async function renderQuoteImage(
  art: Uint8Array,
  width: number,
  height: number,
  quote: string,
  credit: string,
  font: string,
) {
  const text = `“${quote.trim().replace(/^["“]|["”]$/g, "")}”`;
  const lines = wrapWords(text, Math.max(14, Math.round(Math.sqrt(text.length * 3.2))), 6);
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const size = Math.round(Math.min(width / 11, (width * 0.86) / (longest * 0.55)));
  const creditSize = Math.round(width / 34);
  const bottom = height * 0.93 - (credit ? creditSize * 1.8 : 0);
  const top = bottom - (lines.length - 1) * size * 1.15;
  const family = esc(FONT_STACK(font));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<defs><linearGradient id="q" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.85"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
<rect y="${(top - size * 2.2).toFixed(1)}" width="${width}" height="${(height - top + size * 2.2).toFixed(1)}" fill="url(#q)"/>
${lines
  .map(
    (l, i) =>
      `<text x="${width / 2}" y="${(top + i * size * 1.15).toFixed(1)}" text-anchor="middle" font-family="${family}" font-weight="700" font-size="${size}" fill="#fff" stroke="#000" stroke-width="${(size / 18).toFixed(1)}" paint-order="stroke">${esc(l)}</text>`,
  )
  .join("\n")}
${credit ? `<text x="${width / 2}" y="${(height * 0.93).toFixed(1)}" text-anchor="middle" font-family="${family}" font-size="${creditSize}" fill="#ddd">${esc(credit)}</text>` : ""}
</svg>`;
  return new Uint8Array(
    await sharp(art)
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer(),
  );
}

/** Cover: artwork from the model + app-composited title/subtitle/author (never model-rendered text). */
export async function renderCover(art: Uint8Array, title: string, subtitle: string, author: string, width = 1200) {
  const height = Math.round(width * 1.5);
  const bg = await renderPanelArt(art, width, height, { focalX: 0.5, focalY: 0.5, scale: 1 });
  const tSize = Math.round(width / (title.length > 18 ? 12 : 8));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
<defs><linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0.65"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient>
<linearGradient id="b" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.7"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
<rect width="${width}" height="${height * 0.32}" fill="url(#t)"/><rect y="${height * 0.8}" width="${width}" height="${height * 0.2}" fill="url(#b)"/>
<text x="${width / 2}" y="${height * 0.13}" text-anchor="middle" font-family="'DejaVu Sans', sans-serif" font-weight="900" font-size="${tSize}" fill="#fff" stroke="#000" stroke-width="${tSize / 14}" paint-order="stroke">${esc(title)}</text>
${subtitle ? `<text x="${width / 2}" y="${height * 0.13 + tSize}" text-anchor="middle" font-family="'DejaVu Sans', sans-serif" font-size="${Math.round(tSize / 2.6)}" fill="#fff">${esc(subtitle)}</text>` : ""}
${author ? `<text x="${width / 2}" y="${height * 0.95}" text-anchor="middle" font-family="'DejaVu Sans', sans-serif" font-size="${Math.round(width / 30)}" fill="#fff">${esc(author)}</text>` : ""}
</svg>`;
  return new Uint8Array(
    await sharp(bg)
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer(),
  );
}
