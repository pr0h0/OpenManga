import { type AnyPgColumn, boolean, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { createdAt, id, ts } from "./common.ts";
import { userServices } from "./mcp.ts";
import { panels } from "./media.ts";
import { projects, shareLinks } from "./projects.ts";

/**
 * A comment on a panel. A thread is a root comment (`threadId` null) and the replies that point at it; resolving is
 * done on the root. The body is the member's own text, shown as text and never as markup. A root deleted while it has
 * replies keeps its row with an empty body and `deletedAt`, so the replies keep their thread. A comment written or a
 * thread resolved through an agent connection (MCP) records that, and which connection: everyone sees that an agent
 * did it, only the member whose connection it was sees which one.
 */
export const panelComments = pgTable(
  "panel_comments",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    panelId: uuid("panel_id")
      .notNull()
      .references(() => panels.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references((): AnyPgColumn => panelComments.id, { onDelete: "cascade" }),
    authorUserId: uuid("author_user_id").references(() => users.id, { onDelete: "set null" }),
    /** A guest's name, for a comment left through a reader link that allows comments (`shareId`); no user then. */
    guestName: text("guest_name"),
    shareId: uuid("share_id").references(() => shareLinks.id, { onDelete: "set null" }),
    body: text("body").notNull(),
    /** Where on the panel's artwork the thread points, as fractions of its width and height (top left 0, 0). */
    anchor: jsonb("anchor").$type<{ x: number; y: number }>(),
    /** The moment in the chapter's video preview the thread is about, in ms from its start. */
    timecodeMs: integer("timecode_ms"),
    /** Who is asked to deal with the thread (first comment only). */
    assigneeUserId: uuid("assignee_user_id").references(() => users.id, { onDelete: "set null" }),
    /** The panel's artwork when the thread was started, and when it was resolved: before and after a fix. */
    artworkAssetId: uuid("artwork_asset_id"),
    resolvedArtworkAssetId: uuid("resolved_artwork_asset_id"),
    /** Members @mentioned in the body, resolved when it was written. */
    mentions: jsonb("mentions").$type<string[]>().notNull().default([]),
    /** Written through an agent connection rather than by hand; kept true after the connection is deleted. */
    viaAgent: boolean("via_agent").notNull().default(false),
    viaServiceId: uuid("via_service_id").references(() => userServices.id, { onDelete: "set null" }),
    resolvedAt: ts("resolved_at"),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    resolvedViaAgent: boolean("resolved_via_agent").notNull().default(false),
    resolvedViaServiceId: uuid("resolved_via_service_id").references(() => userServices.id, { onDelete: "set null" }),
    editedAt: ts("edited_at"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("panel_comments_panel_idx").on(t.panelId, t.createdAt),
    index("panel_comments_project_idx").on(t.projectId, t.resolvedAt),
    index("panel_comments_thread_idx").on(t.threadId),
  ],
);

/** Something for one user to look at: a mention of them, or a reply in a thread they wrote in. */
export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"mention" | "reply" | "assigned" | "guest">().notNull(),
    commentId: uuid("comment_id")
      .notNull()
      .references(() => panelComments.id, { onDelete: "cascade" }),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt, t.createdAt)],
);
