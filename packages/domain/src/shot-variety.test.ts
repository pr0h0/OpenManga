import { expect, test } from "bun:test";
import { describeShotRun, repeatedShots } from "./shot-variety.ts";

const p = (id: string, shotType: string, cameraAngle: string | null = null) => ({ id, shotType, cameraAngle });

test("runs of one shot size or one framing are found; varied coverage is not", () => {
  expect(repeatedShots([p("a", "wide"), p("b", "medium"), p("c", "close"), p("d", "medium")])).toEqual([]);
  // Four medium shots from changing angles: one size run.
  const size = repeatedShots([p("a", "medium"), p("b", "medium", "low"), p("c", "medium"), p("d", "medium", "high")]);
  expect(size).toEqual([{ kind: "size", shotType: "medium", cameraAngle: null, panelIds: ["a", "b", "c", "d"] }]);
  expect(describeShotRun(size[0]!)).toBe("4 medium shots in a row");
  // Three close shots, angle unset or eye level: the same framing.
  const framing = repeatedShots([p("w", "wide"), p("a", "close"), p("b", "close", "eye-level"), p("c", "close")]);
  expect(framing).toEqual([
    { kind: "framing", shotType: "close", cameraAngle: "eye-level", panelIds: ["a", "b", "c"] },
  ]);
  expect(describeShotRun(framing[0]!)).toBe("3 close shots in a row from the same eye-level angle");
  // Three of a size with a change of angle is fine.
  expect(repeatedShots([p("a", "close"), p("b", "close", "low"), p("c", "close")])).toEqual([]);
});
