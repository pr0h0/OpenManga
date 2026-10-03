import { expect, test } from "bun:test";
import { type TimingShot, timingFixes, timingIssues, timingSettings } from "./timing.ts";
import { timeGroup } from "./video.ts";

const s = timingSettings({ minShotSeconds: 4, maxShotSeconds: 8 }, 2500);
const line = (id: string, ms: number[], pauseAfterMs = 350, text = "one two three four five six") => ({
  id,
  text,
  startOffsetMs: 0,
  endOffsetMs: 0,
  segments: ms.map((m) => ({ ms: m, pauseAfterMs })),
});
const shot = (
  key: string,
  lines: TimingShot["lines"],
  sceneId = "s1",
  extra: Partial<TimingShot> = {},
): TimingShot => ({
  key,
  label: key,
  panelId: key,
  sceneId,
  joinNext: false,
  minHoldMs: null,
  lines,
  ...extra,
});

test("a shot's own minimum hold replaces the export's; equal minimums split a span as before", () => {
  expect(timeGroup([], 1, { minHoldMs: 2500, fps: 30, minHolds: [4000] }).frames).toEqual([120]);
  expect(timeGroup([], 1, { minHoldMs: 2500, fps: 30, minHolds: [null] }).frames).toEqual([75]);
  // A 9 s line over three shots: 275 frames, as the even split always gave.
  const l = [{ startOffsetMs: 0, endOffsetMs: 0, segments: [{ ms: 9000, pauseAfterMs: 0 }] }];
  expect(timeGroup(l, 3, { minHoldMs: 2500, fps: 30 }).frames).toEqual([92, 92, 91]);
  // A longer minimum on one shot: each gets its minimum, the rest is shared.
  expect(timeGroup([], 2, { minHoldMs: 2500, fps: 30, minHolds: [5000, null] }).frames).toEqual([150, 75]);
});

test("issues: long, flash, still and dead air", () => {
  const shots = [
    shot("long", [line("a", [9000])]),
    shot("flash", [], "s1", { minHoldMs: null }),
    shot("still", [line("b", [14_000])]),
    shot("gap", [line("c", [1000], 4000), line("d", [1000])]),
    shot("tail", [line("e", [500])], "s1", { minHoldMs: 6000 }),
  ];
  const { issues } = timingIssues(shots, s);
  expect(issues.map((i) => [i.key, i.kind])).toEqual([
    ["long", "long"],
    ["flash", "flash"],
    ["still", "still"],
    // 4 s pause between two lines; a 0.5 s line held for its 6 s minimum.
    ["gap", "silence"],
    ["tail", "silence"],
  ]);
  expect(issues.find((i) => i.key === "gap")!.ms).toBe(4000);
});

test("fixes: spread a long line over the next shots of its scene; holds within min and max; trim to target", () => {
  const shots = [
    shot("p1", [line("a", [15_000])]),
    shot("p2", []),
    shot("p3", [], "other"),
    shot("p4", [line("b", [500])], "other", { minHoldMs: 7000 }),
  ];
  const { spread, holds, trim } = timingFixes(shots, s, 60_000);
  // 15.15 s needs two shots of at most 8 s: the line spans p1 and p2; p3 is another scene.
  expect(spread).toMatchObject([{ lineId: "a", fromKey: "p1", untilPanelId: "p2", shots: 2 }]);
  expect(spread[0]!.holds.find((h) => h.key === "p1")!.afterMs).toBeLessThan(8000);
  expect(spread[0]!.deltaMs).toBeLessThanOrEqual(0);
  // p2 and p3 flash under 4 s; p4 is padded to 7 s for 0.65 s of narration.
  expect(holds.map((h) => [h.key, h.holdMs])).toEqual([
    ["p2", 4000],
    ["p3", 4000],
    ["p4", 4000],
  ]);
  // 60 s target against ~27 s: lines get longer budgets (capped at 1.5x).
  expect(trim.map((t) => [t.lineId, t.words, t.budget])).toEqual([
    ["a", 6, 9],
    ["b", 6, 9],
  ]);
  expect(timingFixes(shots, s, null).trim).toEqual([]);
});
