import { describe, expect, test } from "bun:test";
import { probeImage, sharp } from "@openmanga/image-utils";
import { Bubble, SfxStyle } from "@openmanga/schemas";
import {
  chunkBlocks,
  type RenderPage,
  renderCover,
  renderPageImage,
  renderPageSvg,
  renderWebtoonBlocks,
  stackVertical,
} from "./compose.ts";

const art = async (w: number, h: number) =>
  new Uint8Array(
    await sharp({ create: { width: w, height: h, channels: 3, background: "#4477aa" } })
      .png()
      .toBuffer(),
  );

async function page(): Promise<RenderPage> {
  return {
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
        art: await art(1536, 1024),
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
    ],
    sfx: [{ id: "s", panelId: "b", text: "BAM", style: SfxStyle.parse({ x: 0.5, y: 0.7 }) }],
  };
}

describe("deterministic compositor", () => {
  test("large noisy panel art composites (no 10 MB SVG line limit) and lands in its frame", async () => {
    const noisy = new Uint8Array(
      await sharp({
        create: {
          width: 1600,
          height: 2400,
          channels: 3,
          background: "#000",
          noise: { type: "gaussian", mean: 128, sigma: 80 },
        },
      })
        .png({ compressionLevel: 0 })
        .toBuffer(),
    );
    const base = await page();
    const p: RenderPage = {
      ...base,
      width: 1600,
      height: 2400,
      bubbles: [],
      sfx: [],
      panels: [{ ...base.panels[0]!, frame: { x: 0, y: 0, width: 1, height: 1 }, art: noisy }],
    };
    const img = await renderPageImage(p, "png");
    expect(img.width).toBe(1600);
    const { data, info } = await sharp(img.data).raw().toBuffer({ resolveWithObject: true });
    let nonWhite = 0;
    for (let i = 0; i < 4000; i += info.channels) if (data[i] !== 255 || data[i + 1] !== 255) nonWhite++;
    expect(nonWhite).toBeGreaterThan(100);
    const blocks = await renderWebtoonBlocks(p, 800);
    expect(blocks).toHaveLength(1);
  }, 60_000);

  test("renders page PNG/JPG at page size and scale", async () => {
    const p = await page();
    const png = await renderPageImage(p, "png");
    expect(await probeImage(png.data)).toMatchObject({ mime: "image/png", width: 800, height: 1200 });
    const jpg = await renderPageImage(p, "jpg", { scale: 0.5 });
    expect(await probeImage(jpg.data)).toMatchObject({ mime: "image/jpeg", width: 400, height: 600 });
  });

  test("same input produces an identical composition document", async () => {
    const p = await page();
    const a = await renderPageSvg(p, 1);
    const b = await renderPageSvg(structuredClone(p), 1);
    expect(a.svg).toBe(b.svg);
    expect(a.svg).toContain("Who&#39;s");
    expect(a.svg).toContain(">BAM<");
  });

  test("webtoon blocks are full width and chunked at block boundaries", async () => {
    const blocks = await renderWebtoonBlocks(await page(), 600);
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.height).toBe(Math.round(((0.4 * 1200) / (0.9 * 800)) * 600));
    const strip = await stackVertical(blocks, 600, 20);
    expect(strip.height).toBe(blocks[0]!.height + blocks[1]!.height + 20);
    expect(chunkBlocks([{ height: 500 }, { height: 500 }, { height: 500 }], 1100, 40).map((c) => c.length)).toEqual([
      2, 1,
    ]);
    expect(chunkBlocks([{ height: 5000 }], 1000, 0)).toHaveLength(1);
  });

  test("cover composites title over artwork", async () => {
    const out = await renderCover(await art(1024, 1536), "Rain City", "Chapter 1", "Author", 600);
    expect(await probeImage(out)).toMatchObject({ width: 600, height: 900 });
  });
});

describe("shaped panels", () => {
  test("art is cut to the outline and the border follows it; the rest of the box stays page", async () => {
    // A triangle pointing down across the whole page: art fills it, the corners beside the point stay white.
    const p: RenderPage = {
      id: "s",
      order: 1,
      width: 400,
      height: 400,
      readingDirection: "ltr",
      panels: [
        {
          id: "t",
          order: 1,
          frame: {
            x: 0,
            y: 0,
            width: 1,
            height: 1,
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 0.5, y: 1 },
            ],
          },
          imageTransform: { focalX: 0.5, focalY: 0.5, scale: 1 },
          art: await art(400, 400),
        },
      ],
      bubbles: [],
      sfx: [],
    };
    const { data, width } = await renderPageImage(p, "png");
    const { data: px } = await sharp(data).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => [...px.subarray((y * width + x) * 3, (y * width + x) * 3 + 3)];
    expect(at(200, 100)).toEqual([0x44, 0x77, 0xaa]); // inside: the art
    expect(at(30, 360)).toEqual([255, 255, 255]); // bottom-left corner of the box, outside the triangle: page
    expect(at(370, 360)).toEqual([255, 255, 255]);
    const svg = (await renderPageSvg(p)).svg;
    expect(svg).toContain('<path d="M0.0 0.0 L400.0 0.0 L200.0 400.0 Z"');
    expect(svg).not.toContain('<rect x="0.0" y="0.0" width="400.0" height="400.0" fill="none"');
  });
});
