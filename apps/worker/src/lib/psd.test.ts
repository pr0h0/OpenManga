import { expect, test } from "bun:test";
import { initializeCanvas, type Layer, readPsd } from "ag-psd";
import { packBits, writePsd } from "./psd.ts";

// ag-psd is an independent reader (dev only); it needs an ImageData factory outside a browser to decode pixels.
initializeCanvas(
  (() => {
    throw new Error("no canvas");
  }) as never,
  ((width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) })) as never,
);

const solid = (w: number, h: number, rgba: [number, number, number, number]) => {
  const b = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) b.set(rgba, i * 4);
  return b;
};

test("PackBits: runs and literals as Photoshop expects", () => {
  expect([...packBits(Uint8Array.from([1, 1, 1, 2, 3, 4, 4]))]).toEqual([254, 1, 1, 2, 3, 255, 4]);
  // A literal stops at 128 bytes, a run at 128 repeats.
  const mixed = Uint8Array.from({ length: 300 }, (_, i) => i % 251);
  expect(packBits(mixed)[0]).toBe(127);
  expect([...packBits(new Uint8Array(300))]).toEqual([129, 0, 129, 0, 213, 0]);
});

test("a written PSD reads back with its layers, groups, names, bounds, opacity, visibility and pixels", () => {
  const W = 300;
  const H = 200;
  const composite = new Uint8Array(W * H * 3).fill(250);
  const psd = writePsd({
    width: W,
    height: H,
    dpi: 300,
    composite,
    layers: [
      { name: "Background", left: 0, top: 0, width: W, height: H, rgba: solid(W, H, [255, 255, 255, 255]) },
      {
        name: "Panels",
        children: [
          {
            name: "Panel 1",
            children: [
              {
                name: "Guide",
                left: 10,
                top: 20,
                width: 100,
                height: 80,
                rgba: solid(100, 80, [9, 9, 9, 255]),
                opacity: 0.5,
                hidden: true,
              },
              { name: "Art", left: 10, top: 20, width: 100, height: 80, rgba: solid(100, 80, [200, 30, 40, 255]) },
            ],
          },
        ],
      },
      { name: "Dialogue — “Hey!”", left: 150, top: 50, width: 60, height: 30, rgba: solid(60, 30, [1, 2, 3, 128]) },
    ],
  });
  const doc = readPsd(psd.buffer as ArrayBuffer, { useImageData: true });
  expect([doc.width, doc.height]).toEqual([W, H]);
  expect(doc.imageResources?.resolutionInfo?.horizontalResolution).toBe(300);
  const names = (ls: Layer[] = []): unknown[] => ls.map((l) => (l.children ? [l.name, names(l.children)] : l.name));
  expect(names(doc.children)).toEqual(["Background", ["Panels", [["Panel 1", ["Guide", "Art"]]]], "Dialogue — “Hey!”"]);
  const panel = doc.children![1]!.children![0]!;
  const [guide, art] = panel.children!;
  expect([art!.left, art!.top, art!.right, art!.bottom]).toEqual([10, 20, 110, 100]);
  expect([...art!.imageData!.data.slice(0, 4)]).toEqual([200, 30, 40, 255]);
  expect(guide!.hidden).toBe(true);
  expect(guide!.opacity).toBeCloseTo(0.5, 2);
  const bubble = doc.children![2]!;
  expect([...bubble.imageData!.data.slice(0, 4)]).toEqual([1, 2, 3, 128]);
  expect([...doc.imageData!.data.slice(0, 4)]).toEqual([250, 250, 250, 255]);
});
