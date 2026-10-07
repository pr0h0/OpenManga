/**
 * Print workflow: trim sizes, the order of an interior's pages (table of contents, blank versos so chapters open on
 * a recto), and the wraparound cover's geometry with the checks a printer would bounce it for. Pure, so the API
 * reports the cover's problems before anything is rendered and the worker draws exactly the layout reported.
 *
 * Numbers follow Amazon KDP's published paperback specification, the usual reference for print-on-demand manga.
 */

import { measureText, wrapText } from "./text.ts";

/** Page sizes in points (1/72 in) that are not KDP trims: printed at this size, with bleed added outside. */
export const PAGE_SIZES_PT: Record<string, [number, number]> = {
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  B5: [498.9, 708.66],
  letter: [612, 792],
  tankobon: [362.83, 515.91],
};
/** Amazon KDP trim sizes in inches. Printed with bleed: the page is 0.125" wider and 0.25" taller than the trim. */
export const KDP_TRIM_IN: Record<string, [number, number]> = {
  kdp_5x8: [5, 8],
  kdp_5_5x8_5: [5.5, 8.5],
  kdp_6x9: [6, 9],
  kdp_7x10: [7, 10],
  kdp_8_5x11: [8.5, 11],
};

/** The trim (the finished page) in inches for a PDF page size, or null for "source" (the page's own pixels). */
export function trimSizeIn(pageSize: string): [number, number] | null {
  const kdp = KDP_TRIM_IN[pageSize];
  if (kdp) return kdp;
  const pt = PAGE_SIZES_PT[pageSize];
  return pt ? [pt[0] / 72, pt[1] / 72] : null;
}

export type PaperType = "white" | "cream" | "color";
/** KDP's paper thickness per page in inches: the spine is the page count times this. */
export const PAPER_IN_PER_PAGE: Record<PaperType, number> = { white: 0.002252, cream: 0.0025, color: 0.002347 };
export const PRINT_SPEC = {
  bleedIn: 0.125,
  /** Cover text keeps this far inside the trim. */
  coverSafeIn: 0.125,
  /** KDP prints no spine text on books under this many pages. */
  spineTextMinPages: 79,
  /** Spine text keeps this far from each fold. */
  spineMarginIn: 0.0625,
  minPages: 24,
  maxPages: { white: 828, cream: 776, color: 828 } as Record<PaperType, number>,
  /** Where KDP prints the barcode on the back: this box, this far from the spine fold and the bottom trim. */
  barcode: { widthIn: 2, heightIn: 1.2, marginIn: 0.25 },
  /** Art below this is soft at print size. */
  minDpi: 300,
  /** Total ink (C+M+Y+K) most presses cap a page at. */
  inkLimitPct: 300,
  /** Interior lettering keeps this far inside the trim on a KDP book's top, bottom and outside edges. */
  interiorSafeIn: 0.25,
  /** Other page sizes: 5 mm inside the trim on every edge. */
  genericSafeIn: 5 / 25.4,
};

/** KDP's minimum inside (gutter) margin for a page count. */
export function gutterIn(pageCount: number) {
  if (pageCount <= 150) return 0.375;
  if (pageCount <= 300) return 0.5;
  if (pageCount <= 500) return 0.625;
  if (pageCount <= 700) return 0.75;
  return 0.875;
}

export function spineWidthIn(pageCount: number, paper: PaperType, paperThicknessMm?: number) {
  const perPage = paperThicknessMm ? paperThicknessMm / 25.4 : PAPER_IN_PER_PAGE[paper];
  return pageCount * perPage;
}

export type PrintIssue = {
  code:
    | "no_cover_art"
    | "art_low_dpi"
    | "spine_no_text"
    | "spine_text_small"
    | "spine_text_cut"
    | "title_cut"
    | "back_text_cut"
    | "page_count_low"
    | "page_count_high"
    | "text_outside_safe"
    // Interior preflight
    | "low_dpi"
    | "ink_over_limit"
    | "odd_page_count"
    | "font_missing"
    | "fonts_rasterized";
  /** "block" stops a cover from rendering; "warn" ships but should be fixed; "info" is how it will be printed. */
  severity: "block" | "warn" | "info";
  message: string;
};

// ---------------------------------------------------------------- interior

export type InteriorEntry =
  | { kind: "cover" }
  | { kind: "toc" }
  | { kind: "blank" }
  | { kind: "page"; pageId: string; chapterId: string };

/**
 * The PDF's pages in order: an optional cover, an optional contents page, then each chapter, with a blank page
 * before any chapter that would otherwise open on a verso (left-hand, even) page. Page numbers are 1-based PDF pages.
 */
export function interiorSequence(
  chapters: { id: string; title: string; order: number; pageIds: string[] }[],
  o: { cover: boolean; toc: boolean; rectoChapters: boolean },
) {
  const entries: InteriorEntry[] = [];
  if (o.cover) entries.push({ kind: "cover" });
  if (o.toc) entries.push({ kind: "toc" });
  const toc: { order: number; title: string; page: number }[] = [];
  for (const ch of chapters) {
    if (!ch.pageIds.length) continue;
    // A recto is an odd page: the chapter's first page would be page entries.length + 1.
    if (o.rectoChapters && entries.length % 2 === 1) entries.push({ kind: "blank" });
    toc.push({ order: ch.order, title: ch.title, page: entries.length + 1 });
    for (const pageId of ch.pageIds) entries.push({ kind: "page", pageId, chapterId: ch.id });
  }
  return { entries, toc };
}

/** Where a lettering box sits on a printed page, in points from the bottom-left like the PDF it is drawn into. */
type PtBox = { x: number; y: number; width: number; height: number };

/**
 * The lettering (normalised page boxes) that falls outside the printed page's safe area: inside the trim by the
 * safe margin, with KDP's wider gutter on the binding side. `index` is the 0-based PDF page, so even indexes are
 * rectos, bound on their left (on their right in a right-to-left book).
 */
export function outsideSafeZone<T extends { x: number; y: number; width: number; height: number }>(
  boxes: T[],
  place: { image: PtBox; trim: PtBox; kdp: boolean; pageCount: number; index: number; rtl: boolean },
): T[] {
  const edge = (place.kdp ? PRINT_SPEC.interiorSafeIn : PRINT_SPEC.genericSafeIn) * 72;
  const gutter = place.kdp ? Math.max(edge, gutterIn(place.pageCount) * 72) : edge;
  const recto = place.index % 2 === 0;
  const bindLeft = recto !== place.rtl;
  const t = place.trim;
  const safe = {
    left: t.x + (bindLeft ? gutter : edge),
    right: t.x + t.width - (bindLeft ? edge : gutter),
    bottom: t.y + edge,
    top: t.y + t.height - edge,
  };
  const im = place.image;
  return boxes.filter((b) => {
    const left = im.x + b.x * im.width;
    const right = im.x + (b.x + b.width) * im.width;
    // Page boxes run from the top; PDF points from the bottom.
    const top = im.y + im.height - b.y * im.height;
    const bottom = im.y + im.height - (b.y + b.height) * im.height;
    const tol = 0.5;
    return left < safe.left - tol || right > safe.right + tol || bottom < safe.bottom - tol || top > safe.top + tol;
  });
}

// ---------------------------------------------------------------- cover

/** A box in inches from the top-left corner of the whole cover sheet (bleed included). */
export type InBox = { x: number; y: number; width: number; height: number };
/** A block of text: baseline of the first line at (x, y) in inches, lines `lineIn` apart, rotated about (x, y). */
export type TextBlock = {
  role: "title" | "author" | "spine" | "back";
  lines: string[];
  sizePt: number;
  lineIn: number;
  x: number;
  y: number;
  anchor: "start" | "middle";
  rotate: 0 | 90;
  weight: 400 | 700 | 900;
};

export type CoverInput = {
  trimIn: [number, number];
  pageCount: number;
  paper: PaperType;
  paperThicknessMm?: number;
  /** The front art's pixel size; null when the project has no cover art. */
  art: { width: number; height: number } | null;
  title: string;
  author: string;
  description: string;
  /** A right-to-left book is bound on the right: laid flat, its front is the left panel and its back the right. */
  rtl?: boolean;
};

const inset = (b: InBox, dx: number, dy = dx): InBox => ({
  x: b.x + dx,
  y: b.y + dy,
  width: Math.max(0, b.width - 2 * dx),
  height: Math.max(0, b.height - 2 * dy),
});

/**
 * Points of cover text per inch of room. `measureText` is tuned to the lettering faces; covers are set in DejaVu Sans,
 * which runs about 15% wider, so cover text is laid out against widths shrunk by that much. The worker still measures
 * the drawn text against the safe areas.
 */
const FACE_PT = 72 / 1.15;

/** Lines at the largest size from `max` down to `min` that fit `maxLines` lines of `widthPt`; cut with … at `min`. */
function fitLines(text: string, widthPt: number, maxLines: number, max: number, min: number) {
  for (let size = max; ; size = Math.max(min, size * 0.92)) {
    const lines = wrapText(text, widthPt, size);
    if (lines.length <= maxLines) return { lines, size, cut: false };
    if (size <= min) break;
  }
  const lines = wrapText(text, widthPt, min).slice(0, maxLines);
  return { lines: ellipsize(lines, widthPt, min), size: min, cut: true };
}

/** Shortens the last line until it fits `widthPt` with an ellipsis. */
function ellipsize(lines: string[], widthPt: number, size: number) {
  const out = [...lines];
  let last = out.pop() ?? "";
  while (last && measureText(`${last}…`, size) > widthPt) last = last.slice(0, -1);
  out.push(`${last.trimEnd()}…`);
  return out;
}

/**
 * The wraparound cover (back, spine, front, with bleed) for a page count and paper: its size, the panels and safe
 * areas, where the barcode goes, the text laid out inside the safe areas, and what a printer would flag. The front
 * holds the cover art with the title and author, the spine the title (and author when there is room) when the book
 * is thick enough for spine text, and the back the description above the barcode. A right-to-left book mirrors
 * the panels; its barcode stays at the bottom of the back, next to the spine.
 */
export function coverLayout(c: CoverInput) {
  const b = PRINT_SPEC.bleedIn;
  const [tw, th] = c.trimIn;
  const spine = spineWidthIn(c.pageCount, c.paper, c.paperThicknessMm);
  const width = 2 * b + 2 * tw + spine;
  const height = th + 2 * b;
  const left: InBox = { x: b, y: b, width: tw, height: th };
  const spineBox: InBox = { x: b + tw, y: b, width: spine, height: th };
  const right: InBox = { x: b + tw + spine, y: b, width: tw, height: th };
  const [back, front] = c.rtl ? [right, left] : [left, right];
  const m = PRINT_SPEC.coverSafeIn;
  const safe = {
    back: inset(back, m),
    front: inset(front, m),
    spine: inset(spineBox, PRINT_SPEC.spineMarginIn, m),
  };
  const bc = PRINT_SPEC.barcode;
  const barcode: InBox = {
    x: c.rtl ? back.x + bc.marginIn : back.x + back.width - bc.marginIn - bc.widthIn,
    y: back.y + back.height - bc.marginIn - bc.heightIn,
    width: bc.widthIn,
    height: bc.heightIn,
  };
  /** The front art's box: the front panel and its bleed on the outside, top and bottom. */
  const frontArt: InBox = { x: c.rtl ? 0 : front.x, y: 0, width: tw + b, height };
  const issues: PrintIssue[] = [];
  const issue = (code: PrintIssue["code"], severity: PrintIssue["severity"], message: string) =>
    issues.push({ code, severity, message });

  if (c.pageCount < PRINT_SPEC.minPages)
    issue(
      "page_count_low",
      "warn",
      `${c.pageCount} pages: KDP prints paperbacks of ${PRINT_SPEC.minPages} pages or more.`,
    );
  if (c.pageCount > PRINT_SPEC.maxPages[c.paper])
    issue(
      "page_count_high",
      "warn",
      `${c.pageCount} pages: KDP prints at most ${PRINT_SPEC.maxPages[c.paper]} on ${c.paper} paper.`,
    );

  let artDpi: number | null = null;
  if (!c.art) issue("no_cover_art", "block", "The front needs cover art. Generate or upload the project cover first.");
  else {
    // Cover-fit: the art fills the front with bleed, cropping the overflow, so the short side decides.
    artDpi = Math.round(Math.min(c.art.width / frontArt.width, c.art.height / frontArt.height));
    if (artDpi < PRINT_SPEC.minDpi)
      issue(
        "art_low_dpi",
        "warn",
        `The cover art is ${artDpi} DPI at print size (${PRINT_SPEC.minDpi} recommended) and will print soft. Use art of at least ${Math.ceil(frontArt.width * PRINT_SPEC.minDpi)} × ${Math.ceil(frontArt.height * PRINT_SPEC.minDpi)} px.`,
      );
  }

  const text: TextBlock[] = [];
  const fs = safe.front;
  const title = c.title.trim();
  if (title) {
    const t = fitLines(title, fs.width * FACE_PT, 3, Math.round(tw * 72 * 0.11), 14);
    if (t.cut) issue("title_cut", "warn", "The title is too long for the front at 14 pt and was shortened.");
    text.push({
      role: "title",
      lines: t.lines,
      sizePt: t.size,
      lineIn: (t.size * 1.15) / 72,
      x: fs.x + fs.width / 2,
      y: fs.y + 0.15 + (t.size * 0.85) / 72,
      anchor: "middle",
      rotate: 0,
      weight: 900,
    });
  }
  const author = c.author.trim();
  if (author) {
    const a = fitLines(author, fs.width * FACE_PT, 1, Math.max(10, Math.round(tw * 72 * 0.045)), 8);
    text.push({
      role: "author",
      lines: a.lines,
      sizePt: a.size,
      lineIn: (a.size * 1.2) / 72,
      x: fs.x + fs.width / 2,
      y: fs.y + fs.height - 0.15,
      anchor: "middle",
      rotate: 0,
      weight: 700,
    });
  }

  const spineSafe = safe.spine;
  if (c.pageCount < PRINT_SPEC.spineTextMinPages)
    issue(
      "spine_no_text",
      "info",
      `Under ${PRINT_SPEC.spineTextMinPages} pages KDP allows no spine text, so the spine is left plain.`,
    );
  else if (title) {
    // Glyphs from cap height to descender, with their outline, take about 1.1 em across the spine.
    const size = Math.min(24, (spineSafe.width * 72) / 1.1);
    const length = spineSafe.height * FACE_PT;
    const both = author ? `${title}  ·  ${author}` : title;
    const label = measureText(both, size) <= length ? both : title;
    if (size < 5)
      issue(
        "spine_text_small",
        "warn",
        `The spine is ${spine.toFixed(3)}" wide: its text would be ${size.toFixed(1)} pt, too small to read, so the spine is left plain.`,
      );
    else {
      const fitted = fitLines(label, length, 1, size, Math.min(size, 5));
      if (fitted.cut) issue("spine_text_cut", "warn", "The title is too long for the spine and was shortened.");
      text.push({
        role: "spine",
        lines: fitted.lines,
        sizePt: fitted.size,
        lineIn: fitted.size / 72,
        // Rotated 90° clockwise about its own origin, it reads top to bottom with its cap height towards the front:
        // the baseline sits a quarter em behind the spine's centre line so the glyphs are centred on it.
        x: spineSafe.x + spineSafe.width / 2 - (fitted.size * 0.25) / 72,
        y: spineSafe.y + spineSafe.height / 2,
        anchor: "middle",
        rotate: 90,
        weight: 700,
      });
    }
  }

  const description = c.description.trim();
  if (description) {
    const bs = safe.back;
    // Above the barcode with a little air, the rest of the back's safe area.
    const area = { ...bs, height: barcode.y - 0.15 - bs.y };
    const fit = (size: number) => Math.floor((area.height * 72 - size * 0.3) / (size * 1.35));
    let size = 11;
    let lines = wrapText(description, area.width * FACE_PT, size);
    while (lines.length > fit(size) && size > 8) {
      size -= 0.5;
      lines = wrapText(description, area.width * FACE_PT, size);
    }
    if (lines.length > fit(size)) {
      lines = ellipsize(lines.slice(0, Math.max(1, fit(size))), area.width * FACE_PT, size);
      issue("back_text_cut", "warn", "The description is too long for the back cover at 8 pt and was shortened.");
    }
    text.push({
      role: "back",
      lines,
      sizePt: size,
      lineIn: (size * 1.35) / 72,
      x: area.x,
      y: area.y + (size * 0.9) / 72,
      anchor: "start",
      rotate: 0,
      weight: 400,
    });
  }

  return {
    widthIn: width,
    heightIn: height,
    bleedIn: b,
    spineIn: spine,
    panels: { back, spine: spineBox, front },
    frontArt,
    safe,
    barcode,
    artDpi,
    text,
    issues,
  };
}
export type CoverLayout = ReturnType<typeof coverLayout>;
