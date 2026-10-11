import { afterAll, beforeAll, expect, test } from "bun:test";
import { assets, eq, inArray } from "@openmanga/db";
import { enforceProjectPolicies } from "../../apps/worker/src/handlers/maintenance.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. "Who's there?" Woo Jin asked.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let panelId: string;
let chapterId: string;

type View = {
  policy: { enabled: boolean };
  use: { bytes: number; capBytes: number | null; overCap: boolean };
  expendable: Record<string, { files: number; bytes: number }>;
  preview: { files: number; bytes: number } | null;
};
const done = (id: string) =>
  waitFor(
    async () => {
      const r = await u.get<{ job: { status: string } }>(`/api/generations/${id}`);
      return ["completed", "failed"].includes(r.job.status) ? r.job : null;
    },
    { label: "job", timeoutMs: 60_000 },
  );
const drawn = async () =>
  (await h.deps.db.select({ id: assets.id }).from(assets).where(eq(assets.projectId, projectId))).filter(Boolean);

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "keeper", email: "ke@example.com", password: "keeper-pass-12" }, 201);
  projectId = (
    await u.post<{ project: { id: string } }>("/api/projects", { title: "Storage", story: { content: STORY } }, 201)
  ).project.id;
  const { latest } = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${latest.id}/analyze`,
    {},
    202,
  );
  await done(a.job.id);
  await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
  chapterId = (await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`)).chapters[0]!.id;
  await done((await u.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, {}, 202)).job.id);
  const { panels } = await u.get<{ panels: { id: string }[] }>(`/api/chapters/${chapterId}/panels`);
  panelId = panels[0]!.id;
  for (let i = 0; i < 3; i++)
    await done((await u.post<{ job: { id: string } }>(`/api/panels/${panelId}/generate`, {}, 202)).job.id);
}, 180_000);
afterAll(() => h?.stop());

test("a project's policy deletes older panel versions by their own age, and leaves the art a panel shows", async () => {
  const before = await u.get<View>(`/api/projects/${projectId}/storage`);
  expect(before.policy.enabled).toBe(false);
  expect(before.expendable.panel_version?.files).toBe(2);
  expect(before.preview).toBeNull();
  // The two older versions were drawn "40 days ago".
  const { panel } = await u.get<{ panel: { activeArtworkAssetId: string } }>(`/api/panels/${panelId}`);
  const older = (await drawn()).map((a) => a.id).filter((id) => id !== panel.activeArtworkAssetId);
  await h.deps.db
    .update(assets)
    .set({ createdAt: new Date(Date.now() - 40 * 86_400_000) })
    .where(inArray(assets.id, older));
  await h.deps.db
    .update(assets)
    .set({ createdAt: new Date(Date.now() - 40 * 86_400_000) })
    .where(eq(assets.id, panel.activeArtworkAssetId));
  // Generally 365 days, but older panel versions only 30: those go, nothing else.
  const set = await u.put<View>(`/api/projects/${projectId}/storage`, {
    enabled: true,
    maxAgeDays: 365,
    kindAges: { panel_version: 30, export: null },
    capGb: null,
  });
  expect(set.preview?.files).toBe(2);
  const r = await u.post<View & { deleted: number }>(`/api/projects/${projectId}/storage/apply`, {});
  expect(r.deleted).toBe(2);
  expect(r.expendable.panel_version).toBeUndefined();
  const left = (await drawn()).map((a) => a.id);
  expect(left).toContain(panel.activeArtworkAssetId);
  for (const id of older) expect(left).not.toContain(id);
});

test("over its cap, a project makes nothing new; maintenance applies the policy by itself", async () => {
  await u.put(`/api/projects/${projectId}/storage`, { enabled: true, maxAgeDays: null, capGb: 0.000001 });
  const v = await u.get<View>(`/api/projects/${projectId}/storage`);
  expect(v.use.overCap).toBe(true);
  const r = await u.raw("POST", `/api/panels/${panelId}/generate`, {});
  expect(r.status).toBe(409);
  expect(((await r.json()) as { error: { code: string } }).error.code).toBe("storage_cap_exceeded");
  await u.post(`/api/projects/${projectId}/exports`, { kind: "project_json", acknowledgeIssues: true }, 409);
  // Raised: room again, and an expendable export older than its age is cleared by the hourly pass.
  await u.put(`/api/projects/${projectId}/storage`, { enabled: true, maxAgeDays: null, capGb: 50 });
  const ex = await u.post<{ job: { id: string } }>(
    `/api/projects/${projectId}/exports`,
    { kind: "project_json", acknowledgeIssues: true },
    202,
  );
  await waitFor(
    async () => {
      const j = await u.get<{ job: { status: string } }>(`/api/jobs/${ex.job.id}`);
      return j.job.status === "completed" ? j : null;
    },
    { label: "export", timeoutMs: 60_000 },
  );
  await u.put(`/api/projects/${projectId}/storage`, {
    enabled: true,
    maxAgeDays: null,
    kindAges: { export: 1 },
    capGb: 50,
  });
  const exported = (await u.get<View>(`/api/projects/${projectId}/storage`)).expendable.export!;
  expect(exported.files).toBe(1);
  await h.deps.db
    .update(assets)
    .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
    .where(eq(assets.projectId, projectId));
  expect(await enforceProjectPolicies(h.workerDeps)).toBeGreaterThanOrEqual(1);
  expect((await u.get<View>(`/api/projects/${projectId}/storage`)).expendable.export).toBeUndefined();
});
