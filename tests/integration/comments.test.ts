import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq, panels as panelsTable, sql } from "@openmanga/db";
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

  test("an agent audits and another fixes: who wrote and resolved what, by hand or through which connection", async () => {
    type Seen = Thread & {
      viaAgent: boolean;
      agentName: string | null;
      resolvedViaAgent: boolean;
      resolvedAgentName: string | null;
      replies: (Comment & { viaAgent: boolean; agentName: string | null })[];
    };
    const panel = otherPanelId;
    const threadsAs = async (c: TestClient) =>
      (await c.get<{ threads: Seen[] }>(`/api/panels/${panel}/comments`)).threads;

    // The editor's audit agent leaves a finding; the editor also comments by hand.
    const auditor = await mcp(editor, ["panels:read", "panels:write"]);
    const posted = await auditor("post_comment", { panelId: panel, body: "The lamp is missing in this panel @olive" });
    expect(posted.error).toBeNull();
    const finding = (posted.data as { comment: Seen & Record<string, unknown> }).comment;
    expect(finding).toMatchObject({ viaAgent: true, agentName: "notes agent" });
    // Connection ids never leave the server, not even to the author.
    expect(Object.keys(finding).some((k) => /serviceid/i.test(k))).toBe(false);
    const byHand = await editor.post<{ comment: Seen }>(
      `/api/panels/${panel}/comments`,
      { body: "Also the rain" },
      201,
    );
    expect(byHand.comment).toMatchObject({ viaAgent: false, agentName: null });

    // The author sees which connection wrote it; everyone else sees only that an agent did.
    const mine = (await threadsAs(editor)).find((t) => t.id === finding.id)!;
    expect(mine).toMatchObject({ viaAgent: true, agentName: "notes agent" });
    const theirs = (await threadsAs(owner)).find((t) => t.id === finding.id)!;
    expect(theirs).toMatchObject({ viaAgent: true, agentName: null, author: "eddie" });
    const listed = await owner.get<{ threads: Seen[] }>(`/api/projects/${projectId}/comments`);
    expect(listed.threads.find((t) => t.id === finding.id)).toMatchObject({ viaAgent: true, agentName: null });
    // The mention says it came through an agent, never which one.
    const note = (await owner.get<{ notifications: (Notification & { viaAgent: boolean })[] }>("/api/notifications"))
      .notifications[0]!;
    expect(note).toMatchObject({ actor: "eddie", viaAgent: true });
    expect(JSON.stringify(note)).not.toContain("notes agent");

    // The owner's fixing agent reads the open findings, replies with what it did and resolves the thread.
    const fixer = await mcp(owner, ["panels:read", "panels:write"]);
    const open = await fixer("list_comments", { projectId, status: "open" });
    const seen = (open.data as { threads: Seen[] }).threads.find((t) => t.id === finding.id)!;
    expect(seen).toMatchObject({ viaAgent: true, agentName: null });
    const reply = await fixer("post_comment", { panelId: panel, threadId: finding.id, body: "Added the lamp back." });
    expect(reply.error).toBeNull();
    // Resolving through a reply resolves its thread.
    const replyId = (reply.data as { comment: { id: string } }).comment.id;
    const resolved = await fixer("resolve_comment", { commentId: replyId });
    expect(resolved.error).toBeNull();
    expect((resolved.data as { comment: Seen }).comment).toMatchObject({
      id: finding.id,
      resolvedBy: "olive",
      resolvedViaAgent: true,
      resolvedAgentName: "notes agent",
    });
    const forOwner = (await threadsAs(owner)).find((t) => t.id === finding.id)!;
    expect(forOwner).toMatchObject({ resolvedViaAgent: true, resolvedAgentName: "notes agent" });
    expect(forOwner.replies[0]).toMatchObject({ viaAgent: true, agentName: "notes agent" });
    const forEditor = (await threadsAs(editor)).find((t) => t.id === finding.id)!;
    expect(forEditor).toMatchObject({ resolvedViaAgent: true, resolvedAgentName: null });
    expect(forEditor.replies[0]).toMatchObject({ viaAgent: true, agentName: null });
    expect(
      (await owner.get<{ threads: Seen[] }>(`/api/projects/${projectId}/comments`)).threads.some(
        (t) => t.id === finding.id,
      ),
    ).toBe(false);

    // Reopened by hand: the agent's resolution is gone with it. A read-only connection cannot resolve.
    await editor.post(`/api/comments/${finding.id}/resolve`, { resolved: false });
    expect((await threadsAs(editor)).find((t) => t.id === finding.id)).toMatchObject({
      resolvedAt: null,
      resolvedViaAgent: false,
      resolvedAgentName: null,
    });
    const readOnly = await mcp(owner, ["panels:read"]);
    expect((await readOnly("resolve_comment", { commentId: finding.id })).error).not.toBeNull();
    expect((await fixer("resolve_comment", { commentId: crypto.randomUUID() })).error?.code).toBe("not_found");
    // A viewer's agent may resolve too, as the viewer may by hand.
    const viewerAgent = await mcp(viewer, ["panels:read", "panels:write"]);
    expect((await viewerAgent("resolve_comment", { commentId: finding.id })).error).toBeNull();

    // A revoked connection still marks what it wrote; its owner still sees its name.
    const { connections } = await editor.get<{ connections: { id: string; name: string }[] }>(
      "/api/agents/connections",
    );
    for (const c of connections) await editor.post(`/api/agents/connections/${c.id}/revoke`, {});
    expect((await threadsAs(editor)).find((t) => t.id === finding.id)).toMatchObject({
      viaAgent: true,
      agentName: "notes agent",
    });
  });

  test("an agent pins, assigns by username and reassigns; a non-member cannot be assigned", async () => {
    const call = await mcp(owner, ["panels:read", "panels:write"]);
    const posted = await call("post_comment", {
      panelId: otherPanelId,
      body: "The lamp is gone in this panel",
      anchor: { x: 0.4, y: 0.6 },
      assignTo: "@eddie",
    });
    expect(posted.error).toBeNull();
    const c = (posted.data as { comment: { id: string; anchor: unknown; assignee: string } }).comment;
    expect(c).toMatchObject({ anchor: { x: 0.4, y: 0.6 }, assignee: "eddie" });
    const moved = await call("assign_comment", { commentId: c.id, username: "vera" });
    expect((moved.data as { comment: { assignee: string } }).comment.assignee).toBe("vera");
    expect((await call("assign_comment", { commentId: c.id, username: "otto" })).error?.code).toBe("bad_request");
    const mine = await (await mcp(viewer, ["panels:read"]))("list_comments", { projectId, assignedToMe: true });
    expect((mine.data as { threads: { id: string }[] }).threads.map((t) => t.id)).toContain(c.id);
    expect((await call("assign_comment", { commentId: c.id, username: null })).error).toBeNull();
  });
});

describe("review", () => {
  type Review = Thread & {
    chapterId: string;
    anchor: { x: number; y: number } | null;
    timecodeMs: number | null;
    assignee: string | null;
    assigneeUserId: string | null;
    guestName: string | null;
    artworkAssetId: string | null;
    resolvedArtworkAssetId: string | null;
    currentArtworkAssetId: string | null;
    replies: (Comment & { guestName: string | null })[];
  };
  const panelAt = async (i: number) =>
    (await owner.get<{ panels: { id: string }[] }>(`/api/pages/${pageId}`)).panels[i]!.id;
  const art = async (panel: string, name: string) => {
    const a = await h.deps.assets.store({
      projectId,
      ownerUserId: null,
      type: "panel_art",
      data: new Uint8Array(64).fill(name.length),
      mimeType: "image/png",
    });
    await h.deps.db.update(panelsTable).set({ activeArtworkAssetId: a.id }).where(eq(panelsTable.id, panel));
    return a.id;
  };
  const me = async (c: TestClient) => (await c.get<{ user: { id: string } }>("/api/auth/me")).user.id;

  test("a pinned spot and a video moment on a new thread; never on a reply", async () => {
    const panel = await panelAt(2);
    const { comment } = await editor.post<{ comment: Review }>(
      `/api/panels/${panel}/comments`,
      { body: "Her hand is wrong here", anchor: { x: 0.25, y: 0.75 }, timecodeMs: 83_000 },
      201,
    );
    expect(comment).toMatchObject({ anchor: { x: 0.25, y: 0.75 }, timecodeMs: 83_000 });
    expect(comment.chapterId).toBe(chapterId);
    await editor.post(
      `/api/panels/${panel}/comments`,
      { body: "and here", threadId: comment.id, anchor: { x: 0.1, y: 0.1 } },
      400,
    );
    await editor.post(`/api/panels/${panel}/comments`, { body: "off the image", anchor: { x: 1.2, y: 0 } }, 422);
  });

  test("assigning a thread notifies the member, filters the list, and must name a member", async () => {
    const panel = await panelAt(2);
    const eddie = await me(editor);
    const { comment } = await owner.post<{ comment: Review }>(
      `/api/panels/${panel}/comments`,
      { body: "Please redraw the door", assigneeUserId: eddie },
      201,
    );
    expect(comment).toMatchObject({ assignee: "eddie", assigneeUserId: eddie });
    expect((await inbox(editor)).notifications[0]).toMatchObject({ kind: "assigned", actor: "olive" });
    const mine = await editor.get<{ threads: Review[] }>(`/api/projects/${projectId}/comments?assignee=me`);
    expect(mine.threads.map((t) => t.id)).toEqual([comment.id]);
    expect((await owner.get<{ threads: Review[] }>(`/api/projects/${projectId}/comments?assignee=me`)).threads).toEqual(
      [],
    );
    // Reassigned through a reply's id, to the viewer, then cleared; an outsider cannot be assigned.
    const reply = await editor.post<{ comment: Review }>(
      `/api/panels/${panel}/comments`,
      { body: "Not mine", threadId: comment.id },
      201,
    );
    const vera = await me(viewer);
    const moved = await editor.post<{ comment: Review }>(`/api/comments/${reply.comment.id}/assign`, {
      assigneeUserId: vera,
    });
    expect(moved.comment).toMatchObject({ id: comment.id, assignee: "vera" });
    expect((await inbox(viewer)).notifications[0]).toMatchObject({ kind: "assigned", actor: "eddie" });
    await owner.post(`/api/comments/${comment.id}/assign`, { assigneeUserId: await me(outsider) }, 400);
    const cleared = await owner.post<{ comment: Review }>(`/api/comments/${comment.id}/assign`, {
      assigneeUserId: null,
    });
    expect(cleared.comment.assignee).toBeNull();
    expect((await outsider.raw("POST", `/api/comments/${comment.id}/assign`, { assigneeUserId: null })).status).toBe(
      404,
    );
  });

  test("before and after: the art a thread was started on, the art now, and the art it was resolved on", async () => {
    const panel = await panelAt(3);
    const before = await art(panel, "before");
    const { comment } = await owner.post<{ comment: Review }>(
      `/api/panels/${panel}/comments`,
      { body: "Too dark" },
      201,
    );
    expect(comment).toMatchObject({ artworkAssetId: before, currentArtworkAssetId: before });
    const after = await art(panel, "after-fix");
    expect((await threads(owner, panel)).find((t) => t.id === comment.id)).toMatchObject({
      artworkAssetId: before,
      currentArtworkAssetId: after,
      resolvedArtworkAssetId: null,
    });
    await owner.post(`/api/comments/${comment.id}/resolve`, { resolved: true });
    // Redrawn again later: the resolution keeps the art it was resolved on.
    await art(panel, "later");
    expect((await threads(owner, panel)).find((t) => t.id === comment.id)).toMatchObject({
      artworkAssetId: before,
      resolvedArtworkAssetId: after,
    });
    await owner.post(`/api/comments/${comment.id}/resolve`, { resolved: false });
    expect(
      ((await threads(owner, panel)).find((t) => t.id === comment.id) as unknown as Review).resolvedArtworkAssetId,
    ).toBeNull();
  });

  test("a production run reports the project's open comment threads", async () => {
    await owner.patch(`/api/projects/${projectId}`, { settings: { budgetUsd: 1 } });
    await owner.post(`/api/projects/${projectId}/production-runs`, { reviewGates: true, render: false }, 201);
    const { runs } = await owner.get<{ runs: { id: string; openComments: number }[] }>(
      `/api/projects/${projectId}/production-runs`,
    );
    const [open] = await h.deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from panel_comments where project_id = ${projectId} and thread_id is null and resolved_at is null and deleted_at is null`,
    );
    expect(runs[0]!.openComments).toBe(open!.n);
    expect(runs[0]!.openComments).toBeGreaterThan(0);
    await owner.post(`/api/production-runs/${runs[0]!.id}/cancel`, { jobs: true });
  });

  test("guests comment through a reader link that allows it, under a name, and see only that link's threads", async () => {
    const panel = await panelAt(1);
    const closed = await owner.post<{ share: { id: string; token: string } }>(
      `/api/projects/${projectId}/shares`,
      { chapterId },
      201,
    );
    const guest = h.client();
    const t0 = closed.share.token;
    expect((await guest.raw("GET", `/api/public/shares/${t0}/comments?pageId=${pageId}`)).status).toBe(404);
    expect(
      (await guest.raw("POST", `/api/public/shares/${t0}/comments`, { panelId: panel, name: "Ana", body: "Hi" }))
        .status,
    ).toBe(404);
    const reader0 = await guest.get<{ allowComments: boolean; chapters: { pages: { panels?: unknown[] }[] }[] }>(
      `/api/public/shares/${t0}`,
    );
    expect(reader0.allowComments).toBe(false);
    expect(reader0.chapters[0]!.pages[0]!.panels).toEqual([]);

    // The owner lets readers comment on the same link.
    await owner.patch(`/api/shares/${closed.share.id}`, { allowComments: true });
    await viewer.raw("PATCH", `/api/shares/${closed.share.id}`, { allowComments: false }).then((r) => {
      expect(r.status).toBe(403);
    });
    const reader = await guest.get<{ allowComments: boolean; chapters: { pages: { panels: { id: string }[] }[] }[] }>(
      `/api/public/shares/${t0}`,
    );
    expect(reader.allowComments).toBe(true);
    expect(reader.chapters[0]!.pages[0]!.panels.map((p) => p.id)).toContain(panel);

    const ownerUnread = (await inbox(owner)).unread;
    const posted = await guest.post<{ comment: Record<string, unknown> }>(
      `/api/public/shares/${t0}/comments`,
      { panelId: panel, name: "Ana", body: "The second bubble has a typo", anchor: { x: 0.5, y: 0.2 } },
      201,
    );
    // Only names and words go back to a guest: no account ids, assignees or agent details.
    expect(Object.keys(posted.comment).sort()).toEqual([
      "anchor",
      "author",
      "authorName",
      "body",
      "createdAt",
      "deletedAt",
      "editedAt",
      "guestName",
      "id",
      "panelId",
      "resolvedAt",
      "threadId",
    ]);
    const note = (await inbox(owner)).notifications[0]!;
    expect(note).toMatchObject({ kind: "guest", guestName: "Ana" });
    expect((await inbox(owner)).unread).toBe(ownerUnread + 1);
    // Members see it with the guest's name; a member's reply reaches the guest's view, and a guest reply notifies them.
    const t = (await threads(editor, panel)).find((x) => x.id === posted.comment.id) as unknown as Review;
    expect(t).toMatchObject({ guestName: "Ana", author: null });
    await editor.post(`/api/panels/${panel}/comments`, { body: "Fixed, thanks", threadId: t.id }, 201);
    await guest.post(
      `/api/public/shares/${t0}/comments`,
      { panelId: panel, name: "Ana", body: "Looks good", threadId: t.id },
      201,
    );
    expect((await inbox(editor)).notifications[0]).toMatchObject({ kind: "guest", guestName: "Ana" });
    const seen = await guest.get<{ threads: { id: string; replies: { body: string; guestName: string | null }[] }[] }>(
      `/api/public/shares/${t0}/comments?pageId=${pageId}`,
    );
    expect(seen.threads.map((x) => x.id)).toEqual([t.id]);
    expect(seen.threads[0]!.replies.map((r) => r.body)).toEqual(["Fixed, thanks", "Looks good"]);
    // The member's reply shows their display name at most, never their username (a sign-in name).
    const reply = seen.threads[0]!.replies[0] as unknown as { author: string | null };
    expect(reply.author).toBeNull();
    const [ed] = await h.deps.db.execute<{ username: string }>(
      sql`select u.username from users u join panel_comments pc on pc.author_user_id = u.id where pc.thread_id = ${t.id} limit 1`,
    );
    expect(JSON.stringify(seen)).not.toContain(`"${ed!.username}"`);
    // Members' own threads on the same page stay private to the project.
    expect(JSON.stringify(seen)).not.toContain("Her hand is wrong here");

    // Not on a thread members started, not on a panel outside the link, not without a name, and not in a flood.
    const members = (await threads(owner, panel)).find((x) => !(x as unknown as Review).guestName)!;
    if (members)
      expect(
        (
          await guest.raw("POST", `/api/public/shares/${t0}/comments`, {
            panelId: panel,
            name: "Ana",
            body: "x",
            threadId: members.id,
          })
        ).status,
      ).toBe(404);
    expect(
      (
        await guest.raw("POST", `/api/public/shares/${t0}/comments`, {
          panelId: crypto.randomUUID(),
          name: "Ana",
          body: "x",
        })
      ).status,
    ).toBe(404);
    expect(
      (await guest.raw("POST", `/api/public/shares/${t0}/comments`, { panelId: panel, name: " ", body: "x" })).status,
    ).toBe(422);
    let limited = 0;
    for (let i = 0; i < 12; i++) {
      const r = await guest.raw("POST", `/api/public/shares/${t0}/comments`, {
        panelId: panel,
        name: "Bot",
        body: `spam ${i}`,
      });
      if (r.status === 429) limited++;
    }
    expect(limited).toBeGreaterThan(0);
    // Revoked: the link and its comments are gone for guests.
    await owner.del(`/api/shares/${closed.share.id}`);
    expect((await guest.raw("GET", `/api/public/shares/${t0}/comments?pageId=${pageId}`)).status).toBe(404);
  });
});
