/**
 * Story coverage: how the plan (chapters, scenes, panels, narration) spends the story source. A text job maps each
 * source paragraph to the scenes that tell it and weighs it; everything here is the arithmetic around that map.
 */

export type SourceParagraph = { key: string; start: number; end: number; text: string };

/** A paragraph longer than this is cut at sentence ends, so one wall of text does not become one opaque unit. */
const LONG_PARAGRAPH = 2400;

/**
 * The source as numbered paragraphs (P1, P2, …) with their character offsets in the revision. Blank lines separate
 * paragraphs; text with none is split at single line breaks; a very long paragraph is cut at sentence ends.
 */
export function splitParagraphs(text: string): SourceParagraph[] {
  const blocks = (sep: RegExp) => {
    const out: { start: number; end: number }[] = [];
    let at = 0;
    for (const m of text.matchAll(sep)) {
      out.push({ start: at, end: m.index });
      at = m.index + m[0].length;
    }
    out.push({ start: at, end: text.length });
    return out;
  };
  let ranges = blocks(/\n\s*\n/g);
  if (ranges.length === 1 && text.length > LONG_PARAGRAPH) ranges = blocks(/\n/g);
  const pieces: { start: number; end: number }[] = [];
  for (const r of ranges) {
    let { start } = r;
    while (r.end - start > LONG_PARAGRAPH) {
      const window = text.slice(start, start + LONG_PARAGRAPH);
      const cut = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
      const end = start + (cut > LONG_PARAGRAPH / 3 ? cut + 1 : LONG_PARAGRAPH);
      pieces.push({ start, end });
      start = end;
    }
    pieces.push({ start, end: r.end });
  }
  const out: SourceParagraph[] = [];
  for (const p of pieces) {
    // Trim to the words, keeping offsets exact.
    const raw = text.slice(p.start, p.end);
    const lead = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (!body) continue;
    out.push({ key: `P${out.length + 1}`, start: p.start + lead, end: p.start + lead + body.length, text: body });
  }
  return out;
}

/** Groups paragraphs into requests of at most `maxChars` source characters each (a paragraph is never split). */
export function chunkParagraphs(ps: SourceParagraph[], maxChars = 12_000): SourceParagraph[][] {
  const out: SourceParagraph[][] = [];
  let cur: SourceParagraph[] = [];
  let size = 0;
  for (const p of ps) {
    if (cur.length && size + p.text.length > maxChars) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(p);
    size += p.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

export type CoveragePlanScene = { id: string; key: string; title: string; panels: number };
export type CoveragePlanChapter = {
  id: string;
  key: string;
  order: number;
  title: string;
  panels: number;
  /** Narration words in the chapter, a proxy for its share of the runtime. */
  words: number;
  scenes: CoveragePlanScene[];
};
/** What the model said about one paragraph: how much it matters (1–5) and which scenes or chapters tell it. */
export type ParagraphMapping = { weight: number; coveredBy: string[] };

export type CoverageFinding = {
  kind: "left_out" | "repeated" | "more_room" | "less_room";
  severity: "low" | "medium" | "high";
  /** Source spans (character offsets in the revision) with the paragraphs they join. */
  spans: { start: number; end: number; paragraphs: string[] }[];
  chapterIds: string[];
  sceneIds: string[];
  sourceShare?: number;
  planShare?: number;
  message: string;
};

export type CoverageShares = {
  chapterId: string;
  sourceShare: number;
  panelShare: number;
  narrationShare: number;
};

const pct = (x: number) => `${Math.round(x * 100)}%`;
/** A share this far apart counts as "far more or less room than its weight". */
const RATIO = 2.5;
/** Too small to judge: a chapter or scene under this share of both the source and the plan. */
const MIN_SHARE = 0.02;

/**
 * Findings from the paragraph map: important paragraphs nothing tells (runs joined into one span), paragraphs told in
 * more than one chapter, and chapters or scenes whose share of the panels is far from their share of the source
 * (weighted by importance and length).
 */
export function coverageFindings(
  paragraphs: SourceParagraph[],
  mapping: Map<string, ParagraphMapping>,
  plan: CoveragePlanChapter[],
): { findings: CoverageFinding[]; shares: CoverageShares[] } {
  const chapterOfScene = new Map(plan.flatMap((c) => c.scenes.map((s) => [s.key, c] as const)));
  const chapterByKey = new Map(plan.map((c) => [c.key, c]));
  const sceneByKey = new Map(plan.flatMap((c) => c.scenes.map((s) => [s.key, s] as const)));
  const findings: CoverageFinding[] = [];

  // Left out: important paragraphs (weight 3+) nothing tells; consecutive ones are one span.
  let run: SourceParagraph[] = [];
  let runWeight = 0;
  const flush = () => {
    if (run.length)
      findings.push({
        kind: "left_out",
        severity: runWeight >= 5 ? "high" : runWeight >= 4 ? "medium" : "low",
        spans: [{ start: run[0]!.start, end: run.at(-1)!.end, paragraphs: run.map((p) => p.key) }],
        chapterIds: [],
        sceneIds: [],
        message: `${run.length === 1 ? "A paragraph" : `${run.length} paragraphs`} of weight ${runWeight} ${run.length === 1 ? "is" : "are"} not told anywhere in the plan.`,
      });
    run = [];
    runWeight = 0;
  };
  for (const p of paragraphs) {
    const m = mapping.get(p.key);
    if (m && !m.coveredBy.length && m.weight >= 3) {
      run.push(p);
      runWeight = Math.max(runWeight, m.weight);
    } else flush();
  }
  flush();

  // Repeated: one paragraph told in two or more chapters.
  for (const p of paragraphs) {
    const m = mapping.get(p.key);
    if (!m) continue;
    const chapters = [
      ...new Set(m.coveredBy.map((k) => chapterOfScene.get(k) ?? chapterByKey.get(k)).filter(Boolean)),
    ] as CoveragePlanChapter[];
    if (chapters.length < 2) continue;
    findings.push({
      kind: "repeated",
      severity: m.weight >= 4 ? "medium" : "low",
      spans: [{ start: p.start, end: p.end, paragraphs: [p.key] }],
      chapterIds: chapters.map((c) => c.id),
      sceneIds: m.coveredBy.map((k) => sceneByKey.get(k)?.id).filter((x): x is string => Boolean(x)),
      message: `Told in ${chapters.map((c) => `chapter ${c.order}`).join(" and ")}.`,
    });
  }

  // Room against weight: each paragraph's mass (weight × length) split across what tells it.
  const mass = new Map<string, number>();
  const spansOf = new Map<string, SourceParagraph[]>();
  let total = 0;
  for (const p of paragraphs) {
    const m = mapping.get(p.key);
    const w = (m?.weight ?? 1) * p.text.length;
    total += w;
    const targets = (m?.coveredBy ?? []).filter((k) => sceneByKey.has(k) || chapterByKey.has(k));
    for (const k of targets) {
      mass.set(k, (mass.get(k) ?? 0) + w / targets.length);
      spansOf.set(k, [...(spansOf.get(k) ?? []), p]);
    }
  }
  const panels = plan.reduce((n, c) => n + c.panels, 0);
  const words = plan.reduce((n, c) => n + c.words, 0);
  const shares: CoverageShares[] = [];
  const room = (
    key: string,
    o: { chapter: CoveragePlanChapter; scene?: CoveragePlanScene; source: number; plan: number },
  ): CoverageFinding | null => {
    if (Math.max(o.source, o.plan) < MIN_SHARE || !panels) return null;
    const ratio = o.source ? o.plan / o.source : Number.POSITIVE_INFINITY;
    if (ratio < RATIO && ratio > 1 / RATIO) return null;
    const what = o.scene ? `Scene "${o.scene.title}" (chapter ${o.chapter.order})` : `Chapter ${o.chapter.order}`;
    const ps = spansOf.get(key) ?? [];
    return {
      kind: ratio >= RATIO ? "more_room" : "less_room",
      severity: ratio >= RATIO * 2 || ratio <= 1 / (RATIO * 2) ? "medium" : "low",
      spans: ps.length ? [{ start: ps[0]!.start, end: ps.at(-1)!.end, paragraphs: ps.map((p) => p.key) }] : [],
      chapterIds: [o.chapter.id],
      sceneIds: o.scene ? [o.scene.id] : [],
      sourceShare: o.source,
      planShare: o.plan,
      message: `${what} has ${pct(o.plan)} of the panels for ${pct(o.source)} of the story's weight.`,
    };
  };
  for (const c of plan) {
    const source = total
      ? ((mass.get(c.key) ?? 0) + c.scenes.reduce((n, s) => n + (mass.get(s.key) ?? 0), 0)) / total
      : 0;
    const panelShare = panels ? c.panels / panels : 0;
    shares.push({ chapterId: c.id, sourceShare: source, panelShare, narrationShare: words ? c.words / words : 0 });
    const chapterFinding = room(c.key, { chapter: c, source, plan: panelShare });
    if (chapterFinding) findings.push(chapterFinding);
    if (c.scenes.length < 2) continue;
    for (const s of c.scenes) {
      const f = room(s.key, {
        chapter: c,
        scene: s,
        source: total ? (mass.get(s.key) ?? 0) / total : 0,
        plan: panels ? s.panels / panels : 0,
      });
      // The chapter already says it when its one finding points the same way.
      if (f && f.kind !== chapterFinding?.kind) findings.push(f);
    }
  }
  return { findings, shares };
}
