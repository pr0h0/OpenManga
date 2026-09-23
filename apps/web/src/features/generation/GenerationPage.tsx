import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Cpu, RotateCcw, XCircle } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { JobListItem } from "../../api/types.ts";
import { AssetImage, EmptyState, ErrorBox, fmt, PageHeader, Spinner, StatusChip, toast } from "../../components/ui.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { ActiveBatches } from "./BatchStatus.tsx";
import { JOB_STATUSES, KIND_LABELS, kindLabel, ProgressBar } from "./shared.tsx";

type ListResponse = { jobs: JobListItem[]; counts: Record<string, number> };
const PAGE = 50;

export function GenerationPage() {
  const projectId = useProjectId();
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");

  const q = useInfiniteQuery({
    queryKey: [...qk.generations(projectId), status, kind],
    initialPageParam: "",
    queryFn: ({ pageParam }) => {
      const p = new URLSearchParams({ limit: String(PAGE) });
      if (status) p.set("status", status);
      if (kind) p.set("kind", kind);
      if (pageParam) p.set("before", pageParam);
      return get<ListResponse>(`/projects/${projectId}/generations?${p}`);
    },
    getNextPageParam: (last) => (last.jobs.length === PAGE ? last.jobs.at(-1)!.createdAt : undefined),
    refetchInterval: (query) => {
      const c = query.state.data?.pages[0]?.counts;
      return c && (c.queued ?? 0) + (c.processing ?? 0) > 0 ? 5000 : false;
    },
  });

  const cancel = useAction((id: string) => post<{ result: string }>(`/generations/${id}/cancel`), {
    invalidate: [qk.generations(projectId)],
    success: (r) =>
      r.result === "cancel_requested"
        ? "Cancellation requested; running output will not be activated"
        : "Job cancelled",
  });
  const retry = useAction((id: string) => post(`/generations/${id}/retry`), {
    invalidate: [qk.generations(projectId)],
    success: "Retry queued",
  });

  const counts = q.data?.pages[0]?.counts ?? {};
  const jobs = q.data?.pages.flatMap((p) => p.jobs) ?? [];
  const total =
    (counts.queued ?? 0) +
    (counts.awaiting_input ?? 0) +
    (counts.processing ?? 0) +
    (counts.completed ?? 0) +
    (counts.failed ?? 0) +
    (counts.cancelled ?? 0);
  const done = (counts.completed ?? 0) + (counts.failed ?? 0) + (counts.cancelled ?? 0);

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader title="Generation" subtitle="Every AI call, what it was sent, what it cost." />
      <ActiveBatches projectId={projectId} className="mb-4" />
      <div className="card mb-4 p-4">
        <div className="mb-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
          {(["queued", "processing", "completed", "failed", "cancelled"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className="text-left"
              onClick={() => setStatus(status === s ? "" : s === "cancelled" ? "cancelled,cancel_requested" : s)}
            >
              <div className="muted text-xs capitalize">{s}</div>
              <div className="text-xl font-semibold">{counts[s] ?? 0}</div>
            </button>
          ))}
        </div>
        <ProgressBar value={total ? done / total : 0} label="Jobs finished" />
        <div className="muted mt-1 text-xs">
          {counts.completed ?? 0} / {total} completed · {counts.processing ?? 0} generating · {counts.queued ?? 0}{" "}
          queued
          {(counts.awaiting_input ?? 0) > 0 && (
            <button type="button" className="ml-1 underline" onClick={() => setStatus("awaiting_input")}>
              · {counts.awaiting_input} waiting for your answer
            </button>
          )}
        </div>
      </div>

      <div className="mb-3 flex flex-wrap gap-2">
        <select
          className="input w-auto"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="Filter by status"
        >
          <option value="">All statuses</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        <select
          className="input w-auto"
          value={kind}
          onChange={(e) => setKind(e.target.value)}
          aria-label="Filter by kind"
        >
          <option value="">All kinds</option>
          {Object.entries(KIND_LABELS).map(([k, l]) => (
            <option key={k} value={k}>
              {l}
            </option>
          ))}
        </select>
      </div>

      {q.error && <ErrorBox error={q.error} onRetry={() => q.refetch()} />}
      {q.isLoading ? (
        <Spinner />
      ) : !jobs.length ? (
        <EmptyState icon={<Cpu className="size-8" />} title="No generation jobs">
          Jobs appear here when you analyze stories, generate references, panels, edits or narration text.
        </EmptyState>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="muted text-left text-xs">
              <tr className="border-b border-[var(--border)]">
                <th className="p-2">Output</th>
                <th className="p-2">Kind</th>
                <th className="p-2">Status</th>
                <th className="p-2">Attempts</th>
                <th className="p-2">Cost</th>
                <th className="p-2">Latency</th>
                <th className="p-2">Created</th>
                <th className="p-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id} className="border-b border-[var(--border)] align-top last:border-0">
                  <td className="p-2">
                    {j.outputAssetId ? (
                      <AssetImage
                        assetId={j.outputAssetId}
                        alt={`${kindLabel(j.kind)} output`}
                        className="size-12 rounded"
                      />
                    ) : (
                      <div className="size-12 rounded bg-[var(--panel-2)]" />
                    )}
                  </td>
                  <td className="p-2">
                    <Link
                      to="/projects/$projectId/generation/$jobId"
                      params={{ projectId, jobId: j.id }}
                      className="font-medium hover:underline"
                    >
                      {kindLabel(j.kind)}
                    </Link>
                    <div className="muted text-xs">
                      {j.targetType ?? "—"} {j.targetId ? `· ${j.targetId.slice(0, 8)}` : ""} ·{" "}
                      {j.model ?? j.provider ?? ""}
                    </div>
                    {j.failureReason && <div className="mt-1 max-w-md text-xs text-red-500">{j.failureReason}</div>}
                  </td>
                  <td className="p-2">
                    <StatusChip status={j.status} />
                  </td>
                  <td className="p-2">
                    {j.attempts}/{j.maxAttempts}
                  </td>
                  <td className="p-2">{fmt.usd(j.costUsd)}</td>
                  <td className="p-2">{j.latencyMs ? fmt.ms(j.latencyMs) : "—"}</td>
                  <td className="muted p-2 text-xs" title={fmt.date(j.createdAt)}>
                    {fmt.ago(j.createdAt)}
                  </td>
                  <td className="p-2 text-right">
                    <div className="flex justify-end gap-1">
                      {(j.status === "queued" || j.status === "processing") && (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={cancel.isPending}
                          onClick={() => cancel.mutate(j.id)}
                          aria-label="Cancel job"
                        >
                          <XCircle className="size-4" /> Cancel
                        </button>
                      )}
                      {(j.status === "failed" || j.status === "cancelled") && (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={retry.isPending}
                          onClick={() => retry.mutate(j.id)}
                          aria-label="Retry job"
                        >
                          <RotateCcw className="size-4" /> Retry
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <div className="mt-3 text-center">
          <button
            type="button"
            className="btn-secondary"
            disabled={q.isFetchingNextPage}
            onClick={() => q.fetchNextPage().catch(toast.error)}
          >
            {q.isFetchingNextPage && <Spinner />} Load more
          </button>
        </div>
      )}
    </div>
  );
}
