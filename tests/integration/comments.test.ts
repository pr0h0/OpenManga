import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

/** Panel comments: threads, mentions, notifications, who may do what, live events, and agents. */

let h: Awaited<ReturnType<typeof startHarness>>;
let owner: TestClient;
let editor: TestClient;
let viewer: TestClient;
let outsider: TestClient;
let projectId = "";
let chapterId = "";
let pageId = "";
let panelId = "";
let otherPanelId = "";

type Comment = { id: string; body: string; author: string; mentions: string[]; deletedAt: string | null };
type Thread = Comment & { resolvedAt: string | null; resolvedBy: string | null; replies: Comment[] };
type Notification = { id: string; kind: string; actor: string; body: string; panelId: string; readAt: string | null };

async function register(c: TestClient, username: string) {
  await c.post(
    "/api/auth/register",
    { username, email: `${username}@example.com`, password: `${username}-pass-1234` },
    201,
  );
}
async function join(c: TestClient, username: string, role: "editor" | "viewer") {
  await owner.post(`/api/projects/${projectId}/invites`, { identifier: username, role }, 201);
  const inv = (await c.get<{ invites: { id: string }[] }>("/api/invites")).invites[0]!;
  await c.post(`/api/invites/${inv.id}/accept`, {}, 200);
}
const threads = async (c: TestClient, id = panelId) =>
  (await c.get<{ threads: Thread[] }>(`/api/panels/${id}/comments`)).threads;
const inbox = (c: TestClient) => c.get<{ notifications: Notification[]; unread: number }>("/api/notifications");

beforeAll(async () => {
  h = await startHarness();
  [owner, editor, viewer, outsider] = [h.client(), h.client(), h.client(), h.client()];
  await register(owner, "olive");
  await register(editor, "eddie");
  await register(viewer, "vera");
  await register(outsider, "otto");
  projectId = (await owner.post<{ project: { id: string } }>("/api/projects", { title: "Notes" }, 201)).project.id;
  chapterId = (
    await owner.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201)
  ).chapter.id;
  pageId = (
    await owner.post<{ page: { id: string } }>(`/api/chapters/${chapterId}/pages`, { layoutTemplate: "four-grid" }, 201)
  ).page.id;
  const panels = (await owner.get<{ panels: { id: string }[] }>(`/api/pages/${pageId}`)).panels;
  panelId = panels[0]!.id;
  otherPanelId = panels[1]!.id;
  await join(editor, "eddie", "editor");
  await join(viewer, "vera", "viewer");
});
afterAll(() => h?.stop());

describe("threads", () => {
  test("a viewer comments and mentions; mentioned members are notified, outsiders and non-members are not", async () => {
    const r = await viewer.post<{ comment: Comment }>(
      `/api/panels/${panelId}/comments`,
      { body: "The hand looks wrong here, @eddie. Also @otto and mail me at x@olive.com" },
      201,
    );
    expect(r.comment.mentions).toHaveLength(1);
    const n = await inbox(editor);
    expect(n.unread).toBe(1);
    expect(n.notifications[0]).toMatchObject({ kind: "mention", actor: "vera", panelId });
    expect((await inbox(owner)).unread).toBe(0);
    expect((await inbox(outsider)).unread).toBe(0);
    expect(await outsider.raw("GET", `/api/panels/${panelId}/comments`).then((x) => x.status)).toBe(404);
    expect(await outsider.raw("POST", `/api/panels/${panelId}/comments`, { body: "hi" }).then((x) => x.status)).toBe(
      404,
    );
  });

  test("replies notify the thread's participants; text is stored as written", async () => {
    const [t] = await threads(owner);
    const html = "<img src=x onerror=alert(1)> fixed in v2";
    await editor.post(`/api/panels/${panelId}/comments`, { body: html, threadId: t!.id }, 201);
    const n = await inbox(viewer);
    expect(n.notifications[0]).toMatchObject({ kind: "reply", actor: "eddie", body: html });
    // Replying to a reply is refused: a thread is one level deep.
    const [after] = await threads(owner);
    expect(after!.replies[0]!.body).toBe(html);
    await owner.post(`/api/panels/${panelId}/comments`, { body: "x", threadId: after!.replies[0]!.id }, 400);
    // A thread id from another panel is not a thread of this one.
    await owner.post(`/api/panels/${otherPanelId}/comments`, { body: "x", threadId: t!.id }, 404);
  });

  test("you edit and delete your own; the owner may delete anyone's but edit nobody's", async () => {
    const [t] = await threads(owner);
    const reply = t!.replies[0]!;
    await viewer.patch(`/api/comments/${reply.id}`, { body: "hijack" }, 403);
    await owner.patch(`/api/comments/${reply.id}`, { body: "hijack" }, 403);
    await editor.patch(`/api/comments/${reply.id}`, { body: "Fixed in v2, @olive please check" }, 200);
    expect((await inbox(owner)).notifications[0]).toMatchObject({ kind: "mention", actor: "eddie" });
    await viewer.del(`/api/comments/${reply.id}`, 403);
    // The first comment has a reply, so deleting it blanks it and keeps the thread.
    await viewer.del(`/api/comments/${t!.id}`, 200);
    const [kept] = await threads(owner);
    expect(kept!.deletedAt).not.toBeNull();
    expect(kept!.body).toBe("");
    expect(kept!.replies).toHaveLength(1);
    const extra = await viewer.post<{ comment: Comment }>(`/api/panels/${panelId}/comments`, { body: "noise" }, 201);
    await owner.del(`/api/comments/${extra.comment.id}`, 200);
    expect(await threads(owner)).toHaveLength(1);
  });

  test("any member resolves and reopens; the open list and the badges follow", async () => {
    const second = await editor.post<{ comment: Comment }>(
      `/api/panels/${otherPanelId}/comments`,
      { body: "Too dark" },
      201,
    );
    let counts = await viewer.get<{ panels: Record<string, number>; pages: Record<string, number> }>(
      `/api/projects/${projectId}/comment-counts`,
    );
    expect(counts.panels[panelId]).toBe(1);
    expect(counts.pages[pageId]).toBe(2);
    await viewer.post(`/api/comments/${second.comment.id}/resolve`, { resolved: true }, 200);
    counts = await viewer.get(`/api/projects/${projectId}/comment-counts`);
    expect(counts.pages[pageId]).toBe(1);
    const open = await owner.get<{ threads: { id: string; chapterId: string; pageId: string; replies: number }[] }>(
      `/api/projects/${projectId}/comments?chapterId=${chapterId}`,
    );
    expect(open.threads).toHaveLength(1);
    expect(open.threads[0]).toMatchObject({ pageId, chapterId, replies: 1 });
    const resolved = await owner.get<{ threads: { id: string }[] }>(
      `/api/projects/${projectId}/comments?status=resolved`,
    );
    expect(resolved.threads.map((t) => t.id)).toEqual([second.comment.id]);
    const [t] = await threads(owner, otherPanelId);
    expect(t!.resolvedBy).toBe("vera");
    await owner.post(`/api/comments/${second.comment.id}/resolve`, { resolved: false }, 200);
    expect((await owner.get<{ threads: unknown[] }>(`/api/projects/${projectId}/comments`)).threads).toHaveLength(2);
  });

  test("notifications are marked read, and leave with the membership", async () => {
    const before = await inbox(editor);
    expect(before.unread).toBeGreaterThan(0);
    await editor.post("/api/notifications/read", { ids: [before.notifications[0]!.id] });
    expect((await inbox(editor)).unread).toBe(before.unread - 1);
    await editor.post("/api/notifications/read", {});
    expect((await inbox(editor)).unread).toBe(0);
    // Another user's ids are not theirs to mark.
    const ownerInbox = await inbox(owner);
    await editor.post("/api/notifications/read", { ids: ownerInbox.notifications.map((n) => n.id) });
    expect((await inbox(owner)).unread).toBe(ownerInbox.unread);
    expect((await inbox(viewer)).notifications.length).toBeGreaterThan(0);
    await viewer.del(
      `/api/projects/${projectId}/members/${(await viewer.get<{ user: { id: string } }>("/api/auth/me")).user.id}`,
    );
    expect((await inbox(viewer)).notifications).toHaveLength(0);
    await join(viewer, "vera", "viewer");
  });

  test("comment changes reach the project's live events", async () => {
    const seen: string[] = [];
    const unsubscribe = h.deps.events.subscribe(h.config.REDIS_URL, projectId, (m) => seen.push(m));
    await unsubscribe.ready;
    await viewer.post(`/api/panels/${panelId}/comments`, { body: "live" }, 201);
    await waitFor(async () => seen.some((m) => m.includes('"comment.updated"') && m.includes(pageId)), {
      label: "comment event",
    });
    await unsubscribe();
  });
});

describe("agents", () => {
  async function mcp(c: TestClient, scopes: string[]) {
    const { token } = await c.post<{ token: string }>(
      "/api/agents/tokens",
      { name: "notes agent", scopes, projectAccess: "all", approvalMode: "ALLOW_ALL" },
      201,
    );
    const client = new Client({ name: "notes-agent", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: (url, init) => {
          const headers = new Headers((init as RequestInit).headers);
          headers.set("host", "test.local");
          return Promise.resolve(h.app.request(String(url), { ...(init as RequestInit), headers }));
        },
      }),
    );
    return async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args }).catch((e: Error) => ({
        isError: true,
        content: [{ type: "text", text: JSON.stringify({ error: { code: "unknown_tool", message: e.message } }) }],
        structuredContent: undefined,
      }));
      const text = (r.content as { type: string; text?: string }[]).find((x) => x.type === "text")?.text ?? "{}";
      return r.isError
        ? { error: (JSON.parse(text) as { error: { code: string } }).error, data: null }
        : { error: null, data: (r.structuredContent as { data: Record<string, unknown> }).data };
    };
  }

  test("a member's agent reads and posts comments with the right scopes", async () => {
    const call = await mcp(viewer, ["panels:read", "panels:write"]);
    const list = await call("list_comments", { panelId });
    expect(list.error).toBeNull();
    expect((list.data as { threads: unknown[] }).threads.length).toBeGreaterThan(0);
    const open = await call("list_comments", { projectId });
    expect((open.data as { threads: unknown[] }).threads.length).toBeGreaterThan(0);
    const posted = await call("post_comment", { panelId, body: "From my agent, @olive" });
    expect(posted.error).toBeNull();
    expect((await inbox(owner)).notifications[0]).toMatchObject({ kind: "mention", actor: "vera" });

    const readOnly = await mcp(viewer, ["panels:read"]);
    expect((await readOnly("post_comment", { panelId, body: "nope" })).error).not.toBeNull();
    const stranger = await mcp(outsider, ["panels:read", "panels:write"]);
    expect((await stranger("list_comments", { panelId })).error?.code).toBe("not_found");
  });
});
