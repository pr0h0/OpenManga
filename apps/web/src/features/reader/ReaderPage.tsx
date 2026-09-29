import { useQuery } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Columns2, Play, Rows3 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { get } from "../../api/client.ts";
import { ErrorBox, Spinner } from "../../components/ui.tsx";
import { VideoPreview } from "../video/VideoPreview.tsx";

type Shared = {
  project: { title: string; description: string; author: string; readingDirection: string; format: string };
  chapters: {
    id: string;
    title: string;
    order: number;
    pages: { id: string; order: number; width: number; height: number }[];
  }[];
};

/** The public reader behind a share link: no sign-in, read-only, page by page or as one long scroll. */
export function ReaderPage() {
  const { token } = useParams({ strict: false }) as { token: string };
  const { data, error, isLoading } = useQuery({
    queryKey: ["share", token],
    queryFn: () => get<Shared>(`/public/shares/${token}`),
    retry: false,
  });
  const [chapterIdx, setChapterIdx] = useState(0);
  const [pageIdx, setPageIdx] = useState(0);
  // Strips and film shots read as a scroll; pages one at a time.
  const [mode, setMode] = useState<"pages" | "scroll" | null>(null);
  const [playing, setPlaying] = useState(false);
  const scroll = (mode ?? (data && data.project.format !== "comic" ? "scroll" : "pages")) === "scroll";
  const rtl = data?.project.readingDirection === "rtl";
  const chapter = data?.chapters[chapterIdx];
  const pageList = chapter?.pages ?? [];
  const width = useMemo(
    () => Math.min(1600, Math.round(Math.max(400, window.innerWidth) * Math.min(2, window.devicePixelRatio || 1))),
    [],
  );
  const src = (id: string) => `/api/public/shares/${token}/pages/${id}.png?width=${width}`;

  const step = (d: number) => {
    const next = pageIdx + d;
    if (next >= 0 && next < pageList.length) setPageIdx(next);
    else if (next >= pageList.length && data && chapterIdx < data.chapters.length - 1) {
      setChapterIdx(chapterIdx + 1);
      setPageIdx(0);
    } else if (next < 0 && chapterIdx > 0) {
      setChapterIdx(chapterIdx - 1);
      setPageIdx((data?.chapters[chapterIdx - 1]?.pages.length ?? 1) - 1);
    }
  };
  // Arrow keys follow the book: in a right-to-left book the left arrow turns forward.
  useEffect(() => {
    if (scroll) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(rtl ? -1 : 1);
      if (e.key === "ArrowLeft") step(rtl ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  useEffect(() => {
    if (data) document.title = `${data.project.title}${chapter ? ` — ${chapter.title}` : ""}`;
  }, [data, chapter]);
  // Preload the next page so turning is instant.
  useEffect(() => {
    const next = pageList[pageIdx + 1];
    if (!scroll && next) new Image().src = src(next.id);
  });

  if (isLoading)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="size-6" />
      </div>
    );
  if (error || !data)
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorBox error={error ?? new Error("This link is not available.")} />
        <p className="muted mt-2 text-sm">The link may have been revoked. Ask whoever shared it for a new one.</p>
      </div>
    );

  const page = pageList[pageIdx];
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-4 py-2">
        <div className="mr-auto min-w-0">
          <h1 className="truncate text-sm font-semibold">{data.project.title}</h1>
          {data.project.author && <p className="muted truncate text-xs">by {data.project.author}</p>}
        </div>
        {data.chapters.length > 1 && (
          <select
            className="input w-auto max-w-[50vw] text-sm"
            aria-label="Chapter"
            value={chapterIdx}
            onChange={(e) => {
              setChapterIdx(Number(e.target.value));
              setPageIdx(0);
              window.scrollTo(0, 0);
            }}
          >
            {data.chapters.map((ch, i) => (
              <option key={ch.id} value={i}>
                {ch.order}. {ch.title}
              </option>
            ))}
          </select>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={() => setMode(scroll ? "pages" : "scroll")}
          aria-label={scroll ? "Read page by page" : "Read as a scroll"}
          title={scroll ? "Read page by page" : "Read as a scroll"}
        >
          {scroll ? <Columns2 className="size-4" /> : <Rows3 className="size-4" />}
        </button>
        {chapter && pageList.length > 0 && (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setPlaying(true)}
            aria-label="Play this chapter as a video preview"
            title="Play this chapter as a video preview"
          >
            <Play className="size-4" />
          </button>
        )}
      </header>
      {playing && chapter && (
        <VideoPreview
          open
          onClose={() => setPlaying(false)}
          projectId=""
          scope={{ chapterId: chapter.id }}
          defaultCut={data.project.format === "film" ? "panel" : "page"}
          title={chapter.title}
          shareToken={token}
        />
      )}

      {!pageList.length ? (
        <p className="muted p-6 text-center">This chapter has no pages yet.</p>
      ) : scroll ? (
        <main className="mx-auto flex max-w-3xl flex-col">
          {pageList.map((pg) => (
            <img
              key={pg.id}
              src={src(pg.id)}
              alt={`Page ${pg.order}`}
              loading="lazy"
              width={pg.width}
              height={pg.height}
              className="h-auto w-full"
            />
          ))}
          {data.chapters[chapterIdx + 1] && (
            <button
              type="button"
              className="btn-primary m-4 self-center"
              onClick={() => {
                setChapterIdx(chapterIdx + 1);
                window.scrollTo(0, 0);
              }}
            >
              Next chapter: {data.chapters[chapterIdx + 1]!.title}
            </button>
          )}
        </main>
      ) : (
        page && (
          <main className="relative flex h-[calc(100dvh-3.25rem)] items-center justify-center p-2">
            <img
              key={page.id}
              src={src(page.id)}
              alt={`Page ${page.order}`}
              className="max-h-full max-w-full object-contain"
            />
            {/* The two halves turn the page; which half is "forward" follows the reading direction. */}
            <button
              type="button"
              className="absolute inset-y-0 left-0 flex w-1/2 cursor-w-resize items-center"
              aria-label={rtl ? "Next page" : "Previous page"}
              onClick={() => step(rtl ? 1 : -1)}
            >
              <ChevronLeft className="ml-1 size-6 opacity-30" />
            </button>
            <button
              type="button"
              className="absolute inset-y-0 right-0 flex w-1/2 cursor-e-resize items-center justify-end"
              aria-label={rtl ? "Previous page" : "Next page"}
              onClick={() => step(rtl ? -1 : 1)}
            >
              <ChevronRight className="mr-1 size-6 opacity-30" />
            </button>
            <div className="muted absolute bottom-2 left-1/2 -translate-x-1/2 rounded bg-[var(--panel)] px-2 py-0.5 text-xs">
              {pageIdx + 1} / {pageList.length}
            </div>
          </main>
        )
      )}
    </div>
  );
}
