import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, users } from "@openmanga/db";
import type { McpActor } from "../../apps/api/src/mcp/context.ts";
import { startHarness, type TestClient } from "./harness.ts";

/** Local usage stats: per user, route patterns only (never ids), off on request, and only totals for an admin. */

type Stats = {
  enabled: boolean;
  pages: { route: string; visits: number; ms: number }[];
  actions: { action: string; source: string; count: number; errors: number; ms: number; users?: number }[];
};

let h: Awaited<ReturnType<typeof startHarness>>;
let a: TestClient;
let b: TestClient;
let projectId = "";

beforeAll(async () => {
  h = await startHarness();
  a = h.client();
  b = h.client();
  await a.post(
    "/api/auth/register",
    { username: "tally", email: "tally@example.com", password: "tally-pass-123" },
    201,
  );
  await b.post(
    "/api/auth/register",
    { username: "boss2", email: "boss2@example.com", password: "boss2-pass-123" },
    201,
  );
  await h.deps.db.update(users).set({ role: "admin" }).where(eq(users.username, "boss2"));
  projectId = (await a.post<{ project: { id: string } }>("/api/projects", { title: "Counted" }, 201)).project.id;
});
afterAll(() => h?.stop());

test("write requests are counted by route pattern, with errors and time, and never carry an id", async () => {
  const ch = (await a.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "C" }, 201))
    .chapter;
  await a.patch(`/api/chapters/${ch.id}`, { title: "C2" });
  await a.patch(`/api/chapters/${crypto.randomUUID()}`, { title: "nope" }, 404);
  const s = await a.get<Stats>("/api/me/activity");
  expect(s.enabled).toBe(true);
  const by = (k: string) => s.actions.find((x) => x.action === k);
  expect(by("POST /api/projects")).toMatchObject({ source: "web", count: 1, errors: 0 });
  expect(by("POST /api/projects/:projectId/chapters")?.count).toBe(1);
  expect(by("PATCH /api/chapters/:id")).toMatchObject({ count: 2, errors: 1 });
  expect(by("PATCH /api/chapters/:id")!.ms).toBeGreaterThanOrEqual(0);
  // Reads are not actions.
  expect(s.actions.some((x) => x.action.startsWith("GET "))).toBe(false);
  expect(JSON.stringify(s)).not.toContain(projectId);
  expect(JSON.stringify(s)).not.toContain(ch.id);
});

test("screen time is stored per route template; a path with a real id is refused", async () => {
  await a.post("/api/me/activity", {
    pages: [
      { route: "/projects/$projectId/pages/$pageId", visits: 2, ms: 45_000 },
      { route: "/", visits: 1, ms: 5_000 },
    ],
  });
  await a.post("/api/me/activity", { pages: [{ route: "/projects/$projectId/pages/$pageId", visits: 1, ms: 15_000 }] });
  await a.post("/api/me/activity", { pages: [{ route: `/projects/${projectId}`, visits: 1, ms: 1 }] }, 422);
  await a.post("/api/me/activity", { pages: [{ route: "/projects/abc123", visits: 1, ms: 1 }] }, 422);
  const s = await a.get<Stats>("/api/me/activity?days=7");
  expect(s.pages[0]).toMatchObject({ route: "/projects/$projectId/pages/$pageId", visits: 3, ms: 60_000 });
  expect(s.pages.find((p) => p.route === "/")?.ms).toBe(5_000);
});

test("each user sees only their own; an admin sees totals with user counts and no identities", async () => {
  await b.post("/api/projects", { title: "Boss's" }, 201);
  const mine = await b.get<Stats>("/api/me/activity");
  expect(mine.pages).toHaveLength(0);
  expect(mine.actions.find((x) => x.action === "POST /api/projects")?.count).toBe(1);
  await a.get("/api/admin/activity", 403);
  const all = await b.get<Stats & { users: number }>("/api/admin/activity");
  expect(all.users).toBe(2);
  expect(all.actions.find((x) => x.action === "POST /api/projects")).toMatchObject({ count: 2, users: 2 });
  const text = JSON.stringify(all);
  for (const leak of ["tally", "boss2", projectId]) expect(text).not.toContain(leak);
});

test("turned off, nothing more is recorded; clearing deletes everything", async () => {
  await a.patch("/api/auth/settings", { activityTracking: false });
  const before = await a.get<Stats>("/api/me/activity");
  expect(before.enabled).toBe(false);
  await a.post("/api/projects", { title: "Uncounted" }, 201);
  await a.post("/api/me/activity", { pages: [{ route: "/", visits: 5, ms: 9_000 }] });
  const after = await a.get<Stats>("/api/me/activity");
  expect(after.actions.find((x) => x.action === "POST /api/projects")?.count).toBe(1);
  expect(after.pages.find((p) => p.route === "/")?.ms).toBe(5_000);
  await a.del("/api/me/activity");
  const cleared = await a.get<Stats>("/api/me/activity");
  // Turning stats off is itself the last write counted before they stopped; clearing removes it too.
  expect(cleared.pages).toHaveLength(0);
  expect(cleared.actions).toHaveLength(0);
});

test("a call an agent makes through MCP counts as an agent action", async () => {
  await a.patch("/api/auth/settings", { activityTracking: true });
  const { invoke } = await import("../../apps/api/src/mcp/runtime.ts");
  const me = (await a.get<{ user: McpActor["user"] }>("/api/auth/me")).user;
  const actor = {
    user: me,
    serviceId: crypto.randomUUID(),
    serviceName: "test agent",
    serviceKind: "pat",
    clientId: null,
    scopes: new Set(),
    declinedScopes: new Set(),
    projectAccess: "all",
    projectIds: new Set(),
    allowProjectCreate: true,
    approvalMode: "never",
  } as unknown as McpActor;
  await invoke(h.deps, actor, "PATCH", `/api/projects/${projectId}`, { body: { title: "Renamed by agent" } });
  const s = await a.get<Stats>("/api/me/activity");
  expect(s.actions.find((x) => x.action === "PATCH /api/projects/:projectId")).toMatchObject({
    source: "agent",
    count: 1,
  });
});
