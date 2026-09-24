import { afterAll, beforeAll, expect, test } from "bun:test";
import { aiUsage, and, eq, isNull } from "@openmanga/db";
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
  await send(chat.id, { text: long });
  const seen: string[] = [];
  let buf = "";
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
  // Someone else cannot listen in.
  expect((await bob.raw("GET", `/api/expert-chats/${chat.id}/stream`)).status).toBe(404);
});
