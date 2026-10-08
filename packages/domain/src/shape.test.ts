import { expect, test } from "bun:test";
import { clampFrame, splitFrame } from "./layout.ts";
import {
  frameFromPolygon,
  framePath,
  framePolygon,
  inFrame,
  insertFramePoint,
  moveFramePoint,
  removeFramePoint,
} from "./shape.ts";

const box = { x: 0.1, y: 0.2, width: 0.4, height: 0.3 };

test("a plain frame is its box's four corners, and back", () => {
  expect(framePolygon(box)).toEqual([
    { x: 0.1, y: 0.2 },
    { x: 0.5, y: 0.2 },
    { x: 0.5, y: 0.5 },
    { x: 0.1, y: 0.5 },
  ]);
  expect(frameFromPolygon(framePolygon(box))).toEqual(box);
  expect(framePath(box, 100, 100)).toBe("M10.0 20.0 L50.0 20.0 L50.0 50.0 L10.0 50.0 Z");
});

test("a point added on the top edge and raised gives a pointed top; the box grows to bound it", () => {
  const five = insertFramePoint(box, 0);
  expect(framePolygon(five).length).toBe(5);
  // Kept even while it sits on the edge, so it can be dragged.
  expect(five.points?.length).toBe(5);
  const peaked = moveFramePoint(five, 1, { x: 0.3, y: 0.1 });
  expect(peaked).toMatchObject({ x: 0.1, y: 0.1, width: 0.4, height: 0.4 });
  expect(peaked.points?.[1]).toEqual({ x: 0.5, y: 0 });
  // Moving the box carries the outline with it.
  const moved = clampFrame({ ...peaked, x: 0.2 });
  expect(framePolygon(moved)[1]).toEqual({ x: 0.4, y: 0.1 });
  expect(inFrame(peaked, { x: 0.3, y: 0.15 })).toBe(true);
  expect(inFrame(peaked, { x: 0.12, y: 0.12 })).toBe(false);
});

test("a slanted gutter: two panels sharing a diagonal", () => {
  const left = frameFromPolygon([
    { x: 0, y: 0 },
    { x: 0.6, y: 0 },
    { x: 0.4, y: 1 },
    { x: 0, y: 1 },
  ]);
  expect(left).toMatchObject({ x: 0, y: 0, width: 0.6, height: 1 });
  expect(left.points?.length).toBe(4);
  expect(inFrame(left, { x: 0.55, y: 0.9 })).toBe(false);
});

test("points stay between three and 24, and off-page points are clamped", () => {
  const tri = removeFramePoint(box, 0);
  expect(framePolygon(tri).length).toBe(3);
  expect(framePolygon(removeFramePoint(tri, 0)).length).toBe(3);
  const out = moveFramePoint(box, 0, { x: -0.5, y: -0.5 });
  expect(out).toMatchObject({ x: 0, y: 0 });
});

test("splitting a shaped panel gives two rectangles", () => {
  const peaked = moveFramePoint(insertFramePoint(box, 0), 1, { x: 0.3, y: 0.1 });
  const [a, b] = splitFrame(peaked, "vertical");
  expect(a.points).toBeUndefined();
  expect(b.points).toBeUndefined();
});
