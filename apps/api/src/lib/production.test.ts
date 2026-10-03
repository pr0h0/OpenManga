import { expect, test } from "bun:test";
import { initialSteps } from "./production.ts";

const o = { reviewGates: false, preparePrompts: true, render: true, youtube: false };
const keys = (steps: { key: string }[]) => steps.map((s) => s.key);

test("an update runs from the first stale stage on; a revised story re-analyses and always reviews", () => {
  expect(keys(initialSteps({ ...o, update: true }, ["render"]))).toEqual(["render"]);
  expect(keys(initialSteps({ ...o, update: true }, ["audio", "render"]))).toEqual(["audio", "render"]);
  // New artwork leaves narration current but the video stale: everything after art runs, and finds what to do. The
  // changed-narration review is always a step and skips itself when no chapter's narration is out of date.
  expect(keys(initialSteps({ ...o, update: true }, ["art"]))).toEqual([
    "art",
    "review_narration",
    "narration",
    "audio",
    "render",
  ]);
  expect(keys(initialSteps({ ...o, update: true, reviewGates: true, youtube: true }, ["render"]))).toEqual([
    "review_render",
    "render",
    "youtube_package",
  ]);
  // A revised story is re-analysed and reviewed (whatever the review setting), then everything after it can run.
  expect(keys(initialSteps({ ...o, update: true }, ["story"]))).toEqual([
    "analyze",
    "review_analysis",
    "apply",
    "references",
    "review_plans",
    "plan",
    "prompts",
    "art",
    "review_narration",
    "narration",
    "audio",
    "render",
  ]);
  // A full run starts at the analysis; its review step is always there and skips itself when not needed.
  expect(keys(initialSteps(o)).slice(0, 3)).toEqual(["analyze", "review_analysis", "apply"]);
});
