import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@openmanga/db";
import { startHarness, type TestClient } from "./harness.ts";

/** Recovery links, email invitations and unlisted addresses: each proves only what it should. */

let h: Awaited<ReturnType<typeof startHarness>>;
let owner: TestClient;

beforeAll(async () => {
  h = await startHarness();
  owner = h.client();
  await owner.post(
    "/api/auth/register",
    { username: "ahowner", email: "aho@example.com", password: "ahowner-pass-1" },
    201,
  );
});
afterAll(() => h?.stop());

const resetToken = async (email: string) => {
  const [m] = await h.deps.db.execute<{ text_body: string }>(
    sql`select text_body from dev_emails where "to" = ${email} order by created_at desc limit 1`,
  );
  return /token=([\w-]+)/.exec(m!.text_body)![1]!;
};

test("a new password, by change or by reset, ends every earlier reset link", async () => {
  const v = h.client();
  await v.post(
    "/api/auth/register",
    { username: "ahvictim", email: "ahv@example.com", password: "ahvictim-pass-1" },
    201,
  );
  await h.client().post("/api/auth/password-reset/request", { identifier: "ahv@example.com" });
  const early = await resetToken("ahv@example.com");
  await v.post("/api/auth/password", { currentPassword: "ahvictim-pass-1", newPassword: "ahvictim-pass-2" });
  await h.client().post("/api/auth/password-reset/confirm", { token: early, password: "attacker-pass-9" }, 400);
  // Two links out; using one ends the other.
  await h.client().post("/api/auth/password-reset/request", { identifier: "ahv@example.com" });
  const first = await resetToken("ahv@example.com");
  await h.client().post("/api/auth/password-reset/request", { identifier: "ahv@example.com" });
  const second = await resetToken("ahv@example.com");
  await h.client().post("/api/auth/password-reset/confirm", { token: second, password: "ahvictim-pass-3" });
  await h.client().post("/api/auth/password-reset/confirm", { token: first, password: "attacker-pass-9" }, 400);
  await h.client().post("/api/auth/login", { identifier: "ahvictim", password: "ahvictim-pass-3" }, 200);
});

test("an email invitation is not claimable in the app by whoever registered that address", async () => {
  const squatter = h.client();
  await squatter.post(
    "/api/auth/register",
    { username: "ahsquat", email: "someone@example.com", password: "ahsquat-pass-1" },
    201,
  );
  const pid = (await owner.post<{ project: { id: string } }>("/api/projects", { title: "Private" }, 201)).project.id;
  await owner.post(`/api/projects/${pid}/invites`, { identifier: "someone@example.com", role: "editor" }, 201);
  expect((await squatter.get<{ invites: unknown[] }>("/api/invites")).invites).toHaveLength(0);
  const [inv] = await h.deps.db.execute<{ id: string }>(sql`select id from project_invites where project_id = ${pid}`);
  await squatter.post(`/api/invites/${inv!.id}/accept`, {}, 404);
  // An invitation made before this rule, still naming the account, is not answerable in the app either.
  const [sq] = await h.deps.db.execute<{ id: string }>(sql`select id from users where username = 'ahsquat'`);
  await h.deps.db.execute(sql`update project_invites set user_id = ${sq!.id} where id = ${inv!.id}`);
  expect((await squatter.get<{ invites: unknown[] }>("/api/invites")).invites).toHaveLength(0);
  await squatter.post(`/api/invites/${inv!.id}/decline`, {}, 404);
  await squatter.post(`/api/invites/${inv!.id}/accept`, {}, 404);
  await squatter.get(`/api/projects/${pid}`, 404);
});

test("probing other series' addresses is throttled like the public page", async () => {
  const mine = (await owner.post<{ series: { id: string } }>("/api/series", { title: "Mine" }, 201)).series.id;
  const other = h.client();
  await other.post(
    "/api/auth/register",
    { username: "ahother", email: "aho2@example.com", password: "ahother-pass-1" },
    201,
  );
  const theirs = (await other.post<{ series: { id: string } }>("/api/series", { title: "Theirs" }, 201)).series.id;
  await other.patch(`/api/series/${theirs}`, { visibility: "unlisted", publicSlug: "hidden-one" });
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++)
    statuses.push((await owner.raw("PATCH", `/api/series/${mine}`, { publicSlug: "hidden-one" })).status);
  expect(statuses.slice(0, 30).every((s) => s === 409)).toBe(true);
  expect(statuses[30]).toBe(429);
});

test("an open event stream ends once its session is revoked (logout everywhere, password change)", async () => {
  const victim = h.client();
  await victim.post(
    "/api/auth/register",
    { username: "streamvictim", email: "sv@example.com", password: "stream-victim-1" },
    201,
  );
  const pid = (await victim.post<{ project: { id: string } }>("/api/projects", { title: "Streamed" }, 201)).project.id;
  // A copy of the cookie, as a thief would hold it.
  const thief = h.client();
  thief.cookies = new Map(victim.cookies);
  const res = await thief.raw("GET", `/api/projects/${pid}/events`);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  expect(first).toContain("event: ready");

  await victim.post("/api/auth/logout-all", {});
  // The stream re-checks its session at every ping (about 15 s) and closes; it never runs on.
  const ended = (async () => {
    for (;;) if ((await reader.read()).done) return true;
  })();
  const timeout = new Promise<boolean>((r) => setTimeout(() => r(false), 40_000));
  expect(await Promise.race([ended, timeout])).toBe(true);
}, 60_000);

test("the project audit log shows a viewer no one else's address or agent connection", async () => {
  const pid = (await owner.post<{ project: { id: string } }>("/api/projects", { title: "Audited" }, 201)).project.id;
  const ownerId = (await owner.get<{ user: { id: string } }>("/api/auth/me")).user.id;
  const viewer = h.client();
  await viewer.post(
    "/api/auth/register",
    { username: "auditview", email: "av@example.com", password: "audit-view-1" },
    201,
  );
  const viewerId = (await viewer.get<{ user: { id: string } }>("/api/auth/me")).user.id;
  await h.deps.db.execute(
    sql`insert into project_members (project_id, user_id, role) values (${pid}, ${viewerId}, 'viewer')`,
  );
  const serviceId = crypto.randomUUID();
  await h.deps.db.execute(sql`
    insert into audit_events (user_id, project_id, action, metadata, ip, service_id)
    values (${ownerId}, ${pid}, 'panel.update', ${JSON.stringify({ via: "Secret agent", field: "x" })}::jsonb, '203.0.113.9', ${serviceId})`);
  type Ev = { action: string; ip: string | null; serviceId: string | null; metadata: Record<string, unknown> };
  const seen = (await viewer.get<{ events: Ev[] }>(`/api/projects/${pid}/audit`)).events.find(
    (e) => e.action === "panel.update",
  )!;
  expect(seen).toMatchObject({ ip: null, serviceId: null, metadata: { field: "x" } });
  expect(seen.metadata.via).toBeUndefined();
  const own = (await owner.get<{ events: Ev[] }>(`/api/projects/${pid}/audit`)).events.find(
    (e) => e.action === "panel.update",
  )!;
  expect(own).toMatchObject({ ip: "203.0.113.9", serviceId, metadata: { via: "Secret agent" } });
});
