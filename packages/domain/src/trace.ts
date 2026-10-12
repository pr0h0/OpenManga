/**
 * Source traceability: which part of a chapter's text each panel tells. Deterministic, no AI: panels are aligned to
 * the chapter's sentences in reading order (a panel never comes from earlier text than the panel before it), scored by
 * shared words weighted by rarity, with a panel's dialogue found verbatim as a strong anchor. Every sentence ends up
 * with a panel: a panel's span runs from its sentence up to the next panel's.
 */

export type SourceSpan = { start: number; end: number; text: string };
export type TracePanel = { beat: string; dialogue?: string[] };

/**
 * Sentences of `text` with exact offsets. A sentence ends at end punctuation followed by a capital or an opening quote
 * (so `"Who?" she asked.` stays one), and at every line break.
 */
export function sentenceSpans(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    // A lone closing quote or bracket is not a sentence.
    if (/[\p{L}\p{N}]/u.test(body)) out.push({ start: from + lead, end: from + lead + body.length });
  };
  let at = 0;
  for (const m of text.matchAll(/(?<=[.!?。！？…]["'”’»)\]]*)\s+(?=[\p{Lu}\p{Lo}"'“‘«([])|\n+/gu)) {
    push(at, m.index);
    at = m.index + m[0].length;
  }
  push(at, text.length);
  return out;
}

const stem = (w: string) => (w.length > 4 ? w.replace(/(?:ing|ed|es|s)$/u, "") : w);
const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).map(stem);
const squash = (s: string) => words(s).join(" ");

/** Aligns panels (in reading order) to the chapter text; returns one span per panel, or nothing when there is no text. */
export function traceSpans(text: string, panels: TracePanel[]): (SourceSpan | null)[] {
  const sents = sentenceSpans(text);
  const n = panels.length;
  const m = sents.length;
  if (!m || !n) return panels.map(() => null);
  const sentWords = sents.map((s) => new Set(words(text.slice(s.start, s.end))));
  const sentFlat = sents.map((s) => squash(text.slice(s.start, s.end)));
  const df = new Map<string, number>();
  for (const ws of sentWords) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
  const idf = (w: string) => Math.log((m + 1) / ((df.get(w) ?? 0) + 0.5));

  const prepared = panels.map((p) => {
    const own = [...new Set(words([p.beat, ...(p.dialogue ?? [])].join(" ")))].map((w) => [w, idf(w)] as const);
    return {
      own,
      total: own.reduce((a, [, v]) => a + v, 0),
      quotes: (p.dialogue ?? []).map(squash).filter((q) => q.length >= 12),
    };
  });
  const score = (i: number, j: number) => {
    const p = prepared[i]!;
    let hit = 0;
    for (const [w, v] of p.own) if (sentWords[j]!.has(w)) hit += v;
    let s = p.total ? hit / p.total : 0;
    for (const q of p.quotes) if (sentFlat[j]!.includes(q)) s += 1;
    return s;
  };

  // best[i][j]: the best total with panel i on sentence j and every earlier panel on sentence j or before.
  // A small pull towards the proportional position decides between sentences that score alike.
  const pos = (i: number, j: number) => 0.15 * (1 - Math.abs(i / Math.max(1, n - 1) - j / Math.max(1, m - 1)));
  const from = Array.from({ length: n }, () => new Int32Array(m));
  let prev = new Float64Array(m);
  for (let i = 0; i < n; i++) {
    const cur = new Float64Array(m);
    let runMax = Number.NEGATIVE_INFINITY;
    let runArg = 0;
    for (let j = 0; j < m; j++) {
      if (i > 0 && prev[j]! > runMax) {
        runMax = prev[j]!;
        runArg = j;
      }
      cur[j] = score(i, j) + pos(i, j) + (i > 0 ? runMax : 0);
      from[i]![j] = runArg;
    }
    prev = cur;
  }
  const anchor = new Array<number>(n);
  let j = 0;
  for (let k = 1; k < m; k++) if (prev[k]! > prev[j]!) j = k;
  for (let i = n - 1; i >= 0; i--) {
    anchor[i] = j;
    j = from[i]![j]!;
  }

  // The sentences between two anchors go to whichever of the two panels they read more like, split at one point.
  const firstOf = anchor.map((a, i) => (i === 0 ? 0 : a));
  for (let i = 0; i + 1 < n; i++) {
    const [a, b] = [anchor[i]!, anchor[i + 1]!];
    if (b - a < 2) continue;
    let best = b;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (let k = a + 1; k <= b; k++) {
      let s = 0;
      for (let j = a + 1; j < b; j++) s += j < k ? score(i, j) : score(i + 1, j);
      if (s >= bestScore) [best, bestScore] = [k, s];
    }
    firstOf[i + 1] = best;
  }
  return firstOf.map((first, i) => {
    const last = Math.max(anchor[i]!, (i + 1 < n ? firstOf[i + 1]! : m) - 1);
    const start = sents[first]!.start;
    const end = sents[last]!.end;
    return { start, end, text: text.slice(start, end) };
  });
}

/**
 * Where a traced span is in the chapter's current text: the same place, moved (the nearest copy of its text), or
 * changed when its text is no longer there (the story was revised under it).
 */
export function locateSpan(text: string, span: SourceSpan): { start: number; end: number; changed: boolean } {
  if (text.slice(span.start, span.end) === span.text) return { start: span.start, end: span.end, changed: false };
  let best = -1;
  for (let at = text.indexOf(span.text); at >= 0; at = text.indexOf(span.text, at + 1))
    if (best < 0 || Math.abs(at - span.start) < Math.abs(best - span.start)) best = at;
  if (best >= 0) return { start: best, end: best + span.text.length, changed: false };
  return { start: Math.min(span.start, text.length), end: Math.min(span.end, text.length), changed: true };
}
