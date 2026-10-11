import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let panelId: string;

type Run = { jobId: string; status: string; assetId: string | null; durationMs: number | null; costUsd: number };
const compare = () => u.get<{ compareId: string | null; runs: Run[] }>(`/api/panels/${panelId}/compare`);
const panel = async () =>
  (await u.get<{ panel: { activeArtworkAssetId: string | null; status: string } }>(`/api/panels/${panelId}`)).panel;

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "judge", email: "ju@example.com", password: "judge-pass-1234" }, 201);
  const projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Bake-off" }, 201)).project.id;
  const chapterId = (
    await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201)
  ).chapter.id;
  const { page } = await u.post<{ page: { id: string } }>(
    `/api/chapters/${chapterId}/pages`,
    { layoutTemplate: "full-page" },
    201,
  );
  panelId = (await u.get<{ panels: { id: string }[] }>(`/api/pages/${page.id}`)).panels[0]!.id;
}, 60_000);
afterAll(() => h?.stop());

test("runs side by side leave the panel alone; each has time and cost; the pick becomes its artwork", async () => {
  expect((await compare()).runs).toEqual([]);
  await u.post(`/api/panels/${panelId}/compare`, { runs: [{ credentialId: null }] }, 422);
  const r = await u.post<{ compareId: string; jobs: { id: string }[] }>(
    `/api/panels/${panelId}/compare`,
    { runs: [{ credentialId: null }, { credentialId: null }, { credentialId: null }] },
    202,
  );
  expect(r.jobs).toHaveLength(3);
  const done = await waitFor(
    async () => {
      const c = await compare();
      return c.runs.length === 3 && c.runs.every((x) => x.status === "completed") ? c : null;
    },
    { label: "comparison", timeoutMs: 60_000 },
  );
  expect(done.compareId).toBe(r.compareId);
  expect(done.runs.every((x) => x.assetId && x.durationMs !== null && x.costUsd >= 0)).toBe(true);
  // Nothing was made active while comparing.
  expect((await panel()).activeArtworkAssetId).toBeNull();
  const { versions } = await u.get<{ versions: { operation: string | null }[] }>(`/api/panels/${panelId}/versions`);
  expect(versions.filter((v) => v.operation === "compare")).toHaveLength(3);

  const winner = done.runs[1]!;
  const picked = await u.post<{ assetId: string }>(`/api/panels/${panelId}/compare/pick`, { jobId: winner.jobId });
  expect(picked.assetId).toBe(winner.assetId!);
  expect(await panel()).toMatchObject({ activeArtworkAssetId: winner.assetId, status: "ready" });
  await u.post(`/api/panels/${panelId}/compare/pick`, { jobId: crypto.randomUUID() }, 404);
}, 120_000);
