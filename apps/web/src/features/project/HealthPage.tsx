import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Accessibility as Accessibility2, AlertTriangle, CheckCircle2, HeartPulse, Info } from "lucide-react";
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
      <Accessibility projectId={projectId} />
    </div>
  );
}

type A11y = {
  altText: { panels: number; written: number; empty: string[] };
  readingOrder: { pageId: string; chapter: number; page: number; panels: number; expected: number[] }[];
  lettering: {
    kind: "contrast" | "size";
    pageId: string;
    chapter: number;
    page: number;
    text: string;
    value: number;
    limit: number;
  }[];
};

/**
 * For readers who use a screen reader or read small: alt text, pages whose panel order differs from where the panels
 * sit, and lettering too faint or too small. Each page links to its editor.
 */
function Accessibility({ projectId }: { projectId: string }) {
  const q = useQuery({
    queryKey: ["project", projectId, "accessibility"],
    queryFn: () => get<A11y>(`/projects/${projectId}/accessibility`),
  });
  if (!q.data) return null;
  const a = q.data;
  const pageLink = (x: { pageId: string; chapter: number; page: number }) => (
    <Link
      to="/projects/$projectId/pages/$pageId"
      params={{ projectId, pageId: x.pageId }}
      className="text-accent-500 hover:underline"
    >
      ch. {x.chapter}, page {x.page}
    </Link>
  );
  return (
    <section className="card space-y-3 p-4" aria-label="Accessibility">
      <h2 className="flex items-center gap-1.5 text-sm font-medium">
        <Accessibility2 className="size-4" /> Accessibility
      </h2>
      <p className="text-sm">
        Alt text: {a.altText.written} of {a.altText.panels} panels written by hand; the rest are described from their
        story beat, dialogue and sound effects (EPUBs and readers use it).
        {a.altText.empty.length > 0 && (
          <span className="text-amber-600"> {a.altText.empty.length} panel(s) have nothing to describe them by.</span>
        )}{" "}
        <a className="text-accent-500 hover:underline" href={`/api/projects/${projectId}/transcript?download=1`}>
          Narration transcript
        </a>
      </p>
      {a.readingOrder.length > 0 && (
        <div className="text-sm">
          <h3 className="font-medium">Reading order</h3>
          <ul className="space-y-0.5">
            {a.readingOrder.map((r) => (
              <li key={r.pageId}>
                {pageLink(r)}: panels are numbered in another order than they sit; a reader goes{" "}
                {r.expected.join(" → ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {a.lettering.length > 0 && (
        <div className="text-sm">
          <h3 className="font-medium">Lettering</h3>
          <ul className="space-y-0.5">
            {a.lettering.slice(0, 50).map((l, i) => (
              <li key={`${l.pageId}-${i}`}>
                {pageLink(l)}: “{l.text.slice(0, 40)}” —{" "}
                {l.kind === "contrast"
                  ? `contrast ${l.value}:1, under ${l.limit}:1`
                  : `text ${(l.value * 100).toFixed(1)}% of the page width, under ${(l.limit * 100).toFixed(1)}%`}
              </li>
            ))}
          </ul>
          {a.lettering.length > 50 && <p className="muted text-xs">and {a.lettering.length - 50} more</p>}
        </div>
      )}
      {!a.readingOrder.length && !a.lettering.length && (
        <p className="muted text-sm">Reading order and lettering contrast and size: nothing to fix.</p>
      )}
    </section>
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
