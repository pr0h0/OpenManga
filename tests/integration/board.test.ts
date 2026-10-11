import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, referenceAssets } from "@openmanga/db";
import { sharp } from "@openmanga/image-utils";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let otherProject: string;

type Item = { id: string; assetId: string; note: string; described: { status: string; aspects: string[] } | null };
const board = async (p = projectId) => (await u.get<{ items: Item[] }>(`/api/projects/${p}/board`)).items;
const png = async (color: string) =>
  new Uint8Array(
    await sharp({ create: { width: 640, height: 480, channels: 3, background: color } })
      .png()
      .toBuffer(),
  );
const upload = async (color: string, note: string, p = projectId) => {
  const form = new FormData();
  form.set("file", new File([await png(color)], `${color}.png`, { type: "image/png" }));
  form.set("note", note);
  return (await u.json<{ item: { id: string; assetId: string } }>("POST", `/api/projects/${p}/board`, form, 201)).item;
};

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "boarder", email: "bo@example.com", password: "boarder-pass-1" }, 201);
  projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Mood" }, 201)).project.id;
  otherProject = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Other" }, 201)).project.id;
}, 60_000);
afterAll(() => h?.stop());

test("images are added, noted, reordered and taken off the board", async () => {
  const a = await upload("#224466", "night light");
  const b = await upload("#aa3311", "red coat");
  expect((await board()).map((i) => i.note)).toEqual(["night light", "red coat"]);
  await u.post(`/api/projects/${projectId}/board/order`, { ids: [b.id, a.id] });
  await u.patch(`/api/board-items/${a.id}`, { note: "blue night light" });
  expect((await board()).map((i) => i.note)).toEqual(["red coat", "blue night light"]);
  // An image already in the project, by its asset; another project's is refused.
  const again = await u.post<{ item: { id: string } }>(`/api/projects/${projectId}/board`, { assetId: a.assetId }, 201);
  const foreign = await upload("#000000", "x", otherProject);
  await u.post(`/api/projects/${projectId}/board`, { assetId: foreign.assetId }, 404);
  await u.del(`/api/board-items/${again.item.id}`);
  expect(await board()).toHaveLength(2);
  // Taken off the board, the image stays in the project.
  const asset = await h.deps.assets.get(a.assetId);
  expect(asset?.deletedAt).toBeNull();
});

test("dropped onto a character, an outfit, a location state, a prop and the style as draft references", async () => {
  const [coat, light] = await board();
  const ch = await u.post<{ character: { id: string; currentVersionId: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Mira", description: { hair: "black" } },
    201,
  );
  const outfit = (
    await u.post<{ outfit: { id: string } }>(`/api/characters/${ch.character.id}/outfits`, { name: "Red coat" }, 201)
  ).outfit.id;
  const loc = await u.post<{ location: { id: string } }>(
    `/api/projects/${projectId}/locations`,
    { name: "Harbour" },
    201,
  );
  const locVersion = (await u.get<{ versions: { id: string }[] }>(`/api/locations/${loc.location.id}`)).versions[0]!.id;
  const night = (
    await u.post<{ state: { id: string } }>(`/api/locations/${loc.location.id}/states`, { name: "at night" }, 201)
  ).state.id;
  const prop = await u.post<{ prop: { id: string } }>(`/api/projects/${projectId}/props`, { name: "Lantern" }, 201);
  const propVersion = (await u.get<{ versions: { id: string }[] }>(`/api/props/${prop.prop.id}`)).versions[0]!.id;
  await u.post(`/api/projects/${projectId}/style`, { stylePresetKey: null, customDescription: "ink wash" }, 201);
  const { currentStyleId } = await u.get<{ currentStyleId: string }>(`/api/projects/${projectId}/style`);

  const use = (id: string, b: Record<string, unknown>, status = 201) =>
    u.post<{ reference: typeof referenceAssets.$inferSelect }>(`/api/board-items/${id}/use`, b, status);
  const r1 = await use(coat!.id, { target: "character", versionId: ch.character.currentVersionId });
  expect(r1.reference).toMatchObject({ subjectType: "character", status: "draft", kind: "uploaded" });
  // Its own asset, so trashing the reference never takes the board image with it.
  expect(r1.reference.assetId).not.toBe(coat!.assetId);
  const r2 = await use(coat!.id, { target: "outfit", versionId: ch.character.currentVersionId, outfitId: outfit });
  expect(r2.reference).toMatchObject({ outfitId: outfit, kind: "outfit" });
  const r3 = await use(light!.id, { target: "location", versionId: locVersion, locationStateId: night });
  expect(r3.reference).toMatchObject({ locationStateId: night, locationVersionId: locVersion });
  await use(light!.id, { target: "prop", versionId: propVersion });
  await use(light!.id, { target: "style", styleId: currentStyleId });
  const refs = await h.deps.db.select().from(referenceAssets).where(eq(referenceAssets.projectId, projectId));
  expect(refs.map((r) => r.subjectType).sort()).toEqual(["character", "character", "location", "prop", "style"]);
  // Another project's version is refused.
  const otherCh = await u.post<{ character: { currentVersionId: string } }>(
    `/api/projects/${otherProject}/characters`,
    { name: "Elsewhere", description: {} },
    201,
  );
  await use(coat!.id, { target: "character", versionId: otherCh.character.currentVersionId }, 400);
});

test("as a panel's layout guide, and described for one aspect", async () => {
  const [coat] = await board();
  const chapterId = (
    await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201)
  ).chapter.id;
  const { page } = await u.post<{ page: { id: string } }>(
    `/api/chapters/${chapterId}/pages`,
    { layoutTemplate: "full-page" },
    201,
  );
  const panelId = (await u.get<{ panels: { id: string }[] }>(`/api/pages/${page.id}`)).panels[0]!.id;
  const r = await u.post<{ panel: { guide: { assetId: string; strength: string; pose: string } } }>(
    `/api/board-items/${coat!.id}/use`,
    {
      target: "guide",
      panelId,
      strength: "strict",
    },
  );
  expect(r.panel.guide).toEqual({ assetId: coat!.assetId, strength: "strict", pose: "" });
  await u.post(`/api/assets/${coat!.assetId}/describe`, { aspects: ["lighting"] }, 202);
  const described = await waitFor(
    async () => {
      const it = (await board()).find((i) => i.id === coat!.id)!;
      return it.described?.status === "completed" ? it.described : null;
    },
    { label: "description", timeoutMs: 60_000 },
  );
  expect(described.aspects).toEqual(["lighting"]);
}, 120_000);
