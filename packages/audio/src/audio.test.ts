import { describe, expect, test } from "bun:test";
import { mockWav } from "@openmanga/testing";
import {
  analyseWav,
  concatWav,
  ElevenLabsTTSProvider,
  FakeTTSProvider,
  GeminiTTSProvider,
  KokoroTTSProvider,
  OpenAITTSProvider,
  parseWav,
  pcmToWav,
  trimSilenceWav,
} from "./index.ts";

describe("wav utils", () => {
  test("parse and concat with silence", () => {
    const a = mockWav("hello there friend");
    const b = mockWav("second");
    const joined = concatWav([
      { wav: a.data, pauseAfterMs: 500 },
      { wav: b.data, pauseAfterMs: 999 },
    ]);
    const info = parseWav(joined);
    expect(info.sampleRate).toBe(24000);
    expect(info.channels).toBe(1);
    expect(info.durationMs).toBe(a.durationMs + 500 + b.durationMs);
    expect(() => parseWav(new Uint8Array(10))).toThrow();
  });
});

describe("tts providers", () => {
  test("fake synthesizes 24k mono wav; scenarios", async () => {
    const p = new FakeTTSProvider();
    const r = await p.synthesize({ text: "The city had already fallen.", voice: "af_heart", speed: 1 });
    expect(r.sampleRate).toBe(24000);
    expect(r.durationMs).toBeGreaterThan(0);
    await expect(p.synthesize({ text: "[[mock:500]]", voice: "af_heart", speed: 1 })).rejects.toMatchObject({
      code: "synthesis_error",
    });
  });

  test("kokoro offline and loading states", async () => {
    const offline = new KokoroTTSProvider({
      url: "http://kokoro:8000",
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect((await offline.health()).state).toBe("offline");
    const loading = new KokoroTTSProvider({
      url: "http://k",
      fetch: (async () =>
        new Response(JSON.stringify({ status: "loading" }), { status: 503 })) as unknown as typeof fetch,
    });
    expect((await loading.health()).state).toBe("loading");
    const bad = new KokoroTTSProvider({
      url: "http://k",
      fetch: (async () => new Response("bad voice", { status: 422 })) as unknown as typeof fetch,
    });
    await expect(bad.synthesize({ text: "x", voice: "nope", speed: 1 })).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  test("kokoro success parses wav", async () => {
    const w = mockWav("hello");
    const ok = new KokoroTTSProvider({
      url: "http://k",
      fetch: (async () =>
        new Response(w.data, { headers: { "x-model-version": "kokoro-82m-v1.0" } })) as unknown as typeof fetch,
    });
    const r = await ok.synthesize({ text: "hello", voice: "af_heart", speed: 1 });
    expect(r.durationMs).toBe(w.durationMs);
    expect(r.modelVersion).toBe("kokoro-82m-v1.0");
  });
});

describe("cloud TTS providers", () => {
  const pcm = new Uint8Array(48_000); // 1 s of 16-bit mono at 24 kHz
  const capture = (make: () => Response) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return make();
    }) as unknown as typeof fetch;
    return { f, seen };
  };

  test("pcmToWav produces a WAV that parses and concatenates with Kokoro-format audio", () => {
    const wav = pcmToWav(pcm, 24_000);
    const info = parseWav(wav);
    expect(info).toMatchObject({ sampleRate: 24_000, channels: 1, bitsPerSample: 16, durationMs: 1000 });
    const joined = parseWav(
      concatWav([
        { wav, pauseAfterMs: 500 },
        { wav, pauseAfterMs: 0 },
      ]),
    );
    expect(joined.durationMs).toBe(2500);
  });

  test("OpenAI requests PCM with voice/speed and returns WAV", async () => {
    const { f, seen } = capture(() => new Response(pcm));
    const r = await new OpenAITTSProvider({
      apiKey: "sk-1",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-4o-mini-tts",
      fetch: f,
    }).synthesize({ text: "Hello", voice: "marin", speed: 1.2 });
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/audio/speech");
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({
      model: "gpt-4o-mini-tts",
      voice: "marin",
      input: "Hello",
      response_format: "pcm",
      speed: 1.2,
    });
    expect(r).toMatchObject({ provider: "openai", sampleRate: 24_000, durationMs: 1000 });
    expect(parseWav(r.wav).durationMs).toBe(1000);
  });

  test("Gemini decodes base64 L16 and honors the rate in the mime type; missing audio is an error", async () => {
    const body = {
      candidates: [
        {
          content: {
            parts: [
              { inlineData: { mimeType: "audio/L16;codec=pcm;rate=24000", data: Buffer.from(pcm).toString("base64") } },
            ],
          },
        },
      ],
    };
    const { f, seen } = capture(() => new Response(JSON.stringify(body)));
    const p = new GeminiTTSProvider({
      apiKey: "g",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      model: "gemini-2.5-flash-preview-tts",
      fetch: f,
    });
    const r = await p.synthesize({ text: "Hi", voice: "Kore", speed: 1 });
    expect(seen[0]!.url).toContain("gemini-2.5-flash-preview-tts:generateContent");
    expect(
      JSON.parse(String(seen[0]!.init.body)).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName,
    ).toBe("Kore");
    expect(r.durationMs).toBe(1000);
    const empty = capture(() => new Response(JSON.stringify({ candidates: [{ finishReason: "SAFETY" }] })));
    const e = await new GeminiTTSProvider({ apiKey: "g", baseUrl: "https://x", model: "m", fetch: empty.f })
      .synthesize({ text: "x", voice: "Kore", speed: 1 })
      .catch((x) => x);
    expect(e.code).toBe("content_policy");
  });

  test("ElevenLabs uses the voice id path with pcm_24000 and maps account voices", async () => {
    const { f, seen } = capture(() => new Response(pcm));
    const p = new ElevenLabsTTSProvider({
      apiKey: "xi",
      baseUrl: "https://api.elevenlabs.io",
      model: "eleven_flash_v2_5",
      fetch: f,
    });
    await p.synthesize({ text: "Hey", voice: "abc 123", speed: 2 });
    expect(seen[0]!.url).toBe("https://api.elevenlabs.io/v1/text-to-speech/abc%20123?output_format=pcm_24000");
    expect(JSON.parse(String(seen[0]!.init.body))).toMatchObject({
      model_id: "eleven_flash_v2_5",
      voice_settings: { speed: 1.2 },
    });
    const v = capture(
      () =>
        new Response(
          JSON.stringify({
            voices: [{ voice_id: "v1", name: "Rachel", labels: { gender: "female", accent: "american" } }],
          }),
        ),
    );
    const voices = await new ElevenLabsTTSProvider({
      apiKey: "xi",
      baseUrl: "https://api.elevenlabs.io",
      model: "m",
      fetch: v.f,
    }).voices();
    expect(voices).toEqual([{ id: "v1", name: "Rachel", language: "american", gender: "female" }]);
    const bad = capture(
      () => new Response(JSON.stringify({ detail: { message: "invalid api key" } }), { status: 401 }),
    );
    const e = await new ElevenLabsTTSProvider({
      apiKey: "xi",
      baseUrl: "https://api.elevenlabs.io",
      model: "m",
      fetch: bad.f,
    })
      .synthesize({ text: "x", voice: "v", speed: 1 })
      .catch((x) => x);
    expect(e.code).toBe("auth");
    expect(e.message).toContain("invalid api key");
  });
});

test("trimSilenceWav removes voice padding and reports what it cut", () => {
  const rate = 24_000;
  const frames = (ms: number) => Math.round((ms / 1000) * rate);
  const pcm = new Int16Array(frames(1500));
  // 300ms of silence, 900ms of tone, 300ms of silence — the shape Kokoro produces.
  for (let i = frames(300); i < frames(1200); i++) pcm[i] = i % 2 ? 9000 : -9000;
  const wav = pcmToWav(new Uint8Array(pcm.buffer), rate);
  expect(parseWav(wav).durationMs).toBe(1500);
  const t = trimSilenceWav(wav, { thresholdDb: -45, keepMs: 25 });
  expect(t.durationMs).toBeGreaterThanOrEqual(940);
  expect(t.durationMs).toBeLessThanOrEqual(960);
  expect(t.trimmedMs).toBeGreaterThan(500);
  expect(parseWav(t.wav).sampleRate).toBe(rate);
  // All-silence and already-tight audio come back untouched.
  const silent = pcmToWav(new Uint8Array(new Int16Array(frames(200)).buffer), rate);
  expect(trimSilenceWav(silent).trimmedMs).toBe(0);
});

test("OpenAI voice list follows the model: legacy tts-1 rejects the newer voices", async () => {
  const modern = await new OpenAITTSProvider({
    apiKey: "k",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini-tts",
  }).voices();
  const legacy = await new OpenAITTSProvider({
    apiKey: "k",
    baseUrl: "https://api.openai.com/v1",
    model: "tts-1-hd",
  }).voices();
  expect(modern.map((v) => v.id)).toContain("marin");
  expect(legacy.map((v) => v.id)).not.toContain("marin");
  expect(legacy.map((v) => v.id)).toContain("nova");
  expect(legacy.length).toBeLessThan(modern.length);
});

test("analyseWav measures speech level, clipping and the longest pause inside the take", () => {
  const sr = 24_000;
  // 0.5 s tone, 2 s silence, 0.5 s tone with a clipped stretch, then 0.3 s trailing silence (not a gap).
  const n = sr * 3.3;
  const pcm = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const loud = t < 0.5 || (t >= 2.5 && t < 3);
    pcm[i] = loud ? Math.round(Math.sin(2 * Math.PI * 220 * t) * 8000) : 0;
  }
  pcm.fill(32_767, Math.round(sr * 2.6), Math.round(sr * 2.6) + 48); // 2 ms flat at full scale
  const stats = analyseWav(pcmToWav(new Uint8Array(pcm.buffer), sr));
  expect(stats.durationMs).toBe(3300);
  expect(stats.peakDb).toBeCloseTo(0, 1);
  expect(stats.clippedMs).toBe(2);
  expect(stats.longestGapMs).toBeGreaterThanOrEqual(1990);
  expect(stats.longestGapMs).toBeLessThanOrEqual(2010);
  // A sine of amplitude 8000 has an RMS of 8000/√2: about -15.2 dBFS (the clipped samples nudge it up a little).
  expect(stats.speechDb).toBeGreaterThan(-15.5);
  expect(stats.speechDb).toBeLessThan(-14);
  const silent = analyseWav(pcmToWav(new Uint8Array(new Int16Array(sr).buffer), sr));
  expect(silent.speechDb).toBe(Number.NEGATIVE_INFINITY);
  expect(silent.longestGapMs).toBe(0);
});

test("analyseWav: an empty take and a stereo one", () => {
  const empty = analyseWav(pcmToWav(new Uint8Array(0), 24_000));
  expect(empty).toMatchObject({ durationMs: 0, clippedMs: 0, longestGapMs: 0 });
  expect(empty.speechDb).toBe(Number.NEGATIVE_INFINITY);
  // Stereo at 48 kHz: 1 s of tone on both channels, 1.6 s of silence, 1 s of tone. The gap is measured in time.
  const sr = 48_000;
  const frames = sr * 3.6;
  const pcm = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i++) {
    const v = i < sr || i >= sr * 2.6 ? Math.round(Math.sin((2 * Math.PI * 300 * i) / sr) * 6000) : 0;
    pcm[i * 2] = v;
    pcm[i * 2 + 1] = v;
  }
  const stereo = analyseWav(pcmToWav(new Uint8Array(pcm.buffer), sr, 2));
  expect(stereo.durationMs).toBe(3600);
  expect(Math.abs(stereo.longestGapMs - 1600)).toBeLessThanOrEqual(10);
  expect(stereo.clippedMs).toBe(0);
});
