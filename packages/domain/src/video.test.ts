import { expect, test } from "bun:test";
import { holdFor, kenBurnsZoomAt, pageShotBox, panelShotBox, scrollPlan, VIDEO_BREATH_MS } from "./video.ts";

test("holds are frame-exact: narration + breath, at least the minimum", () => {
  // Segments are silence-trimmed when stored, so the breath is small and is the only pause added at a cut.
  expect(VIDEO_BREATH_MS).toBe(150);
  expect(holdFor(0, false, 2500, 30)).toEqual({ frames: 75, holdMs: 2500 });
  expect(holdFor(6010, true, 2500, 30)).toEqual({ frames: 185, holdMs: (185 * 1000) / 30 });
  expect(holdFor(6010, true, 2500, 30, 400)).toEqual({ frames: 193, holdMs: (193 * 1000) / 30 });
});

test("zoom curve matches zoompan: push in on wide, pull out on close", () => {
  expect(kenBurnsZoomAt("wide", 0.06, 0)).toBe(1);
  expect(kenBurnsZoomAt("wide", 0.06, 1)).toBeCloseTo(1.06);
  expect(kenBurnsZoomAt("close", 0.06, 0)).toBeCloseTo(1.06);
  expect(kenBurnsZoomAt("close", 0.06, 1)).toBeCloseTo(1);
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
