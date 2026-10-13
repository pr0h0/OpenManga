import { classifyFetchError, classifyHttpStatus, ProviderError, videoModel } from "@openmanga/domain";
import type { Logger } from "@openmanga/logger";
import type { VideoAIProvider, VideoInputImage, VideoPoll, VideoRequest } from "./index.ts";

/**
 * How one fal endpoint names its inputs. Only this file knows fal request shapes (invariant 1): the domain catalog
 * says what a model can do and costs, this says how to ask for it. Every option a model has is always sent, because
 * fal's defaults are often the expensive choice (1080p, sound on, "auto" length).
 */
type FalInputSpec = {
  /** The first frame's field (absent on text-to-video endpoints). */
  image?: string;
  /** The last frame's field, for endpoints that take one. */
  endImage?: string;
  /** How the length is sent: a number, a numeric string ("5") or seconds with a unit ("8s"). */
  duration: { key: string; as: "number" | "string" | "seconds" };
  /** Sent only when making a clip from words (an image fixes the shape otherwise). */
  aspect?: string;
  resolution?: { key: string; values?: Record<string, string> };
  /** The sound switch; sent as false unless sound was asked for. */
  audio?: string;
  negative?: string;
  seed?: string;
  /** Fixed extra inputs (a model's own style switch). */
  extra?: Record<string, unknown>;
};

const D = (as: FalInputSpec["duration"]["as"] = "string") => ({ key: "duration", as });
const RES = { key: "resolution" };

/** Every endpoint the catalog names, by fal endpoint id. Sources: docs/VIDEO_PROVIDERS.md. */
export const FAL_INPUTS: Record<string, FalInputSpec> = {
  "fal-ai/bytedance/seedance/v1/pro/fast/image-to-video": { image: "image_url", duration: D(), resolution: RES, seed: "seed" },
  "xai/grok-imagine-video/v1.5/lite/image-to-video": { image: "image_url", duration: D("number"), resolution: RES },
  "fal-ai/minimax/hailuo-02/standard/image-to-video": {
    image: "image_url",
    endImage: "end_image_url",
    duration: D(),
    resolution: { key: "resolution", values: { "480p": "512P", "720p": "768P" } },
  },
  "fal-ai/wan-25-preview/image-to-video": {
    image: "image_url",
    duration: D(),
    resolution: RES,
    negative: "negative_prompt",
    seed: "seed",
  },
  "fal-ai/wan-25-preview/text-to-video": {
    duration: D(),
    aspect: "aspect_ratio",
    resolution: RES,
    negative: "negative_prompt",
    seed: "seed",
  },
  "fal-ai/pixverse/v6/image-to-video": {
    image: "image_url",
    duration: D("number"),
    resolution: { key: "resolution", values: { "480p": "540p", "720p": "720p" } },
    audio: "generate_audio_switch",
    negative: "negative_prompt",
    seed: "seed",
  },
  "fal-ai/kling-video/v2.5-turbo/pro/image-to-video": {
    image: "image_url",
    endImage: "tail_image_url",
    duration: D(),
    negative: "negative_prompt",
  },
  "fal-ai/kling-video/v2.5-turbo/pro/text-to-video": { duration: D(), aspect: "aspect_ratio", negative: "negative_prompt" },
  "fal-ai/kling-video/v3/standard/image-to-video": {
    image: "start_image_url",
    endImage: "end_image_url",
    duration: D(),
    audio: "generate_audio",
    negative: "negative_prompt",
  },
  "fal-ai/veo3.1/fast/image-to-video": {
    image: "image_url",
    duration: D("seconds"),
    resolution: RES,
    audio: "generate_audio",
    negative: "negative_prompt",
    seed: "seed",
  },
  "fal-ai/veo3.1/fast": {
    duration: D("seconds"),
    aspect: "aspect_ratio",
    resolution: RES,
    audio: "generate_audio",
    negative: "negative_prompt",
    seed: "seed",
  },
};

/** The JSON body fal gets, with the images already turned into URLs. Exported for tests. */
export function falInput(endpoint: string, req: VideoRequest, urls: { image?: string; endImage?: string }) {
  const s = FAL_INPUTS[endpoint];
  if (!s) throw new ProviderError("fal", "invalid_request", `No fal input format for ${endpoint}`, { retryable: false });
  const d = req.seconds;
  const body: Record<string, unknown> = { prompt: req.prompt, ...s.extra };
  if (s.image && urls.image) body[s.image] = urls.image;
  if (s.endImage && urls.endImage) body[s.endImage] = urls.endImage;
  body[s.duration.key] = s.duration.as === "number" ? d : s.duration.as === "seconds" ? `${d}s` : String(d);
  if (s.aspect && !urls.image) body[s.aspect] = req.aspect;
  if (s.resolution) body[s.resolution.key] = s.resolution.values?.[req.resolution] ?? req.resolution;
  if (s.audio) body[s.audio] = req.audio;
  if (s.negative && req.negativePrompt) body[s.negative] = req.negativePrompt;
  if (s.seed && req.seed != null) body[s.seed] = req.seed;
  // PixVerse's own anime look, for manga and cartoon projects.
  if (endpoint.startsWith("fal-ai/pixverse/") && (req.style === "anime" || req.style === "cartoon"))
    body.style = req.style === "anime" ? "anime" : "3d_animation";
  return body;
}

/** A submitted request: fal's id and the URLs it gave for it (they differ by endpoint, so they are kept, not built). */
type Handle = { id: string; status: string; response: string; cancel: string };

/** The app part of an endpoint id (`fal-ai/kling-video/v2.1/…` → `fal-ai/kling-video`), for handles without URLs. */
export const falAppId = (model: string) => model.split("/").slice(0, 2).join("/");

const FAL_ERRORS: Record<string, ProviderError["code"]> = {
  content_policy_violation: "content_policy",
  generation_timeout: "timeout",
  request_timeout: "timeout",
  startup_timeout: "timeout",
  downstream_service_unavailable: "server_error",
  downstream_service_error: "server_error",
  internal_server_error: "server_error",
  internal_error: "server_error",
  no_media_generated: "invalid_response",
};

/** fal's error body ({detail: [{type, msg}]} or {detail, error_type}) as a ProviderError, by its type, never its text. */
function falError(status: number, json: unknown, text: string) {
  const j = json as { detail?: unknown; error_type?: string } | null;
  const first = Array.isArray(j?.detail) ? (j.detail[0] as { type?: string; msg?: string } | undefined) : undefined;
  const type = first?.type ?? j?.error_type ?? "";
  const msg = first?.msg ?? (typeof j?.detail === "string" ? j.detail : text.slice(0, 200));
  const code = FAL_ERRORS[type] ?? (type.startsWith("runner_") ? "server_error" : classifyHttpStatus(status));
  return new ProviderError("fal", code, `fal: ${msg || `HTTP ${status}`}${type ? ` (${type})` : ""}`, {
    status,
    raw: json ?? text,
  });
}

/**
 * fal.ai's queue API: submit to `queue.fal.run/<endpoint>`, poll the status URL it returns, read the result from its
 * response URL, download the video at once (fal keeps it about a week). Auth is `Authorization: Key <key>`. Images go
 * up to fal's CDN first (falling back to a data URI), since request bodies are meant to stay small.
 */
export class FalVideoProvider implements VideoAIProvider {
  readonly provider = "fal";
  readonly model: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly opts: {
      apiKey: string;
      model: string;
      baseUrl: string;
      /** fal's REST host, for image uploads. */
      restUrl?: string;
      timeoutMs?: number;
      logger?: Logger;
      fetch?: typeof fetch;
    },
  ) {
    this.model = opts.model;
    this.fetchImpl = opts.fetch ?? fetch;
  }

  private get base() {
    return (this.opts.baseUrl || "https://queue.fal.run").replace(/\/$/, "");
  }

  private async call(method: string, url: string, body?: unknown, signal?: AbortSignal) {
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Key ${this.opts.apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ?? AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      throw classifyFetchError("fal", e);
    }
    const text = await res.text().catch(() => "");
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* a non-JSON body: reported as text */
    }
    if (!res.ok) throw falError(res.status, json, text);
    return json;
  }

  /** An input image as a URL fal can fetch: uploaded to its CDN, or inline when the upload is unavailable. */
  private async imageUrl(img: VideoInputImage, signal?: AbortSignal) {
    const rest = (this.opts.restUrl ?? "https://rest.fal.ai").replace(/\/$/, "");
    try {
      const ext = img.mime.split("/")[1] ?? "png";
      const up = (await this.call(
        "POST",
        `${rest}/storage/upload/initiate?storage_type=fal-cdn-v3`,
        { content_type: img.mime, file_name: `shot.${ext}` },
        signal,
      )) as { upload_url?: string; file_url?: string } | null;
      if (!up?.upload_url || !up.file_url) throw new Error("no upload URL");
      const put = await this.fetchImpl(up.upload_url, {
        method: "PUT",
        headers: { "content-type": img.mime },
        body: new Blob([img.data as Uint8Array<ArrayBuffer>], { type: img.mime }),
        signal: signal ?? AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
      if (!put.ok) throw new Error(`upload HTTP ${put.status}`);
      return up.file_url;
    } catch (e) {
      // A rejected key fails the run here rather than again on submit; anything else falls back to inline.
      if (e instanceof ProviderError && e.code === "auth") throw e;
      this.opts.logger?.warn("fal upload failed; sending the image inline", { error: (e as Error).message });
      return `data:${img.mime};base64,${Buffer.from(img.data).toString("base64")}`;
    }
  }

  async submit(req: VideoRequest, signal?: AbortSignal) {
    const m = videoModel(this.model);
    if (!req.image && !m?.textToVideo)
      throw new ProviderError(
        "fal",
        "invalid_request",
        `${m?.label ?? this.model} needs the shot's image: draw it first`,
        { retryable: false },
      );
    const endpoint = !req.image && m?.textEndpoint ? m.textEndpoint : this.model;
    const urls = {
      image: req.image ? await this.imageUrl(req.image, signal) : undefined,
      endImage: req.endImage && m?.endFrame ? await this.imageUrl(req.endImage, signal) : undefined,
    };
    const r = (await this.call("POST", `${this.base}/${endpoint}`, falInput(endpoint, req, urls), signal)) as {
      request_id?: string;
      status_url?: string;
      response_url?: string;
      cancel_url?: string;
    } | null;
    if (!r?.request_id) throw new ProviderError("fal", "invalid_response", "fal returned no request id");
    const app = `${this.base}/${falAppId(endpoint)}/requests/${r.request_id}`;
    const handle: Handle = {
      id: r.request_id,
      status: r.status_url ?? `${app}/status`,
      response: r.response_url ?? app,
      cancel: r.cancel_url ?? `${app}/cancel`,
    };
    this.opts.logger?.info("fal video submitted", { endpoint, requestId: r.request_id });
    return { id: JSON.stringify(handle) };
  }

  /** The stored handle; a bare request id (older rows) gets the URLs fal's own client would build. */
  private handle(id: string): Handle {
    try {
      const h = JSON.parse(id) as Handle;
      if (h.id && h.status && h.response) return h;
    } catch {
      /* a bare id */
    }
    const app = `${this.base}/${falAppId(this.model)}/requests/${id}`;
    return { id, status: `${app}/status`, response: app, cancel: `${app}/cancel` };
  }

  async poll(id: string, signal?: AbortSignal): Promise<VideoPoll> {
    const h = this.handle(id);
    const s = (await this.call("GET", h.status, undefined, signal)) as {
      status?: string;
      queue_position?: number;
      error?: string;
      error_type?: string;
    } | null;
    if (s?.status === "IN_QUEUE") return { state: "queued", position: s.queue_position ?? null };
    if (s?.status === "IN_PROGRESS") return { state: "running", position: null };
    if (s?.status !== "COMPLETED")
      throw new ProviderError("fal", "invalid_response", `fal: unexpected status ${s?.status ?? "none"}`);
    // A failed request is COMPLETED too, with its error on the status.
    if (s.error || s.error_type)
      throw falError(422, { detail: s.error ?? "", error_type: s.error_type }, s.error ?? "");
    const out = (await this.call("GET", h.response, undefined, signal)) as {
      video?: { url?: string; content_type?: string };
      seed?: number;
    } | null;
    const url = out?.video?.url;
    if (!url) throw new ProviderError("fal", "invalid_response", "fal returned no video", { raw: out });
    let res: Response;
    try {
      res = await this.fetchImpl(url, { signal: signal ?? AbortSignal.timeout(5 * 60_000) });
    } catch (e) {
      throw classifyFetchError("fal", e);
    }
    if (!res.ok) throw new ProviderError("fal", "server_error", `fal video download failed (HTTP ${res.status})`);
    return {
      state: "done",
      data: new Uint8Array(await res.arrayBuffer()),
      mime: out?.video?.content_type || "video/mp4",
      seed: typeof out?.seed === "number" ? out.seed : null,
      raw: out,
    };
  }

  async cancel(id: string) {
    await this.call("PUT", this.handle(id).cancel).catch(() => {});
  }
}
