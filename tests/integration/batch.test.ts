import { afterAll, beforeAll, expect, test } from "bun:test";
import type {
  BatchHandle,
  BatchItemResult,
  BatchRequestSpec,
  BatchStatus,
  ImageBatchProvider,
} from "../../packages/ai-image/src/batch.ts";
import { aiUsage, and, eq, generationJobs, panels, providerBatches, sql } from "@openmanga/db";
import { mockImagePng } from "@openmanga/testing";
import { imageBatchSubmit, pollProviderBatches } from "../../apps/worker/src/handlers/image-batch.ts";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId = "";
let chapterId = "";
let panelIds: string[] = [];

/** Records what was submitted and hands back one image per request on the second poll. */
class FakeBatchProvider implements ImageBatchProvider {
  readonly provider = "openai";
  readonly model = "gpt-image-2";
  submitted: BatchRequestSpec[][] = [];
  polls = new Map<string, number>();
  released = 0;
  constructor(private readonly png: Uint8Array) {}
  chunk(reqs: BatchRequestSpec[]) {
    // Two per batch, so the multi-batch path is the one under test.
    return reqs.length > 2 ? [reqs.slice(0, 2), reqs.slice(2)] : [reqs];
  }
  async submitBatch(reqs: BatchRequestSpec[], idempotencyKey: string): Promise<BatchHandle> {
    this.submitted.push(reqs);
    return {
      handle: `batch_${this.submitted.length}`,
      keys: reqs.map((r) => r.key),
      idempotencyKey,
      ownedFileIds: ["file-a"],
    };
  }
  async pollBatch(hd: BatchHandle): Promise<BatchStatus> {
    // Per handle: each batch reports running once before it finishes, as a real one would.
    const seen = (this.polls.get(hd.handle) ?? 0) + 1;
    this.polls.set(hd.handle, seen);
    const total = hd.keys.length;
    if (seen <= 1) return { state: "running", counts: { total, completed: 0, failed: 0 } };
    // One request in the first batch fails, to prove partial results are handled.
    const items: BatchItemResult[] = hd.keys.map((key: string, i: number) =>
      i === 0 && hd.handle === "batch_1"
        ? { key, ok: false as const, code: "moderation_blocked", message: "rejected by the safety system" }
        : {
            key,
            ok: true as const,
            result: {
              data: this.png,
              mime: "image/png",
              width: 64,
              height: 64,
              provider: this.provider,
              model: this.model,
              quality: "low",
              requestId: null,
              latencyMs: 0,
              usage: {
                textInputTokens: 100,
                imageInputTokens: 200,
                imageOutputTokens: 300,
                cachedInputTokens: 0,
                raw: {},
              },
              request: { endpoint: "/v1/batches", size: "64x64", referenceCount: 1 },
            },
          },
    );
    const failed = items.filter((it) => !it.ok).length;
    return {
      state: failed ? "partial" : "succeeded",
      counts: { total, completed: total - failed, failed },
      items,
    };
  }
  async cancelBatch() {}
  async releaseBatch() {
    this.released++;
  }
  async findByIdempotencyKey() {
    return null;
  }
}

let fake: FakeBatchProvider;

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "batcher", email: "batch@example.com", password: "batching-pass-1" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Batch" }, 201);
  projectId = p.project.id;
  const ch = await alice.post<{ chapter: { id: string } }>(
    `/api/projects/${projectId}/chapters`,
    { title: "One" },
    201,
  );
  chapterId = ch.chapter.id;
  const page = await alice.post<{ page: { id: string } }>(
    `/api/chapters/${chapterId}/pages`,
    { layoutTemplate: "four-grid" },
    201,
  );
  const doc = await alice.get<{ panels: { id: string }[] }>(`/api/pages/${page.page.id}`);
  panelIds = doc.panels.slice(0, 3).map((x) => x.id);
  for (const id of panelIds) await alice.patch(`/api/panels/${id}`, { promptOverride: `draw panel ${id.slice(0, 4)}` });

  fake = new FakeBatchProvider(await mockImagePng({ width: 64, height: 64, prompt: "batch" }));
  // The harness runs in mock mode, where there is no real batch provider to resolve.
  h.workerDeps.resolver.imageBatch = (async () => fake) as typeof h.workerDeps.resolver.imageBatch;
  h.deps.resolver.imageBatch = h.workerDeps.resolver.imageBatch;
});
afterAll(() => h?.stop());

test("a batch run writes its panels unqueued, then parks them on the provider", async () => {
  const r = await alice.post<{ batchId: string; jobs: { id: string }[] }>(
    `/api/projects/${projectId}/generations/bulk`,
    { scope: { panelIds }, onlyMissing: false, confirm: true, batch: true },
    202,
  );
  expect(r.jobs).toHaveLength(3);

  // Not queued: nothing may generate these synchronously while the submitter collects them.
  const rows = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.batchId, r.batchId), eq(generationJobs.kind, "panel_generation")));
  expect(rows.map((x) => x.status)).toEqual(["queued", "queued", "queued"]);
  expect(rows.every((x) => x.parameters.batchMode === true)).toBe(true);
  for (const row of rows) expect(await h.deps.queue.has("image-generation", row.id)).toBe(false);

  const [submitJob] = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.batchId, r.batchId), eq(generationJobs.kind, "image_batch_submit")));
  expect(submitJob).toBeTruthy();

  // Phase one.
  const out = await imageBatchSubmit(h.workerDeps, submitJob!);
  expect(out).toEqual({ submitted: 3, batches: 2, fellBack: 0 });
  expect(fake.submitted.map((c) => c.length)).toEqual([2, 1]);
  // Every spec carries the prompt and its references, keyed by job id.
  expect(
    fake.submitted
      .flat()
      .map((s) => s.key)
      .sort(),
  ).toEqual([...rows.map((x) => x.id)].sort());

  const parked = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.batchId, r.batchId), eq(generationJobs.kind, "panel_generation")));
  expect(parked.every((x) => x.status === "submitted")).toBe(true);
  expect(parked.every((x) => typeof x.parameters.providerBatchId === "string")).toBe(true);
  const batches = await h.deps.db.select().from(providerBatches).where(eq(providerBatches.projectId, projectId));
  expect(batches).toHaveLength(2);
  expect(batches.every((b) => b.state === "pending" && b.capability === "image")).toBe(true);
});

test("re-running the submit job submits nothing further", async () => {
  const [submitJob] = await h.deps.db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.kind, "image_batch_submit"));
  const before = fake.submitted.length;
  const out = await imageBatchSubmit(h.workerDeps, submitJob!);
  expect(out.submitted).toBe(0);
  expect(fake.submitted.length).toBe(before);
});

test("polling ingests the finished batch: art activated, failures reported, spend at the batch rate", async () => {
  // First pass: still running, so nothing is ingested and the jobs stay parked.
  const first = await pollProviderBatches(h.workerDeps);
  expect(first.polled).toBe(2);
  expect(first.ingested).toBe(0);
  const stillParked = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.kind, "panel_generation"));
  expect(stillParked.every((x) => x.status === "submitted")).toBe(true);

  const second = await pollProviderBatches(h.workerDeps);
  expect(second.ingested).toBe(2);
  expect(second.failed).toBe(1);

  const done = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.kind, "panel_generation"));
  expect(done.filter((x) => x.status === "completed")).toHaveLength(2);
  const failed = done.find((x) => x.status === "failed")!;
  expect(failed.failureCode).toBe("moderation_blocked");
  expect(failed.failureReason).toMatch(/safety system/);

  // The two successes have active artwork; the failure does not.
  const panelRows = await h.deps.db.select().from(panels).where(eq(panels.projectId, projectId));
  const ready = panelRows.filter((p) => panelIds.includes(p.id) && p.activeArtworkAssetId);
  expect(ready).toHaveLength(2);
  expect(ready.every((p) => p.status === "ready")).toBe(true);

  // Spend is recorded against the ":batch" model, which is seeded at half the interactive rate.
  const usage = await h.deps.db.select().from(aiUsage).where(eq(aiUsage.projectId, projectId));
  expect(usage.length).toBeGreaterThanOrEqual(2);
  expect(usage.every((u) => u.model.endsWith(":batch"))).toBe(true);
  const [plain] = await h.deps.db.execute<{ c: number }>(
    sql`select coalesce(sum(estimated_cost_usd),0)::float as c from ai_usage where project_id = ${projectId}`,
  );
  expect(plain!.c).toBeGreaterThan(0);

  const batches = await h.deps.db.select().from(providerBatches).where(eq(providerBatches.projectId, projectId));
  expect(batches.every((b) => b.ingestedAt !== null)).toBe(true);
  expect(batches.every((b) => b.ownedFileIds.length === 0)).toBe(true);
  expect(fake.released).toBe(2);
});
