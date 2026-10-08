import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { projectMembers, sql } from "@openmanga/db";
import { advanceRun } from "../../apps/api/src/lib/production.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows and smiled.`;

type Char = {
  id: string;
  name: string;
  sourceId: string | null;
  syncedVersionId: string | null;
  currentVersionId: string;
};
type Dashboard = {
  series: { id: string; libraryProjectId: string };
  library: { characters: number; locations: number; props: number; facts: number };
  episodes: { id: string; episodeNumber: number; behind: number; panels: number; panelsDrawn: number }[];
  totals: { episodes: number; behind: number };
};

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let member: TestClient;
let stranger: TestClient;
let seriesId: string;
let libraryId: string;
let libChar: { id: string; versionId: string; assetId: string };
let ep1: string;

const dash = () => u.get<Dashboard>(`/api/series/${seriesId}`);
const cast = async (projectId: string) =>
  (await u.get<{ characters: Char[] }>(`/api/projects/${projectId}/characters`)).characters;
const refsOf = (versionId: string) =>
  h.deps.db.execute<{ asset_id: string; status: string; project_id: string }>(
    sql`select asset_id, status, project_id from reference_assets where character_version_id = ${versionId}`,
  );

async function mcp(c: TestClient, grant: Record<string, unknown>) {
  const { token } = await c.post<{ token: string }>(
    "/api/agents/tokens",
    {
      name: "series agent",
      scopes: ["projects:read", "projects:write", "projects:create"],
      approvalMode: "ALLOW_ALL",
      ...grant,
    },
    201,
  );
  const client = new Client({ name: "series-agent", version: "1.0.0" });
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
  return async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as { type: string; text?: string }[]).find((x) => x.type === "text")?.text ?? "{}";
    return r.isError
      ? { error: (JSON.parse(text) as { error: { code: string } }).error, data: null }
      : { error: null, data: (r.structuredContent as { data: Record<string, unknown> }).data };
  };
}

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  member = h.client();
  stranger = h.client();
  await u.post(
    "/api/auth/register",
    { username: "showrunner", email: "sr@example.com", password: "series pass 123" },
    201,
  );
  await member.post(
    "/api/auth/register",
    { username: "artist", email: "ar@example.com", password: "series pass 123" },
    201,
  );
  await stranger.post(
    "/api/auth/register",
    { username: "nobody", email: "nb@example.com", password: "series pass 123" },
    201,
  );
}, 60_000);
afterAll(() => h?.stop());

test("a series has a library project, hidden from the project list and edited with the usual routes", async () => {
  const { series } = await u.post<{ series: { id: string; libraryProjectId: string } }>(
    "/api/series",
    { title: "Rooftop Tales", description: "Recaps" },
    201,
  );
  seriesId = series.id;
  libraryId = series.libraryProjectId;
  const { projects } = await u.get<{ projects: { id: string }[] }>("/api/projects");
  expect(projects.map((p) => p.id)).not.toContain(libraryId);
  const { project } = await u.get<{ project: { seriesRole: string } }>(`/api/projects/${libraryId}`);
  expect(project.seriesRole).toBe("library");

  // The shared cast and world: a character with an approved reference image, a place, a fact, a style.
  const { character } = await u.post<{ character: { id: string; currentVersionId: string } }>(
    `/api/projects/${libraryId}/characters`,
    { name: "Woo Jin", role: "protagonist", description: { hair: "short black hair" }, aliases: ["WJ"] },
    201,
  );
  const g = await u.post<{ job: { id: string } }>(
    `/api/character-versions/${character.currentVersionId}/references/generate`,
    { kind: "portrait" },
    202,
  );
  await waitFor(
    async () =>
      (await u.get<{ job: { status: string } }>(`/api/generations/${g.job.id}`)).job.status === "completed" || null,
    { label: "portrait" },
  );
  const [ref] = await h.deps.db.execute<{ id: string; asset_id: string }>(
    sql`select id, asset_id from reference_assets where character_version_id = ${character.currentVersionId}`,
  );
  await u.post(`/api/references/${ref!.id}/status`, { status: "approved" });
  libChar = { id: character.id, versionId: character.currentVersionId, assetId: ref!.asset_id };
  await u.post(`/api/projects/${libraryId}/locations`, { name: "The Rooftop" }, 201);
  await u.post(
    `/api/projects/${libraryId}/bible/facts`,
    { kind: "place", subject: "the city", text: "Rain never stops in this city." },
    201,
  );
  await u.post(`/api/projects/${libraryId}/style`, { stylePresetKey: null, customDescription: "inky noir" }, 201);

  const d = await dash();
  expect(d.library).toMatchObject({ characters: 1, locations: 1, facts: 1 });
  expect(d.episodes).toEqual([]);
});

test("a new episode links the whole library, sharing its reference images rather than copying them", async () => {
  const r = await u.post<{ project: { id: string }; synced: { created: number; style: boolean; facts: number } }>(
    `/api/series/${seriesId}/episodes`,
    { title: "Episode one", story: { content: STORY, inputKind: "story" } },
    201,
  );
  ep1 = r.project.id;
  expect(r.synced).toMatchObject({ created: 2, style: true, facts: 1 });
  const [wj] = (await cast(ep1)).filter((c) => c.name === "Woo Jin");
  expect(wj).toMatchObject({ sourceId: libChar.id, syncedVersionId: libChar.versionId });
  const refs = [...(await refsOf(wj!.currentVersionId))];
  expect(refs).toEqual([{ asset_id: libChar.assetId, status: "approved", project_id: ep1 }]);
  const { project } = await u.get<{ project: { seriesId: string; episodeNumber: number; currentStyleId: string } }>(
    `/api/projects/${ep1}`,
  );
  expect(project).toMatchObject({ seriesId, episodeNumber: 1 });
  const [style] = await h.deps.db.execute<{ custom_description: string; source_id: string | null }>(
    sql`select custom_description, source_id from project_styles where id = ${project.currentStyleId}`,
  );
  expect(style).toMatchObject({ custom_description: "inky noir" });
  expect(style!.source_id).not.toBeNull();
  const [{ n: assetCopies }] = (await h.deps.db.execute<{ n: number }>(
    sql`select count(*)::int as n from assets where project_id = ${ep1}`,
  )) as unknown as [{ n: number }];
  expect(assetCopies).toBe(0);
  expect((await dash()).episodes[0]).toMatchObject({ id: ep1, episodeNumber: 1, behind: 0 });
}, 60_000);

test("library images: seen by the episode's members, not by anyone else", async () => {
  const [m] = await h.deps.db.execute<{ id: string }>(sql`select id from users where username = 'artist'`);
  await h.deps.db.insert(projectMembers).values({ projectId: ep1, userId: m!.id, role: "editor" });
  const cdn = (c: TestClient) => c.raw("GET", `/cdn/a/${libChar.assetId}`);
  expect((await cdn(member)).status).toBe(200);
  expect((await cdn(stranger)).status).toBe(404);
  // Only images the episode uses: another library image (a second portrait the episode never took) stays private.
  const g = await u.post<{ job: { id: string } }>(
    `/api/character-versions/${libChar.versionId}/references/generate`,
    { kind: "portrait" },
    202,
  );
  await waitFor(
    async () =>
      (await u.get<{ job: { status: string } }>(`/api/generations/${g.job.id}`)).job.status === "completed" || null,
    { label: "second portrait" },
  );
  const [extra] = await h.deps.db.execute<{ asset_id: string }>(
    sql`select asset_id from reference_assets where character_version_id = ${libChar.versionId} and asset_id <> ${libChar.assetId}`,
  );
  expect((await member.raw("GET", `/cdn/a/${extra!.asset_id}`)).status).toBe(404);
  expect((await u.raw("GET", `/cdn/a/${extra!.asset_id}`)).status).toBe(200);
  // Nor can it be trashed in the library while episodes use it.
  await u.post(`/api/assets/${libChar.assetId}/trash`, {}, 409);
  // The series itself stays its owner's.
  await member.get(`/api/series/${seriesId}`, 404);
  await stranger.get(`/api/series/${seriesId}`, 404);
});

test("a changed library entry shows as behind until synced, then follows", async () => {
  const { version } = await u.post<{ version: { id: string } }>(
    `/api/characters/${libChar.id}/versions`,
    { description: { hair: "long silver hair" }, changeNote: "time skip" },
    201,
  );
  // A new version is a draft until approved; approving makes it the library's current one.
  await u.post(`/api/character-versions/${version.id}/status`, { status: "approved" });
  await u.patch(
    `/api/bible-facts/${(await h.deps.db.execute<{ id: string }>(sql`select id from bible_facts where project_id = ${libraryId}`))[0]!.id}`,
    { text: "Rain never stops, except once." },
  );
  const d = await dash();
  expect(d.episodes[0]!.behind).toBe(2);
  expect(d.totals.behind).toBe(1);
  const { episodes } = await u.post<{ episodes: { updated: number; facts: number }[] }>(
    `/api/series/${seriesId}/sync`,
    {},
  );
  expect(episodes[0]).toMatchObject({ updated: 1, facts: 1 });
  const [wj] = (await cast(ep1)).filter((c) => c.name === "Woo Jin");
  expect(wj!.syncedVersionId).toBe(version.id);
  const [desc] = await h.deps.db.execute<{ hair: string }>(
    sql`select description->>'hair' as hair from character_versions where id = ${wj!.currentVersionId}`,
  );
  expect(desc!.hair).toBe("long silver hair");
  expect((await dash()).episodes[0]!.behind).toBe(0);
  // A second sync has nothing to do.
  const again = await u.post<{ episodes: { created: number; updated: number; facts: number }[] }>(
    `/api/series/${seriesId}/sync`,
    { projectId: ep1 },
  );
  expect(again.episodes[0]).toMatchObject({ created: 0, updated: 0, facts: 0 });
});

test("producing an episode keeps the linked cast, and every appearance is found across the series", async () => {
  await u.patch(`/api/projects/${ep1}`, { settings: { budgetUsd: 50 } });
  await u.post(`/api/projects/${ep1}/production-runs`, { reviewGates: false, render: false, youtube: false }, 201);
  await waitFor(
    async () => {
      const { runs } = await u.get<{ runs: { id: string; status: string }[] }>(`/api/projects/${ep1}/production-runs`);
      if (["completed", "completed_with_warnings"].includes(runs[0]!.status)) return true;
      await advanceRun(h.deps, runs[0]!.id);
      return null;
    },
    { label: "episode produced", timeoutMs: 180_000 },
  );
  // The analysis matched the linked Woo Jin by name instead of adding a second one.
  const woo = (await cast(ep1)).filter((c) => c.name === "Woo Jin");
  expect(woo.length).toBe(1);
  expect(woo[0]!.sourceId).toBe(libChar.id);
  const ap = await u.get<{ episodes: { projectId: string; panels: number; chapters: { panels: number }[] }[] }>(
    `/api/series/${seriesId}/appearances?kind=character&id=${libChar.id}`,
  );
  expect(ap.episodes.length).toBe(1);
  expect(ap.episodes[0]!.panels).toBeGreaterThan(0);
  expect(ap.episodes[0]!.chapters[0]!.panels).toBe(ap.episodes[0]!.panels);
  await u.get(`/api/series/${seriesId}/appearances?kind=character&id=${woo[0]!.id}`, 404);
}, 240_000);

test("adopting a project links its same-named cast; splitting a story makes numbered episodes", async () => {
  const { project } = await u.post<{ project: { id: string } }>("/api/projects", { title: "Old one" }, 201);
  await u.post(`/api/projects/${project.id}/characters`, { name: "woo jin", description: { hair: "brown" } }, 201);
  await u.post(`/api/projects/${project.id}/characters`, { name: "Mina" }, 201);
  const { synced } = await u.post<{ synced: { linked: number; created: number } }>(`/api/series/${seriesId}/adopt`, {
    projectId: project.id,
  });
  expect(synced).toMatchObject({ linked: 1, created: 1 });
  const adopted = await cast(project.id);
  expect(adopted.find((c) => c.name === "Woo Jin")!.sourceId).toBe(libChar.id);
  expect(adopted.find((c) => c.name === "Mina")!.sourceId).toBeNull();
  await u.post(`/api/series/${seriesId}/adopt`, { projectId: project.id }, 409);
  await u.post(`/api/series/${seriesId}/adopt`, { projectId: libraryId }, 409);

  const story = ["Chapter 1\nA.", "Chapter 2\nB.", "Chapter 3\nC.", "Chapter 4\nD."].join("\n\n");
  const preview = await u.post<{ episodes: { title: string; chapters: number }[] }>(`/api/series/${seriesId}/split`, {
    story,
    perEpisode: 2,
  });
  expect(preview.episodes).toEqual([
    { title: "Chapter 1 – Chapter 2", chapters: 2, characters: expect.any(Number) },
    { title: "Chapter 3 – Chapter 4", chapters: 2, characters: expect.any(Number) },
  ] as never);
  const made = await u.post<{ projectIds: string[] }>(
    `/api/series/${seriesId}/split`,
    { story, perEpisode: 2, confirm: true },
    201,
  );
  expect(made.projectIds.length).toBe(2);
  const d = await dash();
  expect(d.episodes.map((e) => e.episodeNumber)).toEqual([1, 2, 3, 4]);
}, 60_000);

test("MCP: a connection to all projects reads and runs series; one limited to some projects cannot", async () => {
  const call = await mcp(u, { projectAccess: "all", allowProjectCreate: true });
  const list = await call("list_series", {});
  expect((list.data!.series as { id: string }[]).map((s) => s.id)).toContain(seriesId);
  const got = await call("get_series", { seriesId });
  expect((got.data!.episodes as unknown[]).length).toBe(4);
  const ap = await call("get_series", { seriesId, appearances: { kind: "character", id: libChar.id } });
  expect((ap.data!.entry as { name: string }).name).toBe("Woo Jin");
  const synced = await call("manage_series", { action: "sync", seriesId });
  expect((synced.data!.episodes as unknown[]).length).toBe(4);
  const preview = await call("manage_series", { action: "split", seriesId, story: "Chapter 1\nA.\n\nChapter 2\nB." });
  expect((preview.data!.episodes as unknown[]).length).toBe(1);

  const limited = await mcp(u, { projectAccess: "selected", projectIds: [ep1], allowProjectCreate: false });
  expect((await limited("list_series", {})).error!.code).toBe("project_not_granted");
  expect((await limited("manage_series", { action: "sync", seriesId })).error!.code).toBe("project_not_granted");
}, 60_000);

test("detaching keeps an episode's cast as its own; a series with episodes cannot be deleted", async () => {
  await u.del(`/api/series/${seriesId}`, 409);
  await u.post(`/api/series/${seriesId}/episodes/${ep1}/detach`, {});
  const mine = await cast(ep1);
  expect(mine.find((c) => c.name === "Woo Jin")!.sourceId).toBeNull();
  const { project } = await u.get<{ project: { seriesId: string | null } }>(`/api/projects/${ep1}`);
  expect(project.seriesId).toBeNull();
  for (const e of (await dash()).episodes) await u.post(`/api/series/${seriesId}/episodes/${e.id}/detach`, {});
  await u.del(`/api/series/${seriesId}`);
  const [lib] = await h.deps.db.execute<{ deleted: boolean }>(
    sql`select deleted_at is not null as deleted from projects where id = ${libraryId}`,
  );
  expect(lib!.deleted).toBe(true);

  // Emptying it from the trash leaves the images episodes still use: they move to an episode instead.
  await u.del(`/api/projects/${libraryId}`);
  const [kept] = await h.deps.db.execute<{ project_id: string }>(
    sql`select project_id from assets where id = ${libChar.assetId}`,
  );
  expect(kept?.project_id).toBeTruthy();
  expect(kept!.project_id).not.toBe(libraryId);
  expect(
    await h.deps.assets.storage.exists(
      (
        await h.deps.db.execute<{ k: string }>(sql`select storage_key as k from assets where id = ${libChar.assetId}`)
      )[0]!.k,
    ),
  ).toBe(true);
  // The episode's copy of the first library version still has its reference row (it would have cascaded away).
  const [row] = await h.deps.db.execute<{ n: number }>(
    sql`select count(*)::int as n from reference_assets where project_id = ${ep1} and asset_id = ${libChar.assetId}`,
  );
  expect(row!.n).toBe(1);
});
