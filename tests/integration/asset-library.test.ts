import { afterAll, beforeAll, expect, test } from "bun:test";
import { sharp } from "@openmanga/image-utils";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. "Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let panelId: string;
let active: string;
let older: string;

type Item = {
  id: string;
  type: string;
  tags: string[];
  collections: string[];
  favourite: boolean;
  model: string | null;
};
type Library = { assets: Item[]; facets: { tags: string[]; collections: string[]; models: string[] } };
const list = (q = "") => u.get<Library>(`/api/projects/${projectId}/assets?${q}`);
const ids = async (q = "") => (await list(q)).assets.map((a) => a.id);
const done = (id: string) =>
  waitFor(
    async () => {
      const r = await u.get<{ job: { status: string } }>(`/api/generations/${id}`);
      return ["completed", "failed"].includes(r.job.status) ? r.job : null;
    },
    { label: "job", timeoutMs: 60_000 },
  );

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "lib", email: "li@example.com", password: "lib-pass-12345" }, 201);
  projectId = (
    await u.post<{ project: { id: string } }>("/api/projects", { title: "Library", story: { content: STORY } }, 201)
  ).project.id;
  const { latest } = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${latest.id}/analyze`,
    {},
    202,
  );
  await done(a.job.id);
  await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
  const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
  await done((await u.post<{ job: { id: string } }>(`/api/chapters/${chapters[0]!.id}/plan`, {}, 202)).job.id);
  const { panels } = await u.get<{ panels: { id: string; characterVersionIds: string[] }[] }>(
    `/api/chapters/${chapters[0]!.id}/panels`,
  );
  panelId = panels.find((p) => p.characterVersionIds.length)!.id;
  // Drawn twice: the first version stays in its versions, unused.
  for (let i = 0; i < 2; i++)
    await done((await u.post<{ job: { id: string } }>(`/api/panels/${panelId}/generate`, {}, 202)).job.id);
  const panel = await u.get<{ panel: { activeArtworkAssetId: string } }>(`/api/panels/${panelId}`);
  active = panel.panel.activeArtworkAssetId;
  older = (await ids("type=panel_art")).find((id) => id !== active)!;
}, 180_000);
afterAll(() => h?.stop());

test("tags, collections and favourites file assets, and filter the library", async () => {
  await u.put(`/api/assets/${active}/marks`, { tags: ["rain", "night"], favourite: true });
  await u.put(`/api/assets/${active}/marks`, { collections: ["Cover ideas"] });
  const lib = await list();
  const a = lib.assets.find((x) => x.id === active)!;
  expect(a).toMatchObject({ tags: ["rain", "night"], collections: ["Cover ideas"], favourite: true });
  expect(lib.facets.tags).toEqual(["night", "rain"]);
  expect(await ids("tag=rain")).toEqual([active]);
  expect(await ids("favourite=1")).toEqual([active]);
  expect(await ids("collection=Cover%20ideas")).toEqual([active]);
  expect(await ids("q=nigh")).toEqual([active]);
});

test("by character, source, model and date; unused images and duplicate files", async () => {
  const { characters } = await u.get<{ characters: { id: string }[] }>(`/api/projects/${projectId}/characters`);
  const mine = await Promise.all(characters.map(async (c) => ids(`characterId=${c.id}`)));
  expect(mine.some((x) => x.includes(active))).toBe(true);
  const generated = await list("source=generated&type=panel_art");
  expect(generated.assets.map((x) => x.id).sort()).toEqual([active, older].sort());
  const model = generated.assets[0]!.model!;
  expect(generated.facets.models).toContain(model);
  expect((await ids(`model=${encodeURIComponent(model)}&type=panel_art`)).length).toBe(2);
  const today = new Date().toISOString().slice(0, 10);
  expect(await ids(`from=${today}&type=panel_art`)).toHaveLength(2);
  expect(await ids("to=2000-01-01")).toEqual([]);
  const unused = await ids("view=unused");
  expect(unused).toContain(older);
  expect(unused).not.toContain(active);
  // The same file uploaded twice.
  const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#123456" } })
    .png()
    .toBuffer();
  for (let i = 0; i < 2; i++) {
    const form = new FormData();
    form.set("file", new File([new Uint8Array(png)], "logo.png", { type: "image/png" }));
    await u.json("POST", `/api/projects/${projectId}/video-logo`, form, 201);
  }
  const dupes = await list("view=duplicates");
  expect(dupes.assets).toHaveLength(2);
  expect(await ids("source=uploaded")).toEqual(expect.arrayContaining(dupes.assets.map((x) => x.id)));
});

test("an asset's origin and uses; images like it", async () => {
  const d = await u.get<{
    source: { kind: string; job: { model: string | null } | null };
    usedBy: { kind: string; label: string }[];
    marks: { favourite: boolean };
  }>(`/api/assets/${active}`);
  expect(d.source.kind).toBe("generated");
  expect(d.source.job?.model).toBeTruthy();
  expect(d.usedBy.map((x) => x.kind)).toEqual(["panel"]);
  expect(d.usedBy[0]!.label).toMatch(/^Ch\. 1, page \d+, panel \d+$/);
  expect(d.marks.favourite).toBe(true);
  const like = await u.get<{ similar: { id: string; score: number }[] }>(`/api/assets/${active}/similar`);
  expect(like.similar.length).toBeGreaterThan(0);
  expect(like.similar.every((s) => s.score >= 0 && s.score <= 1)).toBe(true);
  expect(like.similar.map((s) => s.id)).toContain(older);
});

test("bulk actions; an active artwork is skipped when trashing, with the reason; marks follow a duplicate", async () => {
  const r = await u.post<{ done: number; skipped: { id: string; reason: string }[] }>(
    `/api/projects/${projectId}/assets/bulk`,
    { ids: [active, older], action: "tag", value: "draft" },
  );
  expect(r.done).toBe(2);
  expect(await ids("tag=draft")).toHaveLength(2);
  await u.post(`/api/projects/${projectId}/assets/bulk`, { ids: [active], action: "collect" }, 400);
  const t = await u.post<{ done: number; skipped: { id: string; reason: string }[] }>(
    `/api/projects/${projectId}/assets/bulk`,
    { ids: [active, older], action: "trash" },
  );
  expect(t.done).toBe(1);
  expect(t.skipped).toEqual([
    { id: active, reason: "This artwork is active on a panel. Activate another version first." },
  ]);
  expect(await ids("trash=1")).toEqual([older]);
  const copy = await u.post<{ project: { id: string } }>(`/api/projects/${projectId}/duplicate`, {}, 201);
  const theirs = await u.get<Library>(`/api/projects/${copy.project.id}/assets?favourite=1`);
  expect(theirs.assets).toHaveLength(1);
  expect(theirs.assets[0]!.tags).toEqual(["rain", "night", "draft"]);
});
