import { describe, expect, test } from "bun:test";
import type { ProviderError } from "@openmanga/domain";
import {
  BytePlusSeedanceProvider,
  findVideoUrl,
  GeminiVeoProvider,
  KlingVideoProvider,
  MiniMaxVideoProvider,
  RunwayVideoProvider,
} from "./direct.ts";
import type { VideoRequest } from "./index.ts";
import { videoProviderFor } from "./index.ts";

const req = (over: Partial<VideoRequest> = {}): VideoRequest => ({
  prompt: "She turns to the window",
  image: { data: new Uint8Array([1, 2, 3]), mime: "image/jpeg" },
  seconds: 6,
  resolution: "720p",
  aspect: "16:9",
  audio: false,
  ...over,
});

type Call = { method: string; url: string; body: Record<string, unknown> | null; headers: Record<string, string> };
function stub(routes: [RegExp, (c: Call) => Response][]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const c = {
      method: init?.method ?? "GET",
      url,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(c);
    const r = routes.find(([re]) => re.test(`${c.method} ${url}`));
    if (!r) throw new Error(`unexpected ${c.method} ${url}`);
    return r[1](c);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
const mp4 = () => new Response(new Uint8Array([7, 7]), { headers: { "content-type": "video/mp4" } });
const opts = (model: string, baseUrl: string, fetch: typeof globalThis.fetch) => ({
  apiKey: "k",
  model,
  baseUrl,
  fetch,
});

test("every direct provider kind has an adapter; other kinds have none", () => {
  for (const k of ["fal", "google", "kling", "runway", "minimax", "byteplus"])
    expect(videoProviderFor(k, { apiKey: "k", model: "m", baseUrl: "https://x" })).not.toBeNull();
  expect(videoProviderFor("openai", { apiKey: "k", model: "m", baseUrl: "https://x" })).toBeNull();
});

test("a video URL is found wherever an answer puts it", () => {
  expect(findVideoUrl({ data: [{ task_result: { videos: [{ url: "https://cdn/v.mp4" }] } }] })).toBe(
    "https://cdn/v.mp4",
  );
  expect(findVideoUrl({ output: ["https://cdn/o.mp4"] })).toBe("https://cdn/o.mp4");
  expect(findVideoUrl({ status: "ok", note: "https://not-a-video-key" })).toBeNull();
});

describe("Google Veo (Gemini API)", () => {
  const base = "https://generativelanguage.googleapis.com/v1beta";
  test("an operation with the image inline, polled until done, downloaded with the key", async () => {
    let done = false;
    const s = stub([
      [/predictLongRunning/, () => json({ name: "models/veo/operations/op1" })],
      [
        /GET .*operations\/op1$/,
        () =>
          json(
            done
              ? {
                  done: true,
                  response: { generateVideoResponse: { generatedSamples: [{ video: { uri: "https://g/file" } }] } },
                }
              : { done: false },
          ),
      ],
      [/GET https:\/\/g\/file/, () => mp4()],
    ]);
    const p = new GeminiVeoProvider(opts("veo-3.1-fast-generate-preview", base, s.fetch));
    const { id } = await p.submit(req({ endImage: { data: new Uint8Array([4]), mime: "image/png" } }));
    expect(id).toBe("models/veo/operations/op1");
    const body = s.calls[0]!.body as { instances: Record<string, unknown>[]; parameters: Record<string, unknown> };
    expect(s.calls[0]!.headers["x-goog-api-key"]).toBe("k");
    expect(body.instances[0]).toMatchObject({
      prompt: "She turns to the window",
      image: { inlineData: { mimeType: "image/jpeg" } },
    });
    expect(body.instances[0]!.lastFrame).toBeDefined();
    expect(body.parameters).toMatchObject({
      aspectRatio: "16:9",
      durationSeconds: "6",
      personGeneration: "allow_adult",
    });
    expect(await p.poll(id)).toEqual({ state: "running", position: null });
    done = true;
    const r = await p.poll(id);
    expect(r.state).toBe("done");
    expect(s.calls.at(-1)!.headers["x-goog-api-key"]).toBe("k");
  });
  test("a filtered video is a content-policy refusal", async () => {
    const s = stub([
      [
        /GET/,
        () => json({ done: true, response: { generateVideoResponse: { raiMediaFilteredReasons: ["children"] } } }),
      ],
    ]);
    const p = new GeminiVeoProvider(opts("veo-3.1-fast-generate-preview", base, s.fetch));
    expect(await p.poll("op").catch((e) => e)).toMatchObject({ code: "content_policy", retryable: false });
  });
});

describe("Kling", () => {
  const base = "https://api-singapore.klingai.com";
  test("first and last frame as base64, polled by our own task id; sound off unless asked", async () => {
    const s = stub([
      [/POST .*image-to-video\/kling-3\.0/, () => json({ code: 0, data: { task_id: "t1" } })],
      [
        /GET .*tasks\?external_task_ids=/,
        () => json({ code: 0, data: [{ status: "succeeded", result: { videos: [{ url: "https://k/v.mp4" }] } }] }),
      ],
      [/GET https:\/\/k\/v\.mp4/, () => mp4()],
    ]);
    const p = new KlingVideoProvider(opts("kling-3.0", base, s.fetch));
    const { id } = await p.submit(req({ endImage: { data: new Uint8Array([4]), mime: "image/png" } }));
    const body = s.calls[0]!.body as {
      contents: { type: string }[];
      settings: Record<string, unknown>;
      options: { external_task_id: string };
    };
    expect(body.contents.map((c) => c.type)).toEqual(["prompt", "first_frame", "last_frame"]);
    expect(body.settings).toEqual({ resolution: "720p", duration: 6, audio: "off" });
    expect(id as string).toBe(body.options.external_task_id);
    expect((await p.poll(id)).state).toBe("done");
  });
  test("its error codes: auth, balance and policy", async () => {
    const at = (code: number) =>
      new KlingVideoProvider(opts("kling-3.0", base, stub([[/POST/, () => json({ code, message: "x" })]]).fetch))
        .submit(req())
        .then(() => null as unknown as ProviderError)
        .catch((e) => e as ProviderError);
    expect((await at(1002)).code).toBe("auth");
    expect((await at(1102)).code).toBe("quota");
    expect((await at(1301)).code).toBe("content_policy");
  });
});

describe("Runway", () => {
  test("version header, ratio and an inline image; a moderated task is a refusal", async () => {
    let status = "RUNNING";
    const s = stub([
      [/POST .*image_to_video/, () => json({ id: "r1" })],
      [/GET .*tasks\/r1/, () => json(status === "SUCCEEDED" ? { status, output: ["https://r/o.mp4"] } : { status })],
      [/GET https:\/\/r\/o\.mp4/, () => mp4()],
    ]);
    const p = new RunwayVideoProvider(opts("gen4_turbo", "https://api.dev.runwayml.com/v1", s.fetch));
    await p.submit(req({ aspect: "9:16" }));
    expect(s.calls[0]!.headers["x-runway-version"]).toBe("2024-11-06");
    expect(s.calls[0]!.body).toMatchObject({ model: "gen4_turbo", ratio: "720:1280", duration: 6 });
    expect(String(s.calls[0]!.body!.promptImage)).toStartWith("data:image/jpeg;base64,");
    expect((await p.poll("r1")).state).toBe("running");
    status = "SUCCEEDED";
    expect((await p.poll("r1")).state).toBe("done");
    const bad = stub([
      [/GET/, () => json({ status: "FAILED", failure: "blocked", failureCode: "SAFETY.INPUT.IMAGE" })],
    ]);
    const q = new RunwayVideoProvider(opts("gen4_turbo", "https://api.dev.runwayml.com/v1", bad.fetch));
    expect(await q.poll("r1").catch((e) => e)).toMatchObject({ code: "content_policy" });
  });
});

describe("MiniMax", () => {
  test("a task, then a file id, then its download link; errors arrive in base_resp", async () => {
    const s = stub([
      [/POST .*video_generation/, () => json({ task_id: "m1", base_resp: { status_code: 0 } })],
      [
        /GET .*query\/video_generation/,
        () => json({ status: "Success", file_id: "f1", base_resp: { status_code: 0 } }),
      ],
      [
        /GET .*files\/retrieve/,
        () => json({ file: { download_url: "https://mm/v.mp4" }, base_resp: { status_code: 0 } }),
      ],
      [/GET https:\/\/mm\/v\.mp4/, () => mp4()],
    ]);
    const p = new MiniMaxVideoProvider(opts("MiniMax-Hailuo-02", "https://api.minimax.io/v1", s.fetch));
    const { id } = await p.submit(req({ resolution: "480p" }));
    expect(s.calls[0]!.body).toMatchObject({ model: "MiniMax-Hailuo-02", duration: 6, resolution: "512P" });
    expect((await p.poll(id)).state).toBe("done");
    const broke = stub([
      [/POST/, () => json({ base_resp: { status_code: 1008, status_msg: "insufficient balance" } })],
    ]);
    const q = new MiniMaxVideoProvider(opts("MiniMax-Hailuo-02", "https://api.minimax.io/v1", broke.fetch));
    expect(await q.submit(req()).catch((e) => e)).toMatchObject({ code: "quota" });
  });
});

describe("BytePlus Seedance", () => {
  test("text and frames as content, sound as asked, polled until it has a video URL", async () => {
    const s = stub([
      [/POST .*generations\/tasks$/, () => json({ id: "b1" })],
      [/GET .*generations\/tasks\/b1/, () => json({ status: "succeeded", content: { video_url: "https://bp/v.mp4" } })],
      [/GET https:\/\/bp\/v\.mp4/, () => mp4()],
    ]);
    const p = new BytePlusSeedanceProvider(
      opts("seedance-1-5-pro-251215", "https://ark.ap-southeast.bytepluses.com/api/v3", s.fetch),
    );
    await p.submit(req({ audio: true }));
    const body = s.calls[0]!.body as { content: { type: string; role?: string }[]; generate_audio: boolean };
    expect(body.content.map((c) => c.role ?? c.type)).toEqual(["text", "first_frame"]);
    expect(body.generate_audio).toBe(true);
    expect((await p.poll("b1")).state).toBe("done");
  });
});
