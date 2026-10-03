import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { get, post } from "../../api/client.ts";
import { qk } from "../../api/hooks.ts";
import type { ChapterListItem, PanelRow } from "../../api/types.ts";
import { AssetImage, ConfirmDialog, EmptyState, ErrorBox, PageHeader, Spinner, toast } from "../../components/ui.tsx";
import { useAiBody } from "../ai/AiPicker.tsx";
import { CheckPanelsButton } from "../generation/CheckPanels.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";

type Panel = PanelRow & { pageOrder: number };
type Qa = { verdict?: string; stale?: boolean; assetId?: string; problems?: string[] } | null;

const FILTERS = {
  all: { label: "All", test: () => true },
  noArt: { label: "No artwork", test: (p: Panel) => !p.activeArtworkAssetId },
  failed: { label: "Failed", test: (p: Panel) => p.status === "failed" },
  review: { label: "Needs review", test: (p: Panel) => Boolean(p.review) },
  mismatch: {
    label: "Check mismatch",
    test: (p: Panel) => {
      const qa = p.qa as Qa;
      return qa?.verdict === "mismatch" && !qa.stale && qa.assetId === p.activeArtworkAssetId;
    },
  },
  unchecked: {
    label: "Not checked",
    test: (p: Panel) => {
      const qa = p.qa as Qa;
      return Boolean(p.activeArtworkAssetId) && (!qa || qa.stale || qa.assetId !== p.activeArtworkAssetId);
    },
  },
} as const;
type Filter = keyof typeof FILTERS;

/**
 * Every panel of a chapter at a glance, filtered to what needs attention. Keys: arrows move, Enter opens the panel
 * in the editor, C checks it and G regenerates it — both of which spend, so they ask first.
 */
export function StoryboardPage() {
  const projectId = useProjectId();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { chapterId?: string; filter?: Filter };
  const chapters = useQuery({
    queryKey: qk.chapters(projectId),
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
  });
  const chapterId = search.chapterId ?? chapters.data?.chapters[0]?.id;
  const list = useQuery({
    // Under the chapters key, which every panel.updated event refreshes, so checks and new art show up live.
    queryKey: [...qk.chapters(projectId), chapterId, "panels"],
    queryFn: () => get<{ panels: Panel[] }>(`/chapters/${chapterId}/panels`),
    enabled: Boolean(chapterId),
  });
  // A link can open it on a filter, e.g. a production run's "panels without artwork".
  const [filter, setFilter] = useState<Filter>(search.filter ?? "all");
  const shown = useMemo(() => (list.data?.panels ?? []).filter(FILTERS[filter].test), [list.data, filter]);
  const [focus, setFocus] = useState(0);
  const [ask, setAsk] = useState<{ kind: "check" | "generate"; panel: Panel } | null>(null);
  const [busy, setBusy] = useState(false);
  const aiText = useAiBody("text");
  const aiImage = useAiBody("image");
  const grid = useRef<HTMLDivElement>(null);

  useEffect(() => setFocus(0), [filter, chapterId]);
  useEffect(() => {
    grid.current?.querySelector<HTMLElement>(`[data-i="${focus}"]`)?.scrollIntoView({ block: "nearest" });
  }, [focus]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (ask || t.closest("input, textarea, select, [role=dialog]")) return;
      const cols = grid.current ? Math.max(1, Math.round(grid.current.clientWidth / 190)) : 1;
      const move = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key];
      if (move) {
        e.preventDefault();
        setFocus((f) => Math.min(shown.length - 1, Math.max(0, f + move)));
        return;
      }
      const p = shown[focus];
      if (!p) return;
      if (e.key === "Enter")
        navigate({
          to: "/projects/$projectId/pages/$pageId",
          params: { projectId, pageId: p.pageId },
          search: { panelId: p.id },
        });
      if (e.key === "c" && p.activeArtworkAssetId) setAsk({ kind: "check", panel: p });
      if (e.key === "g") setAsk({ kind: "generate", panel: p });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const confirm = async () => {
    if (!ask) return;
    setBusy(true);
    try {
      if (ask.kind === "check") await post(`/panels/${ask.panel.id}/check`, aiText());
      else await post(`/panels/${ask.panel.id}/generate`, aiImage());
      toast.success(ask.kind === "check" ? "Check queued" : "Generation queued");
      setAsk(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  if (chapters.isLoading) return <Spinner className="m-6 size-6" />;
  return (
    <div className="p-6">
      <PageHeader
        title="Storyboard"
        subtitle="Every panel of a chapter. Arrows move, Enter opens, C checks, G regenerates."
        actions={
          <>
            <select
              className="input w-56"
              aria-label="Chapter"
              value={chapterId}
              onChange={(e) =>
                navigate({
                  to: "/projects/$projectId/storyboard",
                  params: { projectId },
                  search: { chapterId: e.target.value },
                })
              }
            >
              {chapters.data?.chapters.map((c) => (
                <option key={c.id} value={c.id}>
                  Ch. {c.order} — {c.title}
                </option>
              ))}
            </select>
            {chapterId && <CheckPanelsButton projectId={projectId} scope={{ chapterId }} />}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap gap-1" role="tablist" aria-label="Filter">
        {(Object.keys(FILTERS) as Filter[]).map((f) => {
          const n = (list.data?.panels ?? []).filter(FILTERS[f].test).length;
          return (
            <button
              key={f}
              type="button"
              role="tab"
              aria-selected={filter === f}
              className={filter === f ? "btn-primary px-2 py-1 text-xs" : "btn-secondary px-2 py-1 text-xs"}
              onClick={() => setFilter(f)}
            >
              {FILTERS[f].label} <span className="opacity-70">{n}</span>
            </button>
          );
        })}
      </div>
      <ErrorBox error={list.error} onRetry={() => list.refetch()} />
      {list.isLoading && <Spinner className="size-6" />}
      {list.data && !shown.length && <EmptyState title="Nothing here">No panel matches this filter.</EmptyState>}
      <div ref={grid} className="grid grid-cols-[repeat(auto-fill,minmax(170px,1fr))] gap-3">
        {shown.map((p, i) => {
          const qa = p.qa as Qa;
          const flags = [
            p.status === "failed" && "failed",
            p.review && "review",
            FILTERS.mismatch.test(p) && (qa?.problems?.[0] ?? "mismatch"),
          ].filter(Boolean) as string[];
          return (
            <button
              key={p.id}
              type="button"
              data-i={i}
              onClick={() => setFocus(i)}
              onDoubleClick={() =>
                navigate({
                  to: "/projects/$projectId/pages/$pageId",
                  params: { projectId, pageId: p.pageId },
                  search: { panelId: p.id },
                })
              }
              className={`card overflow-hidden text-left ${i === focus ? "ring-2 ring-accent-500" : ""}`}
            >
              <AssetImage
                assetId={p.activeArtworkAssetId}
                alt={`Page ${p.pageOrder} panel ${p.order}`}
                className="aspect-video w-full"
              />
              <div className="space-y-1 p-2 text-xs">
                <div className="flex items-center gap-1">
                  <span className="font-medium">
                    p{p.pageOrder}·{p.order}
                  </span>
                  <span className="muted truncate">{p.shotType}</span>
                </div>
                <p className="muted line-clamp-2">{p.storyBeat}</p>
                {flags.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {flags.map((f) => (
                      <span key={f} className="chip bg-amber-500/15 text-amber-700 dark:text-amber-300">
                        {f}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
      <ConfirmDialog
        open={Boolean(ask)}
        title={ask?.kind === "check" ? "Check this panel?" : "Regenerate this panel?"}
        confirmLabel={ask?.kind === "check" ? "Check" : "Regenerate"}
        busy={busy}
        onClose={() => setAsk(null)}
        onConfirm={confirm}
      >
        {ask?.kind === "check"
          ? "Runs the vision consistency check on this panel's artwork (one paid vision call)."
          : "Generates new artwork for this panel (one paid image). The current version is kept in its history."}
      </ConfirmDialog>
    </div>
  );
}
