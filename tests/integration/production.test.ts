import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  and,
  audioJobs,
  eq,
  exportJobs,
  exportsTable,
  generationJobs,
  narrationSegments,
  panels as panelsTable,
  productionRuns,
  sql,
  users,
} from "@openmanga/db";
import { advanceRun, batchModes } from "../../apps/api/src/lib/production.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows and smiled.
The door slammed shut with a BANG.`;

type H = Awaited<ReturnType<typeof startHarness>>;
let h: H;
let u: TestClient;
/** The project the first test produces, which the revised-story test builds on. */
let builtProjectId = "";

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
      if (run.status === "waiting") throw new Error(`run waiting unexpectedly: ${run.reason}`);
      await advanceRun(h.deps, run.id);
      return null;
    },
    { label: `run ${want.join("/")}`, timeoutMs: 180_000 },
  );

/** A new project produced end to end (no reviews, no video). */
async function produce(title: string) {
  const p = await u.post<{ project: { id: string } }>(
    "/api/projects",
    { title, story: { content: STORY, inputKind: "story" } },
    201,
  );
  await u.patch(`/api/projects/${p.project.id}`, { settings: { budgetUsd: 50 } });
  await u.post(
    `/api/projects/${p.project.id}/production-runs`,
    { reviewGates: false, render: false, youtube: false },
    201,
  );
  await until(p.project.id, ["completed"]);
  return p.project.id;
}

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
    builtProjectId = projectId;

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
      "review_plans",
      "plan",
      "prompts",
      "art",
      "review_narration",
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

  test("a revised story: Update production re-analyses it, waits with a diff, and applying keeps existing work", async () => {
    const projectId = builtProjectId;
    const before = await u.get<{ chapters: { id: string; title: string }[] }>(`/api/projects/${projectId}/chapters`);
    expect(before.chapters.length).toBe(1);
    const first = before.chapters[0]!;
    const pagesOf = async (id: string) =>
      (await u.get<{ pages: { id: string; readyCount: number }[] }>(`/api/chapters/${id}`)).pages;
    const firstPages = await pagesOf(first.id);
    expect(firstPages.length).toBeGreaterThan(0);

    // The writer adds a chapter.
    await u.post(
      `/api/projects/${projectId}/story/revisions`,
      { content: `${STORY}\n\nChapter 2: Dawn\n\nWoo Jin walked home at dawn. The city was quiet and grey.` },
      201,
    );
    type Stage = { key: string; count: number };
    const stale = async () =>
      Object.fromEntries(
        (await u.get<{ stages: Stage[] }>(`/api/projects/${projectId}/staleness`)).stages.map((s) => [s.key, s.count]),
      );
    expect((await stale()).story).toBe(1);

    // Review gates off, and still the re-analysis waits for the user.
    const { run } = await u.post<{ run: Run & { steps: { key: string; ref?: string }[] } }>(
      `/api/projects/${projectId}/production-runs`,
      { update: true, reviewGates: false, render: false, youtube: false },
      201,
    );
    expect(run.steps.slice(0, 3).map((s) => s.key)).toEqual(["analyze", "review_analysis", "apply"]);
    const waiting = await until(projectId, ["waiting"]);
    expect(waiting.steps.find((s) => s.status === "review")?.key).toBe("review_analysis");
    const ref = (waiting.steps as { key: string; ref?: string }[]).find((s) => s.key === "analyze")!.ref!;
    // Nothing is applied before the user decides.
    expect((await u.get<{ chapters: unknown[] }>(`/api/projects/${projectId}/chapters`)).chapters.length).toBe(1);

    type Diff = {
      hasExisting: boolean;
      chapters: {
        kept: { id: string; pages: number; textChanged: boolean }[];
        added: { title: string; position: number }[];
        renamed: unknown[];
        removed: unknown[];
      };
    };
    const { diff } = await u.get<{ diff: Diff }>(`/api/story-analyses/${ref}/diff`);
    expect(diff.hasExisting).toBe(true);
    expect(diff.chapters.kept).toMatchObject([{ id: first.id, pages: firstPages.length }]);
    expect(diff.chapters.added).toEqual([{ title: "Chapter 2: Dawn", position: 2 }]);
    expect(diff.chapters.renamed).toEqual([]);
    expect(diff.chapters.removed).toEqual([]);

    // Continue: the analysis is applied keeping everything, and the run carries on to plan and draw the new chapter.
    await u.post(`/api/production-runs/${run.id}/continue`);
    // The analysis moved the next chapter's heading into this chapter's text (the diff said so: textChanged), so the
    // run asks whether to keep its pages or re-plan it rather than re-planning it on its own.
    expect(diff.chapters.kept[0]).toMatchObject({ textChanged: true });
    const asked = await until(projectId, ["waiting"]);
    expect(asked.steps.find((s) => s.status === "review")?.key).toBe("review_plans");
    const { stalePlans } = await u.get<{ stalePlans: { chapterId: string }[] }>(`/api/projects/${projectId}/staleness`);
    expect(stalePlans.map((c) => c.chapterId)).toEqual([first.id]);
    await u.post(`/api/chapters/${first.id}/keep`, { stage: "plan" });
    await u.post(`/api/production-runs/${run.id}/continue`);
    const done = await until(projectId, ["completed"]);
    expect(done.id).toBe(run.id);
    const after = await u.get<{ chapters: { id: string; title: string; order: number }[] }>(
      `/api/projects/${projectId}/chapters`,
    );
    expect(after.chapters.map((c) => [c.title, c.order])).toEqual([
      ["Chapter 1: Rooftop", 1],
      ["Chapter 2: Dawn", 2],
    ]);
    expect(after.chapters[0]!.id).toBe(first.id);
    // The existing chapter keeps its very pages; the new one was planned and drawn.
    expect((await pagesOf(first.id)).map((p) => p.id)).toEqual(firstPages.map((p) => p.id));
    const added = await pagesOf(after.chapters[1]!.id);
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((p) => p.readyCount > 0)).toBe(true);
    expect(await stale()).toMatchObject({ story: 0, plan: 0 });

    // A revision that drops the new chapter: the diff lists it with its work, and applying still keeps it.
    const rev = await u.post<{ revision: { id: string } }>(
      `/api/projects/${projectId}/story/revisions`,
      { content: STORY },
      201,
    );
    const again = await u.post<{ job: { id: string }; analysis: { id: string } }>(
      `/api/story-revisions/${rev.revision.id}/analyze`,
      {},
      202,
    );
    await waitFor(
      async () =>
        (await u.get<{ job: { status: string } }>(`/api/generations/${again.job.id}`)).job.status === "completed",
      { label: "re-analysis" },
    );
    const dropped = (
      await u.get<{ diff: Diff & { chapters: { removed: { id: string; pages: number }[] } } }>(
        `/api/story-analyses/${again.analysis.id}/diff`,
      )
    ).diff;
    expect(dropped.chapters.removed).toMatchObject([{ id: after.chapters[1]!.id, pages: added.length }]);
    await u.post(`/api/story-analyses/${again.analysis.id}/apply`, {});
    const kept = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
    expect(kept.chapters.map((c) => c.id)).toEqual(after.chapters.map((c) => c.id));
  }, 400_000);

  test("a run that reaches the end with failures finishes completed_with_warnings and lists them", async () => {
    const projectId = builtProjectId;
    const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
    const { panels } = await u.get<{ panels: { id: string }[] }>(`/api/chapters/${chapters[0]!.id}/panels`);
    expect(panels.length).toBeGreaterThan(1);
    // The re-analyses above changed chapter texts; keep their plans, this test is about the art.
    const { stalePlans } = await u.get<{ stalePlans: { chapterId: string }[] }>(`/api/projects/${projectId}/staleness`);
    for (const c of stalePlans) await u.post(`/api/chapters/${c.chapterId}/keep`, { stage: "plan" });
    // Two panels edited after they were drawn; the provider refuses one of them.
    for (const [i, pn] of panels.slice(0, 2).entries()) {
      const { specs } = await u.get<{ specs: { spec: Record<string, unknown> }[] }>(`/api/panels/${pn.id}`);
      const spec = specs[0]!.spec;
      await u.put(`/api/panels/${pn.id}/spec`, {
        spec: { ...spec, action: i === 0 ? "draws the sword [[mock:policy]]" : "draws the sword" },
      });
    }
    const { run } = await u.post<{ run: Run }>(
      `/api/projects/${projectId}/production-runs`,
      { update: true, reviewGates: false, preparePrompts: false, render: false, youtube: false },
      201,
    );
    const done = (await until(projectId, ["completed", "completed_with_warnings"])) as Run & {
      warnings: {
        failedJobs: { id: string; kind: string; step: string }[];
        failedJobCount: number;
        panelsWithoutArt: number;
        failedExports: unknown[];
      } | null;
    };
    expect(done.id).toBe(run.id);
    expect(done.status).toBe("completed_with_warnings");
    expect(done.warnings).toMatchObject({ failedJobCount: 1, panelsWithoutArt: 0, failedExports: [] });
    expect(done.warnings!.failedJobs).toMatchObject([{ kind: "panel_generation", step: "art" }]);
    expect(done.steps.find((s) => s.key === "art")?.note).toBe("1 of 2 failed; see Generation");
    // The card's Retry failed calls the usual retry route for each listed job.
    const retried = await u.post<{ job: { id: string } }>(
      `/api/generations/${done.warnings!.failedJobs[0]!.id}/retry`,
      {},
      202,
    );
    expect(retried.job.id).toBeTruthy();
    // A finished run cannot be continued.
    expect((await u.raw("POST", `/api/production-runs/${run.id}/continue`, {})).status).toBe(409);
  }, 400_000);

  test("the audio step checks every segment has current audio: a failed one is a warning, a missed one is queued", async () => {
    const projectId = await produce("Audio check");
    const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
    const { lines } = await u.get<{ lines: { id: string; text: string }[] }>(
      `/api/chapters/${chapters[0]!.id}/narration`,
    );
    expect(lines.length).toBeGreaterThan(0);
    // The voice provider refuses this line's new text.
    await u.patch(`/api/narration-lines/${lines[0]!.id}`, { text: "[[mock:500]] The rain would not stop." });
    const { run } = await u.post<{ run: Run }>(
      `/api/projects/${projectId}/production-runs`,
      { update: true, reviewGates: false, render: false, youtube: false },
      201,
    );
    expect(run.steps.map((s) => s.key)).toEqual(["audio"]);
    const done = (await until(projectId, ["completed", "completed_with_warnings"])) as Run & {
      warnings: { segmentsWithoutAudio: number } | null;
    };
    expect(done.status).toBe("completed_with_warnings");
    expect(done.warnings?.segmentsWithoutAudio).toBe(1);
    expect(done.steps[0]!.note).toBe("1 segment(s) without current audio, 1 failed; see Narration");

    // A segment the step never queued (here: changed while the step was already waiting) is queued once more.
    await u.patch(`/api/narration-lines/${lines[0]!.id}`, { text: "The rain stopped at last." });
    const [me] = await h.deps.db.select().from(users).where(eq(users.username, "prod"));
    const [waiting] = await h.deps.db
      .insert(productionRuns)
      .values({
        projectId,
        userId: me!.id,
        options: { reviewGates: false, preparePrompts: false, render: false, youtube: false },
        steps: [{ key: "audio", status: "running", startedAt: new Date().toISOString() }],
      })
      .returning();
    await advanceRun(h.deps, waiting!.id);
    const [requeued] = await h.deps.db.select().from(productionRuns).where(eq(productionRuns.id, waiting!.id));
    expect(requeued!.steps[0]).toMatchObject({ status: "running", requeued: true });
    expect(requeued!.steps[0]!.audioBatchIds).toHaveLength(1);
    const finished = await until(projectId, ["completed", "completed_with_warnings"]);
    expect(finished.status).toBe("completed");
    const progress = await u.get<{ totals: { segments: number; withAudio: number } }>(
      `/api/projects/${projectId}/narration/progress`,
    );
    expect(progress.totals.withAudio).toBe(progress.totals.segments);
  }, 400_000);

  test("a run is advanced by one holder of its lease at a time, and an expired lease is taken over", async () => {
    const p = await u.post<{ project: { id: string } }>("/api/projects", { title: "Lease" }, 201);
    const projectId = p.project.id;
    const { db } = h.deps;
    const [me] = await db.select().from(users).where(eq(users.username, "prod"));
    const newRun = async () =>
      (
        await db
          .insert(productionRuns)
          .values({
            projectId,
            userId: me!.id,
            options: { reviewGates: false, preparePrompts: false, render: false, youtube: false },
            steps: [{ key: "thumbnail", status: "pending" }],
          })
          .returning()
      )[0]!;
    const thumbnailJobs = async () =>
      (
        await db
          .select({ id: generationJobs.id })
          .from(generationJobs)
          .where(and(eq(generationJobs.projectId, projectId), eq(generationJobs.kind, "thumbnail")))
      ).length;

    // Two processes advance the same run at once: the thumbnail is queued once, and the lease is released after.
    const run = await newRun();
    await Promise.all([advanceRun(h.deps, run.id, "process-a"), advanceRun(h.deps, run.id, "process-b")]);
    expect(await thumbnailJobs()).toBe(1);
    const [after] = await db.select().from(productionRuns).where(eq(productionRuns.id, run.id));
    expect(after!.steps[0]!.status).toBe("running");
    expect(after!.leaseOwner).toBeNull();
    await u.post(`/api/production-runs/${run.id}/cancel`, {});

    // A live lease held elsewhere keeps others out; once it has expired (its holder died), another takes over.
    const second = await newRun();
    await db
      .update(productionRuns)
      .set({ leaseOwner: "process-a", leaseUntil: sql`now() + interval '1 minute'` })
      .where(eq(productionRuns.id, second.id));
    await advanceRun(h.deps, second.id, "process-b");
    const [held] = await db.select().from(productionRuns).where(eq(productionRuns.id, second.id));
    expect(held!.steps[0]!.status).toBe("pending");
    expect(held!.leaseOwner).toBe("process-a");
    await db
      .update(productionRuns)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(productionRuns.id, second.id));
    await advanceRun(h.deps, second.id, "process-b");
    const [taken] = await db.select().from(productionRuns).where(eq(productionRuns.id, second.id));
    // Started (or skipped, if the first run's thumbnail has landed by now): either way, advanced.
    expect(["running", "skipped"]).toContain(taken!.steps[0]!.status);
    expect(taken!.leaseOwner).toBeNull();
    await u.post(`/api/production-runs/${second.id}/cancel`, {});
  });

  test("a chapter whose text changed after planning is never re-planned on its own: the run asks, keep or re-plan", async () => {
    const projectId = await produce("Changed text");
    type Stale = { chapterId: string; pages: number; drawnPanels: number };
    const staleness = () =>
      u.get<{ stages: { key: string; count: number }[]; stalePlans: Stale[]; staleNarration: Stale[] }>(
        `/api/projects/${projectId}/staleness`,
      );
    const count = async (key: string) => (await staleness()).stages.find((s) => s.key === key)!.count;
    // Planned and narrated by the run: up to date.
    expect(await count("plan")).toBe(0);
    expect(await count("narration")).toBe(0);
    const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
    const chapterId = chapters[0]!.id;
    const pageIds = async () =>
      (await u.get<{ pages: { id: string }[] }>(`/api/chapters/${chapterId}`)).pages.map((p) => p.id);
    const before = await pageIds();

    // The writer edits the chapter's text: its plan is now out of date (the narration is written from the panels).
    await u.patch(`/api/chapters/${chapterId}`, {
      sourceExcerpt: `${STORY}\nWoo Jin sheathed the sword and walked to the edge of the roof.`,
    });
    const s1 = await staleness();
    expect(s1.stalePlans).toMatchObject([{ chapterId, pages: before.length }]);
    expect(s1.staleNarration).toEqual([]);
    expect(await count("plan")).toBe(1);

    // Update production stops at a review listing it instead of re-planning it.
    const { run } = await u.post<{ run: Run }>(
      `/api/projects/${projectId}/production-runs`,
      { update: true, reviewGates: false, render: false, youtube: false },
      201,
    );
    expect(run.steps[0]!.key).toBe("review_plans");
    let r = await until(projectId, ["waiting"]);
    expect(r.steps.find((s) => s.status === "review")?.key).toBe("review_plans");
    // Keep: the plan is current again, and nothing was replaced.
    await u.post(`/api/chapters/${chapterId}/keep`, { stage: "plan" });
    expect((await staleness()).stalePlans).toEqual([]);
    await u.post(`/api/production-runs/${run.id}/continue`);
    r = await until(projectId, ["completed"]);
    expect(await pageIds()).toEqual(before);
    expect(await count("plan")).toBe(0);

    // A panel edited after the narration was written: the narration is out of date, and an update asks the same way.
    const { panels } = await u.get<{ panels: { id: string }[] }>(`/api/chapters/${chapterId}/panels`);
    const { specs } = await u.get<{ specs: { spec: Record<string, unknown> }[] }>(`/api/panels/${panels[0]!.id}`);
    await u.put(`/api/panels/${panels[0]!.id}/spec`, { spec: { ...specs[0]!.spec, beat: "Woo Jin turns away." } });
    expect((await staleness()).staleNarration).toMatchObject([{ chapterId }]);
    const again = await u.post<{ run: Run }>(
      `/api/projects/${projectId}/production-runs`,
      { update: true, reviewGates: false, preparePrompts: false, render: false, youtube: false },
      201,
    );
    r = await until(projectId, ["waiting"]);
    expect(r.steps.find((s) => s.status === "review")?.key).toBe("review_narration");
    await u.post(`/api/chapters/${chapterId}/keep`, { stage: "narration" });
    expect(await count("narration")).toBe(0);
    await u.post(`/api/production-runs/${again.run.id}/continue`);
    await until(projectId, ["completed"]);

    // Re-plan: the chapter plan route with replace=true replaces the pages and records the new fingerprint.
    await u.patch(`/api/chapters/${chapterId}`, { sourceExcerpt: `${STORY}\nThe rain stopped.` });
    expect((await staleness()).stalePlans).toHaveLength(1);
    const plan = await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, { replace: true }, 202);
    await waitFor(
      async () =>
        (await u.get<{ job: { status: string } }>(`/api/generations/${plan.job.id}`)).job.status === "completed",
      { label: "re-plan", timeoutMs: 60_000 },
    );
    const after = await pageIds();
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((id) => before.includes(id))).toBe(false);
    expect((await staleness()).stalePlans).toEqual([]);
  }, 400_000);

  test("the YouTube text and thumbnail headline are flagged when the title changes, and only regenerated when asked", async () => {
    const p = await u.post<{ project: { id: string } }>(
      "/api/projects",
      { title: "Publishing", story: { content: STORY, inputKind: "story" } },
      201,
    );
    const projectId = p.project.id;
    await u.patch(`/api/projects/${projectId}`, { settings: { budgetUsd: 50 } });
    await u.post(
      `/api/projects/${projectId}/production-runs`,
      { reviewGates: false, render: false, youtube: true },
      201,
    );
    await until(projectId, ["completed"]);
    type Flag = { key: string; stale: boolean; reasons: string[] };
    const flags = async () =>
      Object.fromEntries(
        (await u.get<{ publishing: Flag[] }>(`/api/projects/${projectId}/staleness`)).publishing.map((f) => [
          f.key,
          f.stale,
        ]),
      );
    expect(await flags()).toEqual({ youtube_text: false, thumbnail: false });

    // Renaming the project: both were written for the old title.
    await u.patch(`/api/projects/${projectId}`, { title: "Publishing, renamed" });
    expect(await flags()).toEqual({ youtube_text: true, thumbnail: true });
    await u.post(`/api/projects/${projectId}/keep-current`, { item: "thumbnail" });
    expect(await flags()).toEqual({ youtube_text: true, thumbnail: false });

    // An update leaves them alone and says so at the end.
    const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
    const { lines } = await u.get<{ lines: { id: string }[] }>(`/api/chapters/${chapters[0]!.id}/narration`);
    await u.patch(`/api/narration-lines/${lines[0]!.id}`, { text: "The rain kept falling on the roof." });
    const yt = async () =>
      (await u.get<{ project: { settings: { youtubePackage?: { titles: string[] } } } }>(`/api/projects/${projectId}`))
        .project.settings.youtubePackage;
    const before = await yt();
    await u.post(
      `/api/projects/${projectId}/production-runs`,
      { update: true, reviewGates: false, render: false, youtube: true },
      201,
    );
    const done = await until(projectId, ["completed"]);
    expect(done.reason).toBe("YouTube text may be out of date");
    expect(await yt()).toEqual(before);

    // Regenerating it on request writes it for the current title and chapters.
    const job = await u.post<{ job: { id: string } }>(`/api/projects/${projectId}/youtube-package`, {}, 202);
    await waitFor(
      async () =>
        (await u.get<{ job: { status: string } }>(`/api/generations/${job.job.id}`)).job.status === "completed",
      { label: "youtube text" },
    );
    expect(await flags()).toEqual({ youtube_text: false, thumbnail: false });
    // A headline the person sets is set for the title as it is then.
    await u.patch(`/api/projects/${projectId}`, { title: "Publishing, again" });
    const { project } = await u.get<{ project: { settings: { thumbnail: Record<string, unknown> } } }>(
      `/api/projects/${projectId}`,
    );
    await u.patch(`/api/projects/${projectId}`, {
      settings: { thumbnail: { ...project.settings.thumbnail, title: "A new headline" } },
    });
    expect((await flags()).thumbnail).toBe(false);
  }, 400_000);

  test("the final-output gate: a missing audio segment and a too-short render are reported, and health counts them", async () => {
    const projectId = await produce("Gate");
    const { db } = h.deps;
    const [me] = await db.select().from(users).where(eq(users.username, "prod"));
    type Warnings = { segmentsWithoutAudio: number; video: string | null } | null;
    const finish = async (render: boolean, steps: { key: string; status: "done"; exportJobId?: string }[]) => {
      const [run] = await db
        .insert(productionRuns)
        .values({
          projectId,
          userId: me!.id,
          options: { reviewGates: false, preparePrompts: false, render, youtube: false },
          steps,
        })
        .returning();
      await advanceRun(h.deps, run!.id);
      const [row] = await db.select().from(productionRuns).where(eq(productionRuns.id, run!.id));
      return { status: row!.status, warnings: row!.warnings as Warnings };
    };
    expect(await finish(false, [{ key: "audio", status: "done" }])).toMatchObject({ status: "completed" });

    // A segment that lost its audio: the run does not report success.
    const [seg] = await db.select().from(narrationSegments).where(eq(narrationSegments.projectId, projectId)).limit(1);
    await db.update(narrationSegments).set({ activeAudioAssetId: null }).where(eq(narrationSegments.id, seg!.id));
    const missing = await finish(false, [{ key: "audio", status: "done" }]);
    expect(missing.status).toBe("completed_with_warnings");
    expect(missing.warnings?.segmentsWithoutAudio).toBe(1);
    expect(missing.warnings?.video).toBeNull();
    await db
      .update(narrationSegments)
      .set({ activeAudioAssetId: seg!.activeAudioAssetId })
      .where(eq(narrationSegments.id, seg!.id));

    // A render half a second long against several seconds of narration: too short.
    const [render] = await db
      .insert(exportJobs)
      .values({ projectId, kind: "video_pages", status: "completed", finishedAt: new Date() })
      .returning();
    const asset = await h.deps.assets.store({
      projectId,
      ownerUserId: me!.id,
      type: "export",
      data: new Uint8Array([0, 0, 0, 24]),
      mimeType: "video/mp4",
      durationMs: 500,
      metadata: { exportJobId: render!.id, kind: "video_pages", fileName: "film.mp4" },
    });
    await db.insert(exportsTable).values({
      projectId,
      exportJobId: render!.id,
      assetId: asset.id,
      kind: "video_pages",
      fileName: "film.mp4",
      expiresAt: new Date(Date.now() + 86400_000),
    });
    const short = await finish(true, [{ key: "render", status: "done", exportJobId: render!.id }]);
    expect(short.status).toBe("completed_with_warnings");
    expect(short.warnings?.video).toContain("too short");
    expect(short.warnings?.segmentsWithoutAudio).toBe(0);
    // Health below counts a segment without audio again.
    await db.update(narrationSegments).set({ activeAudioAssetId: null }).where(eq(narrationSegments.id, seg!.id));

    // Health: not ready, with the missing audio and the video among the blocking items, and the counts.
    const { panels } = await u.get<{ panels: { id: string }[] }>(
      `/api/chapters/${(await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`)).chapters[0]!.id}/panels`,
    );
    await u.post(`/api/panels/${panels[0]!.id}/comments`, { body: "The sword should be on the left." }, 201);
    const [pn] = await db.select().from(panelsTable).where(eq(panelsTable.id, panels[0]!.id));
    await db
      .update(panelsTable)
      .set({ qa: { verdict: "mismatch", assetId: pn!.activeArtworkAssetId } })
      .where(eq(panelsTable.id, pn!.id));
    type Health = {
      verdict: { ready: boolean; blocking: number };
      items: { key: string; count: number; severity: string }[];
      spend: { usd: number; budgetUsd: number | null };
      disk: { totalBytes: number };
    };
    const health = await u.get<Health>(`/api/projects/${projectId}/health`);
    const item = (k: string) => health.items.find((i) => i.key === k || i.key.startsWith(`${k}.`));
    expect(health.verdict.ready).toBe(false);
    expect(health.verdict.blocking).toBe(health.items.filter((i) => i.severity === "block").length);
    expect(item("readiness.missing_audio")).toMatchObject({ count: 1, severity: "block" });
    expect(item("checks")).toMatchObject({ count: 1, severity: "block" });
    expect(item("comments")).toMatchObject({ count: 1, severity: "info" });
    expect(item("stale.audio")).toMatchObject({ count: 1, severity: "info" });
    expect(health.spend.budgetUsd).toBe(50);
    expect(health.disk.totalBytes).toBeGreaterThan(0);
  }, 400_000);

  test("the batch policy only batches keys whose provider has a batch API", async () => {
    const key = async (kind: string) =>
      (
        await u.post<{ credential: { id: string } }>(
          "/api/ai/credentials",
          { kind, label: kind, apiKey: `sk-test-${kind}-1234567890` },
          201,
        )
      ).credential.id;
    const deepseek = await key("deepseek");
    const openai = await key("openai");
    const project = (policy: string) =>
      ({ settings: { batchPolicy: policy } }) as unknown as Parameters<typeof batchModes>[1];
    const o = (text: string | null, image: string | null) => ({
      reviewGates: false,
      preparePrompts: false,
      render: false,
      youtube: false,
      ai: { text: { credentialId: text }, image: { credentialId: image } },
    });
    // Text now, images in batches: DeepSeek text runs now, OpenAI images wait in a batch.
    expect(await batchModes(h.deps, project("images"), o(deepseek, openai))).toEqual({ text: false, image: true });
    // Everything in batches still cannot batch DeepSeek text.
    expect(await batchModes(h.deps, project("cheapest"), o(deepseek, openai))).toEqual({ text: false, image: true });
    expect(await batchModes(h.deps, project("hybrid"), o(openai, openai))).toEqual({ text: true, image: false });
    expect(await batchModes(h.deps, project("interactive"), o(openai, openai))).toEqual({ text: false, image: false });
    expect(await batchModes(h.deps, project("cheapest"), o(null, null))).toEqual({ text: false, image: false });
  });

  test("a 3-hour recap asks the analysis for enough chapters to fit its length", async () => {
    const p = await u.post<{ project: { id: string } }>(
      "/api/projects",
      {
        title: "Three hours",
        format: "film",
        preset: "youtube-recap-180",
        story: { content: STORY, inputKind: "story" },
      },
      201,
    );
    const report = await u.get<{ neededChapters: number | null; target: { minutes: number } }>(
      `/api/projects/${p.project.id}/runtime`,
    );
    expect(report.target.minutes).toBe(180);
    expect(report.neededChapters).toBe(25);
    const story = await u.get<{ latest: { id: string } }>(`/api/projects/${p.project.id}/story`);
    const a = await u.post<{ job: { id: string } }>(`/api/story-revisions/${story.latest.id}/analyze`, {}, 202);
    const job = await waitFor(
      async () => {
        const r = await u.get<{ job: { status: string; compiledPrompt: string | null; templateVersion: number } }>(
          `/api/generations/${a.job.id}`,
        );
        return r.job.status === "completed" ? r.job : null;
      },
      { label: "analysis", timeoutMs: 60_000 },
    );
    expect(job.templateVersion).toBe(3);
    expect(job.compiledPrompt).toContain("at least 25 chapters");
  }, 120_000);

  test("paste mode runs even under a batch policy, and main-only references still cover an unplanned project", async () => {
    const p = await u.post<{ project: { id: string } }>(
      "/api/projects",
      { title: "Economy", preset: "economy", story: { content: STORY, inputKind: "story" } },
      201,
    );
    const projectId = p.project.id;
    await u.patch(`/api/projects/${projectId}`, { settings: { budgetUsd: 20, batchPolicy: "cheapest" } });
    const { run } = await u.post<{ run: Run }>(
      `/api/projects/${projectId}/production-runs`,
      {
        reviewGates: false,
        render: false,
        youtube: false,
        ai: { text: { credentialId: null, manual: true }, image: null },
      },
      201,
    );
    // The analysis waits for a pasted answer instead of being refused for asking for a batch.
    const waiting = await waitFor(
      async () => {
        await advanceRun(h.deps, run.id);
        const { runs } = await u.get<{ runs: Run[] }>(`/api/projects/${projectId}/production-runs`);
        const analyze = runs[0]!.steps.find((s) => s.key === "analyze")!;
        if (runs[0]!.status === "failed") throw new Error(`run failed: ${runs[0]!.reason}`);
        return analyze.status === "running" ? analyze : null;
      },
      { label: "analysis queued", timeoutMs: 30_000 },
    );
    expect(waiting.status).toBe("running");
    // Stopping the run (default) cancels the analysis job it left waiting for an answer.
    const analysisJob = (waiting as { jobIds?: string[] }).jobIds![0]!;
    expect(
      (await u.get<{ run: Run & { pendingJobs: number } }>(`/api/production-runs/${run.id}`)).run.pendingJobs,
    ).toBe(1);
    expect((await u.post<{ cancelled: number }>(`/api/production-runs/${run.id}/cancel`)).cancelled).toBe(1);
    expect((await u.get<{ job: { status: string } }>(`/api/generations/${analysisJob}`)).job.status).toBe("cancelled");

    // Nothing is planned yet, so the main-only policy cannot tell recurring places from one-offs: all are drawn.
    const story = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
    const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
      `/api/story-revisions/${story.latest.id}/analyze`,
      {},
      202,
    );
    await waitFor(
      async () => {
        const r = await u.get<{ job: { status: string } }>(`/api/generations/${a.job.id}`);
        return r.job.status === "completed" ? r : null;
      },
      { label: "analysis", timeoutMs: 60_000 },
    );
    await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
    const est = await u.post<{ count: number; total: number; skippedReasons: { minor: number } }>(
      `/api/projects/${projectId}/generations/bulk`,
      { scope: { references: "location" }, onlyMissing: true },
    );
    expect(est.total).toBeGreaterThan(0);
    expect(est.skippedReasons.minor).toBe(0);
  }, 120_000);

  test("stopping a run cancels its queued audio and export, or only the run with jobs: false", async () => {
    const projectId = builtProjectId;
    const { db } = h.deps;
    const [me] = await db.select().from(users).where(eq(users.username, "prod"));
    const [seg] = await db.select().from(narrationSegments).where(eq(narrationSegments.projectId, projectId)).limit(1);
    // A run part-way through: synthesis it queued and a render, neither started (rows only, nothing on the queue).
    const queue = async () => {
      const batchId = crypto.randomUUID();
      const [audio] = await db
        .insert(audioJobs)
        .values({ projectId, segmentId: seg!.id, batchId, voice: "af_heart", speed: 1 })
        .returning();
      const [render] = await db.insert(exportJobs).values({ projectId, kind: "video_pages" }).returning();
      const [run] = await db
        .insert(productionRuns)
        .values({
          projectId,
          userId: me!.id,
          status: "waiting",
          options: { reviewGates: true, preparePrompts: false, render: true, youtube: false },
          steps: [
            { key: "audio", status: "running", audioBatchIds: [batchId] },
            { key: "render", status: "running", exportJobId: render!.id },
          ],
        })
        .returning();
      return { run: run!, audio: audio!, render: render! };
    };
    const status = async (a: { id: string }, r: { id: string }) => [
      (await db.select().from(audioJobs).where(eq(audioJobs.id, a.id)))[0]!.status,
      (await db.select().from(exportJobs).where(eq(exportJobs.id, r.id)))[0]!.status,
    ];

    const first = await queue();
    expect(
      (await u.get<{ run: { pendingJobs: number } }>(`/api/production-runs/${first.run.id}`)).run.pendingJobs,
    ).toBe(2);
    expect((await u.post<{ cancelled: number }>(`/api/production-runs/${first.run.id}/cancel`, {})).cancelled).toBe(2);
    expect(await status(first.audio, first.render)).toEqual(["cancelled", "cancelled"]);

    const second = await queue();
    expect(
      (await u.post<{ cancelled: number }>(`/api/production-runs/${second.run.id}/cancel`, { jobs: false })).cancelled,
    ).toBe(0);
    expect((await u.get<{ run: { status: string } }>(`/api/production-runs/${second.run.id}`)).run.status).toBe(
      "cancelled",
    );
    expect(await status(second.audio, second.render)).toEqual(["queued", "queued"]);
    await db.update(audioJobs).set({ status: "cancelled" }).where(eq(audioJobs.id, second.audio.id));
    await db.update(exportJobs).set({ status: "cancelled" }).where(eq(exportJobs.id, second.render.id));
  });
});
