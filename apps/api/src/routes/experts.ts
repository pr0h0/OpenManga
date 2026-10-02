import {
  and,
  asc,
  assets,
  desc,
  eq,
  expertChats,
  expertMessages,
  experts,
  generationJobs,
  inArray,
  lt,
  projects,
  sql,
} from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { BUILTIN_EXPERTS, EXPERT_ACTION_KINDS, EXPERT_ACTIONS, findBuiltinExpert } from "@openmanga/prompts";
import {
  outlineText,
  type ProjectConcept,
  type ProjectPremise,
  premiseDescription,
  type StoryOutline,
  type YoutubePackage,
} from "@openmanga/schemas";
import type { AiChoice } from "@openmanga/services";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { AiChoiceInput, assertBudget, assertServerBudget, checkImageChoice, textRun } from "../lib/ai.ts";
import { chatChannel, finishReply, runExpertReply, STALE_REPLY_MS } from "../lib/experts.ts";
import { ApiError, badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { readImageUpload } from "../lib/uploads.ts";
import { createProject, updateProject } from "./projects.ts";
import { createRevision } from "./stories.ts";

export const expertRoutes = new Hono<AppEnv>();

const ExpertInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  systemPrompt: z.string().trim().min(1).max(20_000),
  starters: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
});

async function ownExpert(c: Parameters<typeof user>[0], id: string) {
  const [e] = await c
    .get("deps")
    .db.select()
    .from(experts)
    .where(and(eq(experts.id, id), eq(experts.userId, user(c).id)));
  if (!e) throw notFound("Expert");
  return e;
}

async function ownChat(c: Parameters<typeof user>[0], id: string) {
  const [chat] = await c
    .get("deps")
    .db.select()
    .from(expertChats)
    .where(and(eq(expertChats.id, id), eq(expertChats.userId, user(c).id)));
  if (!chat) throw notFound("Chat");
  return chat;
}

doc({ method: "GET", path: "/api/experts", summary: "Built-in experts and the caller's own", tag: "experts" });
expertRoutes.get("/experts", async (c) => {
  const custom = await c
    .get("deps")
    .db.select()
    .from(experts)
    .where(eq(experts.userId, user(c).id))
    .orderBy(asc(experts.name));
  return c.json({ builtin: BUILTIN_EXPERTS, custom });
});

doc({ method: "POST", path: "/api/experts", summary: "Write your own expert", tag: "experts", body: ExpertInput });
expertRoutes.post("/experts", async (c) => {
  const input = await body(c, ExpertInput);
  const [row] = await c
    .get("deps")
    .db.insert(experts)
    .values({ ...input, userId: user(c).id })
    .returning();
  return c.json({ expert: row }, 201);
});

doc({ method: "PATCH", path: "/api/experts/:id", summary: "Edit your expert", tag: "experts", body: ExpertInput });
expertRoutes.patch("/experts/:id", async (c) => {
  const e = await ownExpert(c, uuidParam(c, "id"));
  const input = await body(c, ExpertInput.partial());
  const [row] = await c
    .get("deps")
    .db.update(experts)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(experts.id, e.id))
    .returning();
  return c.json({ expert: row });
});

doc({
  method: "DELETE",
  path: "/api/experts/:id",
  summary: "Delete your expert; chats with it keep their own copy of its prompt",
  tag: "experts",
});
expertRoutes.delete("/experts/:id", async (c) => {
  const e = await ownExpert(c, uuidParam(c, "id"));
  await c.get("deps").db.delete(experts).where(eq(experts.id, e.id));
  return c.json({ ok: true });
});

doc({
  method: "GET",
  path: "/api/expert-chats",
  summary: "Your chats with experts, most recent first",
  tag: "experts",
});
expertRoutes.get("/expert-chats", async (c) => {
  const rows = await c
    .get("deps")
    .db.select({ chat: expertChats, projectTitle: projects.title })
    .from(expertChats)
    .leftJoin(projects, eq(projects.id, expertChats.projectId))
    .where(eq(expertChats.userId, user(c).id))
    .orderBy(desc(expertChats.updatedAt))
    .limit(500);
  return c.json({ chats: rows.map((r) => ({ ...r.chat, projectTitle: r.projectTitle })) });
});

export const NewChat = z.object({
  /** A built-in expert's key, or the id of one of your own. */
  expert: z.string().min(1).max(100),
  projectId: z.string().uuid().nullable().default(null),
});
doc({
  method: "POST",
  path: "/api/expert-chats",
  summary: "Start a chat with an expert",
  tag: "experts",
  body: NewChat,
});
expertRoutes.post("/expert-chats", async (c) => {
  const input = await body(c, NewChat);
  if (input.projectId) await projectAccess(c, input.projectId, "read");
  const builtin = findBuiltinExpert(input.expert);
  const custom =
    builtin || !z.string().uuid().safeParse(input.expert).success ? null : await ownExpert(c, input.expert);
  if (!builtin && !custom) throw notFound("Expert");
  const [chat] = await c
    .get("deps")
    .db.insert(expertChats)
    .values({
      userId: user(c).id,
      projectId: input.projectId,
      expert: input.expert,
      title: `New chat with ${(builtin ?? custom)!.name}`,
      systemPrompt: (builtin ?? custom)!.systemPrompt,
    })
    .returning();
  return c.json({ chat }, 201);
});

doc({ method: "GET", path: "/api/expert-chats/:id", summary: "A chat and all its messages", tag: "experts" });
expertRoutes.get("/expert-chats/:id", async (c) => {
  const chat = await ownChat(c, uuidParam(c, "id"));
  const { db } = c.get("deps");
  // A reply still pending long after it started was cut off by a restart: say so, so it can be retried.
  const stale = (
    await db
      .select({ id: expertMessages.id, at: expertMessages.createdAt })
      .from(expertMessages)
      .where(and(eq(expertMessages.chatId, chat.id), eq(expertMessages.status, "pending")))
  ).filter((m) => Date.now() - m.at.getTime() > STALE_REPLY_MS);
  if (stale.length)
    await db
      .update(expertMessages)
      .set({ status: "failed", error: "The reply was interrupted (the server restarted). Retry it." })
      .where(
        inArray(
          expertMessages.id,
          stale.map((m) => m.id),
        ),
      );
  const messages = await db
    .select()
    .from(expertMessages)
    .where(eq(expertMessages.chatId, chat.id))
    .orderBy(asc(expertMessages.createdAt));
  const [project] = chat.projectId
    ? await db.select({ id: projects.id, title: projects.title }).from(projects).where(eq(projects.id, chat.projectId))
    : [];
  return c.json({ chat, project: project ?? null, messages, extractions: await extractionsOf(c, messages) });
});

const PatchChat = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  systemPrompt: z.string().trim().min(1).max(20_000).optional(),
  projectId: z.string().uuid().nullable().optional(),
});
doc({
  method: "PATCH",
  path: "/api/expert-chats/:id",
  summary: "Rename a chat, adjust its system prompt, or change the project it is about",
  tag: "experts",
  body: PatchChat,
});
expertRoutes.patch("/expert-chats/:id", async (c) => {
  const chat = await ownChat(c, uuidParam(c, "id"));
  const input = await body(c, PatchChat);
  if (input.projectId) await projectAccess(c, input.projectId, "read");
  const [row] = await c
    .get("deps")
    .db.update(expertChats)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(expertChats.id, chat.id))
    .returning();
  return c.json({ chat: row });
});

doc({ method: "DELETE", path: "/api/expert-chats/:id", summary: "Delete a chat", tag: "experts" });
expertRoutes.delete("/expert-chats/:id", async (c) => {
  const chat = await ownChat(c, uuidParam(c, "id"));
  await c.get("deps").db.delete(expertChats).where(eq(expertChats.id, chat.id));
  return c.json({ ok: true });
});

doc({
  method: "POST",
  path: "/api/expert-chats/:id/attachments",
  summary: "Upload an image to send with a message (multipart `file`)",
  tag: "experts",
});
expertRoutes.post("/expert-chats/:id/attachments", async (c) => {
  const chat = await ownChat(c, uuidParam(c, "id"));
  const up = await readImageUpload(c);
  const deps = c.get("deps");
  const asset = await deps.assets.store({
    projectId: chat.projectId,
    ownerUserId: user(c).id,
    type: "source_image",
    data: up.data,
    mimeType: up.mime,
    width: up.width,
    height: up.height,
    metadata: { uploaded: true, originalName: up.originalName, expertChatId: chat.id },
  });
  await deps.assets.ensureThumbnail(asset).catch(() => {});
  return c.json({ asset: { id: asset.id, width: asset.width, height: asset.height } }, 201);
});

export const Send = z.object({
  text: z.string().max(50_000).default(""),
  /** Images uploaded to this chat (or any image you own) to send with the message. */
  attachments: z.array(z.string().uuid()).max(8).default([]),
  generateImage: z.boolean().default(false),
  aspectRatio: z.number().min(0.25).max(4).default(1),
  ai: AiChoiceInput,
  imageAi: AiChoiceInput,
});

const choiceOf = (ai: AiChoiceInput | undefined): AiChoice | null =>
  ai?.credentialId ? { credentialId: ai.credentialId, model: ai.model ?? undefined } : null;

/** Validates the text and image choices up front, so a bad key fails the request rather than the reply. */
async function replyChoices(
  c: Parameters<typeof user>[0],
  input: { ai?: AiChoiceInput; imageAi?: AiChoiceInput },
  image: boolean,
) {
  const text = await textRun(c, input.ai);
  if (image) await checkImageChoice(c, input.imageAi);
  const ai = text.parameters.ai as AiChoice | { manual: true } | undefined;
  return { ai: ai ?? null, imageAi: choiceOf(input.imageAi) };
}

doc({
  method: "POST",
  path: "/api/expert-chats/:id/messages",
  summary: "Send a message; the reply is written in the background and appears on the chat",
  tag: "experts",
  body: Send,
});
expertRoutes.post("/expert-chats/:id/messages", async (c) => {
  const chat = await ownChat(c, uuidParam(c, "id"));
  const input = await body(c, Send);
  if (!input.text.trim() && !input.attachments.length) throw badRequest("Write a message or attach an image");
  const deps = c.get("deps");
  if (input.attachments.length) {
    const mine = await deps.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(inArray(assets.id, input.attachments), eq(assets.ownerUserId, user(c).id)));
    if (mine.length !== new Set(input.attachments).size) throw notFound("Attachment");
  }
  const busy = await deps.db
    .select({ id: expertMessages.id })
    .from(expertMessages)
    .where(and(eq(expertMessages.chatId, chat.id), inArray(expertMessages.status, ["pending", "awaiting_input"])))
    .limit(1);
  if (busy.length) throw conflict("The expert is still answering the last message");
  const choices = await replyChoices(c, input, input.generateImage);
  const [sent] = await deps.db
    .insert(expertMessages)
    .values({ chatId: chat.id, role: "user", content: input.text.trim(), attachments: input.attachments })
    .returning();
  const [reply] = await deps.db
    .insert(expertMessages)
    .values({
      chatId: chat.id,
      role: "assistant",
      status: "pending",
      options: { generateImage: input.generateImage, aspectRatio: input.aspectRatio },
      // A moment after the question, so the two always sort in the order they were said.
      createdAt: new Date(sent!.createdAt.getTime() + 1),
    })
    .returning();
  const first = await deps.db
    .select({ id: expertMessages.id })
    .from(expertMessages)
    .where(and(eq(expertMessages.chatId, chat.id), eq(expertMessages.role, "user")))
    .limit(2);
  await deps.db
    .update(expertChats)
    .set({
      updatedAt: new Date(),
      lastMessageAt: new Date(),
      // The first message names the chat, until it is renamed.
      ...(first.length === 1 && input.text.trim()
        ? { title: input.text.trim().replace(/\s+/g, " ").slice(0, 80) }
        : {}),
    })
    .where(eq(expertChats.id, chat.id));
  void runExpertReply(deps, { chatId: chat.id, messageId: reply!.id, userId: user(c).id, ...choices });
  return c.json({ message: sent, reply }, 202);
});

/** Each open stream holds a Redis connection: a few per user is plenty, since only a chat being answered needs one. */
const MAX_CHAT_STREAMS_PER_USER = 4;
const chatStreams = new Map<string, number>();

doc({
  method: "GET",
  path: "/api/expert-chats/:id/stream",
  summary: "The reply being written, as it arrives (server-sent events: {messageId, content so far})",
  tag: "experts",
});
expertRoutes.get("/expert-chats/:id/stream", async (c) => {
  const chat = await ownChat(c, uuidParam(c, "id"));
  const deps = c.get("deps");
  const userId = user(c).id;
  const open = chatStreams.get(userId) ?? 0;
  if (open >= MAX_CHAT_STREAMS_PER_USER)
    throw new ApiError(429, "too_many_streams", "Too many chats are streaming. Close a tab and try again.");
  chatStreams.set(userId, open + 1);
  c.header("x-accel-buffering", "no");
  c.header("cache-control", "no-cache, no-transform");
  return streamSSE(c, async (stream) => {
    let latest: string | null = null;
    let wake: (() => void) | null = null;
    // Only the newest text matters: an update replaces one not yet sent instead of queueing behind it.
    const unsubscribe = deps.events.subscribeTo(deps.config.REDIS_URL, chatChannel(chat.id), (msg) => {
      latest = msg;
      wake?.();
    });
    let closed = false;
    stream.onAbort(() => {
      closed = true;
      wake?.();
    });
    try {
      // "ready" means listening: a reply sent right after it must not be published before the subscription exists.
      await unsubscribe.ready;
      await stream.writeSSE({ event: "ready", data: JSON.stringify({ chatId: chat.id }) });
      let lastPing = Date.now();
      while (!closed) {
        if (latest === null)
          await new Promise<void>((r) => {
            wake = r;
            setTimeout(r, 15_000);
          });
        wake = null;
        if (latest !== null) {
          const data: string = latest;
          latest = null;
          await stream.writeSSE({ event: "message", data });
        }
        if (Date.now() - lastPing > 14_000) {
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
          lastPing = Date.now();
        }
      }
    } finally {
      await unsubscribe();
      chatStreams.set(userId, Math.max(0, (chatStreams.get(userId) ?? 1) - 1));
    }
  });
});

const Retry = Send.pick({ ai: true, imageAi: true, generateImage: true, aspectRatio: true }).partial({
  generateImage: true,
  aspectRatio: true,
});
doc({
  method: "POST",
  path: "/api/expert-chats/:id/retry",
  summary: "Write the last reply again (after a failure, or to get a different answer)",
  tag: "experts",
  body: Retry,
});
expertRoutes.post("/expert-chats/:id/retry", async (c) => {
  const chat = await ownChat(c, uuidParam(c, "id"));
  const input = await body(c, Retry);
  const deps = c.get("deps");
  const [last] = await deps.db
    .select()
    .from(expertMessages)
    .where(eq(expertMessages.chatId, chat.id))
    .orderBy(desc(expertMessages.createdAt))
    .limit(1);
  if (last?.role !== "assistant") throw badRequest("There is no reply to write again");
  if (last.status === "pending") throw conflict("The expert is still answering");
  const generateImage = input.generateImage ?? Boolean(last.options.generateImage);
  const choices = await replyChoices(c, input, generateImage);
  const [reply] = await deps.db
    .update(expertMessages)
    .set({
      status: "pending",
      content: "",
      error: null,
      images: [],
      prompt: null,
      options: { generateImage, aspectRatio: input.aspectRatio ?? last.options.aspectRatio ?? 1 },
    })
    .where(eq(expertMessages.id, last.id))
    .returning();
  void runExpertReply(deps, { chatId: chat.id, messageId: last.id, userId: user(c).id, ...choices });
  return c.json({ reply }, 202);
});

export const Answer = z
  .object({
    text: z.string().trim().max(100_000).default(""),
    /** Images the other chat made, uploaded to this chat first: they become the reply's images. */
    images: z.array(z.string().uuid()).max(8).default([]),
    imageAi: AiChoiceInput,
  })
  .refine((a) => a.text || a.images.length, "Paste the answer's text, or upload its image");
doc({
  method: "POST",
  path: "/api/expert-messages/:id/answer",
  summary: "Paste the answer to a reply that is waiting for one (no API key needed)",
  tag: "experts",
  body: Answer,
});
expertRoutes.post("/expert-messages/:id/answer", async (c) => {
  const id = uuidParam(c, "id");
  const deps = c.get("deps");
  const [m] = await deps.db.select().from(expertMessages).where(eq(expertMessages.id, id));
  if (!m) throw notFound("Message");
  const chat = await ownChat(c, m.chatId);
  if (m.status !== "awaiting_input") throw conflict("This reply is not waiting for an answer");
  const input = await body(c, Answer);
  if (input.images.length) {
    const mine = await deps.db
      .select({ id: assets.id })
      .from(assets)
      .where(and(inArray(assets.id, input.images), eq(assets.ownerUserId, user(c).id)));
    if (mine.length !== new Set(input.images).size) throw notFound("Image");
  }
  // The answer's image is the one uploaded with it. Otherwise it is drawn with the image key given here, and without
  // one the text is kept and the reply says why it has no picture.
  const imageAi = choiceOf(input.imageAi);
  await finishReply(deps, { chatId: chat.id, messageId: m.id, userId: user(c).id, imageAi }, input.text, {
    provider: "manual",
    model: "manual",
    images: input.images,
  });
  const [row] = await deps.db.select().from(expertMessages).where(eq(expertMessages.id, m.id));
  return c.json({ reply: row });
});

// ---------------------------------------------------------------- output actions

/** The extraction jobs run on a chat's replies, newest first: what the chat shows under each reply. */
async function extractionsOf(c: Parameters<typeof user>[0], messages: { id: string; role: string }[]) {
  const ids = messages.filter((m) => m.role === "assistant").map((m) => m.id);
  if (!ids.length) return [];
  const rows = await c
    .get("deps")
    .db.select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.kind, "expert_extract"),
        eq(generationJobs.userId, user(c).id),
        inArray(generationJobs.targetId, ids),
      ),
    )
    .orderBy(desc(generationJobs.createdAt))
    .limit(200);
  return rows.map(extractionView);
}

/** An extraction job as the chat shows it: the action, its state, and once done the object to review and apply. */
export const extractionView = (j: typeof generationJobs.$inferSelect) => ({
  id: j.id,
  messageId: j.targetId,
  projectId: j.projectId,
  action: String(j.input.action),
  status: j.status,
  manual: j.parameters.manual === true,
  result: (j.result as { data?: unknown } | null)?.data ?? null,
  applied: (j.result as { applied?: Applied } | null)?.applied ?? null,
  failureReason: j.failureReason,
  createdAt: j.createdAt,
});

export const Extract = z.object({
  /** concept: a new project; premise: the project's description; outline: an outline story revision; youtube: the YouTube package text. */
  action: z.enum(EXPERT_ACTION_KINDS),
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/expert-messages/:id/extract",
  summary:
    "Turn an expert's reply into something to apply: a new project's concept, the project's premise, an outline or the YouTube package text. Queues a text job (provider key or paste mode) whose result you review; nothing is applied until you call the usual route with it.",
  tag: "experts",
  body: Extract,
});
expertRoutes.post("/expert-messages/:id/extract", async (c) => {
  const id = uuidParam(c, "id");
  const deps = c.get("deps");
  const [m] = await deps.db.select().from(expertMessages).where(eq(expertMessages.id, id));
  if (!m) throw notFound("Message");
  const chat = await ownChat(c, m.chatId);
  const input = await body(c, Extract);
  if (m.role !== "assistant" || m.status !== "done" || !m.content.trim())
    throw conflict("Only a finished reply from the expert can be turned into something");
  const spec = EXPERT_ACTIONS[input.action];
  if (spec.needsProject && !chat.projectId)
    throw badRequest("This chat is not about a project. Choose the project it is about first.");
  // Run inside the chat's project when it has one (its budget, its Generation page); a concept from a chat about
  // no project is the user's own job.
  if (chat.projectId) {
    await projectAccess(c, chat.projectId, "generate");
    await assertBudget(c, chat.projectId);
  } else await assertServerBudget(c);
  const run = await textRun(c, input.ai);
  const [question] = await deps.db
    .select({ content: expertMessages.content })
    .from(expertMessages)
    .where(
      and(
        eq(expertMessages.chatId, chat.id),
        eq(expertMessages.role, "user"),
        lt(expertMessages.createdAt, m.createdAt),
      ),
    )
    .orderBy(desc(expertMessages.createdAt))
    .limit(1);
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(tx, {
      projectId: chat.projectId,
      userId: user(c).id,
      kind: "expert_extract",
      priority: PRIORITY.single,
      targetType: "expert_message",
      targetId: m.id,
      templateName: spec.template.name,
      templateVersion: spec.template.version,
      provider: run.provider,
      model: run.model,
      parameters: run.parameters,
      // The reply is copied here: retrying it later rewrites the message, and this job extracts what was shown.
      input: {
        action: input.action,
        chatId: chat.id,
        messageId: m.id,
        reply: m.content,
        question: question?.content ?? "",
      },
    }),
  );
  await deps.jobs.kick();
  return c.json({ job, extraction: extractionView(job) }, 202);
});

/** What applying an extraction did, kept on its job so it is never applied twice by accident. */
type Applied = {
  at: string;
  /** How many times it has been applied (more than once only when asked to apply it again). */
  count: number;
  /** True while an apply is under way: a second one is refused rather than run beside it. */
  pending?: boolean;
  projectId?: string;
  revisionId?: string;
};

export const ApplyExtraction = z.object({
  /** The extracted object as the user edited it; omitted, the job's own result is applied. */
  data: z.record(z.string(), z.unknown()).optional(),
  /** Apply an extraction that was already applied, once more (a second project, a second revision…). */
  again: z.boolean().default(false),
  /** concept: move the chat to the new project. */
  attachChat: z.boolean().default(false),
});
doc({
  method: "POST",
  path: "/api/expert-extractions/:id/apply",
  summary:
    "Apply a completed expert extraction (optionally edited): create the project, replace the description or YouTube text, or save the outline revision. Recorded on the job; applying it again is refused with 409 unless again=true.",
  tag: "experts",
  body: ApplyExtraction,
});
expertRoutes.post("/expert-extractions/:id/apply", async (c) => {
  const id = uuidParam(c, "id");
  const input = await body(c, ApplyExtraction);
  const { db } = c.get("deps");
  const [job] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
  if (job?.kind !== "expert_extract" || job.userId !== user(c).id) throw notFound("Extraction");
  if (job.status !== "completed")
    throw conflict(`This extraction is ${job.status}; only a completed one can be applied`);
  const action = String(job.input.action) as keyof typeof EXPERT_ACTIONS;
  const parsed = EXPERT_ACTIONS[action].schema.safeParse(input.data ?? (job.result as { data?: unknown }).data);
  if (!parsed.success) throw new ApiError(422, "validation_error", "Invalid data for this action", parsed.error.issues);
  if (action !== "concept" && !job.projectId) throw conflict("This extraction belongs to no project");
  const before = (job.result as { applied?: Applied }).applied ?? null;
  // Claimed before anything changes, in one statement: two clicks (or an agent retrying) cannot both apply it.
  const [claimed] = await db
    .update(generationJobs)
    .set({
      result: sql`${generationJobs.result} || jsonb_build_object('applied', ${JSON.stringify({
        at: new Date().toISOString(),
        count: before?.count ?? 0,
        pending: true,
      })}::jsonb)`,
    })
    .where(
      and(
        eq(generationJobs.id, job.id),
        input.again
          ? sql`coalesce(${generationJobs.result}->'applied'->>'pending', 'false') <> 'true'`
          : sql`${generationJobs.result}->'applied' is null`,
      ),
    )
    .returning({ id: generationJobs.id });
  if (!claimed) {
    const [now] = await db
      .select({ result: generationJobs.result })
      .from(generationJobs)
      .where(eq(generationJobs.id, id));
    const was = (now?.result as { applied?: Applied } | null)?.applied;
    throw new ApiError(
      409,
      "already_applied",
      was?.pending
        ? "This extraction is being applied right now."
        : `This extraction was already applied (${was?.at ?? "earlier"}). Apply it again only on purpose: pass again=true.`,
      { applied: was ?? null },
    );
  }
  const created: Pick<Applied, "projectId" | "revisionId"> = {};
  try {
    if (action === "concept") {
      const k = parsed.data as ProjectConcept;
      const project = await createProject(c, {
        title: k.title,
        description: premiseDescription(k),
        projectType: k.projectType,
        format: k.format,
        language: "en",
        colorMode: "full_color",
        customStyle: "",
        story: { content: k.storyIdea, inputKind: "idea", title: k.title },
      });
      created.projectId = project.id;
      const chatId = String(job.input.chatId ?? "");
      if (input.attachChat && chatId)
        await db
          .update(expertChats)
          .set({ projectId: project.id, updatedAt: new Date() })
          .where(and(eq(expertChats.id, chatId), eq(expertChats.userId, user(c).id)));
    } else if (action === "outline") {
      const o = parsed.data as StoryOutline;
      const rev = await createRevision(c, job.projectId!, {
        content: outlineText(o),
        title: o.title,
        inputKind: "outline",
      });
      Object.assign(created, { projectId: job.projectId!, revisionId: rev.id });
    } else {
      await updateProject(
        c,
        job.projectId!,
        action === "premise"
          ? { description: premiseDescription(parsed.data as ProjectPremise) }
          : { settings: { youtubePackage: parsed.data as YoutubePackage } },
      );
      created.projectId = job.projectId!;
    }
  } catch (e) {
    // Nothing was applied: put back what was recorded before, so it can be applied (or applied again) once fixed.
    await db
      .update(generationJobs)
      .set({
        result: before
          ? sql`${generationJobs.result} || jsonb_build_object('applied', ${JSON.stringify(before)}::jsonb)`
          : sql`${generationJobs.result} - 'applied'`,
      })
      .where(eq(generationJobs.id, job.id));
    throw e;
  }
  const applied: Applied = { at: new Date().toISOString(), count: (before?.count ?? 0) + 1, ...created };
  const [row] = await db
    .update(generationJobs)
    .set({ result: sql`${generationJobs.result} || jsonb_build_object('applied', ${JSON.stringify(applied)}::jsonb)` })
    .where(eq(generationJobs.id, job.id))
    .returning();
  return c.json({ extraction: extractionView(row!), applied });
});
