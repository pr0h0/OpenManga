import { expect, test } from "bun:test";
import type { PanelSeam } from "@openmanga/schemas";
import { chunkStrip, featherMask, type StripBlock, stripLayout } from "./strip.ts";

const block = (height: number, seam?: PanelSeam): StripBlock => ({ data: new Uint8Array(1), height, seam });
const tops = (blocks: StripBlock[], gap = 40) => stripLayout(blocks, { gap }).placements.map((p) => p.top);

test("without seams a strip is the old uniform-gap stack, exactly", () => {
  const blocks = [block(100), block(200), block(300)];
  const l = stripLayout(blocks, { gap: 40 });
  expect(l.placements.map((p) => p.top)).toEqual([0, 140, 380]);
  // Same arithmetic the previous stacker used: heights plus one gap per seam.
  expect(l.height).toBe(100 + 200 + 300 + 40 * 2);
  expect(l.feathers).toEqual([]);
  expect(l.bands).toEqual([]);
});

test("butt removes the seam, so continuous action has no visible join", () => {
  expect(tops([block(100), block(100, { kind: "butt" })])).toEqual([0, 100]);
});

test("gap can be authored per seam, overriding the project default", () => {
  expect(tops([block(100), block(100, { kind: "gap", size: 4 })])).toEqual([0, 104]);
  expect(tops([block(100), block(100, { kind: "gap", size: 0 })])).toEqual([0, 100]);
});

test("bleed and dissolve overlap, so the strip is shorter than its parts", () => {
  const bleed = stripLayout([block(200), block(200, { kind: "bleed", size: 50 })], { gap: 40 });
  expect(bleed.placements.map((p) => p.top)).toEqual([0, 150]);
  expect(bleed.height).toBe(350);
  // A hard-edged bleed needs no alpha ramp; a dissolve does, on the incoming edge only.
  expect(bleed.feathers).toEqual([]);
  const dissolve = stripLayout([block(200), block(200, { kind: "dissolve", size: 50 })], { gap: 40 });
  expect(dissolve.feathers).toEqual([{ index: 1, top: 50, bottom: 0 }]);
});

test("an overlap can never consume a whole neighbour", () => {
  // 500 asked for against a 100px neighbour would reorder the blocks and lose a panel.
  const l = stripLayout([block(100), block(400, { kind: "dissolve", size: 500 })], { gap: 40 });
  expect(l.placements[1]!.top).toBe(1);
  expect(l.height).toBe(401);
});

test("fade paints a band and ramps both edges into it", () => {
  const l = stripLayout([block(300), block(300, { kind: "fade", size: 60, color: "#000000" })], { gap: 40 });
  expect(l.placements.map((p) => p.top)).toEqual([0, 360]);
  expect(l.bands).toEqual([{ top: 240, height: 180, color: "#000000" }]);
  // The outgoing edge fades out and the incoming edge fades in, so neither ends on a hard line.
  expect(l.feathers).toEqual([
    { index: 1, top: 60, bottom: 0 },
    { index: 0, top: 0, bottom: 60 },
  ]);
});

test("a fade with no colour falls back to the strip background", () => {
  expect(
    stripLayout([block(100), block(100, { kind: "fade" })], { gap: 10, background: "#101010" }).bands[0]!.color,
  ).toBe("#101010");
});

test("chunking never cuts a blended seam", () => {
  const blocks = [
    block(400),
    block(400, { kind: "dissolve", size: 40 }),
    block(400, { kind: "gap" }),
    block(400, { kind: "bleed", size: 40 }),
  ];
  const chunks = chunkStrip(blocks, 900, { gap: 40 });
  // The only breakable seam inside the limit is the plain gap before block 2.
  expect(chunks.map((c) => c.length)).toEqual([2, 2]);
  // A chunk's first block starts clean: its seam belonged to a panel now in another file.
  expect(chunks.every((c) => !c[0]!.seam)).toBe(true);
});

test("a blended run taller than the limit goes out oversized rather than torn", () => {
  const blocks = [block(800), block(800, { kind: "dissolve", size: 40 })];
  expect(chunkStrip(blocks, 500, { gap: 40 }).map((c) => c.length)).toEqual([2]);
});

test("the feather mask ramps only the edges asked for", () => {
  const both = featherMask(800, 1000, 100, 200);
  expect(both).toContain('offset="0.1000" stop-color="#fff" stop-opacity="1"');
  expect(both).toContain('offset="0.8000" stop-color="#fff" stop-opacity="1"');
  const topOnly = featherMask(800, 1000, 100, 0);
  expect(topOnly).toContain('<stop offset="1" stop-color="#fff" stop-opacity="1"/>');
  expect(topOnly).not.toContain('stop-opacity="0"/></linearGradient>');
});
