import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, generationInputs, generationJobs } from "@openmanga/db";
import { sharp } from "@openmanga/image-utils";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let panelId: string;

type Version = { assetId: string; width: number; height: number; operation: string | null };
const versions = async () => (await u.get<{ versions: Version[] }>(`/api/panels/${panelId}/versions`)).versions;
const active = async () =>
  (
    await u.get<{ panel: { activeArtworkAssetId: string; guide: { assetId: string } | null } }>(
      `/api/panels/${panelId}`,
    )
  ).panel;
const done = (jobId: string) =>
  waitFor(
    async () => {
      const [j] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
      return j?.status === "completed" || j?.status === "failed" ? j : null;
    },
    { label: "job", timeoutMs: 60_000 },
  );

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post(
    "/api/auth/register",
    { username: "toolsmith", email: "ts@example.com", password: "toolsmith-pass1" },
    201,
  );
  projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Tools" }, 201)).project.id;
  const chapterId = (
    await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201)
  ).chapter.id;
  const { page } = await u.post<{ page: { id: string } }>(
    `/api/chapters/${chapterId}/pages`,
    { layoutTemplate: "two-horizontal" },
    201,
  );
  panelId = (await u.get<{ panels: { id: string }[] }>(`/api/pages/${page.id}`)).panels[0]!.id;
}, 60_000);
afterAll(() => h?.stop());

test("no artwork, no tools; then quick tools each make a new active version", async () => {
  await u.post(`/api/panels/${panelId}/tools`, { tool: "upscale" }, 409);
  const gen = await u.post<{ job: { id: string } }>(`/api/panels/${panelId}/generate`, {}, 202);
  expect((await done(gen.job.id)).status).toBe("completed");
  const first = (await versions())[0]!;

  const up = await u.post<{ asset: { id: string; width: number } }>(
    `/api/panels/${panelId}/tools`,
    { tool: "upscale" },
    201,
  );
  expect(up.asset.width).toBe(first.width * 2);
  expect((await active()).activeArtworkAssetId).toBe(up.asset.id);
  await u.post(`/api/panels/${panelId}/tools`, { tool: "lineart" }, 201);
  // A palette from another project image (a board upload).
  const form = new FormData();
  const warm = await sharp({ create: { width: 64, height: 64, channels: 3, background: "#c04020" } })
    .png()
    .toBuffer();
  form.set("file", new File([new Uint8Array(warm)], "warm.png", { type: "image/png" }));
  const { item } = await u.json<{ item: { assetId: string } }>("POST", `/api/projects/${projectId}/board`, form, 201);
  await u.post(`/api/panels/${panelId}/tools`, { tool: "palette", paletteAssetId: item.assetId }, 201);
  const ops = (await versions()).map((v) => v.operation);
  expect(ops.slice(0, 3)).toEqual(["palette", "lineart", "upscale"]);
  // Every earlier version is still there.
  expect((await versions()).map((v) => v.assetId)).toContain(first.assetId);
}, 120_000);

test("AI tools are masked edits: the whole picture, or a wider canvas for outpainting", async () => {
  const r = await u.post<{ job: { id: string } }>(
    `/api/panels/${panelId}/tools`,
    { tool: "relight", light: "cold moonlight from above" },
    202,
  );
  const j = await done(r.job.id);
  expect(j.status).toBe("completed");
  expect(j.kind).toBe("panel_edit");
  expect(j.compiledPrompt).toContain("Relight the whole image: cold moonlight from above.");
  expect((await versions())[0]!.operation).toBe("relight");

  const before = (await versions())[0]!;
  const o = await u.post<{ job: { id: string } }>(
    `/api/panels/${panelId}/tools`,
    { tool: "outpaint", aspect: "9:16" },
    202,
  );
  expect((await done(o.job.id)).status).toBe("completed");
  const inputs = await h.deps.db.select().from(generationInputs).where(eq(generationInputs.jobId, o.job.id));
  const target = inputs.find((i) => i.role === "target")!;
  // The target is the extended canvas: as wide as the picture, taller, 9:16.
  expect(target.width).toBe(before.width);
  expect(Math.abs(target.width! / target.height! - 9 / 16)).toBeLessThan(0.01);
  await u.post(`/api/panels/${panelId}/tools`, { tool: "expression", character: "Mira", expression: "x" }, 422);
}, 120_000);

test("guide tools tidy the layout guide; a locked panel is refused", async () => {
  await u.post(`/api/panels/${panelId}/guide/tools`, { tool: "clean" }, 409);
  const { items } = await u.get<{ items: { id: string; assetId: string }[] }>(`/api/projects/${projectId}/board`);
  await u.post(`/api/board-items/${items[0]!.id}/use`, { target: "guide", panelId });
  await u.post(`/api/panels/${panelId}/guide/tools`, { tool: "clean" }, 201);
  const g = (await active()).guide!;
  expect(g.assetId).not.toBe(items[0]!.assetId);
  await u.patch(`/api/panels/${panelId}`, { approvalStatus: "locked" });
  await u.post(`/api/panels/${panelId}/tools`, { tool: "upscale" }, 409);
});
