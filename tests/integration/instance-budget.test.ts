import { afterAll, beforeAll, expect, test } from "bun:test";
import { aiUsage, and, eq, generationJobs, users } from "@openmanga/db";
import { advanceRun } from "../../apps/api/src/lib/production.ts";
import { runGenerationJob } from "../../apps/worker/src/lib/runner.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

/** The server-wide monthly ceiling sits above every project's cap, and nobody but an admin can move it. */

let h: Awaited<ReturnType<typeof startHarness>>;
let admin: TestClient;
let alice: TestClient;
let projectId = "";
let chapterId = "";
let panelId = "";

type Budget = { limitUsd: number | null; source: string; spentUsd: number; exceeded: boolean; monthStart: string };

/** Real (non-mock) spend this month, which is what the ceiling counts. */
const spend = (usd: number) =>
  h.deps.db.insert(aiUsage).values({
    provider: "openai",
    model: "gpt-image-2",
    operation: "panel_generation",
    projectId,
    images: 1,
    estimatedCostUsd: String(usd),
  });

beforeAll(async () => {
  h = await startHarness();
  admin = h.client();
  alice = h.client();
  await admin.post(
    "/api/auth/register",
    { username: "boss", email: "boss@example.com", password: "boss-pass-1234" },
    201,
  );
  await h.deps.db.update(users).set({ role: "admin" }).where(eq(users.username, "boss"));
  await alice.post(
    "/api/auth/register",
    { username: "spender", email: "sp@example.com", password: "spend-pass-1234" },
    201,
  );
  projectId = (await alice.post<{ project: { id: string } }>("/api/projects", { title: "Spend" }, 201)).project.id;
  // No project cap, so only the server's ceiling can stop anything here.
  await alice.patch(`/api/projects/${projectId}`, { settings: { budgetUsd: null } });
  chapterId = (
    await alice.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "C" }, 201)
  ).chapter.id;
  const page = await alice.post<{ page: { id: string } }>(
    `/api/chapters/${chapterId}/pages`,
    { layoutTemplate: "four-grid" },
    201,
  );
  const doc = await alice.get<{ panels: { id: string }[] }>(`/api/pages/${page.page.id}`);
  panelId = doc.panels[0]!.id;
  for (const p of doc.panels) await alice.patch(`/api/panels/${p.id}`, { promptOverride: `draw ${p.id.slice(0, 4)}` });
});
afterAll(() => h?.stop());

test("only admins see and set the ceiling; the env value is the default and an admin's value overrides it", async () => {
  await alice.get("/api/admin/budget", 403);
  await alice.raw("PUT", "/api/admin/budget", { monthlyUsd: 1 }).then((r) => expect(r.status).toBe(403));

  let r = await admin.get<{ budget: Budget; envDefaultUsd: number | null }>("/api/admin/budget");
  expect(r.budget).toMatchObject({ limitUsd: null, source: "none", exceeded: false });
  expect(r.budget.monthStart).toMatch(/^\d{4}-\d{2}-01T00:00:00Z$/);

  h.deps.config.INSTANCE_BUDGET_USD_MONTHLY = 50;
  r = await admin.get<typeof r>("/api/admin/budget");
  expect(r.budget).toMatchObject({ limitUsd: 50, source: "env" });
  expect(r.envDefaultUsd).toBe(50);

  const set = await admin.raw("PUT", "/api/admin/budget", { monthlyUsd: 10 });
  expect(set.status).toBe(200);
  expect(((await set.json()) as { budget: Budget }).budget).toMatchObject({ limitUsd: 10, source: "admin" });

  // Explicitly no ceiling, even with an env default.
  await admin.raw("PUT", "/api/admin/budget", { monthlyUsd: null });
  r = await admin.get<typeof r>("/api/admin/budget");
  expect(r.budget).toMatchObject({ limitUsd: null, source: "admin" });

  // Back to the default.
  await admin.raw("DELETE", "/api/admin/budget");
  r = await admin.get<typeof r>("/api/admin/budget");
  expect(r.budget).toMatchObject({ limitUsd: 50, source: "env" });
  h.deps.config.INSTANCE_BUDGET_USD_MONTHLY = undefined;
});

test("past the ceiling, new AI work is refused with its own code and no override", async () => {
  await admin.raw("PUT", "/api/admin/budget", { monthlyUsd: 5 });
  await spend(2);
  // Mock calls cost nothing real and do not count.
  await h.deps.db
    .insert(aiUsage)
    .values({ provider: "mock", model: "m", operation: "x", projectId, estimatedCostUsd: "100" });
  const under = await admin.get<{ budget: Budget }>("/api/admin/budget");
  expect(under.budget.spentUsd).toBe(2);
  expect(under.budget.exceeded).toBe(false);

  await spend(4);
  const refused = await alice.raw("POST", `/api/panels/${panelId}/generate`, {}, { "x-allow-over-budget": "1" });
  expect(refused.status).toBe(402);
  const err = ((await refused.json()) as { error: { code: string; message: string } }).error;
  expect(err.code).toBe("instance_budget_exceeded");
  expect(err.message).toMatch(/monthly AI budget of \$5\.00/);

  // An estimate is still free; confirming it is not.
  const bulk = await alice.raw(
    "POST",
    `/api/projects/${projectId}/generations/bulk`,
    { scope: { chapterId }, onlyMissing: false, confirm: true },
    { "x-allow-over-budget": "1" },
  );
  expect(bulk.status).toBe(402);
  await admin.raw("PUT", "/api/admin/budget", { monthlyUsd: null });
});

test("a queued batch pauses at the ceiling, cannot be resumed past it, and resumes once it is raised", async () => {
  // A provider batch run: its jobs wait for one submit job, which is the one the gate stops.
  const run = await alice.post<{ batchId: string }>(
    `/api/projects/${projectId}/generations/bulk`,
    { scope: { chapterId }, onlyMissing: false, confirm: true, batch: true },
    202,
  );
  const [submit] = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.batchId, run.batchId), eq(generationJobs.kind, "image_batch_submit")));

  // Spent this month is already $6; the ceiling drops below it while the run waits.
  await admin.raw("PUT", "/api/admin/budget", { monthlyUsd: 3 });
  await runGenerationJob(
    h.workerDeps,
    { data: { jobId: submit!.id }, queueName: "image-batch", attemptsMade: 0, opts: { attempts: 3 } } as never,
    async () => {
      throw new Error("the gate should have stopped this job before it ran");
    },
  );
  const jobs = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.batchId, run.batchId));
  expect(jobs.every((j) => j.status === "paused")).toBe(true);
  expect(jobs[0]!.failureReason).toMatch(/server's monthly AI budget of \$3\.00 is reached/);
  const view = await alice.get<{ batches: { batchId: string; state: string; pauseReason: string }[] }>(
    `/api/projects/${projectId}/generations/batches`,
  );
  expect(view.batches.find((b) => b.batchId === run.batchId)?.state).toBe("paused");

  const blocked = await alice.raw(
    "POST",
    `/api/generations/batches/${run.batchId}/resume`,
    {},
    { "x-allow-over-budget": "1" },
  );
  expect(blocked.status).toBe(402);
  expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe("instance_budget_exceeded");

  await admin.raw("PUT", "/api/admin/budget", { monthlyUsd: 100 });
  const resumed = await alice.post<{ resumed: number }>(`/api/generations/batches/${run.batchId}/resume`);
  expect(resumed.resumed).toBe(jobs.length);
});

test("a production run pauses at the ceiling with the server's reason", async () => {
  const p = await alice.post<{ project: { id: string } }>(
    "/api/projects",
    { title: "Run", story: { content: "Chapter 1: Dock\n\nMina waited at the dock for a ship.", inputKind: "story" } },
    201,
  );
  await alice.patch(`/api/projects/${p.project.id}`, { settings: { budgetUsd: 50 } });
  await admin.raw("PUT", "/api/admin/budget", { monthlyUsd: 1 });
  const { run } = await alice.post<{ run: { id: string } }>(
    `/api/projects/${p.project.id}/production-runs`,
    { reviewGates: false, render: false, youtube: false },
    201,
  );
  type Run = { id: string; status: string; reason: string | null };
  const runs = [
    await waitFor(
      async () => {
        const { runs } = await alice.get<{ runs: Run[] }>(`/api/projects/${p.project.id}/production-runs`);
        if (runs[0]!.status !== "running") return runs[0]!;
        await advanceRun(h.deps, run.id);
        return null;
      },
      { label: "the run stops" },
    ),
  ];
  expect(runs[0]).toMatchObject({ id: run.id, status: "paused" });
  expect(runs[0]!.reason).toMatch(/^Server budget ceiling reached: .*monthly AI budget of \$1\.00/);
  await admin.raw("PUT", "/api/admin/budget", { monthlyUsd: null });
});
