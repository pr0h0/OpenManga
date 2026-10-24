import {
  and,
  asc,
  assets,
  chapters,
  eq,
  inArray,
  isNotNull,
  isNull,
  letteringTranslations,
  ne,
  pages,
  projects,
  series,
} from "@openmanga/db";
import { altTextFor, cachedPageRender } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { notFound, query } from "../lib/http.ts";
import { failureGuard } from "../lib/middleware.ts";
import { doc } from "../lib/openapi.ts";
import { sendAsset } from "./assets.ts";

/**
 * A series' reader page, with no session: the series that turned it on (unlisted or public), its episodes in order
 * and, of their chapters, only those whose publish date has come (a future date shows as scheduled, without pages).
 */
export const publicSeriesRoutes = new Hono<AppEnv>();
/** Social previews: /s/:slug as a small HTML page crawlers read, which sends people on to the app's reader. */
export const seriesPreviewRoutes = new Hono<AppEnv>();

type Ctx = Context<AppEnv>;

async function openSeries(c: Ctx, slug: string) {
  // An unlisted page is private by its address: cap wrong ones per client so the addresses cannot be walked.
  const guesses = await failureGuard(c, "series-slug", 30, 900);
  const [s] = await c
    .get("deps")
    .db.select()
    .from(series)
    .where(and(eq(series.publicSlug, slug.toLowerCase()), ne(series.visibility, "off")));
  if (!s) {
    await guesses.fail();
    throw notFound("Series");
  }
  return s;
}

/** The series' episodes with their published (and scheduled) chapters, in reading order. */
async function contents(c: Ctx, s: typeof series.$inferSelect) {
  const { db } = c.get("deps");
  const eps = await db
    .select({
      id: projects.id,
      title: projects.title,
      number: projects.episodeNumber,
      coverAssetId: projects.coverAssetId,
      readingDirection: projects.readingDirection,
      language: projects.language,
    })
    .from(projects)
    // Only the series owner's projects: nobody else can put chapters on this reader page.
    .where(
      and(
        eq(projects.seriesId, s.id),
        eq(projects.seriesRole, "episode"),
        eq(projects.ownerUserId, s.ownerUserId),
        isNull(projects.deletedAt),
      ),
    )
    .orderBy(asc(projects.episodeNumber));
  const chs = eps.length
    ? await db
        .select({
          id: chapters.id,
          projectId: chapters.projectId,
          order: chapters.order,
          title: chapters.title,
          summary: chapters.summary,
          publishAt: chapters.publishAt,
        })
        .from(chapters)
        .where(
          and(
            inArray(
              chapters.projectId,
              eps.map((e) => e.id),
            ),
            isNotNull(chapters.publishAt),
          ),
        )
        .orderBy(asc(chapters.order))
    : [];
  const now = Date.now();
  return eps.map((e) => ({
    ...e,
    chapters: chs
      .filter((ch) => ch.projectId === e.id)
      .map(({ projectId: _p, ...ch }) => ({ ...ch, available: ch.publishAt!.getTime() <= now })),
  }));
}

/** A chapter that is readable now, with its episode. */
async function openChapter(c: Ctx, s: typeof series.$inferSelect, chapterId: string) {
  const eps = await contents(c, s);
  for (const e of eps) {
    const ch = e.chapters.find((x) => x.id === chapterId && x.available);
    if (ch) return { episode: e, chapter: ch, episodes: eps };
  }
  throw notFound("Chapter");
}

/** The series' cover: the library's cover, else the first episode's that has one. */
async function coverAsset(c: Ctx, s: typeof series.$inferSelect, eps: { coverAssetId: string | null }[]) {
  const { db } = c.get("deps");
  const [lib] = await db
    .select({ cover: projects.coverAssetId })
    .from(projects)
    .where(eq(projects.id, s.libraryProjectId));
  for (const id of [lib?.cover, ...eps.map((e) => e.coverAssetId)]) {
    if (!id) continue;
    const [a] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), isNull(assets.deletedAt)));
    if (a) return a;
  }
  return null;
}

const links = (c: Ctx, slug: string) => {
  const urls = c.get("deps").urls;
  return {
    reader: urls.appUrl(`s/${slug}`),
    share: new URL(`/s/${slug}`, urls.appOrigin).toString(),
    feed: urls.apiUrl(`public/series/${slug}/feed.xml`),
    cover: urls.apiUrl(`public/series/${slug}/cover`),
  };
};

doc({
  method: "GET",
  path: "/api/public/series/:slug",
  summary:
    "A series' reader page: its title, description, cover, reading direction, the languages it can be read in (the original and every translated lettering), and its episodes with their published chapters (available) and scheduled ones (a future publishAt). No sign-in.",
  tag: "series",
  auth: false,
});
publicSeriesRoutes.get("/series/:slug", async (c) => {
  const s = await openSeries(c, c.req.param("slug"));
  const eps = await contents(c, s);
  const { db } = c.get("deps");
  const translated = eps.length
    ? await db
        .selectDistinct({ language: letteringTranslations.language })
        .from(letteringTranslations)
        .where(
          inArray(
            letteringTranslations.projectId,
            eps.map((e) => e.id),
          ),
        )
    : [];
  const original = eps[0]?.language ?? "en";
  const cover = await coverAsset(c, s, eps);
  return c.json({
    series: {
      title: s.title,
      description: s.description,
      visibility: s.visibility,
      readingDirection: eps[0]?.readingDirection ?? "ltr",
      cover: cover ? links(c, s.publicSlug!).cover : null,
      links: links(c, s.publicSlug!),
    },
    languages: [
      original,
      ...translated
        .map((t) => t.language)
        .filter((l) => l !== original)
        .sort(),
    ],
    episodes: eps.map(({ id: _id, coverAssetId: _c, language: _l, ...e }) => e),
  });
});

doc({
  method: "GET",
  path: "/api/public/series/:slug/chapters/:chapterId",
  summary:
    "A published chapter of a series' reader page: its pages in reading order, and the chapters before and after it. No sign-in.",
  tag: "series",
  auth: false,
});
publicSeriesRoutes.get("/series/:slug/chapters/:chapterId", async (c) => {
  const s = await openSeries(c, c.req.param("slug"));
  const { episode, chapter, episodes } = await openChapter(c, s, c.req.param("chapterId"));
  const pgs = await c
    .get("deps")
    .db.select({ id: pages.id, order: pages.order, width: pages.width, height: pages.height })
    .from(pages)
    .where(eq(pages.chapterId, chapter.id))
    .orderBy(asc(pages.order));
  const alts = await altTextFor(
    c.get("deps").db,
    pgs.map((pg) => pg.id),
  );
  const readable = episodes.flatMap((e) => e.chapters.filter((ch) => ch.available).map((ch) => ch.id));
  const at = readable.indexOf(chapter.id);
  return c.json({
    episode: { number: episode.number, title: episode.title, readingDirection: episode.readingDirection },
    chapter,
    pages: pgs.map((pg) => ({ ...pg, alt: alts.get(pg.id)?.alt ?? "" })),
    previous: readable[at - 1] ?? null,
    next: readable[at + 1] ?? null,
  });
});

const PageQuery = z.object({
  width: z.coerce.number().int().min(200).max(1600).default(1200),
  /** A translated edition: its lettering where translated. */
  language: z.string().trim().min(2).max(16).optional(),
});
doc({
  method: "GET",
  path: "/api/public/series/:slug/pages/:pageId.png",
  summary:
    "A page of a published chapter, lettered (in ?language= where translated), as a PNG at ?width= up to 1600. No sign-in.",
  tag: "series",
  auth: false,
  query: PageQuery,
});
publicSeriesRoutes.get("/series/:slug/pages/:file", async (c) => {
  const s = await openSeries(c, c.req.param("slug"));
  const pageId = c.req.param("file").replace(/\.png$/, "");
  if (!z.string().uuid().safeParse(pageId).success) throw notFound("Page");
  const q = query(c, PageQuery);
  const { db, assets: assetSvc } = c.get("deps");
  const [page] = await db
    .select({
      chapterId: pages.chapterId,
      projectId: pages.projectId,
      rd: projects.readingDirection,
      lang: projects.language,
    })
    .from(pages)
    .innerJoin(projects, eq(projects.id, pages.projectId))
    .where(eq(pages.id, pageId));
  if (!page) throw notFound("Page");
  await openChapter(c, s, page.chapterId);
  const bucket = Math.min(1600, Math.ceil(q.width / 200) * 200);
  // Only an edition this project has: any other value would render and store one more copy per string anyone sends.
  const [edition] =
    q.language && q.language !== page.lang
      ? await db
          .select({ language: letteringTranslations.language })
          .from(letteringTranslations)
          .where(
            and(eq(letteringTranslations.projectId, page.projectId), eq(letteringTranslations.language, q.language)),
          )
          .limit(1)
      : [];
  const language = edition?.language ?? null;
  const { asset } = await cachedPageRender(db, assetSvc, page.projectId, pageId, page.rd, bucket, false, language);
  return sendAsset(c, asset, { cacheControl: "public, max-age=300", variants: false });
});

doc({
  method: "GET",
  path: "/api/public/series/:slug/cover",
  summary: "The series' cover image (the library's cover, else the first episode's). No sign-in.",
  tag: "series",
  auth: false,
});
publicSeriesRoutes.get("/series/:slug/cover", async (c) => {
  const s = await openSeries(c, c.req.param("slug"));
  const cover = await coverAsset(c, s, await contents(c, s));
  if (!cover) throw notFound("Cover");
  return sendAsset(c, cover, { cacheControl: "public, max-age=3600", variants: false });
});

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

doc({
  method: "GET",
  path: "/api/public/series/:slug/feed.xml",
  summary: "An RSS 2.0 feed of the series' published chapters, newest first. No sign-in.",
  tag: "series",
  auth: false,
});
publicSeriesRoutes.get("/series/:slug/feed.xml", async (c) => {
  const s = await openSeries(c, c.req.param("slug"));
  const l = links(c, s.publicSlug!);
  const items = (await contents(c, s))
    .flatMap((e) => e.chapters.filter((ch) => ch.available).map((ch) => ({ e, ch })))
    .sort((a, b) => b.ch.publishAt!.getTime() - a.ch.publishAt!.getTime())
    .slice(0, 50);
  const body = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
<title>${xml(s.title)}</title>
<link>${xml(l.reader)}</link>
<description>${xml(s.description || s.title)}</description>
<atom:link href="${xml(l.feed)}" rel="self" type="application/rss+xml"/>
${items
  .map(
    ({ e, ch }) => `<item>
<title>${xml(`${e.number ? `Episode ${e.number} · ` : ""}${ch.title}`)}</title>
<link>${xml(`${l.reader}?chapter=${ch.id}`)}</link>
<guid isPermaLink="false">${ch.id}</guid>
<pubDate>${ch.publishAt!.toUTCString()}</pubDate>
<description>${xml(ch.summary)}</description>
</item>`,
  )
  .join("\n")}
</channel>
</rss>
`;
  return c.body(body, 200, {
    "content-type": "application/rss+xml; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
});

seriesPreviewRoutes.get("/s/:slug", async (c) => {
  const s = await openSeries(c, c.req.param("slug"));
  const l = links(c, s.publicSlug!);
  const cover = await coverAsset(c, s, await contents(c, s));
  const description = (s.description || s.title).slice(0, 300);
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${xml(s.title)}</title>
<meta name="description" content="${xml(description)}">
${s.visibility === "unlisted" ? '<meta name="robots" content="noindex">\n' : ""}<meta property="og:type" content="website">
<meta property="og:title" content="${xml(s.title)}">
<meta property="og:description" content="${xml(description)}">
<meta property="og:url" content="${xml(l.share)}">
${cover ? `<meta property="og:image" content="${xml(l.cover)}">\n<meta name="twitter:card" content="summary_large_image">\n` : '<meta name="twitter:card" content="summary">\n'}<link rel="alternate" type="application/rss+xml" title="${xml(s.title)}" href="${xml(l.feed)}">
<meta http-equiv="refresh" content="0; url=${xml(l.reader)}">
</head>
<body><p><a href="${xml(l.reader)}">${xml(s.title)}</a></p></body>
</html>
`;
  return c.html(html, 200, {
    "cache-control": "public, max-age=300",
    ...(s.visibility === "unlisted" ? { "x-robots-tag": "noindex" } : {}),
  });
});
