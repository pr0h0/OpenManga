import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq, generationJobs, panels, providerBatches, sql } from "@openmanga/db";
import { ProviderError } from "@openmanga/domain";
import { imageBatchSubmit, pollProviderBatches } from "../../apps/worker/src/handlers/image-batch.ts";
import { runMaintenance } from "../../apps/worker/src/handlers/maintenance.ts";
import { textBatchSubmit } from "../../apps/worker/src/handlers/text-batch.ts";
import type {
  BatchHandle,
  BatchRequestSpec,
  BatchStatus,
  ImageBatchProvider,
} from "../../packages/ai-image/src/batch.ts";
import type { TextBatchProvider, TextBatchRequestSpec } from "../../packages/ai-text/src/batch.ts";
import { startHarness, type TestClient } from "./harness.ts";

/**
 * The production incident: a run split into many batches, OpenAI accepted a few and refused the rest with
 * `token_limit_exceeded`, and every panel in the refused batches was marked failed. Refused work must wait.
 */

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId = "";
const pageIds: string[] = [];

const QUEUE_FULL =
  '{"code":"token_limit_exceeded","message":"Enqueued token limit reached for gpt-image-2 in organization org-x. ' +
  'Limit: 1,000,000 enqueued tokens. Please try again once some in_progress batches have been completed."}';

/**
 * Two requests per batch. `refuseOnSubmit` refuses the create call for that many submissions after the first;
 * `refuseOnPoll` holds handles that the provider accepted and then failed in validation.
 */
class QueueFullProvider implements ImageBatchProvider {
  readonly provider = "openai";
  readonly model = "gpt-image-2";
  submitted: { key: string; keys: string[] }[] = [];
  refuseOnSubmit = 0;
  refuseOnPoll = new Set<string>();
  chunk(reqs: BatchRequestSpec[]) {
    const out: BatchRequestSpec[][] = [];
    for (let i = 0; i < reqs.length; i += 2) out.push(reqs.slice(i, i + 2));
    return out;
  }
  async submitBatch(reqs: BatchRequestSpec[], idempotencyKey: string): Promise<BatchHandle> {
    if (this.submitted.length && this.refuseOnSubmit > 0) {
      this.refuseOnSubmit--;
      throw new ProviderError("openai", "batch_queue_full", `OpenAI HTTP 400: ${QUEUE_FULL}`);
    }
    this.submitted.push({ key: idempotencyKey, keys: reqs.map((r) => r.key) });
    return { handle: `qf_${this.submitted.length}`, keys: reqs.map((r) => r.key), idempotencyKey, ownedFileIds: [] };
  }
  async pollBatch(hd: BatchHandle): Promise<BatchStatus> {
    const total = hd.keys.length;
    if (this.refuseOnPoll.has(hd.handle))
      return {
        state: "failed",
        counts: { total, completed: 0, failed: 0 },
        items: [],
        error: QUEUE_FULL,
        queueFull: true,
      };
    return { state: "running", counts: { total, completed: 0, failed: 0 } };
  }
  async cancelBatch() {}
  async releaseBatch() {}
  async findByIdempotencyKey() {
    return null;
  }
}

let fake: QueueFullProvider;

async function startRun(pageId: string) {
  const r = await alice.post<{ batchId: string; jobs: { id: string }[] }>(
    `/api/projects/${projectId}/generations/bulk`,
    { scope: { pageId }, onlyMissing: false, confirm: true, batch: true },
    202,
  );
  const [submit] = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.batchId, r.batchId), eq(generationJobs.kind, "image_batch_submit")));
  return { ...r, submit: submit! };
}

const jobsOf = (batchId: string) =>
  h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.batchId, batchId), eq(generationJobs.kind, "panel_generation")));

/** Moves a waiting batch's next try (and optionally its first refusal) into the past. */
const rewind = (batchId: string, sinceHoursAgo = 0) =>
  h.deps.db.execute(sql`update generation_jobs set parameters = jsonb_set(jsonb_set(parameters,
    '{queueWait,nextAt}', to_jsonb(${new Date(Date.now() - 60_000).toISOString()}::text)),
    '{queueWait,since}', to_jsonb(${new Date(Date.now() - sinceHoursAgo * 3600_000).toISOString()}::text))
    where batch_id = ${batchId} and parameters ? 'queueWait'`);

const batchView = async (batchId: string) =>
  (
    await alice.get<{ batches: { batchId: string; state: string; queueWaitUntil: string | null }[] }>(
      `/api/projects/${projectId}/generations/batches`,
    )
  ).batches.find((b) => b.batchId === batchId);

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "qfull", email: "qf@example.com", password: "queue-full-pass-1" },
    201,
  );
  projectId = (await alice.post<{ project: { id: string } }>("/api/projects", { title: "Queue" }, 201)).project.id;
  const ch = await alice.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "C" }, 201);
  for (let i = 0; i < 3; i++) {
    const page = await alice.post<{ page: { id: string } }>(
      `/api/chapters/${ch.chapter.id}/pages`,
      { layoutTemplate: "four-grid" },
      201,
    );
    pageIds.push(page.page.id);
    const doc = await alice.get<{ panels: { id: string }[] }>(`/api/pages/${page.page.id}`);
    for (const p of doc.panels)
      await alice.patch(`/api/panels/${p.id}`, { promptOverride: `draw ${p.id.slice(0, 4)}` });
  }
  fake = new QueueFullProvider();
  h.workerDeps.resolver.imageBatch = (async () => fake) as typeof h.workerDeps.resolver.imageBatch;
  h.deps.resolver.imageBatch = h.workerDeps.resolver.imageBatch;
});
afterAll(() => h?.stop());

test("a refusal on submit keeps the accepted chunk, leaves the rest queued, and a later try submits them", async () => {
  fake.refuseOnSubmit = 1;
  const run = await startRun(pageIds[0]!);
  expect(run.jobs).toHaveLength(4);

  const out = await imageBatchSubmit(h.workerDeps, run.submit);
  expect(out).toMatchObject({ submitted: 2, batches: 1, waiting: 2, failed: 0 });
  expect(fake.submitted).toHaveLength(1);

  const jobs = await jobsOf(run.batchId);
  expect(jobs.filter((j) => j.status === "submitted")).toHaveLength(2);
  const waiting = jobs.filter((j) => j.status === "queued");
  expect(waiting).toHaveLength(2);
  const wait = waiting[0]!.parameters.queueWait as { nextAt: string; tries: number; reason: string };
  expect(wait.tries).toBe(1);
  expect(Date.parse(wait.nextAt) - Date.now()).toBeGreaterThan(4 * 60_000);
  expect(wait.reason).toMatch(/token_limit_exceeded/);

  // Shown as waiting, not failed; at the provider takes precedence in the state, with the next try alongside.
  const view = await batchView(run.batchId);
  expect(view?.state).toBe("submitted");
  expect(view?.queueWaitUntil).toBe(wait.nextAt);

  // Neither the stranded-batch sweep nor an early poll touches them.
  await runMaintenance(h.workerDeps);
  await pollProviderBatches(h.workerDeps);
  expect((await jobsOf(run.batchId)).filter((j) => j.status === "queued")).toHaveLength(2);
  expect(fake.submitted).toHaveLength(1);

  // Once the wait is over, the poller submits them, under a key of their own round.
  await rewind(run.batchId);
  await pollProviderBatches(h.workerDeps);
  expect(fake.submitted).toHaveLength(2);
  expect(fake.submitted[1]!.key).toMatch(/:w1$/);
  expect((await jobsOf(run.batchId)).every((j) => j.status === "submitted")).toBe(true);
});

test("a batch accepted and then refused goes back to waiting and is resubmitted under a new key", async () => {
  const run = await startRun(pageIds[1]!);
  await imageBatchSubmit(h.workerDeps, run.submit);
  const rows = await h.deps.db.select().from(providerBatches).where(eq(providerBatches.batchId, run.batchId));
  expect(rows).toHaveLength(2);
  // OpenAI's usual way: both batches created, the second fails validation over the enqueued-token limit.
  const refusedRow = rows.find((r) => r.handle === `qf_${fake.submitted.length}`)!;
  fake.refuseOnPoll.add(refusedRow.handle);

  await pollProviderBatches(h.workerDeps);
  const jobs = await jobsOf(run.batchId);
  const back = jobs.filter((j) => j.status === "queued");
  expect(back).toHaveLength(2);
  expect(back.every((j) => !j.parameters.providerBatchId && j.parameters.queueWait)).toBe(true);
  expect(jobs.filter((j) => j.status === "failed")).toHaveLength(0);
  // Their panels were not failed either.
  const [panel] = await h.deps.db.select().from(panels).where(eq(panels.id, back[0]!.targetId!));
  expect(panel!.status).not.toBe("failed");
  const [closed] = await h.deps.db.select().from(providerBatches).where(eq(providerBatches.id, refusedRow.id));
  expect(closed!.ingestedAt).not.toBeNull();
  expect(closed!.failureReason).toMatch(/queue full/);

  const before = fake.submitted.length;
  await rewind(run.batchId);
  await pollProviderBatches(h.workerDeps);
  expect(fake.submitted).toHaveLength(before + 1);
  // A new key, so the refused batch (which still exists at the provider under the old one) is not adopted.
  expect(fake.submitted.at(-1)!.key).not.toBe(refusedRow.idempotencyKey);
  expect(fake.submitted.at(-1)!.key).toMatch(/:w1$/);
  expect((await jobsOf(run.batchId)).every((j) => j.status === "submitted")).toBe(true);
});

test("a waiting batch can be paused, resumed and cancelled, and gives up after a day", async () => {
  fake.refuseOnSubmit = 10;
  const run = await startRun(pageIds[2]!);
  await imageBatchSubmit(h.workerDeps, run.submit);
  expect((await jobsOf(run.batchId)).filter((j) => j.status === "queued")).toHaveLength(4);
  // Refused from the first chunk: nothing reached the provider.

  await alice.post(`/api/generations/batches/${run.batchId}/pause`, {});
  expect((await jobsOf(run.batchId)).filter((j) => j.status === "paused")).toHaveLength(4);
  // Paused work is not resubmitted, even with its wait over.
  await rewind(run.batchId);
  const submittedBefore = fake.submitted.length;
  await pollProviderBatches(h.workerDeps);
  expect(fake.submitted.length).toBe(submittedBefore);

  await alice.post(`/api/generations/batches/${run.batchId}/resume`, {});
  const resumed = (await jobsOf(run.batchId)).filter((j) => j.status === "queued");
  expect(resumed).toHaveLength(4);
  expect(resumed.every((j) => j.parameters.queueWait)).toBe(true);

  // Still refused after 24 hours of trying: fail, with the reason.
  await rewind(run.batchId, 25);
  await pollProviderBatches(h.workerDeps);
  const gaveUp = (await jobsOf(run.batchId)).filter((j) => j.status === "failed");
  expect(gaveUp).toHaveLength(4);
  expect(gaveUp[0]!.failureCode).toBe("batch_queue_full");
  expect(gaveUp[0]!.failureReason).toMatch(/stayed full for 24 hours/);

  // Cancelling a waiting run (a fresh one) cancels its queued jobs.
  const again = await startRun(pageIds[2]!);
  await imageBatchSubmit(h.workerDeps, again.submit);
  expect((await batchView(again.batchId))?.queueWaitUntil).toBeTruthy();
  const r = await alice.post<{ cancelled: number }>(`/api/generations/batches/${again.batchId}/cancel`, {});
  expect(r.cancelled).toBeGreaterThanOrEqual(2);
  expect((await jobsOf(again.batchId)).filter((j) => j.status === "queued")).toHaveLength(0);
  fake.refuseOnSubmit = 0;
});

test("a text batch refused on submit waits the same way", async () => {
  let calls = 0;
  const submitted: string[] = [];
  const text: TextBatchProvider = {
    provider: "openai",
    model: "gpt-5-mini",
    chunk: (reqs: TextBatchRequestSpec[]) => [reqs],
    async submitBatch(reqs: TextBatchRequestSpec[], idempotencyKey: string) {
      if (calls++ === 0) throw new ProviderError("openai", "batch_queue_full", `Batch HTTP 400: ${QUEUE_FULL}`);
      submitted.push(idempotencyKey);
      return { handle: "tq_1", keys: reqs.map((r) => r.key), idempotencyKey, ownedFileIds: [] };
    },
    pollBatch: async (hd) => ({ state: "running", counts: { total: hd.keys.length, completed: 0, failed: 0 } }),
    cancelBatch: async () => {},
    releaseBatch: async () => {},
    findByIdempotencyKey: async () => null,
  };
  h.workerDeps.resolver.textBatch = (async () => text) as typeof h.workerDeps.resolver.textBatch;
  h.deps.resolver.textBatch = h.workerDeps.resolver.textBatch;

  await alice.post(
    `/api/projects/${projectId}/story/revisions`,
    { content: "A lighthouse keeper counts ships that never arrive.", inputKind: "story" },
    201,
  );
  const story = await alice.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const r = await alice.post<{ job: { id: string; batchId: string } }>(
    `/api/story-revisions/${story.latest.id}/rewrite`,
    { instruction: "Shorter", batch: true },
    202,
  );
  const [submit] = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.kind, "text_batch_submit"), eq(generationJobs.batchId, r.job.batchId)));
  const out = await textBatchSubmit(h.workerDeps, submit!);
  expect(out).toMatchObject({ submitted: 0, waiting: 1 });
  const [waiting] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id));
  expect(waiting!.status).toBe("queued");
  expect(waiting!.parameters.queueWait).toBeTruthy();

  // The consistency-check sweep must not resubmit it early; the wait being over does.
  await h.deps.db.execute(
    sql`update generation_jobs set created_at = now() - interval '5 minutes' where id = ${r.job.id}`,
  );
  await pollProviderBatches(h.workerDeps);
  expect(submitted).toHaveLength(0);
  await rewind(r.job.batchId);
  await pollProviderBatches(h.workerDeps);
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatch(/:w1$/);
  const [parked] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, r.job.id));
  expect(parked!.status).toBe("submitted");
});
