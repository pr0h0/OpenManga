export * from "./browser.ts";

import { createHash } from "node:crypto";
import { type Pronunciation, spokenText } from "./narration.ts";

/** Stable JSON (sorted keys) for hashing. */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

export const hashOf = (v: unknown) =>
  createHash("sha256")
    .update(typeof v === "string" ? v : stableStringify(v))
    .digest("hex");

/**
 * A narration segment's text hash: of what the voice says, so audio goes stale when a pronunciation entry changes
 * how the segment is spoken, and not otherwise. With no dictionary entry matching it is the hash of the text itself.
 */
export const segmentTextSha = (text: string, dictionary?: readonly Pronunciation[]) =>
  hashOf(spokenText(text, dictionary));
