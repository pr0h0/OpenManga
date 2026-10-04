import { expect, test } from "bun:test";
import {
  audioFindings,
  findingKey,
  type LintChapter,
  lintNarrationRules,
  loudnessFindings,
  narrationDensity,
  similarity,
} from "./narration-lint.ts";

const opts = { names: ["Ines", "Tomas"], wordsPerShot: 20, wordsPerMinute: 150 };
const chapter = (id: string, order: number, lines: string[], shots = 0, dialogue: Record<number, string[]> = {}) =>
  ({
    id,
    order,
    title: id,
    lines: lines.map((text, i) => ({
      id: `${id}-l${i}`,
      text,
      panelId: shots ? `${id}-p${Math.min(i, shots - 1)}` : null,
    })),
    shots: Array.from({ length: shots }, (_, i) => ({ id: `${id}-p${i}`, dialogue: dialogue[i] ?? [] })),
  }) satisfies LintChapter;
const kinds = (c: LintChapter, others: LintChapter[] = []) => lintNarrationRules(c, others, opts).map((f) => f.kind);

test("repeated sentence openings within a few sentences", () => {
  const c = chapter("a", 1, ["She climbed the stairs. She lit the lamp.", "She waited for the boat. The wind rose."]);
  const f = lintNarrationRules(c, [], opts).find((x) => x.kind === "repeated_opening");
  expect(f).toBeUndefined(); // "she climbed", "she lit", "she waited": different two-word openers
  const d = chapter("b", 1, ["The lamp was old. The lamp was cold.", "The lamp was all she had. Then it went dark."]);
  const g = lintNarrationRules(d, [], opts).find((x) => x.kind === "repeated_opening");
  expect(g?.lineIds).toEqual(["b-l0", "b-l1"]);
  expect(g?.message).toContain('"the lamp"');
});

test("sentences of the same length, one after another", () => {
  const same = Array.from({ length: 7 }, (_, i) => `Wave ${i} rolled slowly over the old stone pier.`);
  const f = lintNarrationRules(chapter("a", 1, same), [], opts).find((x) => x.kind === "flat_rhythm");
  expect(f?.lineIds).toHaveLength(7);
  const varied = [
    same[0]!,
    "The wind rose.",
    same[1]!,
    same[2]!,
    "It was over before anyone understood.",
    same[3]!,
    same[4]!,
  ];
  expect(kinds(chapter("b", 1, varied))).not.toContain("flat_rhythm");
});

test("a name used too often in a short stretch", () => {
  const c = chapter("a", 1, ["Ines ran. Ines stopped.", "Ines looked back. Ines saw Tomas."]);
  const f = lintNarrationRules(c, [], opts).filter((x) => x.kind === "name_overuse");
  expect(f.map((x) => x.message)).toEqual(['"Ines" is named 4 times in 4 sentences.']);
  expect(kinds(chapter("b", 1, ["Ines ran. She stopped.", "Ines looked back and saw Tomas."]))).not.toContain(
    "name_overuse",
  );
});

test("near-duplicate lines, and unlike lines left alone", () => {
  expect(similarity("The storm broke over Vell that night.", "The storm broke over Vell that night!")).toBe(1);
  const c = chapter("a", 1, [
    "The storm broke over the lighthouse at Vell that night.",
    "Tomas kept the logbook by the window.",
    "That night the storm broke over the lighthouse at Vell.",
  ]);
  const f = lintNarrationRules(c, [], opts).filter((x) => x.kind === "near_duplicate");
  expect(f.map((x) => x.lineIds)).toEqual([["a-l0", "a-l2"]]);
});

test("narration that repeats its panel's dialogue", () => {
  const c = chapter("a", 1, ["Tomas said he would never leave the light.", "The boat left."], 2, {
    0: ["I will never leave the light."],
  });
  expect(
    lintNarrationRules(c, [], opts)
      .filter((x) => x.kind === "restates_dialogue")
      .map((x) => x.lineIds),
  ).toEqual([["a-l0"]]);
});

test("chapters that open or end the same way", () => {
  const one = chapter("a", 1, ["Night fell over Vell as the boat came in.", "It ended in silence."]);
  const two = chapter("b", 2, ["Night fell over Vell as the storm came in.", "The lamp burned on."]);
  const f = lintNarrationRules(two, [one], opts).find((x) => x.kind === "chapter_opening");
  expect(f?.relatedChapterIds).toEqual(["a"]);
  expect(kinds(two, [one])).not.toContain("chapter_ending");
});

test("density: crowded shots, silent stretches and pace from real audio", () => {
  const long = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");
  const c: LintChapter = {
    ...chapter("a", 1, [long, "Short."], 6),
    // Line 1 sits on shot 1; shots 2–5 say nothing.
    audio: { ms: 60_000, words: 260 },
  };
  const f = lintNarrationRules(c, [], opts);
  expect(f.filter((x) => x.kind === "dense_shot").map((x) => x.lineIds)).toEqual([["a-l0"]]);
  expect(f.find((x) => x.kind === "silent_stretch")?.message).toContain("4 shots in a row (shots 3–6)");
  expect(f.find((x) => x.kind === "pace")?.message).toContain("260 words a minute");
  const d = narrationDensity(c);
  expect(d.totals).toMatchObject({ words: 51, shots: 6, silentShots: 4, wordsPerMinute: 260 });
});

test("a line spanning several shots keeps them from counting as silent", () => {
  const c = chapter("a", 1, ["One long line."], 4);
  expect(narrationDensity(c).totals.silentShots).toBe(3);
  expect(narrationDensity({ ...c, lines: [{ ...c.lines[0]!, untilPanelId: "a-p3" }] }).totals.silentShots).toBe(0);
});

test("a finding's key ignores the order of its lines", () => {
  const f = { kind: "near_duplicate" as const, lineIds: ["b", "a"], relatedChapterIds: [] };
  expect(findingKey(f)).toBe(findingKey({ ...f, lineIds: ["a", "b"] }));
});

test("audio findings: silent, clipped, stalled and out-of-level takes; chapters out of step in loudness", () => {
  const ok = { durationMs: 3000, speechDb: -20, clippedMs: 0, longestGapMs: 300 };
  const found = audioFindings([
    { lineId: "a", stats: ok },
    { lineId: "b", stats: { ...ok, speechDb: -21 } },
    { lineId: "c", stats: { ...ok, speechDb: -60 } },
    { lineId: "d", stats: { ...ok, clippedMs: 25 } },
    { lineId: "d", stats: { ...ok, clippedMs: 3 } },
    { lineId: "e", stats: { ...ok, longestGapMs: 2400 } },
    { lineId: "f", stats: { ...ok, speechDb: -29 } },
  ]);
  expect(found.map((f) => [f.kind, f.lineIds[0], f.severity])).toEqual([
    ["audio_silent", "c", "high"],
    ["audio_clipping", "d", "high"],
    ["audio_gap", "e", "medium"],
    ["audio_level", "f", "medium"],
  ]);
  expect(found[3]!.message).toBe("9.0 dB quieter than the chapter's other lines.");
  const loud = loudnessFindings([
    { id: "c1", lufs: -20 },
    { id: "c2", lufs: -19.5 },
    { id: "c3", lufs: -25 },
    { id: "c4", lufs: Number.NaN },
  ]);
  expect([...loud.keys()]).toEqual(["c3"]);
  expect(loud.get("c3")!.message).toContain("5.3 LU quieter");
  expect(loudnessFindings([{ id: "c1", lufs: -30 }]).size).toBe(0);
});
