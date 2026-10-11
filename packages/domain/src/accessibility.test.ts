import { expect, test } from "bun:test";
import { contrastRatio, expectedReadingOrder, letteringIssues, panelAltText } from "./accessibility.ts";

test("alt text: the beat, then who says what, then the sounds", () => {
  expect(
    panelAltText({
      beat: "Woo Jin climbs onto the rooftop in the rain",
      dialogue: [
        { speaker: "Woo Jin", text: "Who's there?" },
        { speaker: null, text: "  Footsteps.  " },
      ],
      sfx: ["BANG"],
    }),
  ).toBe("Woo Jin climbs onto the rooftop in the rain. Woo Jin: “Who's there?” “Footsteps.” Sound: BANG.");
});

test("contrast follows WCAG: black on white 21, grey on white under AA, a non-hex colour unknown", () => {
  expect(contrastRatio("#000", "#ffffff")).toBe(21);
  expect(contrastRatio("#999999", "#ffffff")!).toBeLessThan(4.5);
  expect(contrastRatio("transparent", "#fff")).toBeNull();
});

test("lettering: faint text and text too small for the format", () => {
  const line = (id: string, fontSize: number, textColor: string) => ({
    id,
    text: id,
    bubble: { fontSize, textColor, background: "#ffffff" },
  });
  const issues = letteringIssues(
    [line("ok", 34, "#111111"), line("faint", 34, "#aaaaaa"), line("tiny", 20, "#111")],
    1600,
    "comic",
  );
  expect(issues.map((i) => [i.kind, i.lineId])).toEqual([
    ["contrast", "faint"],
    ["size", "tiny"],
  ]);
  // The same 34 px is small on an 800 px strip read on a phone.
  expect(letteringIssues([line("strip", 20, "#111")], 800, "vertical")[0]?.kind).toBe("size");
});

test("reading order: rows top to bottom, left to right, or right to left in a manga", () => {
  const f = (id: string, x: number, y: number, w = 0.45, h = 0.3) => ({ id, frame: { x, y, width: w, height: h } });
  const page = [f("bottom", 0, 0.66, 1), f("top-right", 0.5, 0), f("top-left", 0, 0.02), f("middle", 0, 0.33, 1)];
  expect(expectedReadingOrder(page, false)).toEqual(["top-left", "top-right", "middle", "bottom"]);
  expect(expectedReadingOrder(page, true)).toEqual(["top-right", "top-left", "middle", "bottom"]);
});
