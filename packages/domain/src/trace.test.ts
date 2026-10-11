import { describe, expect, test } from "bun:test";
import { locateSpan, sentenceSpans, traceSpans } from "./trace.ts";

const TEXT = [
  "Mira climbed the lighthouse stairs in the storm.",
  "At the top she found the lamp dark and the keeper gone.",
  '"Who turned it off?" she whispered.',
  "",
  "Down in the harbour, a fishing boat drifted toward the rocks.",
  "Its captain waved a red lantern at the black tower.",
].join("\n");

describe("traceSpans", () => {
  test("splits sentences with exact offsets", () => {
    const s = sentenceSpans(TEXT);
    expect(s).toHaveLength(5);
    expect(TEXT.slice(s[2]!.start, s[2]!.end)).toBe('"Who turned it off?" she whispered.');
  });

  test("aligns panels in order, dialogue anchors, every sentence covered", () => {
    const spans = traceSpans(TEXT, [
      { beat: "Mira climbs the stairs of the lighthouse in heavy rain" },
      { beat: "She stares at the dark lamp", dialogue: ["Who turned it off?"] },
      { beat: "A boat drifts toward the rocks in the harbour" },
      { beat: "The captain waves a red lantern" },
    ]);
    expect(spans.map((s) => s!.text.split("\n")[0])).toEqual([
      "Mira climbed the lighthouse stairs in the storm.",
      "At the top she found the lamp dark and the keeper gone.",
      "Down in the harbour, a fishing boat drifted toward the rocks.",
      "Its captain waved a red lantern at the black tower.",
    ]);
    // The quoted line anchors the second panel; the sentence before it reads more like that panel than the first.
    expect(spans[1]!.text).toContain("Who turned it off?");
    expect(spans[0]!.text).not.toContain("keeper gone");
    expect(spans[3]!.end).toBe(TEXT.length);
  });

  test("never goes backwards, and handles no text", () => {
    const spans = traceSpans(TEXT, [{ beat: "red lantern captain" }, { beat: "Mira lighthouse stairs" }]);
    expect(spans[1]!.start).toBeGreaterThanOrEqual(spans[0]!.start);
    expect(traceSpans("", [{ beat: "x" }])).toEqual([null]);
  });
});

describe("locateSpan", () => {
  const [span] = traceSpans(TEXT, [{ beat: "Mira lighthouse stairs" }]);
  test("same place, moved, changed", () => {
    expect(locateSpan(TEXT, span!).changed).toBe(false);
    const moved = `A new opening line.\n${TEXT}`;
    const at = locateSpan(moved, span!);
    expect(moved.slice(at.start, at.end)).toBe(span!.text);
    expect(locateSpan(TEXT.replace("storm", "snow"), span!).changed).toBe(true);
  });
});
