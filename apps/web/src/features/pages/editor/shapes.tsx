import {
  bubbleGeometry,
  framePolygon,
  insertFramePoint,
  layoutBubbleText,
  moveFramePoint,
  removeFramePoint,
} from "@openmanga/domain/browser";
import type { Frame } from "@openmanga/schemas";
import Konva from "konva";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Circle, Group, Image as KImage, Line, Path, Rect, Text } from "react-konva";
import { assetUrl } from "../../../api/client.ts";
import type { EditorPanel } from "../../../api/types.ts";
import {
  clampBox,
  clampFrame,
  computeCrop,
  type DocBubble,
  type DocPanel,
  type DocSfx,
  type EditorDoc,
  panImageTransform,
  useEditor,
} from "./store.ts";

const FONT_STACK = (f: string) => `${f}, Comic Neue, DejaVu Sans, sans-serif`;

const cursor = (kind: string, readOnly: boolean) => (e: Konva.KonvaEventObject<MouseEvent>) => {
  const el = e.target.getStage()?.container();
  if (el) el.style.cursor = readOnly ? "" : kind;
};

const imageCache = new Map<string, HTMLImageElement>();
export function useHtmlImage(src: string | null) {
  const [img, setImg] = useState<HTMLImageElement | null>(() =>
    src ? (imageCache.get(src)?.complete ? imageCache.get(src)! : null) : null,
  );
  useEffect(() => {
    if (!src) return setImg(null);
    const cached = imageCache.get(src);
    if (cached?.complete && cached.naturalWidth) return setImg(cached);
    const el = cached ?? new Image();
    const onLoad = () => setImg(el);
    el.addEventListener("load", onLoad);
    if (!cached) {
      el.src = src;
      imageCache.set(src, el);
    }
    return () => el.removeEventListener("load", onLoad);
  }, [src]);
  return img;
}

const STATUS_COLOR: Record<string, string> = {
  planned: "#71717a",
  "prompt-ready": "#6366f1",
  queued: "#f59e0b",
  generating: "#0ea5e9",
  ready: "#10b981",
  failed: "#ef4444",
};

type Common = {
  W: number;
  H: number;
  readOnly: boolean;
  selected: boolean;
  onSelect: (e: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => void;
};

export function PanelNode({
  panel,
  server,
  W,
  H,
  readOnly,
  selected,
  onSelect,
  displayIndex,
}: Common & { panel: DocPanel; server: EditorPanel | undefined; displayIndex: number }) {
  const { commit, setInteracting } = useEditor.getState();
  const img = useHtmlImage(server?.artwork ? assetUrl(server.artwork.id) : null);
  const x = panel.frame.x * W;
  const y = panel.frame.y * H;
  const w = panel.frame.width * W;
  const h = panel.frame.height * H;
  const crop = img ? computeCrop(img.naturalWidth, img.naturalHeight, w / h, panel.imageTransform) : null;
  const status =
    server?.latestJob?.status === "failed" && server.status !== "ready" ? "failed" : (server?.status ?? "planned");
  const busy = status === "queued" || status === "generating";
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => setPulse((p) => (p + 1) % 20), 80);
    return () => clearInterval(t);
  }, [busy]);
  const border = Math.max(2, W / 400);
  const adjusting = useEditor((s) => s.adjustImageFor === panel.id) && !readOnly && Boolean(img);
  const shaping = useEditor((s) => s.shapeEditFor === panel.id) && !readOnly;
  // A shaped panel: its outline in the group's own pixels (the group sits at the box's top-left).
  const outline = panel.frame.points?.flatMap((p) => [p.x * w, p.y * h]) ?? null;
  const clip = outline
    ? (ctx: Konva.Context) => {
        ctx.beginPath();
        for (let i = 0; i < outline.length; i += 2)
          i ? ctx.lineTo(outline[i]!, outline[i + 1]!) : ctx.moveTo(outline[i]!, outline[i + 1]!);
        ctx.closePath();
      }
    : undefined;
  const panStart = useRef<{ doc: EditorDoc; t: DocPanel["imageTransform"] } | null>(null);
  const setTransformLive = (t: DocPanel["imageTransform"]) =>
    useEditor.setState((s) => ({
      doc: { ...s.doc, panels: s.doc.panels.map((p) => (p.id === panel.id ? { ...p, imageTransform: t } : p)) },
    }));
  const commitTransform = (t: DocPanel["imageTransform"]) =>
    commit((d) => ({ ...d, panels: d.panels.map((p) => (p.id === panel.id ? { ...p, imageTransform: t } : p)) }));
  return (
    <Group
      id={`panel-${panel.id}`}
      name="panel"
      x={x}
      y={y}
      draggable={!readOnly && !adjusting && !shaping}
      onDblClick={() => !readOnly && img && useEditor.getState().setAdjustImage(panel.id)}
      onDblTap={() => !readOnly && img && useEditor.getState().setAdjustImage(panel.id)}
      onMouseDown={onSelect}
      onTap={onSelect}
      onDragStart={() => setInteracting(true)}
      onDragEnd={(e) => {
        setInteracting(false);
        const nx = e.target.x() / W;
        const ny = e.target.y() / H;
        commit((d) => ({
          ...d,
          panels: d.panels.map((p) =>
            p.id === panel.id ? { ...p, frame: clampFrame({ ...p.frame, x: nx, y: ny }) } : p,
          ),
        }));
      }}
      onTransformStart={() => setInteracting(true)}
      onTransformEnd={(e) => {
        setInteracting(false);
        const n = e.target;
        const nw = (w * n.scaleX()) / W;
        const nh = (h * n.scaleY()) / H;
        n.scale({ x: 1, y: 1 });
        commit((d) => ({
          ...d,
          panels: d.panels.map((p) =>
            p.id === panel.id ? { ...p, frame: clampFrame({ x: n.x() / W, y: n.y() / H, width: nw, height: nh }) } : p,
          ),
        }));
      }}
    >
      {adjusting && img && crop && (
        <KImage
          image={img}
          x={-crop.x * (w / crop.width)}
          y={-crop.y * (h / crop.height)}
          width={img.naturalWidth * (w / crop.width)}
          height={img.naturalHeight * (h / crop.height)}
          opacity={0.35}
          listening={false}
        />
      )}
      <Group {...(clip ? { clipFunc: clip } : { clipX: 0, clipY: 0, clipWidth: w, clipHeight: h })}>
        <Rect width={w} height={h} fill="#e5e7eb" />
        {img && crop ? (
          <KImage image={img} width={w} height={h} crop={crop} />
        ) : (
          <Text
            text={server?.storyBeat || "Empty panel"}
            width={w}
            height={h}
            padding={16}
            fontSize={Math.max(14, W / 70)}
            fill="#6b7280"
            align="center"
            verticalAlign="middle"
            listening={false}
          />
        )}
        {busy && <Rect width={w} height={h} fill="#0ea5e9" opacity={0.08 + (pulse / 20) * 0.15} listening={false} />}
      </Group>
      {adjusting && img && (
        <Rect
          name="image-pan"
          width={w}
          height={h}
          fill="rgba(0,0,0,0.001)"
          draggable
          onMouseEnter={(e) => {
            const el = e.target.getStage()?.container();
            if (el) el.style.cursor = "move";
          }}
          onMouseLeave={(e) => {
            const el = e.target.getStage()?.container();
            if (el) el.style.cursor = "";
          }}
          onMouseDown={(e) => {
            e.cancelBubble = true;
          }}
          onDragStart={(e) => {
            e.cancelBubble = true;
            const st = useEditor.getState();
            panStart.current = { doc: st.doc, t: panel.imageTransform };
            setInteracting(true);
          }}
          onDragMove={(e) => {
            e.cancelBubble = true;
            const start = panStart.current;
            if (!start) return;
            setTransformLive(
              panImageTransform(img.naturalWidth, img.naturalHeight, w, h, start.t, e.target.x(), e.target.y()),
            );
          }}
          onDragEnd={(e) => {
            e.cancelBubble = true;
            const start = panStart.current;
            const dx = e.target.x();
            const dy = e.target.y();
            e.target.position({ x: 0, y: 0 });
            panStart.current = null;
            if (!start) return setInteracting(false);
            useEditor.setState({ doc: start.doc });
            setInteracting(false);
            commitTransform(panImageTransform(img.naturalWidth, img.naturalHeight, w, h, start.t, dx, dy));
          }}
          onWheel={(e) => {
            e.evt.preventDefault();
            e.cancelBubble = true;
            const t = panel.imageTransform;
            const k = e.evt.deltaY > 0 ? 1 / 1.08 : 1.08;
            commitTransform(panImageTransform(img.naturalWidth, img.naturalHeight, w, h, t, 0, 0, t.scale * k));
          }}
        />
      )}
      {(() => {
        const stroke = {
          stroke: shaping || adjusting ? "#f59e0b" : selected ? "#3b6cf6" : status === "failed" ? "#ef4444" : "#111",
          strokeWidth: adjusting || selected || shaping ? border * 2 : border,
          dash: adjusting ? [border * 6, border * 3] : undefined,
          listening: false,
        };
        return outline ? (
          <Line points={outline} closed lineJoin="miter" {...stroke} />
        ) : (
          <Rect width={w} height={h} {...stroke} />
        );
      })()}
      <Group x={8} y={8} listening={false}>
        <Rect width={Math.max(28, W / 45)} height={Math.max(22, W / 60)} cornerRadius={6} fill="#111" opacity={0.75} />
        <Text
          text={String(displayIndex)}
          width={Math.max(28, W / 45)}
          height={Math.max(22, W / 60)}
          align="center"
          verticalAlign="middle"
          fill="#fff"
          fontStyle="bold"
          fontSize={Math.max(12, W / 110)}
        />
        <Circle
          x={Math.max(28, W / 45) + 12}
          y={Math.max(22, W / 60) / 2}
          radius={Math.max(5, W / 250)}
          fill={STATUS_COLOR[status] ?? "#71717a"}
        />
      </Group>
    </Group>
  );
}

export function BubbleNode({ item, W, H, readOnly, selected, onSelect }: Common & { item: DocBubble }) {
  const { commit, setInteracting } = useEditor.getState();
  const b = item.bubble;
  const g = bubbleGeometry(b, W, H);
  const layout = layoutBubbleText(item.text, b, W, H);
  const boxed = b.type === "narration" || b.type === "system";
  const tailDragStart = useRef<EditorDoc | null>(null);
  const groupRef = useRef<Konva.Group>(null);
  // The outline path includes the tail; the Transformer (which measures with skipTransform) should frame only the
  // bubble body so its anchors don't sit on the tail tip handle.
  useLayoutEffect(() => {
    const node = groupRef.current;
    if (!node) return;
    const original = Konva.Group.prototype.getClientRect;
    node.getClientRect = function (this: Konva.Group, cfg) {
      if (cfg?.skipTransform) return { x: 0, y: 0, width: g.width, height: g.height };
      return original.call(this, cfg);
    };
    node.getLayer()?.batchDraw();
  }, [g.width, g.height]);
  const update = (fn: (bb: typeof b) => typeof b) =>
    commit((d) => ({ ...d, bubbles: d.bubbles.map((x) => (x.id === item.id ? { ...x, bubble: fn(x.bubble) } : x)) }));
  return (
    <>
      <Group
        ref={groupRef}
        id={`bubble-${item.id}`}
        x={g.x + g.width / 2}
        y={g.y + g.height / 2}
        offsetX={g.width / 2}
        offsetY={g.height / 2}
        rotation={b.rotation}
        draggable={!readOnly}
        onMouseEnter={cursor("move", readOnly)}
        onMouseLeave={cursor("", readOnly)}
        onMouseDown={onSelect}
        onTap={onSelect}
        onDragStart={() => setInteracting(true)}
        onDragEnd={(e) => {
          setInteracting(false);
          const nx = (e.target.x() - g.width / 2) / W;
          const ny = (e.target.y() - g.height / 2) / H;
          update((bb) => clampBox({ ...bb, x: nx, y: ny }));
        }}
        onTransformStart={() => setInteracting(true)}
        onTransformEnd={(e) => {
          setInteracting(false);
          const n = e.target;
          const nw = g.width * n.scaleX();
          const nh = g.height * n.scaleY();
          n.scale({ x: 1, y: 1 });
          update((bb) => ({
            ...clampBox({ ...bb, x: (n.x() - nw / 2) / W, y: (n.y() - nh / 2) / H, width: nw / W, height: nh / H }),
            rotation: Math.round(n.rotation()),
          }));
        }}
      >
        <Path
          data={g.path}
          fill={b.background}
          stroke={b.borderColor}
          strokeWidth={b.borderWidth}
          lineJoin="round"
          dash={g.dash ?? undefined}
        />
        {g.innerBorder && (
          <Path
            data={g.innerBorder}
            stroke={b.borderColor}
            strokeWidth={Math.max(1, b.borderWidth / 2)}
            listening={false}
          />
        )}
        {layout.lines.map((line, i) => {
          const y = layout.top - b.fontSize * 0.85 + i * layout.lineH;
          const common = {
            text: line,
            y,
            fontSize: b.fontSize,
            fontFamily: FONT_STACK(b.font),
            fontStyle: b.type === "shout" ? "bold" : "normal",
            fill: b.textColor,
            listening: false,
          } as const;
          if (b.align === "left") return <Text key={i} {...common} x={b.padding + (boxed ? 0 : g.width * 0.075)} />;
          if (b.align === "right") return <Text key={i} {...common} x={0} width={g.width - b.padding} align="right" />;
          return <Text key={i} {...common} x={0} width={g.width} align="center" />;
        })}
        {selected && (
          <Rect width={g.width} height={g.height} stroke="#3b6cf6" dash={[6, 4]} strokeWidth={1.5} listening={false} />
        )}
      </Group>
      {selected && !readOnly && b.tail && !boxed && (
        <Line
          points={[
            g.x + g.width / 2,
            g.y + g.height / 2,
            (b.tailTarget?.x ?? b.x + b.width / 2) * W,
            (b.tailTarget?.y ?? Math.min(1, b.y + b.height * 1.5)) * H,
          ]}
          stroke="#3b6cf6"
          strokeWidth={Math.max(1.5, W / 800)}
          dash={[8, 6]}
          listening={false}
        />
      )}
      {selected && !readOnly && b.tail && !boxed && (
        <Circle
          name="tail-handle"
          x={(b.tailTarget?.x ?? b.x + b.width / 2) * W}
          y={(b.tailTarget?.y ?? Math.min(1, b.y + b.height * 1.5)) * H}
          radius={Math.max(12, W / 110)}
          fill="#3b6cf6"
          stroke="#fff"
          strokeWidth={3}
          hitStrokeWidth={20}
          onMouseEnter={cursor("grab", readOnly)}
          onMouseLeave={cursor("", readOnly)}
          onDragMove={(e) => {
            // Live preview only; the drag-start doc is restored before committing so undo/save see the change.
            const tx = Math.min(1, Math.max(0, e.target.x() / W));
            const ty = Math.min(1, Math.max(0, e.target.y() / H));
            useEditor.setState((s) => ({
              doc: {
                ...s.doc,
                bubbles: s.doc.bubbles.map((x) =>
                  x.id === item.id ? { ...x, bubble: { ...x.bubble, tailTarget: { x: tx, y: ty } } } : x,
                ),
              },
            }));
          }}
          draggable
          onDragStart={() => {
            tailDragStart.current = useEditor.getState().doc;
            setInteracting(true);
          }}
          onDragEnd={(e) => {
            const tx = Math.min(1, Math.max(0, e.target.x() / W));
            const ty = Math.min(1, Math.max(0, e.target.y() / H));
            if (tailDragStart.current) useEditor.setState({ doc: tailDragStart.current });
            tailDragStart.current = null;
            setInteracting(false);
            update((bb) => ({ ...bb, tailTarget: { x: tx, y: ty } }));
          }}
        />
      )}
    </>
  );
}

export function SfxNode({ item, W, H, readOnly, selected, onSelect }: Common & { item: DocSfx }) {
  const { commit, setInteracting } = useEditor.getState();
  const st = item.style;
  const size = st.fontSize * st.scale;
  const ref = useRef<Konva.Text>(null);
  // SFX is a single line (like the exported SVG): no fixed box width, centered on the real rendered width.
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const center = () => {
      node.offsetX(node.width() / 2);
      node.getLayer()?.batchDraw();
    };
    center();
    let alive = true;
    void document.fonts?.ready.then(() => alive && center());
    return () => {
      alive = false;
    };
  }, [item.text, size, st.font, st.strokeWidth]);
  const update = (fn: (s: typeof st) => typeof st) =>
    commit((d) => ({ ...d, sfx: d.sfx.map((x) => (x.id === item.id ? { ...x, style: fn(x.style) } : x)) }));
  return (
    <Text
      id={`sfx-${item.id}`}
      text={item.text}
      x={st.x * W}
      y={st.y * H}
      ref={ref}
      offsetY={size * 0.8}
      wrap="none"
      rotation={st.rotation}
      fontSize={size}
      fontStyle="bold"
      fontFamily={FONT_STACK(st.font)}
      fill={st.fill}
      stroke={st.stroke}
      strokeWidth={st.strokeWidth}
      fillAfterStrokeEnabled
      lineJoin="round"
      opacity={st.opacity}
      shadowColor={selected ? "#3b6cf6" : undefined}
      shadowBlur={selected ? 12 : 0}
      draggable={!readOnly}
      onMouseEnter={cursor("move", readOnly)}
      onMouseLeave={cursor("", readOnly)}
      onMouseDown={onSelect}
      onTap={onSelect}
      onDragStart={() => setInteracting(true)}
      onDragEnd={(e) => {
        setInteracting(false);
        const nx = Math.min(1, Math.max(0, e.target.x() / W));
        const ny = Math.min(1, Math.max(0, e.target.y() / H));
        update((s) => ({ ...s, x: nx, y: ny }));
      }}
      onTransformStart={() => setInteracting(true)}
      onTransformEnd={(e) => {
        setInteracting(false);
        const n = e.target;
        const k = Math.max(n.scaleX(), n.scaleY());
        n.scale({ x: 1, y: 1 });
        update((s) => ({
          ...s,
          x: n.x() / W,
          y: n.y() / H,
          rotation: Math.round(n.rotation()),
          scale: Math.min(10, Math.max(0.1, s.scale * k)),
        }));
      }}
    />
  );
}

/**
 * The outline editor of one panel, drawn in page pixels over everything: a handle on every point (drag it; double-click
 * to remove it, down to three) and a "+" halfway along every edge (click to add a point there). Dragging updates the
 * panel live and records one undo step when released.
 */
export function ShapeHandles({ panelId, W, H, zoom }: { panelId: string; W: number; H: number; zoom: number }) {
  const panel = useEditor((s) => s.doc.panels.find((p) => p.id === panelId));
  const start = useRef<EditorDoc | null>(null);
  if (!panel) return null;
  const { commit, setInteracting } = useEditor.getState();
  const poly = framePolygon(panel.frame);
  const r = Math.max(5, 7 / zoom);
  const setFrame = (frame: Frame) => (d: EditorDoc) => ({
    ...d,
    panels: d.panels.map((p) => (p.id === panelId ? { ...p, frame } : p)),
  });
  const at = (e: Konva.KonvaEventObject<DragEvent>) => ({
    x: Math.min(1, Math.max(0, e.target.x() / W)),
    y: Math.min(1, Math.max(0, e.target.y() / H)),
  });
  return (
    <Group name="shape-handles">
      {poly.map((p, i) => {
        const q = poly[(i + 1) % poly.length]!;
        return (
          <Circle
            key={`m${i}`}
            name="shape-add"
            x={((p.x + q.x) / 2) * W}
            y={((p.y + q.y) / 2) * H}
            radius={r * 0.8}
            fill="#fff"
            stroke="#f59e0b"
            strokeWidth={r / 3}
            dash={[r / 2, r / 3]}
            onClick={() => commit(setFrame(insertFramePoint(panel.frame, i)))}
            onTap={() => commit(setFrame(insertFramePoint(panel.frame, i)))}
          />
        );
      })}
      {poly.map((p, i) => (
        <Circle
          key={`p${i}`}
          name="shape-point"
          x={p.x * W}
          y={p.y * H}
          radius={r}
          fill="#f59e0b"
          stroke="#fff"
          strokeWidth={r / 3}
          draggable
          onDragStart={() => {
            start.current = useEditor.getState().doc;
            setInteracting(true);
          }}
          onDragMove={(e) =>
            useEditor.setState((s) => ({ doc: setFrame(moveFramePoint(panel.frame, i, at(e)))(s.doc) }))
          }
          onDragEnd={(e) => {
            const frame = moveFramePoint(panel.frame, i, at(e));
            if (start.current) useEditor.setState({ doc: start.current });
            start.current = null;
            setInteracting(false);
            commit(setFrame(frame));
          }}
          onDblClick={() => commit(setFrame(removeFramePoint(panel.frame, i)))}
          onDblTap={() => commit(setFrame(removeFramePoint(panel.frame, i)))}
        />
      ))}
    </Group>
  );
}
