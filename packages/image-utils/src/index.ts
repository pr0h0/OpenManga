import { createHash } from "node:crypto";
import sharp from "sharp";

/**
 * libvips defaults to a cache sized for a long-lived image server and one thread per core per pipeline. This
 * process runs many pipelines at once (IMAGE_WORKER_CONCURRENCY defaults to 24) and each one is a one-shot
 * resize, so a large cache buys nothing and the threads multiply resident memory. Measured: a 60-asset import
 * peaked at 2.9 GB before this, which a small VPS does not have.
 */
sharp.cache({ memory: 64, files: 0, items: 50 });
sharp.concurrency(2);

export type ImageMime = "image/png" | "image/jpeg" | "image/webp";

/** Detect real image type from magic bytes. Never trust extensions or client MIME. */
export function sniffImageMime(b: Uint8Array): ImageMime | null {
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a
  )
    return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  return null;
}

export const extForMime = (m: string) =>
  ({
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/webp": "webp",
    "audio/wav": "wav",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/flac": "flac",
    "audio/mp4": "m4a",
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/json": "json",
    "video/mp4": "mp4",
    "application/x-subrip": "srt",
    "text/markdown": "md",
    "text/plain": "txt",
    "application/vnd.adobe.photoshop": "psd",
  })[m] ?? "bin";

export class InvalidImageError extends Error {}

export async function probeImage(data: Uint8Array) {
  const mime = sniffImageMime(data);
  if (!mime) throw new InvalidImageError("Unsupported or invalid image data");
  try {
    const meta = await sharp(data).metadata();
    if (!meta.width || !meta.height) throw new InvalidImageError("Image has no dimensions");
    return { mime, width: meta.width, height: meta.height };
  } catch (e) {
    if (e instanceof InvalidImageError) throw e;
    throw new InvalidImageError("Corrupt image data");
  }
}

/** Re-encode an upload: applies EXIF orientation, strips metadata (GPS etc.), bounds pixel count. */
/** 40 MP: a legitimate reference upload is far smaller, and each decode is ~4 bytes a pixel of resident memory. */
export async function sanitizeUpload(data: Uint8Array, maxPixels = 40_000_000) {
  const { mime } = await probeImage(data);
  const img = sharp(data, { limitInputPixels: maxPixels }).rotate();
  try {
    const out =
      mime === "image/png"
        ? await img.png().toBuffer({ resolveWithObject: true })
        : mime === "image/jpeg"
          ? await img.jpeg({ quality: 95 }).toBuffer({ resolveWithObject: true })
          : await img.webp({ quality: 95 }).toBuffer({ resolveWithObject: true });
    return { data: new Uint8Array(out.data), mime, width: out.info.width, height: out.info.height };
  } catch (e) {
    // A header sharp can read does not mean pixels it can decode: a truncated file passes `metadata()` and then
    // fails here. Unguarded, that reached the API as a 500 for what is simply a bad upload.
    if (e instanceof InvalidImageError) throw e;
    throw new InvalidImageError(`Could not re-encode the image: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export type ReferenceParams = {
  maxWidth: number;
  maxHeight: number;
  fit: "inside" | "cover" | "contain";
  allowUpscale: boolean;
  format: "webp" | "png" | "jpeg";
  quality: number;
};

/** Deterministic cache key for a prompt-reference derivative of a canonical asset. */
export function referenceCacheKey(canonicalSha256: string, p: ReferenceParams) {
  const enc = p.format === "png" ? "lossless" : `q${p.quality}`;
  const up = p.allowUpscale ? "up" : "noup";
  return createHash("sha256")
    .update(`${canonicalSha256}:${p.maxWidth}x${p.maxHeight}:${p.fit}:${up}:${p.format}:${enc}`)
    .digest("hex");
}

/** Compute resulting dimensions for fit=inside without touching pixels. */
export function fitInside(w: number, h: number, maxW: number, maxH: number, allowUpscale: boolean) {
  let scale = Math.min(maxW / w, maxH / h);
  if (!allowUpscale) scale = Math.min(1, scale);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Create the small derivative sent alongside OpenAI requests. The canonical buffer is never mutated. */
export async function createPromptReference(canonical: Uint8Array, p: ReferenceParams) {
  let img = sharp(canonical)
    .rotate()
    .resize({
      width: p.maxWidth,
      height: p.maxHeight,
      fit: p.fit,
      withoutEnlargement: !p.allowUpscale,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    });
  img =
    p.format === "webp"
      ? img.webp({ quality: p.quality })
      : p.format === "jpeg"
        ? img.jpeg({ quality: p.quality })
        : img.png();
  const { data, info } = await img.toBuffer({ resolveWithObject: true });
  const mime: ImageMime = p.format === "webp" ? "image/webp" : p.format === "jpeg" ? "image/jpeg" : "image/png";
  return { data: new Uint8Array(data), width: info.width, height: info.height, mime };
}

export async function createThumbnail(data: Uint8Array, maxSize = 384, quality = 80) {
  const { data: out, info } = await sharp(data, { limitInputPixels: false })
    .rotate()
    .resize({ width: maxSize, height: maxSize, fit: "inside", withoutEnlargement: true })
    .webp({ quality })
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(out), width: info.width, height: info.height, mime: "image/webp" as const };
}

export type SizeOption = { width: number; height: number };

/** Choose the provider-supported size whose aspect ratio is closest (log-distance) to the panel ratio. */
export function chooseImageDimensions(panelAspectRatio: number, sizes: SizeOption[]): SizeOption {
  if (!(panelAspectRatio > 0) || !Number.isFinite(panelAspectRatio)) throw new Error("Invalid aspect ratio");
  if (!sizes.length) throw new Error("No sizes available");
  let best = sizes[0]!;
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of sizes) {
    const d = Math.abs(Math.log(s.width / s.height) - Math.log(panelAspectRatio));
    if (d < bestD - 1e-9 || (Math.abs(d - bestD) < 1e-9 && s.width * s.height > best.width * best.height)) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

/** The image focus as a 0..1 position inside the crop that is actually shown (clamped when the crop hits an edge). */
export function focusInCrop(
  srcW: number,
  srcH: number,
  aspect: number,
  t: { focalX: number; focalY: number; scale: number },
) {
  const c = computeCrop(srcW, srcH, aspect, t);
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return { x: clamp((t.focalX * srcW - c.left) / c.width), y: clamp((t.focalY * srcH - c.top) / c.height) };
}

/**
 * Deterministic crop rectangle (in source pixels) that fills a target aspect ratio.
 * focal (0..1) is kept as close to center as possible; scale>1 zooms in.
 */
export function computeCrop(
  srcW: number,
  srcH: number,
  targetAspect: number,
  t: { focalX: number; focalY: number; scale: number },
) {
  let cw = srcW;
  let ch = srcW / targetAspect;
  if (ch > srcH) {
    ch = srcH;
    cw = srcH * targetAspect;
  }
  const scale = Math.max(1, t.scale);
  cw /= scale;
  ch /= scale;
  const cx = t.focalX * srcW;
  const cy = t.focalY * srcH;
  const left = Math.min(Math.max(0, cx - cw / 2), srcW - cw);
  const top = Math.min(Math.max(0, cy - ch / 2), srcH - ch);
  return {
    left: Math.round(left),
    top: Math.round(top),
    width: Math.max(1, Math.min(srcW - Math.round(left), Math.round(cw))),
    height: Math.max(1, Math.min(srcH - Math.round(top), Math.round(ch))),
  };
}

/** Crop + resize artwork into an exact panel box. Returns PNG; original untouched. */
export async function renderPanelArt(
  data: Uint8Array,
  outW: number,
  outH: number,
  t: { focalX: number; focalY: number; scale: number },
) {
  const meta = await sharp(data).metadata();
  const crop = computeCrop(meta.width ?? outW, meta.height ?? outH, outW / outH, t);
  return new Uint8Array(
    await sharp(data)
      .extract(crop)
      .resize(Math.max(1, Math.round(outW)), Math.max(1, Math.round(outH)), { fit: "fill" })
      .png()
      .toBuffer(),
  );
}

/**
 * Convert a user-painted mask (painted = opaque white/any alpha>0 on transparent/black) into
 * the OpenAI edit mask convention: fully transparent where edits are allowed, opaque elsewhere.
 * Output matches the target image size exactly.
 */
export async function toEditMask(mask: Uint8Array, width: number, height: number) {
  const { data, info } = await sharp(mask)
    .resize(width, height, { fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const out = Buffer.alloc(info.width * info.height * 4);
  for (let i = 0; i < info.width * info.height; i++) {
    const r = data[i * 4]!;
    const g = data[i * 4 + 1]!;
    const b = data[i * 4 + 2]!;
    const a = data[i * 4 + 3]!;
    const painted = a > 16 && r + g + b > 96;
    out[i * 4] = 0;
    out[i * 4 + 1] = 0;
    out[i * 4 + 2] = 0;
    out[i * 4 + 3] = painted ? 0 : 255;
  }
  return new Uint8Array(
    await sharp(out, { raw: { width: info.width, height: info.height, channels: 4 } })
      .png()
      .toBuffer(),
  );
}

/**
 * How a page prints: "cmyk" through a CMYK press profile and back to sRGB, so colours a press cannot reach shift on
 * screen the way they will on paper; "grey" as a black-ink-only interior prints it. The profile is libvips's
 * built-in generic one ("Chemical proof"), not a particular printer's: it shows which colours move, not exact ink.
 */
export async function softProof(data: Uint8Array, mode: "cmyk" | "grey") {
  const flat = sharp(data, { limitInputPixels: false }).flatten({ background: "#ffffff" });
  if (mode === "grey") return new Uint8Array(await flat.greyscale().png().toBuffer());
  const cmyk = await flat.withIccProfile("cmyk").tiff({ compression: "none" }).toBuffer();
  return new Uint8Array(await sharp(cmyk, { limitInputPixels: false }).toColourspace("srgb").png().toBuffer());
}

/**
 * Total ink of the darkest area (C+M+Y+K, in percent) and the mean colour shift of the soft proof (0–100), measured
 * on a copy `width` pixels wide so each pixel is an area a press cares about, not a single dot. A grey interior
 * prints with black ink only: its ink is the grey level, and it has no colour to shift.
 */
export async function inkCoverage(data: Uint8Array, width: number, grey: boolean) {
  const small = sharp(data, { limitInputPixels: false })
    .flatten({ background: "#ffffff" })
    .resize({ width: Math.max(1, Math.round(width)) });
  if (grey) {
    const { data: g } = await small.greyscale().raw().toBuffer({ resolveWithObject: true });
    let max = 0;
    for (const v of g) max = Math.max(max, 255 - v);
    return { maxInkPct: Math.round((max / 255) * 100), shiftPct: 0 };
  }
  const rgb = await small.removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const raw = { raw: { width: rgb.info.width, height: rgb.info.height, channels: 3 as const } };
  const cmyk = await sharp(rgb.data, raw).withIccProfile("cmyk").raw().toBuffer();
  let max = 0;
  for (let i = 0; i + 3 < cmyk.length; i += 4)
    max = Math.max(max, cmyk[i]! + cmyk[i + 1]! + cmyk[i + 2]! + cmyk[i + 3]!);
  const tiff = await sharp(rgb.data, raw).withIccProfile("cmyk").tiff({ compression: "none" }).toBuffer();
  const back = await sharp(tiff).toColourspace("srgb").removeAlpha().raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < rgb.data.length; i++) diff += Math.abs(rgb.data[i]! - back[i]!);
  return {
    maxInkPct: Math.round((max / 255) * 100),
    shiftPct: Math.round((diff / rgb.data.length / 255) * 1000) / 10,
  };
}

export { sharp };

/**
 * Cell `index` (0-8, reading order) of an image divided into a 3x3 grid, inset by `inset` of a cell on every side so
 * the gutters between cells are left out.
 */
export function gridCell(width: number, height: number, index: number, inset = 0.03) {
  const cw = width / 3;
  const ch = height / 3;
  const [col, row] = [index % 3, Math.floor(index / 3)];
  const left = Math.round(col * cw + cw * inset);
  const top = Math.round(row * ch + ch * inset);
  return {
    left,
    top,
    width: Math.max(1, Math.round(cw * (1 - 2 * inset))),
    height: Math.max(1, Math.round(ch * (1 - 2 * inset))),
  };
}

/** A region of an image, as a lossless PNG. */
export async function cropRegion(data: Uint8Array, r: { left: number; top: number; width: number; height: number }) {
  const { data: out, info } = await sharp(data, { limitInputPixels: false })
    .extract(r)
    .png()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(out), width: info.width, height: info.height, mime: "image/png" as const };
}

// ---------------------------------------------------------------- image tools (deterministic)

const toPng = async (img: ReturnType<typeof sharp>) => {
  const { data, info } = await img.png().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data), width: info.width, height: info.height, mime: "image/png" as const };
};

/** Larger by `factor` (Lanczos, a light sharpen), capped at `max` px on the long side. */
export async function upscale(data: Uint8Array, factor = 2, max = 4096) {
  const m = await sharp(data).metadata();
  const scale = Math.min(factor, max / Math.max(m.width ?? 1, m.height ?? 1));
  if (scale <= 1) throw new InvalidImageError("Already at the largest size");
  return toPng(
    sharp(data, { limitInputPixels: false })
      .resize(Math.round((m.width ?? 1) * scale), Math.round((m.height ?? 1) * scale), { kernel: "lanczos3" })
      .sharpen({ sigma: 0.6 }),
  );
}

/** Black lines on white from an illustration: edges of the grey image, inverted and thresholded. */
export async function lineArt(data: Uint8Array) {
  return toPng(
    sharp(data, { limitInputPixels: false })
      .flatten({ background: "#ffffff" })
      .greyscale()
      .blur(0.6)
      .convolve({ width: 3, height: 3, kernel: [-1, -1, -1, -1, 8, -1, -1, -1, -1] })
      .negate()
      .normalise()
      .threshold(200),
  );
}

/** A rough sketch made clean: grey paper and smudges to white, strokes to solid black. */
export async function cleanSketch(data: Uint8Array) {
  return toPng(
    sharp(data, { limitInputPixels: false })
      .flatten({ background: "#ffffff" })
      .greyscale()
      .normalise()
      .median(3)
      .threshold(150),
  );
}

// sRGB <-> CIELAB (D65), for a palette transfer that moves colour without moving lightness structure.
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const gam = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
const fLab = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
const fInv = (t: number) => (t ** 3 > 0.008856 ? t ** 3 : (t - 16 / 116) / 7.787);
function toLab(r: number, g: number, b: number): [number, number, number] {
  const [R, G, B] = [lin(r / 255), lin(g / 255), lin(b / 255)];
  const x = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
  const y = R * 0.2126 + G * 0.7152 + B * 0.0722;
  const z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
  const [fx, fy, fz] = [fLab(x), fLab(y), fLab(z)];
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}
function fromLab(L: number, a: number, b: number): [number, number, number] {
  const fy = (L + 16) / 116;
  const [x, y, z] = [fInv(fy + a / 500) * 0.95047, fInv(fy), fInv(fy - b / 200) * 1.08883];
  const R = x * 3.2406 + y * -1.5372 + z * -0.4986;
  const G = x * -0.9689 + y * 1.8758 + z * 0.0415;
  const B = x * 0.0557 + y * -0.204 + z * 1.057;
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(gam(Math.max(0, v)) * 255)));
  return [c(R), c(G), c(B)];
}
async function labPixels(data: Uint8Array, maxSide?: number) {
  let img = sharp(data, { limitInputPixels: false }).flatten({ background: "#ffffff" }).removeAlpha();
  if (maxSide) img = img.resize(maxSide, maxSide, { fit: "inside", withoutEnlargement: true });
  const { data: px, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const lab = new Float32Array(info.width * info.height * 3);
  for (let i = 0; i < info.width * info.height; i++) {
    const [L, A, B] = toLab(px[i * 3]!, px[i * 3 + 1]!, px[i * 3 + 2]!);
    lab[i * 3] = L;
    lab[i * 3 + 1] = A;
    lab[i * 3 + 2] = B;
  }
  return { lab, width: info.width, height: info.height };
}
const stats = (lab: Float32Array) => {
  const n = lab.length / 3;
  const mean = [0, 0, 0];
  const sd = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) mean[k]! += lab[i * 3 + k]! / n;
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) sd[k]! += (lab[i * 3 + k]! - mean[k]!) ** 2 / n;
  return { mean, sd: sd.map((v) => Math.sqrt(v) || 1) };
};

export const PALETTE_MAX_PIXELS = 12_000_000;

/**
 * The colours of `palette` on `data` (Reinhard transfer in CIELAB): each channel's mean and spread matched, so the
 * picture takes the other image's palette while its shapes and light stay. `strength` 0..1 blends with the original.
 */
export async function paletteTransfer(data: Uint8Array, palette: Uint8Array, strength = 1) {
  // The transfer runs per pixel on the calling thread (the API's): bounded so one request cannot stall or exhaust it.
  // ponytail: rejects past 12 MP; tile it or move it to the worker if bigger artwork needs a palette.
  for (const img of [data, palette]) {
    const meta = await sharp(img, { limitInputPixels: false }).metadata();
    if ((meta.width ?? 0) * (meta.height ?? 0) > PALETTE_MAX_PIXELS)
      throw new InvalidImageError("This image is too large for the palette tool (12 megapixels at most)");
  }
  const src = await labPixels(data);
  const ref = await labPixels(palette, 512);
  const s = stats(src.lab);
  const r = stats(ref.lab);
  const out = Buffer.alloc(src.width * src.height * 3);
  for (let i = 0; i < src.width * src.height; i++) {
    const v = [0, 1, 2].map((k) => {
      const x = src.lab[i * 3 + k]!;
      const moved = ((x - s.mean[k]!) / s.sd[k]!) * r.sd[k]! + r.mean[k]!;
      return x + (moved - x) * strength;
    });
    const [R, G, B] = fromLab(v[0]!, v[1]!, v[2]!);
    out[i * 3] = R;
    out[i * 3 + 1] = G;
    out[i * 3 + 2] = B;
  }
  return toPng(sharp(out, { raw: { width: src.width, height: src.height, channels: 3 } }));
}

/** A mask that lets an edit change the whole image (painted = editable, as user masks are drawn). */
export async function fullMask(width: number, height: number) {
  return toPng(sharp({ create: { width, height, channels: 4, background: "#ffffff" } }));
}

/**
 * The picture centred on a larger canvas of aspect `aspect` (width / height), and the mask of the new area, for an
 * edit that paints the scene outwards (outpainting): 16:9 art widened to 9:16 instead of cropped.
 */
export async function extendCanvas(data: Uint8Array, aspect: number) {
  const m = await sharp(data).metadata();
  const [w, h] = [m.width ?? 1, m.height ?? 1];
  const [W, H] = w / h > aspect ? [w, Math.round(w / aspect)] : [Math.round(h * aspect), h];
  if (W === w && H === h) throw new InvalidImageError("The picture already has that shape");
  const left = Math.floor((W - w) / 2);
  const top = Math.floor((H - h) / 2);
  const canvas = await toPng(
    sharp(data, { limitInputPixels: false })
      .flatten({ background: "#808080" })
      .extend({ left, right: W - w - left, top, bottom: H - h - top, background: "#808080" }),
  );
  const keep = await sharp({ create: { width: w, height: h, channels: 4, background: "#000000" } })
    .png()
    .toBuffer();
  const mask = await toPng(
    sharp({ create: { width: W, height: H, channels: 4, background: "#ffffff" } }).composite([
      { input: keep, left, top },
    ]),
  );
  return { canvas, mask };
}

// ---------------------------------------------------------------- near-duplicate features

/**
 * Small deterministic features of an image for finding near-duplicates without a model: a 64-bit difference hash
 * of the whole picture (near-identical images), a 16x16 edge map of its middle (where figures usually are: repeated
 * poses), and a colour histogram of its outer ring (repeated backgrounds).
 */
export type ImageFeatures = { dhash: string; center: number[]; border: number[] };

export async function imageFeatures(data: Uint8Array): Promise<ImageFeatures> {
  const grey = await sharp(data, { limitInputPixels: false })
    .flatten({ background: "#ffffff" })
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += grey[y * 9 + x]! < grey[y * 9 + x + 1]! ? "1" : "0";
  const dhash = BigInt(`0b${bits}`).toString(16).padStart(16, "0");

  const meta = await sharp(data).metadata();
  const [w, h] = [meta.width ?? 1, meta.height ?? 1];
  const mid = await sharp(data, { limitInputPixels: false })
    .flatten({ background: "#ffffff" })
    .extract({
      left: Math.round(w * 0.2),
      top: Math.round(h * 0.2),
      width: Math.max(1, Math.round(w * 0.6)),
      height: Math.max(1, Math.round(h * 0.6)),
    })
    .greyscale()
    .resize(18, 18, { fit: "fill" })
    .raw()
    .toBuffer();
  // Gradient magnitude on the inner 16x16, zero-mean and unit-length, so a dot product is a correlation.
  const center: number[] = [];
  for (let y = 1; y < 17; y++)
    for (let x = 1; x < 17; x++) {
      const gx = mid[y * 18 + x + 1]! - mid[y * 18 + x - 1]!;
      const gy = mid[(y + 1) * 18 + x]! - mid[(y - 1) * 18 + x]!;
      center.push(Math.hypot(gx, gy));
    }
  const m = center.reduce((a, b) => a + b, 0) / center.length;
  const centred = center.map((v) => v - m);
  const norm = Math.hypot(...centred) || 1;

  const small = await sharp(data, { limitInputPixels: false })
    .flatten({ background: "#ffffff" })
    .removeAlpha()
    .resize(32, 32, { fit: "fill" })
    .raw()
    .toBuffer();
  const border = new Array<number>(64).fill(0);
  let n = 0;
  for (let y = 0; y < 32; y++)
    for (let x = 0; x < 32; x++) {
      if (x >= 5 && x < 27 && y >= 5 && y < 27) continue;
      const i = (y * 32 + x) * 3;
      border[(small[i]! >> 6) * 16 + (small[i + 1]! >> 6) * 4 + (small[i + 2]! >> 6)]! += 1;
      n++;
    }
  return {
    dhash,
    center: centred.map((v) => Math.round((v / norm) * 1e4) / 1e4),
    border: border.map((v) => Math.round((v / n) * 1e4) / 1e4),
  };
}

/** Bits that differ between two difference hashes (0 = the same picture). */
export function hashDistance(a: string, b: string) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let d = 0;
  while (x) {
    d += Number(x & 1n);
    x >>= 1n;
  }
  return d;
}

/** Dot product of two unit vectors (center edge maps: a correlation). */
export const correlation = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);

/** Histogram intersection of two border histograms: 1 = the same colours in the same amounts. */
export const histogramOverlap = (a: number[], b: number[]) => a.reduce((s, v, i) => s + Math.min(v, b[i] ?? 0), 0);

export type DuplicateKind = "identical" | "pose" | "background" | "thumbnail";
export type DuplicateItem = ImageFeatures & {
  id: string;
  /** Reading position across the project (panels in order); neighbours are expected to look alike. */
  seq: number;
  /** The scene it belongs to: a background repeating inside one scene is continuity, not a duplicate. */
  scene: string | null;
  thumbnail?: boolean;
};

/**
 * Groups of near-duplicates: near-identical images, the same figure staging (pose) in panels that are not
 * neighbours, the same background across different scenes, and near-identical thumbnail candidates. Each group is
 * the connected pairs above the threshold, with its strongest pair's score.
 */
export function groupDuplicates(items: DuplicateItem[], max = 200) {
  const kinds: DuplicateKind[] = ["identical", "thumbnail", "pose", "background"];
  const parent = new Map<string, string>();
  const best = new Map<string, number>();
  const key = (kind: DuplicateKind, id: string) => `${kind}:${id}`;
  const find = (x: string): string => {
    const p = parent.get(x);
    if (!p || p === x) return x;
    const r = find(p);
    parent.set(x, r);
    return r;
  };
  const join = (kind: DuplicateKind, a: string, b: string, score: number) => {
    const [ra, rb] = [find(key(kind, a)), find(key(kind, b))];
    if (ra !== rb) parent.set(ra, rb);
    parent.set(key(kind, a), find(key(kind, a)));
    parent.set(key(kind, b), find(key(kind, b)));
    const r = find(rb);
    best.set(r, Math.max(best.get(r) ?? 0, best.get(ra) ?? 0, score));
  };
  // Hashes as two 32-bit halves: a pair's distance is two popcounts, not a BigInt loop.
  const halves = items.map((i) => [
    Number.parseInt(i.dhash.slice(0, 8), 16),
    Number.parseInt(i.dhash.slice(8, 16), 16),
  ]);
  const pop = (v: number) => {
    let x = v - ((v >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
  };
  for (let a = 0; a < items.length; a++)
    for (let b = a + 1; b < items.length; b++) {
      const [x, y] = [items[a]!, items[b]!];
      if (Boolean(x.thumbnail) !== Boolean(y.thumbnail)) continue;
      const dist = pop((halves[a]![0]! ^ halves[b]![0]!) >>> 0) + pop((halves[a]![1]! ^ halves[b]![1]!) >>> 0);
      if (dist <= 6) {
        join(x.thumbnail ? "thumbnail" : "identical", x.id, y.id, 1 - dist / 64);
        continue;
      }
      if (x.thumbnail || Math.abs(x.seq - y.seq) <= 1) continue;
      const c = correlation(x.center, y.center);
      if (c >= 0.85) join("pose", x.id, y.id, c);
      if (x.scene !== y.scene) {
        const o = histogramOverlap(x.border, y.border);
        if (o >= 0.9) join("background", x.id, y.id, o);
      }
    }
  const out: { kind: DuplicateKind; score: number; ids: string[] }[] = [];
  for (const kind of kinds) {
    const groups = new Map<string, string[]>();
    for (const i of items) {
      const k = key(kind, i.id);
      if (!parent.has(k)) continue;
      const r = find(k);
      groups.set(r, [...(groups.get(r) ?? []), i.id]);
    }
    for (const [root, ids] of groups)
      if (ids.length > 1) out.push({ kind, score: Math.round((best.get(root) ?? 0) * 1000) / 1000, ids });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, max);
}
