import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { get } from "../../api/client.ts";
import { clsx } from "../../components/ui.tsx";
import { ProgressBar } from "../generation/shared.tsx";

type ChapterProgress = {
  id: string;
  title: string;
  order: number;
  lines: number;
  segments: number;
  withAudio: number;
  queued: number;
  processing: number;
  failed: number;
};
type Progress = {
  language: string;
  chapters: ChapterProgress[];
  totals: { chapters: number; segments: number; withAudio: number; queued: number; processing: number; failed: number };
};

const pct = (done: number, total: number) => (total ? Math.round((done / total) * 100) : 0);

/**
 * Synthesis progress for every chapter at once. The narration editor works on one chapter at a time, so a run
 * spanning a whole project was only visible a chapter at a time — with no way to tell whether the rest had
 * finished, stalled or failed.
 */
export function SynthesisProgress({ projectId, language }: { projectId: string; language: string }) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["narration-progress", projectId, language],
    queryFn: () => get<Progress>(`/projects/${projectId}/narration/progress?language=${encodeURIComponent(language)}`),
    // Follows the work: quick while anything is running, idle otherwise.
    refetchInterval: (r) => {
      const t = r.state.data?.totals;
      return t && t.queued + t.processing > 0 ? 10_000 : 30_000;
    },
  });
  const d = q.data;
  if (!d?.totals.segments) return null;
  const t = d.totals;
  const running = t.queued + t.processing;
  const shown = open ? d.chapters : d.chapters.filter((c) => c.queued + c.processing + c.failed > 0);
  return (
    <section className="card mb-3 p-3" aria-label="Narration synthesis progress">
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <h2 className="font-medium">Speech across {t.chapters} chapters</h2>
        <span className="muted text-xs">
          {t.withAudio} / {t.segments} segments
          {running > 0 ? ` · ${t.processing} synthesising, ${t.queued} queued` : ""}
          {t.failed > 0 ? ` · ${t.failed} failed` : ""}
        </span>
        <button type="button" className="btn-ghost ml-auto text-xs" onClick={() => setOpen(!open)}>
          {open ? "Show only active" : "Show all chapters"}
        </button>
      </div>
      <div className="mt-2">
        <ProgressBar value={pct(t.withAudio, t.segments)} label="Segments with audio" />
      </div>
      {shown.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {shown.map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <Link
                to="/projects/$projectId/narration"
                params={{ projectId }}
                search={{ chapterId: c.id }}
                className="w-56 shrink-0 truncate hover:underline"
                title={c.title}
              >
                Ch. {c.order} — {c.title}
              </Link>
              <span className="muted w-20 shrink-0 tabular-nums">
                {c.withAudio}/{c.segments}
              </span>
              <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--panel-2)]">
                <span
                  className={clsx(
                    "block h-full transition-all",
                    c.failed > 0 ? "bg-amber-500" : c.withAudio === c.segments ? "bg-emerald-500" : "bg-accent-500",
                  )}
                  style={{ width: `${pct(c.withAudio, c.segments)}%` }}
                />
              </span>
              <span className="muted w-40 shrink-0 text-right">
                {c.processing > 0 ? `${c.processing} synthesising` : c.queued > 0 ? `${c.queued} queued` : ""}
                {c.failed > 0 ? ` · ${c.failed} failed` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
