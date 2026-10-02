import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  aiUsage,
  and,
  auditEvents,
  desc,
  devEmails,
  eq,
  generationJobs,
  productionRuns,
  projectInvites,
  userServiceProjects,
} from "@openmanga/db";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

/** Members: invitations (in the app and by email), the role matrix, spending as a member, and agents in shared projects. */

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient; // owner
let bob: TestClient; // editor
let carol: TestClient; // viewer
let dave: TestClient; // not a member
let projectId = "";
let chapterId = "";
let panelId = "";
const ids: Record<string, string> = {};

async function register(c: TestClient, username: string) {
  const r = await c.post<{ user: { id: string } }>(
    "/api/auth/register",
    { username, email: `${username}@example.com`, password: `${username}-pass-1234` },
    201,
  );
  ids[username] = r.user.id;
}

const status = async (c: TestClient, method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  (await c.raw(method, path, body ?? (method === "GET" || method === "DELETE" ? undefined : {}), headers)).status;

async function inviteAndAccept(who: TestClient, username: string, role: "editor" | "viewer") {
  await alice.post(`/api/projects/${projectId}/invites`, { identifier: username, role }, 201);
  const { invites } = await who.get<{ invites: { id: string; projectId: string; role: string }[] }>("/api/invites");
  const inv = invites.find((i) => i.projectId === projectId)!;
  expect(inv.role).toBe(role);
  await who.post(`/api/invites/${inv.id}/accept`, {}, 200);
}

/** The newest invitation link mailed to an address, as its token. */
async function mailedToken(email: string) {
  const [mail] = await h.deps.db
    .select()
    .from(devEmails)
    .where(eq(devEmails.to, email))
    .orderBy(desc(devEmails.createdAt))
    .limit(1);
  const url = String(mail!.metadata.inviteUrl);
  expect(mail!.textBody).toContain(url);
  return new URL(url).searchParams.get("token")!;
}

beforeAll(async () => {
  h = await startHarness();
  [alice, bob, carol, dave] = [h.client(), h.client(), h.client(), h.client()];
  await register(alice, "alice");
  await register(bob, "bob");
  await register(carol, "carol");
  await register(dave, "dave");
  projectId = (await alice.post<{ project: { id: string } }>("/api/projects", { title: "Shared" }, 201)).project.id;
  chapterId = (
    await alice.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201)
  ).chapter.id;
  const page = await alice.post<{ page: { id: string } }>(
    `/api/chapters/${chapterId}/pages`,
    { layoutTemplate: "four-grid" },
    201,
  );
  panelId = (await alice.get<{ panels: { id: string }[] }>(`/api/pages/${page.page.id}`)).panels[0]!.id;
  await alice.patch(`/api/panels/${panelId}`, { promptOverride: "a lighthouse at night" });
});
afterAll(() => h?.stop());

describe("invitations in the app", () => {
  test("an unknown username is refused; nobody but the owner can invite", async () => {
    await alice.post(`/api/projects/${projectId}/invites`, { identifier: "nobody-here", role: "editor" }, 404);
    expect(
      await status(dave, "POST", `/api/projects/${projectId}/invites`, { identifier: "bob", role: "editor" }),
    ).toBe(404);
  });

  test("the invited account sees it, can decline, and accepts a new one", async () => {
    await alice.post(`/api/projects/${projectId}/invites`, { identifier: "carol", role: "viewer" }, 201);
    const first = (await carol.get<{ invites: { id: string }[] }>("/api/invites")).invites[0]!;
    await carol.post(`/api/invites/${first.id}/decline`, {}, 200);
    expect((await carol.get<{ invites: unknown[] }>("/api/invites")).invites).toHaveLength(0);
    await carol.post(`/api/invites/${first.id}/accept`, {}, 404);
    await inviteAndAccept(carol, "carol", "viewer");
    await inviteAndAccept(bob, "bob", "editor");
    // Already a member: nothing to invite.
    await alice.post(`/api/projects/${projectId}/invites`, { identifier: "bob", role: "viewer" }, 409);
  });

  test("an invitation can only be accepted by its account, and a revoked one not at all", async () => {
    await alice.post(`/api/projects/${projectId}/invites`, { identifier: "dave", role: "editor" }, 201);
    const inv = (await dave.get<{ invites: { id: string }[] }>("/api/invites")).invites[0]!;
    await bob.post(`/api/invites/${inv.id}/accept`, {}, 404);
    await bob.del(`/api/invites/${inv.id}`, 403);
    await alice.del(`/api/invites/${inv.id}`, 200);
    await dave.post(`/api/invites/${inv.id}/accept`, {}, 404);
    expect(await status(dave, "GET", `/api/projects/${projectId}`)).toBe(404);
  });

  test("shared projects are on the member's dashboard with their role and owner", async () => {
    const { projects } = await bob.get<{ projects: { id: string; role: string; ownerUsername: string }[] }>(
      "/api/projects",
    );
    expect(projects.find((p) => p.id === projectId)).toMatchObject({ role: "editor", ownerUsername: "alice" });
    const mine = await alice.get<{ projects: { id: string; role: string }[] }>("/api/projects");
    expect(mine.projects.find((p) => p.id === projectId)?.role).toBe("owner");
  });

  test("everyone sees the members; only the owner sees pending invitations", async () => {
    await alice.post(`/api/projects/${projectId}/invites`, { identifier: "pending@example.com", role: "viewer" }, 201);
    const owner = await alice.get<{ members: { username: string; role: string }[]; invites: unknown[] }>(
      `/api/projects/${projectId}/members`,
    );
    expect(owner.members.map((m) => [m.username, m.role])).toEqual([
      ["alice", "owner"],
      ["carol", "viewer"],
      ["bob", "editor"],
    ]);
    expect(owner.invites).toHaveLength(1);
    const viewer = await carol.get<{ members: unknown[]; invites: unknown[]; canManage: boolean }>(
      `/api/projects/${projectId}/members`,
    );
    expect(viewer.members).toHaveLength(3);
    expect(viewer.invites).toHaveLength(0);
    expect(viewer.canManage).toBe(false);
  });
});

describe("the role matrix", () => {
  test("viewers read and cannot change, generate, share, export or copy", async () => {
    expect(await status(carol, "GET", `/api/projects/${projectId}`)).toBe(200);
    expect(await status(carol, "GET", `/api/chapters/${chapterId}`)).toBe(200);
    expect(await status(carol, "PATCH", `/api/projects/${projectId}`, { title: "Mine now" })).toBe(403);
    expect(await status(carol, "PATCH", `/api/panels/${panelId}`, { promptOverride: "x" })).toBe(403);
    expect(await status(carol, "POST", `/api/projects/${projectId}/chapters`, { title: "Two" })).toBe(403);
    expect(await status(carol, "POST", `/api/panels/${panelId}/generate`)).toBe(403);
    expect(await status(carol, "POST", `/api/projects/${projectId}/exports`, { kind: "pdf" })).toBe(403);
    expect(await status(carol, "POST", `/api/projects/${projectId}/duplicate`)).toBe(403);
    expect(await status(carol, "GET", `/api/projects/${projectId}/shares`)).toBe(403);
    expect(await status(carol, "POST", "/api/expert-chats", { expert: "story-editor", projectId })).toBe(403);
    expect(await status(carol, "DELETE", `/api/projects/${projectId}/members/${ids.bob}`)).toBe(403);
  });

  test("editors change and generate, but the budget, sharing, members and the project's fate are the owner's", async () => {
    expect(await status(bob, "PATCH", `/api/projects/${projectId}`, { title: "Shared (edited)" })).toBe(200);
    expect(await status(bob, "POST", `/api/projects/${projectId}/chapters`, { title: "Two" })).toBe(201);
    // Sending the budget back unchanged is not changing it; changing it is the owner's.
    expect(await status(bob, "PATCH", `/api/projects/${projectId}`, { settings: { budgetUsd: 5 } })).toBe(200);
    expect(await status(bob, "PATCH", `/api/projects/${projectId}`, { settings: { budgetUsd: 500 } })).toBe(403);
    expect(await status(bob, "PATCH", `/api/projects/${projectId}`, { settings: { budgetUsd: null } })).toBe(403);
    expect(await status(bob, "POST", `/api/projects/${projectId}/shares`, {})).toBe(403);
    expect(
      await status(bob, "POST", `/api/projects/${projectId}/invites`, { identifier: "dave", role: "viewer" }),
    ).toBe(403);
    expect(await status(bob, "PATCH", `/api/projects/${projectId}/members/${ids.carol}`, { role: "editor" })).toBe(403);
    expect(await status(bob, "POST", `/api/projects/${projectId}/status`, { action: "trash" })).toBe(403);
    expect(await status(bob, "POST", `/api/projects/${projectId}/status`, { action: "archive" })).toBe(403);
    expect(await status(bob, "DELETE", `/api/chapters/${chapterId}`)).toBe(403);
    // A panel has an off switch, so an editor turns it off; deleting it is the owner's. Pages have none: editors may.
    expect(await status(bob, "PATCH", `/api/panels/${panelId}`, { video: { disabled: true } })).toBe(200);
    expect(await status(bob, "DELETE", `/api/panels/${panelId}`)).toBe(403);
    await alice.patch(`/api/panels/${panelId}`, { video: null });
    const spare = await bob.post<{ page: { id: string } }>(`/api/chapters/${chapterId}/pages`, {}, 201);
    expect(await status(bob, "DELETE", `/api/pages/${spare.page.id}`)).toBe(200);
    expect(await status(dave, "GET", `/api/projects/${projectId}`)).toBe(404);
  });

  test("an editor's generation runs as the editor and counts toward the project budget", async () => {
    const r = await bob.post<{ job: { id: string } }>(`/api/panels/${panelId}/generate`, {}, 202);
    const [job] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id));
    // Keys are per user: the job is the editor's, so the worker resolves the editor's own key for it.
    expect(job!.userId).toBe(ids.bob!);
    await waitFor(async () => {
      const [j] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id));
      return j?.status === "completed" || j?.status === "failed";
    });
    // Its usage is recorded against the project (which is what the cap counts), as the editor's.
    const usage = await h.deps.db.select().from(aiUsage).where(eq(aiUsage.projectId, projectId));
    expect(usage.length).toBeGreaterThan(0);
    expect(usage.every((u) => u.userId === ids.bob)).toBe(true);
    // Past the cap, only the owner can confirm going over it.
    await h.deps.db
      .insert(aiUsage)
      .values({ provider: "openai", model: "m", operation: "x", projectId, estimatedCostUsd: "10" });
    const refused = await bob.raw("POST", `/api/panels/${panelId}/generate`, {}, { "x-allow-over-budget": "1" });
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toContain("owner");
    expect(
      (await alice.raw("POST", `/api/panels/${panelId}/generate`, {}, { "x-allow-over-budget": "1" })).status,
    ).toBe(202);
    await h.deps.db.delete(aiUsage).where(eq(aiUsage.projectId, projectId));
  });

  test("a member cannot retry another member's keyed job, or continue their production run", async () => {
    const [job] = await h.deps.db
      .insert(generationJobs)
      .values({
        projectId,
        userId: ids.alice,
        kind: "panel_generation",
        queue: "image-generation",
        status: "failed",
        parameters: { ai: { credentialId: crypto.randomUUID() } },
      })
      .returning();
    const r = await bob.raw("POST", `/api/generations/${job!.id}/retry`, {});
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: { code: string } }).error.code).toBe("not_your_job");
    const [run] = await h.deps.db
      .insert(productionRuns)
      .values({
        projectId,
        userId: ids.alice!,
        status: "paused",
        options: { reviewGates: true, preparePrompts: false, render: false, youtube: false },
      })
      .returning();
    const cont = await bob.raw("POST", `/api/production-runs/${run!.id}/continue`, {});
    expect(cont.status).toBe(403);
    expect(((await cont.json()) as { error: { code: string } }).error.code).toBe("not_your_run");
    await h.deps.db.delete(productionRuns).where(eq(productionRuns.id, run!.id));
  });

  test("the owner changes roles and removes members; members can leave, the owner cannot", async () => {
    await alice.patch(`/api/projects/${projectId}/members/${ids.bob}`, { role: "viewer" });
    expect(await status(bob, "PATCH", `/api/projects/${projectId}`, { title: "x" })).toBe(403);
    await alice.patch(`/api/projects/${projectId}/members/${ids.bob}`, { role: "editor" });
    expect(await status(bob, "PATCH", `/api/projects/${projectId}`, { title: "Shared" })).toBe(200);
    await alice.patch(`/api/projects/${projectId}/members/${ids.alice}`, { role: "viewer" }, 400);
    await alice.del(`/api/projects/${projectId}/members/${ids.alice}`, 400);

    await alice.del(`/api/projects/${projectId}/members/${ids.carol}`, 200);
    expect(await status(carol, "GET", `/api/projects/${projectId}`)).toBe(404);
    await inviteAndAccept(carol, "carol", "viewer");
    await carol.del(`/api/projects/${projectId}/members/${ids.carol}`, 200);
    expect(await status(carol, "GET", `/api/projects/${projectId}`)).toBe(404);

    const actions = (
      await h.deps.db.select({ a: auditEvents.action }).from(auditEvents).where(eq(auditEvents.projectId, projectId))
    ).map((r) => r.a);
    for (const a of [
      "member.invite",
      "member.accept",
      "member.decline",
      "member.invite_revoke",
      "member.role_change",
      "member.remove",
      "member.leave",
    ])
      expect(actions).toContain(a);
  });

  test("membership changes reach the project's live events", async () => {
    const seen: string[] = [];
    const unsubscribe = h.deps.events.subscribe(h.config.REDIS_URL, projectId, (m) => seen.push(m));
    await unsubscribe.ready;
    await alice.patch(`/api/projects/${projectId}/members/${ids.bob}`, { role: "viewer" });
    await alice.patch(`/api/projects/${projectId}/members/${ids.bob}`, { role: "editor" });
    await waitFor(async () => seen.some((m) => m.includes('"members.updated"')), { label: "members event" });
    await unsubscribe();
  });
});

describe("invitations by email", () => {
  test("a new address signs up from the link while registration is closed, once", async () => {
    h.config.REGISTRATION_ENABLED = false;
    try {
      const stranger = h.client();
      await stranger.post(
        "/api/auth/register",
        { username: "eve", email: "eve@example.com", password: "eve-pass-1234" },
        403,
      );
      await alice.post(`/api/projects/${projectId}/invites`, { identifier: "Eve@Example.com", role: "viewer" }, 201);
      const token = await mailedToken("eve@example.com");
      // Stored only as a hash.
      const rows = await h.deps.db.select().from(projectInvites).where(eq(projectInvites.email, "eve@example.com"));
      expect(rows[0]!.tokenHash).not.toBe(token);
      expect(JSON.stringify(rows)).not.toContain(token);

      const preview = await stranger.get<{ invite: { accountExists: boolean; email: string; role: string } }>(
        `/api/public/invites/${token}`,
      );
      expect(preview.invite).toMatchObject({ accountExists: false, email: "eve@example.com", role: "viewer" });
      const r = await stranger.post<{ user: { email: string }; projectId: string }>(
        "/api/auth/invite-signup",
        { token, username: "eve", password: "eve-pass-1234" },
        201,
      );
      expect(r.user.email).toBe("eve@example.com");
      expect(r.projectId).toBe(projectId);
      expect(await status(stranger, "GET", `/api/projects/${projectId}`)).toBe(200);
      expect(await status(stranger, "PATCH", `/api/projects/${projectId}`, { title: "x" })).toBe(403);

      // Used once: neither a second account nor a second accept.
      const again = h.client();
      const reuse = await again.raw("POST", "/api/auth/invite-signup", {
        token,
        username: "eve2",
        password: "eve-pass-1234",
      });
      expect(reuse.status).toBe(400);
      expect(((await reuse.json()) as { error: { code: string } }).error.code).toBe("invalid_token");
      await again.get(`/api/public/invites/${token}`, 404);
    } finally {
      h.config.REGISTRATION_ENABLED = true;
    }
  });

  test("an expired link is refused, and a taken username leaves the link usable", async () => {
    await alice.post(`/api/projects/${projectId}/invites`, { identifier: "frank@example.com", role: "editor" }, 201);
    const token = await mailedToken("frank@example.com");
    const anon = h.client();
    await anon.post("/api/auth/invite-signup", { token, username: "bob", password: "frank-pass-1234" }, 409);
    await h.deps.db
      .update(projectInvites)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(projectInvites.email, "frank@example.com"));
    await anon.post("/api/auth/invite-signup", { token, username: "frank", password: "frank-pass-1234" }, 400);
  });

  test("an address with an account accepts the link signed in as that account only", async () => {
    await alice.post(`/api/projects/${projectId}/invites`, { identifier: "dave@example.com", role: "viewer" }, 201);
    const token = await mailedToken("dave@example.com");
    expect(
      (await h.client().get<{ invite: { accountExists: boolean } }>(`/api/public/invites/${token}`)).invite
        .accountExists,
    ).toBe(true);
    // It is also in dave's invitations in the app.
    expect((await dave.get<{ invites: unknown[] }>("/api/invites")).invites).toHaveLength(1);
    const wrong = await bob.raw("POST", "/api/invites/accept-link", { token });
    expect(wrong.status).toBe(403);
    await dave.post<{ projectId: string }>("/api/invites/accept-link", { token }, 200);
    expect(await status(dave, "GET", `/api/projects/${projectId}`)).toBe(200);
    await alice.del(`/api/projects/${projectId}/members/${ids.dave}`, 200);
  });

  test("wrong link tokens are capped per address", async () => {
    const guesser = h.client();
    const ip = { "x-real-ip": "10.20.30.40" };
    for (let i = 0; i < 10; i++)
      expect((await guesser.raw("GET", `/api/public/invites/not-a-real-token-${i}`, undefined, ip)).status).toBe(404);
    expect((await guesser.raw("GET", "/api/public/invites/not-a-real-token-x", undefined, ip)).status).toBe(429);
    expect(
      (
        await guesser.raw(
          "POST",
          "/api/auth/invite-signup",
          { token: "not-a-real-token-y", username: "zed", password: "zed-pass-12345" },
          ip,
        )
      ).status,
    ).toBe(429);
  });
});

describe("agents of members", () => {
  async function mcpAs(c: TestClient, grant: Record<string, unknown>) {
    const { token, connection } = await c.post<{ token: string; connection: { id: string } }>(
      "/api/agents/tokens",
      {
        name: "member agent",
        scopes: ["projects:read", "projects:write", "chapters:read"],
        approvalMode: "ALLOW_ALL",
        ...grant,
      },
      201,
    );
    const client = new Client({ name: "member-agent", version: "1.0.0" });
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
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await client.callTool({ name, arguments: args });
      const text = (r.content as { type: string; text?: string }[]).find((x) => x.type === "text")?.text ?? "{}";
      return r.isError
        ? { error: (JSON.parse(text) as { error: { code: string } }).error, data: null }
        : { error: null, data: (r.structuredContent as { data: Record<string, unknown> }).data };
    };
    return { call, connectionId: connection.id };
  }

  test("a member's connection reaches a shared project with the member's role, and loses it with the membership", async () => {
    await inviteAndAccept(carol, "carol", "viewer");
    const all = await mcpAs(carol, { projectAccess: "all" });
    const list = await all.call("list_projects");
    expect(JSON.stringify(list.data)).toContain(projectId);
    expect((await all.call("get_project", { projectId })).error).toBeNull();
    // A viewer's agent is a viewer too.
    expect((await all.call("update_project", { projectId, title: "agent was here" })).error?.code).toBe("forbidden");

    // A shared project can be one of a connection's selected projects.
    const selected = await mcpAs(carol, { projectAccess: "selected", projectIds: [projectId] });
    expect((await selected.call("get_project", { projectId })).error).toBeNull();

    // An editor's agent edits.
    const editor = await mcpAs(bob, { projectAccess: "all" });
    expect((await editor.call("update_project", { projectId, title: "Shared by agent" })).error).toBeNull();

    await alice.del(`/api/projects/${projectId}/members/${ids.carol}`, 200);
    expect((await all.call("get_project", { projectId })).error?.code).toBe("not_found");
    expect((await selected.call("get_project", { projectId })).error?.code).toBe("not_found");
    // The grant went with the membership, so rejoining does not quietly bring it back.
    const grants = await h.deps.db
      .select()
      .from(userServiceProjects)
      .where(
        and(eq(userServiceProjects.serviceId, selected.connectionId), eq(userServiceProjects.projectId, projectId)),
      );
    expect(grants).toHaveLength(0);
  });
});
