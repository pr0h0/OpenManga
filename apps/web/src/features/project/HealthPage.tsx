import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AlertTriangle, CheckCircle2, HeartPulse, Info } from "lucide-react";
import { get } from "../../api/client.ts";
import { ErrorBox, fmt, PageHeader, Spinner } from "../../components/ui.tsx";
import { useProjectId } from "./ProjectLayout.tsx";

type Item = {
  key: string;
  label: string;
  count: number;
  severity: "block" | "info";
  link: { to: string; search?: Record<string, string> };
};
type Health = {
  verdict: { ready: boolean; blocking: number };
  items: Item[];
  spend: { usd: number; budgetUsd: number | null };
  disk: { totalBytes: number };
};

const useHealth = (projectId: string) =>
  useQuery({
    queryKey: ["project", projectId, "health"],
    queryFn: () => get<Health>(`/projects/${projectId}/health`),
  });

function Verdict({ h }: { h: Health }) {
  return h.verdict.ready ? (
    <span className="flex items-center gap-1.5 font-medium text-emerald-700 dark:text-emerald-300">
      <CheckCircle2 className="size-4" /> Ready to publish
    </span>
  ) : (
    <span className="flex items-center gap-1.5 font-medium text-amber-700 dark:text-amber-300">
      <AlertTriangle className="size-4" /> {h.verdict.blocking} blocking issue{h.verdict.blocking === 1 ? "" : "s"}
    </span>
  );
}

function ItemLink({ projectId, item }: { projectId: string; item: Item }) {
  return (
    <Link
      // The API names in-app routes; they are the project's own pages.
      to={item.link.to as "/projects/$projectId"}
      params={{ projectId }}
      search={item.link.search as never}
      className="text-accent-500 hover:underline"
    >
      {item.label} →
    </Link>
  );
}

/**
 * Everything that stands between the project and publishing, and everything worth knowing, in one place: each item
 * links to where it is fixed. Blocking items are what an export would ship incomplete or wrong.
 */
export function HealthPage() {
  const projectId = useProjectId();
  const q = useHealth(projectId);
  if (q.isLoading) return <Spinner />;
  if (q.error || !q.data) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  const h = q.data;
  const blocking = h.items.filter((i) => i.severity === "block");
  const info = h.items.filter((i) => i.severity === "info");
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <PageHeader title="Health" subtitle="What stands between this project and publishing, and where to fix it." />
      <div className="card flex flex-wrap items-center gap-x-6 gap-y-2 p-4 text-sm">
        <Verdict h={h} />
        <span className="muted">
          Spend {fmt.usd(h.spend.usd)}
          {h.spend.budgetUsd != null ? ` of ${fmt.usd(h.spend.budgetUsd)} budget` : " (no budget cap)"}
        </span>
        <span className="muted">On disk {fmt.bytes(h.disk.totalBytes)}</span>
      </div>
      {[
        { title: "Blocking", items: blocking, Icon: AlertTriangle, tone: "text-amber-600" },
        { title: "Worth knowing", items: info, Icon: Info, tone: "muted" },
      ].map(
        (g) =>
          g.items.length > 0 && (
            <section key={g.title} className="card space-y-2 p-4">
              <h2 className="text-sm font-medium">{g.title}</h2>
              <ul className="space-y-1.5 text-sm">
                {g.items.map((i) => (
                  <li key={i.key} className="flex items-start gap-2">
                    <g.Icon className={`mt-0.5 size-4 shrink-0 ${g.tone}`} />
                    <ItemLink projectId={projectId} item={i} />
                  </li>
                ))}
              </ul>
            </section>
          ),
      )}
      {!h.items.length && <p className="muted text-sm">Nothing to report: everything is current.</p>}
    </div>
  );
}

/** The overview's compact version: the verdict and the first few blocking items. */
export function HealthCard({ projectId }: { projectId: string }) {
  const q = useHealth(projectId);
  if (!q.data) return null;
  const h = q.data;
  const blocking = h.items.filter((i) => i.severity === "block");
  return (
    <div className="card space-y-2 p-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto flex items-center gap-2 text-sm font-medium">
          <HeartPulse className="size-4" /> Health
        </h3>
        <Link to="/projects/$projectId/health" params={{ projectId }} className="text-accent-500 hover:underline">
          Details →
        </Link>
      </div>
      <div className="text-sm">
        <Verdict h={h} />
      </div>
      {blocking.length > 0 && (
        <ul className="space-y-1">
          {blocking.slice(0, 4).map((i) => (
            <li key={i.key}>
              <ItemLink projectId={projectId} item={i} />
            </li>
          ))}
          {blocking.length > 4 && <li className="muted">and {blocking.length - 4} more</li>}
        </ul>
      )}
    </div>
  );
}
