import type { PanelSeam } from "@openmanga/schemas";

/** One panel, already rasterised at the strip's width. `seam` describes how it meets the block before it. */
export type StripBlock = { data: Uint8Array; height: number; seam?: PanelSeam | null };

export type StripLayout = {
  /** Where each block's top edge sits. Blocks may overlap, so these are not cumulative heights. */
  placements: { index: number; top: number }[];
  /** Flat colour painted under a fade seam, so the faded edges dissolve into it rather than into the page. */
  bands: { top: number; height: number; color: string }[];
  /** Alpha ramps applied to a block's own edges before it is composited. */
  feathers: { index: number; top: number; bottom: number }[];
  height: number;
  /** Indices a chunk may start at. A blended seam must never be cut, or the blend tears across two files. */
  breakable: number[];
};

/**
 * Where every block lands in a strip, and what has to be painted or faded between them.
 *
 * Pure on purpose: the seam arithmetic is the part that goes wrong (overlaps making the strip shorter than the
 * sum of its parts, a fade band with nothing behind it, a chunk boundary cutting a dissolve in half), and it is
 * worth checking without rendering anything.
 */
export function stripLayout(blocks: StripBlock[], opts: { gap: number; background?: string }): StripLayout {
  const layout: StripLayout = { placements: [], bands: [], feathers: [], height: 0, breakable: [] };
  let cursor = 0;
  for (const [index, block] of blocks.entries()) {
    const seam = block.seam ?? null;
    const kind = index === 0 ? "first" : (seam?.kind ?? "gap");
    // A seam can never eat more than either neighbour, or blocks would reorder and the strip would lose content.
    const room = Math.min(block.height, blocks[index - 1]?.height ?? block.height);
    const size = seam?.size;
    if (index === 0) {
      layout.breakable.push(0);
    } else if (kind === "butt") {
      layout.breakable.push(index);
    } else if (kind === "gap") {
      cursor += size ?? opts.gap;
      layout.breakable.push(index);
    } else if (kind === "bleed" || kind === "dissolve") {
      const overlap = Math.max(1, Math.min(size ?? Math.round(room * 0.15), room - 1));
      cursor -= overlap;
      // dissolve ramps the incoming edge in; bleed keeps a hard edge and simply sits on top.
      if (kind === "dissolve") layout.feathers.push({ index, top: overlap, bottom: 0 });
    } else if (kind === "fade") {
      const band = Math.max(1, Math.min(size ?? opts.gap * 2, room - 1));
      // Paint the colour across both faded edges and the space between them, then fade each edge into it.
      layout.bands.push({
        top: cursor - band,
        height: band * 3,
        color: seam?.color ?? opts.background ?? "#ffffff",
      });
      cursor += band;
      layout.feathers.push({ index, top: band, bottom: 0 });
      const previous = layout.feathers.find((f) => f.index === index - 1);
      if (previous) previous.bottom = band;
      else layout.feathers.push({ index: index - 1, top: 0, bottom: band });
      layout.breakable.push(index);
    }
    layout.placements.push({ index, top: cursor });
    cursor += block.height;
    layout.height = Math.max(layout.height, cursor);
  }
  return layout;
}

/**
 * Splits a strip into files no taller than `maxHeight`, cutting only where a seam allows it. A run of blended
 * panels that is itself taller than the limit goes out oversized rather than torn in half.
 */
export function chunkStrip(blocks: StripBlock[], maxHeight: number, opts: { gap: number }): StripBlock[][] {
  if (blocks.length === 0) return [];
  const layout = stripLayout(blocks, opts);
  const breakable = new Set(layout.breakable);
  const chunks: StripBlock[][] = [];
  let start = 0;
  let lastBreak = 0;
  for (let i = 1; i < blocks.length; i++) {
    const startTop = layout.placements[start]!.top;
    const endBottom = layout.placements[i]!.top + blocks[i]!.height;
    if (endBottom - startTop > maxHeight && lastBreak > start) {
      chunks.push(blocks.slice(start, lastBreak).map((b, n) => (n === 0 ? { ...b, seam: null } : b)));
      start = lastBreak;
    }
    if (breakable.has(i)) lastBreak = i;
  }
  chunks.push(blocks.slice(start).map((b, n) => (n === 0 ? { ...b, seam: null } : b)));
  return chunks;
}

/** A vertical alpha ramp for one block's edges, as an SVG mask composited with `dest-in`. */
export function featherMask(width: number, height: number, top: number, bottom: number) {
  const stops: string[] = [];
  if (top > 0) {
    stops.push('<stop offset="0" stop-color="#fff" stop-opacity="0"/>');
    stops.push(`<stop offset="${(top / height).toFixed(4)}" stop-color="#fff" stop-opacity="1"/>`);
  } else {
    stops.push('<stop offset="0" stop-color="#fff" stop-opacity="1"/>');
  }
  if (bottom > 0) {
    stops.push(`<stop offset="${(1 - bottom / height).toFixed(4)}" stop-color="#fff" stop-opacity="1"/>`);
    stops.push('<stop offset="1" stop-color="#fff" stop-opacity="0"/>');
  } else {
    stops.push('<stop offset="1" stop-color="#fff" stop-opacity="1"/>');
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><defs><linearGradient id="f" x1="0" y1="0" x2="0" y2="1">${stops.join("")}</linearGradient></defs><rect width="${width}" height="${height}" fill="url(#f)"/></svg>`;
}
