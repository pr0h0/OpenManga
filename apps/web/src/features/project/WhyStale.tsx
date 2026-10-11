import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { get } from "../../api/client.ts";
import { Spinner } from "../../components/ui.tsx";

type WhyItem = {
  label: string;
  why: string;
  redo: string;
  chapterId?: string;
  pageId?: string;
  panelId?: string;
};
type WhyStage = { key: string; items: WhyItem[]; more: number };

/**
 * Behind one stage of the staleness chips: each chapter, page or panel it counts, what changed under it, and what
 * an update would redo. Shares the staleness query prefix, so a decision anywhere refreshes it.
 */
export function WhyStale({ projectId, stage, label }: { projectId: string; stage: string; label: string }) {
  const q = useQuery({
    queryKey: ["project", projectId, "staleness", "why"],
    queryFn: () => get<{ stages: WhyStage[] }>(`/projects/${projectId}/staleness/why`),
  });
  const s = q.data?.stages.find((x) => x.key === stage);
  return (
    <section
      className="rounded-md border border-[var(--border)] p-3 text-xs"
      aria-label={`Why ${label} is out of date`}
    >
      {q.isLoading && <Spinner />}
      {s && !s.items.length && <p className="muted">Up to date.</p>}
      {s && s.items.length > 0 && (
        <ul className="space-y-2">
          {s.items.map((it) => (
            <li key={`${it.label}-${it.panelId ?? it.chapterId ?? ""}-${it.why}`}>
              <div className="font-medium">
                {it.pageId ? (
                  <Link
                    to="/projects/$projectId/pages/$pageId"
                    params={{ projectId, pageId: it.pageId }}
                    search={it.panelId ? { panelId: it.panelId } : {}}
                    className="underline"
                  >
                    {it.label}
                  </Link>
                ) : it.chapterId ? (
                  <Link
                    to="/projects/$projectId/chapters/$chapterId"
                    params={{ projectId, chapterId: it.chapterId }}
                    hash={stage === "plan" ? "source" : undefined}
                    className="underline"
                  >
                    {it.label}
                  </Link>
                ) : stage === "story" ? (
                  <Link to="/projects/$projectId/story" params={{ projectId }} className="underline">
                    {it.label}
                  </Link>
                ) : (
                  it.label
                )}
              </div>
              <div>{it.why}</div>
              <div className="muted">Update: {it.redo}</div>
            </li>
          ))}
          {s.more > 0 && <li className="muted">and {s.more} more</li>}
        </ul>
      )}
    </section>
  );
}
