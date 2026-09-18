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
