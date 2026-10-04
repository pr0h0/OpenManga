/** Silence after a narration segment unless the user sets another value. */
export const DEFAULT_NARRATION_PAUSE_MS = 350;

/**
 * Split narration into TTS-friendly segments: paragraphs first, then sentences, packing sentences
 * up to maxChars; overlong sentences split at semantic pauses (; : , —) and finally at word boundaries.
 */
export function segmentNarration(
  text: string,
  maxChars = 400,
  pauseMs = DEFAULT_NARRATION_PAUSE_MS,
): { text: string; pauseAfterMs: number }[] {
  const out: { text: string; pauseAfterMs: number }[] = [];
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);

  for (const para of paragraphs) {
    const sentences = splitSentences(para).flatMap((s) => (s.length > maxChars ? splitLong(s, maxChars) : [s]));
    let buf = "";
    const flush = (pause: number) => {
      if (buf.trim()) out.push({ text: buf.trim(), pauseAfterMs: pause });
      buf = "";
    };
    for (const s of sentences) {
      if (buf && buf.length + 1 + s.length > maxChars) flush(pauseMs);
      buf = buf ? `${buf} ${s}` : s;
    }
    flush(pauseMs);
  }
  return out;
}

export function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) ?? [text];
  return parts.map((s) => s.trim()).filter(Boolean);
}

function splitLong(s: string, max: number): string[] {
  const pieces = s.split(/(?<=[;:,—–])\s+/);
  const out: string[] = [];
  let buf = "";
  for (const p of pieces) {
    if (p.length > max) {
      if (buf) out.push(buf);
      buf = "";
      const words = p.split(" ");
      let w = "";
      for (const word of words) {
        if (w && w.length + 1 + word.length > max) {
          out.push(w);
          w = "";
        }
        w = w ? `${w} ${word}` : word.slice(0, max);
      }
      if (w) out.push(w);
      continue;
    }
    if (buf && buf.length + 1 + p.length > max) {
      out.push(buf);
      buf = "";
    }
    buf = buf ? `${buf} ${p}` : p;
  }
  if (buf) out.push(buf);
  return out;
}

export type TimelineInput = {
  panelId: string | null;
  segmentId: string;
  audioAssetId: string | null;
  durationMs: number | null;
  pauseAfterMs: number;
  text: string;
};

export function buildTimeline(chapterId: string, items: TimelineInput[]) {
  let t = 0;
  const segments = items.map((i) => {
    const durationMs = i.durationMs ?? 0;
    const seg = {
      panelId: i.panelId,
      segmentId: i.segmentId,
      audioAssetId: i.audioAssetId,
      text: i.text,
      startMs: t,
      durationMs,
    };
    t += durationMs + i.pauseAfterMs;
    return seg;
  });
  // The pause after the last segment is never played (renderers cut at the end of the audio), so it is not counted.
  const totalDurationMs = Math.max(0, t - (items.at(-1)?.pauseAfterMs ?? 0));
  return { schemaVersion: 1, chapterId, totalDurationMs, segments };
}

export type Pronunciation = { term: string; spoken: string; caseSensitive?: boolean; wholeWord?: boolean };

/**
 * The text a voice is asked to say: every dictionary term replaced by its spoken form, in one pass so a spoken form
 * is never itself rewritten. Where matches overlap the earlier one wins, then the longer ("Seo Jinhyeok" before
 * "Seo"). Whole-word matching treats letters and digits of any script as word characters.
 */
export function spokenText(text: string, dictionary: readonly Pronunciation[] | undefined): string {
  if (!dictionary?.length) return text;
  const hits: { start: number; end: number; spoken: string }[] = [];
  for (const e of dictionary) {
    const term = e.term.trim();
    if (!term) continue;
    const body = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = e.wholeWord === false ? body : `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`;
    for (const m of text.matchAll(new RegExp(pattern, e.caseSensitive ? "gu" : "giu")))
      hits.push({ start: m.index, end: m.index + m[0].length, spoken: e.spoken });
  }
  if (!hits.length) return text;
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let at = 0;
  for (const h of hits) {
    if (h.start < at) continue;
    out += text.slice(at, h.start) + h.spoken;
    at = h.end;
  }
  return out + text.slice(at);
}
