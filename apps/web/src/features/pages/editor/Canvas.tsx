import type Konva from "konva";
import { Maximize, Minus, Plus } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Layer, Rect, Stage, Transformer } from "react-konva";
import { create } from "zustand";
import type { PageDocument } from "../../../api/types.ts";
import { BubbleNode, PanelNode, SfxNode, ShapeHandles } from "./shapes.tsx";
import { useEditor } from "./store.ts";

/** View state (zoom/pan) is UI-only and never persisted. */
export const useView = create<{
  zoom: number;
  x: number;
  y: number;
  fitTick: number;
  set: (v: Partial<{ zoom: number; x: number; y: number }>) => void;
  fit: () => void;
  zoomBy: (k: number) => void;
}>((set) => ({
  zoom: 0.3,
  x: 0,
  y: 0,
  fitTick: 0,
  set: (v) => set(v),
  fit: () => set((s) => ({ fitTick: s.fitTick + 1 })),
  zoomBy: (k) => set((s) => ({ zoom: Math.min(4, Math.max(0.05, s.zoom * k)) })),
}));

export function EditorCanvas({ data, readOnly = false }: { data: PageDocument; readOnly?: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const trRef = useRef<Konva.Transformer>(null);
  const stageRef = useRef<Konva.Stage>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const aimTailFor = useEditor((s) => s.aimTailFor);
  const adjustImageFor = useEditor((s) => s.adjustImageFor);
  const shapeEditFor = useEditor((s) => s.shapeEditFor);
  useEffect(() => {
    const el = stageRef.current?.container();
    if (el) el.style.cursor = aimTailFor ? "crosshair" : "";
  }, [aimTailFor]);
  const { zoom, x, y, fitTick } = useView();
  const setView = useView((s) => s.set);
  const W = data.page.width;
  const H = data.page.height;

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const z = Math.min((size.w - 40) / W, (size.h - 40) / H);
    setView({ zoom: z, x: (size.w - W * z) / 2, y: (size.h - H * z) / 2 });
  }, [size.w, size.h, W, H, setView]);
  useEffect(fit, [fitTick, data.page.id, size.w, size.h]);

  useEffect(() => {
    const tr = trRef.current;
    const stage = stageRef.current;
    if (!tr || !stage) return;
    const prefix = selection?.type === "panel" ? "panel" : selection?.type === "bubble" ? "bubble" : "sfx";
    const nodes =
      readOnly || !selection || useEditor.getState().adjustImageFor || useEditor.getState().shapeEditFor
        ? []
        : selection.ids.map((id) => stage.findOne(`#${prefix}-${id}`)).filter((n): n is Konva.Node => Boolean(n));
    tr.nodes(nodes);
    tr.rotateEnabled(selection?.type !== "panel");
    tr.keepRatio(selection?.type === "sfx");
    tr.getLayer()?.batchDraw();
  }, [selection, doc, readOnly, adjustImageFor, shapeEditFor]);

  const onWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    const p = stage?.getPointerPosition();
    if (!p) return;
    if (e.evt.ctrlKey || e.evt.metaKey) {
      const k = e.evt.deltaY > 0 ? 1 / 1.1 : 1.1;
      const nz = Math.min(4, Math.max(0.05, zoom * k));
      setView({ zoom: nz, x: p.x - ((p.x - x) / zoom) * nz, y: p.y - ((p.y - y) / zoom) * nz });
    } else {
      setView({ x: x - e.evt.deltaX, y: y - e.evt.deltaY });
    }
  };

  const serverPanel = new Map(data.panels.map((p) => [p.id, p]));
  const ordered = [...doc.panels].sort((a, b) => a.order - b.order);
  /** In aim mode any click on the page (panels and lettering included) sets the tail tip there. */
  const aimTail = (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const st = useEditor.getState();
    if (!st.aimTailFor) return false;
    const id = st.aimTailFor;
    const p = e.target.getStage()?.getRelativePointerPosition();
    st.setAimTail(null);
    e.cancelBubble = true;
    if (!p) return true;
    const tx = Math.min(1, Math.max(0, p.x / W));
    const ty = Math.min(1, Math.max(0, p.y / H));
    st.commit((d) => ({
      ...d,
      bubbles: d.bubbles.map((b) =>
        b.id === id ? { ...b, bubble: { ...b.bubble, tail: true, tailTarget: { x: tx, y: ty } } } : b,
      ),
    }));
    st.select({ type: "bubble", ids: [id] });
    return true;
  };
  const sel =
    (type: "panel" | "bubble" | "sfx", id: string) => (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
      if (aimTail(e)) return;
      e.cancelBubble = true;
      const st = useEditor.getState();
      if (st.adjustImageFor && st.adjustImageFor !== id) st.setAdjustImage(null);
      select({ type, ids: [id] }, "shiftKey" in e.evt && e.evt.shiftKey);
    };
  const isSel = (type: string, id: string) => selection?.type === type && selection.ids.includes(id);

  return (
    <div
      ref={wrap}
      className="relative h-full w-full overflow-hidden bg-[var(--panel-2)]"
      role="application"
      aria-label="Page canvas"
    >
      <Stage
        ref={stageRef}
        width={size.w}
        height={size.h}
        x={x}
        y={y}
        scaleX={zoom}
        scaleY={zoom}
        draggable
        dragButtons={[0, 1]}
        onWheel={onWheel}
        onDragEnd={(e) => {
          if (e.target === e.target.getStage()) setView({ x: e.target.x(), y: e.target.y() });
        }}
        onMouseDown={(e) => {
          if (aimTail(e)) return;
          if (adjustImageFor && e.target.name() !== "image-pan") useEditor.getState().setAdjustImage(null);
          if (e.target === e.target.getStage() || e.target.name() === "page-bg") select(null);
        }}
      >
        <Layer>
          <Rect
            name="page-bg"
            width={W}
            height={H}
            fill="#fff"
            shadowColor="#000"
            shadowBlur={30 / zoom}
            shadowOpacity={0.25}
          />
          {ordered.map((p, i) => (
            <PanelNode
              key={p.id}
              panel={p}
              server={serverPanel.get(p.id)}
              displayIndex={i + 1}
              W={W}
              H={H}
              readOnly={readOnly}
              selected={isSel("panel", p.id)}
              onSelect={sel("panel", p.id)}
            />
          ))}
          {[...doc.sfx]
            .sort((a, b) => a.style.zIndex - b.style.zIndex)
            .map((s) => (
              <SfxNode
                key={s.id}
                item={s}
                W={W}
                H={H}
                readOnly={readOnly}
                selected={isSel("sfx", s.id)}
                onSelect={sel("sfx", s.id)}
              />
            ))}
          {[...doc.bubbles]
            .sort((a, b) => a.bubble.zIndex - b.bubble.zIndex)
            .map((b) => (
              <BubbleNode
                key={b.id}
                item={b}
                W={W}
                H={H}
                readOnly={readOnly}
                selected={isSel("bubble", b.id)}
                onSelect={sel("bubble", b.id)}
              />
            ))}
          {shapeEditFor && !readOnly && <ShapeHandles panelId={shapeEditFor} W={W} H={H} zoom={zoom} />}
          <Transformer
            ref={trRef}
            ignoreStroke
            flipEnabled={false}
            rotationSnaps={[0, 90, 180, 270]}
            anchorSize={Math.max(8, 10)}
            borderStroke="#3b6cf6"
            anchorStroke="#3b6cf6"
          />
        </Layer>
      </Stage>
      <div className="card absolute right-3 bottom-3 flex items-center gap-1 p-1 shadow">
        <button
          type="button"
          className="btn-ghost p-1.5"
          aria-label="Zoom out"
          onClick={() => useView.getState().zoomBy(1 / 1.2)}
        >
          <Minus className="size-4" />
        </button>
        <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="btn-ghost p-1.5"
          aria-label="Zoom in"
          onClick={() => useView.getState().zoomBy(1.2)}
        >
          <Plus className="size-4" />
        </button>
        <button type="button" className="btn-ghost p-1.5" aria-label="Fit page" onClick={fit}>
          <Maximize className="size-4" />
        </button>
      </div>
    </div>
  );
}
