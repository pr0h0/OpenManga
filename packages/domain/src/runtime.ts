/** A project's target video length and the pace it is narrated at. */
export type RuntimeTarget = { minutes: number; wordsPerMinute: number; minShotSeconds: number; maxShotSeconds: number };

/** Panels a comic page averages, for turning a shot budget into a page target. */
const PANELS_PER_COMIC_PAGE = 3.5;
/** The page target a chapter plan accepts. */
const MAX_PLAN_PAGES = 60;

/**
 * Split a runtime into per-chapter budgets, in proportion to each chapter's source length: narration words, shots
 * (one per panel) at the middle of the allowed shot length, and the page target a chapter plan is asked for.
 */
export function runtimeBudget(
  t: RuntimeTarget,
  chapters: { id: string; sourceChars: number }[],
  format: "comic" | "film" | "vertical",
) {
  const totalWords = t.minutes * t.wordsPerMinute;
  const weight = chapters.reduce((s, c) => s + Math.max(1, c.sourceChars), 0);
  const avgShotSec = (t.minShotSeconds + t.maxShotSeconds) / 2;
  return {
    totalWords,
    chapters: chapters.map((c) => {
      const words = Math.round((totalWords * Math.max(1, c.sourceChars)) / weight);
      const shots = Math.max(1, Math.round(words / (t.wordsPerMinute / 60) / avgShotSec));
      const pages = format === "comic" ? Math.ceil(shots / PANELS_PER_COMIC_PAGE) : shots;
      // More shots than one plan holds: the chapter will come out short unless it is split or shots run longer.
      const capped = pages > MAX_PLAN_PAGES;
      return { id: c.id, words, shots, pages: Math.min(MAX_PLAN_PAGES, Math.max(1, pages)), capped };
    }),
  };
}

/** Shots one chapter plan can hold: a film or strip page is one shot, a comic page about 3.5 panels. */
export const planShotCapacity = (format: "comic" | "film" | "vertical") =>
  format === "comic" ? Math.floor(MAX_PLAN_PAGES * PANELS_PER_COMIC_PAGE) : MAX_PLAN_PAGES;

/**
 * How many chapters a runtime needs so that no chapter's share is more than a plan can hold (with some room to
 * spare, since chapters are split at story breaks, not evenly). Null when one chapter is enough.
 */
export function chaptersForRuntime(t: RuntimeTarget, format: "comic" | "film" | "vertical") {
  const shots = (t.minutes * 60) / ((t.minShotSeconds + t.maxShotSeconds) / 2);
  const n = Math.ceil(shots / (planShotCapacity(format) * 0.8));
  return n > 1 ? n : null;
}

/** Words per panel that land a chapter on its word budget, kept within the shot-length bounds. */
export function wordsPerPanelFor(t: RuntimeTarget, chapterWords: number, panels: number) {
  const lo = Math.ceil((t.wordsPerMinute * t.minShotSeconds) / 60);
  const hi = Math.floor((t.wordsPerMinute * t.maxShotSeconds) / 60);
  const want = panels > 0 ? Math.round(chapterWords / panels) : lo;
  return Math.min(80, Math.max(5, Math.min(hi, Math.max(lo, want))));
}
