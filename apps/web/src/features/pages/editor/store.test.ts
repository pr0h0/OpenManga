import { expect, test } from "bun:test";
import { computeCrop, panImageTransform, useEditor } from "./store.ts";

test("panning moves the crop opposite to the drag and never past the image edge", () => {
  const t = { focalX: 0.5, focalY: 0.5, scale: 1 };
  // 1024x1536 portrait art in a wide 800x400 frame: crop is full width, can only move vertically
  const down = panImageTransform(1024, 1536, 800, 400, t, 0, 100);
  expect(down.focalY).toBeLessThan(0.5);
  expect(down.focalX).toBe(0.5);
  const far = panImageTransform(1024, 1536, 800, 400, t, 0, -100_000);
  const crop = computeCrop(1024, 1536, 2, far);
  expect(crop.y + crop.height).toBeCloseTo(1536, 0);
  expect(far.focalY).toBeCloseTo(1 - crop.height / 2 / 1536, 3);
  const zoomed = panImageTransform(1024, 1536, 800, 400, t, 50, 0, 2);
  expect(zoomed.scale).toBe(2);
  expect(zoomed.focalX).toBeLessThan(0.5);
  expect(panImageTransform(1024, 1536, 800, 400, t, 0, 0, 20).scale).toBe(8);
});

test("a page opens on the panel a link names, else on its first panel", () => {
  const panel = (id: string, order: number) => ({ id, order, frame: { x: 0, y: 0, w: 1, h: 1 }, imageTransform: null });
  const doc = (...p: ReturnType<typeof panel>[]) =>
    ({ panels: p, dialogue: [], narration: [], sfx: [] }) as unknown as Parameters<
      ReturnType<typeof useEditor.getState>["hydrate"]
    >[1];
  const d = doc(panel("b", 2), panel("a", 1), panel("c", 3));
  useEditor.getState().hydrate("page-1", d, "c");
  expect(useEditor.getState().selection).toEqual({ type: "panel", ids: ["c"] });
  // A panel id that is not on this page (a stale link) falls back to the first panel.
  useEditor.getState().hydrate("page-2", d, "gone");
  expect(useEditor.getState().selection).toEqual({ type: "panel", ids: ["a"] });
  useEditor.getState().hydrate("page-3", d);
  expect(useEditor.getState().selection).toEqual({ type: "panel", ids: ["a"] });
  // Refreshing the page already open keeps what the user selected since.
  useEditor.getState().select({ type: "panel", ids: ["b"] });
  useEditor.getState().hydrate("page-3", d, "c");
  expect(useEditor.getState().selection).toEqual({ type: "panel", ids: ["b"] });
});
