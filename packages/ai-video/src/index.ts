import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_VIDEO_MODEL,
  ProviderError,
  type ProviderErrorCode,
  type VideoClipAspect,
  type VideoResolution,
} from "@openmanga/domain";
import { scenarioFromText } from "@openmanga/testing";

export { FalVideoProvider } from "./fal.ts";

export type VideoInputImage = { data: Uint8Array; mime: string };

/** One clip to make. `seconds`, `resolution` and `aspect` are already ones the model offers. */
export type VideoRequest = {
  prompt: string;
  negativePrompt?: string | null;
  /** The first frame (image-to-video), or null for text-to-video. */
  image: VideoInputImage | null;
  /** A last frame to land on, for models that take one. */
  endImage?: VideoInputImage | null;
  seconds: number;
  resolution: VideoResolution;
  aspect: VideoClipAspect;
  audio: boolean;
  seed?: number | null;
  /** The shot's camera move, for the local model (paid models read it from the prompt). */
  motion?: string;
  /** The project's look, for models with a style switch (PixVerse's anime style). */
  style?: "anime" | "cartoon" | "realistic" | null;
};

/** A finished clip: an MP4 (or the provider's container) and what the provider reported. */
export type VideoResult = { data: Uint8Array; mime: string; seed: number | null; raw: unknown };

export type VideoPoll = { state: "queued" | "running"; position: number | null } | ({ state: "done" } & VideoResult);

/**
 * A video provider. Generation is asynchronous everywhere: `submit` returns the provider's request id, which the job
 * stores so a restarted worker polls the same request instead of paying for a second one. A provider that finishes
 * at once (the local model) returns its result with the submission.
 */
export interface VideoAIProvider {
  readonly provider: string;
  readonly model: string;
  submit(req: VideoRequest, signal?: AbortSignal): Promise<{ id: string; result?: VideoResult }>;
  poll(id: string, signal?: AbortSignal): Promise<VideoPoll>;
  /** Best effort: a request already running may still be billed. */
  cancel(id: string): Promise<void>;
}

const SIZES: Record<VideoResolution, number> = { "480p": 480, "720p": 720, "1080p": 1080 };

/** Frame size of a clip: `resolution` is the short side. */
export function clipFrame(resolution: VideoResolution, aspect: VideoClipAspect) {
  const short = SIZES[resolution];
  const long = Math.round((short * 16) / 9 / 2) * 2;
  return aspect === "9:16" ? { w: short, h: long } : aspect === "1:1" ? { w: short, h: short } : { w: long, h: short };
}

const fail = (code: ProviderErrorCode, provider = "local") =>
  new ProviderError(provider, code, `Mock ${code} (requested by a [[mock:…]] marker)`, {
    retryable: code !== "content_policy" && code !== "auth",
  });

/** ffmpeg's zoompan over `frames` frames for a camera move: slow, 8% travel, centred. */
function move(motion: string | undefined, frames: number, w: number, h: number, fps: number) {
  const t = `(on/${Math.max(1, frames - 1)})`;
  const z = 1.08;
  const centre = { x: "iw/2-(iw/zoom/2)", y: "ih/2-(ih/zoom/2)" };
  const m =
    motion === "pull-out"
      ? { z: `${z}-${z - 1}*${t}`, ...centre }
      : motion === "pan-left"
        ? { z: String(z), x: `(iw-iw/zoom)*(1-${t})`, y: centre.y }
        : motion === "pan-right"
          ? { z: String(z), x: `(iw-iw/zoom)*${t}`, y: centre.y }
          : motion === "pan-up"
            ? { z: String(z), x: centre.x, y: `(ih-ih/zoom)*(1-${t})` }
            : motion === "pan-down"
              ? { z: String(z), x: centre.x, y: `(ih-ih/zoom)*${t}` }
              : motion === "static"
                ? { z: "1", ...centre }
                : { z: `1+${z - 1}*${t}`, ...centre };
  return `zoompan=z='${m.z}':x='${m.x}':y='${m.y}':d=1:s=${w}x${h}:fps=${fps}`;
}

/**
 * The free model every server has: the image with a slow camera move, encoded by ffmpeg where the job runs. Nothing
 * moves inside the picture. It finishes at once (no request to poll) and costs nothing; tests and the demo use it in
 * place of a paid model, and `[[mock:policy]]`-style markers in the prompt make it fail on purpose.
 */
export class LocalVideoProvider implements VideoAIProvider {
  readonly provider = "local";
  readonly model = LOCAL_VIDEO_MODEL;
  constructor(private readonly opts: { tempRoot?: string; fps?: number } = {}) {}

  async submit(req: VideoRequest) {
    const sc = scenarioFromText(req.prompt);
    if (sc === "429") throw fail("rate_limited");
    if (sc === "500" || sc === "502" || sc === "503") throw fail("server_error");
    if (sc === "policy") throw fail("content_policy");
    if (sc === "auth") throw fail("auth");
    if (!req.image)
      throw new ProviderError("local", "invalid_request", "Still motion animates the shot's image: draw it first", {
        retryable: false,
      });
    const fps = this.opts.fps ?? 24;
    const { w, h } = clipFrame(req.resolution, req.aspect);
    const frames = Math.round(req.seconds * fps);
    const dir = await mkdtemp(join(this.opts.tempRoot ?? tmpdir(), "clip-"));
    try {
      const src = join(dir, "in");
      const out = join(dir, "out.mp4");
      await Bun.write(src, req.image.data);
      // Cover the frame (crop to its shape), supersample for a smooth zoom, then move.
      const filter = `scale=${w * 2}:${h * 2}:force_original_aspect_ratio=increase,crop=${w * 2}:${h * 2},${move(req.motion, frames, w, h, fps)},format=yuv420p`;
      const p = Bun.spawn(
        [
          "ffmpeg",
          "-y",
          "-hide_banner",
          "-loglevel",
          "error",
          "-loop",
          "1",
          "-i",
          src,
          "-vf",
          filter,
          "-frames:v",
          String(frames),
          "-r",
          String(fps),
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          "23",
          "-movflags",
          "+faststart",
          out,
        ],
        { stdout: "ignore", stderr: "pipe" },
      );
      const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
      if (code !== 0)
        throw new ProviderError("local", "invalid_response", `Still motion failed: ${err.slice(-300)}`, {
          retryable: false,
        });
      const data = new Uint8Array(await Bun.file(out).arrayBuffer());
      return { id: crypto.randomUUID(), result: { data, mime: "video/mp4", seed: null, raw: { frames, fps } } };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async poll(): Promise<VideoPoll> {
    // Nothing is ever left running: a lost result is made again (it is free).
    throw new ProviderError("local", "invalid_response", "Still motion has nothing to poll", { retryable: true });
  }

  async cancel() {}
}
