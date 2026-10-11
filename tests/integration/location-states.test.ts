import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { eq, generationJobs, referenceAssets } from "@openmanga/db";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let locationId: string;
let versionId: string;
let ch: string[];
const panelIn: Record<string, string> = {};
const sceneIn: Record<string, string> = {};

const promptOf = async (panelId: string) =>
  (await u.get<{ compiledPrompt: string }>(`/api/panels/${panelId}/prompt-preview`)).compiledPrompt;
const generated = async (jobId: string) =>
  waitFor(
    async () => {
      const [j] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
      return j?.status === "completed" || j?.status === "failed" ? j : null;
    },
    { label: "reference", timeoutMs: 60_000 },
  );
const approveNewest = async (jobId: string) => {
  const j = await generated(jobId);
  expect(j.status).toBe("completed");
  const [ref] = await h.deps.db
    .select()
    .from(referenceAssets)
    .where(eq(referenceAssets.assetId, (j.result as { assetId: string }).assetId));
  await u.post(`/api/references/${ref!.id}/status`, { status: "approved" });
  return ref!;
};

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "placer", email: "pl@example.com", password: "placer-pass-12" }, 201);
  projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Harbour" }, 201)).project.id;
  locationId = (
    await u.post<{ location: { id: string } }>(
      `/api/projects/${projectId}/locations`,
      { name: "Old lighthouse", description: { summary: "a white stone lighthouse on a cliff" } },
      201,
    )
  ).location.id;
  versionId = (await u.get<{ versions: { id: string }[] }>(`/api/locations/${locationId}`)).versions[0]!.id;
  ch = [];
  for (const title of ["One", "Two", "Three"])
    ch.push(
      (await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title }, 201)).chapter.id,
    );
  // A scene in chapter 2 at night, and one in chapter 3 at noon, each with one panel at the lighthouse.
  for (const [key, chapter, time] of [
    ["night2", ch[1]!, "late night"],
    ["noon3", ch[2]!, "noon"],
  ] as const) {
    const { scene } = await u.post<{ scene: { id: string } }>(
      `/api/chapters/${chapter}/scenes`,
      { title: key, locationId, time },
      201,
    );
    sceneIn[key] = scene.id;
    const { page } = await u.post<{ page: { id: string } }>(
      `/api/chapters/${chapter}/pages`,
      { layoutTemplate: "full-page", sceneId: scene.id },
      201,
    );
    const doc = await u.get<{ panels: { id: string }[] }>(`/api/pages/${page.id}`);
    panelIn[key] = doc.panels[0]!.id;
    await u.patch(`/api/panels/${panelIn[key]}`, { locationVersionId: versionId });
  }
}, 60_000);
afterAll(() => h?.stop());

test("a scene shows the state its time picks, or its chapter range, or the one it picks by hand", async () => {
  const add = (state: Record<string, unknown>) =>
    u.post<{ state: { id: string } }>(`/api/locations/${locationId}/states`, state, 201);
  await add({ name: "at night", description: "lamp blazing, sea black", keywords: ["night"] });
  const ruined = await add({ name: "after the storm", description: "lantern room smashed", fromChapterId: ch[2] });
  const manual = await add({ name: "in fog" });
  expect(await promptOf(panelIn.night2!)).toContain("As it is now (at night): lamp blazing, sea black");
  expect(await promptOf(panelIn.noon3!)).toContain("As it is now (after the storm): lantern room smashed");
  // Picked by hand, the scene's own choice wins.
  await u.patch(`/api/scenes/${sceneIn.noon3}`, { locationStateId: manual.state.id });
  expect(await promptOf(panelIn.noon3!)).toContain("As it is now (in fog)");
  await u.patch(`/api/scenes/${sceneIn.noon3}`, { locationStateId: null });
  // A range that ends before it starts, another project's state on a scene, are refused.
  await u.patch(`/api/location-states/${ruined.state.id}`, { untilChapterId: ch[0] }, 400);
  const other = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Other" }, 201)).project.id;
  const otherLoc = (
    await u.post<{ location: { id: string } }>(`/api/projects/${other}/locations`, { name: "Elsewhere" }, 201)
  ).location.id;
  const foreign = await u.post<{ state: { id: string } }>(`/api/locations/${otherLoc}/states`, { name: "x" }, 201);
  await u.patch(`/api/scenes/${sceneIn.noon3}`, { locationStateId: foreign.state.id }, 400);
  const listed = await u.get<{ states: { name: string }[] }>(`/api/locations/${locationId}/states`);
  expect(listed.states.map((s) => s.name)).toEqual(["at night", "after the storm", "in fog"]);
});

test("a state's reference is drawn from the design and stands in for it only where the state shows", async () => {
  const base = await approveNewest(
    (
      await u.post<{ job: { id: string } }>(
        `/api/location-versions/${versionId}/references/generate`,
        { kind: "location" },
        202,
      )
    ).job.id,
  );
  expect(base.locationStateId).toBeNull();
  const { states } = await u.get<{ states: { id: string; name: string }[] }>(`/api/locations/${locationId}/states`);
  const night = states.find((s) => s.name === "at night")!;
  const run = await u.post<{ job: { id: string } }>(
    `/api/location-versions/${versionId}/references/generate`,
    { kind: "location", locationStateId: night.id },
    202,
  );
  const [job] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, run.job.id));
  expect(job!.compiledPrompt).toContain("Reference image 1 is this place's approved design");
  const stateRef = await approveNewest(run.job.id);
  expect(stateRef.locationStateId).toBe(night.id);
  // At night: the state's own reference. At noon after the storm (no reference of its own): the design.
  const nightPrompt = await promptOf(panelIn.night2!);
  expect(nightPrompt).toContain("The location, as it is now (at night), matches reference image");
  const noon = await u.get<{ references: { assetId: string }[] }>(`/api/panels/${panelIn.noon3}/prompt-preview`);
  expect(noon.references.some((i) => i.assetId === base.assetId)).toBe(true);
  expect(noon.references.some((i) => i.assetId === stateRef.assetId)).toBe(false);
}, 120_000);

test("duplicating the project copies the states, their references and the scenes' picks", async () => {
  await u.patch(`/api/scenes/${sceneIn.noon3}`, {
    locationStateId: (await u.get<{ states: { id: string }[] }>(`/api/locations/${locationId}/states`)).states[2]!.id,
  });
  const { project } = await u.post<{ project: { id: string } }>(`/api/projects/${projectId}/duplicate`, {}, 201);
  const { locations } = await u.get<{ locations: { id: string; name: string }[] }>(
    `/api/projects/${project.id}/locations`,
  );
  const copy = locations.find((l) => l.name === "Old lighthouse")!;
  const { states } = await u.get<{
    states: { id: string; name: string; fromChapterId: string | null; scenes: unknown[] }[];
  }>(`/api/locations/${copy.id}/states`);
  expect(states.map((s) => s.name)).toEqual(["at night", "after the storm", "in fog"]);
  expect(states[1]!.fromChapterId).not.toBeNull();
  expect(states[1]!.fromChapterId).not.toBe(ch[2]);
  expect(states[2]!.scenes).toHaveLength(1);
  const refs = await h.deps.db.select().from(referenceAssets).where(eq(referenceAssets.projectId, project.id));
  expect(refs.some((r) => r.locationStateId === states[0]!.id)).toBe(true);
}, 120_000);

test("MCP: add a state, edit one field without touching the rest, list", async () => {
  const { token } = await u.post<{ token: string }>(
    "/api/agents/tokens",
    {
      name: "states agent",
      scopes: ["library:read", "library:write"],
      projectAccess: "all",
      approvalMode: "ALLOW_ALL",
    },
    201,
  );
  const client = new Client({ name: "states-agent", version: "1.0.0" });
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
    const r = await client.callTool({ name: "manage_location_states", arguments: args });
    expect(r.isError).toBeFalsy();
    return (r.structuredContent as { data: Record<string, unknown> }).data;
  };
  const added = await call({
    action: "add",
    locationId,
    state: { name: "snowed in", description: "drifts to the door", keywords: ["snow"] },
  });
  const id = (added.state as { id: string }).id;
  await call({ action: "edit", id, state: { description: "drifts to the lamp gallery" } });
  const listed = await call({ action: "list", locationId });
  expect((listed.states as { id: string }[]).find((s) => s.id === id)).toMatchObject({
    name: "snowed in",
    description: "drifts to the lamp gallery",
    keywords: ["snow"],
  });
  await client.close();
});
