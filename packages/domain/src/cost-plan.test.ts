import { expect, test } from "bun:test";
import { DEFAULT_UNIT_USAGE, narrationSeconds, planUnitsUsd, sumUsd } from "./cost-plan.ts";

const rate = {
  provider: "p",
  model: "m",
  effectiveFrom: "2020-01-01",
  textInputRate: 1,
  cachedInputRate: 0.1,
  textOutputRate: 4,
  imageInputRate: 0,
  imageOutputRate: 40,
};

test("units are priced from this server's history when it has one, else the defaults; unknown prices stay unknown", () => {
  // 14k in at $1/M and 12k out at $4/M.
  expect(planUnitsUsd("chapter_plan", 2, rate)).toBeCloseTo(2 * (0.014 + 0.048), 6);
  const history = { chapter_plan: { ...DEFAULT_UNIT_USAGE.chapter_plan, textOutputTokens: 1_000 } };
  expect(planUnitsUsd("chapter_plan", 1, rate, history)).toBeCloseTo(0.014 + 0.004, 6);
  expect(planUnitsUsd("panel_generation", 0, null)).toBe(0);
  expect(planUnitsUsd("panel_generation", 3, null)).toBeNull();
  expect(sumUsd([1, 0.5, 0])).toBe(1.5);
  expect(sumUsd([1, null])).toBeNull();
  expect(narrationSeconds(150)).toBe(60);
  expect(narrationSeconds(150, 100)).toBe(90);
});
