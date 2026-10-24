import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, generationJobs, panels } from "@openmanga/db";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

/** Access granted when work was started still has to hold when it runs or is read later. */

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let bob: TestClient;
let bobId = "";

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  bob = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "rcalice", email: "rca@example.com", password: "rcalice-pass-1" },
    201,
  );
  await bob.post("/api/auth/register", { username: "rcbob", email: "rcb@example.com", password: "rcbob-pass-12" }, 201);
  bobId = (await bob.get<{ user: { id: string } }>("/api/auth/me")).user.id;
});
afterAll(() => h?.stop());

async function shared(role: "editor" | "viewer") {
  const projectId = (await alice.post<{ project: { id: string } }>("/api/projects", { title: "Shared" }, 201)).project
    .id;
  await alice.post(`/api/projects/${projectId}/invites`, { identifier: "rcbob", role }, 201);
  const { invites } = await bob.get<{ invites: { id: string; projectId: string }[] }>("/api/invites");
  await bob.post(`/api/invites/${invites.find((i) => i.projectId === projectId)!.id}/accept`, {}, 200);
  return projectId;
}

const lastReply = (c: TestClient, chatId: string, status: string) =>
  waitFor(async () => {
    const r = await c.get<{ messages: { id: string; role: string; status: string }[] }>(`/api/expert-chats/${chatId}`);
    const last = r.messages.at(-1)!;
    return last.role === "assistant" && last.status === status ? last : null;
  });

test("another member's expert extraction is theirs alone, like the chat it came from", async () => {
  const projectId = await shared("viewer");
  const chat = (
    await alice.post<{ chat: { id: string } }>("/api/expert-chats", { expert: "story-developer", projectId }, 201)
  ).chat;
  await alice.post(`/api/expert-chats/${chat.id}/messages`, { text: "PRIVATE-QUESTION" }, 202);
  const reply = await lastReply(alice, chat.id, "done");
  const jobId = (
    await alice.post<{ extraction: { id: string } }>(
      `/api/expert-messages/${reply.id}/extract`,
      { action: "premise" },
      202,
    )
  ).extraction.id;
  await waitFor(
    async () => (await alice.get<{ job: { status: string } }>(`/api/generations/${jobId}`)).job.status === "completed",
  );
  await bob.get(`/api/generations/${jobId}`, 404);
  const list = await bob.get<{ jobs: { id: string; result: unknown }[] }>(`/api/projects/${projectId}/generations`);
  expect(list.jobs.find((j) => j.id === jobId)?.result).toBeNull();
});

test("a pasted expert answer needs current access to the chat's project", async () => {
  const projectId = await shared("editor");
  const chat = (
    await bob.post<{ chat: { id: string } }>("/api/expert-chats", { expert: "thumbnail-designer", projectId }, 201)
  ).chat;
  await bob.post(
    `/api/expert-chats/${chat.id}/messages`,
    { text: "a thumbnail", generateImage: true, ai: { manual: true } },
    202,
  );
  const waiting = await lastReply(bob, chat.id, "awaiting_input");
  await alice.del(`/api/projects/${projectId}/members/${bobId}`);
  await bob.post(`/api/expert-messages/${waiting.id}/answer`, { text: "IMAGE: the lighthouse" }, 404);
});

async function queuedDraw(by: TestClient, projectId: string) {
  const chapterId = (
    await alice.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201)
  ).chapter.id;
  const page = await alice.post<{ page: { id: string } }>(`/api/chapters/${chapterId}/pages`, {}, 201);
  const panelId = (await alice.get<{ panels: { id: string }[] }>(`/api/pages/${page.page.id}`)).panels[0]!.id;
  await alice.patch(`/api/panels/${panelId}`, { promptOverride: "a lighthouse at night" });
  const jobId = (await by.post<{ job: { id: string } }>(`/api/panels/${panelId}/generate`, {}, 202)).job.id;
  return { panelId, jobId };
}

async function settled(jobId: string) {
  return waitFor(async () => {
    const [x] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
    return x && ["completed", "failed", "cancelled"].includes(x.status) ? x : null;
  });
}

test("a removed member's queued work, and work queued in a project then trashed, does not run", async () => {
  const q = (
    h.workerDeps.queue as unknown as { queue(n: string): { pause(): Promise<void>; resume(): Promise<void> } }
  ).queue("image-generation");
  const removedIn = await shared("editor");
  const trashed = (await alice.post<{ project: { id: string } }>("/api/projects", { title: "Trashed" }, 201)).project
    .id;
  await q.pause();
  try {
    const a = await queuedDraw(bob, removedIn);
    const b = await queuedDraw(alice, trashed);
    await alice.del(`/api/projects/${removedIn}/members/${bobId}`);
    await alice.post(`/api/projects/${trashed}/status`, { action: "trash" });
    await q.resume();
    for (const { jobId, panelId } of [a, b]) {
      expect((await settled(jobId)).status).toBe("cancelled");
      const [pn] = await h.deps.db.select().from(panels).where(eq(panels.id, panelId));
      expect(pn!.activeArtworkAssetId).toBeNull();
    }
  } finally {
    await q.resume();
  }
});
