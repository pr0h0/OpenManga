import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Columns2, Rows3, Rss } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { get } from "../../api/client.ts";
import { ErrorBox, fmt, Spinner } from "../../components/ui.tsx";

type Chapter = { id: string; order: number; title: string; summary: string; publishAt: string; available: boolean };
type Series = {
  series: {
    title: string;
    description: string;
    readingDirection: string;
    cover: string | null;
    links: { reader: string; share: string; feed: string };
  };
  languages: string[];
  episodes: { title: string; number: number | null; chapters: Chapter[] }[];
};
type ChapterView = {
  episode: { number: number | null; title: string; readingDirection: string };
  chapter: Chapter;
  pages: { id: string; order: number; width: number; height: number; alt?: string }[];
  previous: string | null;
  next: string | null;
};

const languageName = (code: string) => {
  try {
    return new Intl.DisplayNames([navigator.language], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/**
 * A series' public reader page (/s/:slug): no sign-in. The cover, description and episodes with their published
 * chapters (scheduled ones show when they come out), then a chapter page by page or as one scroll, in any of the
 * languages its lettering was translated into, with an RSS feed for new chapters.
 */
export function SeriesReaderPage() {
  const { slug } = useParams({ strict: false }) as { slug: string };
  const search = useSearch({ strict: false }) as { chapter?: string; language?: string };
  const navigate = useNavigate();
  const s = useQuery({
    queryKey: ["public-series", slug],
    queryFn: () => get<Series>(`/public/series/${slug}`),
    retry: false,
  });
  const language = search.language ?? s.data?.languages[0];
  const go = (chapter?: string, lang = search.language) => {
    void navigate({ to: ".", search: { ...(chapter ? { chapter } : {}), ...(lang ? { language: lang } : {}) } });
    window.scrollTo(0, 0);
  };
  useEffect(() => {
    if (s.data) document.title = s.data.series.title;
  }, [s.data]);

  if (s.isLoading)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner className="size-6" />
      </div>
    );
  if (s.error || !s.data)
    return (
      <div className="mx-auto max-w-md p-6">
        <ErrorBox error={s.error ?? new Error("This series is not available.")} />
      </div>
    );
  const d = s.data;
  return (
    <div className="min-h-dvh bg-[var(--bg)] text-[var(--text)]">
      <header className="sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--panel)] px-4 py-2">
        <button type="button" className="mr-auto min-w-0 text-left" onClick={() => go()}>
          <h1 className="truncate text-sm font-semibold">{d.series.title}</h1>
        </button>
        {d.languages.length > 1 && (
          <select
            className="input w-auto text-sm"
            aria-label="Language"
            value={language}
            onChange={(e) => go(search.chapter, e.target.value)}
          >
            {d.languages.map((l) => (
              <option key={l} value={l}>
                {languageName(l)}
              </option>
            ))}
          </select>
        )}
        <a className="btn-ghost" href={d.series.links.feed} title="RSS feed of new chapters" aria-label="RSS feed">
          <Rss className="size-4" />
        </a>
      </header>
      {search.chapter ? (
        <ChapterReader
          slug={slug}
          chapterId={search.chapter}
          language={language === d.languages[0] ? undefined : language}
          rtl={d.series.readingDirection === "rtl"}
          vertical={d.series.readingDirection === "vertical"}
          onChapter={(id) => go(id)}
        />
      ) : (
        <main className="mx-auto max-w-3xl space-y-6 p-4">
          <section className="flex flex-col gap-4 sm:flex-row">
            {d.series.cover && <img src={d.series.cover} alt="" className="h-auto w-full rounded-lg sm:w-56" />}
            <div className="space-y-2">
              <h2 className="text-2xl font-semibold">{d.series.title}</h2>
              {d.series.description && <p className="whitespace-pre-wrap">{d.series.description}</p>}
            </div>
          </section>
          {d.episodes.map((e) => (
            <section key={`${e.number}-${e.title}`} aria-label={e.title}>
              <h3 className="font-medium">
                {e.number ? `Episode ${e.number}: ` : ""}
                {e.title}
              </h3>
              <ul className="mt-1 divide-y divide-[var(--border)]">
                {e.chapters.map((ch) => (
                  <li key={ch.id} className="flex items-center gap-2 py-2 text-sm">
                    <span className="mr-auto">
                      {ch.order}. {ch.title}
                    </span>
                    {ch.available ? (
                      <button type="button" className="btn-secondary text-xs" onClick={() => go(ch.id)}>
                        Read
                      </button>
                    ) : (
                      <span className="muted text-xs">Coming {new Date(ch.publishAt).toLocaleDateString()}</span>
                    )}
                  </li>
                ))}
                {!e.chapters.length && <li className="muted py-2 text-sm">Nothing published yet.</li>}
              </ul>
            </section>
          ))}
        </main>
      )}
    </div>
  );
}

function ChapterReader({
  slug,
  chapterId,
  language,
  rtl,
  vertical,
  onChapter,
}: {
  slug: string;
  chapterId: string;
  language?: string;
  rtl: boolean;
  vertical: boolean;
  onChapter: (id: string) => void;
}) {
  const q = useQuery({
    queryKey: ["public-series", slug, chapterId],
    queryFn: () => get<ChapterView>(`/public/series/${slug}/chapters/${chapterId}`),
    retry: false,
  });
  const [mode, setMode] = useState<"pages" | "scroll" | null>(null);
  const [pageIdx, setPageIdx] = useState(0);
  useEffect(() => setPageIdx(0), [chapterId]);
  const scroll = (mode ?? (vertical ? "scroll" : "pages")) === "scroll";
  const width = useMemo(
    () => Math.min(1600, Math.round(Math.max(400, window.innerWidth) * Math.min(2, window.devicePixelRatio || 1))),
    [],
  );
  const src = (id: string) =>
    `/api/public/series/${slug}/pages/${id}.png?${new URLSearchParams({ width: String(width), ...(language ? { language } : {}) })}`;
  const pageList = q.data?.pages ?? [];
  const step = (d: number) => {
    const next = pageIdx + d;
    if (next >= 0 && next < pageList.length) setPageIdx(next);
    else if (next >= pageList.length && q.data?.next) onChapter(q.data.next);
    else if (next < 0 && q.data?.previous) onChapter(q.data.previous);
  };
  useEffect(() => {
    if (scroll) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") step(rtl ? -1 : 1);
      if (e.key === "ArrowLeft") step(rtl ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  if (q.isLoading) return <Spinner className="m-6" />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? new Error("This chapter is not published.")} />;
  const v = q.data;
  const page = pageList[pageIdx];
  const nav = (
    <nav className="flex items-center justify-center gap-2 p-3" aria-label="Chapters">
      {v.previous && (
        <button type="button" className="btn-secondary" onClick={() => onChapter(v.previous!)}>
          Previous chapter
        </button>
      )}
      {v.next && (
        <button type="button" className="btn-primary" onClick={() => onChapter(v.next!)}>
          Next chapter
        </button>
      )}
    </nav>
  );
  return (
    <>
      <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-1 text-sm">
        <h2 className="mr-auto truncate">
          {v.episode.number ? `Ep. ${v.episode.number} · ` : ""}
          {v.chapter.title}
        </h2>
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setMode(scroll ? "pages" : "scroll")}
          aria-label={scroll ? "Read page by page" : "Read as a scroll"}
          title={scroll ? "Read page by page" : "Read as a scroll"}
        >
          {scroll ? <Columns2 className="size-4" /> : <Rows3 className="size-4" />}
        </button>
      </div>
      {!pageList.length ? (
        <p className="muted p-6 text-center">This chapter has no pages yet.</p>
      ) : scroll ? (
        <main className="mx-auto flex max-w-3xl flex-col">
          {pageList.map((pg) => (
            <img
              key={pg.id}
              src={src(pg.id)}
              alt={pg.alt || `Page ${pg.order}`}
              loading="lazy"
              width={pg.width}
              height={pg.height}
              className="h-auto w-full"
            />
          ))}
          {nav}
        </main>
      ) : (
        page && (
          <main className="relative flex h-[calc(100dvh-6rem)] items-center justify-center p-2">
            <img
              key={page.id}
              src={src(page.id)}
              alt={page.alt || `Page ${page.order}`}
              className="max-h-full max-w-full object-contain"
            />
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
      {!scroll && pageList.length > 0 && nav}
      <p className="muted pb-4 text-center text-xs">
        <Link to="/s/$slug" params={{ slug }}>
          All chapters
        </Link>
      </p>
    </>
  );
}
