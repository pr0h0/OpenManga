import { randomBytes } from "node:crypto";
import { and, asc, chapters, desc, eq, inArray, isNull, pages, projects, shareLinks } from "@openmanga/db";
import { loadRenderPage, recordAudit, renderPageImage } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { body, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/** Managing a project's read-only links: signed-in members only. */
export const shareRoutes = new Hono<AppEnv>();

doc({ method: "GET", path: "/api/projects/:projectId/shares", summary: "The project's reader links", tag: "shares" });
shareRoutes.get("/projects/:projectId/shares", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
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
  const [row] = await db
    .select({ s: shareLinks, p: projects })
    .from(shareLinks)
    .innerJoin(projects, eq(projects.id, shareLinks.projectId))
    .where(and(eq(shareLinks.token, token), isNull(shareLinks.revokedAt), isNull(projects.deletedAt)));
  if (!row) throw notFound("Link");
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
    .select({ width: pages.width, chapterId: pages.chapterId })
    .from(pages)
    .where(and(eq(pages.id, pageId), eq(pages.projectId, p.id)));
  if (!page || (s.chapterId && page.chapterId !== s.chapterId)) throw notFound("Page");
  // Rendered per request, like the editor preview, and cached by the browser for five minutes. If a popular link
  // ever loads the server noticeably, keep the render as an asset variant instead.
  const render = await loadRenderPage(db, assets.storage, pageId, p.readingDirection);
  const img = await renderPageImage(render, "png", { scale: Math.min(1, width / page.width) });
  return new Response(img.data, {
    headers: { "content-type": "image/png", "cache-control": "public, max-age=300" },
  });
});
