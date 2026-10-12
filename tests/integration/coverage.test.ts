import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let chapterId: string;
let pageId: string;
let panelId: string;

type Panel = {
  id: string;
  shotType: string;
  cameraAngle: string | null;
  guide: { assetId: string; strength: string } | null;
};
type Sheets = { sheets: { jobId: string; status: string; assetId: string | null }[]; cells: string[] };

const sheetOf = async (panel: string) => {
  const { job } = await u.post<{ job: { id: string } }>(`/api/panels/${panel}/coverage`, {}, 202);
  return waitFor(
    async () => {
      const s = (await u.get<Sheets>(`/api/panels/${panel}/coverage`)).sheets.find((x) => x.jobId === job.id);
      return s?.assetId || s?.status === "failed" ? s : null;
    },
    { label: "coverage sheet", timeoutMs: 60_000 },
  );
};

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "coverer", email: "co@example.com", password: "coverer-pass-1" }, 201);
  projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Coverage" }, 201)).project.id;
  chapterId = (await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201))
    .chapter.id;
  pageId = (
    await u.post<{ page: { id: string } }>(`/api/chapters/${chapterId}/pages`, { layoutTemplate: "full-page" }, 201)
  ).page.id;
  await u.post(`/api/chapters/${chapterId}/pages`, { layoutTemplate: "two-horizontal" }, 201);
  panelId = (await u.get<{ panels: { id: string }[] }>(`/api/pages/${pageId}`)).panels[0]!.id;
  await u.put(`/api/panels/${panelId}/spec`, {
    spec: { beat: "The door bursts open", shotType: "medium", cameraAngle: "eye-level", characters: [] },
  });
}, 60_000);
afterAll(() => h?.stop());

test("a sheet of nine setups, one pick reframes the panel, several become a new page after it", async () => {
  const s = await sheetOf(panelId);
  expect(s.assetId).toBeTruthy();
  const listed = await u.get<Sheets>(`/api/panels/${panelId}/coverage`);
  expect(listed.cells).toHaveLength(9);
  expect(listed.cells[5]).toBe("Over the shoulder");

  // One pick: this panel takes the cell as a strict guide and the close-up framing.
  await u.post(`/api/coverage-sheets/${s.jobId}/use`, { cells: [4], mode: "this" });
  let doc = await u.get<{ panels: Panel[] }>(`/api/pages/${pageId}`);
  expect(doc.panels[0]).toMatchObject({ shotType: "close", cameraAngle: "eye-level", guide: { strength: "strict" } });
  const { specs } = await u.get<{ specs: { spec: { shotType: string; beat: string } }[] }>(`/api/panels/${panelId}`);
  expect(specs[0]!.spec).toMatchObject({ shotType: "close", beat: "The door bursts open" });

  // Three picks: a new 3-panel page right after this one, before the page that was next.
  const before = (await u.get<{ pages: { id: string }[] }>(`/api/chapters/${chapterId}`)).pages.map((p) => p.id);
  const r = await u.post<{ panelIds: string[]; pageIds: string[] }>(`/api/coverage-sheets/${s.jobId}/use`, {
    cells: [1, 6, 9],
  });
  expect(r.panelIds).toHaveLength(3);
  const after = (await u.get<{ pages: { id: string }[] }>(`/api/chapters/${chapterId}`)).pages.map((p) => p.id);
  expect(after).toEqual([before[0]!, r.pageIds[0]!, before[1]!]);
  doc = await u.get<{ panels: Panel[] }>(`/api/pages/${r.pageIds[0]}`);
  expect(doc.panels.map((p) => [p.shotType, p.cameraAngle])).toEqual([
    ["wide", "eye-level"],
    ["medium-close", "over-shoulder"],
    ["medium", "high"],
  ]);
  expect(doc.panels.every((p) => p.guide?.strength === "strict")).toBe(true);
  // Guides are different crops of the sheet.
  expect(new Set(doc.panels.map((p) => p.guide!.assetId)).size).toBe(3);

  // Refused: two cells to reframe one panel, six on one comic page.
  await u.post(`/api/coverage-sheets/${s.jobId}/use`, { cells: [1, 2], mode: "this" }, 400);
  await u.post(`/api/coverage-sheets/${s.jobId}/use`, { cells: [1, 2, 3, 4, 5, 6] }, 400);
}, 120_000);

test("a film project gets one page per pick", async () => {
  const film = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Film", format: "film" }, 201))
    .project.id;
  const ch = (await u.post<{ chapter: { id: string } }>(`/api/projects/${film}/chapters`, { title: "One" }, 201))
    .chapter.id;
  const pg = (await u.post<{ page: { id: string } }>(`/api/chapters/${ch}/pages`, { layoutTemplate: "full-page" }, 201))
    .page.id;
  const pn = (await u.get<{ panels: { id: string }[] }>(`/api/pages/${pg}`)).panels[0]!.id;
  const s = await sheetOf(pn);
  const r = await u.post<{ panelIds: string[]; pageIds: string[] }>(`/api/coverage-sheets/${s.jobId}/use`, {
    cells: [1, 2, 3, 4, 5, 6],
  });
  expect(r.pageIds).toHaveLength(6);
  expect(r.panelIds).toHaveLength(6);
}, 120_000);
