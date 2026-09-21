import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  aiUsage,
  and,
  desc,
  eq,
  generationJobs,
  inArray,
  panels,
  providerBatches,
  sql,
  storyRevisions,
} from "@openmanga/db";
import { mockImagePng } from "@openmanga/testing";
import { imageBatchSubmit, pollProviderBatches } from "../../apps/worker/src/handlers/image-batch.ts";
import { storyRewrite } from "../../apps/worker/src/handlers/text.ts";
import { textBatchSubmit } from "../../apps/worker/src/handlers/text-batch.ts";
import { runGenerationJob } from "../../apps/worker/src/lib/runner.ts";
import type {
  BatchHandle,
  BatchItemResult,
  BatchRequestSpec,
  BatchStatus,
  ImageBatchProvider,
} from "../../packages/ai-image/src/batch.ts";
import type { TextBatchHandle, TextBatchProvider, TextBatchRequestSpec } from "../../packages/ai-text/src/batch.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

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

  // Parked work is still in flight. Reporting it as finished stopped the UI polling and showed "1/139 finished"
  // while the provider still held every panel.
  const view = await alice.get<{
    batches: {
      batchId: string;
      state: string;
      ingesting: boolean;
      polledAtLeastOnce: boolean;
      progress: Record<string, number>;
    }[];
  }>(`/api/projects/${projectId}/generations/batches`);
  const mine = view.batches.find((b) => b.batchId === r.batchId);
  expect(mine?.state).toBe("submitted");
  expect(mine?.progress.submitted).toBe(3);
  // Freshly submitted: not checked yet, and nothing to download. Without these the card could only say
  // "waiting", which made a working poll look like it had done nothing while it downloaded for over a minute.
  expect(mine?.polledAtLeastOnce).toBe(false);
  expect(mine?.ingesting).toBe(false);
  const one = await alice.get<{ progress: Record<string, number> }>(`/api/generations/batches/${r.batchId}`);
  expect(one.progress.submitted).toBe(3);
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

/** A text batch provider that answers with a fixed, valid StoryRewrite payload. */
class FakeTextBatch implements TextBatchProvider {
  readonly provider = "openai";
  readonly model = "gpt-5-mini";
  submitted: TextBatchRequestSpec[][] = [];
  polls = new Map<string, number>();
  chunk(reqs: TextBatchRequestSpec[]) {
    return [reqs];
  }
  async submitBatch(reqs: TextBatchRequestSpec[], idempotencyKey: string) {
    this.submitted.push(reqs);
    return { handle: "tbatch_1", keys: reqs.map((r) => r.key), idempotencyKey, ownedFileIds: [] };
  }
  async pollBatch(h: TextBatchHandle) {
    const seen = (this.polls.get(h.handle) ?? 0) + 1;
    this.polls.set(h.handle, seen);
    if (seen <= 1) return { state: "running" as const, counts: { total: h.keys.length, completed: 0, failed: 0 } };
    return {
      state: "succeeded" as const,
      counts: { total: h.keys.length, completed: h.keys.length, failed: 0 },
      items: h.keys.map((key) => ({
        key,
        ok: true as const,
        text: JSON.stringify({ content: "A rewritten story, batched.", notes: "tightened the opening" }),
        finishReason: "stop",
        usage: { inputTokens: 1200, outputTokens: 300, cachedTokens: 0 },
      })),
    };
  }
  async cancelBatch() {}
  async releaseBatch() {}
  async findByIdempotencyKey() {
    return null;
  }
}

test("a text job batches by collecting its own handler's request, then replaying the answer", async () => {
  const fakeText = new FakeTextBatch();
  h.workerDeps.resolver.textBatch = (async () => fakeText) as typeof h.workerDeps.resolver.textBatch;
  h.deps.resolver.textBatch = h.workerDeps.resolver.textBatch;

  await alice.post(
    `/api/projects/${projectId}/story/revisions`,
    { content: "A clockmaker repairs a clock that runs backwards.", inputKind: "story" },
    201,
  );
  const story = await alice.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const r = await alice.post<{ job: { id: string; batchId: string | null } }>(
    `/api/story-revisions/${story.latest.id}/rewrite`,
    { instruction: "Tighten the opening paragraph", batch: true },
    202,
  );
  expect(r.job.batchId).toBeTruthy();

  // Written, not queued, and marked as part of a batch run.
  const [created] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id));
  expect(created!.status).toBe("queued");
  expect(created!.parameters.batchMode).toBe(true);
  expect(await h.deps.queue.has("text-ai", created!.id)).toBe(false);

  const [submitJob] = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.kind, "text_batch_submit"), eq(generationJobs.batchId, r.job.batchId!)));
  const out = await textBatchSubmit(h.workerDeps, submitJob!);
  expect(out).toEqual({ submitted: 1, batches: 1, fellBack: 0 });
  // The collector captured the handler's own messages — no handler rewriting involved.
  expect(fakeText.submitted[0]![0]!.key).toBe(r.job.id);

  const [parked] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id));
  expect(parked!.status).toBe("submitted");

  await pollProviderBatches(h.workerDeps); // running
  expect((await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id)))[0]!.status).toBe(
    "submitted",
  );

  await pollProviderBatches(h.workerDeps); // succeeded -> requeued with the answer attached
  const [requeued] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id));
  expect(requeued!.status).toBe("queued");
  expect((requeued!.parameters.batchAnswer as { text: string }).text).toContain("batched");

  // The handler now runs for real and applies the batched answer: a new story revision.
  //
  // The poll above republished this job and the harness runs a live text worker, so driving it here as well can
  // run the handler twice — two revisions and two usage rows. Take the queue entry away first, then let the job
  // row decide who runs it: `queued` means nothing has started and this is the only runner, anything else means
  // the worker already has it (or finished it) and the run to wait for is that one. Redis alone is not enough to
  // decide — a job the worker has already completed is gone from Redis, which reads the same as never queued.
  await h.deps.queue.removeWaiting("text-ai", r.job.id).catch(() => false);
  const [claim] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id));
  if (claim?.status === "queued")
    await runGenerationJob(
      h.workerDeps,
      { data: { jobId: r.job.id }, queueName: "text-ai", attemptsMade: 1, opts: { attempts: 3 } } as never,
      (job) => storyRewrite(h.workerDeps, job),
    );
  else
    await waitFor(
      async () => {
        const [j] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id));
        return j?.status === "completed" ? j : null;
      },
      { label: "worker finished the replayed job" },
    );
  const [done] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id));
  expect(done!.status).toBe("completed");
  const revisions = await h.deps.db
    .select()
    .from(storyRevisions)
    .where(eq(storyRevisions.projectId, projectId))
    .orderBy(desc(storyRevisions.revisionNumber));
  expect(revisions[0]!.content).toBe("A rewritten story, batched.");
  expect(revisions[0]!.source).toBe("ai_rewrite");

  // Billed at the discounted rate: recorded against the ":batch" model.
  const usage = await h.deps.db
    .select()
    .from(aiUsage)
    .where(and(eq(aiUsage.projectId, projectId), eq(aiUsage.operation, "story_rewrite")));
  expect(usage).toHaveLength(1);
  // The ":batch" suffix is what routes the row to the half-price rate snapshot (the base name is the mock
  // provider's here, since the harness has no real key).
  expect(usage[0]!.model.endsWith(":batch")).toBe(true);
  expect(usage[0]!.textInputTokens).toBe(1200);
});

test("a parked job is never run by the ordinary worker path", async () => {
  // The expensive mistake: a parked panel is already paid for inside a provider batch, so running its handler
  // would buy the same image a second time and the poller would then discard the batched one.
  const [job] = await h.deps.db
    .insert(generationJobs)
    .values({
      projectId,
      kind: "panel_generation",
      queue: "image-generation",
      status: "submitted",
      priority: 5,
      templateName: "panel-generation",
      templateVersion: 6,
      compiledPrompt: "x",
      provider: "openai",
      model: "gpt-image-2",
      parameters: { batchMode: true },
    })
    .returning();
  let ran = 0;
  await runGenerationJob(
    h.workerDeps,
    { data: { jobId: job!.id }, queueName: "image-generation", attemptsMade: 1, opts: { attempts: 3 } } as never,
    async () => {
      ran++;
      return { ok: true };
    },
  );
  expect(ran).toBe(0);
  const [after] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, job!.id));
  expect(after!.status).toBe("submitted");
});

test("a batch that answers only some of its requests fails the rest instead of parking them", async () => {
  const partial = new FakeBatchProvider(await mockImagePng({ width: 32, height: 32, prompt: "p" }));
  // Answers for the first key only, and claims success.
  partial.pollBatch = async (hd) => ({
    state: "succeeded",
    counts: { total: hd.keys.length, completed: 1, failed: 0 },
    items: [
      {
        key: hd.keys[0]!,
        ok: false,
        code: "moderation_blocked",
        message: "rejected",
      },
    ],
  });
  h.workerDeps.resolver.imageBatch = (async () => partial) as typeof h.workerDeps.resolver.imageBatch;

  const [rowA] = await h.deps.db
    .insert(providerBatches)
    .values({
      projectId,
      capability: "image",
      provider: "openai",
      model: "gpt-image-2",
      handle: "batch_partial",
      idempotencyKey: `partial-${crypto.randomUUID()}`,
      state: "pending",
      requestCount: 2,
      submittedAt: new Date(),
    })
    .returning();
  const made: string[] = [];
  for (const n of [1, 2]) {
    const [j] = await h.deps.db
      .insert(generationJobs)
      .values({
        projectId,
        kind: "panel_generation",
        queue: "image-generation",
        status: "submitted",
        priority: 5,
        templateName: "panel-generation",
        templateVersion: 6,
        compiledPrompt: `partial ${n}`,
        provider: "openai",
        model: "gpt-image-2",
        parameters: { batchMode: true, providerBatchId: rowA!.id },
      })
      .returning();
    made.push(j!.id);
  }
  await pollProviderBatches(h.workerDeps);
  const after = await h.deps.db.select().from(generationJobs).where(inArray(generationJobs.id, made));
  expect(after.every((j) => j.status === "failed")).toBe(true);
  // The unanswered one says so rather than borrowing the other's reason.
  expect(after.some((j) => j.failureCode === "missing_result")).toBe(true);
  const [closed] = await h.deps.db.select().from(providerBatches).where(eq(providerBatches.id, rowA!.id));
  expect(closed!.ingestedAt).not.toBeNull();
});

test("replaying a text answer clears the batch marker, so no sweep can resubmit it", async () => {
  const jobs = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.kind, "story_rewrite"), eq(generationJobs.status, "completed")));
  expect(jobs.length).toBeGreaterThan(0);
  // After ingest the job carried its answer and was requeued; the marker that means "waiting to be submitted"
  // must be gone, or the submit sweep would collect and pay for it all over again.
  expect(jobs.every((j) => j.parameters.batchMode === undefined)).toBe(true);
  expect(jobs.every((j) => Boolean(j.parameters.batchAnswer))).toBe(true);
});

test("asking to poll now queues the sweep instead of waiting for the schedule", async () => {
  // Enqueuing runs a real sweep in this harness, so this sits after the ingestion test rather than before it.
  const [job] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.kind, "panel_generation"));
  const poll = await alice.post<{ queued: boolean; outstanding: number }>(
    `/api/generations/batches/${job!.batchId}/poll`,
  );
  expect(poll.queued).toBe(true);
  // Everything has been ingested by this point, so there is nothing left outstanding to report.
  expect(poll.outstanding).toBe(0);
});
