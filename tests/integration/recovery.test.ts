import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { assets, eq, exportJobs, generationJobs, generationOutputs, inArray, sql } from "@openmanga/db";
import { runMaintenance } from "../../apps/worker/src/handlers/maintenance.ts";
import { runGenerationJob } from "../../apps/worker/src/lib/runner.ts";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "rec", email: "rec@example.com", password: "recovery-pass-1" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Recovery" }, 201);
  projectId = p.project.id;
});
afterAll(() => h?.stop());

describe("job redelivery", () => {
  test("a job that already produced its output is finished from it, not run again", async () => {
    // What a worker killed between the provider call and the completion write leaves behind: the job still reads
    // as processing, and the asset it paid for is stored with an output row pointing at it.
    const asset = await h.deps.assets.store({
      projectId,
      ownerUserId: null,
      type: "panel_art",
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      mimeType: "image/png",
    });
    const [job] = await h.deps.db
      .insert(generationJobs)
      .values({
        projectId,
        kind: "panel_generation",
        queue: "image-generation",
        status: "processing",
        priority: 5,
        templateName: "panel-generation",
        templateVersion: 6,
        compiledPrompt: "x",
        provider: "fake",
        model: "fake",
      })
      .returning();
    await h.deps.db.insert(generationOutputs).values({ jobId: job!.id, assetId: asset.id, activated: false });

    let handlerCalls = 0;
    const result = await runGenerationJob(
      h.workerDeps,
      { data: { jobId: job!.id }, queueName: "image-generation", attemptsMade: 1, opts: { attempts: 3 } } as never,
      async () => {
        handlerCalls++;
        return {};
      },
    );

    // The provider is never called again, and the job ends completed rather than failed or stuck.
    expect(handlerCalls).toBe(0);
    expect((result as { recoveredAfterRestart?: boolean })?.recoveredAfterRestart).toBe(true);
    const [after] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, job!.id));
    expect(after!.status).toBe("completed");
    const [stored] = await h.deps.db.select().from(assets).where(eq(assets.id, asset.id));
    expect(stored).toBeTruthy();
  });

  test("a job with no output still runs its handler", async () => {
    const [job] = await h.deps.db
      .insert(generationJobs)
      .values({
        projectId,
        kind: "panel_generation",
        queue: "image-generation",
        status: "processing",
        priority: 5,
        templateName: "panel-generation",
        templateVersion: 6,
        compiledPrompt: "x",
        provider: "fake",
        model: "fake",
      })
      .returning();
    let handlerCalls = 0;
    await runGenerationJob(
      h.workerDeps,
      { data: { jobId: job!.id }, queueName: "image-generation", attemptsMade: 1, opts: { attempts: 3 } } as never,
      async () => {
        handlerCalls++;
        return { ok: true };
      },
    );
    expect(handlerCalls).toBe(1);
    const [after] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, job!.id));
    expect(after!.status).toBe("completed");
    expect(await h.deps.db.execute(sql`select 1`)).toBeTruthy();
  });
});

describe("stalled-job sweep", () => {
  // The bug this covers: the sweep judged jobs on elapsed time alone, so a 2h+ video export that was writing
  // progress the whole time was marked failed at the two-hour mark while it was still rendering.
  const insertExport = async (kind: "video_panels" | "zip_package", quietMinutes: number) => {
    const [row] = await h.deps.db
      .insert(exportJobs)
      .values({
        projectId,
        userId: null,
        kind,
        status: "processing",
        options: {},
        startedAt: new Date(Date.now() - 5 * 3600_000),
      })
      .returning();
    await h.deps.db.execute(
      sql`update export_jobs set updated_at = now() - (${quietMinutes} || ' minutes')::interval where id = ${row!.id}`,
    );
    return row!.id;
  };

  test("a long export that keeps writing progress survives; a silent one is failed", async () => {
    const live = await insertExport("video_panels", 1); // wrote progress a minute ago
    const dead = await insertExport("zip_package", 600); // untouched for 10 hours
    await runMaintenance(h.workerDeps);
    const rows = await h.deps.db
      .select()
      .from(exportJobs)
      .where(inArray(exportJobs.id, [live, dead]));
    expect(rows.find((r) => r.id === live)!.status).toBe("processing");
    expect(rows.find((r) => r.id === dead)!.status).toBe("failed");
  });

  test("a quiet job a worker is still running is left alone", async () => {
    const id = await insertExport("video_panels", 600);
    const deps = { ...h.workerDeps, queue: { ...h.workerDeps.queue, state: async () => "active" } };
    await runMaintenance(deps as typeof h.workerDeps);
    const [row] = await h.deps.db.select().from(exportJobs).where(eq(exportJobs.id, id));
    expect(row!.status).toBe("processing");
  });
});

describe("batch submitter died", () => {
  // Seen in production: three submit jobs failed on an unretryable error and 143 panels sat at `queued` with
  // nothing left to hand them to a provider. The batch looked idle rather than broken.
  const insertBatch = async (submitStatus: "failed" | "queued") => {
    const batchId = crypto.randomUUID();
    const mk = async (
      kind: "panel_generation" | "image_batch_submit",
      status: "queued" | "failed",
      batchMode: boolean,
    ) => {
      const [row] = await h.deps.db
        .insert(generationJobs)
        .values({
          projectId,
          batchId,
          kind,
          status,
          queue: "image-generation",
          targetType: "panel",
          parameters: batchMode ? { batchMode: true } : {},
          input: {},
        })
        .returning();
      return row!.id;
    };
    return {
      panel: await mk("panel_generation", "queued", true),
      submit: await mk("image_batch_submit", submitStatus, false),
    };
  };

  test("its panels are failed with a reason; a batch still waiting to submit is untouched", async () => {
    const dead = await insertBatch("failed");
    const pending = await insertBatch("queued");
    await runMaintenance(h.workerDeps);
    const rows = await h.deps.db
      .select()
      .from(generationJobs)
      .where(inArray(generationJobs.id, [dead.panel, pending.panel]));
    const failed = rows.find((r) => r.id === dead.panel)!;
    expect(failed.status).toBe("failed");
    expect(failed.failureCode).toBe("batch_submit_failed");
    expect(rows.find((r) => r.id === pending.panel)!.status).toBe("queued");
  });
});
