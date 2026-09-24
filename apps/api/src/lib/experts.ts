import { type ChatImage, type ChatMessage, formatPrompt } from "@openmanga/ai-text";
import {
  and,
  asc,
  assets,
  chapters,
  characters,
  characterVersions,
  type Database,
  desc,
  eq,
  expertChats,
  expertMessages,
  inArray,
  isNull,
  locations,
  locationVersions,
  projects,
  props,
} from "@openmanga/db";
import { expertChatV1, splitImagePrompt } from "@openmanga/prompts";
import type { AiChoice } from "@openmanga/services";
import type { Deps } from "../context.ts";

/** The channel an open chat listens on for its reply as it is written. */
export const chatChannel = (chatId: string) => `om:events:chat:${chatId}`;

/**
 * Passes a reply on as it is written: to the page watching the chat (at most every 100 ms), and to the database now
 * and then, so a page that opens mid-reply, or polls instead of listening, still sees it grow.
 */
function streamTo(deps: Deps, run: ReplyRun) {
  let sentAt = 0;
  let savedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let latest = "";
  let stopped = false;
  let saving: Promise<unknown> = Promise.resolve();
  const send = () => {
    timer = null;
    if (stopped) return;
    sentAt = Date.now();
    deps.events.publishTo(chatChannel(run.chatId), { messageId: run.messageId, content: latest }).catch(() => {});
    if (Date.now() - savedAt > 2000) {
      savedAt = Date.now();
      saving = deps.db
        .update(expertMessages)
        .set({ content: latest })
        .where(and(eq(expertMessages.id, run.messageId), eq(expertMessages.status, "pending")))
        .catch(() => {});
    }
  };
  return {
    onText: (soFar: string) => {
      latest = soFar;
      if (timer || stopped) return;
      const wait = 100 - (Date.now() - sentAt);
      if (wait <= 0) send();
      else timer = setTimeout(send, wait);
    },
    /** Once the reply is complete: nothing late may overwrite the final text, so wait out a save under way. */
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      return saving;
    },
  };
}

/** How much of a conversation is sent back with each new message. */
const HISTORY_MESSAGES = 40;
/** Images sent with the conversation: the most recent ones, since each costs input tokens on every reply. */
const HISTORY_IMAGES = 4;
/** A reply still pending after this long was cut off (the server restarted mid-reply) and is shown as failed. */
export const STALE_REPLY_MS = 20 * 60_000;

/**
 * What an expert is told about a project: enough to talk about it (who, where, what happens), not its whole data.
 * Descriptions are cut short so a large project cannot crowd out the conversation.
 */
export async function projectSummary(db: Database, projectId: string) {
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) return null;
  const cut = (s: string | null | undefined, n = 300) => (s ?? "").trim().slice(0, n);
  const cast = await db
    .select({ c: characters, v: characterVersions })
    .from(characters)
    .leftJoin(characterVersions, eq(characterVersions.id, characters.currentVersionId))
    .where(and(eq(characters.projectId, projectId), isNull(characters.deletedAt)))
    .limit(30);
  const places = await db
    .select({ l: locations, v: locationVersions })
    .from(locations)
    .leftJoin(locationVersions, eq(locationVersions.id, locations.currentVersionId))
    .where(and(eq(locations.projectId, projectId), isNull(locations.deletedAt)))
    .limit(30);
  const things = await db
    .select({ name: props.name })
    .from(props)
    .where(and(eq(props.projectId, projectId), isNull(props.deletedAt)))
    .limit(40);
  const chs = await db
    .select({ order: chapters.order, title: chapters.title, summary: chapters.summary })
    .from(chapters)
    .where(eq(chapters.projectId, projectId))
    .orderBy(asc(chapters.order))
    .limit(60);
  return {
    title: p.title,
    description: cut(p.description, 1000),
    type: p.projectType,
    format: p.settings.format,
    language: p.language,
    worldNotes: cut(p.settings.worldNotes, 1500),
    characters: cast.map(({ c, v }) => ({
      name: c.name,
      role: c.role,
      summary: cut(v?.description.summary),
      look: [v?.description.hair, v?.description.eyes, v?.description.wardrobe].filter(Boolean).join("; "),
      personality: cut(v?.description.personality, 200),
    })),
    locations: places.map(({ l, v }) => ({ name: l.name, summary: cut(v?.description.summary) })),
    props: things.map((t) => t.name),
    chapters: chs.map((c) => ({ order: c.order, title: c.title, summary: cut(c.summary, 400) })),
  };
}

export type ReplyRun = {
  chatId: string;
  /** The assistant message being written, created as pending. */
  messageId: string;
  userId: string;
  ai: AiChoice | { manual: true } | null;
  imageAi: AiChoice | null;
};

/** The prompt for the reply in `messageId`: the chat's frame, then every earlier message, with recent images. */
async function buildConversation(deps: Deps, run: ReplyRun) {
  const [chat] = await deps.db.select().from(expertChats).where(eq(expertChats.id, run.chatId));
  if (!chat) throw new Error("Chat no longer exists");
  const [reply] = await deps.db.select().from(expertMessages).where(eq(expertMessages.id, run.messageId));
  if (!reply) throw new Error("Reply no longer exists");
  const earlier = (
    await deps.db
      .select()
      .from(expertMessages)
      .where(eq(expertMessages.chatId, chat.id))
      .orderBy(desc(expertMessages.createdAt))
      .limit(HISTORY_MESSAGES + 1)
  )
    .reverse()
    // Only what was actually said: failed and unanswered replies are not part of the conversation.
    .filter((m) => m.id !== reply.id && m.createdAt <= reply.createdAt && (m.role === "user" || m.status === "done"));
  const project = chat.projectId ? await projectSummary(deps.db, chat.projectId) : null;
  const messages: ChatMessage[] = expertChatV1.build({
    expertPrompt: chat.systemPrompt,
    project,
    wantImage: Boolean(reply.options.generateImage),
    history: earlier.map((m) => ({ role: m.role, content: m.content || "(image)" })),
  });
  // Attach the most recent images the user sent, as small prompt-sized copies. message k+1 is earlier[k].
  let left = HISTORY_IMAGES;
  const params = deps.assets.referenceParams({});
  for (let k = earlier.length - 1; k >= 0 && left > 0; k--) {
    const m = earlier[k]!;
    if (m.role !== "user" || !m.attachments.length) continue;
    const images: ChatImage[] = [];
    for (const id of m.attachments.slice(-left)) {
      const asset = await deps.assets.get(id);
      if (!asset || asset.deletedAt) continue;
      const v = await deps.assets.ensurePromptReference(asset, params);
      images.push({ mime: v.mimeType, data: await deps.assets.readVariant(v), assetId: asset.id });
    }
    left -= images.length;
    messages[k + 1]!.images = images;
  }
  return { chat, reply, messages };
}

/**
 * Writes one reply. Runs after the request that asked for it has returned, so the browser never waits on a model
 * (a reasoning model can think for minutes, longer than a proxy holds a request open); the page polls the chat.
 * Every outcome lands on the message: done, failed with the reason, or waiting for a pasted answer.
 */
export async function runExpertReply(deps: Deps, run: ReplyRun) {
  const fail = (e: unknown) =>
    deps.db
      .update(expertMessages)
      .set({ status: "failed", error: e instanceof Error ? e.message : String(e) })
      .where(eq(expertMessages.id, run.messageId));
  try {
    const { chat, messages } = await buildConversation(deps, run);
    if (run.ai && "manual" in run.ai) {
      // No provider: show the whole conversation to copy into any chat, and wait for its answer to be pasted.
      await deps.db
        .update(expertMessages)
        .set({ status: "awaiting_input", prompt: formatPrompt(messages), provider: "manual", model: "manual" })
        .where(eq(expertMessages.id, run.messageId));
      return;
    }
    const provider = await deps.resolver.text(run.ai ?? { credentialId: null }, run.userId);
    const stream = streamTo(deps, run);
    const r = await provider
      .generateText({ messages, maxTokens: 8000, onText: stream.onText })
      // finally waits for the promise stop returns: a save still under way lands before the final text.
      .finally(() => stream.stop());
    await deps.usage.record({
      provider: r.call.provider,
      model: r.call.model,
      operation: "expert_chat",
      requestId: r.call.requestId,
      projectId: chat.projectId,
      userId: run.userId,
      textInputTokens: r.call.inputTokens,
      textOutputTokens: r.call.outputTokens,
      cachedInputTokens: r.call.cachedTokens,
      rawUsage: r.call.rawUsage,
      latencyMs: r.call.latencyMs,
      success: r.call.success,
      metadata: { templateName: expertChatV1.name, templateVersion: expertChatV1.version, chatId: chat.id },
    });
    await finishReply(deps, run, r.text, { provider: r.call.provider, model: r.call.model });
  } catch (e) {
    deps.logger.warn("expert reply failed", { chatId: run.chatId, error: e instanceof Error ? e.message : String(e) });
    await fail(e).catch(() => {});
  }
}

/**
 * Stores a reply's text (from a provider or pasted), then draws its image when one was asked for. The text is saved
 * first, so a failed image never loses the answer; the image error is kept beside it instead.
 */
export async function finishReply(
  deps: Deps,
  run: Pick<ReplyRun, "chatId" | "messageId" | "userId" | "imageAi">,
  text: string,
  by: {
    provider: string;
    model: string /** Images that came with a pasted answer: kept instead of drawing one. */;
    images?: string[];
  },
) {
  const [reply] = await deps.db.select().from(expertMessages).where(eq(expertMessages.id, run.messageId));
  if (!reply) return;
  const { text: body, imagePrompt } = reply.options.generateImage
    ? splitImagePrompt(text)
    : { text: text.trim(), imagePrompt: null };
  const options = { ...reply.options, ...(imagePrompt ? { imagePrompt } : {}) };
  const brought = by.images ?? [];
  const wantsImage = Boolean(reply.options.generateImage) && !brought.length;
  await deps.db
    .update(expertMessages)
    .set({
      content: body,
      options,
      ...(brought.length ? { images: brought } : {}),
      provider: by.provider,
      model: by.model,
      // Still drawing: the page keeps polling until the image is in.
      status: wantsImage ? "pending" : "done",
      prompt: null,
    })
    .where(eq(expertMessages.id, reply.id));
  await deps.db.update(expertChats).set({ lastMessageAt: new Date() }).where(eq(expertChats.id, run.chatId));
  if (!wantsImage) return;
  try {
    // A reply that forgot its image line still gets a picture: of what it said.
    const prompt = imagePrompt ?? body.slice(0, 1500);
    const [chat] = await deps.db.select().from(expertChats).where(eq(expertChats.id, run.chatId));
    const images = await drawReplyImage(deps, run, prompt, reply.options.aspectRatio ?? 1, chat?.projectId ?? null);
    await deps.db.update(expertMessages).set({ images, status: "done" }).where(eq(expertMessages.id, reply.id));
  } catch (e) {
    await deps.db
      .update(expertMessages)
      .set({ status: "done", options: { ...options, imageError: e instanceof Error ? e.message : String(e) } })
      .where(eq(expertMessages.id, reply.id));
  }
}

/** Draws a reply's image, with the images the user attached in this chat's latest message as references. */
async function drawReplyImage(
  deps: Deps,
  run: Pick<ReplyRun, "chatId" | "messageId" | "userId" | "imageAi">,
  prompt: string,
  aspectRatio: number,
  projectId: string | null,
) {
  const provider = await deps.resolver.image(run.imageAi ?? { credentialId: null }, run.userId);
  const [asked] = await deps.db
    .select({ attachments: expertMessages.attachments })
    .from(expertMessages)
    .where(and(eq(expertMessages.chatId, run.chatId), eq(expertMessages.role, "user")))
    .orderBy(desc(expertMessages.createdAt))
    .limit(1);
  const refs = asked?.attachments.length
    ? await deps.db.select().from(assets).where(inArray(assets.id, asked.attachments))
    : [];
  const params = deps.assets.referenceParams({});
  const references = [];
  for (const a of refs) {
    const v = await deps.assets.ensurePromptReference(a, params);
    references.push({
      data: await deps.assets.readVariant(v),
      mime: v.mimeType,
      label: `reference ${references.length + 1}`,
    });
  }
  const r = await provider.generate({
    prompt,
    aspectRatio,
    quality: deps.config.IMAGE_QUALITY,
    references,
    label: "expert chat image",
  });
  await deps.usage.record({
    provider: r.provider,
    model: r.model,
    operation: "expert_image",
    requestId: r.requestId,
    projectId,
    userId: run.userId,
    textInputTokens: r.usage.textInputTokens,
    imageInputTokens: r.usage.imageInputTokens,
    imageOutputTokens: r.usage.imageOutputTokens,
    textOutputTokens: r.usage.textOutputTokens ?? 0,
    images: 1,
    cachedInputTokens: r.usage.cachedInputTokens,
    rawUsage: r.usage.raw,
    latencyMs: r.latencyMs,
    metadata: { chatId: run.chatId, referenceCount: references.length },
  });
  // Kept with the chat's project when it has one, so the picture shows up in that project's image library too.
  const asset = await deps.assets.store({
    projectId,
    ownerUserId: run.userId,
    type: "source_image",
    data: r.data,
    mimeType: r.mime,
    width: r.width,
    height: r.height,
    metadata: { expertChatId: run.chatId, generated: true, prompt },
  });
  await deps.assets.ensureThumbnail(asset).catch(() => {});
  return [asset.id];
}
