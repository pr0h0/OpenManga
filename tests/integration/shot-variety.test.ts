import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
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

test("runs continue across pages but never across chapters; access; another project's chapter; MCP", async () => {
  const { project } = await u.post<{ project: { id: string } }>("/api/projects", { title: "Edges" }, 201);
  const chapter = async (title: string) =>
    (await u.post<{ chapter: { id: string } }>(`/api/projects/${project.id}/chapters`, { title }, 201)).chapter.id;
  const page = async (chapterId: string, shots: string[]) => {
    const { page } = await u.post<{ page: { id: string } }>(
      `/api/chapters/${chapterId}/pages`,
      { layoutTemplate: "four-grid" },
      201,
    );
    const panels = (await u.get<{ panels: { id: string }[] }>(`/api/pages/${page.id}`)).panels;
    for (const [i, shotType] of shots.entries()) await u.patch(`/api/panels/${panels[i]!.id}`, { shotType });
    return panels.map((p) => p.id);
  };
  const one = await chapter("One");
  const a = await page(one, ["wide", "close", "medium", "medium"]);
  const b = await page(one, ["medium", "medium", "close", "wide"]);
  const two = await chapter("Two");
  // Chapter one ends on a wide shot and two opens on two more: three in a row only if chapters ran together.
  await page(two, ["wide", "wide", "close", "insert"]);

  const v = await u.get<Variety>(`/api/projects/${project.id}/shot-variety`);
  expect(v.runs).toBe(1);
  // The run starts on page one and ends on page two: pages are read in order within the chapter.
  expect(v.chapters.find((c) => c.chapterId === one)!.runs[0]!.panelIds).toEqual([a[2]!, a[3]!, b[0]!, b[1]!]);
  expect(v.chapters.find((c) => c.chapterId === two)!.runs).toEqual([]);

  // Someone outside the project sees nothing; a chapter of another project is refused.
  const outsider = h.client();
  await outsider.post(
    "/api/auth/register",
    { username: "nosy", email: "nosy@example.com", password: "nosy-pass-1234" },
    201,
  );
  expect((await outsider.raw("GET", `/api/projects/${project.id}/shot-variety`)).status).toBeGreaterThanOrEqual(403);
  const { project: other } = await u.post<{ project: { id: string } }>("/api/projects", { title: "Other" }, 201);
  expect((await u.raw("GET", `/api/projects/${other.id}/shot-variety?chapterId=${one}`)).status).toBe(404);
  expect((await u.raw("GET", `/api/projects/${project.id}/shot-variety?chapterId=nope`)).status).toBe(422);

  // An agent reads the same report through get_project_checks.
  const { token } = await u.post<{ token: string }>(
    "/api/agents/tokens",
    { name: "shots agent", scopes: ["projects:read"], projectAccess: "all", approvalMode: "ALLOW_ALL" },
    201,
  );
  const client = new Client({ name: "shots-agent", version: "1.0.0" });
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
  const r = await client.callTool({
    name: "get_project_checks",
    arguments: { projectId: project.id, check: "shot_variety", chapterId: one },
  });
  expect(r.isError).toBeFalsy();
  expect((r.structuredContent as { data: Variety }).data.runs).toBe(1);
  await client.close();
});
