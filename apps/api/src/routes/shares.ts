import { randomBytes } from "node:crypto";
import { and, asc, assets, chapters, desc, eq, inArray, isNull, pages, projects, shareLinks, sql } from "@openmanga/db";
import { cachedPageRender, recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { body, notFound, query, user, uuidParam } from "../lib/http.ts";
import { failureGuard } from "../lib/middleware.ts";
import { doc } from "../lib/openapi.ts";
import { sendAsset } from "./assets.ts";
import { CardQuery, previewPayload, videoCardResponse } from "./video.ts";

/** Managing a project's read-only links: signed-in members only. */
export const shareRoutes = new Hono<AppEnv>();

doc({
  method: "GET",
  path: "/api/projects/:projectId/shares",
  summary: "The project's reader links (owners only)",
  tag: "shares",
});
shareRoutes.get("/projects/:projectId/shares", async (c) => {
  // The tokens are the links themselves: whoever cannot create or revoke one does not get to copy them either.
  const p = await projectAccess(c, uuidParam(c, "projectId"), "manage");
  const rows = await c
    .get("deps")
    .db.select({ s: shareLinks, chapterTitle: chapters.title })
    .from(shareLinks)
    .leftJoin(chapters, eq(chapters.id, shareLinks.chapterId))
    .where(and(eq(shareLinks.projectId, p.id), isNull(shareLinks.revokedAt)))
    .orderBy(desc(shareLinks.createdAt));
  return c.json({ shares: rows.map((r) => ({ ...r.s, chapterTitle: r.chapterTitle })) });
});

const CreateShare = z.object({ chapterId: z.string().uuid().nullable().default(null) });
doc({
  method: "POST",
  path: "/api/projects/:projectId/shares",
  summary: "Create an unlisted, read-only reader link to the project or one chapter (owners only)",
  tag: "shares",
  body: CreateShare,
});
shareRoutes.post("/projects/:projectId/shares", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "manage");
  const { chapterId } = await body(c, CreateShare);
  if (chapterId) {
    const owner = await entityAccess(c, "chapter", chapterId, "read");
    if (owner.id !== p.id) throw notFound("Chapter");
  }
  const { db } = c.get("deps");
  const [share] = await db
    .insert(shareLinks)
    .values({ projectId: p.id, chapterId, token: randomBytes(18).toString("base64url"), createdByUserId: user(c).id })
    .returning();
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: "share.create",
    targetType: "share_link",
    targetId: share!.id,
    metadata: { chapterId },
    requestId: c.get("requestId"),
  });
  return c.json({ share }, 201);
});

doc({ method: "DELETE", path: "/api/shares/:id", summary: "Revoke a reader link (owners only)", tag: "shares" });
shareRoutes.delete("/shares/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [share] = await db.select().from(shareLinks).where(eq(shareLinks.id, id));
  if (!share) throw notFound("Link");
  await projectAccess(c, share.projectId, "manage");
  await db.update(shareLinks).set({ revokedAt: new Date() }).where(eq(shareLinks.id, id));
  await recordAudit(db, {
    userId: user(c).id,
    projectId: share.projectId,
    action: "share.revoke",
    targetType: "share_link",
    targetId: id,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

/** What a reader link opens, with no session: a live, revocable token, and nothing outside its scope. */
export const publicShareRoutes = new Hono<AppEnv>();

async function openShare(c: Parameters<typeof uuidParam>[0], token: string) {
  const { db } = c.get("deps");
  // A reader link is its token: cap wrong ones per address so the token space cannot be walked.
  const guesses = await failureGuard(c, "share-token", 30, 900);
  const [row] = await db
    .select({ s: shareLinks, p: projects })
    .from(shareLinks)
    .innerJoin(projects, eq(projects.id, shareLinks.projectId))
    .where(and(eq(shareLinks.token, token), isNull(shareLinks.revokedAt), isNull(projects.deletedAt)));
  if (!row) {
    await guesses.fail();
    throw notFound("Link");
  }
  return row;
}

doc({
  method: "GET",
  path: "/api/public/shares/:token",
  summary: "A reader link's contents: the title and, per chapter, its pages in reading order. No sign-in.",
  tag: "shares",
  auth: false,
});
publicShareRoutes.get("/shares/:token", async (c) => {
  const { s, p } = await openShare(c, c.req.param("token"));
  const { db } = c.get("deps");
  const chs = await db
    .select({ id: chapters.id, title: chapters.title, order: chapters.order })
    .from(chapters)
    .where(and(eq(chapters.projectId, p.id), s.chapterId ? eq(chapters.id, s.chapterId) : undefined))
    .orderBy(asc(chapters.order));
  const pgs = chs.length
    ? await db
        .select({
          id: pages.id,
          chapterId: pages.chapterId,
          order: pages.order,
          width: pages.width,
          height: pages.height,
        })
        .from(pages)
        .where(
          inArray(
            pages.chapterId,
            chs.map((ch) => ch.id),
          ),
        )
        .orderBy(asc(pages.order))
    : [];
  return c.json({
    project: {
      title: p.title,
      description: p.description,
      author: p.settings.author ?? "",
      readingDirection: p.readingDirection,
      format: p.settings.format,
    },
    chapters: chs.map((ch) => ({ ...ch, pages: pgs.filter((pg) => pg.chapterId === ch.id) })),
  });
});

doc({
  method: "GET",
  path: "/api/public/shares/:token/pages/:pageId.png",
  summary: "One page of a reader link, lettered, as a PNG. ?width= up to 1600 (default 1200). No sign-in.",
  tag: "shares",
  auth: false,
});
publicShareRoutes.get("/shares/:token/pages/:file", async (c) => {
  const { s, p } = await openShare(c, c.req.param("token"));
  const pageId = c.req.param("file").replace(/\.png$/, "");
  if (!z.string().uuid().safeParse(pageId).success) throw notFound("Page");
  const { width } = query(c, z.object({ width: z.coerce.number().int().min(200).max(1600).default(1200) }));
  const { db, assets } = c.get("deps");
  const [page] = await db
    .select({ chapterId: pages.chapterId })
    .from(pages)
    .where(and(eq(pages.id, pageId), eq(pages.projectId, p.id)));
  if (!page || (s.chapterId && page.chapterId !== s.chapterId)) throw notFound("Page");
  // Kept as a render keyed by the page's content and a width bucket, so a repeat read is one lookup and any edit
  // draws it again. Widths round up to 200 px steps, which bounds the copies one page can hold to eight.
  const bucket = Math.min(1600, Math.ceil(width / 200) * 200);
  const { asset } = await cachedPageRender(db, assets, p.id, pageId, p.readingDirection, bucket);
  return sendAsset(c, asset, { cacheControl: "public, max-age=300", variants: false });
});

const SharedPreview = z.object({
  chapterId: z.string().uuid(),
  cut: z.enum(["page", "panel"]).default("panel"),
  aspect: z.enum(["16:9", "9:16", "1:1"]).optional(),
});
doc({
  method: "GET",
  path: "/api/public/shares/:token/video-preview",
  summary:
    "The video preview's shot list for one chapter of a reader link, in the project's language. Media comes from /api/public/shares/:token/assets/:assetId. No sign-in.",
  tag: "shares",
  auth: false,
  query: SharedPreview,
});
publicShareRoutes.get("/shares/:token/video-preview", async (c) => {
  const { s, p } = await openShare(c, c.req.param("token"));
  const q = query(c, SharedPreview);
  const [ch] = await c
    .get("deps")
    .db.select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.id, q.chapterId), eq(chapters.projectId, p.id)));
  if (!ch || (s.chapterId && s.chapterId !== ch.id)) throw notFound("Chapter");
  return c.json(
    await previewPayload(c.get("deps").db, p, { chapterId: ch.id }, q.cut, p.language, { aspect: q.aspect }),
  );
});

doc({
  method: "GET",
  path: "/api/public/shares/:token/video-card/:which.png",
  summary: "The project's intro or outro video card for a reader link's video preview, at ?height=. No sign-in.",
  tag: "shares",
  auth: false,
});
publicShareRoutes.get("/shares/:token/video-card/:file", async (c) => {
  const { p } = await openShare(c, c.req.param("token"));
  const q = query(c, CardQuery);
  return videoCardResponse(c.get("deps"), p, c.req.param("file").replace(/\.png$/, ""), q, "public, max-age=300");
});

doc({
  method: "GET",
  path: "/api/public/shares/:token/assets/:assetId",
  summary:
    "A panel's artwork or a narration segment's audio from inside a reader link's scope, for its video preview (`?v=web` for the display size). No sign-in.",
  tag: "shares",
  auth: false,
});
publicShareRoutes.get("/shares/:token/assets/:assetId", async (c) => {
  const { s, p } = await openShare(c, c.req.param("token"));
  const id = uuidParam(c, "assetId");
  const { db } = c.get("deps");
  const [a] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.id, id), eq(assets.projectId, p.id)));
  if (!a || a.deletedAt) throw notFound("Asset");
  // Only what the preview plays, and only inside the link's scope: a panel's current artwork, a line's audio, or the
  // project's video watermark.
  if (p.settings.video?.watermark?.assetId === id) return sendAsset(c, a);
  const chapter = s.chapterId ? sql`and pg.chapter_id = ${s.chapterId}` : sql``;
  const [used] = await db.execute<{ ok: number }>(sql`
    select 1 as ok from panels pn join pages pg on pg.id = pn.page_id
      where pn.active_artwork_asset_id = ${id} ${chapter}
    union all
    select 1 from narration_segments ns join narration_lines nl on nl.id = ns.narration_line_id
      where ns.active_audio_asset_id = ${id} ${s.chapterId ? sql`and nl.chapter_id = ${s.chapterId}` : sql``}
    limit 1`);
  if (!used) throw notFound("Asset");
  return sendAsset(c, a);
});
