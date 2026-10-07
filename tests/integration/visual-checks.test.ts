import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "@openmanga/db";
import { advanceRun } from "../../apps/api/src/lib/production.ts";
import { runMaintenance } from "../../apps/worker/src/handlers/maintenance.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows and smiled.
The door slammed shut with a BANG.`;

type Qa = {
  verdict: string;
  problems: string[];
  failed: string[];
  checks: string[];
  assetId: string;
  autoFix?: { jobId?: string; attempt?: number; skipped?: string };
};
type PanelRow = {
  id: string;
  status: string;
  activeArtworkAssetId: string | null;
  characterVersionIds: string[];
  frame: { x: number; y: number; width: number; height: number };
  qa: Qa | null;
  spec: Record<string, unknown> | null;
};

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let pageId: string;
let panel: PanelRow;

const panelNow = async () =>
  (await u.get<{ panels: PanelRow[] }>(`/api/pages/${pageId}`)).panels.find((p) => p.id === panel.id)!;
const autoFixJobs = async () =>
  (
    await h.deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from generation_jobs where target_id = ${panel.id} and kind = 'panel_generation' and parameters ? 'autoFix'`,
    )
  )[0]!.n;
const idle = () =>
  waitFor(
    async () => {
      const [r] = await h.deps.db.execute<{ n: number }>(
        sql`select count(*)::int as n from generation_jobs where project_id = ${projectId} and status in ('queued','processing')`,
      );
      return r!.n === 0 ? true : null;
    },
    { label: "jobs settle", timeoutMs: 120_000 },
  );
const settings = (consistencyCheck: Record<string, unknown>) =>
  u.patch(`/api/projects/${projectId}`, {
    settings: { consistencyCheck: { enabled: true, credentialId: null, model: "", ...consistencyCheck } },
  });
/** Set the panel's beat, where the mock check reads its [[mock:qa-*]] markers. */
const beat = async (text: string) => {
  const p = await panelNow();
  await u.put(`/api/panels/${panel.id}/spec`, { spec: { ...p.spec, beat: text } });
};
/** Generate the panel and wait for the art, its check and any re-rolls it causes to finish. */
const generate = async () => {
  await u.post(`/api/panels/${panel.id}/generate`, {}, 202);
  await new Promise((r) => setTimeout(r, 300));
  await idle();
  return (await panelNow()).qa!;
};

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post(
    "/api/auth/register",
    { username: "checker", email: "chk@example.com", password: "check pass 123" },
    201,
  );
  const { project } = await u.post<{ project: { id: string } }>(
    "/api/projects",
    { title: "Checks", story: { content: STORY, inputKind: "story" } },
    201,
  );
  projectId = project.id;
  await u.patch(`/api/projects/${projectId}`, { settings: { budgetUsd: 50 } });
  await u.post(
    `/api/projects/${projectId}/production-runs`,
    { reviewGates: false, render: false, youtube: false },
    201,
  );
  await waitFor(
    async () => {
      const { runs } = await u.get<{ runs: { id: string; status: string }[] }>(
        `/api/projects/${projectId}/production-runs`,
      );
      if (["completed", "completed_with_warnings"].includes(runs[0]!.status)) return true;
      await advanceRun(h.deps, runs[0]!.id);
      return null;
    },
    { label: "run completed", timeoutMs: 180_000 },
  );
  const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
  const ch = await u.get<{ pages: { id: string }[] }>(`/api/chapters/${chapters[0]!.id}`);
  for (const pg of ch.pages) {
    const { panels } = await u.get<{ panels: PanelRow[] }>(`/api/pages/${pg.id}`);
    const withCast = panels.find((p) => p.characterVersionIds.length && p.activeArtworkAssetId);
    if (withCast) {
      pageId = pg.id;
      panel = withCast;
      break;
    }
  }
  expect(panel).toBeDefined();
}, 240_000);
afterAll(() => h?.stop());

test("aspects the project turned on are judged; off ones are not asked", async () => {
  await settings({ checks: { outfit: "flag", palette: "off", anatomy: "flag" } });
  const qa = await generate();
  expect(qa.verdict).toBe("ok");
  expect(qa.checks).toContain("outfit");
  expect(qa.checks).toContain("anatomy");
  expect(qa.checks).not.toContain("palette");
  // No strict pose guide on the panel: pose is not asked even if it were on.
  expect(qa.checks).not.toContain("pose");
  // The check is not drawing: the panel is back to ready once it ran, not left "generating".
  expect((await panelNow()).status).toBe("ready");
});

test("maintenance puts a panel stuck in generating with nothing drawing it back to ready", async () => {
  await h.deps.db.execute(
    sql`update panels set status = 'generating', updated_at = now() - interval '2 hours' where id = ${panel.id}`,
  );
  const r = await runMaintenance(h.workerDeps);
  expect(r.unstuckPanels).toBeGreaterThanOrEqual(1);
  expect((await panelNow()).status).toBe("ready");
});

test("flag only: a failed aspect is reported and nothing is redrawn", async () => {
  await beat("Woo Jin on the roof [[mock:qa-outfit]]");
  const before = await autoFixJobs();
  const qa = await generate();
  expect(qa.verdict).toBe("mismatch");
  expect(qa.failed).toEqual(["outfit"]);
  expect(qa.problems).toContain("outfit: mock outfit mismatch");
  expect(qa.autoFix).toBeUndefined();
  expect(await autoFixJobs()).toBe(before);
});

test("an aspect turned off is neither asked nor flagged", async () => {
  await settings({ checks: { outfit: "off" } });
  const qa = await generate();
  expect(qa.checks).not.toContain("outfit");
  expect(qa.verdict).toBe("ok");
});

test("regenerate once: one automatic re-roll, then flagged with the reason", async () => {
  await settings({ checks: { outfit: "regenerate_once" } });
  const before = await autoFixJobs();
  const qa = await generate();
  expect(await autoFixJobs()).toBe(before + 1);
  // The re-rolled artwork is the one now checked, and it is still wrong.
  const p = await panelNow();
  expect(qa.assetId).toBe(p.activeArtworkAssetId!);
  expect(qa.failed).toEqual(["outfit"]);
  expect(qa.autoFix?.skipped).toMatch(/one automatic re-roll/);
});

test("regenerate to a budget: stops at a spent budget, and at the re-roll cap within it", async () => {
  await settings({ checks: { outfit: "regenerate_budget" }, autoFixBudgetUsd: 0 });
  const before = await autoFixJobs();
  let qa = await generate();
  expect(await autoFixJobs()).toBe(before);
  expect(qa.autoFix?.skipped).toMatch(/budget/);

  await settings({ checks: { outfit: "regenerate_budget" }, autoFixBudgetUsd: 100 });
  qa = await generate();
  // Three re-rolls in a row (the mock stays wrong), then it gives up.
  expect(await autoFixJobs()).toBe(before + 3);
  expect(qa.autoFix?.skipped).toMatch(/after 3 automatic re-rolls/);
}, 180_000);

test("covered faces: a bubble over a face is flagged (and never redrawn)", async () => {
  await beat("Woo Jin on the roof");
  await settings({ checks: { covered_faces: "regenerate_budget" }, autoFixBudgetUsd: 100 });
  const { dialogue } = await u.get<{ dialogue: { id: string; panelId: string | null }[] }>(`/api/pages/${pageId}`);
  const line = dialogue.find((d) => d.panelId === panel.id);
  let id = line?.id;
  if (!id)
    id = (
      await u.post<{ dialogue: { id: string } }>(
        `/api/pages/${pageId}/dialogue`,
        { text: "Who's there?", panelId: panel.id },
        201,
      )
    ).dialogue.id;
  // A bubble the size of the whole panel hides every face in it.
  const f = panel.frame;
  await u.patch(`/api/dialogue/${id}`, { bubble: { x: f.x, y: f.y, width: f.width, height: f.height } });
  const before = await autoFixJobs();
  const qa = await generate();
  expect(qa.failed).toEqual(["covered_faces"]);
  expect(qa.problems[0]).toMatch(/^lettering covers .+'s face$/);
  expect(await autoFixJobs()).toBe(before);
});
