import { expect, test } from "bun:test";
import { edgeDepth, edgeOutline, outlinePath } from "./edge.ts";

const box = [
  { x: 100, y: 100 },
  { x: 500, y: 100 },
  { x: 500, y: 400 },
  { x: 100, y: 400 },
];
const inside = (p: { x: number; y: number }) =>
  p.x >= 100 - 1e-6 && p.x <= 500 + 1e-6 && p.y >= 100 - 1e-6 && p.y <= 400 + 1e-6;

test("straight, size 0 or no style leave the shape as it is", () => {
  expect(edgeOutline(box, { style: "straight", size: 1 }, 1000, "a")).toEqual(box);
  expect(edgeOutline(box, { style: "torn", size: 0 }, 1000, "a")).toEqual(box);
  expect(edgeOutline(box, undefined, 1000, "a")).toEqual(box);
});

test("every style cuts only inwards, keeps the corners, and is the same for the same seed", () => {
  for (const style of ["wavy", "torn", "rough", "brush", "burnt"] as const) {
    const e = { style, size: 1 };
    const o = edgeOutline(box, e, 1000, "panel-1");
    expect(o.length).toBeGreaterThan(box.length);
    expect(o.every(inside)).toBe(true);
    for (const corner of box) expect(o).toContainEqual(corner);
    // Deep enough to see: some point sits well inside the box.
    const depth = Math.max(...o.map((p) => Math.min(p.x - 100, 500 - p.x, p.y - 100, 400 - p.y)));
    expect(depth).toBeGreaterThan(edgeDepth(e, 1000) * 0.3);
    expect(edgeOutline(box, e, 1000, "panel-1")).toEqual(o);
  }
  // Another seed tears differently.
  expect(edgeOutline(box, { style: "torn", size: 1 }, 1000, "panel-2")).not.toEqual(
    edgeOutline(box, { style: "torn", size: 1 }, 1000, "panel-1"),
  );
});

test("a wave comes back to each corner with whole waves", () => {
  const o = edgeOutline(box, { style: "wavy", size: 1 }, 1000, "x");
  expect(outlinePath(o)).toStartWith("M100.0 100.0 L");
  expect(outlinePath(o)).toEndWith(" Z");
});
