import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, users } from "@openmanga/db";
import { announceWorker, forgetWorker, QUEUES, servableQueues } from "@openmanga/queue";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let admin: TestClient;

type Overview = {
  workers: { id: string; host: string; queues: string[]; capabilities: string[] }[] | null;
  uncovered: { queue: string; waiting: number; needs: string[]; refusedBy: { host: string }[] }[];
};

beforeAll(async () => {
  h = await startHarness();
  admin = h.client();
  await admin.post(
    "/api/auth/register",
    { username: "ops", email: "ops@example.com", password: "ops-pass-12345" },
    201,
  );
  await h.deps.db.update(users).set({ role: "admin" }).where(eq(users.username, "ops"));
}, 60_000);
afterAll(() => h?.stop());

test("admin sees the workers alive, what they take and can do, and work no worker can take", async () => {
  // A small machine without ffmpeg: it takes everything but video renders.
  const small = servableQueues([...QUEUES], ["tts"]);
  const now = new Date().toISOString();
  await announceWorker(h.deps.redis, {
    id: "small-1",
    host: "small",
    queues: small.consumed,
    refused: small.refused,
    capabilities: ["tts"],
    version: "1.0.0",
    startedAt: now,
    lastSeen: now,
  });
  // A render waits (delayed, so the test's own workers leave it alone).
  await h.deps.queue.enqueue(
    "render",
    "export",
    { exportJobId: crypto.randomUUID() },
    {
      jobId: `waiting-render-${Date.now()}`,
      delayMs: 3_600_000,
    },
  );
  const o = await admin.get<Overview>("/api/admin/overview");
  expect(o.workers?.map((w) => [w.host, w.capabilities])).toEqual([["small", ["tts"]]]);
  expect(o.workers![0]!.queues).not.toContain("render");
  const render = o.uncovered.find((u) => u.queue === "render")!;
  expect(render.waiting).toBeGreaterThanOrEqual(1);
  expect(render.needs).toEqual(["ffmpeg"]);
  expect(render.refusedBy.map((w) => w.host)).toEqual(["small"]);
  // A render machine joins: nothing is left uncovered.
  await announceWorker(h.deps.redis, {
    id: "render-1",
    host: "render",
    queues: ["render"],
    capabilities: ["ffmpeg", "gpu"],
    refused: [],
    version: "1.0.0",
    startedAt: now,
    lastSeen: now,
  });
  const after = await admin.get<Overview>("/api/admin/overview");
  expect(after.uncovered.find((u) => u.queue === "render")).toBeUndefined();
  await forgetWorker(h.deps.redis, "small-1");
  await forgetWorker(h.deps.redis, "render-1");
  expect((await admin.get<Overview>("/api/admin/overview")).workers).toEqual([]);
});
