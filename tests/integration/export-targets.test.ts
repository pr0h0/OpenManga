import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, exportJobs } from "@openmanga/db";
import { processExport } from "../../apps/worker/src/handlers/export.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. "Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let chapterId: string;

type Issue = { level: string; code: string; message: string };
const check = (key: string, q = "") =>
  u.get<{ facts: Record<string, unknown>; issues: Issue[] }>(
    `/api/projects/${projectId}/export-targets/${key}/check?chapterId=${chapterId}${q}`,
  );

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "plat", email: "pl@example.com", password: "plat-pass-1234" }, 201);
  projectId = (
    await u.post<{ project: { id: string } }>("/api/projects", { title: "Targets", story: { content: STORY } }, 201)
  ).project.id;
  const { latest } = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${latest.id}/analyze`,
    {},
    202,
  );
  const done = (id: string) =>
    waitFor(
      async () => {
        const r = await u.get<{ job: { status: string } }>(`/api/generations/${id}`);
        return ["completed", "failed"].includes(r.job.status) ? r.job : null;
      },
      { label: "job", timeoutMs: 60_000 },
    );
  await done(a.job.id);
  await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
  chapterId = (await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`)).chapters[0]!.id;
  await done((await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, {}, 202)).job.id);
}, 120_000);
afterAll(() => h?.stop());

test("targets are listed with their export kind, options, limits and notes", async () => {
  const { targets } = await u.get<{ targets: { key: string; kind: string; notes: string[] }[] }>("/api/export-targets");
  expect(targets.map((t) => t.key)).toEqual([
    "youtube",
    "youtube_shorts",
    "tiktok",
    "reels",
    "instagram_carousel",
    "webtoon_canvas",
    "tapas",
    "kdp_paperback",
    "pdf",
  ]);
  expect(targets.every((t) => t.notes.length > 0)).toBe(true);
});

test("before exporting: page count, strip images, a Short's length and a panel cut's estimated length", async () => {
  const kdp = await check("kdp_paperback");
  expect(kdp.issues.map((i) => i.code)).toEqual(["too_few_pages"]);
  const strip = await check("webtoon_canvas");
  const images = strip.facts.images as { width: number; height: number }[];
  expect(images.length).toBeGreaterThan(0);
  expect(images.every((i) => i.width === 800 && i.height <= 1280)).toBe(true);
  expect(strip.issues).toEqual([]);
  expect((await check("youtube_shorts", "&durationMs=200000")).issues.map((i) => i.code)).toEqual(["too_long"]);
  expect((await check("tiktok", "&durationMs=200000")).issues).toEqual([]);
  const yt = await check("youtube", "&minHoldMs=2000");
  expect(yt.facts.durationMs).toBeGreaterThan(0);
  await u.get(`/api/projects/${projectId}/export-targets/myspace/check`, 404);
});

test("an export with a target is checked against the files it made", async () => {
  const exp = (body: Record<string, unknown>, status = 202) =>
    u.post<{ job: { id: string } }>(
      `/api/projects/${projectId}/exports`,
      { chapterId, acknowledgeIssues: true, ...body },
      status,
    );
  await exp({ kind: "pdf", target: "webtoon_canvas" }, 400);
  await exp({ kind: "webtoon", target: "nowhere" }, 404);
  const ex = await exp({
    kind: "webtoon",
    target: "webtoon_canvas",
    webtoon: { width: 800, maxChunkHeight: 1280, format: "jpg", split: true, exactHeight: true },
  });
  const job = await waitFor(
    async () => {
      const r = await u.get<{
        job: { status: string; result: { targetCheck?: { target: string; label: string; issues: Issue[] } } | null };
      }>(`/api/jobs/${ex.job.id}`);
      return ["completed", "failed"].includes(r.job.status) ? r.job : null;
    },
    { label: "export", timeoutMs: 120_000 },
  );
  expect(job.status).toBe("completed");
  expect(job.result?.targetCheck).toEqual({ target: "webtoon_canvas", label: "WEBTOON Canvas", issues: [] });
  // Without cutting at the exact height, a panel taller than the limit goes out whole: reported, not refused.
  const tall = await exp({
    kind: "webtoon",
    target: "webtoon_canvas",
    webtoon: { width: 800, maxChunkHeight: 1280, format: "jpg", split: true },
  });
  const t = await waitFor(
    async () => {
      const r = await u.get<{ job: { status: string; result: { targetCheck?: { issues: Issue[] } } | null } }>(
        `/api/jobs/${tall.job.id}`,
      );
      return ["completed", "failed"].includes(r.job.status) ? r.job : null;
    },
    { label: "export", timeoutMs: 120_000 },
  );
  expect(t.result?.targetCheck?.issues.map((i) => i.code)).toContain("image_too_tall");
}, 300_000);

// A running export that is asked to stop and then redelivered (a restart) used to be set back to "processing".
test("an export cancelled after the worker took it off the queue is not rendered", async () => {
  const job = (status: "cancelled" | "cancel_requested") =>
    h.deps.db
      .insert(exportJobs)
      .values({ projectId, kind: "pdf", options: { chapterId }, status })
      .returning()
      .then((r) => r[0]!);
  const bull = (id: string) =>
    ({ data: { exportJobId: id }, attemptsMade: 0, opts: { attempts: 1 } }) as unknown as Parameters<
      typeof processExport
    >[1];
  for (const status of ["cancelled", "cancel_requested"] as const) {
    const row = await job(status);
    expect(await processExport(h.workerDeps, bull(row.id))).toBeUndefined();
    const [after] = await h.deps.db.select().from(exportJobs).where(eq(exportJobs.id, row.id));
    expect(after!.status).toBe("cancelled");
    expect(after!.startedAt).toBeNull();
  }
});
