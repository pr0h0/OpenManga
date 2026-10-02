import { expect, test } from "bun:test";
import {
  canvasSize,
  commit,
  containRect,
  type Drawing,
  history,
  hitHandle,
  isEmpty,
  moveHandle,
  redo,
  standingFigure,
  torso,
  undo,
} from "./guide-draw.ts";

test("the canvas has the panel's shape with a 1024 px long side", () => {
  expect(canvasSize(2)).toEqual({ width: 1024, height: 512 });
  expect(canvasSize(0.5)).toEqual({ width: 512, height: 1024 });
  expect(canvasSize(Number.NaN)).toEqual({ width: 1024, height: 1024 });
  expect(containRect(200, 100, 1000, 1000)).toEqual({ x: 0, y: 250, width: 1000, height: 500 });
});

test("undo and redo walk the history, and a new stroke drops what was undone", () => {
  const empty: Drawing = { marks: [], figures: [], base: false };
  const a = { ...empty, marks: [{ tool: "pen" as const, width: 4, points: [[0, 0]] as [number, number][] }] };
  let h = commit(history(empty), a);
  expect(h.stack[h.at]).toBe(a);
  h = undo(h);
  expect(h.stack[h.at]).toBe(empty);
  expect(undo(h).at).toBe(0);
  expect(redo(h).stack[redo(h).at]).toBe(a);
  h = commit(h, { ...empty, base: true });
  expect(h.stack).toHaveLength(2);
  expect(redo(h).at).toBe(1);
  expect(isEmpty(empty)).toBe(true);
  expect(isEmpty({ ...empty, marks: [{ tool: "eraser", width: 4, points: [[1, 1]] }] })).toBe(true);
  expect(isEmpty(a)).toBe(false);
});

test("a stick figure's joints drag one at a time, and its torso moves the whole figure", () => {
  const f = standingFigure(500, 1000);
  const hand = hitHandle([f], [f.lHand[0] + 5, f.lHand[1]], 20);
  expect(hand).toEqual({ figure: 0, joint: "lHand" });
  const raised = moveHandle(f, "lHand", [400, 100]);
  expect(raised.lHand).toEqual([400, 100]);
  expect(raised.head).toEqual(f.head);
  const t = torso(f);
  expect(hitHandle([f], t, 20)?.joint).toBe("torso");
  const moved = moveHandle(f, "torso", [t[0] + 100, t[1]]);
  expect(moved.head[0]).toBeCloseTo(f.head[0] + 100);
  expect(moved.rFoot[1]).toBeCloseTo(f.rFoot[1]);
  expect(hitHandle([f], [0, 0], 20)).toBeNull();
});
