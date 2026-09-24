import { eq, expertChats, expertMessages } from "@openmanga/db";
import { z } from "zod";
import { NewChat } from "../../routes/experts.ts";
import { defineMcpTool, Passthrough, type ToolContext } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { AiInput, aiLabel, cls, ImageAiInput, restAi, textSpend, Uuid } from "./common.ts";

const MESSAGES = 20;

/** A chat's project (null for a general chat); the chat must be the user's own, which the routes check again. */
async function chatProject(ctx: ToolContext, chatId: string) {
  const [c] = await ctx.deps.db
    .select({ p: expertChats.projectId, u: expertChats.userId })
    .from(expertChats)
    .where(eq(expertChats.id, chatId));
  if (!c || c.u !== ctx.actor.user.id) throw toolError(404, "not_found", "Chat not found");
  return c.p;
}

export const expertTools = [
  defineMcpTool({
    name: "list_experts",
    title: "List experts",
    description:
      "The experts available to the user (built-in writing/art/story consultants and their own) and, with chats=true, their existing chats (most recent first; chats about projects this connection cannot see are left out). Read-only.",
    input: z.object({ chats: z.boolean().default(false), limit: z.number().int().min(1).max(100).default(25) }),
    output: Passthrough,
    scopes: ["experts:use"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/experts", "GET /api/expert-chats"],
    actionKeys: [],
    handler: async ({ chats, limit }, ctx) => {
      const experts = await ctx.invoke<{ experts?: Record<string, unknown>[] }>("GET", "/api/experts");
      if (!chats) return { data: experts };
      const r = await ctx.invoke<{ chats: (Record<string, unknown> & { projectId: string | null })[] }>(
        "GET",
        "/api/expert-chats",
      );
      const visible = r.chats.filter(
        (c) => !c.projectId || ctx.actor.projectAccess === "all" || ctx.actor.projectIds.has(c.projectId),
      );
      return {
        data: {
          ...experts,
          chats: visible.slice(0, limit).map(({ systemPrompt: _s, ...c }) => c),
        },
      };
    },
  }),

  defineMcpTool({
    name: "manage_expert_chat",
    title: "Expert chats",
    description:
      "create: start a chat with an expert (built-in key or own expert id), optionally about a project. get: the chat and its latest messages (paginated from the newest; `before` = number of newest messages to skip). rename. delete (delete class).",
    input: z.object({
      action: z.enum(["create", "get", "rename", "delete"]),
      chatId: Uuid.optional(),
      create: NewChat.optional(),
      title: z.string().trim().min(1).max(200).optional(),
      limit: z.number().int().min(1).max(100).default(MESSAGES),
      before: z.number().int().min(0).default(0),
    }),
    output: Passthrough,
    scopes: ["experts:use"],
    sensitivity: "delete",
    idempotent: false,
    routes: [
      "POST /api/expert-chats",
      "GET /api/expert-chats/:id",
      "PATCH /api/expert-chats/:id",
      "DELETE /api/expert-chats/:id",
    ],
    actionKeys: ["expert_chat.create", "expert_chat.rename", "expert_chat.delete"],
    classify: async (a, ctx) => {
      if (a.action === "create")
        return cls("write", "expert_chat.create", a.create?.projectId ?? null, "Start an expert chat");
      const p = await chatProject(ctx, a.chatId ?? "");
      if (a.action === "get") return cls("read", "expert_chat.get", p, "Read a chat");
      return a.action === "delete"
        ? cls("delete", "expert_chat.delete", p, "Delete an expert chat")
        : cls("write", "expert_chat.rename", p, "Rename an expert chat");
    },
    handler: async (a, ctx) => {
      if (a.action === "create") return { data: await ctx.invoke("POST", "/api/expert-chats", { body: a.create }) };
      if (a.action === "delete") return { data: await ctx.invoke("DELETE", `/api/expert-chats/${a.chatId}`) };
      if (a.action === "rename")
        return { data: await ctx.invoke("PATCH", `/api/expert-chats/${a.chatId}`, { body: { title: a.title } }) };
      const r = await ctx.invoke<{ chat: Record<string, unknown>; project: unknown; messages: unknown[] }>(
        "GET",
        `/api/expert-chats/${a.chatId}`,
      );
      const end = r.messages.length - a.before;
      const { systemPrompt: _s, ...chat } = r.chat;
      return {
        data: {
          chat,
          project: r.project,
          messages: r.messages.slice(Math.max(0, end - a.limit), Math.max(0, end)),
          totalMessages: r.messages.length,
          olderRemaining: Math.max(0, end - a.limit),
        },
      };
    },
  }),

  defineMcpTool({
    name: "send_expert_message",
    title: "Message an expert",
    description:
      "Send a message to an expert chat; the reply is written in the background and appears on the chat (read it with manage_expert_chat get after a few seconds). With ai.manual=true the reply waits for you to paste it (answer_expert_reply); with a provider it spends credits (may need approval). generateImage=true also asks for an image (spends image credits). Image attachments must be uploaded in the OpenManga UI.",
    input: z.object({
      chatId: Uuid,
      text: z.string().max(50_000),
      generateImage: z.boolean().default(false),
      aspectRatio: z.number().min(0.25).max(4).default(1),
      ai: AiInput,
      imageAi: ImageAiInput,
    }),
    output: Passthrough,
    scopes: ["experts:use"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/expert-chats/:id/messages"],
    actionKeys: ["expert.message"],
    classify: async ({ chatId, ai, generateImage }, ctx) =>
      cls(
        generateImage ? "spend" : textSpend(ai, "write"),
        "expert.message",
        await chatProject(ctx, chatId),
        `Message an expert ${aiLabel(ai)}${generateImage ? ", with an image (spends image credits)" : ""}`,
      ),
    handler: async ({ chatId, ai, imageAi, ...body }, ctx) => ({
      data: await ctx.invoke("POST", `/api/expert-chats/${chatId}/messages`, {
        body: { ...body, ai: await restAi(ctx, ai), imageAi: await restAi(ctx, imageAi) },
      }),
    }),
  }),

  defineMcpTool({
    name: "answer_expert_reply",
    title: "Paste expert reply",
    description:
      "Give the text of a reply that is waiting for one (a manual-mode expert message). No provider is used. Returns the updated message.",
    input: z.object({ messageId: Uuid, text: z.string().trim().min(1).max(100_000) }),
    output: Passthrough,
    scopes: ["experts:use"],
    sensitivity: "write",
    idempotent: false,
    routes: ["POST /api/expert-messages/:id/answer"],
    actionKeys: ["expert.answer"],
    classify: async ({ messageId }, ctx) => {
      const [m] = await ctx.deps.db
        .select({ chat: expertMessages.chatId })
        .from(expertMessages)
        .where(eq(expertMessages.id, messageId));
      if (!m) throw toolError(404, "not_found", "Message not found");
      return cls("write", "expert.answer", await chatProject(ctx, m.chat), "Answer an expert reply by hand");
    },
    handler: async ({ messageId, text }, ctx) => ({
      data: await ctx.invoke("POST", `/api/expert-messages/${messageId}/answer`, { body: { text } }),
    }),
  }),

  defineMcpTool({
    name: "retry_expert_reply",
    title: "Retry expert reply",
    description:
      "Write the chat's last reply again (after a failure, or for a different answer). A provider run spends credits (may need approval); manual mode does not.",
    input: z.object({ chatId: Uuid, ai: AiInput, generateImage: z.boolean().optional() }),
    output: Passthrough,
    scopes: ["experts:use"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/expert-chats/:id/retry"],
    actionKeys: ["expert.retry"],
    classify: async ({ chatId, ai, generateImage }, ctx) =>
      cls(
        generateImage ? "spend" : textSpend(ai, "write"),
        "expert.retry",
        await chatProject(ctx, chatId),
        `Rewrite the expert's last reply ${aiLabel(ai)}`,
      ),
    handler: async ({ chatId, ai, generateImage }, ctx) => ({
      data: await ctx.invoke("POST", `/api/expert-chats/${chatId}/retry`, {
        body: { ai: await restAi(ctx, ai), generateImage },
      }),
    }),
  }),
];
