import { randomBytes } from "node:crypto";
import {
  and,
  asc,
  assets,
  chapters,
  desc,
  eq,
  inArray,
  isNull,
  notifications,
  pages,
  panelComments,
  panels,
  projectMembers,
  projects,
  shareLinks,
  sql,
} from "@openmanga/db";
import { cachedPageRender, recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { badRequest, body, notFound, query, user, uuidParam } from "../lib/http.ts";
import { failureGuard, rateLimit } from "../lib/middleware.ts";
import { doc } from "../lib/openapi.ts";
import { sendAsset } from "./assets.ts";
import { CommentAnchor, CommentBody, commentFields } from "./comments.ts";
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

const CreateShare = z.object({
  chapterId: z.string().uuid().nullable().default(null),
  /** Whoever opens the link may leave comments under a name they give, without an account. */
  allowComments: z.boolean().default(false),
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/shares",
  summary: "Create an unlisted, read-only reader link to the project or one chapter (owners only)",
  tag: "shares",
  body: CreateShare,
});
shareRoutes.post("/projects/:projectId/shares", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "manage");
  const { chapterId, allowComments } = await body(c, CreateShare);
  if (chapterId) {
    const owner = await entityAccess(c, "chapter", chapterId, "read");
    if (owner.id !== p.id) throw notFound("Chapter");
  }
  const { db } = c.get("deps");
  const [share] = await db
    .insert(shareLinks)
    .values({
      projectId: p.id,
      chapterId,
      allowComments,
      token: randomBytes(18).toString("base64url"),
      createdByUserId: user(c).id,
    })
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

const PatchShare = z.object({ allowComments: z.boolean() });
doc({
  method: "PATCH",
  path: "/api/shares/:id",
  summary: "Allow or stop guest comments on a reader link (owners only); comments already left stay",
  tag: "shares",
  body: PatchShare,
});
shareRoutes.patch("/shares/:id", async (c) => {
  const { db } = c.get("deps");
  const [share] = await db
    .select()
    .from(shareLinks)
    .where(eq(shareLinks.id, uuidParam(c, "id")));
  if (!share || share.revokedAt) throw notFound("Link");
  await projectAccess(c, share.projectId, "manage");
  const { allowComments } = await body(c, PatchShare);
  const [row] = await db.update(shareLinks).set({ allowComments }).where(eq(shareLinks.id, share.id)).returning();
  return c.json({ share: row });
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
  // With comments allowed, a guest picks the panel a comment is about.
  const pns =
    s.allowComments && pgs.length
      ? await db
          .select({ id: panels.id, pageId: panels.pageId, order: panels.order })
          .from(panels)
          .where(
            inArray(
              panels.pageId,
              pgs.map((pg) => pg.id),
            ),
          )
          .orderBy(asc(panels.order))
      : [];
  return c.json({
    allowComments: s.allowComments,
    project: {
      title: p.title,
      description: p.description,
      author: p.settings.author ?? "",
      readingDirection: p.readingDirection,
      format: p.settings.format,
    },
    chapters: chs.map((ch) => ({
      ...ch,
      pages: pgs
        .filter((pg) => pg.chapterId === ch.id)
        .map((pg) => ({
          ...pg,
          panels: pns.filter((pn) => pn.pageId === pg.id).map(({ id, order }) => ({ id, order })),
        })),
    })),
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

// ---------------------------------------------------------------- guest comments

/** No account: viewer-specific fields (an agent connection's name) resolve to nothing for a guest. */
const NOBODY = "00000000-0000-0000-0000-000000000000";

/** A panel within the link's scope, on a link that allows comments; anything else is not found. */
async function guestPanel(c: Parameters<typeof uuidParam>[0], token: string, panelId: string) {
  const { s, p } = await openShare(c, token);
  if (!s.allowComments) throw notFound("Comments");
  const [pn] = await c
    .get("deps")
    .db.select({ id: panels.id, chapterId: pages.chapterId, art: panels.activeArtworkAssetId })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .where(and(eq(panels.id, panelId), eq(panels.projectId, p.id)));
  if (!pn || (s.chapterId && s.chapterId !== pn.chapterId)) throw notFound("Panel");
  return { s, p, pn };
}

/**
 * A comment as a guest sees it: an allowlist (names, words, where and when), never account ids, assignees or agent
 * connection details, so a field added to comments later stays private until it is added here.
 */
const forGuest = (r: {
  id: string;
  panelId: string;
  threadId: string | null;
  guestName: string | null;
  author: string | null;
  authorName: string | null;
  body: string;
  anchor: { x: number; y: number } | null;
  resolvedAt: Date | null;
  editedAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
}) => ({
  id: r.id,
  panelId: r.panelId,
  threadId: r.threadId,
  guestName: r.guestName,
  // A member is shown by their display name only: a username is a sign-in name, not for anyone holding the link.
  author: null,
  authorName: r.guestName ? null : r.authorName,
  body: r.deletedAt ? "" : r.body,
  anchor: r.anchor,
  resolvedAt: r.resolvedAt,
  editedAt: r.editedAt,
  deletedAt: r.deletedAt,
  createdAt: r.createdAt,
});

const GuestList = z.object({ pageId: z.string().uuid() });
doc({
  method: "GET",
  path: "/api/public/shares/:token/comments",
  summary:
    "On a reader link that allows comments: the threads guests started through this link on one page (?pageId=), with every reply, members' included. Other comments of the project are not shown. No sign-in.",
  tag: "shares",
  auth: false,
  query: GuestList,
});
publicShareRoutes.get("/shares/:token/comments", async (c) => {
  const { s } = await openShare(c, c.req.param("token"));
  if (!s.allowComments) throw notFound("Comments");
  const { pageId } = query(c, GuestList);
  const rows = await c
    .get("deps")
    .db.select(commentFields(NOBODY))
    .from(panelComments)
    .innerJoin(panels, eq(panels.id, panelComments.panelId))
    .where(
      and(
        eq(panels.pageId, pageId),
        sql`coalesce(${panelComments.threadId}, ${panelComments.id}) in (select id from panel_comments where share_id = ${s.id} and thread_id is null)`,
      ),
    )
    .orderBy(asc(panelComments.createdAt));
  const pub = rows.map(forGuest);
  const threads = pub
    .filter((r) => !r.threadId)
    .map((t) => ({ ...t, replies: pub.filter((r) => r.threadId === t.id) }));
  return c.json({ threads });
});

const GuestComment = z.object({
  panelId: z.string().uuid(),
  name: z.string().trim().min(1).max(60),
  body: CommentBody,
  /** Reply to a thread guests started through this link. */
  threadId: z.string().uuid().optional(),
  anchor: CommentAnchor.optional(),
});
/** Anyone with the link can post: a tight per-address limit keeps a script from flooding the project. */
const guestLimit = rateLimit({ key: "guest-comment", limit: () => 10, windowSec: 600, by: "ip" });
doc({
  method: "POST",
  path: "/api/public/shares/:token/comments",
  summary:
    "On a reader link that allows comments: leave a comment on a panel under a name, or reply to a thread started through this link. The project's owner is notified, and so is every member who replied. Plain text, at most 10 per 10 minutes per address. No sign-in.",
  tag: "shares",
  auth: false,
  body: GuestComment,
});
publicShareRoutes.post("/shares/:token/comments", guestLimit, async (c) => {
  const input = await body(c, GuestComment);
  const { s, p, pn } = await guestPanel(c, c.req.param("token"), input.panelId);
  const { db } = c.get("deps");
  let participants: string[] = [];
  if (input.threadId) {
    const [root] = await db.select().from(panelComments).where(eq(panelComments.id, input.threadId));
    if (!root || root.threadId || root.shareId !== s.id || root.panelId !== pn.id) throw notFound("Thread");
    if (input.anchor) throw badRequest("A spot belongs on a thread's first comment");
    participants = (
      await db.select({ u: panelComments.authorUserId }).from(panelComments).where(eq(panelComments.threadId, root.id))
    )
      .map((r) => r.u)
      .filter((u): u is string => Boolean(u));
  }
  const [comment] = await db
    .insert(panelComments)
    .values({
      projectId: p.id,
      panelId: pn.id,
      threadId: input.threadId ?? null,
      authorUserId: null,
      guestName: input.name,
      shareId: s.id,
      body: input.body,
      anchor: input.anchor ?? null,
      artworkAssetId: input.threadId ? null : pn.art,
    })
    .returning();
  // The owner hears about every guest comment; members who replied in the thread hear about replies to it.
  const members = new Set(
    (await db.select({ id: projectMembers.userId }).from(projectMembers).where(eq(projectMembers.projectId, p.id))).map(
      (m) => m.id,
    ),
  );
  const to = [...new Set([p.ownerUserId, ...participants])].filter((u) => members.has(u));
  if (to.length)
    await db.insert(notifications).values(
      to.map((userId) => ({
        userId,
        kind: "guest" as const,
        projectId: p.id,
        commentId: comment!.id,
        actorUserId: null,
      })),
    );
  await db
    .select({ pageId: panels.pageId })
    .from(panels)
    .where(eq(panels.id, pn.id))
    .then(([r]) =>
      c.get("deps").events.publish(p.id, { type: "comment.updated", panelId: pn.id, pageId: r?.pageId ?? null }),
    )
    .catch(() => {});
  const [view] = await db.select(commentFields(NOBODY)).from(panelComments).where(eq(panelComments.id, comment!.id));
  return c.json({ comment: forGuest(view!) }, 201);
});
