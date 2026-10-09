import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows and smiled.
The door slammed shut with a BANG. Rain kept falling on the empty city.`;

type Frame = { x: number; y: number; width: number; height: number; points?: { x: number; y: number }[] };
type Layout = { id: string; name: string; frames: Frame[]; readingDirection: string };
type Doc = { page: { layoutTemplate: string | null }; panels: { id: string; frame: Frame }[] };

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let other: TestClient;
let projectId: string;
let chapterId: string;
let pageId: string;
let three: Layout;

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  other = h.client();
  await u.post(
    "/api/auth/register",
    { username: "layouter", email: "la@example.com", password: "layout pass 12" },
    201,
  );
  await other.post(
    "/api/auth/register",
    { username: "nolayouts", email: "nl@example.com", password: "layout pass 12" },
    201,
  );
  projectId = (
    await u.post<{ project: { id: string } }>("/api/projects", { title: "Layouts", story: { content: STORY } }, 201)
  ).project.id;
  chapterId = (await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201))
    .chapter.id;
  pageId = (
    await u.post<{ page: { id: string } }>(
      `/api/chapters/${chapterId}/pages`,
      { layoutTemplate: "three-horizontal" },
      201,
    )
  ).page.id;
}, 60_000);
afterAll(() => h?.stop());

test("a page's arrangement saved as a layout: its frames, shape included, in the account's library", async () => {
  const doc = await u.get<Doc>(`/api/pages/${pageId}`);
  expect(doc.panels.length).toBe(3);
  // A slanted first panel, so the layout carries a shape.
  const p0 = doc.panels[0]!;
  await u.patch(`/api/pages/${pageId}/document`, {
    panels: [
      {
        id: p0.id,
        frame: {
          ...p0.frame,
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 0.8, y: 1 },
            { x: 0, y: 1 },
          ],
        },
      },
    ],
  });
  const { layout } = await u.post<{ layout: Layout }>("/api/layouts", { name: "Slanted three", pageId }, 201);
  three = layout;
  expect(layout.frames.length).toBe(3);
  expect(layout.frames[0]!.points?.length).toBe(4);
  expect((await u.get<{ layouts: Layout[] }>("/api/layouts")).layouts.map((l) => l.name)).toEqual(["Slanted three"]);
  await u.patch(`/api/layouts/${layout.id}`, { name: "Slanted 3" });
  // Another account sees none of them and cannot use them.
  expect((await other.get<{ layouts: Layout[] }>("/api/layouts")).layouts).toEqual([]);
  await other.patch(`/api/layouts/${layout.id}`, { name: "x" }, 404);
});

test("a saved layout applied to a page: by key, from the library, adding panels when it has more frames", async () => {
  const p2 = (
    await u.post<{ page: { id: string } }>(
      `/api/chapters/${chapterId}/pages`,
      { layoutTemplate: "two-horizontal" },
      201,
    )
  ).page.id;
  await u.post(`/api/pages/${p2}/layout`, { layoutTemplate: `custom:${three.id}` });
  const doc = await u.get<Doc>(`/api/pages/${p2}`);
  expect(doc.page.layoutTemplate).toBe(`custom:${three.id}`);
  expect(doc.panels.length).toBe(3);
  expect(doc.panels[0]!.frame.points?.length).toBe(4);
  // A new page can start from it too; an unknown key is refused.
  await u.post(`/api/chapters/${chapterId}/pages`, { layoutTemplate: `custom:${three.id}` }, 201);
  await u.post(
    `/api/chapters/${chapterId}/pages`,
    { layoutTemplate: "custom:00000000-0000-4000-8000-000000000000" },
    400,
  );
});

test("a chapter re-laid with the project's layouts: pages matched by panel count, others left alone", async () => {
  await u.post(`/api/chapters/${chapterId}/apply-layouts`, {}, 400); // the project has no layouts yet
  await u.patch(`/api/projects/${projectId}`, { settings: { layouts: [three] } });
  const odd = (
    await u.post<{ page: { id: string } }>(`/api/chapters/${chapterId}/pages`, { layoutTemplate: "four-grid" }, 201)
  ).page.id;
  const r = await u.post<{ changed: number; skipped: number }>(`/api/chapters/${chapterId}/apply-layouts`, {});
  expect(r).toEqual({ changed: 3, skipped: 1 });
  const first = await u.get<Doc>(`/api/pages/${pageId}`);
  expect(first.page.layoutTemplate).toBe(`custom:${three.id}`);
  expect((await u.get<Doc>(`/api/pages/${odd}`)).page.layoutTemplate).toBe("four-grid");
  const proj = await u.post<{ changed: number; skipped: number }>(`/api/projects/${projectId}/apply-layouts`, {
    layoutIds: [three.id],
  });
  expect(proj.changed).toBe(3);
});

test("planning a chapter gives its pages the project's layouts where the panel count fits", async () => {
  const { latest } = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const an = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${latest.id}/analyze`,
    {},
    202,
  );
  await waitFor(
    async () =>
      (await u.get<{ job: { status: string } }>(`/api/generations/${an.job.id}`)).job.status === "completed" || null,
    {
      label: "analysis",
    },
  );
  await u.post(`/api/story-analyses/${an.analysis.id}/apply`, {});
  const { chapters } = await u.get<{ chapters: { id: string; order: number }[] }>(
    `/api/projects/${projectId}/chapters`,
  );
  const planned = chapters.find((c) => c.id !== chapterId)!;
  // A 1, 2, 4 and 5 panel layout too, so every page the mock plans finds one.
  const keys = { 1: "full-page", 2: "two-horizontal", 4: "four-grid", 5: "five-action" } as Record<number, string>;
  const extra: Layout[] = [];
  for (const n of [1, 2, 4, 5]) {
    const pg = (
      await u.post<{ page: { id: string } }>(`/api/chapters/${chapterId}/pages`, { layoutTemplate: keys[n] }, 201)
    ).page.id;
    extra.push((await u.post<{ layout: Layout }>("/api/layouts", { name: `${n} panels`, pageId: pg }, 201)).layout);
  }
  await u.patch(`/api/projects/${projectId}`, { settings: { layouts: [three, ...extra] } });
  const plan = await u.post<{ job: { id: string } }>(`/api/chapters/${planned.id}/plan`, {}, 202);
  await waitFor(
    async () =>
      (await u.get<{ job: { status: string } }>(`/api/generations/${plan.job.id}`)).job.status === "completed" || null,
    {
      label: "plan",
    },
  );
  const detail = await u.get<{ pages: { id: string; layoutTemplate: string | null }[] }>(`/api/chapters/${planned.id}`);
  expect(detail.pages.length).toBeGreaterThan(0);
  expect(detail.pages.every((p) => p.layoutTemplate?.startsWith("custom:"))).toBe(true);
}, 120_000);

test("MCP: list the layouts, save one from a page, re-lay a chapter", async () => {
  const { token } = await u.post<{ token: string }>(
    "/api/agents/tokens",
    {
      name: "layouts agent",
      scopes: ["chapters:read", "chapters:write", "projects:read"],
      projectAccess: "all",
      approvalMode: "ALLOW_ALL",
    },
    201,
  );
  const client = new Client({ name: "layouts-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
      fetch: (url, init) => {
        const headers = new Headers((init as RequestInit).headers);
        headers.set("host", "test.local");
        return Promise.resolve(h.app.request(String(url), { ...(init as RequestInit), headers }));
      },
    }),
  );
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: "manage_layouts", arguments: args });
    expect(r.isError).toBeFalsy();
    return (r.structuredContent as { data: Record<string, unknown> }).data;
  };
  const listed = await call({ action: "list", projectId });
  expect((listed.layouts as unknown[]).length).toBeGreaterThan(0);
  expect((listed.projectLayouts as unknown[]).length).toBeGreaterThan(0);
  const saved = await call({ action: "save", pageId, name: "From an agent" });
  expect((saved.layout as { name: string }).name).toBe("From an agent");
  const applied = await call({ action: "apply", chapterId });
  expect(applied).toMatchObject({ changed: expect.any(Number), skipped: expect.any(Number) });
});
