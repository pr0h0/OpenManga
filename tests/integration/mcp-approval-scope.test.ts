import { afterAll, beforeAll, expect, test } from "bun:test";
import { advanceRun } from "../../apps/api/src/lib/production.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows and smiled.
The door slammed shut with a BANG.`;
const ALL = [
  "projects:read",
  "projects:write",
  "projects:create",
  "story:read",
  "story:write",
  "library:read",
  "library:write",
  "chapters:read",
  "chapters:write",
  "panels:read",
  "panels:write",
  "generations:read",
  "generations:run",
  "narration:read",
  "narration:write",
  "exports:read",
  "exports:create",
  "experts:use",
  "usage:read",
  "stats:read",
];

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post(
    "/api/auth/register",
    { username: "mcpaudit", email: "mcpaudit@example.com", password: "mcpaudit-pass-1" },
    201,
  );
}, 60_000);
afterAll(() => h?.stop());

let rpcId = 0;
type CallResult = { status: string; approval?: { approvalRequestId: string }; data?: unknown; error?: unknown };
async function call(token: string, name: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = await h.app.request("http://test.local/mcp", {
    method: "POST",
    headers: {
      host: "test.local",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.includes("data:")
    ? text
        .split("\n")
        .find((l) => l.startsWith("data:"))!
        .slice(5)
    : text;
  const msg = JSON.parse(line) as {
    result?: { isError?: boolean; structuredContent?: Record<string, unknown>; content?: { text?: string }[] };
    error?: unknown;
  };
  if (msg.error) return { status: "rpc_error", error: msg.error };
  const r = msg.result!;
  if (r.isError) return { status: "error", error: JSON.parse(r.content?.[0]?.text ?? "{}").error };
  return r.structuredContent as CallResult;
}

const pat = async (scopes: string[], approvalMode: "ALLOW_ALL" | "REQUIRE_APPROVAL") =>
  (
    await u.post<{ token: string }>(
      "/api/agents/tokens",
      { name: `audit ${approvalMode} ${scopes.length}`, scopes, projectAccess: "all", approvalMode },
      201,
    )
  ).token;

async function project(title: string) {
  const p = await u.post<{ project: { id: string } }>(
    "/api/projects",
    { title, story: { content: STORY, inputKind: "story" } },
    201,
  );
  await u.patch(`/api/projects/${p.project.id}`, { settings: { budgetUsd: 50 } });
  return p.project.id;
}

type Run = { id: string; status: string; reason: string | null; steps: { key: string; status: string }[] };
const until = (projectId: string, want: string[], allowWaiting = false) =>
  waitFor(
    async () => {
      const { runs } = await u.get<{ runs: Run[] }>(`/api/projects/${projectId}/production-runs`);
      const run = runs[0]!;
      if (want.includes(run.status)) return run;
      if (run.status === "failed") throw new Error(`run failed: ${run.reason}`);
      if (run.status === "waiting" && !allowWaiting) throw new Error(`run waiting: ${run.reason}`);
      await advanceRun(h.deps, run.id);
      return null;
    },
    { label: want.join("/"), timeoutMs: 180_000 },
  );

test("update_project waits for approval for every owner-only setting, like project_storage", async () => {
  const pid = await project("A storage");
  const token = await pat(ALL, "REQUIRE_APPROVAL");
  const policy = { enabled: true, maxAgeDays: 1, kindAges: { trash: 1, panel_version: 1, export: 1 }, capGb: null };
  for (const settings of [
    { budgetUsd: 999 },
    { storage: policy },
    { consistencyCheck: { enabled: true, autoFixBudgetUsd: 10000 } },
    { contentPolicyFallback: { enabled: true } },
  ])
    expect((await call(token, "update_project", { projectId: pid, settings })).status).toBe("pending_approval");
  expect((await call(token, "update_project", { projectId: pid, settings: { imageQuality: "high" } })).status).toBe(
    "completed",
  );
  const { project: p } = await u.get<{ project: { settings: Record<string, unknown> } }>(`/api/projects/${pid}`);
  expect(p.settings.storage).toBeUndefined();
  // Sending the current budget back with an ordinary edit changes nothing owner-only.
  expect(
    (
      await call(token, "update_project", {
        projectId: pid,
        settings: { budgetUsd: p.settings.budgetUsd, imageQuality: "low" },
      })
    ).status,
  ).toBe("completed");
}, 60_000);

test("a production run needs the scopes of the steps it does, not just generations:run", async () => {
  const pid = await project("B scope");
  const token = await pat(["generations:run"], "ALLOW_ALL");
  const started = await call(token, "start_production_run", {
    projectId: pid,
    reviewGates: false,
    preparePrompts: false,
    render: false,
    youtube: false,
  });
  expect(started.status).toBe("error");
  const { runs } = await u.get<{ runs: unknown[] }>(`/api/projects/${pid}/production-runs`);
  expect(runs).toHaveLength(0);
}, 60_000);

test("an approved continue passes only the review it was asked for", async () => {
  const pid = await project("C continue");
  const token = await pat(ALL, "REQUIRE_APPROVAL");
  await u.post(
    `/api/projects/${pid}/production-runs`,
    { reviewGates: true, preparePrompts: false, render: false, youtube: false },
    201,
  );
  let run = await until(pid, ["waiting"], true);
  const step1 = run.steps.find((s) => s.status === "review")?.key;
  const parked = await call(token, "continue_production_run", { runId: run.id });
  // The user continues this review in the app themselves; the run advances to the next review.
  await u.post(`/api/production-runs/${run.id}/continue`, {});
  run = await waitFor(
    async () => {
      const r = (await u.get<{ run: Run }>(`/api/production-runs/${run.id}`)).run;
      const k = r.steps.find((s) => s.status === "review")?.key;
      if (r.status === "waiting" && k && k !== step1) return r;
      if (r.status !== "waiting") await advanceRun(h.deps, r.id);
      return null;
    },
    { label: "next review", timeoutMs: 180_000 },
  );
  const step2 = run.steps.find((s) => s.status === "review")?.key;
  const id = parked.approval!.approvalRequestId;
  const d = await u.post<{ approval: { status: string } }>(`/api/agents/approvals/${id}/decide`, {
    decision: "approve",
  });
  const r2 = (await u.get<{ run: Run }>(`/api/production-runs/${run.id}`)).run;
  expect(d.approval.status).toBe("stale");
  expect(r2.steps.find((s) => s.key === step2)?.status).toBe("review");
}, 300_000);
