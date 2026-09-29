import { expect, test } from "bun:test";
import { chaptersForRuntime, runtimeBudget, wordsPerPanelFor } from "./runtime.ts";

const t = { minutes: 30, wordsPerMinute: 150, minShotSeconds: 4, maxShotSeconds: 8 };

test("a runtime splits into chapter budgets by source length", () => {
  const b = runtimeBudget(
    t,
    [
      { id: "a", sourceChars: 3000 },
      { id: "b", sourceChars: 1000 },
    ],
    "film",
  );
  expect(b.totalWords).toBe(4500);
  expect(b.chapters.map((c) => c.words)).toEqual([3375, 1125]);
  // 3375 words at 2.5 words/s is 1350 s; at a 6 s average shot that is 225 shots, capped to a 60-page plan.
  expect(b.chapters[0]).toMatchObject({ shots: 225, pages: 60, capped: true });
  expect(b.chapters[1]).toMatchObject({ shots: 75, pages: 60, capped: true });
  const comic = runtimeBudget({ ...t, minutes: 5 }, [{ id: "a", sourceChars: 1 }], "comic");
  // 750 words → 50 shots → 15 comic pages at ~3.5 panels each.
  expect(comic.chapters[0]).toMatchObject({ words: 750, shots: 50, pages: 15, capped: false });
});

test("words per panel aims at the chapter budget within the shot bounds", () => {
  expect(wordsPerPanelFor(t, 1000, 100)).toBe(10); // 4 s × 2.5 w/s
  expect(wordsPerPanelFor(t, 1500, 100)).toBe(15);
  expect(wordsPerPanelFor(t, 9000, 100)).toBe(20); // 8 s × 2.5 w/s
});

test("a long runtime asks for enough chapters that each fits one plan", () => {
  // 3 h of 9 s shots is 1200 shots; a film plan holds 60, used at 80%: 25 chapters.
  expect(chaptersForRuntime({ minutes: 180, wordsPerMinute: 150, minShotSeconds: 6, maxShotSeconds: 12 }, "film")).toBe(
    25,
  );
  expect(chaptersForRuntime({ minutes: 120, wordsPerMinute: 150, minShotSeconds: 5, maxShotSeconds: 10 }, "film")).toBe(
    20,
  );
  expect(
    chaptersForRuntime({ minutes: 2, wordsPerMinute: 150, minShotSeconds: 4, maxShotSeconds: 8 }, "film"),
  ).toBeNull();
  // Comic plans hold about 210 panels, so far fewer chapters.
  expect(
    chaptersForRuntime({ minutes: 180, wordsPerMinute: 150, minShotSeconds: 6, maxShotSeconds: 12 }, "comic"),
  ).toBe(8);
});
