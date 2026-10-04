import { expect, test } from "bun:test";
import { bestSentence, pickCarousel, pickQuotes, pickShortsSet, REPURPOSE_PRESETS } from "./repurpose.ts";

const cands = Array.from({ length: 60 }, (_, i) => ({
  id: `p${i}`,
  shotType: i % 7 === 0 ? "close_up" : "medium",
  text: i % 5 === 0 ? "Run! The tower is on fire!" : "They walked on.",
  holdMs: 3000,
  hasArt: i % 11 !== 3,
}));

test("a set of Shorts never shares a shot, each within its length", () => {
  const set = pickShortsSet(cands, 3, REPURPOSE_PRESETS.short);
  expect(set).toHaveLength(3);
  const all = set.flat();
  expect(new Set(all).size).toBe(all.length);
  for (const ids of set) expect(ids.length * 3000).toBeLessThanOrEqual(REPURPOSE_PRESETS.short.maxMs);
  // Story order is kept across the set: each Short comes from a later part than the one before.
  const idx = (id: string) => Number(id.slice(1));
  expect(idx(set[0]!.at(-1)!)).toBeLessThan(idx(set[1]![0]!));
});

test("a carousel takes n panels with art, in story order", () => {
  const ids = pickCarousel(cands, 10);
  expect(ids).toHaveLength(10);
  expect(ids.every((id) => cands.find((c) => c.id === id)!.hasArt)).toBe(true);
  const order = ids.map((id) => Number(id.slice(1)));
  expect(order).toEqual([...order].sort((a, b) => a - b));
});

test("quotes pick the most quotable sentence, one per panel", () => {
  expect(bestSentence("Hi. The light is a secret nobody keeps! Then they ate.")).toBe(
    "The light is a secret nobody keeps!",
  );
  expect(bestSentence("Ok.")).toBeNull();
  const q = pickQuotes(
    cands.map((c) => ({ ...c, quotes: [c.text] })),
    3,
  );
  expect(q).toHaveLength(3);
  expect(new Set(q.map((x) => x.panelId)).size).toBe(3);
  expect(q.every((x) => x.text === "The tower is on fire!")).toBe(true);
});
