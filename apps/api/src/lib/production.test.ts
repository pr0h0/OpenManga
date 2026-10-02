import { expect, test } from "bun:test";
import { initialSteps } from "./production.ts";

const o = { reviewGates: false, preparePrompts: true, render: true, youtube: false };
const keys = (steps: { key: string }[]) => steps.map((s) => s.key);

test("an update runs from the first stale stage on, and nothing for a story change alone", () => {
  expect(keys(initialSteps({ ...o, update: true }, ["render"]))).toEqual(["render"]);
  expect(keys(initialSteps({ ...o, update: true }, ["audio", "render"]))).toEqual(["audio", "render"]);
  // New artwork leaves narration current but the video stale: everything after art runs, and finds what to do.
  expect(keys(initialSteps({ ...o, update: true }, ["art"]))).toEqual(["art", "narration", "audio", "render"]);
  expect(keys(initialSteps({ ...o, update: true, reviewGates: true, youtube: true }, ["render"]))).toEqual([
    "review_render",
    "render",
    "youtube_package",
  ]);
  expect(initialSteps({ ...o, update: true }, ["story"])).toEqual([]);
  // A full run is unchanged.
  expect(keys(initialSteps(o))[0]).toBe("analyze");
});
