import { expect, test } from "bun:test";
import { customLayoutFrames, mirrorFrame, pickLayout } from "./layout.ts";

const peaked = {
  x: 0.1,
  y: 0.1,
  width: 0.5,
  height: 0.4,
  points: [
    { x: 0, y: 0.2 },
    { x: 0.8, y: 0 },
    { x: 1, y: 1 },
    { x: 0, y: 1 },
  ],
};

test("mirroring flips the box and a shaped panel's outline", () => {
  const m = mirrorFrame(peaked);
  expect(m.x).toBe(0.4);
  expect(m.points).toEqual([
    { x: 1, y: 0.2 },
    { x: 0.2, y: 0 },
    { x: 0, y: 1 },
    { x: 1, y: 1 },
  ]);
  expect(mirrorFrame(m)).toEqual(peaked);
});

test("a layout is used as made, mirrored for the other reading direction, never for vertical strips", () => {
  const l = { frames: [peaked], readingDirection: "ltr" as const };
  expect(customLayoutFrames(l, "ltr")).toEqual([peaked]);
  expect(customLayoutFrames(l, "rtl")[0]!.x).toBe(0.4);
  expect(customLayoutFrames(l, "vertical")).toEqual([peaked]);
});

test("pages take layouts with their panel count in turn; none fits, none", () => {
  const a = { id: "a", frames: [peaked, peaked] };
  const b = { id: "b", frames: [peaked, peaked] };
  const c = { id: "c", frames: [peaked] };
  const set = [a, c, b];
  expect([0, 1, 2, 3].map((k) => pickLayout(set, 2, k)?.id)).toEqual(["a", "b", "a", "b"]);
  expect(pickLayout(set, 1, 5)?.id).toBe("c");
  expect(pickLayout(set, 3, 0)).toBeNull();
  expect(pickLayout(undefined, 2, 0)).toBeNull();
});
