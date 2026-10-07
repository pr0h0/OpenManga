import { afterAll, beforeAll, expect, test } from "bun:test";
import { providerRateSnapshots } from "@openmanga/db";
import { advanceRun } from "../../apps/api/src/lib/production.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows and smiled.
The door slammed shut with a BANG.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;

type Plan = {
  models: { text: { model: string; free?: boolean } | null; fromHistory: string[] };
  project: {
    analysis: { needed: boolean; usd: number | null };
    references: { count: number; estimated: boolean; usd: number | null };
    thumbnail: { needed: boolean };
  };
  chapters: {
    id: string;
    estimated: boolean;
    panels: number;
    plan: { needed: boolean };
    art: { panels: number; usd: number | null };
    narration: { needed: boolean };
    audio: { segments: number; seconds: number; usd: number };
    storageBytes: number;
  }[];
  totals: { usd: number | null; panelsToDraw: number; storageBytes: number; estimatedChapters: number };
  budget: { limitUsd: number | null; remainingUsd: number | null };
  warnings: string[];
};
const RUN = { reviewGates: false, render: false, youtube: false };
const estimate = (projectId: string, body: Record<string, unknown> = {}) =>
  u.post<Plan>(`/api/projects/${projectId}/production-runs/estimate`, { ...RUN, ...body });

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  // The stub models are free; price them like a real pair so the plan has something to add up.
  for (const model of ["mock", "mock-image"])
    await h.deps.db.insert(providerRateSnapshots).values({
      provider: "mock",
      model,
      effectiveFrom: new Date(Date.now() - 1000),
      textInputRate: "1",
      textOutputRate: "4",
      imageOutputRate: "40",
      imageUnitRate: "0.04",
    });
  (h.deps.usage as unknown as { cache: unknown }).cache = null;
  await u.post(
    "/api/auth/register",
    { username: "planner", email: "plan@example.com", password: "plan pass 123" },
    201,
  );
}, 60_000);
afterAll(() => h?.stop());

test("before anything exists: the analysis, estimated references and a total; paste mode makes text free", async () => {
  const { project } = await u.post<{ project: { id: string } }>(
    "/api/projects",
    { title: "Plan me", story: { content: STORY, inputKind: "story" } },
    201,
  );
  const plan = await estimate(project.id);
  expect(plan.project.analysis.needed).toBe(true);
  expect(plan.project.analysis.usd).toBeGreaterThan(0);
  expect(plan.project.references).toMatchObject({ estimated: true });
  expect(plan.project.references.count).toBeGreaterThan(0);
  expect(plan.project.thumbnail.needed).toBe(true);
  expect(plan.chapters).toEqual([]);
  expect(plan.totals.usd).toBeGreaterThan(0);
  // New projects start with a $5 cap.
  expect(plan.budget.limitUsd).toBe(5);

  const pasted = await estimate(project.id, { ai: { text: { manual: true }, image: null } });
  expect(pasted.models.text?.free).toBe(true);
  expect(pasted.project.analysis.usd).toBe(0);
  // Nothing was queued by pricing it.
  const jobs = await u.get<{ jobs: unknown[] }>(`/api/projects/${project.id}/generations`);
  expect(jobs.jobs).toEqual([]);
});

test("unplanned chapters are estimated from the target runtime; a small cap is warned about", async () => {
  const { project } = await u.post<{ project: { id: string } }>("/api/projects", { title: "Runtime" }, 201);
  await u.patch(`/api/projects/${project.id}`, {
    settings: {
      budgetUsd: 0.001,
      targetRuntime: { minutes: 10, wordsPerMinute: 150, minShotSeconds: 4, maxShotSeconds: 8 },
    },
  });
  for (const title of ["One", "Two"])
    await u.post(`/api/projects/${project.id}/chapters`, { title, sourceExcerpt: `${title}: ${STORY}` }, 201);
  const plan = await estimate(project.id);
  expect(plan.chapters).toHaveLength(2);
  for (const ch of plan.chapters) {
    expect(ch).toMatchObject({ estimated: true, plan: { needed: true }, narration: { needed: true } });
    expect(ch.panels).toBeGreaterThan(0);
    expect(ch.art.panels).toBe(ch.panels);
    // Narration for every estimated panel: local voice, so time and disk but no spend.
    expect(ch.audio.seconds).toBeGreaterThan(0);
    expect(ch.audio.usd).toBe(0);
    expect(ch.storageBytes).toBeGreaterThan(0);
  }
  // Ten minutes at 4–8 s a shot is about a hundred shots, split between the two chapters by their text.
  const shots = plan.chapters.reduce((n, ch) => n + ch.panels, 0);
  expect(shots).toBeGreaterThan(80);
  expect(shots).toBeLessThan(120);
  expect(plan.totals.estimatedChapters).toBe(2);
  expect(plan.warnings.some((w) => w.includes("budget cap"))).toBe(true);
});

test("after a run there is nothing left to pay for; an edited panel is redrawn only by an update", async () => {
  const { project } = await u.post<{ project: { id: string } }>(
    "/api/projects",
    { title: "Produced", story: { content: STORY, inputKind: "story" } },
    201,
  );
  await u.patch(`/api/projects/${project.id}`, { settings: { budgetUsd: 50 } });
  await u.post(`/api/projects/${project.id}/production-runs`, RUN, 201);
  await waitFor(
    async () => {
      const { runs } = await u.get<{ runs: { id: string; status: string }[] }>(
        `/api/projects/${project.id}/production-runs`,
      );
      if (runs[0]!.status === "completed") return true;
      await advanceRun(h.deps, runs[0]!.id);
      return null;
    },
    { label: "run completed", timeoutMs: 180_000 },
  );
  const done = await estimate(project.id);
  expect(done.project.analysis.needed).toBe(false);
  expect(done.project.thumbnail.needed).toBe(false);
  expect(done.totals).toMatchObject({ usd: 0, panelsToDraw: 0, estimatedChapters: 0 });
  expect(done.chapters.every((ch) => !ch.plan.needed && !ch.narration.needed && ch.audio.segments === 0)).toBe(true);
  // Priced from this server's own jobs from now on, not the built-in assumptions.
  expect(done.models.fromHistory).toEqual(expect.arrayContaining(["chapter_plan", "panel_generation"]));

  const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${project.id}/chapters`);
  const { panels } = await u.get<{ panels: { id: string }[] }>(`/api/chapters/${chapters[0]!.id}/panels`);
  // Saving a new spec after the art was drawn is what makes that art out of date.
  const panel = await u.get<{ specs: { spec: Record<string, unknown> }[] }>(`/api/panels/${panels[0]!.id}`);
  await u.put(`/api/panels/${panels[0]!.id}/spec`, { spec: { ...panel.specs[0]!.spec, shotType: "close" } });
  expect((await estimate(project.id)).totals.panelsToDraw).toBe(0);
  const update = await estimate(project.id, { update: true });
  expect(update.totals.panelsToDraw).toBe(1);
  expect(update.totals.usd).toBeGreaterThan(0);

  const outsider = h.client();
  await outsider.post(
    "/api/auth/register",
    { username: "nosy", email: "nosy@example.com", password: "nosy pass 123" },
    201,
  );
  const denied = await outsider.raw("POST", `/api/projects/${project.id}/production-runs/estimate`, RUN);
  expect(denied.status).toBeGreaterThanOrEqual(403);
}, 300_000);
