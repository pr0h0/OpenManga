import { NarrationLineVideo } from "@openmanga/schemas";
import { Merge, Play, RefreshCw, Scissors, Split, Trash2, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { assetUrl, del, patch, post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import type { NarrationDoc, NarrationSegment, Voice } from "../../api/types.ts";
import { clsx, fmt, SaveIndicator, StatusChip, useAutosave } from "../../components/ui.tsx";
import { useAiBody } from "../ai/AiPicker.tsx";

type Line = NarrationDoc["lines"][number];
type PanelOption = { id: string; label: string };

export function LineEditor({
  line,
  panels,
  voices,
  invalidate,
  currentSegmentId,
  defaults,
}: {
  line: Line;
  panels: PanelOption[];
  voices: Voice[];
  invalidate: readonly (readonly unknown[])[];
  currentSegmentId: string | null;
  defaults: { voice: string; speed: number };
}) {
  const [text, setText] = useState(line.text);
  const { state } = useAutosave(text, async (v) => {
    if (v.trim()) await patch(`/narration-lines/${line.id}`, { text: v });
  });
  const update = useAction((body: Record<string, unknown>) => patch(`/narration-lines/${line.id}`, body), {
    invalidate,
  });
  const remove = useAction(() => del(`/narration-lines/${line.id}`), { invalidate, success: "Line deleted" });
  const reseg = useAction(() => post(`/narration-lines/${line.id}/resegment`, { maxChars: 400 }), {
    invalidate,
    success: "Re-segmented",
  });

  return (
    <div className="card p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        <span className="muted">#{line.order}</span>
        <select
          className="input w-auto py-1 text-xs"
          value={line.panelId ?? ""}
          onChange={(e) => update.mutate({ panelId: e.target.value || null })}
          aria-label="Linked panel"
        >
          <option value="">No panel</option>
          {panels.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          <input
            type="checkbox"
            checked={line.showOnPage}
            disabled={!line.panelId}
            onChange={(e) => update.mutate({ showOnPage: e.target.checked })}
          />{" "}
          Caption on page
        </label>
        <SaveIndicator state={state} />
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            className="btn-ghost py-1"
            onClick={() => reseg.mutate()}
            title="Re-split into segments"
          >
            <Split className="size-3.5" /> Resegment
          </button>
          <button
            type="button"
            className="btn-ghost py-1 text-red-500"
            onClick={() => confirm("Delete this narration line?") && remove.mutate()}
            aria-label="Delete line"
          >
            <Trash2 className="size-3.5" />
          </button>
        </div>
      </div>
      <textarea
        className="input min-h-16 font-serif"
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Narration text"
      />
      <LineVideo line={line} panels={panels} onChange={(video) => update.mutate({ video })} />
      <div className="mt-2 space-y-1.5">
        {line.segments.map((s, i) => (
          <SegmentRow
            key={s.id}
            seg={s}
            isLast={i === line.segments.length - 1}
            voices={voices}
            invalidate={invalidate}
            active={s.id === currentSegmentId}
            defaults={defaults}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The line in the video: stretched over the shots up to a later panel (they share one hold), with silence before
 * and after it.
 */
function LineVideo({
  line,
  panels,
  onChange,
}: {
  line: Line;
  panels: PanelOption[];
  onChange: (video: NarrationLineVideo) => void;
}) {
  const v = NarrationLineVideo.parse(line.video ?? {});
  const from = panels.findIndex((p) => p.id === line.panelId);
  const ms = (label: string, key: "startOffsetMs" | "endOffsetMs") => (
    <label className="flex items-center gap-1">
      {label}
      <input
        type="number"
        className="input w-20 py-0.5 text-xs"
        step={100}
        min={0}
        max={10000}
        defaultValue={v[key]}
        onBlur={(e) => {
          const n = Math.min(10000, Math.max(0, Math.round(Number(e.target.value) || 0)));
          if (n !== v[key]) onChange({ ...v, [key]: n });
        }}
      />
      ms
    </label>
  );
  return (
    <div className="muted mt-2 flex flex-wrap items-center gap-2 text-xs">
      <span>In the video:</span>
      <select
        className="input w-auto py-0.5 text-xs"
        value={v.untilPanelId ?? ""}
        onChange={(e) => onChange({ ...v, untilPanelId: e.target.value || null })}
        aria-label="Spoken until panel"
      >
        <option value="">Over its own shot</option>
        {panels.slice(from + 1).map((p) => (
          <option key={p.id} value={p.id}>
            Until {p.label}
          </option>
        ))}
      </select>
      {ms("Start after", "startOffsetMs")}
      {ms("Hold after", "endOffsetMs")}
    </div>
  );
}

function segmentStatus(s: NarrationSegment) {
  if (s.job && ["queued", "processing"].includes(s.job.status)) return s.job.status;
  if (s.job?.status === "failed" && !s.audio) return "failed";
  if (!s.audio) return "none";
  return s.stale ? "stale" : "ready";
}

function SegmentRow({
  seg,
  isLast,
  voices,
  invalidate,
  active,
  defaults,
}: {
  seg: NarrationSegment;
  isLast: boolean;
  voices: Voice[];
  invalidate: readonly (readonly unknown[])[];
  active: boolean;
  defaults: { voice: string; speed: number };
}) {
  const aiTts = useAiBody("tts");
  const [text, setText] = useState(seg.text);
  const ref = useRef<HTMLTextAreaElement>(null);
  const serverText = useRef(seg.text);
  // Adopt server-side text changes (split/merge) unless the user has unsaved local edits.
  useEffect(() => {
    if (seg.text === serverText.current) return;
    setText((local) => (local === serverText.current ? seg.text : local));
    serverText.current = seg.text;
  }, [seg.text]);
  const { state } = useAutosave(text, async (v) => {
    if (v.trim()) await patch(`/narration-segments/${seg.id}`, { text: v });
  });
  const update = useAction((body: Record<string, unknown>) => patch(`/narration-segments/${seg.id}`, body), {
    invalidate,
  });
  // Same provider/voice the page's narration chip picked: without it a re-synth silently drops back to local TTS.
  const synth = useAction(() => post(`/narration-segments/${seg.id}/synthesize`, aiTts()), { invalidate });
  const split = useAction((at: number) => post(`/narration-segments/${seg.id}/split`, { at }), { invalidate });
  const merge = useAction(() => post(`/narration-segments/${seg.id}/merge-next`), { invalidate });
  const status = segmentStatus(seg);

  return (
    <div
      className={clsx(
        "rounded-lg border p-2 text-sm",
        active ? "border-accent-500 bg-accent-600/10" : "border-[var(--border)]",
      )}
    >
      <textarea
        ref={ref}
        className="w-full resize-y bg-transparent outline-none"
        rows={Math.min(4, Math.ceil(text.length / 90) || 1)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        aria-label="Segment text"
      />
      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
        <StatusChip
          status={status === "stale" ? "queued" : status}
          label={status === "none" ? "no audio" : status === "stale" ? "outdated" : status}
        />
        {seg.job?.status === "failed" && seg.job.failureReason && (
          <span className="text-red-500">{seg.job.failureReason}</span>
        )}
        {seg.audio && <span className="muted">{fmt.ms(seg.audio.durationMs)}</span>}
        <select
          className="input w-auto py-0.5 text-xs"
          value={seg.voice ?? ""}
          onChange={(e) => update.mutate({ voice: e.target.value || null })}
          aria-label="Segment voice"
        >
          <option value="">Voice: default ({defaults.voice})</option>
          {voices.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name} ({v.language})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1">
          Speed
          <input
            type="number"
            className="input w-16 py-0.5 text-xs"
            step={0.05}
            min={0.5}
            max={2}
            placeholder={String(defaults.speed)}
            defaultValue={seg.speed ?? ""}
            onBlur={(e) => update.mutate({ speed: e.target.value ? Number(e.target.value) : null })}
          />
        </label>
        <label className="flex items-center gap-1">
          Pause
          <input
            type="number"
            className="input w-20 py-0.5 text-xs"
            step={50}
            min={0}
            max={10000}
            defaultValue={seg.pauseAfterMs}
            onBlur={(e) =>
              Number(e.target.value) !== seg.pauseAfterMs && update.mutate({ pauseAfterMs: Number(e.target.value) })
            }
          />
          ms
        </label>
        <SaveIndicator state={state} />
        <div className="ml-auto flex gap-1">
          {seg.audio && (
            <button
              type="button"
              className="btn-ghost py-0.5"
              onClick={() => new Audio(assetUrl(seg.audio!.assetId)).play()}
              aria-label="Play segment"
            >
              <Play className="size-3.5" />
            </button>
          )}
          <button
            type="button"
            className="btn-ghost py-0.5"
            disabled={synth.isPending || status === "queued" || status === "processing"}
            onClick={() => synth.mutate()}
            title="Synthesize with Kokoro"
          >
            {seg.audio ? <RefreshCw className="size-3.5" /> : <Wand2 className="size-3.5" />}{" "}
            {seg.audio ? "Regenerate" : "Synthesize"}
          </button>
          <button
            type="button"
            className="btn-ghost py-0.5"
            title="Split at cursor"
            onClick={() => {
              const at = ref.current?.selectionStart ?? 0;
              if (at > 0 && at < text.length) split.mutate(at);
            }}
          >
            <Scissors className="size-3.5" />
          </button>
          {!isLast && (
            <button
              type="button"
              className="btn-ghost py-0.5"
              title="Merge with next segment"
              onClick={() => merge.mutate()}
            >
              <Merge className="size-3.5" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
