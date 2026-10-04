import { splitSentences } from "./narration.ts";

/**
 * Deterministic narration checks: what can be found by counting and comparing strings, with no model. The semantic
 * checks (meaning repeated in other words, facts explained again, narration that only describes the frame) are a
 * text job; both produce findings of this shape.
 */
export const RULE_FINDING_KINDS = [
  "repeated_opening",
  "flat_rhythm",
  "name_overuse",
  "near_duplicate",
  "restates_dialogue",
  "chapter_opening",
  "chapter_ending",
  "dense_shot",
  "silent_stretch",
  "pace",
] as const;
export const AI_FINDING_KINDS = [
  "repeated_meaning",
  "cross_chapter_repeat",
  "fact_overexplained",
  "describes_frame",
] as const;
export type NarrationFindingKind = (typeof RULE_FINDING_KINDS)[number] | (typeof AI_FINDING_KINDS)[number];
export type FindingSeverity = "low" | "medium" | "high";

export type LintFinding = {
  kind: NarrationFindingKind;
  severity: FindingSeverity;
  lineIds: string[];
  /** Other chapters the finding points at (an opening shared with chapter 3). */
  relatedChapterIds: string[];
  message: string;
};

export type LintLine = { id: string; text: string; panelId: string | null; untilPanelId?: string | null };
/** A panel (video shot): what is said on it, and what it shows, from its spec, for the semantic lint. */
export type LintShot = { id: string; dialogue: string[]; frame?: string };
export type LintChapter = {
  id: string;
  order: number;
  title: string;
  lines: LintLine[];
  /** The chapter's panels (video shots) in reading order. */
  shots: LintShot[];
  /** Seconds of current narration audio and the words it speaks, when the chapter is voiced. */
  audio?: { ms: number; words: number } | null;
};

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];
const wordCount = (s: string) => words(s).length;
const opener = (s: string, n: number) => words(s).slice(0, n).join(" ");

/** Dice coefficient over word bigrams of the normalised text: 1 for the same words in the same order. */
export function similarity(a: string, b: string) {
  const grams = (s: string) => {
    const w = words(s);
    const out = new Map<string, number>();
    for (let i = 0; i < w.length - 1; i++) out.set(`${w[i]} ${w[i + 1]}`, (out.get(`${w[i]} ${w[i + 1]}`) ?? 0) + 1);
    if (w.length === 1) out.set(w[0]!, 1);
    return out;
  };
  const ga = grams(a);
  const gb = grams(b);
  const total = [...ga.values(), ...gb.values()].reduce((n, v) => n + v, 0);
  if (!total) return 0;
  let shared = 0;
  for (const [g, n] of ga) shared += Math.min(n, gb.get(g) ?? 0);
  return (2 * shared) / total;
}

/** The longest run of words two texts share, in order. */
function sharedRun(a: string, b: string) {
  const wa = words(a);
  const wb = words(b);
  let best = 0;
  const prev = new Array(wb.length + 1).fill(0);
  for (let i = 1; i <= wa.length; i++) {
    let diag = 0;
    for (let j = 1; j <= wb.length; j++) {
      const up = prev[j];
      prev[j] = wa[i - 1] === wb[j - 1] ? diag + 1 : 0;
      best = Math.max(best, prev[j]);
      diag = up;
    }
  }
  return best;
}

type Sentence = { lineId: string; text: string };
const sentencesOf = (lines: LintLine[]): Sentence[] =>
  lines.flatMap((l) => splitSentences(l.text).map((text) => ({ lineId: l.id, text })));
const uniq = (ids: string[]) => [...new Set(ids)];

/** Openers (first two words) used three or more times within five sentences. */
function repeatedOpenings(ss: Sentence[]): LintFinding[] {
  const out: LintFinding[] = [];
  const WINDOW = 5;
  let i = 0;
  while (i < ss.length) {
    const o = opener(ss[i]!.text, 2);
    const hits = [i];
    for (let j = i + 1; j < Math.min(ss.length, i + WINDOW); j++) if (opener(ss[j]!.text, 2) === o) hits.push(j);
    if (o.split(" ").length === 2 && hits.length >= 3) {
      // Extend the run while the opener keeps coming back within the window.
      let last = hits.at(-1)!;
      for (let j = last + 1; j < ss.length && j - last < WINDOW; j++)
        if (opener(ss[j]!.text, 2) === o) {
          hits.push(j);
          last = j;
        }
      out.push({
        kind: "repeated_opening",
        severity: hits.length >= 4 ? "medium" : "low",
        lineIds: uniq(hits.map((h) => ss[h]!.lineId)),
        relatedChapterIds: [],
        message: `${hits.length} sentences close together start with "${o}".`,
      });
      i = last + 1;
    } else i++;
  }
  return out;
}

/** Six or more sentences in a row of nearly the same length: the narration drones. */
function flatRhythm(ss: Sentence[]): LintFinding[] {
  const out: LintFinding[] = [];
  const RUN = 6;
  const lens = ss.map((s) => wordCount(s.text));
  const flat = (from: number, to: number) => {
    const xs = lens.slice(from, to);
    const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length);
    return mean >= 6 && sd / mean < 0.15;
  };
  let i = 0;
  while (i + RUN <= ss.length) {
    if (!flat(i, i + RUN)) {
      i++;
      continue;
    }
    let end = i + RUN;
    while (end < ss.length && flat(i, end + 1)) end++;
    out.push({
      kind: "flat_rhythm",
      severity: "low",
      lineIds: uniq(ss.slice(i, end).map((s) => s.lineId)),
      relatedChapterIds: [],
      message: `${end - i} sentences in a row are all about ${Math.round(lens[i]!)} words long: vary the rhythm.`,
    });
    i = end;
  }
  return out;
}

/** A name said more than three times within five sentences: pronouns would read better. */
function nameOveruse(ss: Sentence[], names: string[]): LintFinding[] {
  const out: LintFinding[] = [];
  const WINDOW = 5;
  const LIMIT = 3;
  for (const name of names) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "gu");
    const counts = ss.map((s) => s.text.match(re)?.length ?? 0);
    let i = 0;
    while (i < ss.length) {
      let n = 0;
      for (let j = i; j < Math.min(ss.length, i + WINDOW); j++) n += counts[j]!;
      if (n > LIMIT) {
        const end = Math.min(ss.length, i + WINDOW);
        out.push({
          kind: "name_overuse",
          severity: n >= LIMIT + 3 ? "medium" : "low",
          lineIds: uniq(
            ss
              .slice(i, end)
              .filter((_, k) => counts[i + k]! > 0)
              .map((s) => s.lineId),
          ),
          relatedChapterIds: [],
          message: `"${name}" is named ${n} times in ${end - i} sentences.`,
        });
        i = end;
      } else i++;
    }
  }
  return out;
}

/** Two lines of the same chapter that say nearly the same words. */
function nearDuplicates(lines: LintLine[]): LintFinding[] {
  const out: LintFinding[] = [];
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i]!;
      const b = lines[j]!;
      if (Math.min(wordCount(a.text), wordCount(b.text)) < 4) continue;
      const s = similarity(a.text, b.text);
      if (s >= 0.7)
        out.push({
          kind: "near_duplicate",
          severity: s >= 0.9 ? "high" : "medium",
          lineIds: [a.id, b.id],
          relatedChapterIds: [],
          message: `Two lines are ${Math.round(s * 100)}% alike.`,
        });
    }
  return out;
}

/** Narration that repeats what the shot's own dialogue already says. */
function restatesDialogue(lines: LintLine[], shots: LintShot[]): LintFinding[] {
  const byShot = new Map(shots.map((s) => [s.id, s.dialogue]));
  const out: LintFinding[] = [];
  for (const l of lines) {
    for (const d of (l.panelId && byShot.get(l.panelId)) || []) {
      // The same run of words, or most of the dialogue's content words said again in another order.
      const content = [...new Set(words(d).filter((w) => w.length > 3))];
      const said = new Set(words(l.text));
      const contained = content.filter((w) => said.has(w)).length;
      if (sharedRun(l.text, d) >= 5 || (content.length >= 4 && contained / content.length >= 0.75)) {
        out.push({
          kind: "restates_dialogue",
          severity: "medium",
          lineIds: [l.id],
          relatedChapterIds: [],
          message: `Repeats the panel's dialogue: "${d.slice(0, 80)}".`,
        });
        break;
      }
    }
  }
  return out;
}

/** Shot-by-shot words, and what the video spends on each, for the density view and its findings. */
export function narrationDensity(c: Pick<LintChapter, "lines" | "shots" | "audio">) {
  const index = new Map(c.shots.map((s, i) => [s.id, i]));
  const perShot = c.shots.map(() => ({ words: 0, lineIds: [] as string[], covered: false }));
  let unplaced = 0;
  for (const l of c.lines) {
    const at = l.panelId ? index.get(l.panelId) : undefined;
    if (at === undefined) {
      unplaced += wordCount(l.text);
      continue;
    }
    perShot[at]!.words += wordCount(l.text);
    perShot[at]!.lineIds.push(l.id);
    // A line stretched over several shots keeps all of them from being silent.
    const until = l.untilPanelId ? index.get(l.untilPanelId) : undefined;
    for (let k = at; k <= (until ?? at); k++) perShot[k]!.covered = true;
  }
  const total = c.lines.reduce((n, l) => n + wordCount(l.text), 0);
  return {
    shots: c.shots.map((s, i) => ({ id: s.id, ...perShot[i]! })),
    totals: {
      words: total,
      shots: c.shots.length,
      silentShots: perShot.filter((s) => !s.covered).length,
      unplacedWords: unplaced,
      wordsPerShot: c.shots.length ? total / c.shots.length : 0,
      audioMs: c.audio?.ms ?? null,
      wordsPerMinute: c.audio?.ms ? Math.round((c.audio.words / c.audio.ms) * 60_000) : null,
    },
  };
}

function densityFindings(c: LintChapter, o: { wordsPerShot: number; wordsPerMinute: number }): LintFinding[] {
  const d = narrationDensity(c);
  const out: LintFinding[] = [];
  for (const s of d.shots)
    if (s.words > Math.max(o.wordsPerShot * 2, o.wordsPerShot + 15))
      out.push({
        kind: "dense_shot",
        severity: s.words > o.wordsPerShot * 3 ? "medium" : "low",
        lineIds: s.lineIds,
        relatedChapterIds: [],
        message: `${s.words} words on one shot (target about ${o.wordsPerShot}): the shot holds long or the words rush.`,
      });
  // Three or more shots in a row with nothing said.
  let run: number[] = [];
  const flush = () => {
    if (run.length >= 3) {
      const before = d.shots[run[0]! - 1]?.lineIds.at(-1);
      const after = d.shots[run.at(-1)! + 1]?.lineIds[0];
      out.push({
        kind: "silent_stretch",
        severity: run.length >= 6 ? "medium" : "low",
        lineIds: [before, after].filter((x): x is string => Boolean(x)),
        relatedChapterIds: [],
        message: `${run.length} shots in a row (shots ${run[0]! + 1}–${run.at(-1)! + 1}) have no narration.`,
      });
    }
    run = [];
  };
  d.shots.forEach((s, i) => {
    if (s.covered) flush();
    else run.push(i);
  });
  flush();
  const wpm = d.totals.wordsPerMinute;
  if (wpm && Math.abs(wpm - o.wordsPerMinute) > o.wordsPerMinute * 0.25)
    out.push({
      kind: "pace",
      severity: "low",
      lineIds: [],
      relatedChapterIds: [],
      message: `The voiced narration runs at ${wpm} words a minute against a target of ${o.wordsPerMinute}.`,
    });
  return out;
}

/** The chapter's first (or last) line against every other chapter's: the same opener or nearly the same words. */
function chapterEdges(c: LintChapter, others: LintChapter[], edge: "opening" | "ending"): LintFinding[] {
  const pick = (ch: LintChapter) => (edge === "opening" ? ch.lines[0] : ch.lines.at(-1));
  const mine = pick(c);
  if (!mine || wordCount(mine.text) < 3) return [];
  const key = (t: string) => (edge === "opening" ? opener(t, 3) : words(t).slice(-3).join(" "));
  const like = others.filter((o) => {
    const theirs = pick(o);
    if (!theirs || wordCount(theirs.text) < 3) return false;
    return key(theirs.text) === key(mine.text) || similarity(theirs.text, mine.text) >= 0.6;
  });
  if (!like.length) return [];
  return [
    {
      kind: edge === "opening" ? "chapter_opening" : "chapter_ending",
      severity: like.length >= 2 ? "medium" : "low",
      lineIds: [mine.id],
      relatedChapterIds: like.map((o) => o.id),
      message: `The chapter ${edge === "opening" ? "opens" : "ends"} like ${like.map((o) => `chapter ${o.order}`).join(", ")}.`,
    },
  ];
}

/**
 * Every deterministic check for one chapter. `others` are the project's other chapters (for repeated openings and
 * endings); `names` the cast names to count.
 */
export function lintNarrationRules(
  c: LintChapter,
  others: LintChapter[],
  o: { names: string[]; wordsPerShot: number; wordsPerMinute: number },
): LintFinding[] {
  const ss = sentencesOf(c.lines);
  return [
    ...repeatedOpenings(ss),
    ...flatRhythm(ss),
    ...nameOveruse(
      ss,
      o.names.filter((n) => n.trim().length > 1),
    ),
    ...nearDuplicates(c.lines),
    ...restatesDialogue(c.lines, c.shots),
    ...chapterEdges(c, others, "opening"),
    ...chapterEdges(c, others, "ending"),
    ...densityFindings(c, o),
  ];
}

/** Identity of a finding across runs: an ignored finding stays ignored while the same lines show the same problem. */
export const findingKey = (f: Pick<LintFinding, "kind" | "lineIds" | "relatedChapterIds">) =>
  `${f.kind}|${[...f.lineIds].sort().join(",")}|${[...f.relatedChapterIds].sort().join(",")}`;
