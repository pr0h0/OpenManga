import { expect, test } from "bun:test";
import { autoFixDecision, MAX_AUTO_REGENERATIONS, visualCheckModes } from "./visual-checks.ts";

const modes = visualCheckModes({ outfit: "regenerate_once", props: "regenerate_budget", covered_faces: "flag" });
const decide = (failed: Parameters<typeof autoFixDecision>[0]["failed"], attempt = 0, spentUsd = 0) =>
  autoFixDecision({ failed, modes, attempt, spentUsd, budgetUsd: 1 }).regenerate;

test("defaults fill aspects a project leaves out", () => {
  expect(modes.headcount).toBe("flag");
  expect(modes.palette).toBe("off");
  expect(modes.outfit).toBe("regenerate_once");
});

test("flag-only failures never regenerate", () => {
  expect(decide(["headcount", "identity"])).toBe(false);
  expect(decide(["covered_faces"])).toBe(false);
  expect(decide([])).toBe(false);
});

test("regenerate once: only the first time", () => {
  expect(decide(["outfit"], 0)).toBe(true);
  expect(decide(["outfit"], 1)).toBe(false);
});

test("regenerate to a budget: while under it and under the attempt cap", () => {
  expect(decide(["props"], 2, 0.5)).toBe(true);
  expect(decide(["props"], 1, 1)).toBe(false);
  expect(decide(["props"], MAX_AUTO_REGENERATIONS, 0)).toBe(false);
  // The budget mode wins over regenerate once when both fail.
  expect(decide(["outfit", "props"], 1, 0)).toBe(true);
});
