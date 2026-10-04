import { classifyFetchError, ProviderError, withRetry } from "@openmanga/domain/browser";
import { mockWav, scenarioFromText } from "@openmanga/testing";
import { pcmToWav } from "./cloud.ts";

export type SynthesizeRequest = { text: string; voice: string; speed: number; language?: string; signal?: AbortSignal };
export type SynthesizeResult = {
  wav: Uint8Array;
  sampleRate: number;
  durationMs: number;
  modelVersion: string | null;
  provider: string;
};
export type TTSStatus = {
  ok: boolean;
  state: "ready" | "loading" | "offline" | "disabled" | "error";
  detail?: string;
  modelVersion?: string | null;
};
export type Voice = { id: string; name: string; language: string; gender?: string };

export interface TTSProvider {
  readonly provider: string;
  health(): Promise<TTSStatus>;
  voices(): Promise<Voice[]>;
  synthesize(req: SynthesizeRequest): Promise<SynthesizeResult>;
}

export class KokoroTTSProvider implements TTSProvider {
  readonly provider = "kokoro";
  constructor(private readonly opts: { url: string; timeoutMs?: number; fetch?: typeof fetch }) {}

  private async req(path: string, init?: RequestInit, timeoutMs = 10_000) {
    try {
      return await (this.opts.fetch ?? fetch)(`${this.opts.url.replace(/\/$/, "")}${path}`, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
    } catch (e) {
      const pe = classifyFetchError(this.provider, e);
      throw pe.code === "network"
        ? new ProviderError(this.provider, "offline", `Kokoro unreachable: ${pe.message}`)
        : pe;
    }
  }

  async health(): Promise<TTSStatus> {
    try {
      const res = await this.req("/health", undefined, 3000);
      const body = (await res.json().catch(() => ({}))) as { status?: string; model_version?: string; detail?: string };
      if (res.status === 503 || body.status === "loading") return { ok: false, state: "loading", detail: body.detail };
      if (!res.ok) return { ok: false, state: "error", detail: `HTTP ${res.status}` };
      return { ok: true, state: "ready", modelVersion: body.model_version ?? null };
    } catch (e) {
      return { ok: false, state: "offline", detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async voices(): Promise<Voice[]> {
    const res = await this.req("/voices");
    if (!res.ok)
      throw new ProviderError(
        this.provider,
        res.status === 503 ? "model_loading" : "server_error",
        `Kokoro voices HTTP ${res.status}`,
      );
    const body = (await res.json()) as { voices: Voice[] };
    return body.voices;
  }

  synthesize(r: SynthesizeRequest): Promise<SynthesizeResult> {
    return withRetry(
      async () => {
        const res = await this.req(
          "/synthesize",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: r.text, voice: r.voice, speed: r.speed, format: "wav", language: r.language }),
          },
          this.opts.timeoutMs ?? 180_000,
        );
        if (res.status === 503)
          throw new ProviderError(this.provider, "model_loading", "Kokoro model is loading", { retryAfterMs: 5000 });
        if (res.status === 400 || res.status === 422) {
          const detail = await res.text();
          throw new ProviderError(this.provider, "invalid_request", `Kokoro rejected request: ${detail.slice(0, 200)}`);
        }
        if (!res.ok)
          throw new ProviderError(
            this.provider,
            "synthesis_error",
            `Kokoro synthesis HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
          );
        const wav = new Uint8Array(await res.arrayBuffer());
        const info = parseWav(wav);
        return {
          wav,
          sampleRate: info.sampleRate,
          durationMs: info.durationMs,
          modelVersion: res.headers.get("x-model-version"),
          provider: this.provider,
        };
      },
      { retries: 2, baseMs: 2000 },
    );
  }
}

export class FakeTTSProvider implements TTSProvider {
  readonly provider = "fake-tts";
  async health(): Promise<TTSStatus> {
    return { ok: true, state: "ready", modelVersion: "fake" };
  }
  async voices(): Promise<Voice[]> {
    return [
      { id: "af_heart", name: "Heart (fake)", language: "en-us", gender: "female" },
      { id: "am_michael", name: "Michael (fake)", language: "en-us", gender: "male" },
      { id: "bf_emma", name: "Emma (fake)", language: "en-gb", gender: "female" },
    ];
  }
  async synthesize(r: SynthesizeRequest): Promise<SynthesizeResult> {
    const sc = scenarioFromText(r.text);
    if (sc === "timeout") throw new ProviderError(this.provider, "offline", "fake offline");
    if (sc === "503") throw new ProviderError(this.provider, "model_loading", "fake loading");
    if (sc === "500")
      throw new ProviderError(this.provider, "synthesis_error", "fake synthesis error", { retryable: false });
    const w = mockWav(r.text, { speed: r.speed });
    return {
      wav: w.data,
      sampleRate: w.sampleRate,
      durationMs: w.durationMs,
      modelVersion: "fake",
      provider: this.provider,
    };
  }
}

export type WavInfo = {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  dataLength: number;
  durationMs: number;
};

export function parseWav(b: Uint8Array): WavInfo {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  if (b.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let o = 12;
  let fmt: { channels: number; sampleRate: number; bits: number } | null = null;
  while (o + 8 <= b.length) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt ")
      fmt = {
        channels: v.getUint16(o + 10, true),
        sampleRate: v.getUint32(o + 12, true),
        bits: v.getUint16(o + 22, true),
      };
    if (id === "data") {
      if (!fmt) throw new Error("WAV data before fmt");
      const len = Math.min(size, b.length - o - 8);
      const bytesPerSec = fmt.sampleRate * fmt.channels * (fmt.bits / 8);
      return {
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        bitsPerSample: fmt.bits,
        dataOffset: o + 8,
        dataLength: len,
        durationMs: Math.round((len / bytesPerSec) * 1000),
      };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

/** What a narration segment's audio measures: its levels, clipped stretches and the longest pause inside it. */
export type AudioStats = {
  durationMs: number;
  /** Highest sample, dBFS. */
  peakDb: number;
  /** RMS over the windows that are not silent (the speech level, unaffected by pauses), dBFS; -Infinity if none. */
  speechDb: number;
  /** Time in runs of three or more samples at full scale: the voice was cut off at the top. */
  clippedMs: number;
  /** The longest silence between the first and the last sound. */
  longestGapMs: number;
};

const db = (amplitude: number) => (amplitude > 0 ? 20 * Math.log10(amplitude / 32768) : Number.NEGATIVE_INFINITY);

/** Levels, clipping and pauses of a 16-bit PCM WAV, in 10 ms windows; silence is below `silenceDb` (-45). */
export function analyseWav(wav: Uint8Array, opts: { silenceDb?: number } = {}): AudioStats {
  const info = parseWav(wav);
  if (info.bitsPerSample !== 16) throw new Error(`Cannot analyse ${info.bitsPerSample}-bit audio`);
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const samples = Math.floor(info.dataLength / 2);
  const win = Math.max(1, Math.round(info.sampleRate * info.channels * 0.01));
  const silence = 32768 * 10 ** ((opts.silenceDb ?? -45) / 20);
  let peak = 0;
  let clipped = 0;
  let run = 0;
  let speechSq = 0;
  let speechN = 0;
  let first = -1;
  let last = -1;
  let gap = 0;
  let longest = 0;
  for (let w = 0; w * win < samples; w++) {
    let max = 0;
    let sq = 0;
    const end = Math.min(samples, (w + 1) * win);
    for (let i = w * win; i < end; i++) {
      const x = Math.abs(view.getInt16(info.dataOffset + i * 2, true));
      if (x > max) max = x;
      sq += x * x;
      if (x >= 32_700) run++;
      else {
        if (run >= 3) clipped += run;
        run = 0;
      }
    }
    if (max > peak) peak = max;
    if (max < silence) {
      if (first >= 0) gap++;
      continue;
    }
    if (first < 0) first = w;
    else longest = Math.max(longest, gap);
    gap = 0;
    last = w;
    speechSq += sq;
    speechN += end - w * win;
  }
  if (run >= 3) clipped += run;
  const perMs = (info.sampleRate * info.channels) / 1000;
  return {
    durationMs: info.durationMs,
    peakDb: db(peak),
    speechDb: speechN ? db(Math.sqrt(speechSq / speechN)) : Number.NEGATIVE_INFINITY,
    clippedMs: Math.round(clipped / perMs),
    longestGapMs: last > first ? longest * 10 : 0,
  };
}

/** Concatenate PCM WAVs (same format) with silence gaps. Deterministic, no external tools. */
/**
 * Trims leading/trailing silence from a 16-bit PCM WAV. TTS voices (Kokoro measured ~0.31s leading, ~0.69s
 * trailing) pad every segment, and that padding stacks with the composed pause at every cut: a narrated film
 * measured 24.6% dead air, ~1.2s at each shot change. Trimming at the source makes `pauseAfterMs` and the video
 * breath the only pauses, so those numbers mean what they say. `keepMs` leaves a little air so words don't clip.
 */
export function trimSilenceWav(wav: Uint8Array, opts: { thresholdDb?: number; keepMs?: number } = {}) {
  const info = parseWav(wav);
  if (info.bitsPerSample !== 16) return { wav, durationMs: info.durationMs, trimmedMs: 0 };
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const bytesPerFrame = info.channels * 2;
  const frames = Math.floor(info.dataLength / bytesPerFrame);
  const threshold = 32768 * 10 ** ((opts.thresholdDb ?? -45) / 20);
  const peak = (frame: number) => {
    let max = 0;
    for (let c = 0; c < info.channels; c++)
      max = Math.max(max, Math.abs(view.getInt16(info.dataOffset + frame * bytesPerFrame + c * 2, true)));
    return max;
  };
  let first = 0;
  while (first < frames && peak(first) < threshold) first++;
  if (first === frames) return { wav, durationMs: info.durationMs, trimmedMs: 0 };
  let last = frames - 1;
  while (last > first && peak(last) < threshold) last--;
  const keep = Math.round(((opts.keepMs ?? 25) / 1000) * info.sampleRate);
  const from = Math.max(0, first - keep);
  const to = Math.min(frames, last + 1 + keep);
  if (from === 0 && to === frames) return { wav, durationMs: info.durationMs, trimmedMs: 0 };
  const pcm = wav.subarray(info.dataOffset + from * bytesPerFrame, info.dataOffset + to * bytesPerFrame);
  const out = pcmToWav(pcm, info.sampleRate, info.channels);
  const durationMs = parseWav(out).durationMs;
  return { wav: out, durationMs, trimmedMs: info.durationMs - durationMs };
}

export function concatWav(parts: { wav: Uint8Array; pauseAfterMs: number }[]): Uint8Array {
  if (!parts.length) throw new Error("Nothing to concatenate");
  const infos = parts.map((p) => parseWav(p.wav));
  const f = infos[0]!;
  for (const i of infos) {
    if (i.sampleRate !== f.sampleRate || i.channels !== f.channels || i.bitsPerSample !== f.bitsPerSample)
      throw new Error("WAV formats differ; convert first");
  }
  const blockAlign = f.channels * (f.bitsPerSample / 8);
  const silenceBytes = (ms: number) => Math.round((ms / 1000) * f.sampleRate) * blockAlign;
  const total = parts.reduce(
    (s, p, i) => s + infos[i]!.dataLength + (i < parts.length - 1 ? silenceBytes(p.pauseAfterMs) : 0),
    0,
  );
  const out = new Uint8Array(44 + total);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, "RIFF");
  v.setUint32(4, 36 + total, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, f.channels, true);
  v.setUint32(24, f.sampleRate, true);
  v.setUint32(28, f.sampleRate * blockAlign, true);
  v.setUint16(32, blockAlign, true);
  v.setUint16(34, f.bitsPerSample, true);
  str(36, "data");
  v.setUint32(40, total, true);
  let o = 44;
  parts.forEach((p, i) => {
    const info = infos[i]!;
    out.set(p.wav.subarray(info.dataOffset, info.dataOffset + info.dataLength), o);
    o += info.dataLength;
    if (i < parts.length - 1) o += silenceBytes(p.pauseAfterMs);
  });
  return out;
}

/** ffmpeg: loudness-normalize and/or transcode. Runs locally; no cloud media services. */
export async function ffmpegConvert(
  input: Uint8Array,
  format: "mp3" | "ogg" | "wav",
  opts: { normalize?: boolean; tempDir: string },
) {
  const { join } = await import("node:path");
  const { writeFile, readFile } = await import("node:fs/promises");
  const inPath = join(opts.tempDir, `in-${crypto.randomUUID()}.wav`);
  const outPath = join(opts.tempDir, `out-${crypto.randomUUID()}.${format}`);
  await writeFile(inPath, input);
  const codec =
    format === "mp3"
      ? ["-c:a", "libmp3lame", "-b:a", "128k"]
      : format === "ogg"
        ? ["-c:a", "libvorbis", "-q:a", "5"]
        : ["-c:a", "pcm_s16le"];
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    inPath,
    ...(opts.normalize ? ["-af", "loudnorm=I=-16:TP=-1.5:LRA=11"] : []),
    "-ar",
    "24000",
    "-ac",
    "1",
    ...codec,
    outPath,
  ];
  try {
    const proc = Bun.spawn(["ffmpeg", ...args], { stderr: "pipe" });
    // A conversion of one narration track is seconds of work; anything past this is a wedged process.
    const timer = setTimeout(() => proc.kill(), 10 * 60 * 1000);
    const code = await proc.exited.finally(() => clearTimeout(timer));
    if (code !== 0)
      throw new Error(`ffmpeg failed (${code}): ${(await new Response(proc.stderr).text()).slice(0, 300)}`);
    return new Uint8Array(await readFile(outPath));
  } finally {
    // Callers may pass a long-lived directory (the narration export passes TEMP_ROOT), so clean up here.
    const { rm } = await import("node:fs/promises");
    await Promise.all([rm(inPath, { force: true }), rm(outPath, { force: true })]);
  }
}

export const AUDIO_MIME = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg" } as const;
export {
  ElevenLabsTTSProvider,
  GEMINI_TTS_VOICES,
  GeminiTTSProvider,
  OPENAI_TTS_VOICES,
  OpenAITTSProvider,
  pcmToWav,
} from "./cloud.ts";
