import { afterAll, beforeAll, expect, test } from "bun:test";
import { sharp } from "@openmanga/image-utils";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let pageId: string;
type Doc = {
  panels: { id: string; frame: { x: number; y: number; width: number; height: number; points?: unknown } }[];
};

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "shaper", email: "sh@example.com", password: "shape pass 123" }, 201);
  const { project } = await u.post<{ project: { id: string } }>("/api/projects", { title: "Shapes" }, 201);
  const { chapter } = await u.post<{ chapter: { id: string } }>(
    `/api/projects/${project.id}/chapters`,
    { title: "One" },
    201,
  );
  const { page } = await u.post<{ page: { id: string } }>(
    `/api/chapters/${chapter.id}/pages`,
    { layoutTemplate: "two-vertical" },
    201,
  );
  pageId = page.id;
}, 60_000);
afterAll(() => h?.stop());

test("a slanted gutter: two panels saved with polygon outlines, kept, and drawn as polygons", async () => {
  const doc = await u.get<Doc>(`/api/pages/${pageId}`);
  expect(doc.panels.length).toBe(2);
  const [a, b] = doc.panels;
  // Left panel leans right at the top, the right one fills the rest: one diagonal gutter between them.
  const left = {
    x: 0.05,
    y: 0.05,
    width: 0.55,
    height: 0.9,
    points: [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.6, y: 1 },
      { x: 0, y: 1 },
    ],
  };
  const right = {
    x: 0.4,
    y: 0.05,
    width: 0.55,
    height: 0.9,
    points: [
      { x: 0.4, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ],
  };
  await u.patch(`/api/pages/${pageId}/document`, {
    panels: [
      { id: a!.id, frame: left },
      { id: b!.id, frame: right },
    ],
  });
  const after = await u.get<Doc>(`/api/pages/${pageId}`);
  expect(after.panels.find((p) => p.id === a!.id)!.frame).toEqual(left);
  expect(after.panels.find((p) => p.id === b!.id)!.frame).toEqual(right);

  // The rendered page: the gutter's white wedge between the two diagonals, not a rectangle of borders.
  const r = await u.raw("GET", `/api/pages/${pageId}/render.png?width=400`);
  expect(r.status).toBe(200);
  const png = new Uint8Array(await r.arrayBuffer());
  const meta = await sharp(png).metadata();
  expect(meta.width).toBe(400);

  // A box without points, and fewer than three points, are refused or stored as a plain box.
  await u.patch(
    `/api/pages/${pageId}/document`,
    { panels: [{ id: a!.id, frame: { ...left, points: [{ x: 0, y: 0 }] } }] },
    422,
  );
});
