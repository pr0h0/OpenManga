import { expect, test } from "bun:test";
import {
  cardFrames,
  cropsToFrame,
  fadeCuts,
  fadeFrames,
  fadeOpacity,
  frameSizeFor,
  holdFor,
  lineDrama,
  motionAt,
  motionPath,
  pageShotBox,
  panelShotBox,
  pickShorts,
  resolveMotions,
  scrollPlan,
  shotGroups,
  timeGroup,
  VIDEO_BREATH_MS,
  watermarkBox,
  youtubeChapters,
  youtubeTimestamp,
} from "./video.ts";

test("holds are frame-exact: narration + breath, at least the minimum", () => {
  // Segments are silence-trimmed when stored, so the breath is small and is the only pause added at a cut.
  expect(VIDEO_BREATH_MS).toBe(150);
  expect(holdFor(0, false, 2500, 30)).toEqual({ frames: 75, holdMs: 2500 });
  expect(holdFor(6010, true, 2500, 30)).toEqual({ frames: 185, holdMs: (185 * 1000) / 30 });
  expect(holdFor(6010, true, 2500, 30, 400)).toEqual({ frames: 193, holdMs: (193 * 1000) / 30 });
});

test("moves: push in on wide, pull out on close, pans travel the slack and keep the focus on the other axis", () => {
  const focus = { x: 0.3, y: 0.7 };
  expect(motionAt(motionPath("push-in", 0.06, focus), 0)).toEqual({ z: 1, x: 0.3, y: 0.7 });
  expect(motionAt(motionPath("push-in", 0.06, focus), 1).z).toBeCloseTo(1.06);
  expect(motionAt(motionPath("pull-out", 0.06, focus), 0).z).toBeCloseTo(1.06);
  expect(motionAt(motionPath("pan-right", 0.06, focus), 0.5)).toEqual({ z: 1.06, x: 0.5, y: 0.7 });
  expect(motionAt(motionPath("pan-up", 0.06, focus), 1)).toEqual({ z: 1.06, x: 0.3, y: 0 });
  expect(motionAt(motionPath("static", 0.06, focus), 0.7).z).toBe(1);
});

test("auto motion follows the shot type but never repeats the previous move", () => {
  const s = (shotType: string, motion?: "auto" | "static", x = 0.7, y = 0.2) => ({
    shotType,
    motion,
    focus: { x, y },
  });
  expect(resolveMotions([s("wide"), s("close"), s("medium")])).toEqual(["push-in", "pull-out", "push-in"]);
  // Two wides in a row: the second pans towards its focus instead; a third goes back to the push.
  expect(resolveMotions([s("wide"), s("wide"), s("wide")])).toEqual(["push-in", "pan-right", "push-in"]);
  // An explicit move is kept even when it repeats.
  expect(resolveMotions([s("wide", "static"), s("wide", "static")])).toEqual(["static", "static"]);
  // After a pan right, a wide whose focus also says right still gets a different move.
  expect(resolveMotions([s("wide"), s("wide"), s("close"), s("close")])).toEqual([
    "push-in",
    "pan-right",
    "pull-out",
    "pan-right",
  ]);
});

test("fades at scene breaks, with per-shot overrides", () => {
  const shots = [
    { sceneId: "a" },
    { sceneId: "a" },
    { sceneId: "b" },
    { sceneId: "b", fade: "on" as const },
    { sceneId: "c", fade: "off" as const },
  ];
  expect(fadeCuts(shots, true)).toEqual([false, false, true, true, false]);
  expect(fadeCuts(shots, false)).toEqual([false, false, false, true, false]);
  expect(fadeFrames(90, 30)).toBe(15);
  expect(fadeFrames(30, 30)).toBe(10);
  expect(fadeOpacity(0, 90, 30, { in: true, out: false })).toBe(1);
  expect(fadeOpacity(15, 90, 30, { in: true, out: false })).toBe(0);
  expect(fadeOpacity(89, 90, 30, { in: false, out: true })).toBeCloseTo(14 / 15);
});

test("a single shot times exactly as holdFor; a span shares one hold split over its shots", () => {
  const seg = (ms: number, pauseAfterMs = 350) => ({ ms, pauseAfterMs });
  const line = (segments: { ms: number; pauseAfterMs: number }[], startOffsetMs = 0, endOffsetMs = 0) => ({
    startOffsetMs,
    endOffsetMs,
    segments,
  });
  const o = { minHoldMs: 2500, fps: 30 };
  // Two lines on one shot: the first line's last pause separates them, as one concatenation.
  const one = timeGroup([line([seg(2000), seg(1500)]), line([seg(1000)])], 1, o);
  expect(one.narrationMs).toBe(2000 + 350 + 1500 + 350 + 1000);
  expect(one.frames).toEqual([holdFor(5200, true, 2500, 30).frames]);
  expect(one.starts).toEqual([[0, 2350], [4200]]);
  expect(timeGroup([], 1, o).frames).toEqual([holdFor(0, false, 2500, 30).frames]);
  // Offsets add silence before and after the line.
  const off = timeGroup([line([seg(1000)], 500, 2000)], 1, o);
  expect(off.starts).toEqual([[500]]);
  expect(off.narrationMs).toBe(3500);
  // A 9 s line over three shots: one hold of 9.15 s split evenly in whole frames, each at least the minimum.
  const span = timeGroup([line([seg(9000)])], 3, o);
  expect(span.totalFrames).toBe(275);
  expect(span.frames).toEqual([92, 92, 91]);
  expect(timeGroup([line([seg(1000)])], 3, o).frames).toEqual([75, 75, 75]);
  expect(shotGroups([false, true, true, false, false])).toEqual([
    { first: 0, last: 0 },
    { first: 1, last: 3 },
    { first: 4, last: 4 },
  ]);
});

test("16:9 shots fill the frame; other panels sit in the margin; page framing by width", () => {
  expect(panelShotBox(16 / 9, 1920, 1080)).toEqual({ full: true, w: 1920, h: 1080 });
  expect(panelShotBox(2 / 3, 1920, 1080)).toMatchObject({ full: false, w: 676, h: 1014 });
  expect(pageShotBox(1600, 2400, 1920, 1080, { framing: "width", pageWidthRatio: 0.6, pageHeightRatio: 0.96 })).toEqual(
    {
      w: 1152,
      h: 1728,
    },
  );
  // A film project's 16:9 page fills the frame instead of sitting pillarboxed with nothing to scroll.
  expect(pageShotBox(1920, 1080, 1920, 1080, { framing: "width", pageWidthRatio: 0.6, pageHeightRatio: 0.96 })).toEqual(
    { w: 1920, h: 1080 },
  );
});

test("vertical reading order breaks same-row ties left to right regardless of input order", async () => {
  const { readingOrder } = await import("./layout.ts");
  const f = (x: number, y: number) => ({ id: `${x},${y}`, frame: { x, y, width: 0.4, height: 0.3 } });
  const shuffled = [f(0.5, 0.6), f(0.03, 0.03), f(0.03, 0.6)];
  expect(readingOrder(shuffled, "vertical").map((p) => p.id)).toEqual(["0.03,0.03", "0.03,0.6", "0.5,0.6"]);
});

test("the continuous scroll framing travels the whole page, however short the hold", () => {
  expect(scrollPlan(900, 2, 60)).toEqual({ y0: 390, travel: 120 });
  expect(scrollPlan(900, 2, 60, "scroll")).toEqual({ y0: 0, travel: 900 });
  expect(scrollPlan(0, 2, 60, "scroll")).toEqual({ y0: 0, travel: 0 });
  // Framed like "width", not like the whole-page "height".
  expect(pageShotBox(800, 2400, 1920, 1080, { framing: "scroll", pageWidthRatio: 0.6, pageHeightRatio: 0.96 })).toEqual(
    pageShotBox(800, 2400, 1920, 1080, { framing: "width", pageWidthRatio: 0.6, pageHeightRatio: 0.96 }),
  );
});

test("chapter timestamps read the way YouTube expects: first at 0:00, hours only when needed", () => {
  expect(youtubeTimestamp(0)).toBe("0:00");
  expect(youtubeTimestamp(65_400)).toBe("1:05");
  expect(youtubeTimestamp(3_725_000)).toBe("1:02:05");
  expect(youtubeChapters([{ startMs: 120, title: "Chapter 1: Rain" }])).toBeNull();
  expect(
    youtubeChapters([
      { startMs: 120, title: "Chapter 1: Rain" },
      { startMs: 612_000, title: "Chapter 2: The Tunnel" },
    ]),
  ).toBe("0:00 Chapter 1: Rain\n10:12 Chapter 2: The Tunnel");
});

test("branding: the watermark box sits in its corner with even sizes; cards are whole frames", () => {
  expect(watermarkBox(1280, 720, { width: 200, height: 100 }, "bottom-right", 0.12)).toEqual({
    x: 1104,
    y: 620,
    w: 154,
    h: 78,
  });
  expect(watermarkBox(1920, 1080, { width: 100, height: 100 }, "top-left", 0.1)).toEqual({
    x: 32,
    y: 32,
    w: 192,
    h: 192,
  });
  expect(cardFrames(3000, 30)).toBe(90);
  expect(cardFrames(1500, 24)).toBe(36);
});

test("frame profiles: the height is the short side of landscape, vertical and square frames", () => {
  expect(frameSizeFor(1080)).toEqual({ frameW: 1920, frameH: 1080 });
  expect(frameSizeFor(1080, "9:16")).toEqual({ frameW: 1080, frameH: 1920 });
  expect(frameSizeFor(720, "1:1")).toEqual({ frameW: 720, frameH: 720 });
  expect(cropsToFrame("16:9")).toBe(false);
  expect(cropsToFrame("9:16")).toBe(true);
});

test("Shorts pick: dramatic shots spread across the story, within the length, in story order, never without art", () => {
  const shot = (id: string, shotType: string, text = "", holdMs = 5000, hasArt = true) => ({
    id,
    shotType,
    text,
    holdMs,
    hasArt,
  });
  expect(lineDrama("")).toBe(0);
  expect(lineDrama("Run!")).toBeGreaterThan(
    lineDrama("They walked home slowly through the quiet streets of the town."),
  );
  const story = [
    shot("a", "wide", "The city sleeps."),
    shot("b", "close", "Who's there?!"),
    shot("c", "medium"),
    shot("d", "medium"),
    shot("e", "extreme-close", "Blood on the blade!"),
    shot("f", "medium"),
    shot("g", "medium"),
    shot("h", "insert", "The secret letter."),
    shot("i", "medium", "", 5000, false),
    shot("j", "close", "Never again!", 5000, false),
    shot("k", "medium"),
    shot("l", "full"),
  ];
  expect(pickShorts(story, { targetMs: 20_000, minMs: 15_000, maxMs: 25_000 })).toEqual(["b", "e", "f", "h"]);
  // Too long: the weakest go until it fits; too short: everything usable is taken.
  expect(pickShorts(story, { targetMs: 20_000, minMs: 5000, maxMs: 10_000 })).toEqual(["b", "e"]);
  expect(pickShorts(story.slice(0, 3), { targetMs: 45_000, minMs: 30_000, maxMs: 60_000 })).toEqual(["a", "b", "c"]);
  expect(pickShorts([shot("x", "close", "", 5000, false)], { targetMs: 45_000, minMs: 30_000, maxMs: 60_000 })).toEqual(
    [],
  );
});
