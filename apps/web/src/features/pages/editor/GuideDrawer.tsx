import { Eraser, Minus, Pen, PersonStanding, Redo2, Trash2, Undo2, UserPlus } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, assetUrl } from "../../../api/client.ts";
import { clsx, Modal, Spinner, toast } from "../../../components/ui.tsx";
import {
  bones,
  canvasSize,
  commit,
  containRect,
  type Drawing,
  type Figure,
  headRadius,
  history,
  hitHandle,
  isEmpty,
  JOINTS,
  type Joint,
  type Mark,
  moveHandle,
  type Pt,
  redo,
  standingFigure,
  torso,
  undo,
} from "./guide-draw.ts";

type Tool = "pen" | "line" | "eraser" | "pose";
const WIDTHS = [
  ["Fine", 4],
  ["Medium", 10],
  ["Bold", 22],
] as const;
const INK = "#111111";

/** Loads an image the canvas may export: fetched through the API (`proxy=1`), so a bucket redirect cannot taint it. */
async function loadBitmap(assetId: string) {
  const url = assetUrl(assetId, "preview");
  const r = await fetch(`${url}${url.includes("?") ? "&" : "?"}proxy=1`, { credentials: "same-origin" });
  if (!r.ok) throw new Error("Could not load the current guide");
  return createImageBitmap(await r.blob());
}

/**
 * Draw a panel's layout guide: freehand pen, straight lines, eraser and posable stick figures, black on white, at
 * the panel's shape. The current art can show faintly underneath for tracing; it is never part of the saved image.
 * Saving uploads the PNG through the same route as an uploaded sketch.
 */
export function GuideDrawer({
  panelId,
  aspect,
  guide,
  artworkId,
  onClose,
  onSaved,
}: {
  panelId: string;
  aspect: number;
  guide: { assetId: string; strength: "loose" | "strict" } | null;
  artworkId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { width: W, height: H } = canvasSize(aspect);
  const view = useRef<HTMLCanvasElement>(null);
  const ink = useRef<HTMLCanvasElement | null>(null);
  const base = useRef<ImageBitmap | null>(null);
  const trace = useRef<HTMLImageElement | null>(null);
  const live = useRef<{ mark?: Mark; drag?: { figure: number; joint: Joint | "torso" }; figures?: Figure[] } | null>(
    null,
  );
  const [loading, setLoading] = useState(Boolean(guide));
  const [hist, setHist] = useState(() => history({ marks: [], figures: [], base: Boolean(guide) }));
  const [tool, setTool] = useState<Tool>("pen");
  const [width, setWidth] = useState<number>(WIDTHS[1][1]);
  const [showTrace, setShowTrace] = useState(Boolean(artworkId));
  const [saving, setSaving] = useState(false);
  const [traceLoaded, setTraceLoaded] = useState(false);
  const doc = hist.stack[hist.at]!;
  // Tracing shows the current art; with no art yet, the existing guide (useful after Clear to redraw over it).
  const traceId = artworkId ?? guide?.assetId ?? null;

  if (!ink.current) ink.current = Object.assign(document.createElement("canvas"), { width: W, height: H });
  const guideId = guide?.assetId;
  useEffect(() => {
    if (!guideId) return;
    let alive = true;
    loadBitmap(guideId)
      .then((b) => {
        if (alive) base.current = b;
      })
      .catch((e) => toast.error(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [guideId]);

  useEffect(() => {
    if (!traceId) return;
    const img = new Image();
    img.onload = () => {
      trace.current = img;
      setTraceLoaded(true);
    };
    img.src = assetUrl(traceId, "preview");
  }, [traceId]);

  /** Base guide, strokes and lines, with the eraser cutting through all of them. */
  const paintInk = (d: Drawing, extra?: Mark) => {
    const c = ink.current;
    if (!c) return c;
    const g = c.getContext("2d")!;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, W, H);
    const b = base.current;
    if (d.base && b) {
      const r = containRect(b.width, b.height, W, H);
      g.drawImage(b, r.x, r.y, r.width, r.height);
    }
    g.lineCap = "round";
    g.lineJoin = "round";
    for (const m of extra ? [...d.marks, extra] : d.marks) {
      g.globalCompositeOperation = m.tool === "eraser" ? "destination-out" : "source-over";
      g.strokeStyle = INK;
      g.lineWidth = m.tool === "eraser" ? m.width * 3 : m.width;
      const pts = m.tool === "line" ? [m.points[0]!, m.points.at(-1)!] : m.points;
      g.beginPath();
      for (const [i, [x, y]] of pts.entries()) i ? g.lineTo(x, y) : g.moveTo(x, y);
      if (pts.length === 1) g.lineTo(pts[0]![0] + 0.1, pts[0]![1]);
      g.stroke();
    }
    g.globalCompositeOperation = "source-over";
    return c;
  };

  const paintFigures = (g: CanvasRenderingContext2D, figures: Figure[], handles: boolean) => {
    g.strokeStyle = INK;
    g.lineWidth = 8;
    g.lineCap = "round";
    for (const f of figures) {
      g.beginPath();
      for (const [a, b] of bones(f)) {
        g.moveTo(a[0], a[1]);
        g.lineTo(b[0], b[1]);
      }
      g.stroke();
      g.beginPath();
      g.arc(f.head[0], f.head[1], headRadius(f), 0, Math.PI * 2);
      g.stroke();
      if (!handles) continue;
      g.fillStyle = "#6366f1";
      for (const p of [...JOINTS.map((j) => f[j]), torso(f)]) {
        g.beginPath();
        g.arc(p[0], p[1], 9, 0, Math.PI * 2);
        g.fill();
      }
    }
  };

  /** White page, faint art to trace, the ink multiplied over it (so a loaded guide's white stays see-through). */
  function paint(d: Drawing = doc) {
    const v = view.current;
    if (!v) return;
    const g = v.getContext("2d")!;
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.fillStyle = "#ffffff";
    g.fillRect(0, 0, W, H);
    const t = trace.current;
    if (showTrace && t) {
      const r = containRect(t.naturalWidth, t.naturalHeight, W, H);
      g.globalAlpha = 0.25;
      g.drawImage(t, r.x, r.y, r.width, r.height);
      g.globalAlpha = 1;
    }
    const c = paintInk(d, live.current?.mark);
    if (c) {
      g.globalCompositeOperation = "multiply";
      g.drawImage(c, 0, 0);
      g.globalCompositeOperation = "source-over";
    }
    paintFigures(g, live.current?.figures ?? d.figures, tool === "pose");
  }
  // `paint` reads the latest state itself; these are what change the picture.
  useEffect(() => paint(), [hist, tool, showTrace, loading, traceLoaded]);

  const point = (e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return [((e.clientX - r.left) / r.width) * W, ((e.clientY - r.top) / r.height) * H];
  };

  const down = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    if (tool === "pose") {
      // A finger is wider than a mouse pointer: the grab radius is ~24 screen px whatever the canvas scale.
      const scale = W / e.currentTarget.getBoundingClientRect().width;
      const hit = hitHandle(doc.figures, p, 24 * scale);
      live.current = hit ? { drag: hit, figures: doc.figures } : null;
      return;
    }
    live.current = { mark: { tool, width, points: [p, p] } };
    paint();
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const l = live.current;
    if (!l) return;
    const p = point(e);
    if (l.drag && l.figures) {
      const { figure, joint } = l.drag;
      l.figures = l.figures.map((f, i) => (i === figure ? moveHandle(f, joint, p) : f));
    } else if (l.mark) {
      if (l.mark.tool === "line") l.mark.points[1] = p;
      else l.mark.points.push(p);
    }
    paint();
  };
  const up = () => {
    const l = live.current;
    live.current = null;
    const mark = l?.mark;
    const figures = l?.figures;
    if (mark) setHist((h) => commit(h, { ...h.stack[h.at]!, marks: [...h.stack[h.at]!.marks, mark] }));
    else if (figures && figures !== doc.figures) setHist((h) => commit(h, { ...h.stack[h.at]!, figures }));
    else paint();
  };

  const save = async () => {
    setSaving(true);
    try {
      const out = Object.assign(document.createElement("canvas"), { width: W, height: H });
      const g = out.getContext("2d")!;
      g.fillStyle = "#ffffff";
      g.fillRect(0, 0, W, H);
      const c = paintInk(doc);
      if (c) g.drawImage(c, 0, 0);
      paintFigures(g, doc.figures, false);
      const blob = await new Promise<Blob | null>((res) => out.toBlob(res, "image/png"));
      if (!blob) throw new Error("Could not encode the drawing");
      const form = new FormData();
      form.set("file", new File([blob], "guide.png", { type: "image/png" }));
      form.set("strength", guide?.strength ?? "loose");
      await api(`/panels/${panelId}/guide`, { method: "POST", body: form });
      toast.success("Layout guide saved");
      onSaved();
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  const toolButton = (t: Tool, label: string, Icon: typeof Pen) => (
    <button
      type="button"
      className={clsx(tool === t ? "btn-primary" : "btn-secondary", "px-2 text-xs")}
      aria-pressed={tool === t}
      onClick={() => setTool(t)}
    >
      <Icon className="size-4" /> {label}
    </button>
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={guide ? "Edit layout guide" : "Draw layout guide"}
      wide="full"
      footer={
        <>
          <label className="mr-auto flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={showTrace}
              disabled={!traceId}
              onChange={(e) => setShowTrace(e.target.checked)}
            />
            Show {artworkId ? "panel art" : "current guide"} underneath (not saved)
          </label>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={saving || loading || isEmpty(doc)}
            onClick={() => void save()}
          >
            {saving && <Spinner />} Save guide
          </button>
        </>
      }
    >
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {toolButton("pen", "Pen", Pen)}
          {toolButton("line", "Line", Minus)}
          {toolButton("eraser", "Eraser", Eraser)}
          {toolButton("pose", "Pose", PersonStanding)}
          <select
            className="input w-auto py-1 text-xs"
            aria-label="Line width"
            value={width}
            onChange={(e) => setWidth(Number(e.target.value))}
          >
            {WIDTHS.map(([label, w]) => (
              <option key={w} value={w}>
                {label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn-secondary px-2 text-xs"
            title="Add a stick figure; drag its joints with the Pose tool, or its body to move it"
            onClick={() => {
              const n = doc.figures.length;
              setHist((h) =>
                commit(h, { ...doc, figures: [...doc.figures, standingFigure(W * [0.5, 0.3, 0.7][n % 3]!, H)] }),
              );
              setTool("pose");
            }}
          >
            <UserPlus className="size-4" /> Figure
          </button>
          <span className="ml-auto flex gap-1">
            <button
              type="button"
              className="btn-ghost p-1.5"
              aria-label="Undo"
              title="Undo"
              disabled={hist.at === 0}
              onClick={() => setHist(undo)}
            >
              <Undo2 className="size-4" />
            </button>
            <button
              type="button"
              className="btn-ghost p-1.5"
              aria-label="Redo"
              title="Redo"
              disabled={hist.at === hist.stack.length - 1}
              onClick={() => setHist(redo)}
            >
              <Redo2 className="size-4" />
            </button>
            <button
              type="button"
              className="btn-ghost p-1.5 text-red-500"
              aria-label="Clear"
              title="Clear everything"
              disabled={isEmpty(doc)}
              onClick={() => setHist((h) => commit(h, { marks: [], figures: [], base: false }))}
            >
              <Trash2 className="size-4" />
            </button>
          </span>
        </div>
        <div className="relative flex min-h-0 flex-1 items-center justify-center">
          {loading && <Spinner />}
          <canvas
            ref={view}
            width={W}
            height={H}
            hidden={loading}
            className={clsx(
              "max-h-full max-w-full touch-none rounded border border-[var(--border)] bg-white",
              tool === "pose" ? "cursor-grab" : "cursor-crosshair",
            )}
            aria-label="Drawing canvas for the layout guide"
            onPointerDown={down}
            onPointerMove={move}
            onPointerUp={up}
            onPointerCancel={up}
          />
        </div>
        <p className="muted text-xs">
          Rough is fine: only the composition, framing and poses are used. Pose: drag a joint, or the dot in the middle
          of the body to move the whole figure.
        </p>
      </div>
    </Modal>
  );
}
