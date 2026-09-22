import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, panels } from "@openmanga/db";
import { mockImagePng } from "@openmanga/testing";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let panelIds: string[];

const png = async (label: string) => await mockImagePng({ width: 64, height: 64, prompt: label });
const form = (data: Uint8Array, name = "art.png", type = "image/png") => {
  const f = new FormData();
  f.set("file", new File([data as BlobPart], name, { type }));
  return f;
};
type Uploaded = {
  asset: { id: string; width: number; height: number };
  activeAssetId: string;
  versions: { assetId: string; kind: string | null; versionNumber: number }[];
};

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "uploader", email: "up@example.com", password: "upload-pass-12" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Brought My Own" }, 201);
  projectId = p.project.id;
  const ch = await alice.post<{ chapter: { id: string } }>(
    `/api/projects/${projectId}/chapters`,
    { title: "One" },
    201,
  );
  const page = await alice.post<{ page: { id: string } }>(
    `/api/chapters/${ch.chapter.id}/pages`,
    { layoutTemplate: "four-grid" },
    201,
  );
  const doc = await alice.get<{ panels: { id: string }[] }>(`/api/pages/${page.page.id}`);
  panelIds = doc.panels.map((x) => x.id);
});
afterAll(() => h?.stop());

test("an uploaded image becomes the panel's artwork, with no provider key involved", async () => {
  const res = await alice.raw("POST", `/api/panels/${panelIds[0]}/artwork/upload`, form(await png("mine")));
  expect(res.status).toBe(201);
  const out = (await res.json()) as Uploaded;
  expect(out.asset.width).toBe(64);
  expect(out.activeAssetId).toBe(out.asset.id);

  // The panel points at it exactly as it would at generated art: same column, same "ready" status.
  const [row] = await h.deps.db.select().from(panels).where(eq(panels.id, panelIds[0]!));
  expect(row!.activeArtworkAssetId).toBe(out.asset.id);
  expect(row!.status).toBe("ready");

  // It shows up in the ordinary version history, with no generation job behind it.
  expect(out.versions).toHaveLength(1);
  expect(out.versions[0]!.assetId).toBe(out.asset.id);
  expect(out.versions[0]!.kind).toBeNull();
});

test("a second upload supersedes the first, and the first can be activated again", async () => {
  const first = await h.deps.db.select().from(panels).where(eq(panels.id, panelIds[0]!));
  const firstAssetId = first[0]!.activeArtworkAssetId!;

  const res = await alice.raw("POST", `/api/panels/${panelIds[0]}/artwork/upload`, form(await png("second")));
  const out = (await res.json()) as Uploaded;
  expect(out.versions).toHaveLength(2);
  expect(out.activeAssetId).not.toBe(firstAssetId);

  // Uploaded versions are ordinary versions: the existing activate route moves between them.
  await alice.post(`/api/panels/${panelIds[0]}/versions/${firstAssetId}/activate`);
  const [row] = await h.deps.db.select().from(panels).where(eq(panels.id, panelIds[0]!));
  expect(row!.activeArtworkAssetId).toBe(firstAssetId);
});

test("the page renders the uploaded artwork", async () => {
  // The point of uploading is that everything downstream treats it as artwork, so render the page and check it
  // produced real pixels rather than an empty frame.
  const [row] = await h.deps.db.select().from(panels).where(eq(panels.id, panelIds[0]!));
  const res = await alice.raw("GET", `/api/pages/${row!.pageId}/render.png?width=400`);
  expect(res.status).toBe(200);
  expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
});

test("a locked panel refuses an upload, and a non-image is refused as unsupported", async () => {
  await h.deps.db.update(panels).set({ approvalStatus: "locked" }).where(eq(panels.id, panelIds[1]!));
  const locked = await alice.raw("POST", `/api/panels/${panelIds[1]}/artwork/upload`, form(await png("nope")));
  expect(locked.status).toBe(409);

  const notAnImage = new FormData();
  notAnImage.set("file", new File(["this is not a png"], "notes.txt", { type: "text/plain" }));
  const refused = await alice.raw("POST", `/api/panels/${panelIds[2]}/artwork/upload`, notAnImage);
  expect(refused.status).toBe(415);
});
