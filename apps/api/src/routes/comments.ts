import {
  and,
  asc,
  chapters,
  count,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notifications,
  pages,
  panelComments,
  panels,
  projectMembers,
  projects,
  sql,
  users,
} from "@openmanga/db";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { badRequest, body, forbidden, notFound, query, user, uuidParam } from "../lib/http.ts";
import { rateLimit } from "../lib/middleware.ts";
import { doc } from "../lib/openapi.ts";

/**
 * Panel comments. Every member can read and write them, viewers included: commenting is how a viewer takes part, so
 * these routes need only `read`. You edit and delete your own; the owner can also delete anyone's.
 */
export const commentRoutes = new Hono<AppEnv>();

/** A burst of comments is a script, not a person. */
const commentLimit = rateLimit({ key: "comment", limit: () => 60, windowSec: 60, by: "user" });

export const CommentBody = z.string().trim().min(1).max(4000);
const MENTION = /(?:^|[^\w@.])@([a-z0-9_][a-z0-9_.-]{2,31})/gi;

/** The project's members (with the owner), as mention targets and for keeping notifications to current members. */
async function membersOf(c: Context<AppEnv>, projectId: string) {
  return c
    .get("deps")
    .db.select({ id: users.id, username: users.username })
    .from(projectMembers)
    .innerJoin(users, eq(users.id, projectMembers.userId))
    .where(eq(projectMembers.projectId, projectId));
}

/** Member ids @mentioned in a body. A name that is not a member of the project mentions nobody. */
function mentionsIn(text: string, members: { id: string; username: string }[]) {
  const names = new Set([...text.matchAll(MENTION)].map((m) => m[1]!.toLowerCase().replace(/[.-]+$/, "")));
  return members.filter((m) => names.has(m.username)).map((m) => m.id);
}

async function notify(
  c: Context<AppEnv>,
  comment: { id: string; projectId: string },
  rows: { userId: string; kind: "mention" | "reply" }[],
) {
  const me = user(c).id;
  const seen = new Set<string>();
  const values = rows.filter((r) => r.userId !== me && !seen.has(r.userId) && seen.add(r.userId));
  if (values.length)
    await c
      .get("deps")
      .db.insert(notifications)
      .values(values.map((v) => ({ ...v, projectId: comment.projectId, commentId: comment.id, actorUserId: me })));
}

async function publish(c: Context<AppEnv>, projectId: string, panelId: string) {
  const [p] = await c.get("deps").db.select({ pageId: panels.pageId }).from(panels).where(eq(panels.id, panelId));
  await c
    .get("deps")
    .events.publish(projectId, { type: "comment.updated", panelId, pageId: p?.pageId ?? null })
    .catch(() => {});
}

const author = sql<string | null>`(select u.username from users u where u.id = ${panelComments.authorUserId})`;
const authorName = sql<string | null>`(select u.display_name from users u where u.id = ${panelComments.authorUserId})`;
const resolver = sql<string | null>`(select u.username from users u where u.id = ${panelComments.resolvedByUserId})`;
/**
 * A comment as `me` sees it. `viaAgent` says a comment was written (or its thread resolved) through an agent
 * connection; the connection's name is shown only to the member it belongs to, everyone else sees just that an agent
 * did it. Connection ids never leave the server.
 */
const commentFields = (me: string) => ({
  id: panelComments.id,
  projectId: panelComments.projectId,
  panelId: panelComments.panelId,
  threadId: panelComments.threadId,
  authorUserId: panelComments.authorUserId,
  author,
  authorName,
  body: panelComments.body,
  mentions: panelComments.mentions,
  viaAgent: panelComments.viaAgent,
  agentName: sql<string | null>`(select s.name from user_services s
    where s.id = ${panelComments.viaServiceId} and s.user_id = ${me} and ${panelComments.authorUserId} = ${me})`,
  resolvedAt: panelComments.resolvedAt,
  resolvedBy: resolver,
  resolvedViaAgent: panelComments.resolvedViaAgent,
  resolvedAgentName: sql<string | null>`(select s.name from user_services s
    where s.id = ${panelComments.resolvedViaServiceId} and s.user_id = ${me} and ${panelComments.resolvedByUserId} = ${me})`,
  editedAt: panelComments.editedAt,
  deletedAt: panelComments.deletedAt,
  createdAt: panelComments.createdAt,
});

/** One comment as the caller sees it, for answers to a write. */
async function viewOf(c: Context<AppEnv>, id: string) {
  const [row] = await c
    .get("deps")
    .db.select(commentFields(user(c).id))
    .from(panelComments)
    .where(eq(panelComments.id, id));
  return row!;
}

/** The agent connection a request came through (an MCP tool call), or null for the app itself. */
const agentOf = (c: Context<AppEnv>) => c.get("service")?.serviceId ?? null;

doc({
  method: "GET",
  path: "/api/panels/:id/comments",
  summary: "A panel's comment threads, oldest first, each with its replies (any member)",
  tag: "comments",
});
commentRoutes.get("/panels/:id/comments", async (c) => {
  const panelId = uuidParam(c, "id");
  await entityAccess(c, "panel", panelId, "read");
  const rows = await c
    .get("deps")
    .db.select(commentFields(user(c).id))
    .from(panelComments)
    .where(eq(panelComments.panelId, panelId))
    .orderBy(asc(panelComments.createdAt));
  const threads = rows
    .filter((r) => !r.threadId)
    .map((root) => ({ ...root, replies: rows.filter((r) => r.threadId === root.id) }));
  return c.json({ threads });
});

const NewComment = z.object({
  body: CommentBody,
  /** Reply to this thread (its first comment's id); omit to start a thread. */
  threadId: z.string().uuid().optional(),
});
doc({
  method: "POST",
  path: "/api/panels/:id/comments",
  summary: "Start a comment thread on a panel, or reply to one; @username mentions a member (any member, viewers too)",
  tag: "comments",
  body: NewComment,
});
commentRoutes.post("/panels/:id/comments", commentLimit, async (c) => {
  const panelId = uuidParam(c, "id");
  const p = await entityAccess(c, "panel", panelId, "read");
  const input = await body(c, NewComment);
  const { db } = c.get("deps");
  const me = user(c).id;
  let participants: string[] = [];
  if (input.threadId) {
    const thread = await db
      .select({ id: panelComments.id, threadId: panelComments.threadId, author: panelComments.authorUserId })
      .from(panelComments)
      .where(
        and(
          eq(panelComments.panelId, panelId),
          sql`(${panelComments.id} = ${input.threadId} or ${panelComments.threadId} = ${input.threadId})`,
        ),
      );
    const root = thread.find((t) => t.id === input.threadId);
    if (!root) throw notFound("Thread");
    if (root.threadId) throw badRequest("Reply to the thread's first comment");
    participants = thread.map((t) => t.author).filter((a): a is string => Boolean(a));
  }
  const members = await membersOf(c, p.id);
  const mentions = mentionsIn(input.body, members);
  const [comment] = await db
    .insert(panelComments)
    .values({
      projectId: p.id,
      panelId,
      threadId: input.threadId ?? null,
      authorUserId: me,
      body: input.body,
      mentions,
      viaAgent: Boolean(agentOf(c)),
      viaServiceId: agentOf(c),
    })
    .returning();
  const current = new Set(members.map((m) => m.id));
  await notify(c, comment!, [
    ...mentions.map((userId) => ({ userId, kind: "mention" as const })),
    ...participants.filter((u) => current.has(u)).map((userId) => ({ userId, kind: "reply" as const })),
  ]);
  await publish(c, p.id, panelId);
  return c.json({ comment: await viewOf(c, comment!.id) }, 201);
});

async function ownComment(c: Context<AppEnv>, id: string, mayModerate = false) {
  const [comment] = await c.get("deps").db.select().from(panelComments).where(eq(panelComments.id, id));
  if (!comment || comment.deletedAt) throw notFound("Comment");
  await projectAccess(c, comment.projectId, "read");
  if (comment.authorUserId !== user(c).id) {
    // The owner may remove anyone's comment; nobody edits someone else's words.
    if (!mayModerate) throw forbidden();
    await projectAccess(c, comment.projectId, "manage");
  }
  return comment;
}

const EditComment = z.object({ body: CommentBody });
doc({
  method: "PATCH",
  path: "/api/comments/:id",
  summary: "Edit your own comment",
  tag: "comments",
  body: EditComment,
});
commentRoutes.patch("/comments/:id", commentLimit, async (c) => {
  const comment = await ownComment(c, uuidParam(c, "id"));
  const input = await body(c, EditComment);
  const mentions = mentionsIn(input.body, await membersOf(c, comment.projectId));
  const [row] = await c
    .get("deps")
    .db.update(panelComments)
    .set({ body: input.body, mentions, editedAt: new Date() })
    .where(eq(panelComments.id, comment.id))
    .returning();
  // Only someone newly mentioned hears about an edit.
  await notify(
    c,
    comment,
    mentions.filter((m) => !comment.mentions.includes(m)).map((userId) => ({ userId, kind: "mention" as const })),
  );
  await publish(c, comment.projectId, comment.panelId);
  return c.json({ comment: await viewOf(c, row!.id) });
});

doc({
  method: "DELETE",
  path: "/api/comments/:id",
  summary: "Delete your own comment (owners can delete any). A thread's first comment with replies is blanked instead.",
  tag: "comments",
});
commentRoutes.delete("/comments/:id", async (c) => {
  const comment = await ownComment(c, uuidParam(c, "id"), true);
  const { db } = c.get("deps");
  const [reply] = comment.threadId
    ? []
    : await db
        .select({ id: panelComments.id })
        .from(panelComments)
        .where(eq(panelComments.threadId, comment.id))
        .limit(1);
  if (reply)
    await db
      .update(panelComments)
      .set({ body: "", mentions: [], deletedAt: new Date() })
      .where(eq(panelComments.id, comment.id));
  else await db.delete(panelComments).where(eq(panelComments.id, comment.id));
  await publish(c, comment.projectId, comment.panelId);
  return c.json({ ok: true });
});

const Resolve = z.object({ resolved: z.boolean() });
doc({
  method: "POST",
  path: "/api/comments/:id/resolve",
  summary: "Resolve or reopen a comment's thread (any member)",
  tag: "comments",
  body: Resolve,
});
commentRoutes.post("/comments/:id/resolve", async (c) => {
  const { db } = c.get("deps");
  const [comment] = await db
    .select()
    .from(panelComments)
    .where(eq(panelComments.id, uuidParam(c, "id")));
  if (!comment) throw notFound("Comment");
  await projectAccess(c, comment.projectId, "read");
  const { resolved } = await body(c, Resolve);
  const [root] = await db
    .update(panelComments)
    .set(
      resolved
        ? {
            resolvedAt: new Date(),
            resolvedByUserId: user(c).id,
            resolvedViaAgent: Boolean(agentOf(c)),
            resolvedViaServiceId: agentOf(c),
          }
        : { resolvedAt: null, resolvedByUserId: null, resolvedViaAgent: false, resolvedViaServiceId: null },
    )
    .where(eq(panelComments.id, comment.threadId ?? comment.id))
    .returning();
  await publish(c, comment.projectId, comment.panelId);
  return c.json({ comment: await viewOf(c, root!.id) });
});

const ListQuery = z.object({
  status: z.enum(["open", "resolved", "all"]).default("open"),
  chapterId: z.string().uuid().optional(),
});
doc({
  method: "GET",
  path: "/api/projects/:projectId/comments",
  summary: "The project's comment threads (open by default), newest activity first, with where each one is",
  tag: "comments",
  query: ListQuery,
});
commentRoutes.get("/projects/:projectId/comments", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, ListQuery);
  const rows = await c
    .get("deps")
    .db.select({
      ...commentFields(user(c).id),
      pageId: pages.id,
      pageOrder: pages.order,
      panelOrder: panels.order,
      chapterId: chapters.id,
      chapterOrder: chapters.order,
      chapterTitle: chapters.title,
      replies: sql<number>`(select count(*)::int from panel_comments r where r.thread_id = ${panelComments.id})`,
      lastActivityAt: sql<string>`greatest(${panelComments.createdAt}, (select max(r.created_at) from panel_comments r where r.thread_id = ${panelComments.id}))`,
    })
    .from(panelComments)
    .innerJoin(panels, eq(panels.id, panelComments.panelId))
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .innerJoin(chapters, eq(chapters.id, pages.chapterId))
    .where(
      and(
        eq(panelComments.projectId, p.id),
        isNull(panelComments.threadId),
        q.status === "open"
          ? isNull(panelComments.resolvedAt)
          : q.status === "resolved"
            ? isNotNull(panelComments.resolvedAt)
            : undefined,
        q.chapterId ? eq(chapters.id, q.chapterId) : undefined,
      ),
    )
    .orderBy(desc(panelComments.createdAt))
    .limit(200);
  return c.json({ threads: rows.sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt))) });
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/comment-counts",
  summary: "Open comment threads per panel and per page, for badges",
  tag: "comments",
});
commentRoutes.get("/projects/:projectId/comment-counts", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const rows = await c
    .get("deps")
    .db.select({ panelId: panelComments.panelId, pageId: panels.pageId, n: count() })
    .from(panelComments)
    .innerJoin(panels, eq(panels.id, panelComments.panelId))
    .where(and(eq(panelComments.projectId, p.id), isNull(panelComments.threadId), isNull(panelComments.resolvedAt)))
    .groupBy(panelComments.panelId, panels.pageId);
  const byPanel: Record<string, number> = {};
  const byPage: Record<string, number> = {};
  for (const r of rows) {
    byPanel[r.panelId] = r.n;
    byPage[r.pageId] = (byPage[r.pageId] ?? 0) + r.n;
  }
  return c.json({ panels: byPanel, pages: byPage });
});

// ---- Notifications: mentions and replies, for the signed-in user.

doc({
  method: "GET",
  path: "/api/notifications",
  summary: "Your recent mentions and replies (newest first) and how many are unread",
  tag: "comments",
});
commentRoutes.get("/notifications", async (c) => {
  const me = user(c).id;
  const { db } = c.get("deps");
  // Only projects you are still in: leaving one takes its comments out of your view.
  const mine = and(
    eq(notifications.userId, me),
    inArray(
      notifications.projectId,
      db.select({ id: projectMembers.projectId }).from(projectMembers).where(eq(projectMembers.userId, me)),
    ),
  );
  const rows = await db
    .select({
      id: notifications.id,
      kind: notifications.kind,
      readAt: notifications.readAt,
      createdAt: notifications.createdAt,
      actor: sql<string | null>`(select u.username from users u where u.id = ${notifications.actorUserId})`,
      projectId: notifications.projectId,
      projectTitle: projects.title,
      commentId: panelComments.id,
      body: panelComments.body,
      // Who notified you is never you, so the connection is never named here.
      viaAgent: panelComments.viaAgent,
      panelId: panelComments.panelId,
      pageId: panels.pageId,
    })
    .from(notifications)
    .innerJoin(projects, eq(projects.id, notifications.projectId))
    .innerJoin(panelComments, eq(panelComments.id, notifications.commentId))
    .innerJoin(panels, eq(panels.id, panelComments.panelId))
    .where(mine)
    .orderBy(desc(notifications.createdAt))
    .limit(50);
  const [unread] = await db
    .select({ n: count() })
    .from(notifications)
    .where(and(mine, isNull(notifications.readAt)));
  return c.json({
    notifications: rows.map((r) => ({ ...r, body: r.body.slice(0, 200) })),
    unread: unread?.n ?? 0,
  });
});

const MarkRead = z.object({ ids: z.array(z.string().uuid()).max(200).optional() });
doc({
  method: "POST",
  path: "/api/notifications/read",
  summary: "Mark notifications read: the given ids, or all of them",
  tag: "comments",
  body: MarkRead,
});
commentRoutes.post("/notifications/read", async (c) => {
  const { ids } = await body(c, MarkRead);
  await c
    .get("deps")
    .db.update(notifications)
    .set({ readAt: new Date() })
    .where(
      and(
        eq(notifications.userId, user(c).id),
        isNull(notifications.readAt),
        ids ? inArray(notifications.id, ids.length ? ids : [crypto.randomUUID()]) : undefined,
      ),
    );
  return c.json({ ok: true });
});
