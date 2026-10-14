import { describe, expect, test } from "bun:test";
import { ProviderError, VIDEO_MODELS } from "@openmanga/domain";
import { FAL_INPUTS, FalVideoProvider, falInput } from "./fal.ts";
import type { VideoRequest } from "./index.ts";

const req = (over: Partial<VideoRequest> = {}): VideoRequest => ({
  prompt: "She turns to the window",
  image: { data: new Uint8Array([1, 2, 3]), mime: "image/jpeg" },
  seconds: 5,
  resolution: "720p",
  aspect: "16:9",
  audio: false,
  ...over,
});

type Call = { method: string; url: string; body: unknown; headers: Record<string, string> };

/** A fetch that answers from a list of [url test, response] pairs, recording every call. */
function stub(routes: [RegExp, (call: Call) => Response][]) {
  const calls: Call[] = [];
  const fetch = (async (url: string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    const call = { method: init?.method ?? "GET", url, body, headers: (init?.headers ?? {}) as Record<string, string> };
    calls.push(call);
    const r = routes.find(([re]) => re.test(`${call.method} ${url}`));
    if (!r) throw new Error(`unexpected ${call.method} ${url}`);
    return r[1](call);
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}
const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });

describe("fal inputs", () => {
  test("every fal model in the catalog has an input format, and every text endpoint too", () => {
    for (const m of VIDEO_MODELS.filter((x) => x.provider === "fal")) {
      expect(FAL_INPUTS[m.id]).toBeDefined();
      if (m.textEndpoint) expect(FAL_INPUTS[m.textEndpoint]).toBeDefined();
    }
  });

  test("lengths, resolutions and the sound switch are always sent in each model's own form", () => {
    const urls = { image: "https://cdn/x.jpg" };
    expect(falInput("fal-ai/bytedance/seedance/v1/pro/fast/image-to-video", req(), urls)).toEqual({
      prompt: "She turns to the window",
      image_url: "https://cdn/x.jpg",
      duration: "5",
      resolution: "720p",
    });
    expect(falInput("fal-ai/veo3.1/fast/image-to-video", req({ seconds: 6 }), urls)).toMatchObject({
      duration: "6s",
      generate_audio: false,
    });
    expect(falInput("xai/grok-imagine-video/v1.5/lite/image-to-video", req(), urls)).toMatchObject({ duration: 5 });
    expect(
      falInput("fal-ai/minimax/hailuo-02/standard/image-to-video", req({ resolution: "480p" }), urls),
    ).toMatchObject({ resolution: "512P" });
    // Kling 3 names its first frame differently and defaults to sound: off unless asked for.
    expect(
      falInput("fal-ai/kling-video/v3/standard/image-to-video", req(), { ...urls, endImage: "https://cdn/y.jpg" }),
    ).toMatchObject({
      start_image_url: "https://cdn/x.jpg",
      end_image_url: "https://cdn/y.jpg",
      generate_audio: false,
    });
    // Text-to-video takes the frame shape; image-to-video follows the image's.
    expect(falInput("fal-ai/wan-25-preview/text-to-video", req({ image: null, aspect: "9:16" }), {})).toMatchObject({
      aspect_ratio: "9:16",
    });
    expect(falInput("fal-ai/wan-25-preview/image-to-video", req({ aspect: "9:16" }), urls)).not.toHaveProperty(
      "aspect_ratio",
    );
    // PixVerse's anime style for manga and cartoon looks.
    expect(falInput("fal-ai/pixverse/v6/image-to-video", req({ style: "anime" }), urls)).toMatchObject({
      style: "anime",
      generate_audio_switch: false,
    });
  });
});

describe("fal queue", () => {
  const model = "fal-ai/kling-video/v2.5-turbo/pro/image-to-video";
  const handle = {
    request_id: "r1",
    status_url: "https://queue.fal.run/fal-ai/kling-video/requests/r1/status",
    response_url: "https://queue.fal.run/fal-ai/kling-video/requests/r1",
    cancel_url: "https://queue.fal.run/fal-ai/kling-video/requests/r1/cancel",
  };

  test("submit uploads the image, sends the input with the Key header and keeps fal's URLs", async () => {
    const s = stub([
      [
        /storage\/upload\/initiate/,
        () => json({ upload_url: "https://up/put", file_url: "https://v3.fal.media/f.jpg" }),
      ],
      [/PUT https:\/\/up\/put/, () => new Response(null, { status: 200 })],
      [/POST https:\/\/queue\.fal\.run\/fal-ai\/kling/, () => json(handle)],
    ]);
    const p = new FalVideoProvider({ apiKey: "k", model, baseUrl: "https://queue.fal.run", fetch: s.fetch });
    const { id } = await p.submit(req());
    expect(JSON.parse(id)).toMatchObject({ id: "r1", status: handle.status_url, response: handle.response_url });
    const sub = s.calls.at(-1)!;
    expect(sub.headers.authorization).toBe("Key k");
    expect(sub.body).toMatchObject({ image_url: "https://v3.fal.media/f.jpg", duration: "5" });
  });

  test("a failed upload sends the image inline instead; a rejected key fails at once", async () => {
    const s = stub([
      [/storage\/upload\/initiate/, () => json({ detail: "nope" }, 404)],
      [/POST https:\/\/queue\.fal\.run/, () => json(handle)],
    ]);
    const p = new FalVideoProvider({ apiKey: "k", model, baseUrl: "https://queue.fal.run", fetch: s.fetch });
    await p.submit(req());
    expect(String((s.calls.at(-1)!.body as { image_url: string }).image_url)).toStartWith("data:image/jpeg;base64,");
    const denied = stub([[/storage\/upload\/initiate/, () => json({ detail: "bad key" }, 401)]]);
    const q = new FalVideoProvider({ apiKey: "k", model, baseUrl: "https://queue.fal.run", fetch: denied.fetch });
    expect(q.submit(req())).rejects.toMatchObject({ code: "auth" });
  });

  test("polling: queued, running, then the video downloaded; a failure that ends COMPLETED is an error", async () => {
    let n = 0;
    const s = stub([
      [
        /status$/,
        () =>
          json(
            [{ status: "IN_QUEUE", queue_position: 3 }, { status: "IN_PROGRESS" }, { status: "COMPLETED" }][n++] ?? {},
          ),
      ],
      [
        /requests\/r1$/,
        () => json({ video: { url: "https://v3.fal.media/out.mp4", content_type: "video/mp4" }, seed: 7 }),
      ],
      [/out\.mp4/, () => new Response(new Uint8Array([9, 9, 9]))],
    ]);
    const p = new FalVideoProvider({ apiKey: "k", model, baseUrl: "https://queue.fal.run", fetch: s.fetch });
    const id = JSON.stringify({
      id: "r1",
      status: handle.status_url,
      response: handle.response_url,
      cancel: handle.cancel_url,
    });
    expect(await p.poll(id)).toEqual({ state: "queued", position: 3 });
    expect(await p.poll(id)).toEqual({ state: "running", position: null });
    const done = await p.poll(id);
    expect(done).toMatchObject({ state: "done", mime: "video/mp4", seed: 7 });
    expect(done.state === "done" && [...done.data]).toEqual([9, 9, 9]);

    const failed = stub([
      [/status$/, () => json({ status: "COMPLETED", error: "unsafe", error_type: "content_policy_violation" })],
    ]);
    const q = new FalVideoProvider({ apiKey: "k", model, baseUrl: "https://queue.fal.run", fetch: failed.fetch });
    const err = await q.poll(id).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("content_policy");
    expect(err.retryable).toBe(false);
  });

  test("error bodies map by fal's type: server trouble retries, bad input does not", async () => {
    const s = stub([
      [/POST https:\/\/queue/, () => json({ detail: [{ type: "downstream_service_unavailable", msg: "down" }] }, 500)],
    ]);
    const p = new FalVideoProvider({ apiKey: "k", model, baseUrl: "https://queue.fal.run", fetch: s.fetch });
    const e1 = await p.submit(req({ image: null })).catch((e) => e);
    expect(e1).toMatchObject({ code: "server_error", retryable: true });
    const bad = stub([
      [/POST https:\/\/queue/, () => json({ detail: [{ type: "image_too_small", msg: "small" }] }, 422)],
    ]);
    const q = new FalVideoProvider({ apiKey: "k", model, baseUrl: "https://queue.fal.run", fetch: bad.fetch });
    expect(await q.submit(req({ image: null })).catch((e) => e)).toMatchObject({
      code: "invalid_request",
      retryable: false,
    });
  });

  test("an image-only model refuses a shot without its image", async () => {
    const p = new FalVideoProvider({
      apiKey: "k",
      model: "fal-ai/bytedance/seedance/v1/pro/fast/image-to-video",
      baseUrl: "https://queue.fal.run",
      fetch: stub([]).fetch,
    });
    expect(p.submit(req({ image: null }))).rejects.toMatchObject({ code: "invalid_request" });
  });

  test("a bare request id (no stored URLs) is polled at the app's queue path", async () => {
    const s = stub([[/fal-ai\/kling-video\/requests\/r9\/status$/, () => json({ status: "IN_PROGRESS" })]]);
    const p = new FalVideoProvider({ apiKey: "k", model, baseUrl: "https://queue.fal.run", fetch: s.fetch });
    expect(await p.poll("r9")).toEqual({ state: "running", position: null });
  });
});
