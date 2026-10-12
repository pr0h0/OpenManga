/** Accessibility: alt text from what a panel holds, and the checks that need no AI. */

/**
 * A panel's description for readers who cannot see it: the moment it shows (its story beat), then what is said in it
 * and the sound effects, in reading order. Built from the panel's own data, so it is there before anyone writes one.
 */
export function panelAltText(p: { beat: string; dialogue: { speaker: string | null; text: string }[]; sfx: string[] }) {
  const parts = [p.beat.trim().replace(/\s+/g, " ")];
  for (const d of p.dialogue) {
    const text = d.text.trim().replace(/\s+/g, " ");
    if (text) parts.push(d.speaker ? `${d.speaker}: “${text}”` : `“${text}”`);
  }
  if (p.sfx.length) parts.push(`Sound: ${p.sfx.join(", ")}.`);
  return parts
    .filter(Boolean)
    .map((s) => (/[.!?…”"]$/.test(s) ? s : `${s}.`))
    .join(" ");
}

const hex = (c: string) => {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1]!.length === 3 ? [...m[1]!].map((x) => x + x).join("") : m[1]!;
  return [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
};
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
};

/** The WCAG contrast ratio of two hex colours (1 to 21), or null when either is not a plain hex colour. */
export function contrastRatio(a: string, b: string) {
  const x = hex(a);
  const y = hex(b);
  if (!x || !y) return null;
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p);
  return Math.round(((hi! + 0.05) / (lo! + 0.05)) * 100) / 100;
}

/** WCAG AA for normal text. */
export const MIN_CONTRAST = 4.5;
/**
 * Smallest lettering as a share of the page width: about 7 pt on a 6-inch printed page for comic pages, about 11 px
 * on a phone 390 px wide for strips (read at the strip's full width), 2% of the frame for film.
 */
export const MIN_TEXT_SHARE = { comic: 0.016, vertical: 0.028, film: 0.02 } as const;

export type LetteringIssue = {
  kind: "contrast" | "size";
  lineId: string;
  text: string;
  /** contrast: the ratio; size: the share of the page width the text is. */
  value: number;
  limit: number;
};

/** Lettering too faint against its bubble, or too small to read at the size the format is read at. */
export function letteringIssues(
  lines: { id: string; text: string; bubble: { fontSize: number; textColor: string; background: string } }[],
  pageWidth: number,
  format: keyof typeof MIN_TEXT_SHARE,
): LetteringIssue[] {
  const out: LetteringIssue[] = [];
  for (const l of lines) {
    const ratio = contrastRatio(l.bubble.textColor, l.bubble.background);
    if (ratio !== null && ratio < MIN_CONTRAST)
      out.push({ kind: "contrast", lineId: l.id, text: l.text, value: ratio, limit: MIN_CONTRAST });
    const share = l.bubble.fontSize / pageWidth;
    if (share < MIN_TEXT_SHARE[format])
      out.push({
        kind: "size",
        lineId: l.id,
        text: l.text,
        value: Math.round(share * 10_000) / 10_000,
        limit: MIN_TEXT_SHARE[format],
      });
  }
  return out;
}

type Frame = { x: number; y: number; width: number; height: number };

/**
 * The order a reader takes a page's panels in from where they sit: rows top to bottom (a panel starts a new row when
 * it begins below the middle of the row so far), each row left to right, or right to left for a right-to-left book.
 */
export function expectedReadingOrder<T extends { id: string; frame: Frame }>(panels: T[], rtl: boolean): string[] {
  const sorted = [...panels].sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
  const rows: T[][] = [];
  for (const p of sorted) {
    const row = rows.at(-1);
    const middle = row ? Math.min(...row.map((r) => r.frame.y + r.frame.height / 2)) : -1;
    if (row && p.frame.y < middle) row.push(p);
    else rows.push([p]);
  }
  return rows.flatMap((row) =>
    row.sort((a, b) => (rtl ? b.frame.x - a.frame.x : a.frame.x - b.frame.x)).map((p) => p.id),
  );
}
