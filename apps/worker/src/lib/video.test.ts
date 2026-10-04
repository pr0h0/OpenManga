import { expect, test } from "bun:test";
import { captionsSupported, fitBox, scrollPlan } from "@openmanga/domain";
import { focusInCrop } from "@openmanga/image-utils";
import { captionChunks, fadeFilter, toAss, toSrt, zoompanFor } from "./video.ts";

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

test("Shorts captions split a cue into even word groups timed by length", () => {
  const cue = { startMs: 1000, endMs: 4000, text: "one two three four five six seven" };
  const bottom = captionChunks([cue], "bottom");
  // 7 words at most 5 per caption: 4 + 3, not 5 + 2.
  expect(bottom.map((c) => c.text)).toEqual(["one two three four", "five six seven"]);
  expect(bottom[0]!.startMs).toBe(1000);
  expect(bottom[0]!.endMs).toBe(bottom[1]!.startMs);
  expect(bottom[1]!.endMs).toBe(4000);
  expect(captionChunks([cue], "two_line").map((c) => c.text)).toEqual(["one two three four\nfive six seven"]);
  expect(captionChunks([{ ...cue, text: "  " }], "center")).toEqual([]);
});

test("the ASS file is sized to the frame and escapes override braces", () => {
  const ass = toAss([{ startMs: 0, endMs: 61_250, text: "Hi {there}" }], "center", 1080, 1920);
  expect(ass).toContain("PlayResX: 1080\nPlayResY: 1920");
  expect(ass).toContain("Style: Default,DejaVu Sans,97,");
  expect(ass).toContain("Dialogue: 0,0:00:00.00,0:01:01.25,Default,,0,0,0,,Hi there");
});

test("captions: long words and text without spaces are broken to fit, timing stays inside the cue", () => {
  const long = captionChunks([{ startMs: 0, endMs: 1000, text: "Donaudampfschifffahrtsgesellschaft sank" }], "center");
  expect(long.map((c) => c.text)).toEqual(["Donaudampf schifffahr tsgesellsc", "haft sank"]);
  // A script written without spaces is cut by characters, never one caption the width of the whole line.
  const cjk = captionChunks(
    [{ startMs: 500, endMs: 2500, text: "彼は屋上の扉を押し開けて女帝が机に伏しているのを見た" }],
    "bottom",
  );
  expect(cjk.every((c) => [...c.text.replaceAll(" ", "")].length <= 16 * 5)).toBe(true);
  expect(cjk.flatMap((c) => c.text.split(" ")).every((w) => [...w].length <= 16)).toBe(true);
  for (const chunks of [long, cjk]) {
    for (const [i, c] of chunks.entries()) {
      expect(c.endMs).toBeGreaterThanOrEqual(c.startMs);
      if (i) expect(c.startMs).toBe(chunks[i - 1]!.endMs);
    }
  }
  expect(cjk[0]!.startMs).toBe(500);
  expect(cjk.at(-1)!.endMs).toBe(2500);
});

test("captions: empty and zero-length cues, and text that could break the ASS file", () => {
  expect(captionChunks([{ startMs: 0, endMs: 0, text: "\n \t" }], "bottom")).toEqual([]);
  expect(captionChunks([{ startMs: 100, endMs: 100, text: "Now." }], "bottom")).toEqual([
    { startMs: 100, endMs: 100, text: "Now." },
  ]);
  const ass = toAss([{ startMs: 0, endMs: 900, text: "a {\\b1}bold\\N claim,\nnew line" }], "bottom", 720, 1280);
  const line = ass.split("\n").find((l) => l.startsWith("Dialogue:"))!;
  // Override blocks and backslashes are dropped, so the text cannot restyle or break the file; one event per caption.
  expect(line).toBe("Dialogue: 0,0:00:00.00,0:00:00.90,Default,,0,0,0,,a b1boldN claim, new line");
  expect(ass.split("\n").filter((l) => l.startsWith("Dialogue:"))).toHaveLength(1);
});

test("captions are refused only for scripts the render has no font for", () => {
  for (const l of ["en", "de", "ru", "ar", "vi", "pt-BR"]) expect(captionsSupported(l)).toBe(true);
  for (const l of ["ja", "ko", "zh", "zh-CN", "hi", "th", "JA"]) expect(captionsSupported(l)).toBe(false);
});
