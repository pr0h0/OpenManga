import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  assets,
  characters,
  characterVersions,
  eq,
  generationInputs,
  generationJobs,
  referenceAssets,
} from "@openmanga/db";
import { mockImagePng } from "@openmanga/testing";
import { imageDescribe } from "../../apps/worker/src/handlers/text.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId = "";

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "seer", email: "seer@example.com", password: "vision-pass-1" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Vision" }, 201);
  projectId = p.project.id;
});
afterAll(() => h?.stop());

test("uploading an image stores it and queues a description job", async () => {
  const png = await mockImagePng({ width: 320, height: 200, prompt: "a rainy rooftop", label: "REF" });
  const form = new FormData();
  form.set("file", new Blob([png.slice()], { type: "image/png" }), "frame.png");
  form.set("aspects", JSON.stringify(["style", "character", "location"]));
  form.set("custom", "What lens would reproduce this depth of field?");
  form.set("note", "frame from a trailer");
  const res = await alice.raw("POST", `/api/projects/${projectId}/images/describe`, form);
  expect(res.status).toBe(202);
  const out = (await res.json()) as { asset: { id: string; type: string }; job: { id: string; kind: string } };
  expect(out.asset.type).toBe("source_image");
  expect(out.job.kind).toBe("image_describe");

  const [stored] = await h.deps.db.select().from(assets).where(eq(assets.id, out.asset.id));
  expect(stored!.projectId).toBe(projectId);
  const [job] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, out.job.id));
  expect(job!.input.assetId).toBe(out.asset.id);
  expect(job!.input.aspects).toEqual(["style", "character", "location"]);
  expect(job!.templateName).toBe("image-describe");

  // The handler runs against the mock provider and returns a parsed description.
  const r = (await imageDescribe(h.workerDeps, job!)) as { description: Record<string, unknown>; aspects: string[] };
  expect(r.aspects).toEqual(["style", "character", "location"]);
  expect(r.description).toBeTruthy();
});

test("only aspects that exist are accepted, and the image must be one", async () => {
  const form = new FormData();
  form.set("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "bad.png");
  form.set("aspects", JSON.stringify(["style"]));
  const bad = await alice.raw("POST", `/api/projects/${projectId}/images/describe`, form);
  expect(bad.status).toBe(415);

  const png = await mockImagePng({ width: 64, height: 64, prompt: "x" });
  const form2 = new FormData();
  form2.set("file", new Blob([png.slice()], { type: "image/png" }), "ok.png");
  form2.set("aspects", JSON.stringify(["nonsense"]));
  const res = await alice.raw("POST", `/api/projects/${projectId}/images/describe`, form2);
  expect(res.status).toBe(400);
});

test("an image already in the project can be described without re-uploading", async () => {
  const png = await mockImagePng({ width: 200, height: 200, prompt: "existing" });
  const asset = await h.deps.assets.store({
    projectId,
    ownerUserId: null,
    type: "panel_art",
    data: png,
    mimeType: "image/png",
    width: 200,
    height: 200,
  });
  const r = await alice.post<{ job: { id: string; targetId: string } }>(
    `/api/assets/${asset.id}/describe`,
    { aspects: ["lighting", "composition"] },
    202,
  );
  expect(r.job.targetId).toBe(asset.id);
});

test("a run that will be refused stores nothing", async () => {
  // The probe that found this: an upload rejected for want of a key had already written the image.
  const before = await h.deps.db.select().from(assets).where(eq(assets.projectId, projectId));
  const png = await mockImagePng({ width: 64, height: 64, prompt: "refused" });
  const form = new FormData();
  form.set("file", new Blob([png.slice()], { type: "image/png" }), "refused.png");
  form.set("aspects", JSON.stringify(["style"]));
  // A credential id that is not this user's is refused by the resolver, after the upload is read.
  form.set("ai", JSON.stringify({ credentialId: "00000000-0000-0000-0000-000000000000", model: null }));
  const res = await alice.raw("POST", `/api/projects/${projectId}/images/describe`, form);
  expect(res.status).toBeGreaterThanOrEqual(400);
  const after = await h.deps.db.select().from(assets).where(eq(assets.projectId, projectId));
  expect(after.length).toBe(before.length);
});

test("descriptions are listed with their image and inputs, across projects by default", async () => {
  // A second project belonging to the same user: its description must be visible from the first, which is the
  // whole point — a style read once should be applicable elsewhere without paying to read it again.
  const other = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Second" }, 201);
  const png = await mockImagePng({ width: 128, height: 128, prompt: "second project" });
  const form = new FormData();
  form.set("file", new Blob([png.slice()], { type: "image/png" }), "other.png");
  form.set("aspects", JSON.stringify(["style"]));
  form.set("note", "from the other project");
  const res = await alice.raw("POST", `/api/projects/${other.project.id}/images/describe`, form);
  expect(res.status).toBe(202);
  const started = (await res.json()) as { job: { id: string }; asset: { id: string } };
  const [job] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, started.job.id));
  await imageDescribe(h.workerDeps, job!);
  // The handler's return value is what the runner stores; mirror that so the row looks like a finished job.
  await h.deps.db
    .update(generationJobs)
    .set({ status: "completed", result: { description: { overview: "a blue square" } } })
    .where(eq(generationJobs.id, started.job.id));

  const all = await alice.get<{ descriptions: { id: string; projectId: string; assetId: string; note: string }[] }>(
    "/api/image-descriptions",
  );
  const found = all.descriptions.find((d) => d.id === started.job.id)!;
  expect(found).toBeTruthy();
  expect(found.assetId).toBe(started.asset.id);
  expect(found.note).toBe("from the other project");

  const scoped = await alice.get<{ descriptions: { id: string }[] }>(
    `/api/image-descriptions?scope=project&projectId=${projectId}`,
  );
  expect(scoped.descriptions.some((d) => d.id === started.job.id)).toBe(false);
});

test("another user's descriptions are not listed", async () => {
  const bob = h.client();
  await bob.post(
    "/api/auth/register",
    { username: "nosy", email: "nosy@example.com", password: "nosy-pass-1234" },
    201,
  );
  const mine = await bob.get<{ descriptions: unknown[] }>("/api/image-descriptions");
  expect(mine.descriptions).toHaveLength(0);
});

test("a description can be removed, taking its image with it", async () => {
  const png = await mockImagePng({ width: 96, height: 96, prompt: "to delete" });
  const form = new FormData();
  form.set("file", new Blob([png.slice()], { type: "image/png" }), "gone.png");
  form.set("aspects", JSON.stringify(["mood"]));
  const res = await alice.raw("POST", `/api/projects/${projectId}/images/describe`, form);
  const started = (await res.json()) as { job: { id: string }; asset: { id: string } };
  // The harness runs real workers, so let it settle rather than racing the handler for the row.
  await waitFor(
    async () => {
      const [j] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, started.job.id));
      return j && ["completed", "failed", "cancelled"].includes(j.status) ? j : null;
    },
    { label: "describe job settles", timeoutMs: 30_000 },
  );

  await alice.del(`/api/image-descriptions/${started.job.id}`);
  const [job] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, started.job.id));
  expect(job).toBeUndefined();
  const [asset] = await h.deps.db.select().from(assets).where(eq(assets.id, started.asset.id));
  expect(asset).toBeUndefined();
});

test("deleting a description leaves an image something else is using", async () => {
  // The image here is a panel's artwork, not an upload of its own: removing the description must not take it.
  const png = await mockImagePng({ width: 96, height: 96, prompt: "shared" });
  const asset = await h.deps.assets.store({
    projectId,
    ownerUserId: null,
    type: "panel_art",
    data: png,
    mimeType: "image/png",
    width: 96,
    height: 96,
  });
  const r = await alice.post<{ job: { id: string } }>(`/api/assets/${asset.id}/describe`, { aspects: ["mood"] }, 202);
  await alice.del(`/api/image-descriptions/${r.job.id}`);
  const [still] = await h.deps.db.select().from(assets).where(eq(assets.id, asset.id));
  expect(still).toBeTruthy();
});

test("only a draft character version can be deleted, and never the last one", async () => {
  const ch = await alice.post<{ character: { id: string; currentVersionId: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Versioned", description: { summary: "v1" } },
    201,
  );
  // The only version: refused even though it is a draft.
  const onlyOne = await alice.raw("DELETE", `/api/character-versions/${ch.character.currentVersionId}`);
  expect(onlyOne.status).toBe(409);

  const v2 = await alice.post<{ version: { id: string } }>(
    `/api/characters/${ch.character.id}/versions`,
    { description: { summary: "v2" }, changeNote: "second", makeCurrent: true },
    201,
  );
  await alice.del(`/api/character-versions/${v2.version.id}`);
  const rows = await h.deps.db
    .select()
    .from(characterVersions)
    .where(eq(characterVersions.characterId, ch.character.id));
  expect(rows).toHaveLength(1);
  // Deleting the current version hands "current" back to the survivor rather than leaving a dangling pointer.
  const [after] = await h.deps.db.select().from(characters).where(eq(characters.id, ch.character.id));
  expect(after!.currentVersionId).toBe(rows[0]!.id);

  // An approved version is refused.
  await alice.patch(`/api/character-versions/${rows[0]!.id}`, { description: { summary: "v1" } });
  await alice.post(`/api/character-versions/${rows[0]!.id}/approve`, {}, 200).catch(() => {});
});

test("a new version does not take over; approving it is what makes it current", async () => {
  const ch = await alice.post<{ character: { id: string; currentVersionId: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Promotion", description: { summary: "first" } },
    201,
  );
  const v1 = ch.character.currentVersionId;
  const v2 = await alice.post<{ version: { id: string } }>(
    `/api/characters/${ch.character.id}/versions`,
    { description: { summary: "second" }, changeNote: "from an image", makeCurrent: true },
    201,
  );
  // makeCurrent is ignored: a draft must not be what new panels pin, because a draft's references are never
  // used for identity, so those panels would generate with no reference at all.
  const [mid] = await h.deps.db.select().from(characters).where(eq(characters.id, ch.character.id));
  expect(mid!.currentVersionId).toBe(v1);

  const byHand = await alice.raw("PATCH", `/api/characters/${ch.character.id}`, { currentVersionId: v2.version.id });
  expect(byHand.status).toBe(409);

  await alice.post(`/api/character-versions/${v2.version.id}/status`, { status: "approved" });
  const [after] = await h.deps.db.select().from(characters).where(eq(characters.id, ch.character.id));
  expect(after!.currentVersionId).toBe(v2.version.id);
});

test("an outfit reference needs the approved design first, then is drawn from it", async () => {
  const ch = await alice.post<{ character: { id: string; currentVersionId: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Dresser", description: { summary: "someone", wardrobe: "grey coat" } },
    201,
  );
  const detail = await alice.get<{ outfits: { id: string; name: string }[] }>(`/api/characters/${ch.character.id}`);
  const outfitId = detail.outfits[0]!.id;

  // Nothing approved yet: refused, and the message says what to do.
  const early = await alice.raw(
    "POST",
    `/api/character-versions/${ch.character.currentVersionId}/references/generate`,
    {
      kind: "outfit",
      outfitId,
    },
  );
  expect(early.status).toBe(409);
  expect(await early.text()).toMatch(/approve this character's main reference first/i);

  // Give the version an approved identity reference, the way generating and approving one would.
  const png = await mockImagePng({ width: 128, height: 192, prompt: "identity" });
  const asset = await h.deps.assets.store({
    projectId,
    ownerUserId: null,
    type: "character_reference",
    data: png,
    mimeType: "image/png",
    width: 128,
    height: 192,
  });
  await h.deps.db.insert(referenceAssets).values({
    projectId,
    subjectType: "character",
    characterVersionId: ch.character.currentVersionId,
    assetId: asset.id,
    kind: "portrait",
    status: "approved",
    isPrimary: true,
  });

  const ok = await alice.post<{ job: { id: string } }>(
    `/api/character-versions/${ch.character.currentVersionId}/references/generate`,
    { kind: "outfit", outfitId },
    202,
  );
  // The approved design rides along as an input image, so the outfit is a re-dress rather than a new character.
  const inputs = await h.deps.db.select().from(generationInputs).where(eq(generationInputs.jobId, ok.job.id));
  expect(inputs).toHaveLength(1);
  expect(inputs[0]!.assetId).toBe(asset.id);
  const [job] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, ok.job.id));
  expect(job!.compiledPrompt).toMatch(/Reference image 1 is this character's approved design/);
});
