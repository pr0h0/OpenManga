import { expect, test } from "bun:test";
import { fitBox, scrollPlan } from "@openmanga/domain";
import { focusInCrop } from "@openmanga/image-utils";
import { fadeFilter, toSrt, zoompanFor } from "./video.ts";

test("scroll is capped and centred when the hold is short", () => {
  expect(scrollPlan(648, 1.1, 60)).toEqual({ y0: 291, travel: 66 });
  expect(scrollPlan(648, 20, 60)).toEqual({ y0: 0, travel: 648 });
  expect(scrollPlan(-10, 5, 60)).toEqual({ y0: 0, travel: 0 });
});

test("zoompan follows the move: zooms anchored on the focus, pans across the slack", () => {
  const focus = { x: 0.25, y: 0.75 };
  expect(zoompanFor("push-in", 0.06, focus, 90, 676, 1014, 30)).toBe(
    "zoompan=z='(1.0000+0.0600*on/90)':x='(iw-iw/zoom)*0.2500':y='(ih-ih/zoom)*0.7500':d=1:s=676x1014:fps=30",
  );
  expect(zoompanFor("pull-out", 0.1, focus, 0, 2, 2, 24)).toContain("z='(1.1000-0.1000*on/1)'");
  expect(zoompanFor("pan-left", 0.06, focus, 90, 2, 2, 30)).toContain(
    "z='1.0600':x='(iw-iw/zoom)*(1.0000-1.0000*on/90)':y='(ih-ih/zoom)*0.7500'",
  );
  expect(zoompanFor("static", 0.06, focus, 90, 2, 2, 30)).toContain("z='1.0000'");
});

test("scene-break fades are frame counted and never longer than a third of the clip", () => {
  expect(fadeFilter({ in: false, out: false }, 90, 30)).toBe("");
  expect(fadeFilter({ in: true, out: true }, 90, 30)).toBe(",fade=t=in:s=0:n=15,fade=t=out:s=75:n=15");
  expect(fadeFilter({ in: true, out: false }, 30, 30)).toBe(",fade=t=in:s=0:n=10");
});

test("panels fit inside the frame margin with even dimensions", () => {
  expect(fitBox(2 / 3, 1804.8, 1015.2)).toEqual({ w: 676, h: 1014 });
  expect(fitBox(21 / 9, 1804.8, 1015.2)).toEqual({ w: 1804, h: 772 });
});

test("srt cues are numbered with hh:mm:ss,mmm times", () => {
  expect(
    toSrt([
      { startMs: 0, endMs: 1500, text: "One." },
      { startMs: 3_723_004, endMs: 3_725_000, text: " Two. " },
    ]),
  ).toBe("1\n00:00:00,000 --> 00:00:01,500\nOne.\n\n2\n01:02:03,004 --> 01:02:05,000\nTwo.\n");
});

test("the move is aimed at the image focus inside the visible crop", () => {
  // centred focus on a matching aspect: centre
  expect(focusInCrop(2048, 1152, 16 / 9, { focalX: 0.5, focalY: 0.5, scale: 1 })).toEqual({ x: 0.5, y: 0.5 });
  // no room to pan on a matching aspect: focus maps to its own position
  expect(focusInCrop(2048, 1152, 16 / 9, { focalX: 0.8, focalY: 0.3, scale: 1 })).toEqual({ x: 0.8, y: 0.3 });
  // zoomed crop centred on the focus: centre of the crop
  const f = focusInCrop(2048, 1152, 16 / 9, { focalX: 0.6, focalY: 0.5, scale: 2 });
  expect(f.x).toBeCloseTo(0.5, 2);
});
