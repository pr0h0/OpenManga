import { expect, test } from "bun:test";
import { splitEpisodes, storyChapters } from "./series.ts";

const STORY = `The Lamp at Vell

Chapter 1: Arrival
Ines came to Vell.

Chapter 2
Tomas would not leave.

CHAPTER III: The Storm
The lamp turned.

# Epilogue
Morning.`;

test("chapters are cut at their headings, a prologue joins the first", () => {
  const chs = storyChapters(STORY);
  expect(chs.map((c) => c.title)).toEqual(["Chapter 1: Arrival", "Chapter 2", "CHAPTER III: The Storm", "Epilogue"]);
  expect(chs[0]!.text).toStartWith("The Lamp at Vell");
  expect(chs[1]!.text).toBe("Chapter 2\nTomas would not leave.");
});

test("prose that starts like a heading is not one", () => {
  const chs = storyChapters(
    "Chapter 1\nPart of me wanted to run.\nBook club met at noon.\n\nChapter Two - Night\nDark.",
  );
  expect(chs.map((c) => c.title)).toEqual(["Chapter 1", "Chapter Two - Night"]);
});

test("episodes group chapters; the last one takes what is left", () => {
  const eps = splitEpisodes(STORY, { perEpisode: 3 });
  expect(eps.map((e) => [e.title, e.chapters])).toEqual([
    ["Chapter 1: Arrival – CHAPTER III: The Storm", 3],
    ["Epilogue", 1],
  ]);
  expect(eps[1]!.text).toBe("# Epilogue\nMorning.");
  // Nothing is lost or repeated.
  expect(
    eps
      .map((e) => e.text)
      .join("\n\n")
      .replace(/\s+/g, " "),
  ).toBe(STORY.replace(/\s+/g, " "));
});

test("without headings the story is cut at paragraph breaks by size", () => {
  const para = "word ".repeat(500).trim();
  const eps = splitEpisodes([para, para, para, para, para].join("\n\n"), { charsPerEpisode: 5000 });
  expect(eps.length).toBe(3);
  expect(eps.map((e) => e.title)).toEqual(["Part 1", "Part 2", "Part 3"]);
  expect(eps.every((e) => !e.text.startsWith("\n"))).toBe(true);
  expect(splitEpisodes("one short story")).toEqual([{ title: "Part 1", text: "one short story", chapters: 0 }]);
});
