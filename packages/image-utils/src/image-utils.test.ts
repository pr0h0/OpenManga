import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import sharp from "sharp";
import {
  chooseImageDimensions,
  cleanSketch,
  computeCrop,
  createPromptReference,
  cropRegion,
  extendCanvas,
  fitInside,
  fullMask,
  gridCell,
  lineArt,
  paletteTransfer,
  probeImage,
  type ReferenceParams,
  referenceCacheKey,
  sanitizeUpload,
  sniffImageMime,
  toEditMask,
  upscale,
} from "./index.ts";

const png = async (w: number, h: number) =>
  new Uint8Array(
    await sharp({ create: { width: w, height: h, channels: 3, background: "#3366cc" } })
      .png()
      .toBuffer(),
  );

const params: ReferenceParams = {
  maxWidth: 160,
  maxHeight: 80,
  fit: "inside",
  allowUpscale: false,
  format: "webp",
  quality: 85,
};
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

describe("prompt reference derivatives", () => {
  test("1600x800 -> 160x80", async () => {
    const src = await png(1600, 800);
    const before = sha(src);
    const r = await createPromptReference(src, params);
    expect([r.width, r.height]).toEqual([160, 80]);
    expect(sniffImageMime(r.data)).toBe("image/webp");
    expect((await probeImage(r.data)).width).toBe(160);
    expect(sha(src)).toBe(before); // canonical untouched
  });

  test("800x1600 -> 40x80 (portrait keeps ratio)", async () => {
    const r = await createPromptReference(await png(800, 1600), params);
    expect([r.width, r.height]).toEqual([40, 80]);
  });

  test("100x50 stays 100x50 when upscaling disabled", async () => {
    const r = await createPromptReference(await png(100, 50), params);
    expect([r.width, r.height]).toEqual([100, 50]);
    expect(fitInside(100, 50, 160, 80, true)).toEqual({ width: 160, height: 80 });
  });

  test("cache key is deterministic and parameter sensitive", () => {
    const a = referenceCacheKey("abc", params);
    expect(referenceCacheKey("abc", { ...params })).toBe(a);
    expect(referenceCacheKey("abc", { ...params, maxWidth: 320 })).not.toBe(a);
    expect(referenceCacheKey("abd", params)).not.toBe(a);
    expect(referenceCacheKey("abc", { ...params, quality: 80 })).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("derivative is deterministic byte-for-byte", async () => {
    const src = await png(1024, 1536);
    const a = await createPromptReference(src, params);
    const b = await createPromptReference(src, params);
    expect(sha(a.data)).toBe(sha(b.data));
  });
});

describe("mime sniffing and uploads", () => {
  test("detects real type, rejects fakes", async () => {
    expect(sniffImageMime(await png(4, 4))).toBe("image/png");
    const jpg = new Uint8Array(
      await sharp(await png(4, 4))
        .jpeg()
        .toBuffer(),
    );
    expect(sniffImageMime(jpg)).toBe("image/jpeg");
    expect(sniffImageMime(new TextEncoder().encode("<svg></svg>"))).toBeNull();
    await expect(probeImage(new TextEncoder().encode("GIF89a...."))).rejects.toThrow();
  });

  test("sanitize strips metadata", async () => {
    const withExif = new Uint8Array(
      await sharp(await png(20, 10))
        .jpeg()
        .withMetadata({ exif: { IFD0: { Copyright: "secret-gps" } } })
        .toBuffer(),
    );
    const clean = await sanitizeUpload(withExif);
    expect((await sharp(clean.data).metadata()).exif).toBeUndefined();
    expect(clean.width).toBe(20);
  });
});

describe("dimensions and crop", () => {
  const sizes = [
    { width: 1024, height: 1024 },
    { width: 1536, height: 1024 },
    { width: 1024, height: 1536 },
  ];
  test("chooseImageDimensions picks nearest ratio", () => {
    expect(chooseImageDimensions(1, sizes)).toEqual({ width: 1024, height: 1024 });
    expect(chooseImageDimensions(2.4, sizes)).toEqual({ width: 1536, height: 1024 });
    expect(chooseImageDimensions(0.3, sizes)).toEqual({ width: 1024, height: 1536 });
    expect(() => chooseImageDimensions(0, sizes)).toThrow();
  });
  test("computeCrop fills target ratio inside bounds", () => {
    const c = computeCrop(1536, 1024, 3, { focalX: 0.5, focalY: 0.5, scale: 1 });
    expect(c.width / c.height).toBeCloseTo(3, 1);
    expect(c.left + c.width).toBeLessThanOrEqual(1536);
    const edge = computeCrop(1536, 1024, 1, { focalX: 1, focalY: 0, scale: 2 });
    expect(edge.left + edge.width).toBe(1536);
    expect(edge.top).toBe(0);
    expect(edge.width).toBe(512);
  });
  test("edit mask: painted area becomes transparent", async () => {
    const mask = new Uint8Array(
      await sharp({ create: { width: 10, height: 10, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
        .composite([
          {
            input: await sharp({ create: { width: 5, height: 10, channels: 4, background: "#ffffff" } })
              .png()
              .toBuffer(),
            left: 0,
            top: 0,
          },
        ])
        .png()
        .toBuffer(),
    );
    const out = await toEditMask(mask, 20, 20);
    const { data, info } = await sharp(out).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([20, 20]);
    expect(data[3]).toBe(0); // left painted -> transparent
    expect(data[(20 * 19 + 19) * 4 + 3]).toBe(255); // right -> opaque
  });
});

describe("OpenAI size menu", () => {
  const menu = "2048x1152,1152x2048,1792x1024,1024x1792,1536x1024,1024x1536,1408x1408".split(",").map((s) => {
    const [width, height] = s.split("x").map(Number);
    return { width: width!, height: height! };
  });
  test("common panel shapes pick the closest ~2 MP size", () => {
    expect(chooseImageDimensions(16 / 9, menu)).toEqual({ width: 2048, height: 1152 });
    expect(chooseImageDimensions(1, menu)).toEqual({ width: 1408, height: 1408 });
    expect(chooseImageDimensions(0.67, menu)).toEqual({ width: 1024, height: 1536 });
    expect(chooseImageDimensions(0.5, menu)).toEqual({ width: 1152, height: 2048 });
    expect(chooseImageDimensions(1.72, menu)).toEqual({ width: 1792, height: 1024 });
    // a very wide page-width strip still gets the widest option
    expect(chooseImageDimensions(4, menu)).toEqual({ width: 2048, height: 1152 });
  });
});

describe("coverage grid", () => {
  test("nine cells in reading order, gutters inset away, cropped exactly", async () => {
    expect(gridCell(900, 600, 0)).toEqual({ left: 9, top: 6, width: 282, height: 188 });
    expect(gridCell(900, 600, 4)).toMatchObject({ left: 309, top: 206 });
    expect(gridCell(900, 600, 8)).toMatchObject({ left: 609, top: 406 });
    const img = await sharp({ create: { width: 900, height: 600, channels: 3, background: "#336699" } })
      .png()
      .toBuffer();
    const cell = await cropRegion(new Uint8Array(img), gridCell(900, 600, 5));
    expect([cell.width, cell.height, cell.mime]).toEqual([282, 188, "image/png"]);
  });
});

describe("image tools", () => {
  const solid = (w: number, h: number, c: string) =>
    sharp({ create: { width: w, height: h, channels: 3, background: c } })
      .png()
      .toBuffer()
      .then((b) => new Uint8Array(b));
  const buf = (u: Uint8Array) => Buffer.from(u);
  const pixel = async (d: Uint8Array, x: number, y: number) => {
    const { data, info } = await sharp(d)
      .toColourspace("srgb")
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const i = (y * info.width + x) * info.channels;
    return [data[i]!, data[i + 1]!, data[i + 2]!];
  };

  test("upscale doubles, capped, and refuses when there is no room", async () => {
    const up = await upscale(await solid(300, 200, "#336699"));
    expect([up.width, up.height]).toEqual([600, 400]);
    expect((await upscale(await solid(3000, 1000, "#000"), 2, 4096)).width).toBe(4096);
    await expect(upscale(await solid(4096, 10, "#000"))).rejects.toThrow("largest");
  });

  test("line art and a cleaned sketch are black on white", async () => {
    const sq = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#d0d0d0" } })
      .composite([{ input: buf(await solid(80, 80, "#202020")), left: 60, top: 60 }])
      .png()
      .toBuffer();
    const lines = await lineArt(new Uint8Array(sq));
    expect(await pixel(lines.data, 10, 10)).toEqual([255, 255, 255]);
    // A line along the square's edge (on the light side of it).
    const across = await Promise.all([58, 59, 60, 61].map((x) => pixel(lines.data, x, 100)));
    expect(Math.min(...across.map((p) => p[0]!))).toBe(0);
    expect(await pixel(lines.data, 100, 100)).toEqual([255, 255, 255]);
    const clean = await cleanSketch(new Uint8Array(sq));
    expect(await pixel(clean.data, 10, 10)).toEqual([255, 255, 255]);
    expect(await pixel(clean.data, 100, 100)).toEqual([0, 0, 0]);
  });

  test("palette transfer moves the colours towards the other image's", async () => {
    const grey = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#808080" } })
      .composite([{ input: buf(await solid(32, 64, "#c0c0c0")), left: 32, top: 0 }])
      .png()
      .toBuffer();
    const warm = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c04020" } })
      .composite([{ input: buf(await solid(32, 64, "#f0a040")), left: 32, top: 0 }])
      .png()
      .toBuffer();
    const out = await paletteTransfer(new Uint8Array(grey), new Uint8Array(warm));
    const [r, , b] = await pixel(out.data, 48, 32);
    expect(r!).toBeGreaterThan(b! + 40);
    expect([out.width, out.height]).toEqual([64, 64]);
  });

  test("an extended canvas and its mask: the new area painted, the picture kept", async () => {
    const { canvas, mask } = await extendCanvas(await solid(160, 90, "#ff0000"), 9 / 16);
    expect([canvas.width, canvas.height]).toEqual([160, 284]);
    expect(await pixel(mask.data, 80, 5)).toEqual([255, 255, 255]);
    expect(await pixel(mask.data, 80, 142)).toEqual([0, 0, 0]);
    expect(await pixel(canvas.data, 80, 142)).toEqual([255, 0, 0]);
    const full = await fullMask(10, 10);
    expect(await pixel(full.data, 5, 5)).toEqual([255, 255, 255]);
  });
});
