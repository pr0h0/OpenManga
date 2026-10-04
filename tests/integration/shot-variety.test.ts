import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;

type Variety = {
  runs: number;
  chapters: { chapterId: string; panels: number; runs: { kind: string; shotType: string; panelIds: string[] }[] }[];
};
type Health = { items: { key: string; label: string; count: number; link: { search?: Record<string, string> } }[] };

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post(
    "/api/auth/register",
    { username: "shots", email: "shots@example.com", password: "shots-pass-1234" },
    201,
  );
});
afterAll(() => h?.stop());

test("a run of the same shot is found per chapter, reported in health, and gone once a panel changes", async () => {
  const { project } = await u.post<{ project: { id: string } }>("/api/projects", { title: "Shots" }, 201);
  const { chapter } = await u.post<{ chapter: { id: string } }>(
    `/api/projects/${project.id}/chapters`,
    { title: "One" },
    201,
  );
  const { page } = await u.post<{ page: { id: string } }>(
    `/api/chapters/${chapter.id}/pages`,
    { layoutTemplate: "four-grid" },
    201,
  );
  const panels = (await u.get<{ panels: { id: string; shotType: string }[] }>(`/api/pages/${page.id}`)).panels;
  // New panels start as medium shots at eye level: four of the same framing in a row.
  expect(panels.every((p) => p.shotType === "medium")).toBe(true);
  const before = await u.get<Variety>(`/api/projects/${project.id}/shot-variety`);
  expect(before.runs).toBe(1);
  expect(before.chapters[0]).toMatchObject({ chapterId: chapter.id, panels: 4 });
  expect(before.chapters[0]!.runs[0]).toMatchObject({
    kind: "framing",
    shotType: "medium",
    panelIds: panels.map((p) => p.id),
  });
  const shots = (await u.get<Health>(`/api/projects/${project.id}/health`)).items.find((i) => i.key === "shots")!;
  expect(shots).toMatchObject({ count: 1, link: { search: { chapterId: chapter.id, filter: "repeated" } } });

  // A close shot in the middle breaks the run: medium, close, medium, medium is varied enough.
  await u.patch(`/api/panels/${panels[1]!.id}`, { shotType: "close" });
  const after = await u.get<Variety>(`/api/projects/${project.id}/shot-variety?chapterId=${chapter.id}`);
  expect(after.runs).toBe(0);
  expect((await u.get<Health>(`/api/projects/${project.id}/health`)).items.some((i) => i.key === "shots")).toBe(false);
});
