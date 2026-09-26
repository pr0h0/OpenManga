import {
  frameSizeFor,
  holdFor,
  kenBurnsPullsOut,
  kenBurnsZoomAt,
  pageShotBox,
  panelShotBox,
  scrollPlan,
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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE, ApiError, assetUrl, get, post } from "../../api/client.ts";
import { ConfirmDialog, ErrorBox, Field, Modal, Spinner, toast } from "../../components/ui.tsx";

type Crop = { left: number; top: number; width: number; height: number };
type PreviewShot = {
  key: string;
  label: string;
  page: { id: string; order: number; chapterOrder: number; width: number; height: number; updatedAt: string };
  panel: {
    id: string;
    shotType: string;
    frame: { x: number; y: number; width: number; height: number };
    aspect: number;
    art: { assetId: string; width: number; height: number; crop: Crop; focus: { x: number; y: number } } | null;
  } | null;
  segments: {
    id: string;
    text: string;
    pauseAfterMs: number;
    audioAssetId: string | null;
    durationMs: number | null;
  }[];
};
type Preview = { cut: "page" | "panel"; language: string; unplacedLines: number; shots: PreviewShot[] };

export type PreviewScope = { chapterId?: string; pageId?: string; panelId?: string };

const FPS = 30;
const { frameW: W, frameH: H } = frameSizeFor(1080);

type Options = {
  cut: "page" | "panel";
  minHoldMs: number;
  zoom: number;
  framing: "width" | "height";
  pageWidthRatio: number;
  pageHeightRatio: number;
  maxScrollPxPerSec: number;
};

/** Timeline with the same holds as the final render (narration + breath, at least the minimum, whole frames). */
function buildTimeline(shots: PreviewShot[], minHoldMs: number) {
  let start = 0;
  const cues: { startMs: number; endMs: number; audioAssetId: string; shot: number }[] = [];
  const timed = shots.map((shot, i) => {
    const voiced = shot.segments.filter((s) => s.audioAssetId && s.durationMs);
    let t = 0;
    for (const [k, s] of voiced.entries()) {
      cues.push({ startMs: start + t, endMs: start + t + s.durationMs!, audioAssetId: s.audioAssetId!, shot: i });
      t += s.durationMs! + (k < voiced.length - 1 ? s.pauseAfterMs : 0);
    }
    const { holdMs } = holdFor(t, voiced.length > 0, minHoldMs, FPS);
    const out = { shot, startMs: start, holdMs, missingAudio: shot.segments.length - voiced.length };
    start += holdMs;
    return out;
  });
  return { timed, cues, totalMs: start };
}

const pageImage = (pageId: string, updatedAt: string) =>
  `${API_BASE}/pages/${pageId}/render.png?width=1600&v=${encodeURIComponent(updatedAt)}`;

/** One shot drawn on a 1920×1080 stage at time `t` (0..1 of its hold) — the same geometry as the ffmpeg render. */
function ShotFrame({ shot, t, holdMs, o }: { shot: PreviewShot; t: number; holdMs: number; o: Options }) {
  const pg = shot.page;
  if (o.cut === "page" || !shot.panel) {
    const box = pageShotBox(pg.width, pg.height, W, H, o);
    const src = pageImage(pg.id, pg.updatedAt);
    const { y0, travel } = scrollPlan(box.h - H, holdMs / 1000, o.maxScrollPxPerSec);
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
    ? {
        src: assetUrl(pn.art.assetId, "web"),
        w: pn.art.width,
        h: pn.art.height,
        crop: pn.art.crop,
        focus: pn.art.focus,
      }
    : {
        src: pageImage(pg.id, pg.updatedAt),
        w: pg.width,
        h: pg.height,
        crop: {
          left: pn.frame.x * pg.width,
          top: pn.frame.y * pg.height,
          width: pn.frame.width * pg.width,
          height: pn.frame.height * pg.height,
        },
        focus: { x: 0.5, y: 0.5 },
      };
  const box = panelShotBox(pn.aspect, W, H);
  const z = kenBurnsZoomAt(pn.shotType, o.zoom, t);
  // zoompan anchor: the visible window keeps the focus at the same relative position while it zooms.
  const vw = source.crop.width / z;
  const vh = source.crop.height / z;
  const vx = source.crop.left + (source.crop.width - vw) * source.focus.x;
  const vy = source.crop.top + (source.crop.height - vh) * source.focus.y;
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
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  scope: PreviewScope;
  defaultCut: "page" | "panel";
  title: string;
}) {
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
    queryFn: () => get<Preview>(`/video-preview?${params}`),
    enabled: open,
  });
  const timeline = useMemo(() => buildTimeline(preview.data?.shots ?? [], o.minHoldMs), [preview.data, o.minHoldMs]);

  const [clock, setClock] = useState(0);
  const [playing, setPlaying] = useState(false);
  const clockRef = useRef(0);
  const started = useRef({ perf: 0, clock: 0 });
  const audio = useRef<{ el: HTMLAudioElement; cue: number } | null>(null);
  const audioCache = useRef(new Map<string, HTMLAudioElement>());

  const stopAudio = useCallback(() => {
    audio.current?.el.pause();
    audio.current = null;
  }, []);
  const seek = useCallback(
    (ms: number) => {
      const v = Math.min(Math.max(0, ms), timeline.totalMs);
      clockRef.current = v;
      started.current = { perf: performance.now(), clock: v };
      stopAudio();
      setClock(v);
    },
    [timeline.totalMs, stopAudio],
  );

  useEffect(() => {
    if (!playing) return;
    started.current = { perf: performance.now(), clock: clockRef.current };
    let raf = 0;
    const audioFor = (id: string) => {
      let el = audioCache.current.get(id);
      if (!el) {
        el = new Audio(assetUrl(id));
        el.preload = "auto";
        audioCache.current.set(id, el);
      }
      return el;
    };
    const tick = () => {
      const now = started.current.clock + (performance.now() - started.current.perf);
      if (now >= timeline.totalMs) {
        clockRef.current = timeline.totalMs;
        setClock(timeline.totalMs);
        stopAudio();
        setPlaying(false);
        return;
      }
      clockRef.current = now;
      const ci = timeline.cues.findIndex((c) => now >= c.startMs && now < c.endMs);
      if (ci !== (audio.current?.cue ?? -1)) {
        stopAudio();
        if (ci >= 0) {
          const cue = timeline.cues[ci]!;
          const el = audioFor(cue.audioAssetId);
          el.currentTime = (now - cue.startMs) / 1000;
          void el.play().catch(() => {});
          audio.current = { el, cue: ci };
          // warm the next couple of segments
          for (const next of timeline.cues.slice(ci + 1, ci + 3)) audioFor(next.audioAssetId);
        }
      }
      setClock(now);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      stopAudio();
    };
  }, [playing, timeline, stopAudio]);

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
      const pn = next.shot.panel;
      const img = new Image();
      img.src =
        o.cut === "panel" && pn?.art
          ? assetUrl(pn.art.assetId, "web")
          : pageImage(next.shot.page.id, next.shot.page.updatedAt);
    }
  }, [current, timeline, o.cut]);

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
  const noArt = o.cut === "panel" ? timeline.timed.filter((s) => s.shot.panel && !s.shot.panel.art).length : 0;
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
  ].filter(Boolean) as string[];

  return (
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
                {shot && <ShotFrame shot={shot.shot} t={t} holdMs={shot.holdMs} o={o} />}
              </div>
              <div className="absolute right-2 bottom-2 rounded bg-black/60 px-2 py-0.5 text-xs text-white">
                {shot?.shot.label}
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
                      <option value="height">Whole page visible</option>
                    </select>
                  </Field>
                )}
                <div className="flex items-end">
                  {scope.chapterId && (
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
            // Exactly five rows tall; it scrolls, following the shot being played.
            <ol
              ref={listRef}
              className="h-[9.25rem] shrink-0 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)] text-xs"
            >
              {timeline.timed.map((s, i) => {
                const narration = s.shot.segments.map((x) => x.text).join(" ");
                return (
                  <li key={s.shot.key} data-shot={i}>
                    <button
                      type="button"
                      className={`flex h-[1.85rem] w-full items-center gap-3 px-2 text-left hover:bg-[var(--panel-2)] ${i === current ? "bg-accent-600/15" : ""}`}
                      onClick={() => seek(s.startMs + 1)}
                    >
                      <span className="w-44 shrink-0 truncate font-medium">{s.shot.label}</span>
                      <span className="muted w-24 shrink-0 tabular-nums">
                        {mmss(s.startMs)} · {(s.holdMs / 1000).toFixed(1)}s
                      </span>
                      {o.cut === "panel" && s.shot.panel && (
                        <span className="muted w-14 shrink-0">
                          {kenBurnsPullsOut(s.shot.panel.shotType) ? "zoom out" : "zoom in"}
                        </span>
                      )}
                      {/* Truncated to keep the row one line; the title shows the whole narration on hover. */}
                      <span className="muted truncate" title={narration || undefined}>
                        {narration || "— no narration —"}
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
