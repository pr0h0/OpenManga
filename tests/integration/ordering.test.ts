import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type TestClient } from "./harness.ts";

/** Moves keep every order unique (1..n): a tie leaves reading order, exports and shot order to chance. */

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId = "";

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post(
    "/api/auth/register",
    { username: "orderly", email: "order@example.com", password: "ordering-pass-1" },
    201,
  );
  projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Order" }, 201)).project.id;
});
afterAll(() => h?.stop());

test("moving a chapter renumbers the others around it", async () => {
  const ids: string[] = [];
  for (const title of ["One", "Two", "Three"])
    ids.push(
      (await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title }, 201)).chapter.id,
    );
  await u.patch(`/api/chapters/${ids[2]}`, { order: 1 });
  const { chapters } = await u.get<{ chapters: { id: string; order: number }[] }>(
    `/api/projects/${projectId}/chapters`,
  );
  expect(chapters.map((c) => c.order)).toEqual([1, 2, 3]);
  expect(chapters.map((c) => c.id)).toEqual([ids[2]!, ids[0]!, ids[1]!]);
  // An order past the end puts it last; an edit with no move leaves the order alone.
  await u.patch(`/api/chapters/${ids[2]}`, { order: 99 });
  await u.patch(`/api/chapters/${ids[0]}`, { title: "One again" });
  const after = await u.get<{ chapters: { id: string; order: number }[] }>(`/api/projects/${projectId}/chapters`);
  expect(after.chapters.map((c) => [c.id, c.order])).toEqual([
    [ids[0]!, 1],
    [ids[1]!, 2],
    [ids[2]!, 3],
  ]);
});

test("reordering some panels puts them first and keeps the rest after them, every order unique", async () => {
  const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
  const pageId = (
    await u.post<{ page: { id: string } }>(
      `/api/chapters/${chapters[0]!.id}/pages`,
      { layoutTemplate: "four-grid" },
      201,
    )
  ).page.id;
  const before = await u.get<{ panels: { id: string; order: number }[] }>(`/api/pages/${pageId}`);
  const [a, b, c, d] = [...before.panels].sort((x, y) => x.order - y.order).map((p) => p.id);
  await u.post(`/api/pages/${pageId}/reorder-panels`, { panelIds: [d, c] });
  const after = await u.get<{ panels: { id: string; order: number }[] }>(`/api/pages/${pageId}`);
  const byOrder = [...after.panels].sort((x, y) => x.order - y.order);
  expect(byOrder.map((p) => p.order)).toEqual([1, 2, 3, 4]);
  expect(byOrder.map((p) => p.id)).toEqual([d!, c!, a!, b!]);
});

test("a page inserted after a page that is not in the chapter is refused, not put first", async () => {
  const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
  await u.post(
    `/api/chapters/${chapters[0]!.id}/pages`,
    { layoutTemplate: "four-grid", afterPageId: crypto.randomUUID() },
    404,
  );
});
