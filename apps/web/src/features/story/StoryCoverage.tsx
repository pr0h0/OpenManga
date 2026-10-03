import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ScanSearch } from "lucide-react";
import { get, post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import { clsx, fmt, Spinner } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";

type Finding = {
  kind: "left_out" | "repeated" | "more_room" | "less_room";
  severity: "low" | "medium" | "high";
  spans: { start: number; end: number; paragraphs: string[]; excerpt: string }[];
  chapterIds: string[];
  sceneIds: string[];
  message: string;
};
type Coverage = {
  report: {
    jobId: string;
    storyRevisionId: string;
    finishedAt: string;
    revisionNumber: number;
    parts: number;
    findings: Finding[];
    shares: { chapterId: string; sourceShare: number; panelShare: number; narrationShare: number }[];
    paragraphs: unknown[];
  } | null;
  stale: { story: boolean; plan: boolean } | null;
  running: { id: string; status: string } | null;
  chapters: { id: string; order: number; title: string }[];
  scenes: { id: string; chapterId: string; title: string }[];
};

const KIND: Record<Finding["kind"], string> = {
  left_out: "Left out",
  repeated: "Told twice",
  more_room: "More room than its weight",
  less_room: "Less room than its weight",
};
const SEVERITY: Record<string, string> = {
  high: "bg-red-500/15 text-red-700 dark:text-red-300",
  medium: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  low: "bg-slate-500/15 text-slate-700 dark:text-slate-300",
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * Story coverage on the Story page: which parts of the source the plan left out, told twice, or gave far more or less
 * room than their weight, each linked to its source span and to the chapter that tells it.
 */
export function StoryCoverage({
  projectId,
  onShowSpan,
}: {
  projectId: string;
  /** Selects the span in the story text (the report's revision). */
  onShowSpan: (revisionId: string, start: number, end: number) => void;
}) {
  const aiText = useAiBody("text");
  const q = useQuery({
    queryKey: ["story-coverage", projectId],
    queryFn: () => get<Coverage>(`/projects/${projectId}/story/coverage`),
    refetchInterval: (s) => (s.state.data?.running ? 4000 : false),
  });
  const run = useAction(() => post(`/projects/${projectId}/story/coverage`, aiText()), {
    invalidate: [["story-coverage", projectId]],
    success: "Coverage check queued; a paste-mode check asks one question per part of the story",
  });
  const data = q.data;
  const r = data?.report;
  const chapter = new Map((data?.chapters ?? []).map((c) => [c.id, c]));
  const scene = new Map((data?.scenes ?? []).map((s) => [s.id, s]));
  const counts = (r?.findings ?? []).reduce<Record<string, number>>((m, f) => {
    m[f.kind] = (m[f.kind] ?? 0) + 1;
    return m;
  }, {});
  return (
    <section className="mt-8">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-lg font-semibold">Story coverage</h2>
        <AiChip cap="text" />
        <button
          type="button"
          className="btn-secondary"
          disabled={run.isPending || Boolean(data?.running)}
          onClick={() => run.mutate()}
          title="Map every paragraph of the applied story to the chapters and scenes that tell it"
        >
          {data?.running ? <Spinner /> : <ScanSearch className="size-4" />} Check coverage
        </button>
      </div>
      {data?.running && (
        <p className="muted mb-3 text-sm">
          A check is {data.running.status.replace("_", " ")}.{" "}
          <Link
            to="/projects/$projectId/generation/$jobId"
            params={{ projectId, jobId: data.running.id }}
            className="underline"
          >
            Open the job
          </Link>
        </p>
      )}
      {!r ? (
        <p className="muted text-sm">
          Compares the applied story with the plan: paragraphs left out, told twice, or given far more or less room than
          their weight. Most useful for long recaps.
        </p>
      ) : (
        <div className="space-y-4">
          <p className="muted text-sm">
            Revision {r.revisionNumber}, {fmt.num(r.paragraphs.length)} paragraphs in {r.parts} part(s), checked{" "}
            {fmt.ago(r.finishedAt)}.
            {data?.stale?.story && <span className="text-amber-600"> The story was revised since.</span>}
            {data?.stale?.plan && <span className="text-amber-600"> The plan changed since.</span>}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(KIND) as Finding["kind"][]).map((k) => (
              <span key={k} className="chip">
                {KIND[k]} · {counts[k] ?? 0}
              </span>
            ))}
          </div>
          <div className="card overflow-x-auto p-0">
            <table className="w-full min-w-[28rem] text-sm">
              <thead className="muted text-left text-xs">
                <tr>
                  <th className="p-2">Chapter</th>
                  <th className="p-2 text-right">Story weight</th>
                  <th className="p-2 text-right">Panels</th>
                  <th className="p-2 text-right">Narration</th>
                </tr>
              </thead>
              <tbody>
                {r.shares.map((s) => {
                  const ratio = s.sourceShare ? s.panelShare / s.sourceShare : null;
                  const off = ratio !== null && (ratio >= 2.5 || ratio <= 0.4);
                  return (
                    <tr key={s.chapterId} className="border-t border-[var(--border)]">
                      <td className="p-2">
                        {chapter.get(s.chapterId)
                          ? `Ch. ${chapter.get(s.chapterId)!.order} — ${chapter.get(s.chapterId)!.title}`
                          : "Deleted chapter"}
                      </td>
                      <td className="p-2 text-right tabular-nums">{pct(s.sourceShare)}</td>
                      <td className={clsx("p-2 text-right tabular-nums", off && "text-amber-600")}>
                        {pct(s.panelShare)}
                      </td>
                      <td className="p-2 text-right tabular-nums">{pct(s.narrationShare)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="muted text-xs">
            Story weight is each paragraph's importance times its length.{" "}
            {pct(Math.max(0, 1 - r.shares.reduce((n, s) => n + s.sourceShare, 0)))} of it is told in no chapter.
          </p>
          {!r.findings.length ? (
            <p className="text-sm">Nothing left out, repeated or far off its weight.</p>
          ) : (
            <ul className="space-y-2">
              {r.findings.map((f, i) => (
                <li key={`${f.kind}-${i}`} className="card space-y-1.5 p-3">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="font-medium">{KIND[f.kind]}</span>
                    <span className={clsx("chip", SEVERITY[f.severity])}>{f.severity}</span>
                    {f.chapterIds.map((id) => (
                      <Link
                        key={id}
                        to="/projects/$projectId/chapters/$chapterId"
                        params={{ projectId, chapterId: id }}
                        className="muted text-xs underline"
                      >
                        Ch. {chapter.get(id)?.order ?? "?"} {chapter.get(id)?.title ?? ""}
                      </Link>
                    ))}
                    {f.sceneIds.map((id) => (
                      <span key={id} className="muted text-xs">
                        · scene “{scene.get(id)?.title ?? "deleted"}”
                      </span>
                    ))}
                  </div>
                  <p className="text-sm">{f.message}</p>
                  {f.spans.map((s) => (
                    <div key={`${s.start}-${s.end}`} className="flex flex-wrap items-start gap-2">
                      <blockquote className="muted min-w-0 flex-1 border-l-2 border-[var(--border)] pl-2 text-xs">
                        {s.excerpt}
                        {s.end - s.start > s.excerpt.length && "…"}
                      </blockquote>
                      <button
                        type="button"
                        className="btn-ghost shrink-0 text-xs"
                        title={`Characters ${s.start}–${s.end} (${s.paragraphs.join(", ")})`}
                        onClick={() => onShowSpan(r.storyRevisionId, s.start, s.end)}
                      >
                        Show in story
                      </button>
                    </div>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
