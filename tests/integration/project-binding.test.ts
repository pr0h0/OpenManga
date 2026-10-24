import { afterAll, beforeAll, expect, test } from "bun:test";
import { projectMembers, sql } from "@openmanga/db";
import { FakeYouTubeClient } from "../../packages/services/src/youtube-client.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

/** Ids in a request, and data shared between projects, stay with the project and person they belong to. */

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let mallory: TestClient;

async function reg(c: TestClient, u: string) {
  await c.post("/api/auth/register", { username: u, email: `${u}@example.com`, password: `${u}-pass-1234` }, 201);
  return (await c.get<{ user: { id: string } }>("/api/auth/me")).user.id;
}

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  mallory = h.client();
  await reg(alice, "bindalice");
  await reg(mallory, "bindmallory");
});
afterAll(() => h?.stop());

async function projectWithPage(c: TestClient, title: string) {
  const { project } = await c.post<{ project: { id: string } }>("/api/projects", { title }, 201);
  const { chapter } = await c.post<{ chapter: { id: string } }>(`/api/projects/${project.id}/chapters`, { title }, 201);
  const { scene } = await c.post<{ scene: { id: string } }>(`/api/chapters/${chapter.id}/scenes`, { title }, 201);
  const { page } = await c.post<{ page: { id: string } }>(`/api/chapters/${chapter.id}/pages`, {}, 201);
  const doc = await c.get<{ panels: { id: string }[] }>(`/api/pages/${page.id}`);
  const { character } = await c.post<{ character: { id: string } }>(
    `/api/projects/${project.id}/characters`,
    { name: `${title} lead` },
    201,
  );
  return { project, chapter, scene, page, panel: doc.panels[0]!, character };
}

test("scene, panel and character ids from another project are refused", async () => {
  const v = await projectWithPage(alice, "Victim");
  const m = await projectWithPage(mallory, "Mine");
  await mallory.post(`/api/chapters/${m.chapter.id}/pages`, { sceneId: v.scene.id }, 400);
  await mallory.patch(`/api/pages/${m.page.id}`, { sceneId: v.scene.id }, 400);
  await mallory.patch(`/api/panels/${m.panel.id}`, { sceneId: v.scene.id }, 400);
  await mallory.post(`/api/pages/${m.page.id}/dialogue`, { text: "hi", characterId: v.character.id }, 400);
  await mallory.post(`/api/pages/${m.page.id}/dialogue`, { text: "hi", panelId: v.panel.id }, 400);
  await mallory.post(`/api/pages/${m.page.id}/sfx`, { text: "BOOM", panelId: v.panel.id }, 400);
  const { dialogue } = await mallory.post<{ dialogue: { id: string } }>(
    `/api/pages/${m.page.id}/dialogue`,
    { text: "ok", characterId: m.character.id, panelId: m.panel.id },
    201,
  );
  await mallory.patch(`/api/dialogue/${dialogue.id}`, { characterId: v.character.id }, 400);
  await mallory.patch(
    `/api/pages/${m.page.id}/document`,
    { dialogue: [{ id: dialogue.id, panelId: v.panel.id }] },
    400,
  );
  // The project's own ids still work.
  await mallory.patch(`/api/panels/${m.panel.id}`, { sceneId: m.scene.id });
});

test("a scene id stored before the check never brings another project's scene into a prompt", async () => {
  const v = await projectWithPage(alice, "Old victim");
  await alice.patch(`/api/scenes/${v.scene.id}`, { title: "Old victim", summary: "VICTIM-SECRET-SUMMARY" });
  const m = await projectWithPage(mallory, "Old mine");
  await h.deps.db.execute(sql`update panels set scene_id = ${v.scene.id} where id = ${m.panel.id}`);
  const pv = await mallory.get<{ compiledPrompt: string }>(`/api/panels/${m.panel.id}/prompt-preview`);
  expect(pv.compiledPrompt).not.toContain("VICTIM-SECRET-SUMMARY");
});

test("a copy of a series episode is not an episode; the public page and sync leave it out", async () => {
  const seriesId = (await alice.post<{ series: { id: string } }>("/api/series", { title: "Bound" }, 201)).series.id;
  const ep = (await alice.post<{ project: { id: string } }>(`/api/series/${seriesId}/episodes`, { title: "E1" }, 201))
    .project.id;
  await alice.patch(`/api/series/${seriesId}`, { visibility: "public", publicSlug: "bound-series" });
  await alice.post(`/api/projects/${ep}/invites`, { identifier: "bindmallory", role: "editor" }, 201);
  const { invites } = await mallory.get<{ invites: { id: string; projectId: string }[] }>("/api/invites");
  await mallory.post(`/api/invites/${invites.find((i) => i.projectId === ep)!.id}/accept`, {}, 200);
  const copy = (
    await mallory.post<{ project: { id: string; seriesId: string | null } }>(`/api/projects/${ep}/duplicate`, {}, 201)
  ).project;
  expect(copy.seriesId).toBeNull();
  // Even a copy linked the old way stays off the owner's page and out of the library sync.
  await h.deps.db.execute(
    sql`update projects set series_id = ${seriesId}, series_role = 'episode', episode_number = 2 where id = ${copy.id}`,
  );
  const ch = (
    await mallory.post<{ chapter: { id: string } }>(`/api/projects/${copy.id}/chapters`, { title: "INJECTED" }, 201)
  ).chapter.id;
  await mallory.patch(`/api/chapters/${ch}`, { publishAt: new Date(Date.now() - 60_000).toISOString() });
  const pub = await h.client().get<{ episodes: { id: string }[] }>("/api/public/series/bound-series");
  expect(JSON.stringify(pub)).not.toContain("INJECTED");
  const synced = await alice.post<{ episodes: { projectId: string }[] }>(`/api/series/${seriesId}/sync`, {});
  expect(synced.episodes.map((e) => e.projectId)).not.toContain(copy.id);
});

test("removing a shared library image from an episode leaves the library's file alone", async () => {
  const { series } = await alice.post<{ series: { id: string; libraryProjectId: string } }>(
    "/api/series",
    { title: "Lib" },
    201,
  );
  const lib = series.libraryProjectId;
  const { character } = await alice.post<{ character: { id: string; currentVersionId: string } }>(
    `/api/projects/${lib}/characters`,
    { name: "Hero" },
    201,
  );
  const g = await alice.post<{ job: { id: string } }>(
    `/api/character-versions/${character.currentVersionId}/references/generate`,
    { kind: "portrait" },
    202,
  );
  await waitFor(
    async () =>
      (await alice.get<{ job: { status: string } }>(`/api/generations/${g.job.id}`)).job.status === "completed" || null,
    { label: "portrait" },
  );
  const [libRef] = await h.deps.db.execute<{ id: string; asset_id: string }>(
    sql`select id, asset_id from reference_assets where character_version_id = ${character.currentVersionId}`,
  );
  await alice.post(`/api/references/${libRef!.id}/status`, { status: "approved" });
  const { project: ep } = await alice.post<{ project: { id: string } }>(
    `/api/series/${series.id}/episodes`,
    { title: "Ep" },
    201,
  );
  const [m] = await h.deps.db.execute<{ id: string }>(sql`select id from users where username = 'bindmallory'`);
  await h.deps.db.insert(projectMembers).values({ projectId: ep.id, userId: m!.id, role: "editor" });
  const [epRef] = await h.deps.db.execute<{ id: string }>(
    sql`select id from reference_assets where project_id = ${ep.id} and asset_id = ${libRef!.asset_id}`,
  );
  await mallory.post(`/api/references/${epRef!.id}/status`, { status: "superseded" });
  await mallory.del(`/api/references/${epRef!.id}`);
  const [a] = await h.deps.db.execute<{ deleted_at: string | null; status: string }>(
    sql`select deleted_at, status from assets where id = ${libRef!.asset_id}`,
  );
  expect(a!.deleted_at).toBeNull();
  expect(a!.status).toBe("approved");
});

test("a video linked by someone else shows only counters read without the channel owner's authorization", async () => {
  const { url } = await alice.post<{ url: string }>("/api/youtube/connect", {});
  const consent = new URL(url);
  const allow = await alice.raw(
    "GET",
    `/api/youtube/fake-consent?state=${consent.searchParams.get("state")}&channel=Bound`,
  );
  const cb = new URL(allow.headers.get("location")!);
  await alice.raw("GET", `${cb.pathname}${cb.search}`);
  const video = `${FakeYouTubeClient.prefix("Bound")}001`;
  const ap = (await alice.post<{ project: { id: string } }>("/api/projects", { title: "YA" }, 201)).project.id;
  await alice.post(`/api/projects/${ap}/youtube/links`, { video }, 201);
  // Alice's authorized snapshot from 40 days ago: hers to see, not Mallory's.
  await h.deps.db.execute(
    sql`update youtube_snapshots set taken_at = now() - interval '40 days' where video_id = ${video}`,
  );
  await h.deps.db.execute(sql`insert into youtube_snapshots (video_id, taken_at, views, likes, comments, connection_id, authorized)
    select video_id, taken_at + interval '1 day', views + 7, likes, comments, connection_id, authorized
    from youtube_snapshots where video_id = ${video}`);
  const mp = (await mallory.post<{ project: { id: string } }>("/api/projects", { title: "YM" }, 201)).project.id;
  const ml = await mallory.post<{ link: { id: string; connectionId: string | null } }>(
    `/api/projects/${mp}/youtube/links`,
    { video },
    201,
  );
  expect(ml.link.connectionId).toBeNull();
  const hist = await mallory.get<{ daily: { day: string }[] }>(
    `/api/projects/${mp}/youtube/links/${ml.link.id}/history`,
  );
  const oldest = hist.daily[0] ? Date.parse(hist.daily[0].day) : Date.now();
  expect(Date.now() - oldest).toBeLessThan(31 * 86_400_000);
});
