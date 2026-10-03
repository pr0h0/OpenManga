import { expect, test } from "bun:test";
import { segmentTextSha, spokenText } from "./index.ts";

const dict = [
  { term: "Qi", spoken: "chee" },
  { term: "Seo Jinhyeok", spoken: "suh jin-hyuk" },
  { term: "Seo", spoken: "suh" },
  { term: "NASA", spoken: "nassa", caseSensitive: true },
  { term: "-ji", spoken: "-jee", wholeWord: false },
];

test("replaces whole words, case-insensitively by default", () => {
  expect(spokenText("Qi flows. The qi of Qing stays.", dict)).toBe("chee flows. The chee of Qing stays.");
});

test("prefers the longer of overlapping terms and never rewrites a spoken form", () => {
  expect(spokenText("Seo Jinhyeok met Seo.", dict)).toBe("suh jin-hyuk met suh.");
  expect(spokenText("Qi", [...dict, { term: "chee", spoken: "WRONG" }])).toBe("chee");
});

test("case-sensitive and part-word entries", () => {
  expect(spokenText("NASA, not nasa.", dict)).toBe("nassa, not nasa.");
  expect(spokenText("Min-ji smiled", dict)).toBe("Min-jee smiled");
});

test("treats non-Latin letters as word characters", () => {
  expect(spokenText("Qié Qi", dict)).toBe("Qié chee");
});

test("the segment hash is of the spoken text, and unchanged when nothing matches", () => {
  expect(segmentTextSha("The rain fell.", dict)).toBe(segmentTextSha("The rain fell."));
  expect(segmentTextSha("Qi rose.", dict)).toBe(segmentTextSha("chee rose."));
  expect(segmentTextSha("Qi rose.", dict)).not.toBe(segmentTextSha("Qi rose."));
});
