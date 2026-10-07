import { type CoverLayout, type InBox, measureText, type PrintIssue, type TextBlock } from "@openmanga/domain";
import { computeCrop, renderPanelArt, sharp } from "@openmanga/image-utils";
import type { Frame, ImageTransform } from "@openmanga/schemas";
import { backdrop } from "@openmanga/services";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** The face cover and contents text are set in: always installed in the render image. */
const PRINT_FONT = "'DejaVu Sans', sans-serif";

let fontList: Promise<Set<string> | null> | undefined;
/** Font families the renderer can draw (fontconfig's list), lower-cased; null where fontconfig is not installed. */
export function installedFonts() {
  fontList ??= (async () => {
    try {
      const p = Bun.spawn(["fc-list", ":", "family"], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      if ((await p.exited) !== 0) return null;
      return new Set(
        out
          .split("\n")
          .flatMap((l) => l.split(","))
          .map((f) => f.trim().toLowerCase())
          .filter(Boolean),
      );
    } catch {
      return null;
    }
  })();
  return fontList;
}

export type FontRow = {
  family: string;
  /** Lettering items (bubbles, captions, SFX) set in it. */
  uses: number;
  /** Null when the server cannot tell. */
  installed: boolean | null;
  /** Always false: lettering is drawn into the page pixels, so the PDF holds no font to embed. */
  embedded: false;
  rasterized: true;
};

/** The fonts the lettering asked for, whether the renderer has them, and how they reach the PDF (as pixels). */
export function fontReport(uses: Map<string, number>, installed: Set<string> | null): FontRow[] {
  return [...uses.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([family, n]) => ({
      family,
      uses: n,
      installed: installed ? installed.has(family.toLowerCase()) : null,
      embedded: false,
      rasterized: true,
    }));
}

/**
 * Effective resolution of a panel's art where it prints: the source pixels its crop keeps across the panel's printed
 * width. `frame` is the panel's box on the page (0–1), the page `pageW`×`pageH` px is printed `printedWidthIn` wide.
 */
export function panelArtDpi(
  art: { width: number; height: number },
  frame: Frame,
  t: ImageTransform,
  page: { width: number; height: number },
  printedWidthIn: number,
) {
  const crop = computeCrop(art.width, art.height, (frame.width * page.width) / (frame.height * page.height), t);
  return Math.round(crop.width / (frame.width * printedWidthIn));
}

/** A contents page the size of an interior page: "Contents", then each chapter with its page number. */
export async function renderTocPage(
  toc: { order: number; title: string; page: number }[],
  width: number,
  height: number,
) {
  // Wide margins: on a full-bleed print size the edges are trimmed and the inside is bound.
  const mx = width * 0.14;
  const top = height * 0.14;
  const size = Math.round(width / 34);
  const line = size * 1.9;
  const room = width - 2 * mx - measureText("0000", size);
  const rows = toc.map((t, i) => {
    let label = `${t.order}. ${t.title}`;
    while (label.length > 4 && measureText(label, size) > room) label = `${label.slice(0, -2)}…`;
    const y = top + size * 3 + i * line;
    return `<text x="${mx}" y="${y.toFixed(1)}" font-size="${size}">${esc(label)}</text><text x="${(width - mx).toFixed(1)}" y="${y.toFixed(1)}" font-size="${size}" text-anchor="end">${t.page}</text>`;
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" font-family="${esc(PRINT_FONT)}" fill="#111">
<rect width="${width}" height="${height}" fill="#fff"/>
<text x="${mx}" y="${top.toFixed(1)}" font-size="${Math.round(size * 1.8)}" font-weight="700">Contents</text>
${rows.join("\n")}
</svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
}

/** Text blocks as SVG at `dpi`, in the cover sheet's pixels. */
function textSvg(blocks: TextBlock[], width: number, height: number, dpi: number) {
  const px = (inches: number) => (inches * dpi).toFixed(1);
  const parts = blocks.map((b) => {
    const size = (b.sizePt * dpi) / 72;
    const rot = b.rotate ? ` transform="rotate(90 ${px(b.x)} ${px(b.y)})"` : "";
    const lines = b.lines
      .map((l, i) => `<tspan x="${px(b.x)}" y="${px(b.y + i * b.lineIn)}">${esc(l)}</tspan>`)
      .join("");
    // Display text gets a dark outline so it reads over any art; the back's small text sits on the dark wash.
    const stroke =
      b.role === "back"
        ? ""
        : ` stroke="#000" stroke-width="${(size / (b.role === "title" ? 14 : 20)).toFixed(1)}" paint-order="stroke" stroke-linejoin="round"`;
    return `<text font-family="${esc(PRINT_FONT)}" font-size="${size.toFixed(1)}" font-weight="${b.weight}" fill="#fff" text-anchor="${b.anchor}"${stroke}${rot}>${lines}</text>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join("\n")}</svg>`;
}

/**
 * The drawn text's pixels that land outside every safe area, by panel. The layout keeps text inside by
 * construction from estimated glyph widths; this measures what the font actually drew.
 */
async function textOutsideSafe(svg: string, layout: CoverLayout, dpi: number) {
  const { data, info } = await sharp(Buffer.from(svg)).ensureAlpha().extractChannel(3).raw().toBuffer({
    resolveWithObject: true,
  });
  const boxes = Object.entries(layout.safe).map(([name, b]) => ({
    name,
    x0: b.x * dpi - 1,
    y0: b.y * dpi - 1,
    x1: (b.x + b.width) * dpi + 1,
    y1: (b.y + b.height) * dpi + 1,
  }));
  const where = new Set<string>();
  for (let y = 0; y < info.height; y++)
    for (let x = 0; x < info.width; x++) {
      if (data[y * info.width + x]! < 64) continue;
      if (boxes.some((b) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1)) continue;
      const panel = Object.entries(layout.panels).find(
        ([, b]) => x >= b.x * dpi && x <= (b.x + b.width) * dpi && y >= b.y * dpi && y <= (b.y + b.height) * dpi,
      );
      where.add(panel?.[0] ?? "edge");
    }
  if (!where.size) return [];
  const places = [...where].map((w) => (w === "edge" ? "bleed" : w)).join(" and ");
  return [
    {
      code: "text_outside_safe",
      severity: "warn",
      message: `Text on the ${places} reaches outside the safe area and may be trimmed or folded.`,
    } satisfies PrintIssue,
  ];
}

/**
 * The wraparound cover at `dpi`: a dark wash of the art behind the back and spine, the art itself cropped to the
 * front with its bleed, and the laid-out text. `issues` adds what measuring the drawn text found.
 */
export async function renderPrintCover(layout: CoverLayout, art: Uint8Array, dpi: number) {
  const px = (v: number) => Math.round(v * dpi);
  const width = px(layout.widthIn);
  const height = px(layout.heightIn);
  const fa = layout.frontArt;
  const front = await renderPanelArt(art, px(fa.width), height, { focalX: 0.5, focalY: 0.5, scale: 1 });
  const wash = await backdrop(art, width, height, 0.35);
  const svg = textSvg(layout.text, width, height, dpi);
  const png = await sharp({ create: { width, height, channels: 3, background: "#111111" }, limitInputPixels: false })
    .composite([
      { input: Buffer.from(wash), left: 0, top: 0 },
      { input: Buffer.from(front), left: Math.min(px(fa.x), width - 1), top: 0 },
      { input: Buffer.from(svg), left: 0, top: 0 },
    ])
    .png()
    .toBuffer();
  return { png: new Uint8Array(png), width, height, issues: await textOutsideSafe(svg, layout, dpi) };
}

/** A smaller copy of the cover with the trim, safe areas, spine folds and barcode box drawn on, for checking. */
export async function coverGuides(cover: Uint8Array, layout: CoverLayout, width = 1600) {
  const k = width / layout.widthIn;
  const height = Math.round(layout.heightIn * k);
  const rect = (b: InBox, attrs: string) =>
    `<rect x="${(b.x * k).toFixed(1)}" y="${(b.y * k).toFixed(1)}" width="${(b.width * k).toFixed(1)}" height="${(b.height * k).toFixed(1)}" ${attrs}/>`;
  const p = layout.panels;
  const trim = { x: p.back.x, y: p.back.y, width: p.back.width * 2 + p.spine.width, height: p.back.height };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
${rect(trim, `fill="none" stroke="#00e5ff" stroke-width="2"`)}
${rect(p.spine, `fill="none" stroke="#00e5ff" stroke-width="2"`)}
${Object.values(layout.safe)
  .map((b) => rect(b, `fill="none" stroke="#ff2bd6" stroke-width="2" stroke-dasharray="8 6"`))
  .join("\n")}
${rect(layout.barcode, `fill="#ffffff" fill-opacity="0.85" stroke="#ffb000" stroke-width="2"`)}
<text x="${((layout.barcode.x + layout.barcode.width / 2) * k).toFixed(1)}" y="${((layout.barcode.y + layout.barcode.height / 2) * k).toFixed(1)}" font-family="${esc(PRINT_FONT)}" font-size="${Math.round(k * 0.18)}" text-anchor="middle" fill="#333">Barcode</text>
</svg>`;
  return new Uint8Array(
    await sharp(cover, { limitInputPixels: false })
      .resize(width, height, { fit: "fill" })
      .composite([{ input: Buffer.from(svg) }])
      .png()
      .toBuffer(),
  );
}
