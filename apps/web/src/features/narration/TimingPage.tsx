import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Check, Scissors, Timer, Wand2 } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import { clsx, EmptyState, ErrorBox, Field, PageHeader, Spinner } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { PreviewVideoButton } from "../video/VideoPreview.tsx";

type Hold = { key: string; beforeMs: number; afterMs: number };
type Effect = { holds: Hold[]; deltaMs: number };
type Report = {
  chapterId: string;
  settings: { minHoldMs: number; minShotMs: number; maxShotMs: number; stillMs: number; silenceMs: number };
  audio: { segments: number; voiced: number };
  totalMs: number;
  targetMs: number | null;
  shots: {
    key: string;
    label: string;
    panelId: string | null;
    holdMs: number;
    narrationMs: number;
    joinNext: boolean;
    minHoldMs: number | null;
    lines: { id: string; text: string; words: number }[];
  }[];
  issues: { kind: "long" | "flash" | "still" | "silence"; key: string; label: string; ms: number; message: string }[];
  fixes: {
    spread: (Effect & { lineId: string; fromKey: string; untilPanelId: string; shots: number })[];
    holds: (Effect & { panelId: string; key: string; holdMs: number; reason: string })[];
    trim: { lineId: string; text: string; words: number; budget: number }[];
  };
};
type ProjectTiming = {
  chapters: {
    id: string;
    order: number;
    title: string;
    shots: number;
    totalMs: number;
    targetMs: number | null;
    audio: { segments: number; voiced: number };
    issues: Record<"long" | "flash" | "still" | "silence", number>;
  }[];
};
type RetimeJob = {
  job: {
    status: string;
    failureReason: string | null;
    result?: { lines: { lineId: string; text: string; after: string; words: number; afterWords: number }[] };
  };
};

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const signed = (ms: number) => `${ms >= 0 ? "+" : "−"}${sec(Math.abs(ms))}`;
const KIND: Record<Report["issues"][number]["kind"], { label: string; tone: string }> = {
  long: { label: "Long", tone: "bg-amber-500/15 text-amber-700 dark:text-amber-300" },
  still: { label: "Still", tone: "bg-red-500/15 text-red-700 dark:text-red-300" },
  flash: { label: "Flash", tone: "bg-sky-500/15 text-sky-700 dark:text-sky-300" },
  silence: { label: "Dead air", tone: "bg-violet-500/15 text-violet-700 dark:text-violet-300" },
};

/**
 * The timing pass: once a chapter's narration is voiced, its real lengths decide the pacing. The project's chapters
 * against their target, then one chapter's shots, what is off, and fixes that each show their effect before they
 * are applied. Existing art only: nothing here generates an image.
 */
export function TimingPage() {
  const projectId = useProjectId();
  const search = useSearch({ strict: false }) as { chapterId?: string };
  const navigate = useNavigate();
  const project = useQuery({
    queryKey: ["timing", projectId],
    queryFn: () => get<ProjectTiming>(`/projects/${projectId}/timing`),
  });
  const chapterId = search.chapterId ?? project.data?.chapters.find((c) => c.audio.voiced)?.id;
  return (
    <div className="mx-auto max-w-6xl p-4 sm:p-6">
      <PageHeader
        title="Timing"
        subtitle="The real narration lengths against your shot lengths and target runtime. Fixes reuse existing art; nothing new is drawn."
      />
      {project.error && <ErrorBox error={project.error} onRetry={() => project.refetch()} />}
      {project.isLoading && <Spinner />}
      {project.data && !project.data.chapters.length && (
        <EmptyState icon={<Timer className="size-8" />} title="No chapters yet">
          Plan a chapter and voice its narration first.
        </EmptyState>
      )}
      {project.data && project.data.chapters.length > 0 && (
        <div className="overflow-x-auto">
          <table className="mb-6 w-full min-w-[34rem] text-sm">
            <thead className="muted text-left text-xs">
              <tr>
                <th className="py-1 pr-2 font-medium">Chapter</th>
                <th className="py-1 pr-2 font-medium">Length</th>
                <th className="py-1 pr-2 font-medium">Voiced</th>
                <th className="py-1 font-medium">Off</th>
              </tr>
            </thead>
            <tbody>
              {project.data.chapters.map((c) => (
                <tr
                  key={c.id}
                  className={clsx(
                    "cursor-pointer border-t border-[var(--border)] hover:bg-[var(--panel-2)]",
                    c.id === chapterId && "bg-accent-600/10",
                  )}
                  onClick={() => navigate({ to: ".", search: { chapterId: c.id } })}
                >
                  <td className="py-1.5 pr-2">
                    {c.order}. {c.title}
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">
                    {sec(c.totalMs)}
                    {c.targetMs != null && <span className="muted"> / {sec(c.targetMs)}</span>}
                  </td>
                  <td className="py-1.5 pr-2 tabular-nums">
                    {c.audio.voiced}/{c.audio.segments}
                  </td>
                  <td className="py-1.5">
                    <span className="flex flex-wrap gap-1">
                      {(Object.keys(KIND) as (keyof typeof KIND)[])
                        .filter((k) => c.issues[k])
                        .map((k) => (
                          <span key={k} className={clsx("chip", KIND[k].tone)}>
                            {KIND[k].label} {c.issues[k]}
                          </span>
                        ))}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {chapterId && <ChapterTiming projectId={projectId} chapterId={chapterId} />}
    </div>
  );
}

function ChapterTiming({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const [minHold, setMinHold] = useState<number>();
  const key = ["timing", projectId, chapterId, minHold ?? null];
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<Report>(`/chapters/${chapterId}/timing${minHold ? `?minHoldMs=${minHold}` : ""}`),
  });
  const invalidate = [key, ["timing", projectId], ["video-preview"]] as const;
  const apply = useAction((body: Record<string, unknown>) => post(`/chapters/${chapterId}/timing/apply`, body), {
    invalidate,
    success: "Applied",
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const r = q.data!;
  const max = Math.max(1, ...r.shots.map((s) => s.holdMs));
  const flagged = new Set(r.issues.map((i) => i.key));
  return (
    <div className="space-y-4">
      <div className="card flex flex-wrap items-end gap-3 p-4">
        <div className="mr-auto">
          <div className="text-lg font-semibold tabular-nums">
            {sec(r.totalMs)}
            {r.targetMs != null && (
              <span className="muted text-sm font-normal">
                {" "}
                of a {sec(r.targetMs)} target ({signed(r.totalMs - r.targetMs)})
              </span>
            )}
          </div>
          <p className="muted text-xs">
            Shots should hold {sec(r.settings.minShotMs)}–{sec(r.settings.maxShotMs)} (the target runtime's shot
            lengths). {r.audio.voiced}/{r.audio.segments} narration segments voiced; unvoiced ones count as silent.
          </p>
        </div>
        <Field label="Minimum hold (s)">
          <input
            className="input w-28"
            type="number"
            min={0.5}
            max={30}
            step={0.5}
            defaultValue={r.settings.minHoldMs / 1000}
            onBlur={(e) => {
              const v = Math.round(Number(e.target.value) * 1000);
              if (v >= 500 && v !== r.settings.minHoldMs) setMinHold(v);
            }}
          />
        </Field>
        <PreviewVideoButton
          projectId={projectId}
          scope={{ chapterId }}
          title="Preview — timing"
          defaultMinHoldMs={r.settings.minHoldMs}
        />
      </div>

      {/* Every shot's hold as a bar: the shot-length band is the shaded range. */}
      <div className="card space-y-1 p-3">
        <h2 className="text-sm font-medium">Shots</h2>
        <ol className="max-h-80 space-y-0.5 overflow-y-auto text-xs">
          {r.shots.map((s) => (
            <li key={s.key} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate sm:w-56" title={s.label}>
                {s.label}
                {s.joinNext && " ↘"}
              </span>
              <span className="relative h-3 flex-1 rounded bg-[var(--panel-2)]">
                <span
                  className="absolute inset-y-0 bg-emerald-500/15"
                  style={{
                    left: `${(r.settings.minShotMs / max) * 100}%`,
                    width: `${(Math.max(0, Math.min(max, r.settings.maxShotMs) - r.settings.minShotMs) / max) * 100}%`,
                  }}
                />
                <span
                  className={clsx(
                    "absolute inset-y-0.5 left-0 rounded",
                    flagged.has(s.key) ? "bg-amber-500" : "bg-accent-500",
                  )}
                  style={{ width: `${(s.holdMs / max) * 100}%` }}
                />
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">{sec(s.holdMs)}</span>
            </li>
          ))}
        </ol>
      </div>

      {r.issues.length > 0 && (
        <div className="card space-y-1 p-3 text-sm">
          <h2 className="font-medium">What is off</h2>
          <ul className="space-y-0.5 text-xs">
            {r.issues.map((i, k) => (
              <li key={`${i.key}-${i.kind}-${k}`} className="flex flex-wrap items-center gap-2">
                <span className={clsx("chip", KIND[i.kind].tone)}>{KIND[i.kind].label}</span>
                <span className="font-medium">{i.label}</span>
                <span className="muted">{i.message}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <FixList
        title="Spread a long line over the next shots"
        hint="The line keeps playing over the next pictures of its scene, so one picture is not on screen for all of it."
        items={r.fixes.spread.map((f) => ({
          id: f.lineId,
          label: `${r.shots.find((s) => s.key === f.fromKey)?.label} — over ${f.shots} shots`,
          effect: f,
          onApply: () => apply.mutate({ spread: { lineId: f.lineId, untilPanelId: f.untilPanelId } }),
        }))}
        shots={r.shots}
        busy={apply.isPending}
      />
      <FixList
        title="Rebalance holds"
        hint="A shot's own minimum hold, within the shot-length settings and never below its narration."
        items={r.fixes.holds.map((f) => ({
          id: f.panelId,
          label: `${r.shots.find((s) => s.key === f.key)?.label} — ${sec(f.holdMs)}, ${f.reason}`,
          effect: f,
          onApply: () => apply.mutate({ hold: { panelId: f.panelId, holdMs: f.holdMs } }),
        }))}
        shots={r.shots}
        busy={apply.isPending}
      />
      <Retime chapterId={chapterId} report={r} invalidate={invalidate} />
    </div>
  );
}

function FixList({
  title,
  hint,
  items,
  shots,
  busy,
}: {
  title: string;
  hint: string;
  items: { id: string; label: string; effect: Effect; onApply: () => void }[];
  shots: Report["shots"];
  busy: boolean;
}) {
  if (!items.length) return null;
  return (
    <div className="card space-y-2 p-3">
      <div>
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="muted text-xs">{hint}</p>
      </div>
      <ul className="space-y-2 text-xs">
        {items.map((it) => (
          <li key={it.id} className="flex flex-wrap items-start gap-2 rounded-md border border-[var(--border)] p-2">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{it.label}</div>
              {/* The preview of the fix: every hold it changes, and the chapter's new length. */}
              <div className="muted">
                {it.effect.holds
                  .map(
                    (h) =>
                      `${shots.find((s) => s.key === h.key)?.label ?? h.key}: ${sec(h.beforeMs)} → ${sec(h.afterMs)}`,
                  )
                  .join(" · ")}{" "}
                · chapter {signed(it.effect.deltaMs)}
              </div>
            </div>
            <button type="button" className="btn-secondary py-1 text-xs" disabled={busy} onClick={it.onApply}>
              <Check className="size-3.5" /> Apply
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Trim or expand lines toward the target: pick lines and budgets, read the rewrite as a diff, keep what you want. */
function Retime({
  chapterId,
  report,
  invalidate,
}: {
  chapterId: string;
  report: Report;
  invalidate: readonly (readonly unknown[])[];
}) {
  const aiText = useAiBody("text");
  const lines = report.shots.flatMap((s) => s.lines);
  const suggested = new Map(report.fixes.trim.map((t) => [t.lineId, t.budget]));
  const [budgets, setBudgets] = useState<Record<string, number>>({});
  const [picked, setPicked] = useState<Set<string>>(() => new Set(suggested.keys()));
  const [jobId, setJobId] = useState<string | null>(null);
  const [keep, setKeep] = useState<Set<string>>(new Set());
  const job = useQuery({
    queryKey: ["retime", jobId],
    queryFn: () => get<RetimeJob>(`/generations/${jobId}`),
    enabled: Boolean(jobId),
    refetchInterval: (q) =>
      ["completed", "failed", "cancelled"].includes(q.state.data?.job.status ?? "") ? false : 2000,
  });
  const budget = (id: string, words: number) => budgets[id] ?? suggested.get(id) ?? words;
  const start = useAction(
    () =>
      post<{ job: { id: string } }>(`/chapters/${chapterId}/narration/retime`, {
        ...aiText(),
        lines: lines
          .filter((l) => picked.has(l.id))
          .map((l) => ({ lineId: l.id, words: Math.max(3, budget(l.id, l.words)) })),
      }),
    {
      success: "Rewrite queued",
      onSuccess: (r) => {
        setJobId(r.job.id);
        setKeep(new Set());
      },
    },
  );
  const proposals = job.data?.job.result?.lines ?? [];
  const applyRetime = useAction(
    async () => {
      const lineIds = [...keep];
      await post(`/chapters/${chapterId}/narration/retime/${jobId}/apply`, { lineIds });
      // Only these lines are voiced again: their unchanged segments keep their audio.
      await post(`/chapters/${chapterId}/narration/synthesize`, { lineIds, onlyMissing: true });
    },
    {
      invalidate: [...invalidate, qk.narration(chapterId)],
      success: "Applied; the changed lines are being voiced again",
      onSuccess: () => setJobId(null),
    },
  );
  if (!lines.length) return null;
  return (
    <div className="card space-y-3 p-3">
      <div>
        <h2 className="text-sm font-medium">Trim or expand narration</h2>
        <p className="muted text-xs">
          A text job rewrites only the lines you tick, each to its word budget
          {report.targetMs != null ? " (pre-filled to land on the target)" : ""}. You read the rewrite before anything
          changes, and only the lines you keep are voiced again.
        </p>
      </div>
      {!jobId && (
        <>
          <ul className="max-h-72 space-y-1 overflow-y-auto text-xs">
            {lines.map((l) => (
              <li key={l.id} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-1"
                  aria-label="Rewrite this line"
                  checked={picked.has(l.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(l.id);
                    else next.delete(l.id);
                    setPicked(next);
                  }}
                />
                <span className="min-w-0 flex-1">{l.text}</span>
                <span className="muted shrink-0 tabular-nums">{l.words} →</span>
                <input
                  className="input w-16 shrink-0 py-0.5 text-xs"
                  type="number"
                  min={3}
                  max={400}
                  aria-label="Word budget"
                  value={budget(l.id, l.words)}
                  onChange={(e) => setBudgets({ ...budgets, [l.id]: Number(e.target.value) })}
                />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <AiChip cap="text" />
            <button
              type="button"
              className="btn-primary"
              disabled={!picked.size || start.isPending}
              onClick={() => start.mutate()}
            >
              <Scissors className="size-4" /> Rewrite {picked.size} line(s)
            </button>
          </div>
        </>
      )}
      {jobId && job.data?.job.status !== "completed" && (
        <p className="muted flex items-center gap-2 text-xs">
          {job.data?.job.status === "failed" ? (
            <span className="text-red-500">The rewrite failed: {job.data.job.failureReason}</span>
          ) : (
            <>
              <Spinner /> Rewriting… ({job.data?.job.status ?? "queued"})
            </>
          )}
          <button type="button" className="btn-ghost text-xs" onClick={() => setJobId(null)}>
            Back
          </button>
        </p>
      )}
      {jobId && job.data?.job.status === "completed" && (
        <>
          <ul className="space-y-2 text-xs">
            {proposals.map((p) => (
              <li key={p.lineId} className="rounded-md border border-[var(--border)] p-2">
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    className="mt-1"
                    checked={keep.has(p.lineId)}
                    onChange={(e) => {
                      const next = new Set(keep);
                      if (e.target.checked) next.add(p.lineId);
                      else next.delete(p.lineId);
                      setKeep(next);
                    }}
                  />
                  <span className="min-w-0 flex-1 space-y-1">
                    <span className="block text-red-700 line-through decoration-red-500/60 dark:text-red-300">
                      {p.text} <span className="muted no-underline">({p.words})</span>
                    </span>
                    <span className="block text-emerald-700 dark:text-emerald-300">
                      {p.after} <span className="muted">({p.afterWords})</span>
                    </span>
                  </span>
                </label>
              </li>
            ))}
            {!proposals.length && <li className="muted">The model returned no changes.</li>}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={!keep.size || applyRetime.isPending}
              onClick={() => applyRetime.mutate()}
            >
              <Wand2 className="size-4" /> Apply {keep.size} and re-voice
            </button>
            <button type="button" className="btn-ghost" onClick={() => setJobId(null)}>
              Discard
            </button>
          </div>
        </>
      )}
    </div>
  );
}
