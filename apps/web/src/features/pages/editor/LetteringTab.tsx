import {
  applySfxDefaults,
  applyTypeStyle,
  refitBubble,
  resolveLettering,
  type TailDirection,
  tailTargetToward,
} from "@openmanga/domain/browser";
import type { Bubble, BubbleType, SfxStyle } from "@openmanga/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { Crosshair, MessageSquarePlus, Minimize2, Paintbrush, Trash2, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { del, patch, post } from "../../../api/client.ts";
import { qk, useAction } from "../../../api/hooks.ts";
import type { PageDocument } from "../../../api/types.ts";
import { ConfirmDialog, clsx, toast } from "../../../components/ui.tsx";
import { useProject } from "../../project/ProjectLayout.tsx";
import { type DocBubble, type DocSfx, useEditor } from "./store.ts";

const TYPES: BubbleType[] = ["normal", "thought", "shout", "whisper", "narration", "system"];

function useLettering() {
  return resolveLettering(useProject().data?.project.settings);
}

/** Selecting from the sidebar puts transformer handles on the canvas item; canvas selection scrolls the card into view. */
function useSelectableCard(type: "bubble" | "sfx", id: string, selected: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (selected && !ref.current?.contains(document.activeElement)) ref.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);
  return {
    ref,
    onPointerDown: () => !selected && useEditor.getState().select({ type, ids: [id] }),
    onFocus: () => !selected && useEditor.getState().select({ type, ids: [id] }),
  };
}

/** Percent-of-page number input for geometry. */
function Pct({ label, value, onChange }: { label: string; value: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1">
      {label}
      <input
        type="number"
        className="input px-1 text-xs"
        step={0.5}
        min={0}
        max={100}
        aria-label={`${label} (% of page)`}
        value={Math.round(value * 1000) / 10}
        onChange={(e) => e.target.value !== "" && onChange(Math.min(1, Math.max(0, Number(e.target.value) / 100)))}
      />
    </label>
  );
}

function CommitInput({
  value,
  onCommit,
  label,
  multiline,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  multiline?: boolean;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = () => draft !== value && onCommit(draft);
  const props = {
    className: "input",
    "aria-label": label,
    value: draft,
    onBlur: commit,
    onChange: (e: { target: { value: string } }) => setDraft(e.target.value),
  };
  return multiline ? (
    <textarea
      {...props}
      rows={2}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          commit();
        }
      }}
    />
  ) : (
    <input {...props} onKeyDown={(e) => e.key === "Enter" && commit()} />
  );
}

const TAIL_PAD: (TailDirection | null)[] = [
  "up-left",
  "up",
  "up-right",
  "left",
  null,
  "right",
  "down-left",
  "down",
  "down-right",
];
const TAIL_ARROW: Record<TailDirection, string> = {
  "up-left": "↖",
  up: "↑",
  "up-right": "↗",
  left: "←",
  right: "→",
  "down-left": "↙",
  down: "↓",
  "down-right": "↘",
};

function TailControls({
  bubbleId,
  bubble: b,
  onChange,
}: {
  bubbleId: string;
  bubble: Bubble;
  onChange: (p: Partial<Bubble>) => void;
}) {
  const aiming = useEditor((s) => s.aimTailFor === bubbleId);
  return (
    <div className="col-span-2 space-y-1.5 rounded-md bg-[var(--panel-2)] p-1.5">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={b.tail} onChange={(e) => onChange({ tail: e.target.checked })} /> Tail
        </label>
        <button
          type="button"
          className={clsx("btn-ghost ml-auto py-0.5 text-xs", aiming && "bg-accent-500 text-white")}
          aria-pressed={aiming}
          title="Then click the page where the speaker is"
          onClick={() => {
            const st = useEditor.getState();
            st.select({ type: "bubble", ids: [bubbleId] });
            st.setAimTail(aiming ? null : bubbleId);
          }}
        >
          <Crosshair className="size-3.5" /> {aiming ? "Click the speaker on the page…" : "Aim at speaker"}
        </button>
      </div>
      <div className="flex items-center gap-2">
        <fieldset className="grid shrink-0 grid-cols-[repeat(3,1.75rem)] gap-0.5" aria-label="Tail direction">
          {TAIL_PAD.map((d, i) =>
            d ? (
              <button
                key={d}
                type="button"
                className="flex size-7 items-center justify-center rounded text-sm leading-none hover:bg-[var(--border)] focus-visible:outline-2 focus-visible:outline-accent-500"
                aria-label={`Point tail ${d.replace("-", " ")}`}
                onClick={() => onChange({ tail: true, tailTarget: tailTargetToward(b, d) })}
              >
                {TAIL_ARROW[d]}
              </button>
            ) : (
              <span key={`c${i}`} />
            ),
          )}
        </fieldset>
        <p className="muted text-[11px] leading-tight">
          Pick a direction, use "Aim at speaker", or drag the blue dot on the page. The tip stays put when you move the
          bubble.
        </p>
      </div>
    </div>
  );
}

function BubbleEditor({ item, data, selected }: { item: DocBubble; data: PageDocument; selected: boolean }) {
  const { commit } = useEditor.getState();
  const lettering = useLettering();
  const card = useSelectableCard("bubble", item.id, selected);
  const W = data.page.width;
  const H = data.page.height;
  const fit = (text: string, bb: Bubble) => refitBubble(text, bb, W, H, lettering.maxWidth);
  const update = (fn: (bb: Bubble, text: string) => Partial<{ bubble: Bubble; text: string }>) =>
    commit((d) => ({
      ...d,
      bubbles: d.bubbles.map((b) => (b.id === item.id ? { ...b, ...fn(b.bubble, b.text) } : b)),
    }));
  const setBubble = (patchB: Partial<Bubble>, refit = false) =>
    update((bb, text) => {
      const next = { ...bb, ...patchB };
      return { bubble: refit && lettering.autoFit ? fit(text, next) : next };
    });
  const setText = (text: string) => update((bb) => ({ text, bubble: lettering.autoFit ? fit(text, bb) : bb }));
  const line = data.dialogue.find((l) => l.id === item.id);
  const inv = [qk.page(data.page.id)];
  const speaker = useAction((characterId: string | null) => patch(`/dialogue/${item.id}`, { characterId }), {
    invalidate: inv,
  });
  const remove = useAction(() => del(`/dialogue/${item.id}`), { invalidate: inv });
  const b = item.bubble;
  return (
    <div
      {...card}
      className={clsx(
        "cursor-pointer space-y-2 rounded-lg border p-2",
        selected ? "border-accent-500 ring-1 ring-accent-500" : "border-[var(--border)]",
      )}
    >
      {item.kind === "narration" ? (
        <p className="text-xs">
          <span className="chip bg-amber-500/15">narration box</span> {item.text}{" "}
          <span className="muted">(edit text in Narration)</span>
        </p>
      ) : (
        <CommitInput label="Bubble text" value={item.text} onCommit={setText} multiline />
      )}
      <div className="grid grid-cols-2 gap-1.5 text-xs">
        <select
          className="input text-xs"
          aria-label="Bubble type"
          value={b.type}
          onChange={(e) =>
            update((bb, text) => {
              const type = e.target.value as BubbleType;
              const next = {
                ...applyTypeStyle(bb, lettering, type),
                tail: !["narration", "system"].includes(type) && bb.tail,
              };
              return { bubble: lettering.autoFit ? fit(text, next) : next };
            })
          }
        >
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        {item.kind === "dialogue" && (
          <select
            className="input text-xs"
            aria-label="Speaker"
            value={line?.characterId ?? ""}
            onChange={(e) => speaker.mutate(e.target.value || null)}
          >
            <option value="">No speaker</option>
            {data.cast.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <label className="flex items-center gap-1">
          Size{" "}
          <input
            type="number"
            className="input text-xs"
            min={8}
            max={120}
            value={b.fontSize}
            onChange={(e) => setBubble({ fontSize: Number(e.target.value) || b.fontSize }, true)}
          />
        </label>
        <label className="flex items-center gap-1">
          <select
            className="input text-xs"
            aria-label="Alignment"
            value={b.align}
            onChange={(e) => setBubble({ align: e.target.value as Bubble["align"] })}
          >
            <option value="left">left</option>
            <option value="center">center</option>
            <option value="right">right</option>
          </select>
        </label>
        <label className="flex items-center gap-1">
          Fill{" "}
          <input
            type="color"
            value={b.background}
            onChange={(e) => setBubble({ background: e.target.value })}
            aria-label="Background color"
          />
        </label>
        <label className="flex items-center gap-1">
          Text{" "}
          <input
            type="color"
            value={b.textColor}
            onChange={(e) => setBubble({ textColor: e.target.value })}
            aria-label="Text color"
          />
        </label>
        <label className="flex items-center gap-1">
          Border{" "}
          <input
            type="color"
            value={b.borderColor}
            onChange={(e) => setBubble({ borderColor: e.target.value })}
            aria-label="Border color"
          />
        </label>
        <div />
        <label className="col-span-2 flex items-center gap-1">
          Font{" "}
          <select className="input text-xs" value={b.font} onChange={(e) => setBubble({ font: e.target.value }, true)}>
            <option>Comic Neue</option>
            <option>DejaVu Sans</option>
          </select>
        </label>
        {b.type !== "narration" && b.type !== "system" && (
          <TailControls bubbleId={item.id} bubble={b} onChange={(p) => setBubble(p)} />
        )}
        <Pct label="X" value={b.x} onChange={(x) => setBubble({ x: Math.min(x, 1 - b.width) })} />
        <Pct label="Y" value={b.y} onChange={(y) => setBubble({ y: Math.min(y, 1 - b.height) })} />
        <Pct label="W" value={b.width} onChange={(w) => setBubble({ width: Math.max(0.02, Math.min(w, 1 - b.x)) })} />
        <Pct label="H" value={b.height} onChange={(h) => setBubble({ height: Math.max(0.02, Math.min(h, 1 - b.y)) })} />
      </div>
      <div className="flex flex-wrap gap-1 text-xs">
        <button
          type="button"
          className="btn-ghost py-0.5 text-xs"
          title="Shrink or grow the box to fit its text"
          onClick={() => update((bb, text) => ({ bubble: fit(text, bb) }))}
        >
          <Minimize2 className="size-3.5" /> Fit to text
        </button>
        <button
          type="button"
          className="btn-ghost py-0.5 text-xs"
          title={`Apply the project's default "${b.type}" style`}
          onClick={() =>
            update((bb, text) => {
              const next = applyTypeStyle(bb, lettering);
              return { bubble: lettering.autoFit ? fit(text, next) : next };
            })
          }
        >
          <Paintbrush className="size-3.5" /> Default style
        </button>
        {item.kind === "dialogue" && (
          <button type="button" className="btn-ghost py-0.5 text-xs text-red-500" onClick={() => remove.mutate()}>
            <Trash2 className="size-3.5" /> Delete bubble
          </button>
        )}
      </div>
    </div>
  );
}

function SfxEditor({ item, pageId, selected }: { item: DocSfx; pageId: string; selected: boolean }) {
  const { commit } = useEditor.getState();
  const lettering = useLettering();
  const card = useSelectableCard("sfx", item.id, selected);
  const set = (p: Partial<SfxStyle>) =>
    commit((d) => ({ ...d, sfx: d.sfx.map((s) => (s.id === item.id ? { ...s, style: { ...s.style, ...p } } : s)) }));
  const remove = useAction(() => del(`/sfx/${item.id}`), { invalidate: [qk.page(pageId)] });
  const st = item.style;
  return (
    <div
      className={clsx(
        "cursor-pointer space-y-2 rounded-lg border p-2 text-xs",
        selected ? "border-accent-500 ring-1 ring-accent-500" : "border-[var(--border)]",
      )}
      {...card}
    >
      <CommitInput
        label="SFX text"
        value={item.text}
        onCommit={(text) => commit((d) => ({ ...d, sfx: d.sfx.map((s) => (s.id === item.id ? { ...s, text } : s)) }))}
      />
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex items-center gap-1">
          Size{" "}
          <input
            type="number"
            className="input text-xs"
            min={8}
            max={400}
            value={st.fontSize}
            onChange={(e) => set({ fontSize: Number(e.target.value) || st.fontSize })}
          />
        </label>
        <label className="flex items-center gap-1">
          Stroke w{" "}
          <input
            type="number"
            className="input text-xs"
            min={0}
            max={30}
            value={st.strokeWidth}
            onChange={(e) => set({ strokeWidth: Number(e.target.value) })}
          />
        </label>
        <label className="flex items-center gap-1">
          Fill{" "}
          <input type="color" value={st.fill} onChange={(e) => set({ fill: e.target.value })} aria-label="SFX fill" />
        </label>
        <label className="flex items-center gap-1">
          Stroke{" "}
          <input
            type="color"
            value={st.stroke}
            onChange={(e) => set({ stroke: e.target.value })}
            aria-label="SFX stroke"
          />
        </label>
        <label className="col-span-2 flex items-center gap-1">
          Rotation{" "}
          <input
            type="range"
            className="flex-1"
            min={-180}
            max={180}
            value={st.rotation}
            onChange={(e) => set({ rotation: Number(e.target.value) })}
          />
        </label>
        <label className="col-span-2 flex items-center gap-1">
          Scale{" "}
          <input
            type="range"
            className="flex-1"
            min={0.2}
            max={4}
            step={0.05}
            value={st.scale}
            onChange={(e) => set({ scale: Number(e.target.value) })}
          />
        </label>
        <label className="col-span-2 flex items-center gap-1">
          Opacity{" "}
          <input
            type="range"
            className="flex-1"
            min={0.1}
            max={1}
            step={0.05}
            value={st.opacity}
            onChange={(e) => set({ opacity: Number(e.target.value) })}
          />
        </label>
        <Pct label="X" value={st.x} onChange={(x) => set({ x })} />
        <Pct label="Y" value={st.y} onChange={(y) => set({ y })} />
      </div>
      <div className="flex flex-wrap gap-1">
        <button
          type="button"
          className="btn-ghost py-0.5"
          onClick={() =>
            commit((d) => ({
              ...d,
              sfx: d.sfx.map((s) => (s.id === item.id ? { ...s, style: applySfxDefaults(s.style, lettering) } : s)),
            }))
          }
        >
          <Paintbrush className="size-3.5" /> Default style
        </button>
        <button type="button" className="btn-ghost py-0.5 text-red-500" onClick={() => remove.mutate()}>
          <Trash2 className="size-3.5" /> Delete SFX
        </button>
      </div>
    </div>
  );
}

export function LetteringTab({ data, panelId }: { data: PageDocument; panelId: string | null }) {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const [text, setText] = useState("");
  const [type, setType] = useState<BubbleType>("normal");
  const [speaker, setSpeaker] = useState("");
  const [sfxText, setSfxText] = useState("");
  const inv = [qk.page(data.page.id)];
  const addBubble = useAction(
    () => post(`/pages/${data.page.id}/dialogue`, { panelId, text, type, characterId: speaker || null }),
    { invalidate: inv, onSuccess: () => setText("") },
  );
  const addSfx = useAction(() => post(`/pages/${data.page.id}/sfx`, { panelId, text: sfxText }), {
    invalidate: inv,
    onSuccess: () => setSfxText(""),
  });
  const qc = useQueryClient();
  const [scope, setScope] = useState<"page" | "chapter" | "project">("page");
  const [applying, setApplying] = useState(false);
  const applyDefaults = async (restyle: boolean) => {
    setApplying(true);
    try {
      await useEditor.getState().flush();
      const r = await post<{ pages: number; bubbles: number; narration: number; sfx: number }>(
        `/pages/${data.page.id}/lettering/apply-defaults`,
        { scope, restyle, fit: true },
      );
      toast.success(
        `${restyle ? "Restyled" : "Fitted"} ${r.bubbles + r.narration} text boxes${restyle ? ` and ${r.sfx} SFX` : ""} on ${r.pages} page${r.pages === 1 ? "" : "s"}`,
      );
      await qc.invalidateQueries({ queryKey: ["page"] });
    } catch (e) {
      toast.error(e);
    }
    setApplying(false);
  };
  const [confirmClear, setConfirmClear] = useState(false);
  const clearLettering = async () => {
    setApplying(true);
    try {
      await useEditor.getState().flush();
      const r = await post<{ pages: number; bubbles: number; sfx: number; captions: number }>(
        `/pages/${data.page.id}/lettering/clear`,
        { scope },
      );
      toast.success(
        `Removed ${r.bubbles} bubbles, ${r.captions} captions and ${r.sfx} SFX from ${r.pages} page${r.pages === 1 ? "" : "s"}`,
      );
      useEditor.getState().select(null);
      await qc.invalidateQueries({ queryKey: ["page"] });
    } catch (e) {
      toast.error(e);
    }
    setApplying(false);
    setConfirmClear(false);
  };
  // With auto-placement off, a chapter plan keeps its dialogue and SFX on each panel instead of lettering them.
  const planned = data.panels.reduce(
    (n, p) =>
      p.plannedLettering && p.approvalStatus !== "locked"
        ? { lines: n.lines + p.plannedLettering.dialogue.length, sfx: n.sfx + p.plannedLettering.sfx.length }
        : n,
    { lines: 0, sfx: 0 },
  );
  const letterFromPlan = useAction(
    async () => {
      await useEditor.getState().flush();
      return post<{ lines: number; sfx: number }>(`/pages/${data.page.id}/letter-from-plan`);
    },
    { invalidate: [["page"]], success: (r) => `Placed ${r.lines} bubbles and ${r.sfx} SFX from the plan` },
  );
  const bubbles = doc.bubbles.filter((b) => !panelId || b.panelId === panelId);
  const sfx = doc.sfx.filter((s) => !panelId || s.panelId === panelId);
  const isSel = (t: string, id: string) => selection?.type === t && selection.ids.includes(id);

  return (
    <div className="space-y-4 text-sm">
      <p className="muted text-xs">
        {panelId
          ? "Showing lettering for the selected panel."
          : "Showing lettering for the whole page. Select a panel to attach new items to it."}{" "}
        Lettering is vector — changes cost zero image calls. Click an item (here or on the page) to move and resize it;
        drag the side handles to change width.
      </p>
      {planned.lines + planned.sfx > 0 && (
        <div className="rounded-lg border border-accent-500/40 bg-accent-600/10 p-2 text-xs">
          <div className="font-medium">The chapter plan wrote text for this page</div>
          <p className="muted mt-1">
            {planned.lines} line{planned.lines === 1 ? "" : "s"} of dialogue and {planned.sfx} SFX, kept aside because
            automatic lettering is off. Place them as bubbles where the plan left space; move or edit them after.
          </p>
          <button
            type="button"
            className="btn-secondary mt-1 w-full text-xs"
            disabled={letterFromPlan.isPending}
            onClick={() => letterFromPlan.mutate()}
          >
            <MessageSquarePlus className="size-3.5" /> Letter from plan
          </button>
        </div>
      )}
      <details className="rounded-lg border border-[var(--border)] p-2 text-xs">
        <summary className="cursor-pointer font-medium">Default styles & bulk actions</summary>
        <div className="mt-2 space-y-2">
          <p className="muted">
            Per-type fonts, sizes and colors are set in Project settings → Lettering. Apply them to existing text:
          </p>
          <select
            className="input text-xs"
            aria-label="Apply to"
            value={scope}
            onChange={(e) => setScope(e.target.value as typeof scope)}
          >
            <option value="page">This page</option>
            <option value="chapter">Whole chapter</option>
            <option value="project">Whole project</option>
          </select>
          <div className="flex gap-1">
            <button
              type="button"
              className="btn-secondary flex-1 text-xs"
              disabled={applying}
              onClick={() => applyDefaults(false)}
            >
              <Minimize2 className="size-3.5" /> Fit boxes to text
            </button>
            <button
              type="button"
              className="btn-secondary flex-1 text-xs"
              disabled={applying}
              onClick={() => applyDefaults(true)}
            >
              <Paintbrush className="size-3.5" /> Apply styles + fit
            </button>
          </div>
          <button
            type="button"
            className="btn-secondary w-full text-xs text-red-500"
            disabled={applying}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 className="size-3.5" /> Remove all bubbles, captions & SFX
          </button>
        </div>
      </details>
      <ConfirmDialog
        open={confirmClear}
        danger
        busy={applying}
        title="Remove lettering?"
        confirmLabel="Remove lettering"
        onClose={() => setConfirmClear(false)}
        onConfirm={clearLettering}
      >
        Deletes every speech bubble and SFX and hides narration captions on{" "}
        {scope === "page"
          ? "this page"
          : scope === "chapter"
            ? "every page of this chapter"
            : "every page of the project"}
        . Artwork is untouched, and narration lines and their audio are kept. This can't be undone.
      </ConfirmDialog>
      <div className="space-y-2 rounded-lg border border-[var(--border)] p-2">
        <textarea
          className="input"
          rows={2}
          placeholder="New dialogue…"
          aria-label="New bubble text"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <div className="flex gap-1">
          <select
            className="input"
            aria-label="New bubble type"
            value={type}
            onChange={(e) => setType(e.target.value as BubbleType)}
          >
            {TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select
            className="input"
            aria-label="New bubble speaker"
            value={speaker}
            onChange={(e) => setSpeaker(e.target.value)}
          >
            <option value="">No speaker</option>
            {data.cast.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          className="btn-primary w-full"
          disabled={!text.trim() || addBubble.isPending}
          onClick={() => addBubble.mutate()}
        >
          <MessageSquarePlus className="size-4" /> Add bubble
        </button>
      </div>
      <div className="flex gap-1">
        <input
          className="input"
          placeholder="SFX (e.g. BAM)"
          aria-label="New sound effect"
          value={sfxText}
          onChange={(e) => setSfxText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sfxText.trim() && addSfx.mutate()}
        />
        <button
          type="button"
          className="btn-secondary"
          disabled={!sfxText.trim() || addSfx.isPending}
          onClick={() => addSfx.mutate()}
        >
          <Zap className="size-4" /> Add
        </button>
      </div>
      {bubbles.map((b) => (
        <BubbleEditor key={b.id} item={b} data={data} selected={isSel("bubble", b.id)} />
      ))}
      {sfx.map((s) => (
        <SfxEditor key={s.id} item={s} pageId={data.page.id} selected={isSel("sfx", s.id)} />
      ))}
      {!bubbles.length && !sfx.length && <p className="muted text-xs">No lettering yet.</p>}
    </div>
  );
}
