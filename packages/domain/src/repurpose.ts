/**
 * Repurposing one finished project: several Shorts from distinct parts of the story, a trailer and a teaser, an
 * Instagram carousel and quote images. Pure picks over the same candidates as the Shorts picker, so a plan is
 * reviewed and changed before anything is rendered.
 */

import { lineDrama, pickShorts, type ShortsCandidate, shortsScore } from "./video.ts";

/** What each kind of item aims for: its length (video) or count (images) and its default frame. */
export const REPURPOSE_PRESETS = {
  short: { minMs: 30_000, targetMs: 45_000, maxMs: 60_000, aspect: "9:16" },
  trailer: { minMs: 60_000, targetMs: 75_000, maxMs: 90_000, aspect: "16:9" },
  teaser: { minMs: 15_000, targetMs: 25_000, maxMs: 30_000, aspect: "9:16" },
} as const;
export const CAROUSEL_SLIDES = 10;

/**
 * `count` Shorts that never share a shot: the story is cut into `count` contiguous parts (by the candidates' story
 * order) and each Short is picked inside its own part, so they are different moments rather than one scene several
 * times. A part too thin to fill a Short gives what it has; an empty one gives nothing.
 */
export function pickShortsSet(
  cands: ShortsCandidate[],
  count: number,
  o: { targetMs: number; minMs: number; maxMs: number },
) {
  const out: string[][] = [];
  for (let k = 0; k < count; k++) {
    const part = cands.slice(Math.floor((k * cands.length) / count), Math.floor(((k + 1) * cands.length) / count));
    const ids = pickShorts(part, o);
    if (ids.length) out.push(ids);
  }
  return out;
}

/** `n` panels with art for a carousel, the strongest of each stretch of the story, in story order. */
export function pickCarousel(cands: ShortsCandidate[], n = CAROUSEL_SLIDES) {
  // Every slide counts the same: a uniform "length" turns the Shorts picker into one-best-per-stretch.
  const even = cands.map((c) => ({ ...c, holdMs: 1000 }));
  return pickShorts(even, { targetMs: n * 1000, minMs: n * 1000, maxMs: n * 1000 });
}

/** The most quotable sentence of a text: dramatic, and short enough to read on an image. */
export function bestSentence(text: string, maxChars = 160) {
  const sentences = (text.match(/[^.!?…]+[.!?…]+["”’]?|[^.!?…]+$/g) ?? [])
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= maxChars);
  return sentences.sort((a, b) => lineDrama(b) - lineDrama(a))[0] ?? null;
}

/**
 * `n` quotes from distinct parts of the story: per stretch, the panel with art whose narration or dialogue has the
 * most quotable sentence, the text being that sentence.
 */
export function pickQuotes(cands: (ShortsCandidate & { quotes: string[] })[], n = 3) {
  const usable = cands
    .filter((c) => c.hasArt)
    .flatMap((c, i) =>
      c.quotes.flatMap((t) => {
        const s = bestSentence(t);
        return s ? [{ panelId: c.id, text: s, i, score: lineDrama(s) + shortsScore(c) / 2 }] : [];
      }),
    );
  const out: { panelId: string; text: string }[] = [];
  for (let k = 0; k < n; k++) {
    const part = usable.slice(Math.floor((k * usable.length) / n), Math.floor(((k + 1) * usable.length) / n));
    const best = part.reduce<(typeof part)[number] | null>((a, x) => (!a || x.score > a.score ? x : a), null);
    if (best && !out.some((q) => q.panelId === best.panelId)) out.push({ panelId: best.panelId, text: best.text });
  }
  return out;
}

/** Pixel size of a still image: 1080 wide, square or Instagram's 4:5 portrait. */
export const stillSize = (aspect: "1:1" | "4:5") => ({ width: 1080, height: aspect === "4:5" ? 1350 : 1080 });
