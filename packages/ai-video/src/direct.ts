import {
  classifyFetchError,
  classifyHttpStatus,
  ProviderError,
  type ProviderErrorCode,
  videoModel,
} from "@openmanga/domain";
import type { Logger } from "@openmanga/logger";
import type { VideoAIProvider, VideoInputImage, VideoPoll, VideoRequest, VideoResult } from "./index.ts";

/**
 * Video providers' own APIs (not through fal): Google Veo on the Gemini API, Kling, Runway, MiniMax Hailuo and
 * ByteDance Seedance on BytePlus ModelArk. Request shapes follow docs/VIDEO_PROVIDERS.md §2–3; none has been called
 * with a real key yet, so each reads its answer tolerantly (the video URL wherever the answer puts it).
 */

type Opts = {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs?: number;
  logger?: Logger;
  fetch?: typeof fetch;
};

const b64 = (img: VideoInputImage) => Buffer.from(img.data).toString("base64");
const dataUri = (img: VideoInputImage) => `data:${img.mime};base64,${b64(img)}`;
const POLICY = /safety|moderat|policy|sensitive|nsfw|inappropriate|violat/i;

/** The first http(s) URL under a key that names a video or a download, anywhere in an answer. */
export function findVideoUrl(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x === "string" && /^https?:\/\//.test(x) && /url|uri|video|download|output/i.test(k)) return x;
    if (Array.isArray(x) && typeof x[0] === "string" && /^https?:\/\//.test(x[0]) && /output|video|url/i.test(k))
      return x[0];
  }
  for (const x of Object.values(v as Record<string, unknown>)) {
    const found = findVideoUrl(x);
    if (found) return found;
  }
  return null;
}

abstract class DirectVideoProvider implements VideoAIProvider {
  abstract readonly provider: string;
  readonly model: string;
  protected readonly fetchImpl: typeof fetch;

  constructor(protected readonly opts: Opts) {
    this.model = opts.model;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  protected get base() {
    return this.opts.baseUrl.replace(/\/$/, "");
  }
  protected abstract headers(): Record<string, string>;

  protected fail(code: ProviderErrorCode, message: string, extra: { status?: number; raw?: unknown } = {}) {
    return new ProviderError(this.provider, code, `${this.provider}: ${message}`, extra);
  }

  protected async call<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: { ...this.headers(), ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ?? AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw classifyFetchError(this.provider, e);
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* not JSON: reported as text */
    }
    if (!res.ok) {
      const msg = JSON.stringify(json ?? text).slice(0, 300);
      throw this.fail(POLICY.test(msg) && res.status < 500 ? "content_policy" : classifyHttpStatus(res.status), msg, {
        status: res.status,
        raw: json ?? text,
      });
    }
    return json as T;
  }

  /** Downloads the finished video; `auth` sends the key too (Google's file links need it). */
  protected async download(url: string, auth = false, signal?: AbortSignal): Promise<VideoResult> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        headers: auth ? this.headers() : {},
        signal: signal ?? AbortSignal.timeout(5 * 60_000),
      });
    } catch (e) {
      throw classifyFetchError(this.provider, e);
    }
    if (!res.ok) throw this.fail("server_error", `video download failed (HTTP ${res.status})`);
    return {
      data: new Uint8Array(await res.arrayBuffer()),
      mime: res.headers.get("content-type")?.startsWith("video/") ? res.headers.get("content-type")! : "video/mp4",
      seed: null,
      raw: { url: url.split("?")[0] },
    };
  }

  /** Refuses a shot without its image on a model that only animates images. */
  protected needImage(req: VideoRequest) {
    const m = videoModel(this.model);
    if (!req.image && !m?.textToVideo)
      throw this.fail("invalid_request", `${m?.label ?? this.model} needs the shot's image: draw it first`);
    return m;
  }

  abstract submit(req: VideoRequest, signal?: AbortSignal): Promise<{ id: string; result?: VideoResult }>;
  abstract poll(id: string, signal?: AbortSignal): Promise<VideoPoll>;
  async cancel(_id: string) {}
}

/** Google Veo on the Gemini API: a long-running operation, polled by name; the file link needs the key. */
export class GeminiVeoProvider extends DirectVideoProvider {
  readonly provider = "google";
  protected headers() {
    return { "x-goog-api-key": this.opts.apiKey };
  }

  async submit(req: VideoRequest, signal?: AbortSignal) {
    this.needImage(req);
    const inline = (img: VideoInputImage) => ({ inlineData: { mimeType: img.mime, data: b64(img) } });
    const r = await this.call<{ name?: string }>(
      "POST",
      `${this.base}/models/${this.model}:predictLongRunning`,
      {
        instances: [
          {
            prompt: req.prompt,
            ...(req.image ? { image: inline(req.image) } : {}),
            ...(req.image && req.endImage ? { lastFrame: inline(req.endImage) } : {}),
          },
        ],
        parameters: {
          aspectRatio: req.aspect === "9:16" ? "9:16" : "16:9",
          durationSeconds: String(req.seconds),
          resolution: req.resolution,
          // Image-to-video only allows adults; a clip from words allows everyone.
          personGeneration: req.image ? "allow_adult" : "allow_all",
          ...(req.seed != null ? { seed: req.seed } : {}),
        },
      },
      signal,
    );
    if (!r?.name) throw this.fail("invalid_response", "no operation name");
    return { id: r.name };
  }

  async poll(id: string, signal?: AbortSignal): Promise<VideoPoll> {
    const op = await this.call<{
      done?: boolean;
      error?: { code?: number; message?: string };
      response?: {
        generateVideoResponse?: {
          generatedSamples?: { video?: { uri?: string } }[];
          raiMediaFilteredReasons?: string[];
        };
      };
    }>("GET", `${this.base}/${id}`, undefined, signal);
    if (!op?.done) return { state: "running", position: null };
    if (op.error) {
      const m = op.error.message ?? "the operation failed";
      throw this.fail(POLICY.test(m) ? "content_policy" : "invalid_response", m, { raw: op.error });
    }
    const out = op.response?.generateVideoResponse;
    const uri = out?.generatedSamples?.[0]?.video?.uri;
    if (!uri) {
      const why = out?.raiMediaFilteredReasons?.join("; ");
      throw why ? this.fail("content_policy", why) : this.fail("invalid_response", "no video in the answer");
    }
    return { state: "done", ...(await this.download(uri, true, signal)) };
  }

  override async cancel(id: string) {
    await this.call("POST", `${this.base}/${id}:cancel`, {}).catch(() => {});
  }
}

/** Kling's own API (Bearer key): a task polled by our own external id; first and last frame, native sound. */
export class KlingVideoProvider extends DirectVideoProvider {
  readonly provider = "kling";
  protected headers() {
    return { authorization: `Bearer ${this.opts.apiKey}` };
  }

  async submit(req: VideoRequest, signal?: AbortSignal) {
    this.needImage(req);
    const external = crypto.randomUUID();
    const r = await this.call<{ code?: number; message?: string }>(
      "POST",
      `${this.base}/image-to-video/${this.model}`,
      {
        contents: [
          { type: "prompt", text: req.prompt },
          ...(req.image ? [{ type: "first_frame", url: b64(req.image) }] : []),
          ...(req.endImage ? [{ type: "last_frame", url: b64(req.endImage) }] : []),
        ],
        settings: {
          resolution: req.resolution,
          duration: req.seconds,
          audio: req.audio ? "native" : "off",
        },
        options: { external_task_id: external },
      },
      signal,
    );
    if (r?.code) throw this.kling(r.code, r.message ?? "", r);
    return { id: external };
  }

  private kling(code: number, message: string, raw: unknown) {
    // Kling's codes: 1000s auth, 1100s account and balance, 1300s policy and limits.
    const c: ProviderErrorCode =
      code >= 1000 && code < 1100
        ? "auth"
        : code >= 1100 && code < 1200
          ? "quota"
          : code === 1301 || POLICY.test(message)
            ? "content_policy"
            : code === 1302 || code === 1303
              ? "rate_limited"
              : code >= 5000
                ? "server_error"
                : "invalid_request";
    return this.fail(c, `${message || "error"} (code ${code})`, { raw });
  }

  async poll(id: string, signal?: AbortSignal): Promise<VideoPoll> {
    const r = await this.call<{ code?: number; message?: string; data?: unknown }>(
      "GET",
      `${this.base}/tasks?external_task_ids=${encodeURIComponent(id)}`,
      undefined,
      signal,
    );
    if (r?.code) throw this.kling(r.code, r.message ?? "", r);
    const task = (Array.isArray(r?.data) ? r.data[0] : r?.data) as
      | { status?: string; task_status?: string; status_msg?: string; task_status_msg?: string }
      | undefined;
    const status = (task?.status ?? task?.task_status ?? "").toLowerCase();
    if (status === "failed") {
      const m = task?.status_msg ?? task?.task_status_msg ?? "the task failed";
      throw this.fail(POLICY.test(m) ? "content_policy" : "invalid_response", m, { raw: task });
    }
    if (status !== "succeeded" && status !== "succeed")
      return { state: status === "submitted" ? "queued" : "running", position: null };
    const url = findVideoUrl(task);
    if (!url) throw this.fail("invalid_response", "no video in the answer", { raw: task });
    return { state: "done", ...(await this.download(url, false, signal)) };
  }
}

const RUNWAY_RATIO = { "16:9": "1280:720", "9:16": "720:1280", "1:1": "960:960" } as const;

/** Runway (Bearer key + a version header): image_to_video tasks; a moderated clip fails and is still billed. */
export class RunwayVideoProvider extends DirectVideoProvider {
  readonly provider = "runway";
  protected headers() {
    return { authorization: `Bearer ${this.opts.apiKey}`, "x-runway-version": "2024-11-06" };
  }

  async submit(req: VideoRequest, signal?: AbortSignal) {
    this.needImage(req);
    const r = await this.call<{ id?: string }>(
      "POST",
      `${this.base}/image_to_video`,
      {
        model: this.model,
        promptImage: dataUri(req.image!),
        promptText: req.prompt.slice(0, 1000),
        ratio: RUNWAY_RATIO[req.aspect],
        duration: req.seconds,
        ...(req.seed != null ? { seed: req.seed } : {}),
      },
      signal,
    );
    if (!r?.id) throw this.fail("invalid_response", "no task id");
    return { id: r.id };
  }

  async poll(id: string, signal?: AbortSignal): Promise<VideoPoll> {
    const t = await this.call<{ status?: string; output?: string[]; failure?: string; failureCode?: string }>(
      "GET",
      `${this.base}/tasks/${id}`,
      undefined,
      signal,
    );
    if (t?.status === "PENDING" || t?.status === "THROTTLED") return { state: "queued", position: null };
    if (t?.status === "RUNNING") return { state: "running", position: null };
    if (t?.status === "FAILED" || t?.status === "CANCELLED") {
      const m = `${t.failure ?? t.status}${t.failureCode ? ` (${t.failureCode})` : ""}`;
      throw this.fail(
        /SAFETY|MODERATION/i.test(t.failureCode ?? "") || POLICY.test(m) ? "content_policy" : "invalid_response",
        m,
        {
          raw: t,
        },
      );
    }
    const url = t?.output?.[0];
    if (t?.status !== "SUCCEEDED" || !url) throw this.fail("invalid_response", `unexpected status ${t?.status}`);
    return { state: "done", ...(await this.download(url, false, signal)) };
  }

  override async cancel(id: string) {
    await this.call("DELETE", `${this.base}/tasks/${id}`).catch(() => {});
  }
}

const MINIMAX_RES = { "480p": "512P", "720p": "768P", "1080p": "1080P" } as const;

/** MiniMax Hailuo (Bearer key): a task, then a file id, then a download link valid for an hour. */
export class MiniMaxVideoProvider extends DirectVideoProvider {
  readonly provider = "minimax";
  protected headers() {
    return { authorization: `Bearer ${this.opts.apiKey}` };
  }

  /** MiniMax answers 200 with `base_resp.status_code` set on errors. */
  private check(r: { base_resp?: { status_code?: number; status_msg?: string } } | null) {
    const code = r?.base_resp?.status_code ?? 0;
    if (!code) return;
    const m = `${r?.base_resp?.status_msg ?? "error"} (code ${code})`;
    const c: ProviderErrorCode =
      code === 1004 || code === 2049
        ? "auth"
        : code === 1008
          ? "quota"
          : code === 1002 || code === 1039
            ? "rate_limited"
            : code === 1026 || code === 1027 || POLICY.test(m)
              ? "content_policy"
              : code === 1000 || code === 1001
                ? "server_error"
                : "invalid_request";
    throw this.fail(c, m, { raw: r });
  }

  async submit(req: VideoRequest, signal?: AbortSignal) {
    this.needImage(req);
    const r = await this.call<{ task_id?: string; base_resp?: { status_code?: number; status_msg?: string } }>(
      "POST",
      `${this.base}/video_generation`,
      {
        model: this.model,
        prompt: req.prompt.slice(0, 2000),
        first_frame_image: dataUri(req.image!),
        duration: req.seconds,
        resolution: MINIMAX_RES[req.resolution],
      },
      signal,
    );
    this.check(r);
    if (!r?.task_id) throw this.fail("invalid_response", "no task id");
    return { id: r.task_id };
  }

  async poll(id: string, signal?: AbortSignal): Promise<VideoPoll> {
    const t = await this.call<{
      status?: string;
      file_id?: string;
      base_resp?: { status_code?: number; status_msg?: string };
    }>("GET", `${this.base}/query/video_generation?task_id=${encodeURIComponent(id)}`, undefined, signal);
    this.check(t);
    if (t?.status === "Preparing" || t?.status === "Queueing") return { state: "queued", position: null };
    if (t?.status === "Processing") return { state: "running", position: null };
    if (t?.status === "Fail") throw this.fail("invalid_response", "the task failed", { raw: t });
    if (t?.status !== "Success" || !t.file_id) throw this.fail("invalid_response", `unexpected status ${t?.status}`);
    const f = await this.call<{ file?: { download_url?: string }; base_resp?: { status_code?: number } }>(
      "GET",
      `${this.base}/files/retrieve?file_id=${encodeURIComponent(t.file_id)}`,
      undefined,
      signal,
    );
    this.check(f);
    const url = f?.file?.download_url;
    if (!url) throw this.fail("invalid_response", "no download link");
    return { state: "done", ...(await this.download(url, false, signal)) };
  }
}

/** ByteDance Seedance on BytePlus ModelArk (Bearer key): a generation task with first and last frame, sound. */
export class BytePlusSeedanceProvider extends DirectVideoProvider {
  readonly provider = "byteplus";
  protected headers() {
    return { authorization: `Bearer ${this.opts.apiKey}` };
  }

  async submit(req: VideoRequest, signal?: AbortSignal) {
    this.needImage(req);
    const r = await this.call<{ id?: string }>(
      "POST",
      `${this.base}/contents/generations/tasks`,
      {
        model: this.model,
        content: [
          { type: "text", text: req.prompt },
          ...(req.image ? [{ type: "image_url", image_url: { url: dataUri(req.image) }, role: "first_frame" }] : []),
          ...(req.endImage
            ? [{ type: "image_url", image_url: { url: dataUri(req.endImage) }, role: "last_frame" }]
            : []),
        ],
        resolution: req.resolution,
        ratio: req.image ? "adaptive" : req.aspect,
        duration: req.seconds,
        generate_audio: req.audio,
        watermark: false,
        ...(req.seed != null ? { seed: req.seed } : {}),
      },
      signal,
    );
    if (!r?.id) throw this.fail("invalid_response", "no task id");
    return { id: r.id };
  }

  async poll(id: string, signal?: AbortSignal): Promise<VideoPoll> {
    const t = await this.call<{
      status?: string;
      content?: { video_url?: string };
      error?: { code?: string; message?: string };
    }>("GET", `${this.base}/contents/generations/tasks/${id}`, undefined, signal);
    if (t?.status === "queued") return { state: "queued", position: null };
    if (t?.status === "running") return { state: "running", position: null };
    if (t?.status === "failed" || t?.status === "expired" || t?.status === "cancelled") {
      const m = `${t.error?.message ?? t.status}${t.error?.code ? ` (${t.error.code})` : ""}`;
      throw this.fail(POLICY.test(m) ? "content_policy" : "invalid_response", m, { raw: t });
    }
    const url = t?.content?.video_url;
    if (t?.status !== "succeeded" || !url) throw this.fail("invalid_response", `unexpected status ${t?.status}`);
    return { state: "done", ...(await this.download(url, false, signal)) };
  }

  override async cancel(id: string) {
    await this.call("DELETE", `${this.base}/contents/generations/tasks/${id}`).catch(() => {});
  }
}
