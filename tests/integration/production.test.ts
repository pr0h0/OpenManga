import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { advanceRun } from "../../apps/api/src/lib/production.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows and smiled.
The door slammed shut with a BANG.`;

type H = Awaited<ReturnType<typeof startHarness>>;
let h: H;
let u: TestClient;

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
}, 60_000);
afterAll(async () => {
  await h?.stop();
});

type Run = {
  id: string;
  status: string;
  reason: string | null;
  steps: { key: string; status: string; note?: string }[];
};

/** The API advances runs on a timer; here the test does it, until the run settles into `want`. */
const until = (projectId: string, want: string[]) =>
  waitFor(
    async () => {
      const { runs } = await u.get<{ runs: Run[] }>(`/api/projects/${projectId}/production-runs`);
      const run = runs[0]!;
      if (want.includes(run.status)) return run;
      if (run.status === "failed") throw new Error(`run failed: ${run.reason}`);
      await advanceRun(h.deps, run.id);
      return null;
    },
    { label: `run ${want.join("/")}`, timeoutMs: 180_000 },
  );

describe("production runs", () => {
  test("one run takes a story to planned, drawn, narrated and voiced chapters, pausing at each review", async () => {
    await u.post(
      "/api/auth/register",
      { username: "prod", email: "prod@example.com", password: "production pw 1" },
      201,
    );
    const p = await u.post<{ project: { id: string } }>(
      "/api/projects",
      { title: "Production", story: { content: STORY, inputKind: "story" } },
      201,
    );
    const projectId = p.project.id;

    // A run spends unattended, so it needs a cap first, and one at a time.
    await u.patch(`/api/projects/${projectId}`, { settings: { budgetUsd: null } });
    expect((await u.raw("POST", `/api/projects/${projectId}/production-runs`, {})).status).toBe(400);
    await u.patch(`/api/projects/${projectId}`, { settings: { budgetUsd: 50 } });
    const { run } = await u.post<{ run: Run }>(
      `/api/projects/${projectId}/production-runs`,
      { reviewGates: true, render: false, youtube: false },
      201,
    );
    expect(run.steps.map((s) => s.key)).toEqual([
      "analyze",
      "review_analysis",
      "apply",
      "references",
      "review_references",
      "plan",
      "prompts",
      "art",
      "narration",
      "audio",
      "thumbnail",
    ]);
    expect((await u.raw("POST", `/api/projects/${projectId}/production-runs`, {})).status).toBe(409);

    // Review the analysis, then the references, then let it run to the end.
    let r = await until(projectId, ["waiting"]);
    expect(r.steps.find((s) => s.status === "review")?.key).toBe("review_analysis");
    await u.post(`/api/production-runs/${r.id}/continue`);
    r = await until(projectId, ["waiting"]);
    expect(r.steps.find((s) => s.status === "review")?.key).toBe("review_references");
    await u.post(`/api/production-runs/${r.id}/continue`);
    r = await until(projectId, ["completed"]);
    expect(r.steps.every((s) => s.status === "done" || s.status === "skipped")).toBe(true);

    const chs = await u.get<{
      chapters: { id: string; stats?: { panels: number; ready: number; narration: number } }[];
    }>(`/api/projects/${projectId}/chapters`);
    expect(chs.chapters.length).toBeGreaterThan(0);
    const chapter = chs.chapters[0]!;
    const detail = await u.get<{ pages: { panelCount: number; readyCount: number }[] }>(`/api/chapters/${chapter.id}`);
    expect(detail.pages.length).toBeGreaterThan(0);
    expect(detail.pages.every((pg) => pg.readyCount === pg.panelCount)).toBe(true);
    const progress = await u.get<{ totals: { segments: number; withAudio: number } }>(
      `/api/projects/${projectId}/narration/progress`,
    );
    expect(progress.totals.segments).toBeGreaterThan(0);
    expect(progress.totals.withAudio).toBe(progress.totals.segments);
    const proj = await u.get<{ project: { settings: { thumbnail?: unknown } } }>(`/api/projects/${projectId}`);
    expect(proj.project.settings.thumbnail).toBeTruthy();

    // A second run finds everything done and skips or finishes each step without spending again.
    const again = await u.post<{ run: Run }>(
      `/api/projects/${projectId}/production-runs`,
      { reviewGates: false, render: false, youtube: false },
      201,
    );
    const second = await until(projectId, ["completed"]);
    expect(second.id).toBe(again.run.id);
    expect(second.steps.find((s) => s.key === "analyze")?.status).toBe("skipped");
    expect(second.steps.find((s) => s.key === "thumbnail")?.status).toBe("skipped");
  }, 400_000);
});
