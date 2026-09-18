import type { ImageDescription } from "@openmanga/schemas";
import { useQuery } from "@tanstack/react-query";
import { History, Loader2, Trash2 } from "lucide-react";
import { useState } from "react";
import { assetUrl, del, get } from "../../api/client.ts";
import { clsx, EmptyState, ErrorBox, fmt, Spinner, toast } from "../../components/ui.tsx";

type Row = {
  id: string;
  projectId: string;
  projectTitle: string;
  status: string;
  createdAt: string;
  assetId: string | null;
  aspects: string[];
  custom: string;
  note: string;
  description: ImageDescription | null;
};

/**
 * Past descriptions, with the image they were read from. Cross-project by default: a style taken from one
 * reference is worth applying in another project, and describing it again would cost a second time for an answer
 * that is already stored.
 */
export function DescribeHistory({ projectId, onReuse }: { projectId: string; onReuse: (row: Row) => void }) {
  const [scope, setScope] = useState<"all" | "project">("all");
  const [removing, setRemoving] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["image-descriptions", scope, scope === "project" ? projectId : "all"],
    queryFn: () =>
      get<{ descriptions: Row[] }>(
        scope === "project" ? `/image-descriptions?scope=project&projectId=${projectId}` : "/image-descriptions",
      ),
    staleTime: 30_000,
  });

  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  const rows = (q.data?.descriptions ?? []).filter((r) => r.description);

  return (
    <section className="space-y-3">
      <header className="flex items-center gap-2">
        <History className="size-4" />
        <h2 className="font-medium">Earlier descriptions</h2>
        <div className="ml-auto flex overflow-hidden rounded-lg border border-[var(--border)] text-xs">
          {(["all", "project"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setScope(s)}
              className={clsx("px-2 py-1", scope === s ? "bg-accent-600 text-white" : "hover:bg-[var(--panel-2)]")}
            >
              {s === "all" ? "All projects" : "This project"}
            </button>
          ))}
        </div>
      </header>

      {!rows.length ? (
        <EmptyState title="Nothing described yet">
          Descriptions are kept here with the image they came from, so you can apply one again — including in another
          project — without paying to read it twice.
        </EmptyState>
      ) : (
        <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <li key={r.id}>
              <div className="card group relative flex items-start gap-3 p-2">
                <button type="button" onClick={() => onReuse(r)} className="flex w-full items-start gap-3 text-left">
                  {r.assetId ? (
                    <img
                      src={assetUrl(r.assetId, "thumbnail")}
                      alt=""
                      className="size-16 shrink-0 rounded object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <span className="flex size-16 shrink-0 items-center justify-center rounded bg-[var(--panel-2)]">
                      <Loader2 className="size-4" />
                    </span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{r.description?.overview || r.note || "Description"}</span>
                    <span className="muted block text-xs">
                      {r.aspects.join(", ") || "overview"}
                      {r.custom ? " · custom question" : ""}
                    </span>
                    <span className="muted block text-xs">
                      {r.projectId !== projectId && <strong className="text-[var(--fg)]">{r.projectTitle} · </strong>}
                      {fmt.ago(r.createdAt)}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  aria-label="Delete this description"
                  title="Delete this description and the image it was read from"
                  className="btn-ghost absolute top-1 right-1 p-1 text-red-500 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  disabled={removing === r.id}
                  onClick={async () => {
                    if (!window.confirm("Delete this description and the image it was read from?")) return;
                    setRemoving(r.id);
                    try {
                      await del(`/image-descriptions/${r.id}`);
                      await q.refetch();
                    } catch (e) {
                      toast.error(e);
                    } finally {
                      setRemoving(null);
                    }
                  }}
                >
                  {removing === r.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export type DescribeHistoryRow = Row;
