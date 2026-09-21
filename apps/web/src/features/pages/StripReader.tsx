import { stripLayout } from "@openmanga/domain/browser";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { API_BASE, get } from "../../api/client.ts";
import { qk } from "../../api/hooks.ts";
import type { ChapterListItem } from "../../api/types.ts";
import { EmptyState, ErrorBox, PageHeader, Spinner } from "../../components/ui.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";

type Block = {
  pageId: string;
  order: number;
  height: number;
  hasArt: boolean;
  seam: Parameters<typeof stripLayout>[0][number]["seam"];
  updatedAt: string;
};
type Strip = { width: number; gap: number; background: string; format: string; blocks: Block[] };

/** The mask that reproduces a seam's feathered edge in the browser, in the strip's own pixels. */
function maskFor(top: number, bottom: number, height: number) {
  if (!top && !bottom) return undefined;
  const stops = ["transparent 0px"];
  if (top) stops.push(`#000 ${top}px`);
  else stops[0] = "#000 0px";
  if (bottom) {
    stops.push(`#000 ${height - bottom}px`, "transparent 100%");
  } else {
    stops.push("#000 100%");
  }
  return `linear-gradient(to bottom, ${stops.join(", ")})`;
}

/**
 * Reads a chapter as one continuous column, laid out by the same stripLayout the export uses — so what you scroll
 * here is what gets stitched. Each block is the page renderer's own output, which means dialogue, captions and
 * sound effects are already composed into it.
 */
export function StripReaderPage() {
  const projectId = useProjectId();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { chapterId?: string };
  const chapters = useQuery({
    queryKey: qk.chapters(projectId),
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
    select: (r) => r.chapters,
  });
  const chapterId = search.chapterId ?? chapters.data?.[0]?.id;
  const strip = useQuery({
    queryKey: ["strip", chapterId ?? ""],
    queryFn: () => get<Strip>(`/chapters/${chapterId}/strip?width=800`),
    enabled: Boolean(chapterId),
  });

  // The layout is computed in strip pixels and then scaled to whatever width the window gives us, so the seams
  // stay proportional instead of being recomputed against a different width.
  const box = useRef<HTMLDivElement>(null);
  const [shown, setShown] = useState(800);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setShown(entry?.contentRect.width ?? 800));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  if (chapters.isLoading) return <Spinner className="size-6" />;
  const d = strip.data;
  const scale = d ? Math.min(1, shown / d.width) : 1;
  const layout = d ? stripLayout(d.blocks, { gap: d.gap, background: d.background }) : null;
  const feathers = new Map(layout?.feathers.map((f) => [f.index, f]) ?? []);

  return (
    <div className="mx-auto max-w-5xl p-4 sm:p-6">
      <PageHeader
        title="Read"
        subtitle={
          d && d.format !== "vertical"
            ? "This project is not a vertical strip, so this is only a preview of how it would stack."
            : "The chapter as one scrolling column, laid out exactly as it exports."
        }
        actions={
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="strip-chapter">
              Chapter
            </label>
            <select
              id="strip-chapter"
              className="input w-56"
              value={chapterId ?? ""}
              onChange={(e) =>
                navigate({
                  to: "/projects/$projectId/read",
                  params: { projectId },
                  search: { chapterId: e.target.value },
                })
              }
            >
              {chapters.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  Ch. {c.order} — {c.title}
                </option>
              ))}
            </select>
            <Link to="/projects/$projectId/pages" params={{ projectId }} search={{}} className="btn-secondary">
              Edit
            </Link>
          </div>
        }
      />
      <ErrorBox error={strip.error} />
      {strip.isLoading && <Spinner className="size-6" />}
      {d && !d.blocks.length && (
        <EmptyState title="Nothing to read yet">Plan the chapter, then generate its panels.</EmptyState>
      )}
      <div ref={box} className="mx-auto w-full" style={{ maxWidth: d?.width }}>
        {d && layout && (
          <div className="relative mx-auto" style={{ height: layout.height * scale, background: d.background }}>
            {layout.bands.map((band) => (
              <div
                key={`band-${band.top}`}
                className="absolute inset-x-0"
                style={{ top: band.top * scale, height: band.height * scale, background: band.color }}
              />
            ))}
            {layout.placements.map((place) => {
              const block = d.blocks[place.index]!;
              const f = feathers.get(place.index);
              const mask = f ? maskFor(f.top * scale, f.bottom * scale, block.height * scale) : undefined;
              return block.hasArt ? (
                <img
                  key={block.pageId}
                  src={`${API_BASE}/pages/${block.pageId}/render.png?width=${d.width}&v=${encodeURIComponent(block.updatedAt)}`}
                  alt={`Panel ${block.order}`}
                  loading="lazy"
                  className="absolute inset-x-0 block w-full"
                  style={{
                    top: place.top * scale,
                    height: block.height * scale,
                    maskImage: mask,
                    WebkitMaskImage: mask,
                  }}
                />
              ) : (
                <div
                  key={block.pageId}
                  className="absolute inset-x-0 flex items-center justify-center bg-[var(--panel-2)] text-xs"
                  style={{ top: place.top * scale, height: block.height * scale }}
                >
                  Panel {block.order} has no artwork yet
                </div>
              );
            })}
          </div>
        )}
      </div>
      {d && layout && (
        <p className="muted mt-3 text-center text-xs">
          {d.blocks.length} panels · {layout.height}px tall at {d.width}px wide
        </p>
      )}
    </div>
  );
}
