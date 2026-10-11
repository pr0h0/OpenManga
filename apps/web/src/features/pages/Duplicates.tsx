import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Copy } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import { AssetImage, Modal, Spinner, StatusChip } from "../../components/ui.tsx";

type Member = {
  assetId: string;
  panelId?: string;
  pageId?: string;
  chapter?: number;
  chapterTitle?: string;
  page?: number;
  panel?: number;
};
type Scan = {
  id: string;
  status: string;
  failureReason: string | null;
  result: { scannedAt: string; panels: number; groups: { kind: string; score: number; members: Member[] }[] } | null;
};

const KIND: Record<string, string> = {
  identical: "Near-identical panels",
  pose: "Same staging (pose) in panels far apart",
  background: "Same background in different scenes",
  thumbnail: "Near-identical cover or thumbnail art",
};

/** Near-duplicate finder: scan the project without AI and look through the groups it found. */
export function DuplicatesButton({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const key = ["project", projectId, "duplicates"];
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<{ scan: Scan | null }>(`/projects/${projectId}/duplicates`),
    select: (r) => r.scan,
    enabled: open,
    refetchInterval: (r) =>
      r.state.data?.scan && !["completed", "failed", "cancelled"].includes(r.state.data.scan.status) ? 3000 : false,
  });
  const scan = useAction(() => post(`/projects/${projectId}/duplicates/scan`), {
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  });
  const s = q.data;
  return (
    <>
      <button type="button" className="btn-secondary" onClick={() => setOpen(true)}>
        <Copy className="size-4" /> Near-duplicates
      </button>
      <Modal
        open={open}
        wide
        onClose={() => setOpen(false)}
        title="Near-duplicates"
        footer={
          <button type="button" className="btn-primary" disabled={scan.isPending} onClick={() => scan.mutate()}>
            {s ? "Scan again" : "Scan the project"}
          </button>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="muted text-xs">
            Compares every drawn panel and the cover and thumbnail art by small image features, without AI: repeats you
            may want to redraw or vary. Neighbouring panels and backgrounds inside one scene are expected to match and
            are left out.
          </p>
          {q.isLoading && <Spinner />}
          {s && !s.result && (
            <div className="flex items-center gap-2">
              <StatusChip status={s.status} /> {s.failureReason && <span className="muted">{s.failureReason}</span>}
            </div>
          )}
          {s?.result && (
            <>
              <p className="text-xs">
                {s.result.panels} panels scanned · {s.result.groups.length} group
                {s.result.groups.length === 1 ? "" : "s"} found
              </p>
              {!s.result.groups.length && <p className="muted">Nothing repeats.</p>}
              <ul className="space-y-3">
                {s.result.groups.map((g, i) => (
                  <li key={`${g.kind}-${i}`} className="rounded-lg border border-[var(--border)] p-2">
                    <div className="mb-1 text-xs font-medium">
                      {KIND[g.kind] ?? g.kind} <span className="muted">· {Math.round(g.score * 100)}%</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {g.members.map((m) => (
                        <figure key={m.assetId + (m.panelId ?? "")} className="w-28 text-[10px]">
                          <AssetImage assetId={m.assetId} alt="" className="aspect-square w-full rounded" fit="cover" />
                          <figcaption className="mt-0.5 truncate">
                            {m.pageId ? (
                              <Link
                                to="/projects/$projectId/pages/$pageId"
                                params={{ projectId, pageId: m.pageId }}
                                search={{ panelId: m.panelId }}
                                className="underline"
                                title={m.chapterTitle}
                              >
                                ch. {m.chapter} p{m.page}·{m.panel}
                              </Link>
                            ) : (
                              "cover / thumbnail"
                            )}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Modal>
    </>
  );
}
