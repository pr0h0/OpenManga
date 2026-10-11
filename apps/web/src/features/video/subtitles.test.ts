import { expect, test } from "bun:test";
import { buildTimeline, type PreviewShot, subtitleAt } from "./VideoPreview.tsx";

const seg = (id: string, text: string, ms: number | null) => ({
  id,
  text,
  pauseAfterMs: 300,
  audioAssetId: ms ? `a-${id}` : null,
  durationMs: ms,
});
const shot = (key: string, segments: ReturnType<typeof seg>[]) =>
  ({
    key,
    label: key,
    joinNext: false,
    minHoldMs: null,
    fade: { in: false, out: false },
    motion: null,
    page: { id: "p", order: 1, chapterOrder: 1, width: 1600, height: 2400, updatedAt: "" },
    panel: null,
    lines: [{ id: `l-${key}`, startOffsetMs: 0, endOffsetMs: 0, segments }],
  }) as unknown as PreviewShot;

test("the subtitle follows the spoken segment, a silent shot shows its line, a pause shows nothing", () => {
  const tl = buildTimeline(
    [
      shot("s1", [seg("a", "Rain hammered the city.", 2000), seg("b", " Woo Jin climbed. ", 1500)]),
      shot("s2", [seg("c", "Unvoiced line.", null)]),
    ],
    2500,
    undefined,
  );
  const [a, b] = tl.cues;
  expect(subtitleAt(tl, a!.startMs + 10)).toBe("Rain hammered the city.");
  expect(subtitleAt(tl, b!.startMs + 10)).toBe("Woo Jin climbed.");
  // Between the two segments the voice pauses: no subtitle, not the whole line.
  expect(subtitleAt(tl, a!.endMs + 50)).toBe("");
  const silent = tl.timed[1]!;
  expect(subtitleAt(tl, silent.startMs + 10)).toBe("Unvoiced line.");
  expect(subtitleAt(tl, tl.totalMs + 1000)).toBe("");
});

test("a chapter's title card plays before its first shot and pushes everything after it", () => {
  const inChapter = (s: PreviewShot, chapterId: string) => ({ ...s, page: { ...s.page, chapterId } }) as PreviewShot;
  const shots = [
    inChapter(shot("s1", [seg("a", "One.", 1000)]), "c1"),
    inChapter(shot("s2", [seg("b", "Two.", 1000)]), "c2"),
  ];
  const plain = buildTimeline(shots, 2000, undefined);
  const card = { chapterId: "c2", title: "Chapter 2", subtitle: "", durationMs: 2000 };
  const tl = buildTimeline(shots, 2000, { intro: null, outro: null, chapters: [card], watermark: null, version: "" });
  expect(tl.timed.map((e) => e.key)).toEqual(["s1", "chapter-c2", "s2"]);
  expect(tl.timed[1]!.title).toBe("Chapter 2");
  expect(tl.timed[2]!.startMs).toBe(plain.timed[1]!.startMs + 2000);
  expect(tl.cues[1]!.startMs).toBe(plain.cues[1]!.startMs + 2000);
  expect(tl.totalMs).toBe(plain.totalMs + 2000);
});
