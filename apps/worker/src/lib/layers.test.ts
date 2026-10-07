import { expect, test } from "bun:test";
import { sharp } from "@openmanga/image-utils";
import { Bubble, SfxStyle } from "@openmanga/schemas";
import type { RenderPage } from "@openmanga/services";
import { initializeCanvas, type Layer, readPsd } from "ag-psd";
import { pageLayers, psdTree, rgbPixels } from "./layers.ts";
import { writePsd } from "./psd.ts";

initializeCanvas(
  (() => {
    throw new Error("no canvas");
  }) as never,
  ((width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })) as never,
);

const art = async (w: number, h: number, background: string) =>
  new Uint8Array(
    await sharp({ create: { width: w, height: h, channels: 3, background } })
      .png()
      .toBuffer(),
  );

const page = async (): Promise<RenderPage> => ({
  id: "p",
  order: 1,
  width: 800,
  height: 1200,
  readingDirection: "ltr",
  panels: [
    {
      id: "a",
      order: 1,
      frame: { x: 0.05, y: 0.05, width: 0.9, height: 0.4 },
      imageTransform: { focalX: 0.5, focalY: 0.5, scale: 1 },
      art: await art(900, 600, "#4477aa"),
    },
    {
      id: "b",
      order: 2,
      frame: { x: 0.05, y: 0.5, width: 0.9, height: 0.45 },
      imageTransform: { focalX: 0.5, focalY: 0.5, scale: 1 },
      art: null,
    },
  ],
  bubbles: [
    {
      id: "d",
      panelId: "a",
      text: "Who's there?",
      bubble: Bubble.parse({ x: 0.1, y: 0.1, width: 0.3, height: 0.08, tailTarget: { x: 0.5, y: 0.3 } }),
    },
    {
      id: "n",
      panelId: "b",
      text: "Meanwhile, downstairs.",
      bubble: Bubble.parse({ type: "narration", x: 0.1, y: 0.55, width: 0.4, height: 0.06 }),
    },
  ],
  sfx: [{ id: "s", panelId: "b", text: "BAM", style: SfxStyle.parse({ x: 0.5, y: 0.7 }) }],
});

test("a page taken apart: each panel's art and frame where the page draws them, lettering one element at a time", async () => {
  const guide = await art(300, 200, "#999999");
  const l = await pageLayers(await page(), 0.5, new Map([["a", guide]]));
  expect([l.width, l.height]).toEqual([400, 600]);
  const [a, b] = l.panels;
  expect(a!.art).toMatchObject({ left: 20, top: 30, width: 360, height: 240 });
  expect(a!.guide).toMatchObject({ left: 20, top: 30, width: 360, height: 240 });
  expect(b!.art).toBeNull();
  // The frame's stroke straddles the panel edge.
  expect(a!.frame!.left).toBeLessThan(20);
  expect(a!.frame!.width).toBeGreaterThan(360);
  expect(l.lettering.map((x) => [x.kind, x.id])).toEqual([
    ["sfx", "s"],
    ["dialogue", "d"],
    ["narration", "n"],
  ]);
  const bubble = l.lettering[1]!.raster!;
  expect(bubble.left).toBeGreaterThanOrEqual(39);
  expect(bubble.left + bubble.width).toBeLessThanOrEqual(400);
  expect(l.letteringSvg).toContain('<g id="dialogue-d">');
  expect(l.letteringSvg).toContain("Who&#39;s</tspan>");
  expect(l.letteringSvg).not.toContain("<image");
  // Without lettering the bubble's white is gone from where it sat.
  const pixel = async (png: Uint8Array) =>
    [...(await sharp(png).extract({ left: 100, top: 63, width: 1, height: 1 }).raw().toBuffer())].slice(0, 3);
  expect(await pixel(l.composite)).toEqual([255, 255, 255]);
  expect(await pixel(l.textFree)).not.toEqual([255, 255, 255]);
});

test("the layered PSD of a page reads back with its groups, named layers and bounds", async () => {
  const l = await pageLayers(await page(), 0.5, new Map());
  const psd = writePsd({
    width: l.width,
    height: l.height,
    dpi: 300,
    layers: psdTree(l),
    composite: await rgbPixels(l.composite),
  });
  const doc = readPsd(psd.buffer as ArrayBuffer, { skipLayerImageData: true, skipCompositeImageData: true });
  const names = (ls: Layer[] = []): unknown[] => ls.map((x) => (x.children ? [x.name, names(x.children)] : x.name));
  expect(names(doc.children)).toEqual([
    "Background",
    [
      "Panels",
      [
        ["Panel 1", ["Art", "Frame"]],
        ["Panel 2", ["Frame"]],
      ],
    ],
    ["Effects", ["BAM"]],
    ["Captions", ["Meanwhile, downstairs."]],
    ["Dialogue", ["Who's there?"]],
  ]);
  const art = doc.children![1]!.children![0]!.children![0]!;
  expect([art.left, art.top, art.right, art.bottom]).toEqual([20, 30, 380, 270]);
});
