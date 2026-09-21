import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ChevronDown, ChevronUp, Clock, Loader2, Pause, Play, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { create } from "zustand";
import { get, post } from "../../api/client.ts";
import { qk } from "../../api/hooks.ts";
import { clsx, Spinner, toast } from "../../components/ui.tsx";

export type BatchInfo = {
  batchId: string;
  createdAt: string;
  finishedAt: string | null;
  state: "queued" | "running" | "submitted" | "paused" | "finished";
  pauseReason?: string | null;
  progress: {
    total: number;
    completed: number;
    generating: number;
    queued: number;
    /** Handed to the provider's batch API; it returns them together, so there is no per-panel progress. */
    submitted?: number;
    failed: number;
    cancelled: number;
    paused?: number;
  };
  queuedAhead: number;
  /** The provider answered and the worker is storing the results; they land together when it finishes. */
  ingesting?: boolean;
  /** Whether this batch has been checked at the provider at least once. */
  polledAtLeastOnce?: boolean;
  chapters: { id: string; title: string; order: number }[];
  pageIds: string[];
  pageOrders: number[];
};
type BatchesResponse = { batches: BatchInfo[]; imageQueue: { queued: number; generating: number } };

export const batchesKey = (projectId: string) => [...qk.generations(projectId), "batches"] as const;

/** Server-backed batch state: survives navigation and reloads. Project SSE events invalidate the key. */
export function useProjectBatches(projectId: string) {
  return useQuery({
    queryKey: batchesKey(projectId),
    queryFn: () => get<BatchesResponse>(`/projects/${projectId}/generations/batches`),
    refetchInterval: (q) => (q.state.data?.batches.some((b) => b.state !== "finished") ? 4000 : 30_000),
  });
}

export function useInvalidateBatches(projectId: string) {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: batchesKey(projectId) });
}

const useDismissed = create<{ ids: Set<string>; dismiss: (id: string) => void }>((set) => ({
  ids: new Set(),
  dismiss: (id) => set((s) => ({ ids: new Set([...s.ids, id]) })),
}));

function scopeLabel(b: BatchInfo) {
  const ch = b.chapters.map((c) => `Ch. ${c.order} ${c.title}`).join(", ") || "Panels";
  if (b.pageOrders.length === 1) return `${ch} · page ${b.pageOrders[0]}`;
  return `${ch} · ${b.pageOrders.length} pages`;
}

function statusLine(b: BatchInfo) {
  const p = b.progress;
  if (b.state === "queued")
    return b.queuedAhead > 0
      ? `Queued — waiting for ${b.queuedAhead} image${b.queuedAhead === 1 ? "" : "s"} ahead`
      : "Queued — starting shortly";
  if (b.state === "running") return `Generating — ${p.generating} in progress`;
  if (b.state === "submitted") return `Sent as a provider batch — ${p.submitted ?? 0} waiting, results arrive together`;
  if (b.state === "paused") return b.pauseReason ?? "Paused";
  return p.failed ? `Finished with ${p.failed} failed` : "Finished";
}

export function BatchCard({ projectId, batch, compact }: { projectId: string; batch: BatchInfo; compact?: boolean }) {
  const invalidate = useInvalidateBatches(projectId);
  const dismiss = useDismissed((s) => s.dismiss);
  const [cancelling, setCancelling] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [polling, setPolling] = useState(false);
  const p = batch.progress;
  const act = async (action: "pause" | "resume") => {
    setToggling(true);
    try {
      const r = await post<{ paused?: number; resumed?: number }>(`/generations/batches/${batch.batchId}/${action}`);
      toast.success(action === "pause" ? `Paused ${r.paused ?? 0} job(s)` : `Resumed ${r.resumed ?? 0} job(s)`);
      await invalidate();
    } catch (e) {
      toast.error(e);
    } finally {
      setToggling(false);
    }
  };
  const done = p.completed + p.failed + p.cancelled;
  const pct = p.total ? (done / p.total) * 100 : 0;
  return (
    <div
      className={clsx("rounded-lg border border-[var(--border)] bg-[var(--panel)]", compact ? "p-2" : "p-3")}
      role="status"
    >
      <div className="flex items-start gap-2 text-sm">
        {batch.state === "paused" ? (
          <Pause className="mt-0.5 size-4 shrink-0 text-amber-500" />
        ) : batch.state === "queued" ? (
          <Clock className="mt-0.5 size-4 shrink-0 text-amber-500" />
        ) : batch.state === "running" || batch.state === "submitted" ? (
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-sky-500" />
        ) : (
          <span className={clsx("mt-1.5 size-2 shrink-0 rounded-full", p.failed ? "bg-red-500" : "bg-emerald-500")} />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate font-medium" title={scopeLabel(batch)}>
            {scopeLabel(batch)}
          </div>
          <div className="muted text-xs">{statusLine(batch)}</div>
        </div>
        {batch.state === "paused" && (
          <button
            type="button"
            className="btn-primary px-2 py-1 text-xs"
            disabled={toggling}
            onClick={() => act("resume")}
          >
            {toggling ? <Spinner className="size-3" /> : <Play className="size-3" />} Resume
          </button>
        )}
        {(p.submitted ?? 0) > 0 && (
          // Results sit at the provider until the scheduled sweep picks them up, which can be minutes after they
          // are ready. This asks for that sweep now.
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            disabled={polling}
            aria-label="Check the provider for results now"
            title="Check the provider for finished results now. Downloading a large batch takes a minute or two."
            onClick={async () => {
              setPolling(true);
              try {
                const r = await post<{ queued: boolean; outstanding: number }>(
                  `/generations/batches/${batch.batchId}/poll`,
                );
                // The check runs in the worker and finishes long after this request does — ingesting 100 images
                // measured 72s. Saying only "checking" made a working poll look like it had done nothing, and a
                // second press during that window looked like a no-op. The count says which case you are in.
                toast.success(
                  r.outstanding === 0
                    ? "Nothing is waiting at the provider for this batch"
                    : `Checking ${r.outstanding} batch${r.outstanding === 1 ? "" : "es"} at the provider — panels appear as they are downloaded, which takes a minute or two for a large one`,
                );
                await invalidate();
              } catch (e) {
                toast.error(e);
              } finally {
                setPolling(false);
              }
            }}
          >
            {polling ? <Spinner className="size-3" /> : <RefreshCw className="size-3" />}
          </button>
        )}
        {(batch.state === "queued" || batch.state === "running") && (p.queued ?? 0) > 0 && (
          <button
            type="button"
            className="btn-ghost px-2 py-1 text-xs"
            disabled={toggling}
            onClick={() => act("pause")}
            aria-label="Pause batch"
          >
            {toggling ? <Spinner className="size-3" /> : <Pause className="size-3" />}
          </button>
        )}
        {batch.state !== "finished" ? (
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            disabled={cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                const r = await post<{ cancelled: number }>(`/generations/batches/${batch.batchId}/cancel`);
                toast.success(`Cancelled ${r.cancelled} job(s)`);
                await invalidate();
              } catch (e) {
                toast.error(e);
              } finally {
                setCancelling(false);
              }
            }}
          >
            {cancelling ? <Spinner className="size-3" /> : "Cancel"}
          </button>
        ) : (
          <button type="button" className="btn-ghost p-1" aria-label="Dismiss" onClick={() => dismiss(batch.batchId)}>
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-[var(--panel-2)]">
        <div
          className={clsx(
            "h-full transition-all",
            batch.state === "queued" || batch.state === "paused" ? "bg-amber-500" : "bg-accent-500",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="muted mt-1 flex flex-wrap justify-between gap-x-2 text-xs">
        <span>
          {p.completed} / {p.total} completed · {p.generating} generating · {p.queued} queued
          {p.submitted ? ` · ${p.submitted} in provider batch` : ""}
          {p.failed ? ` · ${p.failed} failed` : ""}
          {p.cancelled ? ` · ${p.cancelled} cancelled` : ""}
          {p.paused ? ` · ${p.paused} paused` : ""}
        </span>
        {!compact && (
          <Link to="/projects/$projectId/generation" params={{ projectId }} className="hover:underline">
            Details
          </Link>
        )}
      </div>
    </div>
  );
}

/** Batches filtered to a chapter or page (or all). Finished batches linger 15 minutes unless dismissed. */
export function ActiveBatches({
  projectId,
  chapterId,
  pageId,
  compact,
  className,
}: {
  projectId: string;
  chapterId?: string;
  pageId?: string;
  compact?: boolean;
  className?: string;
}) {
  const { data } = useProjectBatches(projectId);
  const dismissed = useDismissed((s) => s.ids);
  const list = (data?.batches ?? []).filter(
    (b) =>
      !dismissed.has(b.batchId) &&
      (!chapterId || b.chapters.some((c) => c.id === chapterId)) &&
      (!pageId || b.pageIds.includes(pageId)),
  );
  if (!list.length) return null;
  return (
    <div className={clsx("space-y-2", className)}>
      {list.map((b) => (
        <BatchCard key={b.batchId} projectId={projectId} batch={b} compact={compact} />
      ))}
    </div>
  );
}

/** Compact state chip for a chapter row. */
export function ChapterBatchChip({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const { data } = useProjectBatches(projectId);
  const active = (data?.batches ?? []).filter(
    (b) => b.state !== "finished" && b.chapters.some((c) => c.id === chapterId),
  );
  if (!active.length) return null;
  const running = active.find((b) => b.state === "running");
  const queued = active.reduce((s, b) => s + b.progress.queued, 0);
  const done = active.reduce((s, b) => s + b.progress.completed, 0);
  const total = active.reduce((s, b) => s + b.progress.total, 0);
  return running ? (
    <span className="chip bg-sky-500/15 text-sky-600 dark:text-sky-300">
      <Loader2 className="size-3 animate-spin" /> Generating {done}/{total}
    </span>
  ) : (
    <span className="chip bg-amber-500/15 text-amber-700 dark:text-amber-300">
      <Clock className="size-3" /> Queued · {queued} images
      {active[0]!.queuedAhead ? ` · ${active[0]!.queuedAhead} ahead` : ""}
    </span>
  );
}

/** Floating indicator shown on every project screen while batches are active. */
export function FloatingBatches({ projectId }: { projectId: string }) {
  const { data } = useProjectBatches(projectId);
  const dismissed = useDismissed((s) => s.ids);
  const [open, setOpen] = useState(false);
  const list = (data?.batches ?? []).filter((b) => !dismissed.has(b.batchId));
  const active = list.filter((b) => b.state !== "finished");
  if (!list.length) return null;
  const total = active.reduce((s, b) => s + b.progress.total, 0);
  const done = active.reduce((s, b) => s + b.progress.completed + b.progress.failed + b.progress.cancelled, 0);
  const queuedBatches = active.filter((b) => b.state === "queued").length;
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-40 w-[min(30rem,92vw)] -translate-x-1/2">
      <div className="card pointer-events-auto shadow-xl">
        <button
          type="button"
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {active.length ? (
            <Loader2 className="size-4 animate-spin text-sky-500" />
          ) : (
            <span className="size-2 rounded-full bg-emerald-500" />
          )}
          <span className="flex-1">
            {active.length
              ? `${active.length} batch${active.length === 1 ? "" : "es"} · ${done}/${total} images${queuedBatches ? ` · ${queuedBatches} waiting` : ""}`
              : `${list.length} batch${list.length === 1 ? "" : "es"} finished`}
          </span>
          {open ? <ChevronDown className="size-4" /> : <ChevronUp className="size-4" />}
        </button>
        {open && (
          <div className="max-h-80 space-y-2 overflow-y-auto border-t border-[var(--border)] p-2">
            {list.map((b) => (
              <BatchCard key={b.batchId} projectId={projectId} batch={b} compact />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
