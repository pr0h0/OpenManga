import { afterAll, beforeAll, expect, test } from "bun:test";
import { projectMembers, sql } from "@openmanga/db";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. "Who's there?" Woo Jin asked.`;

type Step = { tool: string | null; status: string; result?: unknown; approvalRequestId?: string };
type Run = {
  id: string;
  status: string;
  plan: { summary: string; steps: { title: string; tools: string[] }[] } | null;
  steps: Step[];
  summary: string | null;
  error: string | null;
  approval: { id: string; status: string; tool: string } | null;
  job: { status: string } | null;
};

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let other: TestClient;
let projectId: string;
let otherProjectId: string;

const get = (id: string) => u.get<{ run: Run }>(`/api/agent-runs/${id}`).then((r) => r.run);
const until = (id: string, statuses: string[], label = statuses.join("/")) =>
  waitFor(
    async () => {
      const r = await get(id);
      return statuses.includes(r.status) ? r : null;
    },
    { label, timeoutMs: 120_000 },
  );
const start = async (goal: string, extra: Record<string, unknown> = {}) =>
  (await u.post<{ run: Run }>(`/api/projects/${projectId}/agent-runs`, { goal, ...extra }, 201)).run;
const approvePlan = (id: string) => u.post(`/api/agent-runs/${id}/plan`, { decision: "approve" });

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  other = h.client();
  await u.post(
    "/api/auth/register",
    { username: "agentuser", email: "ag@example.com", password: "agent pass 123" },
    201,
  );
  await other.post(
    "/api/auth/register",
    { username: "agentother", email: "ao@example.com", password: "agent pass 123" },
    201,
  );
  const mk = async (title: string) =>
    (
      await u.post<{ project: { id: string } }>(
        "/api/projects",
        { title, story: { content: STORY, inputKind: "story" } },
        201,
      )
    ).project.id;
  projectId = await mk("Agent project");
  otherProjectId = await mk("Another project");
}, 60_000);
afterAll(() => h?.stop());

test("plan first: nothing runs until the plan is approved; a plan can be sent back with feedback", async () => {
  const run = await start("Audit this project and tell me what is missing");
  expect(["planning", "awaiting_plan"]).toContain(run.status);
  const planned = await until(run.id, ["awaiting_plan"]);
  expect(planned.plan!.steps[0]!.tools).toEqual(["get_project_health"]);
  expect(planned.steps).toEqual([]);
  // Approving is the only way on; a step cannot run while the plan waits.
  await u.post(`/api/agent-runs/${run.id}/plan`, { decision: "revise" }, 409);
  await u.post(`/api/agent-runs/${run.id}/plan`, { decision: "revise", feedback: "Keep it short" });
  const revised = await until(run.id, ["awaiting_plan"]);
  expect(revised.plan!.summary).toStartWith("Revised plan");

  await approvePlan(run.id);
  const done = await until(run.id, ["completed"]);
  expect(done.steps.map((s) => [s.tool, s.status])).toEqual([
    ["get_project_health", "completed"],
    [null, "finished"],
  ]);
  expect(done.summary).toBe("mock agent done after 1 step(s)");
  // Approving again is refused: the run is past its plan.
  await u.post(`/api/agent-runs/${run.id}/plan`, { decision: "approve" }, 409);
  const { runs } = await u.get<{ runs: { id: string; status: string }[] }>(`/api/projects/${projectId}/agent-runs`);
  expect(runs[0]).toMatchObject({ id: run.id, status: "completed" });
});

test("a call that needs approval waits for it, then continues from the result", async () => {
  const run = await start("Export the project [[mock:agent-export]]");
  await until(run.id, ["awaiting_plan"]);
  await approvePlan(run.id);
  const waiting = await until(run.id, ["waiting_approval"]);
  expect(waiting.approval).toMatchObject({ status: "pending", tool: "create_export" });
  expect(waiting.steps.at(-1)).toMatchObject({ tool: "create_export", status: "pending_approval" });
  // The same approval queue as any connected agent.
  const { approvals } = await u.get<{ approvals: { id: string }[] }>("/api/agents/approvals");
  expect(approvals.map((a) => a.id)).toContain(waiting.approval!.id);
  await u.post(`/api/agents/approvals/${waiting.approval!.id}/decide`, { decision: "approve" });
  const done = await until(run.id, ["completed"]);
  const exported = done.steps.find((s) => s.tool === "create_export")!;
  expect(exported.status).toBe("completed");
  expect(JSON.stringify(exported.result)).toContain("project_json");
});

test("a denied call is recorded as denied and the agent stops short of it", async () => {
  const run = await start("Export again [[mock:agent-export]]");
  await until(run.id, ["awaiting_plan"]);
  await approvePlan(run.id);
  const waiting = await until(run.id, ["waiting_approval"]);
  await u.post(`/api/agents/approvals/${waiting.approval!.id}/decide`, { decision: "deny" });
  const done = await until(run.id, ["completed"]);
  expect(done.steps.find((s) => s.tool === "create_export")!.status).toBe("denied");
});

test("an unknown tool and another project's id are errors the agent sees, not crashes", async () => {
  const bad = await start("Try something odd [[mock:agent-bad]]");
  await until(bad.id, ["awaiting_plan"]);
  await approvePlan(bad.id);
  const r1 = await until(bad.id, ["completed"]);
  expect(r1.steps[0]).toMatchObject({ tool: "no_such_tool", status: "error" });
  expect(JSON.stringify(r1.steps[0]!.result)).toContain("unknown_tool");

  // The run's connection is held to its own project, even though the user owns the other one too.
  const cross = await start(`Read the other one [[mock:agent-project:${otherProjectId}]]`);
  await until(cross.id, ["awaiting_plan"]);
  await approvePlan(cross.id);
  const r2 = await until(cross.id, ["completed"]);
  expect(r2.steps[0]).toMatchObject({ tool: "get_project_health", status: "error" });
  expect(JSON.stringify(r2.steps[0]!.result)).toContain("project_not_granted");
});

test("limits: a spent budget stops the run before its first step; a run that never finishes stops at 25 steps", async () => {
  const broke = await start("Audit [[mock:agent-loop]]", { budgetUsd: 0 });
  await until(broke.id, ["awaiting_plan"]);
  await approvePlan(broke.id);
  const r1 = await until(broke.id, ["stopped"]);
  expect(r1.error).toMatch(/budget/);
  expect(r1.steps).toEqual([]);

  const loop = await start("Audit forever [[mock:agent-loop]]");
  await until(loop.id, ["awaiting_plan"]);
  await approvePlan(loop.id);
  const r2 = await until(loop.id, ["stopped"]);
  expect(r2.steps.length).toBe(25);
  expect(r2.error).toMatch(/25 steps/);
}, 180_000);

test("a run can be cancelled, and is its starter's alone", async () => {
  const run = await start("Audit [[mock:agent-loop]]");
  await until(run.id, ["awaiting_plan"]);
  await other.get(`/api/agent-runs/${run.id}`, 404);
  await other.post(`/api/agent-runs/${run.id}/cancel`, {}, 404);
  const { run: cancelled } = await u.post<{ run: Run }>(`/api/agent-runs/${run.id}/cancel`, {});
  expect(cancelled.status).toBe("cancelled");
  // The in-app agent is a connection like any other in Agent access.
  const { connections } = await u.get<{ connections: { kind: string; name: string }[] }>("/api/agents/connections");
  expect(connections.filter((x) => x.kind === "app").map((x) => x.name)).toEqual(["In-app agent"]);
});

test("an agent's thinking jobs are its starter's: another member of the project cannot read them", async () => {
  const run = await start("Audit this project");
  const planned = await until(run.id, ["awaiting_plan"]);
  expect(planned.plan).not.toBeNull();
  const [job] = await h.deps.db.execute<{ id: string }>(
    sql`select id from generation_jobs where kind = 'agent_step' and target_id = ${run.id} limit 1`,
  );
  // Another user made an editor of the project sees the project's jobs, but not this one's content.
  const [o] = await h.deps.db.execute<{ id: string }>(sql`select id from users where username = 'agentother'`);
  await h.deps.db.insert(projectMembers).values({ projectId, userId: o!.id, role: "editor" });
  await other.get(`/api/generations/${job!.id}`, 404);
  await other.get(`/api/generations/${job!.id}/manual`, 404);
  await other.get(`/api/jobs/${job!.id}`, 404);
  const listed = await other.get<{ jobs: { id: string; result: unknown; input?: unknown }[] }>(
    `/api/projects/${projectId}/generations?kind=agent_step`,
  );
  const mine = listed.jobs.find((j) => j.id === job!.id);
  expect(mine?.result ?? null).toBeNull();
  // The starter still reads it.
  const own = await u.get<{ job: { result: { plan?: unknown } } }>(`/api/generations/${job!.id}`);
  expect(own.job.result.plan).toBeDefined();
  await u.post(`/api/agent-runs/${run.id}/cancel`, {});
});
