import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, assets, eq, generationJobs, sql } from "@openmanga/db";
import { sharp } from "@openmanga/image-utils";
import { DelayedError } from "@openmanga/queue";
import { runGenerationJob } from "../../apps/worker/src/lib/runner.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

/** Work one account can trigger stays bounded: renders, imports, image tools and shared worker slots. */

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. "Who's there?" Woo Jin asked.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let other: TestClient;

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  other = h.client();
  await u.post(
    "/api/auth/register",
    { username: "limits", email: "limits@example.com", password: "limits-pass-1" },
    201,
  );
  await other.post(
    "/api/auth/register",
    { username: "limits2", email: "l2@example.com", password: "limits2-pass-1" },
    201,
  );
});
afterAll(() => h?.stop());

const done = (id: string) =>
  waitFor(
    async () => {
      const r = await u.get<{ job: { status: string } }>(`/api/generations/${id}`);
      return ["completed", "failed"].includes(r.job.status) ? r.job : null;
    },
    { label: "job", timeoutMs: 60_000 },
  );

test("a public page renders once per edition the project has, whatever ?language= says", async () => {
  const seriesId = (await u.post<{ series: { id: string } }>("/api/series", { title: "Limits" }, 201)).series.id;
  const projectId = (
    await u.post<{ project: { id: string } }>(
      `/api/series/${seriesId}/episodes`,
      { title: "E1", story: { content: STORY, inputKind: "story" } },
      201,
    )
  ).project.id;
  const { latest } = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${latest.id}/analyze`,
    {},
    202,
  );
  await done(a.job.id);
  await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
  const ch = (await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`)).chapters[0]!.id;
  await done((await u.post<{ job: { id: string } }>(`/api/chapters/${ch}/plan`, {}, 202)).job.id);
  await u.patch(`/api/series/${seriesId}`, { visibility: "unlisted", publicSlug: "limits-comic" });
  await u.patch(`/api/chapters/${ch}`, { publishAt: new Date(Date.now() - 60_000).toISOString() });
  const anon = h.client();
  const pageId = (await anon.get<{ pages: { id: string }[] }>(`/api/public/series/limits-comic/chapters/${ch}`))
    .pages[0]!.id;
  const renders = async () =>
    (
      await h.deps.db
        .select({ id: assets.id })
        .from(assets)
        .where(
          and(
            eq(assets.projectId, projectId),
            eq(assets.type, "thumbnail"),
            sql`${assets.metadata}->'pageRender'->>'pageId' = ${pageId}`,
          ),
        )
    ).length;
  for (const l of ["", "zz01", "zz02", "zz03"]) {
    const r = await anon.raw(
      "GET",
      `/api/public/series/limits-comic/pages/${pageId}.png?width=200${l && `&language=${l}`}`,
    );
    expect(r.status).toBe(200);
    await r.arrayBuffer();
  }
  expect(await renders()).toBe(1);
}, 180_000);

test("importing a large JSON export does not parse it in the API", async () => {
  const body = `{"project":{"title":"Peeked title"},"a":[${"{},".repeat(10_000_000)}{}]}`;
  Bun.gc(true);
  const before = process.memoryUsage().rss;
  let peak = before;
  const timer = setInterval(() => (peak = Math.max(peak, process.memoryUsage().rss)), 5);
  const r = await u.raw("POST", "/api/projects/import?name=big.json", new Blob([body], { type: "application/json" }));
  clearInterval(timer);
  expect(r.status).toBe(202);
  const { project } = (await r.json()) as { project: { title: string } };
  expect(project.title).toBe("Peeked title");
  // Parsing it whole used to cost ~25x the 30 MB upload.
  expect(peak - before).toBeLessThan(250 * 1024 * 1024);
}, 120_000);

test("a small broken JSON export is refused at once; the title is the project's own", async () => {
  const bad = await u.raw(
    "POST",
    "/api/projects/import?name=bad.json",
    new Blob(['{"project":'], { type: "application/json" }),
  );
  expect(bad.status).toBe(400);
  const body = `{"meta":{"title":"Not this"},"project":{"title":"This one","x":[${"{},".repeat(400_000)}{}]}}`;
  const r = await u.raw("POST", "/api/projects/import?name=t.json", new Blob([body], { type: "application/json" }));
  expect(r.status).toBe(202);
  expect(((await r.json()) as { project: { title: string } }).project.title).toBe("This one");
}, 60_000);

test("the palette tool refuses artwork too large to recolour on the API thread", async () => {
  const projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Big art" }, 201)).project.id;
  const chapterId = (
    await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "C" }, 201)
  ).chapter.id;
  const { page } = await u.post<{ page: { id: string } }>(`/api/chapters/${chapterId}/pages`, {}, 201);
  const panelId = (await u.get<{ panels: { id: string }[] }>(`/api/pages/${page.id}`)).panels[0]!.id;
  const png = await sharp({ create: { width: 4000, height: 3500, channels: 3, background: "#204060" } })
    .png()
    .toBuffer();
  const art = new FormData();
  art.set("file", new File([new Uint8Array(png)], "big.png", { type: "image/png" }));
  await u.json("POST", `/api/panels/${panelId}/artwork/upload`, art, 201);
  const small = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c04020" } })
    .png()
    .toBuffer();
  const pal = new FormData();
  pal.set("file", new File([new Uint8Array(small)], "warm.png", { type: "image/png" }));
  const { item } = await u.json<{ item: { assetId: string } }>("POST", `/api/projects/${projectId}/board`, pal, 201);
  await u.post(`/api/panels/${panelId}/tools`, { tool: "palette", paletteAssetId: item.assetId }, 400);
}, 60_000);

test("one account cannot take the last shared text slot while someone else waits", async () => {
  const [me] = await h.deps.db.execute<{ id: string }>(sql`select id from users where username = 'limits'`);
  const [them] = await h.deps.db.execute<{ id: string }>(sql`select id from users where username = 'limits2'`);
  const row = (userId: string, status: "processing" | "queued") => ({
    userId: userId,
    kind: "story_analysis" as const,
    queue: "text-ai",
    status,
    priority: 5,
    templateName: "story-analysis",
    templateVersion: 1,
    compiledPrompt: "x",
    provider: "mock",
    model: "mock",
    parameters: {},
  });
  const slots = h.workerDeps.config.TEXT_WORKER_CONCURRENCY;
  const held = await h.deps.db
    .insert(generationJobs)
    .values([...Array.from({ length: slots - 1 }, () => row(me!.id, "processing")), row(them!.id, "queued")])
    .returning({ id: generationJobs.id });
  const [mine] = await h.deps.db.insert(generationJobs).values(row(me!.id, "queued")).returning();
  let delayed = 0;
  let ran = 0;
  const bull = {
    data: { jobId: mine!.id },
    queueName: "text-ai",
    attemptsMade: 0,
    opts: { attempts: 3 },
    moveToDelayed: async () => {
      delayed++;
    },
  };
  await expect(
    runGenerationJob(
      h.workerDeps,
      bull as never,
      async () => {
        ran++;
        return {};
      },
      "token",
    ),
  ).rejects.toBeInstanceOf(DelayedError);
  expect(delayed).toBe(1);
  expect(ran).toBe(0);
  // With nobody else waiting, the slot is theirs.
  await h.deps.db.delete(generationJobs).where(eq(generationJobs.id, held.at(-1)!.id));
  await runGenerationJob(
    h.workerDeps,
    bull as never,
    async () => {
      ran++;
      return {};
    },
    "token",
  );
  expect(ran).toBe(1);
  await h.deps.db.execute(sql`delete from generation_jobs where user_id in (${me!.id}, ${them!.id})`);
});
