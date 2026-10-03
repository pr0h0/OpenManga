import { expect, test } from "bun:test";
import { type CoveragePlanChapter, chunkParagraphs, coverageFindings, splitParagraphs } from "./coverage.ts";

test("paragraphs keep their exact offsets, and a wall of text is split", () => {
  const text = "  First one.\n\nSecond one.\n\n\n  Third.  ";
  const ps = splitParagraphs(text);
  expect(ps.map((p) => p.key)).toEqual(["P1", "P2", "P3"]);
  for (const p of ps) expect(text.slice(p.start, p.end)).toBe(p.text);
  const wall = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} goes on.`).join(" ");
  const parts = splitParagraphs(wall);
  expect(parts.length).toBeGreaterThan(1);
  expect(parts.every((p) => p.text.length <= 2400 && wall.slice(p.start, p.end) === p.text)).toBe(true);
});

test("chunks stay under the size and never split a paragraph", () => {
  const ps = splitParagraphs(Array.from({ length: 30 }, (_, i) => `${"x".repeat(900)} ${i}`).join("\n\n"));
  const chunks = chunkParagraphs(ps, 5000);
  expect(chunks.flat()).toEqual(ps);
  expect(chunks.every((c) => c.reduce((n, p) => n + p.text.length, 0) <= 5000)).toBe(true);
});

const plan: CoveragePlanChapter[] = [
  {
    id: "c1",
    key: "C1",
    order: 1,
    title: "One",
    panels: 18,
    words: 400,
    scenes: [
      { id: "s1", key: "C1.S1", title: "Arrival", panels: 2 },
      { id: "s2", key: "C1.S2", title: "The lamp", panels: 16 },
    ],
  },
  {
    id: "c2",
    key: "C2",
    order: 2,
    title: "Two",
    panels: 2,
    words: 100,
    scenes: [{ id: "s3", key: "C2.S1", title: "Storm", panels: 2 }],
  },
];

test("left out, repeated, and room far from the weight", () => {
  const text = ["A".repeat(100), "B".repeat(100), "C".repeat(100), "D".repeat(100), "E".repeat(100)].join("\n\n");
  const ps = splitParagraphs(text);
  const mapping = new Map([
    ["P1", { weight: 2, coveredBy: ["C1.S1"] }],
    ["P2", { weight: 4, coveredBy: [] }],
    ["P3", { weight: 5, coveredBy: [] }],
    ["P4", { weight: 3, coveredBy: ["C1.S2", "C2.S1"] }],
    ["P5", { weight: 5, coveredBy: ["C2.S1"] }],
  ]);
  const { findings, shares } = coverageFindings(ps, mapping, plan);
  const left = findings.filter((f) => f.kind === "left_out");
  // The two unmapped paragraphs are one span, as heavy as the heaviest of them.
  expect(left).toHaveLength(1);
  expect(left[0]!.spans[0]).toEqual({ start: ps[1]!.start, end: ps[2]!.end, paragraphs: ["P2", "P3"] });
  expect(left[0]!.severity).toBe("high");
  expect(findings.find((f) => f.kind === "repeated")?.chapterIds).toEqual(["c1", "c2"]);
  // Chapter 2 tells the heaviest paragraph in 10% of the panels.
  const less = findings.find((f) => f.kind === "less_room" && f.chapterIds[0] === "c2" && !f.sceneIds.length);
  expect(less?.message).toContain("Chapter 2 has 10% of the panels");
  // Chapter 1 has far more room; its lamp scene, which takes it, is not reported a second time.
  expect(findings.filter((f) => f.kind === "more_room").map((f) => [f.chapterIds, f.sceneIds])).toEqual([[["c1"], []]]);
  expect(shares.map((s) => Math.round(s.panelShare * 100))).toEqual([90, 10]);
});
