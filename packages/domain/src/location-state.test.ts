import { expect, test } from "bun:test";
import { type LocationStateRule, pickLocationState } from "./location-state.ts";

const states: LocationStateRule[] = [
  { id: "night", keywords: ["night"], from: null, until: null },
  { id: "snow", keywords: ["snow", "blizzard"], from: null, until: null },
  { id: "ruined", keywords: [], from: 7, until: null },
  { id: "ruined-night", keywords: ["night"], from: 7, until: null },
  { id: "manual", keywords: [], from: null, until: null },
];
const at = (chapter: number | null, time = "", weather = "", explicit: string | null = null) => ({
  chapter,
  time,
  weather,
  explicit,
});

test("a scene's own pick, then time or weather words, then the chapter range; the latest start wins", () => {
  expect(pickLocationState(states, at(2, "late night", "", "manual"))).toBe("manual");
  expect(pickLocationState(states, at(2, "Late NIGHT"))).toBe("night");
  expect(pickLocationState(states, at(2, "morning", "light snow"))).toBe("snow");
  expect(pickLocationState(states, at(8, "night"))).toBe("ruined-night");
  expect(pickLocationState(states, at(8, "noon"))).toBe("ruined");
  expect(pickLocationState(states, at(3, "noon"))).toBeNull();
  // Whole words only: "nightfall" is not "night".
  expect(pickLocationState(states, at(2, "nightfall"))).toBeNull();
  // A pick that is not one of this place's states is ignored.
  expect(pickLocationState(states, at(2, "noon", "", "elsewhere"))).toBeNull();
  expect(pickLocationState(states, at(null, "night"))).toBe("night");
});
