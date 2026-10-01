import { afterAll, beforeAll, expect, test } from "bun:test";
import { aiUsage, and, eq, isNull, sql } from "@openmanga/db";
import { mockImagePng } from "@openmanga/testing";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let bob: TestClient;
let projectId: string;

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  status: string;
  error: string | null;
  attachments: string[];
  images: string[];
  options: { generateImage?: boolean; aspectRatio?: number; imagePrompt?: string; imageError?: string };
  prompt: string | null;
};
type Chat = { id: string; title: string; systemPrompt: string; projectId: string | null };

const newChat = async (expert: string, project: string | null = null) =>
  (await alice.post<{ chat: Chat }>("/api/expert-chats", { expert, projectId: project }, 201)).chat;
const send = (chatId: string, body: Record<string, unknown>) =>
  alice.post<{ reply: Message }>(`/api/expert-chats/${chatId}/messages`, body, 202);
/** The chat once its last reply is no longer being written. */
const settled = (chatId: string) =>
  waitFor(
    async () => {
      const r = await alice.get<{ messages: Message[] }>(`/api/expert-chats/${chatId}`);
      const last = r.messages.at(-1)!;
      return last.status === "pending" ? null : r.messages;
    },
    { label: "expert reply", timeoutMs: 30_000 },
  );

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  bob = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "asker", email: "asker@example.com", password: "ask-pass-123" },
    201,
  );
  await bob.post(
    "/api/auth/register",
    { username: "other", email: "other@example.com", password: "other-pass-12" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Vell Light" }, 201);
  projectId = p.project.id;
});
afterAll(() => h?.stop());

test("the built-in experts are offered, each with a prompt and openers", async () => {
  const r = await alice.get<{ builtin: { key: string; systemPrompt: string; starters: string[] }[] }>("/api/experts");
  const keys = r.builtin.map((e) => e.key);
  for (const k of ["topic-scout", "title-doctor", "thumbnail-designer", "story-developer"]) expect(keys).toContain(k);
  expect(r.builtin.every((e) => e.systemPrompt.length > 100 && e.starters.length > 0)).toBe(true);
});

test("a chat about a project answers with the project in view, and is kept to come back to", async () => {
  const chat = await newChat("title-doctor", projectId);
  expect(chat.systemPrompt).toContain("You are the Title Doctor");
  await send(chat.id, { text: "Better titles for chapter 1?" });
  const messages = await settled(chat.id);
  expect(messages.map((m) => [m.role, m.status])).toEqual([
    ["user", "done"],
    ["assistant", "done"],
  ]);
  expect(messages[1]!.content).toContain("Mock expert reply to: Better titles for chapter 1?");
  expect(messages[1]!.content).toContain('About your project "Vell Light"');
  // The first message names the chat, and the chat is listed with its project.
  const list = await alice.get<{ chats: (Chat & { projectTitle: string })[] }>("/api/expert-chats");
  const listed = list.chats.find((c) => c.id === chat.id)!;
  expect(listed.title).toBe("Better titles for chapter 1?");
  expect(listed.projectTitle).toBe("Vell Light");
  // A follow-up carries the conversation.
  await send(chat.id, { text: "Shorter ones" });
  expect((await settled(chat.id)).length).toBe(4);
});

test("'generate image' draws one from the prompt the reply wrote, at the chosen shape", async () => {
  const chat = await newChat("thumbnail-designer");
  await send(chat.id, { text: "Hero holding a burning letter", generateImage: true, aspectRatio: 16 / 9 });
  const reply = (await settled(chat.id)).at(-1)!;
  expect(reply.status).toBe("done");
  expect(reply.options.imagePrompt).toContain("a mock illustration of Hero holding a burning letter");
  // The prompt line is taken out of the text shown.
  expect(reply.content).not.toContain("IMAGE PROMPT:");
  expect(reply.images).toHaveLength(1);
  const img = await alice.raw("GET", `/cdn/a/${reply.images[0]}`);
  expect(img.status).toBe(200);
  // An image from a chat with no project is its owner's alone.
  expect((await bob.raw("GET", `/cdn/a/${reply.images[0]}`)).status).toBe(404);
  const [usage] = await h.deps.db
    .select()
    .from(aiUsage)
    .where(and(eq(aiUsage.operation, "expert_image"), isNull(aiUsage.projectId)));
  expect(usage).toBeTruthy();
});

test("attached images go with the message", async () => {
  const chat = await newChat("character-designer");
  const f = new FormData();
  f.set(
    "file",
    new File([(await mockImagePng({ width: 64, height: 64, prompt: "sketch" })) as BlobPart], "s.png", {
      type: "image/png",
    }),
  );
  const up = await alice.json<{ asset: { id: string } }>("POST", `/api/expert-chats/${chat.id}/attachments`, f, 201);
  await send(chat.id, { text: "What do you think of this design?", attachments: [up.asset.id] });
  const [asked, reply] = await settled(chat.id);
  expect(asked!.attachments).toEqual([up.asset.id]);
  expect(reply!.status).toBe("done");
  // Someone else's image cannot be attached.
  const other = await newChat("character-designer");
  const bobChat = (await bob.post<{ chat: Chat }>("/api/expert-chats", { expert: "beta-reader" }, 201)).chat;
  const bf = new FormData();
  bf.set(
    "file",
    new File([(await mockImagePng({ width: 64, height: 64, prompt: "b" })) as BlobPart], "b.png", {
      type: "image/png",
    }),
  );
  const bobs = await bob.json<{ asset: { id: string } }>(
    "POST",
    `/api/expert-chats/${bobChat.id}/attachments`,
    bf,
    201,
  );
  await alice.post(`/api/expert-chats/${other.id}/messages`, { text: "look", attachments: [bobs.asset.id] }, 404);
});

test("with no key, the reply waits for an answer pasted from any chat", async () => {
  const chat = await newChat("topic-scout");
  await send(chat.id, { text: "Premises for a heist story", ai: { manual: true } });
  const waiting = (await settled(chat.id)).at(-1)!;
  expect(waiting.status).toBe("awaiting_input");
  // The whole conversation, ready to copy: the frame, the expert, and the question.
  expect(waiting.prompt).toContain("YOUR ROLE:");
  expect(waiting.prompt).toContain("development scout");
  expect(waiting.prompt).toContain("Premises for a heist story");
  // Nothing else is sent while it waits.
  await alice.post(`/api/expert-chats/${chat.id}/messages`, { text: "and another" }, 409);
  const r = await alice.post<{ reply: Message }>(`/api/expert-messages/${waiting.id}/answer`, {
    text: "1. The vault that robs back.",
  });
  expect(r.reply.status).toBe("done");
  expect(r.reply.content).toBe("1. The vault that robs back.");
});

test("a reply can be written again", async () => {
  const chat = await newChat("hook-editor");
  await send(chat.id, { text: "Where would a reader leave?" });
  await settled(chat.id);
  const again = await alice.post<{ reply: Message }>(`/api/expert-chats/${chat.id}/retry`, {}, 202);
  expect(again.reply.status).toBe("pending");
  const messages = await settled(chat.id);
  expect(messages).toHaveLength(2);
  expect(messages[1]!.status).toBe("done");
});

test("your own experts: write one, chat with it, and the chat keeps its prompt after the expert is gone", async () => {
  const e = await alice.post<{ expert: { id: string } }>(
    "/api/experts",
    { name: "Pun Master", description: "Chapter titles as puns", systemPrompt: "You only answer in puns." },
    201,
  );
  const chat = await newChat(e.expert.id);
  expect(chat.systemPrompt).toBe("You only answer in puns.");
  // Adjusting the prompt for one chat leaves the expert alone.
  await alice.patch(`/api/expert-chats/${chat.id}`, { systemPrompt: "Puns, but gentle ones." });
  await alice.del(`/api/experts/${e.expert.id}`);
  const kept = await alice.get<{ chat: Chat }>(`/api/expert-chats/${chat.id}`);
  expect(kept.chat.systemPrompt).toBe("Puns, but gentle ones.");
  // Another user sees neither the expert nor the chat.
  await bob.get(`/api/expert-chats/${chat.id}`, 404);
  await bob.post("/api/expert-chats", { expert: e.expert.id }, 404);
});

test("a pasted answer can bring the image the other chat made", async () => {
  const chat = await newChat("thumbnail-designer");
  await send(chat.id, { text: "A thumbnail for chapter 3", generateImage: true, ai: { manual: true } });
  const waiting = (await settled(chat.id)).at(-1)!;
  expect(waiting.status).toBe("awaiting_input");
  const f = new FormData();
  f.set(
    "file",
    new File([(await mockImagePng({ width: 96, height: 54, prompt: "made elsewhere" })) as BlobPart], "t.png", {
      type: "image/png",
    }),
  );
  const up = await alice.json<{ asset: { id: string } }>("POST", `/api/expert-chats/${chat.id}/attachments`, f, 201);
  const r = await alice.post<{ reply: Message }>(`/api/expert-messages/${waiting.id}/answer`, {
    text: "Concept: her face lit by the flames.\n\nIMAGE PROMPT: close-up of a woman lit by a burning letter",
    images: [up.asset.id],
  });
  expect(r.reply.status).toBe("done");
  expect(r.reply.images).toEqual([up.asset.id]);
  expect(r.reply.content).toBe("Concept: her face lit by the flames.");
  expect(r.reply.options.imagePrompt).toBe("close-up of a woman lit by a burning letter");
});

test("a reply can be watched as it is written", async () => {
  const chat = await newChat("story-developer");
  const res = await alice.raw("GET", `/api/expert-chats/${chat.id}/stream`);
  expect(res.status).toBe(200);
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  const long = "Outline a story about a lighthouse keeper whose light starts showing ships that sank long ago";
  // "ready" means the stream is listening; a reply sent before it could start unheard.
  let buf = "";
  while (!buf.includes("event: ready")) buf += (await reader.read()).value ?? "";
  buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
  await send(chat.id, { text: long });
  const seen: string[] = [];
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    for (const block of buf.split("\n\n").slice(0, -1)) {
      const data = block
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice(5)
        .trim();
      if (block.includes("event: message") && data) seen.push((JSON.parse(data) as { content: string }).content);
    }
    buf = buf.slice(buf.lastIndexOf("\n\n") + 2);
    if (seen.at(-1)?.endsWith(long)) break;
  }
  await reader.cancel();
  // It arrived in pieces, each one longer than the last, ending with the whole answer.
  expect(seen.length).toBeGreaterThan(1);
  for (let i = 1; i < seen.length; i++) expect(seen[i]!.length).toBeGreaterThanOrEqual(seen[i - 1]!.length);
  expect(seen.at(-1)).toContain("Mock expert reply to: Outline a story");
  const final = (await settled(chat.id)).at(-1)!;
  expect(final.status).toBe("done");
  expect(final.content.startsWith(seen[0]!)).toBe(true);
  // The stream ends on the whole reply, not on whatever was sent last before it finished.
  expect(seen.at(-1)).toBe(final.content);
  // Someone else cannot listen in.
  expect((await bob.raw("GET", `/api/expert-chats/${chat.id}/stream`)).status).toBe(404);
});

test("a chat about a project gets its art style, and its images draw named characters from their references", async () => {
  const c = await alice.post<{ character: { id: string; currentVersionId: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Doyun", description: { hair: "short black hair" } },
    201,
  );
  const gen = await alice.post<{ job: { id: string } }>(
    `/api/character-versions/${c.character.currentVersionId}/references/generate`,
    { kind: "portrait" },
    202,
  );
  await waitFor(
    async () => {
      const r = await alice.get<{ job: { status: string } }>(`/api/generations/${gen.job.id}`);
      return r.job.status === "completed" ? r : null;
    },
    { label: "portrait", timeoutMs: 30_000 },
  );
  const detail = await alice.get<{ references: { id: string }[] }>(`/api/characters/${c.character.id}`);
  await alice.post(`/api/references/${detail.references[0]!.id}/status`, { status: "approved" });

  // The expert is told the art style (seen in the conversation a pasted answer is written from).
  const asked = await newChat("character-designer", projectId);
  await send(asked.id, { text: "Design Doyun's rival", ai: { manual: true } });
  const waiting = (await settled(asked.id)).at(-1)!;
  expect(waiting.prompt).toContain('"artStyle":');
  expect(waiting.prompt).toContain("[template:expert-chat-v2]");

  // Naming him in the image prompt sends his approved reference with it.
  const chat = await newChat("thumbnail-designer", projectId);
  await send(chat.id, { text: "Doyun at the lighthouse door", generateImage: true, aspectRatio: 16 / 9 });
  const reply = (await settled(chat.id)).at(-1)!;
  expect(reply.images).toHaveLength(1);
  const [usage] = await h.deps.db.execute<{ refs: number }>(
    sql`select (metadata->>'referenceCount')::int as refs from ai_usage
        where operation = 'expert_image' and metadata->>'chatId' = ${chat.id}`,
  );
  expect(usage!.refs).toBeGreaterThanOrEqual(1);
});

// ---------------------------------------------------------------- output actions

type Extraction = {
  id: string;
  messageId: string;
  projectId: string | null;
  action: string;
  status: string;
  manual: boolean;
  result: Record<string, unknown> | null;
  failureReason: string | null;
};
const extract = (messageId: string, action: string, ai?: Record<string, unknown>) =>
  alice.post<{ extraction: Extraction }>(`/api/expert-messages/${messageId}/extract`, { action, ai }, 202);
/** The extraction once it has finished, or is waiting for a pasted answer. */
const extracted = (chatId: string, id: string) =>
  waitFor(
    async () => {
      const r = await alice.get<{ extractions: Extraction[] }>(`/api/expert-chats/${chatId}`);
      const e = r.extractions.find((x) => x.id === id);
      return e && ["completed", "failed", "awaiting_input"].includes(e.status) ? e : null;
    },
    { label: "expert extraction", timeoutMs: 30_000 },
  );

test("a concept in a reply becomes a new project, and only once it is applied", async () => {
  const chat = await newChat("topic-scout");
  await send(chat.id, { text: "A premise about a lighthouse that keeps its own hours" });
  const [question, reply] = await settled(chat.id);
  // The project actions need a chat about a project; a new project does not.
  await alice.post(`/api/expert-messages/${reply!.id}/extract`, { action: "premise" }, 400);
  // Only a finished reply from the expert can be used, and only by its owner.
  await alice.post(`/api/expert-messages/${question!.id}/extract`, { action: "concept" }, 409);
  await bob.post(`/api/expert-messages/${reply!.id}/extract`, { action: "concept" }, 404);

  const before = (await alice.get<{ projects: unknown[] }>("/api/projects")).projects.length;
  const started = await extract(reply!.id, "concept");
  expect(started.extraction.projectId).toBeNull();
  const done = await extracted(chat.id, started.extraction.id);
  expect(done.status).toBe("completed");
  const concept = done.result as { title: string; logline: string; premise: string; storyIdea: string };
  // What it read is the reply itself, copied onto the job when it was queued.
  expect(concept.storyIdea).toContain("Mock expert reply to: A premise about a lighthouse");
  expect(concept.title.length).toBeGreaterThan(0);
  // Extracting changed nothing: the user has the same projects until they apply it.
  expect((await alice.get<{ projects: unknown[] }>("/api/projects")).projects.length).toBe(before);
  // A job of no project is its owner's alone.
  await alice.get(`/api/generations/${done.id}`);
  await bob.get(`/api/generations/${done.id}`, 404);
  await bob.get(`/api/jobs/${done.id}`, 404);
  // Its usage is recorded outside any project, like the chat itself.
  const usage = await h.deps.db.select().from(aiUsage).where(eq(aiUsage.generationJobId, done.id));
  expect(usage.length).toBeGreaterThan(0);
  expect(usage.every((u) => u.projectId === null)).toBe(true);

  // Applying is the normal create route, with what the user reviewed.
  const { project } = await alice.post<{ project: { id: string; description: string } }>(
    "/api/projects",
    {
      title: concept.title,
      description: `${concept.logline}\n\n${concept.premise}`,
      projectType: "manhwa",
      format: "comic",
      story: { content: concept.storyIdea, inputKind: "idea", title: concept.title },
    },
    201,
  );
  expect(project.description).toContain(concept.logline);
  const story = await alice.get<{ latest: { content: string; inputKind: string } }>(
    `/api/projects/${project.id}/story`,
  );
  expect(story.latest.inputKind).toBe("idea");
  expect(story.latest.content).toBe(concept.storyIdea);
});

test("premise, outline and YouTube text from a reply about a project, each in the project's Generation", async () => {
  const chat = await newChat("story-developer", projectId);
  await send(chat.id, { text: "An outline in three parts\n\nwith a premise and video copy" });
  const reply = (await settled(chat.id)).at(-1)!;
  const ids: string[] = [];
  for (const action of ["premise", "outline", "youtube"]) {
    const started = await extract(reply.id, action);
    expect(started.extraction.projectId).toBe(projectId);
    const done = await extracted(chat.id, started.extraction.id);
    expect([action, done.status]).toEqual([action, "completed"]);
    ids.push(done.id);
  }
  const chatView = await alice.get<{ extractions: Extraction[] }>(`/api/expert-chats/${chat.id}`);
  expect(chatView.extractions.filter((e) => e.messageId === reply.id).map((e) => e.action)).toEqual([
    "youtube",
    "outline",
    "premise",
  ]);
  const [premise, outline, youtube] = ids.map((id) => chatView.extractions.find((e) => e.id === id)!.result!);
  // Shown in the project's Generation like any other text job.
  const gen = await alice.get<{ jobs: { id: string; kind: string }[] }>(`/api/projects/${projectId}/generations`);
  for (const id of ids) expect(gen.jobs.find((j) => j.id === id)?.kind).toBe("expert_extract");

  // Applying uses the routes the rest of the app does.
  await alice.patch(`/api/projects/${projectId}`, { description: `${premise!.logline}\n\n${premise!.premise}` });
  const o = outline as { title: string; chapters: { title: string; summary: string }[] };
  expect(o.chapters.length).toBeGreaterThan(0);
  await alice.post(
    `/api/projects/${projectId}/story/revisions`,
    {
      content: o.chapters.map((c, i) => `Chapter ${i + 1}: ${c.title}\n${c.summary}`).join("\n\n"),
      title: o.title,
      inputKind: "outline",
    },
    201,
  );
  await alice.patch(`/api/projects/${projectId}`, { settings: { youtubePackage: youtube } });
  const p = await alice.get<{ project: { description: string; settings: { youtubePackage: { titles: string[] } } } }>(
    `/api/projects/${projectId}`,
  );
  expect(p.project.description).toContain(String(premise!.logline));
  expect(p.project.settings.youtubePackage.titles).toEqual((youtube as { titles: string[] }).titles);
  const story = await alice.get<{ latest: { inputKind: string; content: string } }>(`/api/projects/${projectId}/story`);
  expect(story.latest.inputKind).toBe("outline");
  expect(story.latest.content).toStartWith("Chapter 1: ");
});

test("with no key, an extraction asks for its answer and holds it to the schema", async () => {
  const chat = await newChat("story-developer", projectId);
  await send(chat.id, { text: "Outline it" });
  const reply = (await settled(chat.id)).at(-1)!;
  const started = await extract(reply.id, "outline", { manual: true });
  const waiting = await extracted(chat.id, started.extraction.id);
  expect(waiting.status).toBe("awaiting_input");
  expect(waiting.manual).toBe(true);
  const m = await alice.get<{ prompt: string; format: { name: string } | null; example: string | null }>(
    `/api/generations/${waiting.id}/manual`,
  );
  expect(m.format?.name).toBe("StoryOutline");
  expect(m.prompt).toContain("<expert_reply>");
  expect(m.prompt).toContain("Mock expert reply to: Outline it");
  // A wrong answer is refused with its reason, and the job waits again.
  await alice.post(`/api/generations/${waiting.id}/manual`, { text: '{"chapters": []}' });
  const again = await waitFor(
    async () => {
      const r = await alice.get<{ awaitingAnswer: boolean; lastError: string | null }>(
        `/api/generations/${waiting.id}/manual`,
      );
      return r.awaitingAnswer && r.lastError ? r : null;
    },
    { label: "rejected answer" },
  );
  expect(again.lastError).toContain("StoryOutline");
  await alice.post(`/api/generations/${waiting.id}/manual`, { text: m.example! });
  const done = await extracted(chat.id, waiting.id);
  expect(done.status).toBe("completed");
  expect((done.result as { chapters: unknown[] }).chapters.length).toBeGreaterThan(0);
});
