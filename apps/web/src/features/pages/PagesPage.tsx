import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowDown, ArrowUp, LayoutGrid, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { assetUrl, del, get, patch, post } from "../../api/client.ts";
import { qk, useAction, useMeta } from "../../api/hooks.ts";
import type { ChapterDetail, ChapterDetailPage, ChapterListItem } from "../../api/types.ts";
import {
  ConfirmDialog,
  clsx,
  EmptyState,
  ErrorBox,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
} from "../../components/ui.tsx";
import { ActiveBatches } from "../generation/BatchStatus.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { BulkGenerateButton, LayoutThumb } from "./BulkGenerate.tsx";

/**
 * Draws from the chapter payload rather than fetching. One query per card meant a request per page on every
 * visit — 148 of them for a feature-length film project, which rate-limited the grid on its own.
 */
function PagePreview({ page }: { page: ChapterDetailPage }) {
  const { width: W, height: H } = page;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="block w-full bg-white"
      role="img"
      aria-label={`Page ${page.order} preview`}
    >
      {page.panels.map((p) => {
        const x = p.frame.x * W;
        const y = p.frame.y * H;
        const w = p.frame.width * W;
        const h = p.frame.height * H;
        return (
          <g key={p.id}>
            <rect x={x} y={y} width={w} height={h} fill="#e5e7eb" />
            {p.activeArtworkAssetId && (
              <image
                href={assetUrl(p.activeArtworkAssetId, "thumbnail")}
                x={x}
                y={y}
                width={w}
                height={h}
                preserveAspectRatio="xMidYMid slice"
              />
            )}
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill="none"
              stroke={
                p.status === "failed"
                  ? "#ef4444"
                  : p.review
                    ? "#8b5cf6"
                    : (p.qa as { verdict?: string; stale?: boolean } | null)?.verdict === "mismatch" &&
                        !(p.qa as { stale?: boolean }).stale
                      ? "#f59e0b"
                      : "#111"
              }
              strokeWidth={W / 200}
              strokeDasharray={
                (p.qa as { verdict?: string } | null)?.verdict === "mismatch" ? `${W / 60} ${W / 120}` : undefined
              }
            />
          </g>
        );
      })}
    </svg>
  );
}

export function PagesPage() {
  const projectId = useProjectId();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { chapterId?: string };
  const chapters = useQuery({
    queryKey: qk.chapters(projectId),
    // Cache holds the raw response shape shared with other screens; select derives the list.
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
    select: (r) => r.chapters,
  });
  const chapterId = search.chapterId ?? chapters.data?.[0]?.id;
  const chapter = useQuery({
    queryKey: qk.chapter(chapterId ?? ""),
    queryFn: () => get<ChapterDetail>(`/chapters/${chapterId}`),
    enabled: Boolean(chapterId),
  });
  const { data: meta } = useMeta();
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const inv = [qk.chapter(chapterId ?? ""), qk.chapters(projectId)];

  const addPage = useAction(
    (layoutTemplate: string) => post<{ page: { id: string } }>(`/chapters/${chapterId}/pages`, { layoutTemplate }),
    { invalidate: inv, success: "Page added", onSuccess: () => setAdding(false) },
  );
  const move = useAction((v: { id: string; order: number }) => patch(`/pages/${v.id}`, { order: v.order }), {
    invalidate: inv,
  });
  const remove = useAction((id: string) => del(`/pages/${id}`), {
    invalidate: inv,
    success: "Page deleted",
    onSuccess: () => setDeleting(null),
  });

  if (chapters.isLoading)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  if (chapters.error)
    return (
      <div className="p-6">
        <ErrorBox error={chapters.error} onRetry={() => chapters.refetch()} />
      </div>
    );
  if (!chapters.data?.length)
    return (
      <div className="p-6">
        <EmptyState
          icon={<LayoutGrid className="size-8" />}
          title="No chapters yet"
          action={
            <Link to="/projects/$projectId/chapters" params={{ projectId }} className="btn-primary">
              Go to chapters
            </Link>
          }
        >
          Analyze your story or create a chapter, then plan its pages.
        </EmptyState>
      </div>
    );

  const pages = chapter.data?.pages ?? [];
  const totalPanels = pages.reduce((s, p) => s + p.panelCount, 0);
  const ready = pages.reduce((s, p) => s + p.readyCount, 0);

  return (
    <div className="p-6">
      <PageHeader
        title="Pages"
        subtitle={chapter.data ? `${pages.length} pages · ${ready} / ${totalPanels} panels with artwork` : undefined}
        actions={
          <>
            <label className="sr-only" htmlFor="chapter-select">
              Chapter
            </label>
            <select
              id="chapter-select"
              className="input w-56"
              value={chapterId}
              onChange={(e) =>
                navigate({
                  to: "/projects/$projectId/pages",
                  params: { projectId },
                  search: { chapterId: e.target.value },
                })
              }
            >
              {chapters.data.map((c) => (
                <option key={c.id} value={c.id}>
                  Ch. {c.order} — {c.title}
                </option>
              ))}
            </select>
            {chapterId && totalPanels > 0 && (
              <BulkGenerateButton
                projectId={projectId}
                scope={{ chapterId }}
                label="Generate chapter"
                className="btn-secondary"
              />
            )}
            <button type="button" className="btn-primary" onClick={() => setAdding(true)} disabled={!chapterId}>
              <Plus className="size-4" /> Add page
            </button>
          </>
        }
      />
      {chapterId && <ActiveBatches projectId={projectId} chapterId={chapterId} className="mb-4" />}
      {chapter.error && <ErrorBox error={chapter.error} />}
      {chapter.isLoading && <Spinner />}
      {chapter.data && !pages.length && (
        <EmptyState
          icon={<LayoutGrid className="size-8" />}
          title="No pages in this chapter"
          action={
            <Link
              to="/projects/$projectId/chapters/$chapterId"
              params={{ projectId, chapterId: chapterId! }}
              className="btn-secondary"
            >
              Plan chapter with AI
            </Link>
          }
        >
          Plan the chapter to create scenes, pages and panels automatically, or add a page manually.
        </EmptyState>
      )}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
        {pages.map((p, i) => (
          <div key={p.id} className="card group overflow-hidden">
            <Link
              to="/projects/$projectId/pages/$pageId"
              params={{ projectId, pageId: p.id }}
              search={{}}
              aria-label={`Open page ${p.order} in editor`}
              className="block focus-visible:outline-2 focus-visible:outline-accent-500"
            >
              <PagePreview page={p} />
            </Link>
            <div className="flex items-center justify-between gap-1 p-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">Page {p.order}</div>
                <div className="muted truncate text-xs">
                  {p.readyCount}/{p.panelCount} ready
                </div>
              </div>
              <StatusChip status={p.status} />
            </div>
            <div className="flex justify-end gap-0.5 border-t border-[var(--border)] p-1">
              <button
                type="button"
                className="btn-ghost p-1"
                aria-label="Move page earlier"
                disabled={i === 0 || move.isPending}
                onClick={() => move.mutate({ id: p.id, order: p.order - 1 })}
              >
                <ArrowUp className="size-3.5" />
              </button>
              <button
                type="button"
                className="btn-ghost p-1"
                aria-label="Move page later"
                disabled={i === pages.length - 1 || move.isPending}
                onClick={() => move.mutate({ id: p.id, order: p.order + 1 })}
              >
                <ArrowDown className="size-3.5" />
              </button>
              <button
                type="button"
                className="btn-ghost p-1 text-red-500"
                aria-label="Delete page"
                onClick={() => setDeleting(p.id)}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>

      <Modal open={adding} onClose={() => setAdding(false)} title="Add page — choose a layout" wide>
        <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
          {meta?.layouts.map((t) => (
            <button
              key={t.key}
              type="button"
              disabled={addPage.isPending}
              onClick={() => addPage.mutate(t.key)}
              className={clsx("card flex flex-col items-center gap-2 p-3 text-center text-xs hover:border-accent-500")}
            >
              <LayoutThumb frames={t.frames} className="h-24 w-16" />
              <span className="font-medium">{t.name}</span>
            </button>
          ))}
        </div>
      </Modal>
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete page?"
        danger
        confirmLabel="Delete page"
        busy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      >
        The page, its panels and lettering are removed. Generated artwork stays in the asset library.
      </ConfirmDialog>
    </div>
  );
}
