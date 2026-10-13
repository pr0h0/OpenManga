import { InvalidImageError, sanitizeUpload } from "@openmanga/image-utils";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { ApiError, badRequest } from "./http.ts";

/** Read a multipart image upload: size-limited, magic-byte validated, re-encoded without metadata. */
export async function readImageUpload(c: Context<AppEnv>, field = "file") {
  const max = c.get("deps").config.UPLOAD_MAX_BYTES;
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > max + 64_000) throw new ApiError(413, "too_large", `Upload exceeds ${Math.round(max / 1024 / 1024)} MB`);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest("Expected multipart/form-data");
  }
  const file = form.get(field);
  if (!(file instanceof File)) throw badRequest(`Missing file field "${field}"`);
  if (file.size > max) throw new ApiError(413, "too_large", `Upload exceeds ${Math.round(max / 1024 / 1024)} MB`);
  const raw = new Uint8Array(await file.arrayBuffer());
  try {
    const clean = await sanitizeUpload(raw);
    return { ...clean, form, originalName: file.name.slice(0, 200) };
  } catch (e) {
    if (e instanceof InvalidImageError)
      throw new ApiError(415, "unsupported_media", "Only PNG, JPEG and WebP images are allowed");
    // The magic bytes said PNG/JPEG/WebP but the decoder could not read it — a truncated or corrupt file. That
    // is the caller's upload, not a server fault, so it must not surface as a 500.
    throw new ApiError(415, "unsupported_media", "That image could not be read — it looks truncated or corrupt");
  }
}

/** An audio file's type from its first bytes: MP3, WAV, OGG, FLAC or an MP4/M4A container; null for anything else. */
export function sniffAudio(b: Uint8Array): string | null {
  const ascii = (from: number, n: number) => String.fromCharCode(...b.slice(from, from + n));
  if (ascii(0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0)) return "audio/mpeg";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(4, 4) === "ftyp") return "audio/mp4";
  return null;
}

/** A music or sound upload (multipart `file`): the bytes and their type, refused unless they are audio. */
export async function readAudioUpload(c: Context<AppEnv>, field = "file") {
  const max = c.get("deps").config.UPLOAD_MAX_BYTES;
  if (Number(c.req.header("content-length") ?? 0) > max + 64_000)
    throw new ApiError(413, "too_large", `Upload exceeds ${Math.round(max / 1024 / 1024)} MB`);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest("Expected multipart/form-data");
  }
  const file = form.get(field);
  if (!(file instanceof File)) throw badRequest(`Missing file field "${field}"`);
  if (file.size > max) throw new ApiError(413, "too_large", `Upload exceeds ${Math.round(max / 1024 / 1024)} MB`);
  const data = new Uint8Array(await file.arrayBuffer());
  const mime = sniffAudio(data);
  if (!mime) throw new ApiError(415, "unsupported_media", "Only MP3, WAV, OGG, FLAC and M4A audio is allowed");
  return { data, mime, originalName: file.name.slice(0, 200) };
}
