import { classifyFetchError, classifyHttpStatus, ProviderError, videoModel } from "@openmanga/domain";
import type { Logger } from "@openmanga/logger";
import type { VideoAIProvider, VideoInputImage, VideoPoll, VideoRequest } from "./index.ts";

/**
 * How one fal model names its inputs. Only this file knows fal request shapes (invariant 1): the domain catalog
 * lists what a model can do and costs, this says how to ask for it.
 */
type FalInputSpec = {
  /** The first frame's field. */
  image: string;
  /** The last frame's field, for models that take one. */
  endImage?: string;
  /** How the length is sent: a number, a numeric string ("5") or seconds with a unit ("8s"). */
  duration: { key: string; as: "number" | "string" | "seconds" };
  aspect?: string;
  resolution?: string;
  audio?: string;
  negative?: string;
  seed?: string;
};

const DEFAULT_SPEC: FalInputSpec = {
  image: "image_url",
  duration: { key: "duration", as: "string" },
  aspect: "aspect_ratio",
  resolution: "resolution",
  negative: "negative_prompt",
  seed: "seed",
};

/** Per-model differences from DEFAULT_SPEC, by fal endpoint id (see docs/VIDEO_PROVIDERS.md for the sources). */
export const FAL_INPUTS: Record<string, Partial<FalInputSpec>> = {};

const specFor = (model: string): FalInputSpec => ({ ...DEFAULT_SPEC, ...(FAL_INPUTS[model] ?? {}) });

const dataUri = (img: VideoInputImage) => `data:${img.mime};base64,${Buffer.from(img.data).toString("base64")}`;

/** The app part of an endpoint id (`fal-ai/kling-video/v2.1/…` → `fal-ai/kling-video`): status and results live there. */
export const falAppId = (model: string) => model.split("/").slice(0, 2).join("/");

/** The JSON body fal gets for a request. Exported for tests. */
export function falInput(model: string, req: VideoRequest) {
  const s = specFor(model);
  const m = videoModel(model);
  const d = req.seconds;
  const body: Record<string, unknown> = { prompt: req.prompt };
  if (req.image) body[s.image] = dataUri(req.image);
  if (req.endImage && s.endImage && m?.endFrame) body[s.endImage] = dataUri(req.endImage);
  body[s.duration.key] = s.duration.as === "number" ? d : s.duration.as === "seconds" ? `${d}s` : String(d);
  // An image fixes the shape for image-to-video models that take none; text-to-video always needs it.
  if (s.aspect && (m?.aspects.length ?? 0) > 1) body[s.aspect] = req.aspect;
  if (s.resolution && (m?.resolutions.length ?? 0) > 1) body[s.resolution] = req.resolution;
  if (s.audio && m?.audio) body[s.audio] = req.audio;
  if (s.negative && req.negativePrompt) body[s.negative] = req.negativePrompt;
  if (s.seed && req.seed != null) body[s.seed] = req.seed;
  return body;
}

type FalStatus = { status?: string; queue_position?: number; error?: string; logs?: unknown };
type FalOutput = { video?: { url?: string; content_type?: string }; seed?: number; detail?: unknown };

/**
 * fal.ai's queue API: submit to `queue.fal.run/<endpoint>`, poll `…/requests/<id>/status`, read the result from
 * `…/requests/<id>`, then download the video from the URL it names. Auth is `Authorization: Key <key>`.
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
        headers: { authorization: `Key ${this.opts.apiKey}`, ...(body ? { "content-type": "application/json" } : {}) },
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
      /* a non-JSON error body: reported below */
    }
    if (!res.ok) {
      const detail = JSON.stringify((json as { detail?: unknown } | null)?.detail ?? json ?? text).slice(0, 300);
      const policy = /content|policy|safety|nsfw|moderat/i.test(detail);
      throw new ProviderError("fal", policy ? "content_policy" : classifyHttpStatus(res.status), `fal: ${detail}`, {
        status: res.status,
        raw: json ?? text,
        retryAfterMs: Number(res.headers.get("retry-after")) * 1000 || undefined,
      });
    }
    return json;
  }

  async submit(req: VideoRequest, signal?: AbortSignal) {
    const m = videoModel(this.model);
    const endpoint = !req.image && m?.textEndpoint ? m.textEndpoint : this.model;
    if (!req.image && !m?.textToVideo)
      throw new ProviderError("fal", "invalid_request", `${m?.label ?? this.model} needs the shot's image: draw it first`, {
        retryable: false,
      });
    const r = (await this.call("POST", `${this.base}/${endpoint}`, falInput(endpoint, req), signal)) as {
      request_id?: string;
    } | null;
    if (!r?.request_id) throw new ProviderError("fal", "invalid_response", "fal returned no request id");
    this.opts.logger?.info("fal video submitted", { model: endpoint, requestId: r.request_id });
    return { id: r.request_id };
  }

  async poll(id: string, signal?: AbortSignal): Promise<VideoPoll> {
    const app = `${this.base}/${falAppId(this.model)}/requests/${id}`;
    const s = (await this.call("GET", `${app}/status`, undefined, signal)) as FalStatus | null;
    if (s?.status === "IN_QUEUE") return { state: "queued", position: s.queue_position ?? null };
    if (s?.status === "IN_PROGRESS") return { state: "running", position: null };
    if (s?.status !== "COMPLETED")
      throw new ProviderError("fal", "invalid_response", `fal: unexpected status ${s?.status ?? "none"}`);
    // A failed run is COMPLETED too: its result request answers with the error.
    const out = (await this.call("GET", app, undefined, signal)) as FalOutput | null;
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
      raw: { ...out, video: { ...out?.video } },
    };
  }

  async cancel(id: string) {
    await this.call("PUT", `${this.base}/${falAppId(this.model)}/requests/${id}/cancel`).catch(() => {});
  }
}
