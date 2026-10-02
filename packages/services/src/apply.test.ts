import { expect, test } from "bun:test";
import { mergeChapters } from "./apply.ts";

const ch = (id: string, title: string, order: number, fromAnalysis = true) => ({
  id,
  title,
  order,
  storyAnalysisId: fromAnalysis ? "a1" : null,
});
const ids = (order: ({ existingId: string } | { index: number })[]) =>
  order.map((o) => ("existingId" in o ? o.existingId : `new${o.index}`));

test("a revised analysis keeps chapters by title, renames by position, adds the rest in place", () => {
  const existing = [ch("c1", "Rooftop", 1), ch("c2", "The Door", 2), ch("c3", "Rain", 3)];
  const m = mergeChapters(existing, [
    { title: "rooftop" },
    { title: "The Stairwell" },
    { title: "The Door" },
    { title: "Dawn" },
  ]);
  expect(m.chapters.map((c) => [c.kind, c.existingId])).toEqual([
    ["kept", "c1"],
    // Position 2 is "The Door", which the new analysis still has: so this one is new, not a rename.
    ["added", null],
    ["kept", "c2"],
    // Position 4 has no old chapter; "Rain" (position 3) is not renamed into it.
    ["added", null],
  ]);
  // "Rain" is not in the new analysis: it stays, after the chapter it followed.
  expect(m.unmatched.map((u) => u.id)).toEqual(["c3"]);
  expect(ids(m.order)).toEqual(["c1", "new1", "c2", "c3", "new3"]);
});

test("a chapter at the same place whose title changed is a rename; manual chapters are never renamed", () => {
  const m = mergeChapters([ch("c1", "Rooftop", 1), ch("c2", "Door", 2)], [{ title: "Rooftop" }, { title: "The Door" }]);
  expect(m.chapters[1]).toMatchObject({ kind: "renamed", existingId: "c2", fromTitle: "Door" });
  const manual = mergeChapters([ch("m1", "Notes", 1, false)], [{ title: "Rooftop" }]);
  expect(manual.chapters[0]!.kind).toBe("added");
  // A leftover chapter with nothing before it keeps the start, like the first apply onto manual chapters did.
  expect(ids(manual.order)).toEqual(["m1", "new0"]);
});

test("applying the same analysis again changes nothing", () => {
  const existing = [ch("c1", "One", 1), ch("c2", "Two", 2)];
  const m = mergeChapters(existing, [{ title: "One" }, { title: "Two" }]);
  expect(m.chapters.every((c) => c.kind === "kept")).toBe(true);
  expect(ids(m.order)).toEqual(["c1", "c2"]);
  // Leftovers keep their own order when they share an anchor.
  const left = mergeChapters([ch("c1", "One", 1), ch("x", "X", 2), ch("y", "Y", 3)], [{ title: "One" }]);
  expect(ids(left.order)).toEqual(["c1", "x", "y"]);
});
