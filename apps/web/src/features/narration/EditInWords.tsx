import type { VideoEditOp } from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Wand2 } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import { Spinner } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";

type Edit = { op: VideoEditOp; label: string; effect: string; changes: number };
type EditJob = {
  job: {
    status: string;
    failureReason: string | null;
    result?: { summary: string; edits: Edit[]; dropped: string[]; appliedAt?: string };
  };
};

/**
 * "Edit the video in words": an instruction becomes a list of timeline edits, each with what it would change. Tick,
 * change or drop them, then apply; nothing changes before that.
 */
export function EditInWords({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const aiText = useAiBody("text");
  const [instruction, setInstruction] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [ops, setOps] = useState<(VideoEditOp | null)[] | null>(null);
  const job = useQuery({
    queryKey: ["video-edit", jobId],
    queryFn: () => get<EditJob>(`/generations/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (q) =>
      ["completed", "failed", "cancelled"].includes(q.state.data?.job.status ?? "") ? false : 2000,
  });
  const result = job.data?.job.status === "completed" ? job.data.job.result : undefined;
  const edits = result?.edits ?? [];
  // The proposal's edits until the user ticks or changes one; null = left out.
  const current = ops ?? edits.map((e) => e.op);
  const propose = useAction(
    () => post<{ job: { id: string } }>(`/projects/${projectId}/video-edits`, { ...aiText(), instruction }),
    {
      success: "Working out the edits",
      onSuccess: (r) => {
        setJobId(r.job.id);
        setOps(null);
      },
    },
  );
  const apply = useAction(
    () =>
      post<{ applied: { label: string }[] }>(`/projects/${projectId}/video-edits/${jobId}/apply`, {
        ops: current.filter((o): o is VideoEditOp => o !== null),
      }),
    {
      success: (r) => `Applied ${r.applied.length} edit(s)`,
      onSuccess: () => {
        setJobId(null);
        setInstruction("");
        void qc.invalidateQueries({ queryKey: ["timing"] });
        void qc.invalidateQueries({ queryKey: ["project", projectId] });
      },
    },
  );
  const set = (i: number, op: VideoEditOp | null) => setOps(current.map((o, k) => (k === i ? op : o)));
  const kept = current.filter(Boolean).length;
  return (
    <section className="card mb-6 space-y-3 p-3" aria-label="Edit in words">
      <div>
        <h2 className="text-sm font-medium">Edit in words</h2>
        <p className="muted text-xs">
          Say what to change: “make chapter 4 faster”, “cut every silence over 900 ms”, “add a title card before chapter
          8”. You get a list of edits with what each would change; nothing changes until you apply it.
        </p>
      </div>
      {!jobId && (
        <div className="flex flex-wrap items-center gap-2">
          <input
            className="input min-w-0 flex-1"
            placeholder="What should change?"
            aria-label="Instruction"
            maxLength={2000}
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && instruction.trim().length >= 3 && propose.mutate()}
          />
          <AiChip cap="text" />
          <button
            type="button"
            className="btn-primary"
            disabled={instruction.trim().length < 3 || propose.isPending}
            onClick={() => propose.mutate()}
          >
            <Wand2 className="size-4" /> Propose edits
          </button>
        </div>
      )}
      {jobId && !result && (
        <p className="muted flex items-center gap-2 text-xs">
          {job.data?.job.status === "failed" ? (
            <span className="text-red-500">It failed: {job.data.job.failureReason}</span>
          ) : (
            <>
              <Spinner /> Working out the edits… ({job.data?.job.status ?? "queued"})
            </>
          )}
          <button type="button" className="btn-ghost text-xs" onClick={() => setJobId(null)}>
            Back
          </button>
        </p>
      )}
      {result && (
        <>
          {result.summary && <p className="text-sm">{result.summary}</p>}
          <ul className="space-y-1 text-sm" aria-label="Proposed edits">
            {edits.map((e, i) => {
              const op = current[i] ?? null;
              return (
                <li key={i} className="flex flex-wrap items-center gap-2 rounded-md border border-[var(--border)] p-2">
                  <input
                    type="checkbox"
                    aria-label={`Apply: ${e.label}`}
                    checked={op !== null}
                    onChange={(ev) => set(i, ev.target.checked ? e.op : null)}
                  />
                  <span className="min-w-0 flex-1">
                    {e.label}
                    <span className="muted text-xs"> · {e.effect}</span>
                  </span>
                  {op && <OpFields op={op} onChange={(next) => set(i, next)} />}
                </li>
              );
            })}
          </ul>
          {!edits.length && <p className="muted text-xs">No edits proposed.</p>}
          {result.dropped.length > 0 && <p className="muted text-xs">Left out: {result.dropped.join("; ")}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={!kept || apply.isPending}
              onClick={() => apply.mutate()}
            >
              Apply {kept} edit(s)
            </button>
            <button type="button" className="btn-ghost" onClick={() => setJobId(null)}>
              Reject
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** The numbers and text of an edit that can be changed before applying it. */
function OpFields({ op, onChange }: { op: VideoEditOp; onChange: (op: VideoEditOp) => void }) {
  const num = (v: string) => (v === "" ? null : Number(v));
  if (op.op === "pauses")
    return (
      <span className="flex items-center gap-1 text-xs">
        at most
        <input
          className="input w-20 py-0.5 text-xs"
          type="number"
          min={0}
          max={10000}
          step={50}
          aria-label="Longest pause (ms)"
          value={op.maxPauseMs ?? ""}
          onChange={(e) => onChange({ ...op, maxPauseMs: num(e.target.value) })}
        />
        ms, ×
        <input
          className="input w-16 py-0.5 text-xs"
          type="number"
          min={0}
          max={4}
          step={0.1}
          aria-label="Pause scale"
          value={op.pauseScale ?? ""}
          onChange={(e) => onChange({ ...op, pauseScale: num(e.target.value) })}
        />
      </span>
    );
  if (op.op === "holds")
    return (
      <span className="flex items-center gap-1 text-xs">
        <input
          className="input w-24 py-0.5 text-xs"
          type="number"
          min={500}
          max={60000}
          step={100}
          placeholder="export's"
          aria-label="Minimum hold (ms)"
          value={op.holdMs ?? ""}
          onChange={(e) => onChange({ ...op, holdMs: num(e.target.value) })}
        />
        ms
      </span>
    );
  if (op.op === "card" && op.card)
    return (
      <input
        className="input w-56 py-0.5 text-xs"
        maxLength={120}
        aria-label="Card title"
        value={op.card.title}
        onChange={(e) => onChange({ ...op, card: { ...op.card!, title: e.target.value } })}
      />
    );
  return null;
}
