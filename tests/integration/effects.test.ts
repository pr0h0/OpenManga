import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, generationJobs } from "@openmanga/db";
import { sharp } from "@openmanga/image-utils";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let pageId: string;
let panelId: string;

const render = async () => {
  const r = await u.raw("GET", `/api/pages/${pageId}/render.png?width=400`);
  expect(r.status).toBe(200);
  return new Uint8Array(await r.arrayBuffer());
};
const mean = async (png: Uint8Array) => (await sharp(png).stats()).channels.slice(0, 3).map((c) => c.mean);

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "inker", email: "in@example.com", password: "inker-pass-123" }, 201);
  const projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Effects" }, 201)).project.id;
  const chapterId = (
    await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201)
  ).chapter.id;
  pageId = (
    await u.post<{ page: { id: string } }>(`/api/chapters/${chapterId}/pages`, { layoutTemplate: "full-page" }, 201)
  ).page.id;
  panelId = (await u.get<{ panels: { id: string }[] }>(`/api/pages/${pageId}`)).panels[0]!.id;
  const gen = await u.post<{ job: { id: string } }>(`/api/panels/${panelId}/generate`, {}, 202);
  await waitFor(
    async () => {
      const [j] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, gen.job.id));
      return j?.status === "completed" || null;
    },
    { label: "art", timeoutMs: 60_000 },
  );
}, 90_000);
afterAll(() => h?.stop());

test("effects are saved on the panel and drawn into the page render; removing them restores it", async () => {
  const plain = await render();
  await u.patch(`/api/panels/${panelId}`, {
    effects: [{ type: "speed", density: 1, strength: 1 }, { type: "flashback" }],
  });
  const { panel } = await u.get<{ panel: { effects: { type: string; angle: number }[] } }>(`/api/panels/${panelId}`);
  expect(panel.effects.map((e) => e.type)).toEqual(["speed", "flashback"]);
  // Filled from the defaults.
  expect(panel.effects[0]!.angle).toBe(0);
  const withFx = await render();
  expect(Buffer.from(withFx).equals(Buffer.from(plain))).toBe(false);
  // The flashback warms the picture: red over blue.
  const [r, , b] = await mean(withFx);
  expect(r!).toBeGreaterThan(b!);
  await u.patch(`/api/panels/${panelId}`, { effects: null });
  expect(Buffer.from(await render()).equals(Buffer.from(plain))).toBe(true);
  // At most six, of known kinds.
  await u.patch(`/api/panels/${panelId}`, { effects: Array.from({ length: 7 }, () => ({ type: "rain" })) }, 422);
  await u.patch(`/api/panels/${panelId}`, { effects: [{ type: "lasers" }] }, 422);
});
