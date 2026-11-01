/**
 * Matching a narration recording made outside OpenManga to the segments it reads: a speech recogniser's timed words
 * are aligned to the segments' words, so each segment learns where it is spoken in the file. The text is known, so
 * the recogniser only has to be close: a misheard word costs a little, an extra or a missing one costs a little more.
 */

/** `audio_assets.provider` of a take cut from an imported recording: current while its text is, whatever the voice. */
export const IMPORTED_AUDIO_PROVIDER = "import";

/** A recognised word, in seconds from the start of the recording. */
export type SpokenWord = { start: number; end: number; word: string };

export type SegmentSpan = {
  segmentId: string;
  /** Words in the segment's text, and how many of them were found in the recording. */
  words: number;
  matched: number;
  /** Where its first matched word starts and its last matched word ends, ms; null when nothing matched. */
  startMs: number | null;
  endMs: number | null;
  /**
   * Where to look for the quiet spot to cut at on each side: from the previous found segment's last word to its own
   * first word, and from its last word to the next found segment's first word. Null when nothing matched.
   */
  cutBefore: [number, number] | null;
  cutAfter: [number, number] | null;
  /**
   * Where to cut when those windows hold no pause (the lines were run together): within EDGE_MS of the gap between
   * the last word heard before it and its first word, and between its last word and the next word heard.
   */
  nearBefore: [number, number] | null;
  nearAfter: [number, number] | null;
};

/** Lowercase, without accents or punctuation: "Života," and "zivota" compare equal. */
export function normalizeWord(w: string) {
  return w
    .toLowerCase()
    .replace(/đ/g, "d")
    .normalize("NFD")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

const tokens = (text: string) => text.split(/\s+/).map(normalizeWord).filter(Boolean);

function levenshtein(a: string, b: string) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length]!;
}

const INDEL = 1;
/** Substitution cost: the same word, a near miss ("osjećala"/"osječala"), or a different word. */
function subCost(a: string, b: string, fuzzy: boolean) {
  if (a === b) return 0;
  if (!fuzzy || Math.abs(a.length - b.length) > 3) return 1.2;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length) >= 0.6 ? 0.4 : 1.2;
}

/** Cost of two words heard as one ("pred udaju" / "predudaju") or one heard as two. */
const JOIN = 0.2;

/** Edit-distance alignment of ref[r0,r1) to hyp[h0,h1); writes matched pairs into `map`. */
function fill(ref: string[], hyp: string[], r0: number, r1: number, h0: number, h1: number, map: Int32Array) {
  const n = r1 - r0;
  const m = h1 - h0;
  // ponytail: a gap this large (a whole chapter the recording does not read) stays unmatched; it never happens
  // between anchors in a recording of the same text.
  if (!n || !m || n * m > 4_000_000) return;
  const fuzzy = n * m <= 250_000;
  const w = m + 1;
  const r = (i: number) => ref[r0 + i - 1]!;
  const h = (j: number) => hyp[h0 + j - 1]!;
  const d = new Float32Array((n + 1) * w);
  // The cost of reaching (i, j) by each move; Infinity where the move does not apply.
  const moves = (i: number, j: number) => {
    const sub = subCost(r(i), h(j), fuzzy);
    return {
      sub,
      diag: d[(i - 1) * w + j - 1]! + sub,
      up: d[(i - 1) * w + j]! + INDEL,
      left: d[i * w + j - 1]! + INDEL,
      join2: i > 1 && r(i - 1) + r(i) === h(j) ? d[(i - 2) * w + j - 1]! + JOIN : Number.POSITIVE_INFINITY,
      split2: j > 1 && r(i) === h(j - 1) + h(j) ? d[(i - 1) * w + j - 2]! + JOIN : Number.POSITIVE_INFINITY,
    };
  };
  for (let i = 0; i <= n; i++) d[i * w] = i * INDEL;
  for (let j = 0; j <= m; j++) d[j] = j * INDEL;
  for (let i = 1; i <= n; i++)
    for (let j = 1; j <= m; j++) {
      const c = moves(i, j);
      d[i * w + j] = Math.min(c.diag, c.up, c.left, c.join2, c.split2);
    }
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const c = moves(i, j);
    const at = d[i * w + j]!;
    const is = (v: number) => Math.abs(at - v) < 1e-4;
    if (is(c.diag)) {
      if (c.sub < 1) map[r0 + i - 1] = h0 + j - 1;
      i--;
      j--;
    } else if (is(c.join2)) {
      map[r0 + i - 1] = map[r0 + i - 2] = h0 + j - 1;
      i -= 2;
      j--;
    } else if (is(c.split2)) {
      map[r0 + i - 1] = h0 + j - 2;
      i--;
      j -= 2;
    } else if (is(c.up)) i--;
    else j--;
  }
}

/** Longest chain of pairs increasing in both indexes (pairs come sorted by the first). */
function increasingChain(pairs: [number, number][]) {
  const tails: number[] = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k]![1];
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tails[lo - 1]!;
    tails[lo] = k;
  }
  const out: [number, number][] = [];
  for (let k = tails.at(-1) ?? -1; k >= 0; k = prev[k]!) out.push(pairs[k]!);
  return out.reverse();
}

/**
 * For each word of `ref`, the index of the `hyp` word it was heard as, or -1. Three-word phrases that occur once in
 * both are anchors (so a long recording aligns piecewise and a missing passage cannot drag everything after it);
 * the words between anchors are aligned by edit distance.
 */
export function alignWords(ref: string[], hyp: string[]) {
  const map = new Int32Array(ref.length).fill(-1);
  const N = 3;
  const grams = (t: string[]) => {
    const m = new Map<string, number>();
    for (let i = 0; i + N <= t.length; i++) {
      const k = t.slice(i, i + N).join(" ");
      m.set(k, m.has(k) ? -1 : i);
    }
    return m;
  };
  const inHyp = grams(hyp);
  const pairs: [number, number][] = [];
  for (const [k, i] of grams(ref)) {
    const j = inHyp.get(k);
    if (i >= 0 && j !== undefined && j >= 0) pairs.push([i, j]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const anchors = increasingChain(pairs);
  for (const [i, j] of anchors) map[i] = j;
  let r = 0;
  let h = 0;
  for (const [i, j] of [...anchors, [ref.length, hyp.length] as [number, number]]) {
    fill(ref, hyp, r, i, h, j, map);
    r = i + 1;
    h = j + 1;
  }
  return map;
}

/** Where each segment is spoken in a recording of the segments read in order. */
export function alignSegments(
  segments: readonly { id: string; text: string }[],
  spoken: readonly SpokenWord[],
  audioMs: number,
): SegmentSpan[] {
  const ref: string[] = [];
  const owner: number[] = [];
  segments.forEach((s, k) => {
    for (const t of tokens(s.text)) {
      ref.push(t);
      owner.push(k);
    }
  });
  const heard = spoken.map((w) => ({ ...w, t: normalizeWord(w.word) })).filter((w) => w.t);
  const map = alignWords(
    ref,
    heard.map((w) => w.t),
  );
  const first = new Int32Array(segments.length).fill(-1);
  const last = new Int32Array(segments.length).fill(-1);
  const matched = new Int32Array(segments.length);
  const total = new Int32Array(segments.length);
  for (let i = 0; i < ref.length; i++) {
    const k = owner[i]!;
    total[k]!++;
    const j = map[i]!;
    if (j < 0) continue;
    matched[k]!++;
    if (first[k]! < 0) first[k] = j;
    last[k] = j;
  }
  const ms = (s: number) => Math.round(s * 1000);
  const EDGE_MS = 100;
  return segments.map((s, k) => {
    const base = { segmentId: s.id, words: total[k]!, matched: matched[k]! };
    if (first[k]! < 0)
      return {
        ...base,
        startMs: null,
        endMs: null,
        cutBefore: null,
        cutAfter: null,
        nearBefore: null,
        nearAfter: null,
      };
    const startMs = ms(heard[first[k]!]!.start);
    const endMs = ms(heard[last[k]!]!.end);
    // The neighbours are the nearest segments that were found: words heard between them and this one that matched
    // nothing stay inside the window, so no cut lands in the middle of one.
    let p = k - 1;
    while (p >= 0 && last[p]! < 0) p--;
    let q = k + 1;
    while (q < segments.length && first[q]! < 0) q++;
    // A recogniser often stretches a word over the pause next to it ("Ustala" given 1.4 s, most of it the silence
    // before it), so a window runs from the middle of one side's edge word to the middle of the other's, and at least
    // EDGE_MS past both edges. The cut lands in a pause inside it. Two neighbours get the same window, so the same cut.
    const mid = (j: number) => ms((heard[j]!.start + heard[j]!.end) / 2);
    const firstMid = Math.max(mid(first[k]!), startMs + EDGE_MS);
    const lastMid = Math.min(mid(last[k]!), endMs - EDGE_MS);
    const prevEnd = p >= 0 ? ms(heard[last[p]!]!.end) : null;
    const nextStart = q < segments.length ? ms(heard[first[q]!]!.start) : null;
    const before = prevEnd === null ? startMs - 1000 : Math.min(mid(last[p]!), prevEnd - EDGE_MS);
    const after = nextStart === null ? endMs + 1000 : Math.max(mid(first[q]!), nextStart + EDGE_MS);
    const clamp = (x: number) => Math.min(audioMs, Math.max(0, x));
    return {
      ...base,
      startMs,
      endMs,
      cutBefore: [clamp(Math.min(startMs, before)), firstMid],
      cutAfter: [lastMid, clamp(Math.max(endMs, after))],
      nearBefore: [clamp(Math.min(startMs, (prevEnd ?? startMs - 1000) - EDGE_MS)), startMs + EDGE_MS],
      nearAfter: [endMs - EDGE_MS, clamp(Math.max(endMs, (nextStart ?? endMs + 1000) + EDGE_MS))],
    };
  });
}
