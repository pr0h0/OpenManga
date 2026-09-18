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
    "application/pdf": "pdf",
    "application/zip": "zip",
    "application/json": "json",
    "video/mp4": "mp4",
    "application/x-subrip": "srt",
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

export { sharp };
