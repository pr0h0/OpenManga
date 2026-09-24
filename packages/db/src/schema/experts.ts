import { index, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { createdAt, id, ts, updatedAt } from "./common.ts";
import { projects } from "./projects.ts";

/** An expert a user wrote: a named system prompt to brainstorm with, beside the built-in ones. */
export const experts = pgTable(
  "experts",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    systemPrompt: text("system_prompt").notNull(),
    /** Openers offered on an empty chat with this expert. */
    starters: jsonb("starters").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("experts_user_idx").on(t.userId)],
);

/**
 * A conversation with an expert. It keeps its own copy of the system prompt, so editing or deleting the expert later
 * never changes a chat already under way, and the prompt can be adjusted for one chat alone.
 */
export const expertChats = pgTable(
  "expert_chats",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** The project being talked about, if any: its summary is sent as context. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    /** A built-in expert's key, or a custom expert's id. */
    expert: text("expert").notNull(),
    title: text("title").notNull().default("New chat"),
    systemPrompt: text("system_prompt").notNull(),
    lastMessageAt: ts("last_message_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("expert_chats_user_idx").on(t.userId, t.updatedAt)],
);

export type ExpertMessageStatus = "done" | "pending" | "awaiting_input" | "failed";
export type ExpertMessageOptions = {
  /** Asked for an image with the reply. */
  generateImage?: boolean;
  aspectRatio?: number;
  /** The prompt the reply wrote for its image. */
  imagePrompt?: string;
  imageError?: string;
};

export const expertMessages = pgTable(
  "expert_messages",
  {
    id: id(),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => expertChats.id, { onDelete: "cascade" }),
    role: text("role").$type<"user" | "assistant">().notNull(),
    content: text("content").notNull().default(""),
    status: text("status").$type<ExpertMessageStatus>().notNull().default("done"),
    error: text("error"),
    /** Images the user attached (asset ids). */
    attachments: jsonb("attachments").$type<string[]>().notNull().default([]),
    /** Images the reply produced (asset ids). */
    images: jsonb("images").$type<string[]>().notNull().default([]),
    options: jsonb("options").$type<ExpertMessageOptions>().notNull().default({}),
    /** A reply waiting to be pasted: the whole conversation as it would have been sent. */
    prompt: text("prompt"),
    provider: text("provider"),
    model: text("model"),
    createdAt: createdAt(),
  },
  (t) => [index("expert_messages_chat_idx").on(t.chatId, t.createdAt)],
);
