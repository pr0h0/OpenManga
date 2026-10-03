import { eq, expertChats, expertMessages, generationJobs } from "@openmanga/db";
import { EXPERT_ACTION_KINDS, type ExpertAction } from "@openmanga/prompts";
import { z } from "zod";
import { NewChat } from "../../routes/experts.ts";
import { defineMcpTool, Passthrough, type ToolContext } from "../registry.ts";
import { toolError } from "../runtime.ts";
import type { McpScope } from "../scopes.ts";
import {
  AiInput,
  aiLabel,
  cls,
  grantProject,
  ImageAiInput,
  jobView,
  links,
  requireCreate,
  restAi,
  textSpend,
  Uuid,
} from "./common.ts";

const MESSAGES = 20;

/** What applying each action needs: a new project, the project's settings, or its story. */
const APPLY_SCOPES: Record<ExpertAction, McpScope> = {
  concept: "projects:create",
  premise: "projects:write",
  outline: "story:write",
  youtube: "projects:write",
};
const APPLY_SUMMARY: Record<ExpertAction, string> = {
  concept: "Create a new project from an expert's concept",
  premise: "Replace the project description with an expert's premise",
  outline: "Save an expert's outline as a new story revision",
  youtube: "Replace the project's YouTube package text with an expert's",
};

/** An extraction job of this user's, with what it extracted. */
async function extraction(ctx: ToolContext, jobId: string) {
  const [j] = await ctx.deps.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  if (j?.kind !== "expert_extract" || j.userId !== ctx.actor.user.id)
    throw toolError(404, "not_found", "Expert extraction not found");
  return j;
}

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

  defineMcpTool({
    name: "use_expert_reply",
    title: "Use an expert reply",
    description:
      "Turn an expert's reply into something applied, in two steps. extract: queue a text job that reads the reply (messageId, from manage_expert_chat get) as action concept (a new project: title, logline, premise, type, format, story idea), premise (a new logline and premise for the chat's project), outline (chapters, for a new outline story revision) or youtube (the project's YouTube package text). premise, outline and youtube need a chat about a project. Asynchronous: poll get_job; with ai.manual=true answer it via get_manual_prompt / submit_manual_answer (no spending); a provider run spends credits (may need approval). The completed job's result.data is the extracted object: show it to the user. apply: after the user agrees, apply the job's result (jobId and the same action; pass data to apply an edited version) through the normal routes: concept creates the project with the story idea as its first revision (needs permission to create projects), premise replaces the project description, outline adds a story revision, youtube replaces settings.youtubePackage. apply is sensitive (may need approval). Each extraction is applied once: applying it again is refused with already_applied (409, details.applied says when and what it created) unless again=true, which you pass only when the user explicitly asks to apply it a second time.",
    input: z.object({
      mode: z.enum(["extract", "apply"]),
      action: z.enum(EXPERT_ACTION_KINDS),
      messageId: Uuid.optional().describe("extract: the expert's reply."),
      jobId: Uuid.optional().describe("apply: the completed extraction job."),
      data: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("apply: an edited version of the job's result.data, checked against the same schema."),
      again: z
        .boolean()
        .default(false)
        .describe(
          "apply: apply an extraction that was already applied, once more. Only when the user explicitly asks for it.",
        ),
      ai: AiInput,
    }),
    output: Passthrough,
    scopes: ["experts:use", "projects:create", "projects:write", "story:write"],
    scopesFor: (a) => (a.mode === "extract" ? ["experts:use"] : ["experts:use", APPLY_SCOPES[a.action]]),
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/expert-messages/:id/extract", "POST /api/expert-extractions/:id/apply"],
    actionKeys: [
      "expert.extract",
      "expert.apply_concept",
      "expert.apply_premise",
      "expert.apply_outline",
      "expert.apply_youtube",
    ],
    classify: async (a, ctx) => {
      if (a.mode === "extract") {
        const [m] = await ctx.deps.db
          .select({ chat: expertMessages.chatId })
          .from(expertMessages)
          .where(eq(expertMessages.id, a.messageId ?? ""));
        if (!m) throw toolError(404, "not_found", "Message not found");
        return cls(
          textSpend(a.ai, "write"),
          "expert.extract",
          await chatProject(ctx, m.chat),
          `Read an expert's reply as ${a.action} ${aiLabel(a.ai)}`,
        );
      }
      const j = await extraction(ctx, a.jobId ?? "");
      const applied = (j.result as { applied?: { count?: number } } | null)?.applied;
      return cls(
        "sensitive-write",
        `expert.apply_${a.action}`,
        j.projectId,
        `${APPLY_SUMMARY[a.action]}${a.again ? " (again: it was already applied)" : ""}`,
        // Applied by someone else while this waited makes the request stale instead of applying it twice.
        { target: { status: j.status, applied: applied?.count ?? 0 } },
      );
    },
    handler: async (a, ctx) => {
      if (a.mode === "extract") {
        if (!a.messageId) throw toolError(400, "bad_request", "messageId is required");
        const r = await ctx.invoke<{ job: Record<string, unknown> }>(
          "POST",
          `/api/expert-messages/${a.messageId}/extract`,
          { body: { action: a.action, ai: await restAi(ctx, a.ai) } },
        );
        return {
          data: { job: jobView(r.job), next: "Poll get_job until completed, then show result.data to the user." },
        };
      }
      const j = await extraction(ctx, a.jobId ?? "");
      if (String(j.input.action) !== a.action)
        throw toolError(400, "bad_request", `This job extracted a ${String(j.input.action)}, not a ${a.action}`);
      if (a.action === "concept") requireCreate(ctx);
      const r = await ctx.invoke<{ applied: { projectId?: string; revisionId?: string } }>(
        "POST",
        `/api/expert-extractions/${j.id}/apply`,
        { body: { data: a.data, again: a.again } },
      );
      const projectId = r.applied.projectId;
      if (a.action === "concept" && projectId) await grantProject(ctx, projectId);
      return { data: r, links: projectId ? { project: links(ctx).project(projectId) } : undefined };
    },
  }),
];
