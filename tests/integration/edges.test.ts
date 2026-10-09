import { afterAll, beforeAll, expect, test } from "bun:test";
import { sharp } from "@openmanga/image-utils";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let pageId: string;

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "edger", email: "ed@example.com", password: "edge pass 1234" }, 201);
  projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Edges" }, 201)).project.id;
  const { chapter } = await u.post<{ chapter: { id: string } }>(
    `/api/projects/${projectId}/chapters`,
    { title: "One" },
    201,
  );
  pageId = (
    await u.post<{ page: { id: string } }>(`/api/chapters/${chapter.id}/pages`, { layoutTemplate: "two-vertical" }, 201)
  ).page.id;
}, 60_000);
afterAll(() => h?.stop());

const alphaAt = async (path: string, x: number, y: number) => {
  const r = await u.raw("GET", path);
  expect(r.status).toBe(200);
  const { data, info } = await sharp(new Uint8Array(await r.arrayBuffer()))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3]!;
};

test("a page edge in the project's settings: paper in page images, cut out for video previews", async () => {
  await u.patch(`/api/projects/${projectId}`, { settings: { edges: { page: { style: "torn", size: 1 } } } });
  const { project } = await u.get<{ project: { settings: { edges: unknown } } }>(`/api/projects/${projectId}`);
  expect(project.settings.edges).toEqual({ page: { style: "torn", size: 1 } });
  // The outermost row of a torn page is cut away somewhere along it: transparent in the cut-out render only.
  const row = async (cut: boolean) => {
    const r = await u.raw("GET", `/api/pages/${pageId}/render.png?width=400${cut ? "&cutout=1" : ""}`);
    const { data, info } = await sharp(new Uint8Array(await r.arrayBuffer()))
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return Array.from({ length: info.width }, (_, x) => data[x * 4 + 3]!);
  };
  expect((await row(true)).some((a) => a === 0)).toBe(true);
  expect((await row(false)).every((a) => a === 255)).toBe(true);
  // The middle of the page is page either way.
  expect(await alphaAt(`/api/pages/${pageId}/render.png?width=400&cutout=1`, 200, 300)).toBe(255);
  await u.patch(`/api/projects/${projectId}`, { settings: { edges: { page: { style: "glitter", size: 1 } } } }, 422);
});

test("a panel's own border is kept on its frame and overrides the project's default", async () => {
  await u.patch(`/api/projects/${projectId}`, { settings: { edges: { panels: { style: "wavy", size: 0.5 } } } });
  const doc = await u.get<{ panels: { id: string; frame: Record<string, unknown> }[] }>(`/api/pages/${pageId}`);
  const p = doc.panels[0]!;
  await u.patch(`/api/pages/${pageId}/document`, {
    panels: [{ id: p.id, frame: { ...p.frame, edge: { style: "burnt", size: 0.8 } } }],
  });
  const after = await u.get<{ panels: { id: string; frame: { edge?: unknown } }[] }>(`/api/pages/${pageId}`);
  expect(after.panels.find((x) => x.id === p.id)!.frame.edge).toEqual({ style: "burnt", size: 0.8 });
  expect(after.panels.find((x) => x.id !== p.id)!.frame.edge).toBeUndefined();
  expect((await u.raw("GET", `/api/pages/${pageId}/render.png?width=400`)).status).toBe(200);
});

test("a page's own edge: set on one page, the others keep the project's, and null goes back to it", async () => {
  await u.patch(`/api/projects/${projectId}`, { settings: { edges: { page: { style: "wavy", size: 1 } } } });
  const { page } = await u.patch<{ page: { edge: unknown } }>(`/api/pages/${pageId}`, {
    edge: { style: "burnt", size: 0.7 },
  });
  expect(page.edge).toEqual({ style: "burnt", size: 0.7 });
  // The page's own edge changes its render; going back to the project's changes it again.
  const png = async () =>
    new Uint8Array(await (await u.raw("GET", `/api/pages/${pageId}/render.png?width=300`)).arrayBuffer());
  const burnt = await png();
  await u.patch(`/api/pages/${pageId}`, { edge: null });
  const wavy = await png();
  expect(Buffer.from(burnt).equals(Buffer.from(wavy))).toBe(false);
  const after = await u.get<{ page: { edge: unknown } }>(`/api/pages/${pageId}`);
  expect(after.page.edge).toBeNull();
  await u.patch(`/api/pages/${pageId}`, { edge: { style: "sparkly", size: 1 } }, 422);
});
