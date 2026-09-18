import { afterAll, beforeAll, expect, test } from "bun:test";
import { assets, eq, generationJobs } from "@openmanga/db";
import { mockImagePng } from "@openmanga/testing";
import { imageDescribe } from "../../apps/worker/src/handlers/text.ts";
import { startHarness, type TestClient } from "./harness.ts";

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
