import { describe, expect, test } from "bun:test";
import { elapsedLabel, placeOnTimeline, type TimelinePoint, timelineView } from "./timeline.ts";

const ev = (id: string, o: Partial<TimelinePoint>): TimelinePoint => ({
  id,
  kind: "event",
  day: null,
  characterIds: [],
  chapter: null,
  scene: null,
  ...o,
});

describe("timeline", () => {
  test("elapsed labels", () => {
    expect([0, 0.25, 3, 21, 90, 3650].map(elapsedLabel)).toEqual([
      "the same day",
      "6 hours",
      "3 days",
      "3 weeks",
      "3 months",
      "10 years",
    ]);
  });

  test("elapsed since the previous dated event, ages from births, a day running backwards flagged", () => {
    const v = timelineView([
      ev("b", { kind: "birth", day: 0, characterIds: ["mira"] }),
      ev("a", { day: 365.25 * 17 + 10, characterIds: ["mira", "tom"] }),
      ev("u", {}),
      ev("c", { day: 365.25 * 17 + 13, characterIds: ["mira"] }),
      ev("x", { day: 100 }),
    ]);
    expect(v.map((e) => e.elapsed)).toEqual([null, "17 years", null, "3 days", "17 years"]);
    expect(v[1]!.ages).toEqual({ mira: 17 });
    expect(v.map((e) => e.outOfOrder)).toEqual([false, false, false, false, true]);
  });

  test("a state finds the event of its chapter and scene, else the nearest earlier chapter", () => {
    const events = [
      ev("e1", { chapter: 1 }),
      ev("e2", { chapter: 2, scene: 1 }),
      ev("e3", { chapter: 2, scene: 3 }),
      ev("e4", { chapter: 5 }),
    ];
    expect(placeOnTimeline(events, { chapter: 2, scene: 2 })).toBe("e2");
    expect(placeOnTimeline(events, { chapter: 2, scene: 4 })).toBe("e3");
    expect(placeOnTimeline(events, { chapter: 2, scene: null })).toBe("e2");
    expect(placeOnTimeline(events, { chapter: 4, scene: null })).toBe("e3");
    expect(placeOnTimeline(events, { chapter: null, scene: null })).toBeNull();
    expect(placeOnTimeline([ev("e5", { chapter: 3 })], { chapter: 1, scene: null })).toBeNull();
  });
});
