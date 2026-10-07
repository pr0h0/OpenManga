import { useQuery } from "@tanstack/react-query";
import { post } from "../../api/client.ts";
import { ErrorBox, fmt, Spinner } from "../../components/ui.tsx";

type Usd = number | null;
type ChapterRow = {
  id: string;
  order: number;
  title: string;
  estimated: boolean;
  panels: number;
  plan: { needed: boolean; usd: Usd };
  prompts: { pages: number; usd: Usd };
  art: { panels: number; usd: Usd; batched: boolean };
  narration: { needed: boolean; usd: Usd };
  audio: { segments: number; seconds: number };
  storageBytes: number;
  usd: Usd;
};
export type CostPlanData = {
  models: { text: { model: string; free?: boolean } | null; image: { model: string } | null };
  project: {
    analysis: { needed: boolean; usd: Usd };
    references: { count: number; estimated: boolean; usd: Usd; batched: boolean };
    thumbnail: { needed: boolean; usd: Usd };
    youtube: { needed: boolean; usd: Usd };
  };
  chapters: ChapterRow[];
  totals: {
    usd: Usd;
    nowUsd: Usd;
    batchedUsd: Usd;
    storageBytes: number;
    panelsToDraw: number;
    estimatedChapters: number;
  };
  budget: { limitUsd: number | null; spentUsd: number; remainingUsd: number | null };
  warnings: string[];
};

const usd = (v: Usd) => (v === null ? "price unknown" : fmt.usd(v));

/**
 * What a production run with these options would still do and cost, before it starts: totals, what runs now and
 * what waits for a half-price batch, the disk it will take, the budget left, and a table per chapter.
 */
export function CostPlan({ projectId, body }: { projectId: string; body: Record<string, unknown> }) {
  const plan = useQuery({
    queryKey: ["cost-plan", projectId, JSON.stringify(body)],
    queryFn: () => post<CostPlanData>(`/projects/${projectId}/production-runs/estimate`, body),
    staleTime: 30_000,
  });
  if (plan.isLoading)
    return (
      <p className="muted flex items-center gap-2 text-xs">
        <Spinner className="size-3" /> Pricing the run…
      </p>
    );
  if (plan.error) return <ErrorBox error={plan.error} onRetry={() => plan.refetch()} />;
  const d = plan.data!;
  const t = d.totals;
  const over = t.usd !== null && d.budget.remainingUsd !== null && t.usd > d.budget.remainingUsd;
  return (
    <section aria-label="Cost plan" className="space-y-2 rounded-lg border border-[var(--border)] p-3">
      <p className="text-sm">
        About <strong>{usd(t.usd)}</strong>
        {t.batchedUsd ? (
          <>
            {" "}
            · {usd(t.nowUsd)} now, {usd(t.batchedUsd)} in a half-price batch (results can take up to a day)
          </>
        ) : null}{" "}
        · {fmt.bytes(t.storageBytes)} of new files · {t.panelsToDraw} panel(s) to draw
      </p>
      <p className={over ? "text-xs text-amber-700 dark:text-amber-300" : "muted text-xs"}>
        Budget:{" "}
        {d.budget.limitUsd === null
          ? "no cap"
          : `${fmt.usd(d.budget.remainingUsd)} left of ${fmt.usd(d.budget.limitUsd)}`}
        {t.estimatedChapters > 0 &&
          ` · ${t.estimatedChapters} chapter(s) not planned yet: their panels are estimated, so the total is too`}
        {d.models.text?.free && " · text answers pasted by you: free"}
      </p>
      {d.warnings.map((w) => (
        <p key={w} className="text-xs text-amber-700 dark:text-amber-300">
          {w}
        </p>
      ))}
      <details>
        <summary className="cursor-pointer text-xs font-medium">By chapter</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[34rem] text-xs">
            <thead className="muted text-left">
              <tr>
                <th className="py-1 pr-2">Chapter</th>
                <th className="py-1 pr-2 text-right">Plan</th>
                <th className="py-1 pr-2 text-right">Prompts</th>
                <th className="py-1 pr-2 text-right">Art</th>
                <th className="py-1 pr-2 text-right">Narration</th>
                <th className="py-1 pr-2 text-right">Audio</th>
                <th className="py-1 text-right">Total</th>
              </tr>
            </thead>
            <tbody>
              {[
                ["Analysis", d.project.analysis.needed, d.project.analysis.usd],
                [
                  `References (${d.project.references.count}${d.project.references.estimated ? ", estimated" : ""})`,
                  d.project.references.count > 0,
                  d.project.references.usd,
                ],
                ["Thumbnail", d.project.thumbnail.needed, d.project.thumbnail.usd],
                ["YouTube text", d.project.youtube.needed, d.project.youtube.usd],
              ]
                .filter(([, needed]) => needed)
                .map(([label, , v]) => (
                  <tr key={String(label)} className="border-t border-[var(--border)]">
                    <td className="py-1 pr-2" colSpan={6}>
                      {label}
                    </td>
                    <td className="py-1 text-right tabular-nums">{usd(v as Usd)}</td>
                  </tr>
                ))}
              {d.chapters.map((c) => (
                <tr key={c.id} className="border-t border-[var(--border)]">
                  <td className="py-1 pr-2">
                    Ch. {c.order} {c.title}
                    {c.estimated && <span className="muted"> · estimated</span>}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">{c.plan.needed ? usd(c.plan.usd) : "—"}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {c.prompts.pages ? `${c.prompts.pages} pg · ${usd(c.prompts.usd)}` : "—"}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {c.art.panels ? `${c.art.panels} · ${usd(c.art.usd)}${c.art.batched ? " (batch)" : ""}` : "—"}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">
                    {c.narration.needed ? usd(c.narration.usd) : "—"}
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums" title="Voiced locally: nothing is spent">
                    {c.audio.segments ? `${Math.round(c.audio.seconds / 60)} min` : "—"}
                  </td>
                  <td className="py-1 text-right font-medium tabular-nums">{usd(c.usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  );
}
