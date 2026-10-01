import {
  cardFrames,
  fadeOpacity,
  frameSizeFor,
  type Motion,
  motionAt,
  motionPath,
  pageShotBox,
  panelShotBox,
  scrollPlan,
  shotGroups,
  timeGroup,
  watermarkBox,
} from "@openmanga/domain/browser";
import { useQuery } from "@tanstack/react-query";
import {
  Clapperboard,
  ListVideo,
  Maximize,
  Minimize,
  Pause,
  Play,
  Settings2,
  SkipBack,
  SkipForward,
  TriangleAlert,
} from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, ApiError, assetUrl, get, post } from "../../api/client.ts";
import { ConfirmDialog, ErrorBox, Field, Modal, Spinner, toast } from "../../components/ui.tsx";

type Crop = { left: number; top: number; width: number; height: number };
type PreviewSegment = {
  id: string;
  text: string;
  pauseAfterMs: number;
  audioAssetId: string | null;
  durationMs: number | null;
};
type PreviewShot = {
  key: string;
  label: string;
  /** Shares one hold with the next shot: a narration line spans the cut. */
  joinNext: boolean;
  fade: { in: boolean; out: boolean };
  /** Panel cut: the resolved camera move. */
  motion: Motion | null;
  page: { id: string; order: number; chapterOrder: number; width: number; height: number; updatedAt: string };
  panel: {
    id: string;
    shotType: string;
    frame: { x: number; y: number; width: number; height: number };
    aspect: number;
    focus: { x: number; y: number };
    art: { assetId: string; width: number; height: number; crop: Crop } | null;
  } | null;
  lines: { id: string; startOffsetMs: number; endOffsetMs: number; segments: PreviewSegment[] }[];
};
type Card = { title: string; subtitle: string; durationMs: number };
type Branding = {
  intro: Card | null;
  outro: Card | null;
  watermark: {
    assetId: string;
    corner: "top-left" | "top-right" | "bottom-left" | "bottom-right";
    opacity: number;
    size: number;
    width: number;
    height: number;
  } | null;
  /** Changes whenever the project's settings do, so a re-rendered card is not served from the cache. */
  version: string;
};
type Preview = {
  cut: "page" | "panel";
  language: string;
  branding: Branding;
  unplacedLines: number;
  disabledPanels: number;
  shots: PreviewShot[];
};

const MOTION_LABEL: Record<Motion, string> = {
  static: "static",
  "push-in": "push in",
  "pull-out": "pull out",
  "pan-left": "pan left",
  "pan-right": "pan right",
  "pan-up": "pan up",
  "pan-down": "pan down",
};

export type PreviewScope = { chapterId?: string; pageId?: string; panelId?: string };

const FPS = 30;
const { frameW: W, frameH: H } = frameSizeFor(1080);

type Options = {
  cut: "page" | "panel";
  minHoldMs: number;
  zoom: number;
  framing: "width" | "height" | "scroll";
  pageWidthRatio: number;
  pageHeightRatio: number;
  maxScrollPxPerSec: number;
};

/** One entry of the timeline: a shot, or the intro or outro card. */
type Timed = {
  key: string;
  label: string;
  shot: PreviewShot | null;
  card: "intro" | "outro" | null;
  startMs: number;
  holdMs: number;
  frames: number;
  missingAudio: number;
};

/**
 * Timeline with the same holds as the final render: the intro card, the shared `timeGroup` over each run of shots a
 * narration line spans (narration + offsets + breath, at least the minimum per shot, whole frames), the outro card.
 */
function buildTimeline(shots: PreviewShot[], minHoldMs: number, branding: Branding | undefined) {
  let frames = 0;
  const at = (f: number) => (f * 1000) / FPS;
  const cues: { startMs: number; endMs: number; audioAssetId: string }[] = [];
  const timed: Timed[] = [];
  const card = (which: "intro" | "outro") => {
    const c = branding?.[which];
    if (!c || !shots.length) return;
    const n = cardFrames(c.durationMs, FPS);
    const label = which === "intro" ? "Intro card" : "Outro card";
    timed.push({
      key: which,
      label,
      shot: null,
      card: which,
      startMs: at(frames),
      holdMs: at(n),
      frames: n,
      missingAudio: 0,
    });
    frames += n;
  };
  card("intro");
  for (const g of shotGroups(shots.map((s) => s.joinNext))) {
    const members = shots.slice(g.first, g.last + 1);
    const lines = members.flatMap((s) =>
      s.lines.map((l) => ({ ...l, voiced: l.segments.filter((x) => x.audioAssetId && x.durationMs) })),
    );
    const timing = timeGroup(
      lines.map((l) => ({
        ...l,
        segments: l.voiced.map((x) => ({ ms: x.durationMs!, pauseAfterMs: x.pauseAfterMs })),
      })),
      members.length,
      { minHoldMs, fps: FPS },
    );
    const groupMs = at(frames);
    lines.forEach((l, k) => {
      l.voiced.forEach((x, j) => {
        const start = groupMs + timing.starts[k]![j]!;
        cues.push({ startMs: start, endMs: start + x.durationMs!, audioAssetId: x.audioAssetId! });
      });
    });
    members.forEach((shot, m) => {
      const n = timing.frames[m]!;
      const all = shot.lines.flatMap((l) => l.segments);
      const voiced = all.filter((x) => x.audioAssetId && x.durationMs).length;
      timed.push({
        key: shot.key,
        label: shot.label,
        shot,
        card: null,
        startMs: at(frames),
        holdMs: at(n),
        frames: n,
        missingAudio: all.length - voiced,
      });
      frames += n;
    });
  }
  card("outro");
  return { timed, cues, totalMs: at(frames) };
}

/** Where the preview loads pages and media: the signed-in routes, or a reader link's public ones. */
type PreviewUrls = {
  page: (pageId: string, updatedAt: string) => string;
  asset: (id: string, variant?: "web") => string;
  card: (which: "intro" | "outro", version: string) => string;
};
const signedInUrls = (projectId: string): PreviewUrls => ({
  page: (pageId, updatedAt) => `${API_BASE}/pages/${pageId}/render.png?width=1600&v=${encodeURIComponent(updatedAt)}`,
  asset: (id, variant) => assetUrl(id, variant),
  card: (which, version) =>
    `${API_BASE}/projects/${projectId}/video-card/${which}.png?height=${H}&v=${encodeURIComponent(version)}`,
});
const sharedUrls = (token: string): PreviewUrls => ({
  page: (pageId, updatedAt) =>
    `${API_BASE}/public/shares/${token}/pages/${pageId}.png?width=1600&v=${encodeURIComponent(updatedAt)}`,
  asset: (id, variant) => `${API_BASE}/public/shares/${token}/assets/${id}${variant ? `?v=${variant}` : ""}`,
  card: (which, version) =>
    `${API_BASE}/public/shares/${token}/video-card/${which}.png?height=${H}&v=${encodeURIComponent(version)}`,
});
const Urls = createContext<PreviewUrls>(sharedUrls(""));

/** An entry of the timeline on the stage, with the logo over it, as the render composites it. */
function StageFrame({ entry, t, o, branding }: { entry: Timed; t: number; o: Options; branding: Branding }) {
  const urls = useContext(Urls);
  const wm = branding.watermark;
  const box = wm ? watermarkBox(W, H, wm, wm.corner, wm.size) : null;
  return (
    <>
      {entry.card ? (
        <img
          src={urls.card(entry.card, branding.version)}
          alt=""
          style={{ position: "absolute", inset: 0, width: W, height: H }}
        />
      ) : (
        entry.shot && <ShotFrame shot={entry.shot} t={t} holdMs={entry.holdMs} frames={entry.frames} o={o} />
      )}
      {wm && box && (
        <img
          src={urls.asset(wm.assetId)}
          alt=""
          style={{ position: "absolute", left: box.x, top: box.y, width: box.w, height: box.h, opacity: wm.opacity }}
        />
      )}
    </>
  );
}

/** Black over the picture where a scene break fades (the render's ffmpeg fade, same ramp). */
function FadeShade({ shot, t, frames }: { shot: PreviewShot; t: number; frames: number }) {
  const opacity = fadeOpacity(t * frames, frames, FPS, shot.fade);
  return opacity > 0 ? <div style={{ position: "absolute", inset: 0, background: "black", opacity }} /> : null;
}

/** One shot drawn on a 1920×1080 stage at time `t` (0..1 of its hold) — the same geometry as the ffmpeg render. */
function ShotFrame(props: { shot: PreviewShot; t: number; holdMs: number; frames: number; o: Options }) {
  return (
    <>
      <ShotPicture {...props} />
      <FadeShade shot={props.shot} t={props.t} frames={props.frames} />
    </>
  );
}

function ShotPicture({ shot, t, holdMs, o }: { shot: PreviewShot; t: number; holdMs: number; o: Options }) {
  const urls = useContext(Urls);
  const pg = shot.page;
  if (o.cut === "page" || !shot.panel) {
    const box = pageShotBox(pg.width, pg.height, W, H, o);
    const src = urls.page(pg.id, pg.updatedAt);
    const { y0, travel } = scrollPlan(box.h - H, holdMs / 1000, o.maxScrollPxPerSec, o.framing);
    const top = box.h > H ? -(y0 + travel * t) : (H - box.h) / 2;
    return (
      <>
        <Backdrop src={src} />
        <img
          key={src}
          src={src}
          alt=""
          style={{ position: "absolute", left: (W - box.w) / 2, top, width: box.w, height: box.h }}
        />
      </>
    );
  }
  const pn = shot.panel;
  // Clean art cropped as on the page, or the lettered page crop when there is no art (like the render).
  const source = pn.art
    ? { src: urls.asset(pn.art.assetId, "web"), w: pn.art.width, h: pn.art.height, crop: pn.art.crop }
    : {
        src: urls.page(pg.id, pg.updatedAt),
        w: pg.width,
        h: pg.height,
        crop: {
          left: pn.frame.x * pg.width,
          top: pn.frame.y * pg.height,
          width: pn.frame.width * pg.width,
          height: pn.frame.height * pg.height,
        },
      };
  const box = panelShotBox(pn.aspect, W, H);
  // zoompan's window: zoom z, sitting at (x, y) of the slack the zoom leaves.
  const m = motionAt(motionPath(shot.motion ?? "static", o.zoom, pn.focus), t);
  const vw = source.crop.width / m.z;
  const vh = source.crop.height / m.z;
  const vx = source.crop.left + (source.crop.width - vw) * m.x;
  const vy = source.crop.top + (source.crop.height - vh) * m.y;
  const s = box.w / vw;
  return (
    <>
      {!box.full && <Backdrop src={source.src} />}
      <div
        style={{
          position: "absolute",
          left: (W - box.w) / 2,
          top: (H - box.h) / 2,
          width: box.w,
          height: box.h,
          overflow: "hidden",
        }}
      >
        <img
          key={source.src}
          src={source.src}
          alt=""
          style={{
            position: "absolute",
            left: -vx * s,
            top: -vy * s,
            width: source.w * s,
            height: source.h * s,
            maxWidth: "none",
          }}
        />
      </div>
    </>
  );
}

function Backdrop({ src }: { src: string }) {
  return (
    <img
      key={src}
      src={src}
      alt=""
      style={{
        position: "absolute",
        inset: 0,
        width: W,
        height: H,
        objectFit: "cover",
        filter: "blur(36px) brightness(0.55)",
        transform: "scale(1.12)",
      }}
    />
  );
}

/** A remembered on/off choice; storage can be unavailable (private mode), which just means the default. */
function readFlag(key: string, fallback: boolean) {
  try {
    const v = localStorage.getItem(key);
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writeFlag(key: string, value: boolean) {
  try {
    localStorage.setItem(key, value ? "1" : "0");
  } catch {}
}

const mmss = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Plays a page, a panel or a chapter in the browser the way the final video will look and sound: same shots, holds,
 * framing, scroll and Ken Burns move, with the synthesized narration. Nothing is rendered or spent.
 */
export function VideoPreview({
  open,
  onClose,
  projectId,
  scope,
  defaultCut,
  title,
  shareToken,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  scope: PreviewScope;
  defaultCut: "page" | "panel";
  title: string;
  /** Played from a reader link: public, read-only routes, and nothing to render. */
  shareToken?: string;
}) {
  const urls = useMemo(() => (shareToken ? sharedUrls(shareToken) : signedInUrls(projectId)), [shareToken, projectId]);
  const [o, setO] = useState<Options>({
    cut: scope.panelId ? "panel" : defaultCut,
    minHoldMs: 2500,
    zoom: 0.06,
    framing: "width",
    pageWidthRatio: 0.6,
    pageHeightRatio: 0.96,
    maxScrollPxPerSec: 60,
  });
  const params = new URLSearchParams({
    cut: o.cut,
    ...Object.fromEntries(Object.entries(scope).filter(([, v]) => Boolean(v))),
  });
  const preview = useQuery({
    queryKey: ["video-preview", params.toString()],
    queryFn: () =>
      get<Preview>(shareToken ? `/public/shares/${shareToken}/video-preview?${params}` : `/video-preview?${params}`),
    enabled: open,
  });
  const timeline = useMemo(
    () => buildTimeline(preview.data?.shots ?? [], o.minHoldMs, preview.data?.branding),
    [preview.data, o.minHoldMs],
  );

  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const clockRef = useRef(0);
  // Playback runs on the Web Audio clock, not on animation frames: a hidden tab or a covered window stops animation
  // frames, which used to stop the next narration segment from ever starting. The audio clock keeps going, every
  // segment is scheduled on it ahead of time, and the picture simply reads the same clock when it is on screen.
  const player = useRef<{
    ctx: AudioContext;
    /** clock (ms) = base.clock + (ctx.currentTime - base.ctx) * 1000 while playing */
    base: { clock: number; ctx: number };
    sources: Map<number, AudioBufferSourceNode>;
    /** Bumped on every seek or pause, so a segment still decoding for an old position is not started. */
    epoch: number;
  } | null>(null);
  const buffers = useRef(new Map<string, Promise<AudioBuffer | null>>());

  const now = useCallback(() => {
    const p = player.current;
    if (!p) return clockRef.current;
    return p.base.clock + (p.ctx.currentTime - p.base.ctx) * 1000;
  }, []);
  const stopSources = useCallback(() => {
    const p = player.current;
    if (!p) return;
    p.epoch++;
    for (const src of p.sources.values()) {
      try {
        src.stop();
      } catch {}
    }
    p.sources.clear();
  }, []);
  const seek = useCallback(
    (ms: number) => {
      const v = Math.min(Math.max(0, ms), timeline.totalMs);
      stopSources();
      clockRef.current = v;
      if (player.current) player.current.base = { clock: v, ctx: player.current.ctx.currentTime };
      setClock(v);
    },
    [timeline.totalMs, stopSources],
  );

  useEffect(() => {
    if (!playing) return;
    const AudioCtx =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!player.current)
      player.current = { ctx: new AudioCtx(), base: { clock: 0, ctx: 0 }, sources: new Map(), epoch: 0 };
    const p = player.current;
    void p.ctx.resume().catch(() => {});
    p.base = { clock: clockRef.current, ctx: p.ctx.currentTime };
    const decode = (id: string) => {
      let b = buffers.current.get(id);
      if (!b) {
        // Read through the API even with bucket storage: a redirect to the bucket would need a CORS rule there.
        const url = urls.asset(id);
        b = fetch(`${url}${url.includes("?") ? "&" : "?"}proxy=1`)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
          .then((data) => p.ctx.decodeAudioData(data))
          .catch(() => null);
        buffers.current.set(id, b);
      }
      return b;
    };
    const LOOKAHEAD_MS = 30_000;
    // Queues every segment that overlaps the next 30 s at its exact place on the audio clock.
    const schedule = () => {
      const at = now();
      const epoch = p.epoch;
      timeline.cues.forEach((cue, i) => {
        if (p.sources.has(i) || cue.endMs <= at || cue.startMs > at + LOOKAHEAD_MS) return;
        p.sources.set(i, null as unknown as AudioBufferSourceNode); // reserved while it decodes
        void decode(cue.audioAssetId).then((buf) => {
          if (epoch !== p.epoch) return;
          if (!buf) return void p.sources.delete(i);
          const src = p.ctx.createBufferSource();
          src.buffer = buf;
          src.connect(p.ctx.destination);
          const when = p.base.ctx + (cue.startMs - p.base.clock) / 1000;
          const late = Math.max(0, p.ctx.currentTime - when);
          if (late >= buf.duration) return;
          src.start(Math.max(when, p.ctx.currentTime), late);
          p.sources.set(i, src);
        });
      });
    };
    // Timers keep running (throttled to about once a second) in a background tab, and a tab that is playing audio is
    // not throttled further, so a 30 s lookahead is always refilled in time.
    const tick = () => {
      const t = now();
      clockRef.current = Math.min(t, timeline.totalMs);
      if (t >= timeline.totalMs) {
        stopSources();
        setClock(timeline.totalMs);
        setPlaying(false);
        return;
      }
      schedule();
    };
    tick();
    const timer = setInterval(tick, 250);
    let raf = 0;
    const frame = () => {
      setClock(Math.min(now(), timeline.totalMs));
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      clearInterval(timer);
      cancelAnimationFrame(raf);
      clockRef.current = Math.min(now(), timeline.totalMs);
      stopSources();
    };
  }, [playing, timeline, now, stopSources]);

  // The audio context is closed with the preview.
  useEffect(
    () => () => {
      stopSources();
      void player.current?.ctx.close().catch(() => {});
      player.current = null;
    },
    [stopSources],
  );

  useEffect(() => {
    if (!open) {
      setPlaying(false);
      seek(0);
    }
  }, [open, seek]);
  const current = Math.max(
    0,
    timeline.timed.findIndex((s) => clock >= s.startMs && clock < s.startMs + s.holdMs),
  );
  const shot = timeline.timed[current];
  // Warm the next shots' images so cuts land on a loaded picture.
  useEffect(() => {
    for (const next of timeline.timed.slice(current + 1, current + 3)) {
      if (!next.shot) continue;
      const pn = next.shot.panel;
      const img = new Image();
      img.src =
        o.cut === "panel" && pn?.art
          ? urls.asset(pn.art.assetId, "web")
          : urls.page(next.shot.page.id, next.shot.page.updatedAt);
    }
  }, [current, timeline, o.cut, urls]);

  // The picture takes whatever space the controls leave, as the largest 16:9 box that fits it both ways.
  const [stageW, setStageW] = useState(960);
  const areaRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = areaRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setStageW(Math.max(160, Math.min(el.clientWidth, (el.clientHeight * W) / H))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [open, preview.data]);

  // Shot list and settings fold away; the choice is remembered in this browser.
  const [showLines, setShowLines] = useState(() => readFlag("om-preview-lines", true));
  const [showOptions, setShowOptions] = useState(() => readFlag("om-preview-options", false));
  useEffect(() => writeFlag("om-preview-lines", showLines), [showLines]);
  useEffect(() => writeFlag("om-preview-options", showOptions), [showOptions]);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void rootRef.current?.requestFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("input, select, textarea")) return;
      if (e.key === " ") {
        e.preventDefault();
        setPlaying((p) => !p);
      }
      if (e.key === "ArrowRight") seek((timeline.timed[current + 1]?.startMs ?? timeline.totalMs) + 1);
      if (e.key === "ArrowLeft") seek((timeline.timed[Math.max(0, current - 1)]?.startMs ?? 0) + 1);
      if (e.key === "f" || e.key === "F") toggleFullscreen();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, seek, timeline, current, toggleFullscreen]);

  const [notReady, setNotReady] = useState(false);
  const render = async (acknowledgeIssues: boolean) => {
    try {
      await post(`/projects/${projectId}/exports`, {
        kind: o.cut === "panel" ? "video_panels" : "video_pages",
        chapterId: scope.chapterId,
        language: preview.data?.language,
        video: {
          height: 1080,
          fps: FPS,
          minHoldMs: o.minHoldMs,
          framing: o.framing,
          pageWidthRatio: o.pageWidthRatio,
          pageHeightRatio: o.pageHeightRatio,
          maxScrollPxPerSec: o.maxScrollPxPerSec,
          zoom: o.zoom,
        },
        acknowledgeIssues,
      });
      setNotReady(false);
      toast.success("Final render queued — follow it on the Exports page");
    } catch (e) {
      if (e instanceof ApiError && e.code === "export_not_ready") setNotReady(true);
      else toast.error(e);
    }
  };

  const listRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    if (!showLines) return;
    listRef.current?.querySelector<HTMLElement>(`[data-shot="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current, showLines]);

  const missingAudio = timeline.timed.reduce((n, s) => n + s.missingAudio, 0);
  const noArt = o.cut === "panel" ? timeline.timed.filter((s) => s.shot?.panel && !s.shot.panel.art).length : 0;
  const scale = stageW / W;
  const t = shot ? Math.min(1, Math.max(0, (clock - shot.startMs) / shot.holdMs)) : 0;

  const togglePlay = () => {
    if (clock >= timeline.totalMs) seek(0);
    setPlaying((p) => !p);
  };

  const issues = [
    missingAudio > 0 && `${missingAudio} narration segment(s) have no audio yet and are silent`,
    noArt > 0 && `${noArt} panel(s) have no artwork and show their lettered page crop`,
    (preview.data?.unplacedLines ?? 0) > 0 &&
      `${preview.data?.unplacedLines} narration line(s) aren't linked to a page or panel and are left out`,
    (preview.data?.disabledPanels ?? 0) > 0 &&
      `${preview.data?.disabledPanels} panel(s) are disabled as shots and left out with their narration`,
  ].filter(Boolean) as string[];

  return (
    <Urls.Provider value={urls}>
      <Modal open={open} onClose={onClose} title={title} wide="full">
        {preview.isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner className="size-6" />
          </div>
        ) : preview.error ? (
          <ErrorBox error={preview.error} onRetry={() => preview.refetch()} />
        ) : (
          // Full screen keeps the app's own panel colours around the picture (the picture itself is black), so the lines and
          // settings read exactly as they do in the window, in either theme.
          <div
            ref={rootRef}
            className={`flex h-full flex-col gap-2 ${fullscreen ? "bg-[var(--panel)] p-3 text-[var(--text)]" : ""}`}
          >
            {/* The picture: all the room the rest leaves. */}
            <div ref={areaRef} className="flex min-h-0 flex-1 items-center justify-center">
              {/* Clicking the picture plays or pauses, like any video player. */}
              <button
                type="button"
                className="relative block cursor-pointer overflow-hidden rounded-lg bg-black p-0"
                style={{ width: stageW, height: (stageW * H) / W }}
                aria-label={playing ? "Pause" : "Play"}
                disabled={!timeline.totalMs}
                onClick={togglePlay}
              >
                <div
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: W,
                    height: H,
                    transform: `scale(${scale})`,
                    transformOrigin: "0 0",
                    overflow: "hidden",
                  }}
                >
                  {shot && preview.data && <StageFrame entry={shot} t={t} o={o} branding={preview.data.branding} />}
                </div>
                <div className="absolute right-2 bottom-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
                  {shot?.label}
                </div>
              </button>
            </div>

            {/* Controls and progress: always visible. */}
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <button
                type="button"
                className="btn-ghost p-1.5"
                aria-label="Previous shot"
                onClick={() => seek((timeline.timed[Math.max(0, current - 1)]?.startMs ?? 0) + 1)}
              >
                <SkipBack className="size-4" />
              </button>
              <button type="button" className="btn-primary" onClick={togglePlay} disabled={!timeline.totalMs}>
                {playing ? <Pause className="size-4" /> : <Play className="size-4" />} {playing ? "Pause" : "Play"}
              </button>
              <button
                type="button"
                className="btn-ghost p-1.5"
                aria-label="Next shot"
                onClick={() => seek((timeline.timed[current + 1]?.startMs ?? timeline.totalMs) + 1)}
              >
                <SkipForward className="size-4" />
              </button>
              <input
                type="range"
                className="min-w-40 flex-1"
                min={0}
                max={Math.max(1, timeline.totalMs)}
                step={100}
                value={clock}
                onChange={(e) => seek(Number(e.target.value))}
                aria-label="Seek"
              />
              <span className="muted text-xs tabular-nums">
                {mmss(clock)} / {mmss(timeline.totalMs)} · shot {current + 1}/{timeline.timed.length}
              </span>
              {issues.length > 0 && (
                <button
                  type="button"
                  className="btn-ghost p-1.5 text-amber-500"
                  title={issues.join("\n")}
                  aria-label={`${issues.length} issue(s)`}
                  onClick={() => setShowOptions(true)}
                >
                  <TriangleAlert className="size-4" />
                </button>
              )}
              <button
                type="button"
                className={`btn-ghost p-1.5 ${showLines ? "bg-[var(--panel-2)]" : ""}`}
                aria-pressed={showLines}
                title="Show or hide the shot list"
                onClick={() => setShowLines((v) => !v)}
              >
                <ListVideo className="size-4" /> <span className="hidden sm:inline">Lines</span>
              </button>
              <button
                type="button"
                className={`btn-ghost p-1.5 ${showOptions ? "bg-[var(--panel-2)]" : ""}`}
                aria-pressed={showOptions}
                title="Show or hide the render settings"
                onClick={() => setShowOptions((v) => !v)}
              >
                <Settings2 className="size-4" /> <span className="hidden sm:inline">Settings</span>
              </button>
              <button
                type="button"
                className="btn-ghost p-1.5"
                aria-label={fullscreen ? "Exit full screen" : "Full screen"}
                title={fullscreen ? "Exit full screen (F)" : "Full screen (F)"}
                onClick={toggleFullscreen}
              >
                {fullscreen ? <Minimize className="size-4" /> : <Maximize className="size-4" />}
              </button>
            </div>

            {showOptions && (
              <div className="shrink-0 space-y-2">
                <div className="grid gap-3 sm:grid-cols-4">
                  {!scope.panelId && (
                    <Field label="Cut">
                      <select
                        className="input"
                        value={o.cut}
                        onChange={(e) => {
                          setPlaying(false);
                          seek(0);
                          setO({ ...o, cut: e.target.value as Options["cut"] });
                        }}
                      >
                        <option value="panel">Panel cut (Ken Burns)</option>
                        <option value="page">Page cut</option>
                      </select>
                    </Field>
                  )}
                  <Field label={`Min seconds per ${o.cut === "panel" ? "panel" : "page"}`}>
                    <input
                      className="input"
                      type="number"
                      min={0.5}
                      max={30}
                      step={0.5}
                      value={o.minHoldMs / 1000}
                      onChange={(e) => setO({ ...o, minHoldMs: Math.round(Number(e.target.value) * 1000) })}
                    />
                  </Field>
                  {o.cut === "panel" ? (
                    <Field label={`Zoom ${Math.round(o.zoom * 100)}%`}>
                      <input
                        type="range"
                        className="w-full"
                        min={0}
                        max={0.15}
                        step={0.01}
                        value={o.zoom}
                        onChange={(e) => setO({ ...o, zoom: Number(e.target.value) })}
                      />
                    </Field>
                  ) : (
                    <Field label="Page framing">
                      <select
                        className="input"
                        value={o.framing}
                        onChange={(e) => setO({ ...o, framing: e.target.value as Options["framing"] })}
                      >
                        <option value="width">3/5 width, slow scroll</option>
                        <option value="scroll">3/5 width, scroll the whole page</option>
                        <option value="height">Whole page visible</option>
                      </select>
                    </Field>
                  )}
                  <div className="flex items-end">
                    {scope.chapterId && !shareToken && (
                      <button type="button" className="btn-secondary w-full" onClick={() => void render(false)}>
                        <Clapperboard className="size-4" /> Render final video
                      </button>
                    )}
                  </div>
                </div>
                {issues.length > 0 && (
                  <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                    {issues.join(" · ")}
                  </p>
                )}
              </div>
            )}

            {showLines && (
              // Exactly five rows tall (rows, their four dividers and the border); it scrolls, following the current shot.
              <ol
                ref={listRef}
                className="h-[calc(5*1.85rem+6px)] shrink-0 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)] text-xs"
              >
                {timeline.timed.map((s, i) => {
                  const narration = (s.shot?.lines ?? [])
                    .flatMap((l) => l.segments)
                    .map((x) => x.text)
                    .join(" ");
                  // A line spanning the cut keeps speaking over this shot.
                  const continues = timeline.timed[i - 1]?.shot?.joinNext;
                  return (
                    <li key={s.key} data-shot={i}>
                      <button
                        type="button"
                        className={`flex h-[1.85rem] w-full items-center gap-3 px-2 text-left hover:bg-[var(--panel-2)] ${i === current ? "bg-accent-600/15" : ""}`}
                        onClick={() => seek(s.startMs + 1)}
                      >
                        <span className="w-44 shrink-0 truncate font-medium">{s.label}</span>
                        <span className="muted w-24 shrink-0 tabular-nums">
                          {mmss(s.startMs)} · {(s.holdMs / 1000).toFixed(1)}s
                        </span>
                        {o.cut === "panel" && s.shot?.panel && (
                          <span className="muted w-16 shrink-0">
                            {s.shot.motion ? MOTION_LABEL[s.shot.motion] : ""}
                            {s.shot.fade.in ? " · fade" : ""}
                          </span>
                        )}
                        {/* Truncated to keep the row one line; the title shows the whole narration on hover. */}
                        <span className="muted truncate" title={narration || undefined}>
                          {s.card
                            ? (preview.data?.branding[s.card]?.title ?? "")
                            : narration || (continues ? "↳ narration continues" : "— no narration —")}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>
        )}
        <ConfirmDialog
          open={notReady}
          title="Render anyway?"
          confirmLabel="Render anyway"
          onClose={() => setNotReady(false)}
          onConfirm={() => void render(true)}
        >
          The readiness check found missing artwork, narration or audio in this chapter. The Exports page lists the
          details. Render anyway?
        </ConfirmDialog>
      </Modal>
    </Urls.Provider>
  );
}

/** Opens the in-browser video preview for a chapter, page or panel. */
export function PreviewVideoButton({
  projectId,
  scope,
  label = "Preview video",
  title,
  className = "btn-secondary",
}: {
  projectId: string;
  scope: PreviewScope;
  label?: string;
  title: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} onClick={() => setOpen(true)}>
        <Play className="size-4" /> {label}
      </button>
      {open && (
        <VideoPreview
          open={open}
          onClose={() => setOpen(false)}
          projectId={projectId}
          scope={scope}
          defaultCut="panel"
          title={title}
        />
      )}
    </>
  );
}
