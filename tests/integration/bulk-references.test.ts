import { afterAll, beforeAll, expect, test } from "bun:test";
import { aiUsage, and, eq, generationJobs, inArray, referenceAssets } from "@openmanga/db";
import { mockImagePng } from "@openmanga/testing";
import { imageBatchSubmit, pollProviderBatches } from "../../apps/worker/src/handlers/image-batch.ts";
import type {
  BatchHandle,
  BatchRequestSpec,
  BatchStatus,
  ImageBatchProvider,
} from "../../packages/ai-image/src/batch.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
const locationVersions: string[] = [];
const propVersions: string[] = [];

type Estimate = {
  count: number;
  skipped: number;
  total: number;
  skippedReasons: { inProgress: number; hasReference: number };
  batch: boolean;
};
type Run = { batchId: string | null; jobs: { id: string; targetId: string }[] };

/** Answers every request in one poll, so the batch path can be driven start to finish in a test. */
class FakeBatchProvider implements ImageBatchProvider {
  readonly provider = "openai";
  readonly model = "gpt-image-2";
  submitted: BatchRequestSpec[][] = [];
  constructor(private readonly png: Uint8Array) {}
  chunk(reqs: BatchRequestSpec[]) {
    return [reqs];
  }
  async submitBatch(reqs: BatchRequestSpec[], idempotencyKey: string): Promise<BatchHandle> {
    this.submitted.push(reqs);
    return { handle: `ref_batch_${this.submitted.length}`, keys: reqs.map((r) => r.key), idempotencyKey };
  }
  async pollBatch(hd: BatchHandle): Promise<BatchStatus> {
    return {
      state: "succeeded",
      counts: { total: hd.keys.length, completed: hd.keys.length, failed: 0 },
      items: hd.keys.map((key) => ({
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
          usage: { textInputTokens: 50, imageInputTokens: 0, imageOutputTokens: 400, cachedInputTokens: 0, raw: {} },
          request: { endpoint: "/v1/batches", size: "64x64", referenceCount: 0 },
        },
      })),
    };
  }
  async cancelBatch() {}
  async releaseBatch() {}
  async findByIdempotencyKey() {
    return null;
  }
}

const bulk = <T>(references: "location" | "prop", extra: Record<string, unknown> = {}, status?: number) =>
  alice.post<T>(`/api/projects/${projectId}/generations/bulk`, { scope: { references }, ...extra }, status);

const referencesOn = async (column: "location" | "prop", versionIds: string[]) =>
  h.deps.db
    .select()
    .from(referenceAssets)
    .where(
      inArray(column === "location" ? referenceAssets.locationVersionId : referenceAssets.propVersionId, versionIds),
    );

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "worldbuilder", email: "world@example.com", password: "world-pass-12" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Whole World At Once" }, 201);
  projectId = p.project.id;
  for (const name of ["Vell Light", "The Harbour", "Keeper's Cottage"]) {
    const r = await alice.post<{ location: { currentVersionId: string } }>(
      `/api/projects/${projectId}/locations`,
      { name, description: { summary: `${name}, on the coast` } },
      201,
    );
    locationVersions.push(r.location.currentVersionId);
  }
  for (const name of ["Weather notebook", "Brass lamp"]) {
    const r = await alice.post<{ prop: { currentVersionId: string } }>(
      `/api/projects/${projectId}/props`,
      { name, description: { summary: name } },
      201,
    );
    propVersions.push(r.prop.currentVersionId);
  }
  const fake = new FakeBatchProvider(await mockImagePng({ width: 64, height: 64, prompt: "reference" }));
  h.workerDeps.resolver.imageBatch = (async () => fake) as typeof h.workerDeps.resolver.imageBatch;
  h.deps.resolver.imageBatch = h.workerDeps.resolver.imageBatch;
});
afterAll(() => h?.stop());

test("the estimate counts every location before anything is spent", async () => {
  const e = await bulk<Estimate>("location", { onlyMissing: true });
  expect(e.total).toBe(3);
  expect(e.count).toBe(3);
  expect(e.skipped).toBe(0);
  // Nothing was queued by asking.
  const jobs = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.projectId, projectId), eq(generationJobs.kind, "location_reference")));
  expect(jobs).toHaveLength(0);
});

test("confirming draws one reference for every location, as a draft on its current version", async () => {
  const run = await bulk<Run>("location", { onlyMissing: true, confirm: true }, 202);
  expect(run.jobs).toHaveLength(3);
  expect(new Set(run.jobs.map((j) => j.targetId))).toEqual(new Set(locationVersions));
  await waitFor(
    async () => {
      const done = await h.deps.db
        .select()
        .from(generationJobs)
        .where(and(eq(generationJobs.batchId, run.batchId!), eq(generationJobs.status, "completed")));
      return done.length === 3 ? done : null;
    },
    { label: "three location references", timeoutMs: 60_000 },
  );
  const refs = await referencesOn("location", locationVersions);
  expect(refs).toHaveLength(3);
  expect(refs.every((r) => r.status === "draft" && r.isPrimary && r.kind === "location")).toBe(true);
});

test("'only missing' skips what already has a reference; unticked, it draws them all again", async () => {
  const missing = await bulk<Estimate>("location", { onlyMissing: true });
  expect(missing.count).toBe(0);
  expect(missing.skippedReasons.hasReference).toBe(3);
  const all = await bulk<Estimate>("location", { onlyMissing: false });
  expect(all.count).toBe(3);
});

test("a batched run parks the references at the provider and ingests them as drafts, billed at the batch rate", async () => {
  const run = await bulk<Run>("prop", { onlyMissing: true, confirm: true, batch: true }, 202);
  expect(run.jobs).toHaveLength(2);
  // Written but not queued: the submitter collects them, nothing draws them synchronously meanwhile.
  const written = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.batchId, run.batchId!), eq(generationJobs.kind, "prop_reference")));
  expect(written.every((j) => j.parameters.batchMode === true)).toBe(true);

  // A second request while they wait must not queue the same props again.
  const again = await bulk<Estimate>("prop", { onlyMissing: false });
  expect(again.count).toBe(0);
  expect(again.skippedReasons.inProgress).toBe(2);

  const [submit] = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.batchId, run.batchId!), eq(generationJobs.kind, "image_batch_submit")));
  await imageBatchSubmit(h.workerDeps, submit!);
  const parked = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.batchId, run.batchId!), eq(generationJobs.kind, "prop_reference")));
  expect(parked.every((j) => j.status === "submitted")).toBe(true);

  await pollProviderBatches(h.workerDeps);
  const done = await h.deps.db
    .select()
    .from(generationJobs)
    .where(and(eq(generationJobs.batchId, run.batchId!), eq(generationJobs.kind, "prop_reference")));
  expect(done.every((j) => j.status === "completed")).toBe(true);

  // A batched reference is indistinguishable from a direct one: a primary draft on the current version.
  const refs = await referencesOn("prop", propVersions);
  expect(refs).toHaveLength(2);
  expect(refs.every((r) => r.status === "draft" && r.isPrimary && r.kind === "prop")).toBe(true);
  const usage = await h.deps.db
    .select()
    .from(aiUsage)
    .where(
      inArray(
        aiUsage.generationJobId,
        done.map((j) => j.id),
      ),
    );
  expect(usage).toHaveLength(2);
  expect(usage.every((u) => u.model.endsWith(":batch"))).toBe(true);
});
