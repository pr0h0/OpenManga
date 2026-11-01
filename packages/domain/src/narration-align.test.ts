import { expect, test } from "bun:test";
import { alignSegments, normalizeWord } from "./narration-align.ts";

// Recognised words one per 0.3 s, a 0.6 s pause between sentences.
function speak(sentences: string[][]) {
  const out: { start: number; end: number; word: string }[] = [];
  let t = 0;
  for (const words of sentences) {
    for (const word of words) {
      out.push({ start: t, end: t + 0.25, word });
      t += 0.3;
    }
    t += 0.6;
  }
  return out;
}

test("normalizes case, accents and punctuation", () => {
  expect(normalizeWord("Života,")).toBe("zivota");
  expect(normalizeWord("Đurđa")).toBe("durda");
  expect(normalizeWord("—")).toBe("");
});

test("finds each segment despite misheard and invented words, and leaves unread segments unmatched", () => {
  const segments = [
    { id: "a", text: "Zamislite da se pripremate za najsretniji dan svog života," },
    { id: "b", text: "uvjereni da osobu koju volite poznajete bolje od bilo koga, pred udaju." },
    { id: "c", text: "A onda, samo nekoliko sati prije vjenčanja, jedna poruka promijeni sve." },
    { id: "d", text: "Ovo nije u snimku." },
  ];
  const words = speak([
    ["Zamislite", "da", "se", "pripremate", "za", "najsredniji", "dan", "svog", "života."],
    ["Uvjereni", "da", "osobu", "koju", "volite", "poznajete", "bolje", "od", "bilo", "koga,", "predudaju."],
    ["hmm"],
    ["A", "onda", "samo", "nekoliko", "sati", "prije", "vjenčanja.", "Jedna", "poruka", "promijeni", "sve."],
  ]);
  const audioMs = 20_000;
  const [a, b, c, d] = alignSegments(segments, words, audioMs);

  expect(a!.matched).toBe(9); // "najsredniji" is a near miss of "najsretniji"
  expect(a!.startMs).toBe(0);
  expect(a!.endMs).toBe(2650);
  expect(b!.matched).toBe(12); // "pred udaju" was heard as one word
  expect(b!.endMs).toBe(6550);
  expect(b!.startMs).toBe(3300);
  // a and b share one cut window, from the middle of a's last word to the middle of b's first, so one cut.
  expect(a!.cutAfter).toEqual([2525, 3425]);
  expect(b!.cutBefore).toEqual([2525, 3425]);
  // "hmm" belongs to no segment: c starts at its own first word, and the window it is cut in reaches back to b's
  // last word, so the quietest spot (not "hmm") decides the cut.
  expect(c!.matched).toBe(11);
  expect(c!.startMs).toBe(8100);
  expect(c!.cutBefore).toEqual([6425, 8225]);
  expect(d).toMatchObject({ matched: 0, words: 4, startMs: null, cutBefore: null });
  expect(c!.cutAfter![1]).toBe(Math.min(audioMs, c!.endMs! + 1000));
});

test("a recording that skips a passage still aligns what follows it", () => {
  const sentence = (n: number) => `Rečenica broj ${n} govori o nečemu sasvim drugom ${n}.`;
  const segments = Array.from({ length: 30 }, (_, i) => ({ id: String(i), text: sentence(i) }));
  const read = segments.filter((_, i) => i < 10 || i >= 15).map((s) => s.text.split(" "));
  const spans = alignSegments(segments, speak(read), 600_000);
  expect(spans.slice(10, 15).every((s) => s.matched <= 3)).toBe(true);
  expect(spans.filter((s) => s.matched === s.words).length).toBe(25);
  const starts = spans.filter((s) => s.startMs !== null).map((s) => s.startMs!);
  expect(starts).toEqual([...starts].sort((x, y) => x - y));
});

test("a word stretched over the pause next to it still has the pause inside the cut window", () => {
  // "Ustala" is given 43.40-44.82 s although it is spoken from 43.9 s: the pause 43.5-43.8 s sits inside its span.
  const spoken = [
    { start: 42.9, end: 43.14, word: "moje" },
    { start: 43.14, end: 43.4, word: "dove." },
    { start: 43.4, end: 44.82, word: "Ustala" },
    { start: 44.82, end: 45.1, word: "sam." },
  ];
  const [a, b] = alignSegments(
    [
      { id: "a", text: "moje dove." },
      { id: "b", text: "Ustala sam." },
    ],
    spoken,
    60_000,
  );
  expect(a!.cutAfter![0]).toBeLessThanOrEqual(43_400);
  expect(a!.cutAfter![1]).toBeGreaterThanOrEqual(43_800);
  expect(b!.cutBefore).toEqual(a!.cutAfter);
});
