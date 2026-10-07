import { expect, test } from "bun:test";
import sharp from "sharp";
import { inkCoverage, softProof } from "./index.ts";

const swatch = async (background: string) =>
  new Uint8Array(
    await sharp({ create: { width: 40, height: 40, channels: 3, background } })
      .png()
      .toBuffer(),
  );

test("a CMYK soft proof keeps white and shifts a colour the press cannot print; grey drops the colour", async () => {
  const white = await sharp(await softProof(await swatch("#ffffff"), "cmyk"))
    .raw()
    .toBuffer();
  expect([...white.subarray(0, 3)]).toEqual([255, 255, 255]);
  const green = await softProof(await swatch("#00ff00"), "cmyk");
  const meta = await sharp(green).metadata();
  expect([meta.width, meta.height, meta.format]).toEqual([40, 40, "png"]);
  const g = await sharp(green).raw().toBuffer();
  expect(g[0]! + (255 - g[1]!) + g[2]!).toBeGreaterThan(60);
  const grey = await sharp(await softProof(await swatch("#ff0000"), "grey"))
    .toColourspace("srgb")
    .raw()
    .toBuffer();
  expect(grey[0]).toBe(grey[1]!);
  expect(grey[1]).toBe(grey[2]!);
});

test("ink coverage: none on white, high on rich colour, the grey level for a black-ink interior", async () => {
  expect(await inkCoverage(await swatch("#ffffff"), 10, false)).toEqual({ maxInkPct: 0, shiftPct: 0 });
  const black = await inkCoverage(await swatch("#000000"), 10, false);
  expect(black.maxInkPct).toBeGreaterThan(150);
  const green = await inkCoverage(await swatch("#00ff00"), 10, false);
  expect(green.shiftPct).toBeGreaterThan(5);
  expect(await inkCoverage(await swatch("#000000"), 10, true)).toEqual({ maxInkPct: 100, shiftPct: 0 });
  expect((await inkCoverage(await swatch("#808080"), 10, true)).maxInkPct).toBe(50);
});
