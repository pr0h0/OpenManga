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
