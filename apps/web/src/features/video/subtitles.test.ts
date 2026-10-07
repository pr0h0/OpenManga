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
