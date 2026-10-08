import type { Bubble, Frame, ImageTransform, SfxStyle } from "@openmanga/schemas";
import { create } from "zustand";
import { patch } from "../../../api/client.ts";
import type { PageDocument } from "../../../api/types.ts";
import { toast } from "../../../components/ui.tsx";

/** Vendor-neutral editable document. Konva only renders this; it is never the storage format. */
export type DocPanel = { id: string; frame: Frame; imageTransform: ImageTransform; order: number };
export type DocBubble = {
  id: string;
  kind: "dialogue" | "narration";
  text: string;
  bubble: Bubble;
  panelId: string | null;
};
export type DocSfx = { id: string; text: string; style: SfxStyle; panelId: string | null };
export type EditorDoc = { panels: DocPanel[]; bubbles: DocBubble[]; sfx: DocSfx[] };

export type Selection = { type: "panel" | "bubble" | "sfx"; ids: string[] } | null;
type SaveState = "idle" | "saving" | "saved" | "error";

export function docFromServer(d: PageDocument): EditorDoc {
  return {
    panels: d.panels.map((p) => ({ id: p.id, frame: p.frame, imageTransform: p.imageTransform, order: p.order })),
    bubbles: [
      ...d.dialogue.map((l) => ({
        id: l.id,
        kind: "dialogue" as const,
        text: l.text,
        bubble: l.bubble,
        panelId: l.panelId,
      })),
      ...d.narration
        .filter((n) => n.showOnPage && n.box)
        .map((n) => ({
          id: n.id,
          kind: "narration" as const,
          text: n.text,
          bubble: n.box as Bubble,
          panelId: n.panelId,
        })),
    ],
    sfx: d.sfx.map((s) => ({ id: s.id, text: s.text, style: s.style, panelId: s.panelId })),
  };
}

const ids = (d: EditorDoc) =>
  [...d.panels.map((p) => p.id), ...d.bubbles.map((b) => b.id), ...d.sfx.map((s) => s.id)].sort().join(",");
const key = (kind: "panels" | "bubbles" | "sfx", id: string) => `${kind}:${id}`;

/** Ids whose content differs between two snapshots. */
function changedKeys(a: EditorDoc, b: EditorDoc) {
  const out: string[] = [];
  for (const kind of ["panels", "bubbles", "sfx"] as const) {
    const prev = new Map((a[kind] as { id: string }[]).map((x) => [x.id, JSON.stringify(x)]));
    for (const x of b[kind] as { id: string }[]) if (prev.get(x.id) !== JSON.stringify(x)) out.push(key(kind, x.id));
  }
  return out;
}

type State = {
  pageId: string | null;
  doc: EditorDoc;
  past: EditorDoc[];
  future: EditorDoc[];
  selection: Selection;
  pending: Set<string>;
  saveState: SaveState;
  inFlight: boolean;
  interacting: boolean;
  /** Bubble id whose tail is aimed by the next click on the page. */
  aimTailFor: string | null;
  setAimTail: (id: string | null) => void;
  /** Panel whose artwork is being moved/zoomed inside its frame (drag = pan, wheel = zoom). */
  adjustImageFor: string | null;
  setAdjustImage: (id: string | null) => void;
  /** The panel whose outline points are being edited (drag, add on an edge, double-click to remove). */
  shapeEditFor: string | null;
  setShapeEdit: (id: string | null) => void;
  onSaved: (() => void) | null;
  /** Loads a page; on a page newly opened, `panelId` (when it is on the page) is selected instead of the first panel. */
  hydrate: (pageId: string, d: PageDocument, panelId?: string) => void;
  select: (s: Selection, additive?: boolean) => void;
  /** Apply an edit as one undoable step and schedule persistence. */
  commit: (fn: (d: EditorDoc) => EditorDoc) => void;
  undo: () => void;
  redo: () => void;
  setInteracting: (v: boolean) => void;
  flush: () => Promise<void>;
};

let timer: ReturnType<typeof setTimeout> | undefined;

export const useEditor = create<State>((set, get) => ({
  pageId: null,
  doc: { panels: [], bubbles: [], sfx: [] },
  past: [],
  future: [],
  selection: null,
  pending: new Set(),
  saveState: "idle",
  inFlight: false,
  interacting: false,
  aimTailFor: null,
  setAimTail: (id) => set({ aimTailFor: id }),
  adjustImageFor: null,
  setAdjustImage: (id) => set({ adjustImageFor: id, ...(id ? { shapeEditFor: null } : {}) }),
  shapeEditFor: null,
  setShapeEdit: (id) => set({ shapeEditFor: id, ...(id ? { adjustImageFor: null } : {}) }),
  onSaved: null,

  hydrate: (pageId, d, panelId) => {
    const s = get();
    const next = docFromServer(d);
    if (s.pageId !== pageId) {
      // Open on the panel a link names (a comment, a storyboard card), else the first, so the Panel/Prompt/Versions
      // tabs have something to show.
      const first = next.panels.find((p) => p.id === panelId) ?? [...next.panels].sort((x, y) => x.order - y.order)[0];
      set({
        pageId,
        doc: next,
        past: [],
        future: [],
        selection: first ? { type: "panel", ids: [first.id] } : null,
        pending: new Set(),
        saveState: "idle",
      });
      return;
    }
    // Never clobber local edits that are dragging, queued or being saved.
    if (s.interacting || s.pending.size || s.inFlight) return;
    const structural = ids(next) !== ids(s.doc);
    set({ doc: next, ...(structural ? { past: [], future: [] } : {}) });
    if (structural && s.selection) {
      const all = new Set(ids(next).split(","));
      const kept = s.selection.ids.filter((i) => all.has(i));
      set({ selection: kept.length ? { ...s.selection, ids: kept } : null });
    }
  },

  select: (sel, additive) => {
    const cur = get().selection;
    if (additive && sel && cur?.type === "panel" && sel.type === "panel") {
      const id = sel.ids[0]!;
      const next = cur.ids.includes(id) ? cur.ids.filter((x) => x !== id) : [...cur.ids, id];
      set({ selection: next.length ? { type: "panel", ids: next } : null });
      return;
    }
    set({ selection: sel });
  },

  commit: (fn) => {
    const prev = get().doc;
    const next = fn(prev);
    const changed = changedKeys(prev, next);
    if (!changed.length) return;
    set((s) => ({
      doc: next,
      past: [...s.past.slice(-99), prev],
      future: [],
      pending: new Set([...s.pending, ...changed]),
    }));
    schedule();
  },

  undo: () => {
    const s = get();
    const prev = s.past.at(-1);
    if (!prev) return;
    set({
      doc: prev,
      past: s.past.slice(0, -1),
      future: [s.doc, ...s.future],
      pending: new Set([...s.pending, ...changedKeys(s.doc, prev), ...changedKeys(prev, s.doc)]),
    });
    schedule();
  },

  redo: () => {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({
      doc: next,
      past: [...s.past, s.doc],
      future: s.future.slice(1),
      pending: new Set([...s.pending, ...changedKeys(s.doc, next), ...changedKeys(next, s.doc)]),
    });
    schedule();
  },

  setInteracting: (v) => set({ interacting: v }),

  flush: async () => {
    const s = get();
    if (!s.pageId || !s.pending.size || s.inFlight) return;
    const keys = [...s.pending];
    set({ pending: new Set(), inFlight: true, saveState: "saving" });
    const has = (k: "panels" | "bubbles" | "sfx", id: string) => keys.includes(key(k, id));
    const body = {
      panels: s.doc.panels
        .filter((p) => has("panels", p.id))
        .map((p) => ({ id: p.id, frame: p.frame, imageTransform: p.imageTransform, order: p.order })),
      dialogue: s.doc.bubbles
        .filter((b) => b.kind === "dialogue" && has("bubbles", b.id))
        .map((b) => ({ id: b.id, bubble: b.bubble, text: b.text })),
      narration: s.doc.bubbles
        .filter((b) => b.kind === "narration" && has("bubbles", b.id))
        .map((b) => ({ id: b.id, box: b.bubble })),
      sfx: s.doc.sfx.filter((x) => has("sfx", x.id)).map((x) => ({ id: x.id, style: x.style, text: x.text })),
    };
    try {
      await patch(`/pages/${s.pageId}/document`, body);
      set({ inFlight: false, saveState: get().pending.size ? "saving" : "saved" });
      get().onSaved?.();
    } catch (e) {
      // Put keys back so the next edit retries them; never silently drop changes.
      set((st) => ({ inFlight: false, saveState: "error", pending: new Set([...st.pending, ...keys]) }));
      toast.error(e);
    }
    if (get().pending.size) schedule();
  },
}));

function schedule() {
  clearTimeout(timer);
  useEditor.setState({ saveState: "saving" });
  timer = setTimeout(() => void useEditor.getState().flush(), 300);
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
export function clampFrame(f: Frame): Frame {
  const width = Math.min(1, Math.max(0.02, f.width));
  const height = Math.min(1, Math.max(0.02, f.height));
  return {
    x: clamp01(Math.min(f.x, 1 - width)),
    y: clamp01(Math.min(f.y, 1 - height)),
    width,
    height,
    ...(f.points ? { points: f.points } : {}),
    ...(f.edge ? { edge: f.edge } : {}),
  };
}
export function clampBox<T extends { x: number; y: number; width: number; height: number }>(b: T): T {
  const width = Math.min(1, Math.max(0.01, b.width));
  const height = Math.min(1, Math.max(0.01, b.height));
  return { ...b, width, height, x: clamp01(Math.min(b.x, 1 - width)), y: clamp01(Math.min(b.y, 1 - height)) };
}

/** Same crop math as packages/image-utils computeCrop (that module needs sharp, so not browser-safe). */
/**
 * Pan/zoom an image transform by a drag of (dx, dy) page pixels on a frame drawn w×h, keeping the crop inside the
 * image so the stored focal point never drifts into a dead zone.
 */
export function panImageTransform(
  srcW: number,
  srcH: number,
  w: number,
  h: number,
  t: ImageTransform,
  dx: number,
  dy: number,
  scale = t.scale,
): ImageTransform {
  const s = Math.min(8, Math.max(1, scale));
  const crop = computeCrop(srcW, srcH, w / h, { ...t, scale: s });
  const cx = crop.x + crop.width / 2 - dx * (crop.width / w);
  const cy = crop.y + crop.height / 2 - dy * (crop.height / h);
  const clamp = (v: number, half: number, size: number) => Math.min(size - half, Math.max(half, v)) / size;
  return {
    focalX: Math.round(clamp(cx, crop.width / 2, srcW) * 10000) / 10000,
    focalY: Math.round(clamp(cy, crop.height / 2, srcH) * 10000) / 10000,
    scale: Math.round(s * 1000) / 1000,
  };
}

export function computeCrop(
  srcW: number,
  srcH: number,
  targetAspect: number,
  t: { focalX: number; focalY: number; scale: number },
) {
  let cw = srcW;
  let ch = srcW / targetAspect;
  if (ch > srcH) {
    ch = srcH;
    cw = srcH * targetAspect;
  }
  const scale = Math.max(1, t.scale);
  cw /= scale;
  ch /= scale;
  const left = Math.min(Math.max(0, t.focalX * srcW - cw / 2), srcW - cw);
  const top = Math.min(Math.max(0, t.focalY * srcH - ch / 2), srcH - ch);
  return { x: left, y: top, width: cw, height: ch };
}
