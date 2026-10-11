import { afterAll, beforeAll, expect, test } from "bun:test";
import { assetFeatures } from "@openmanga/db";
import { sharp } from "@openmanga/image-utils";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
const panelIds: string[] = [];

const scene = async (bg: string, figure: "circle" | "bars", fg: string) => {
  const shape =
    figure === "circle"
      ? `<circle cx="200" cy="150" r="70" fill="${fg}"/>`
      : `<rect x="140" y="70" width="40" height="160" fill="${fg}"/><rect x="220" y="70" width="40" height="160" fill="${fg}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="${bg}"/>${shape}</svg>`;
  return new Uint8Array(await sharp(Buffer.from(svg)).png().toBuffer());
};
const upload = async (panelId: string, png: Uint8Array) => {
  const form = new FormData();
  form.set("file", new File([Buffer.from(png)], "art.png", { type: "image/png" }));
  await u.json("POST", `/api/panels/${panelId}/artwork/upload`, form, 201);
};

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "twins", email: "tw@example.com", password: "twins-pass-123" }, 201);
  projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Repeats" }, 201)).project.id;
  const chapterId = (
    await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201)
  ).chapter.id;
  // Two scenes, three pages of two panels.
  const scenes: string[] = [];
  for (const title of ["Harbour", "Tower"])
    scenes.push(
      (await u.post<{ scene: { id: string } }>(`/api/chapters/${chapterId}/scenes`, { title }, 201)).scene.id,
    );
  for (const sceneId of [scenes[0], scenes[0], scenes[1]]) {
    const { page } = await u.post<{ page: { id: string } }>(
      `/api/chapters/${chapterId}/pages`,
      { layoutTemplate: "two-horizontal", sceneId },
      201,
    );
    panelIds.push(...(await u.get<{ panels: { id: string }[] }>(`/api/pages/${page.id}`)).panels.map((p) => p.id));
  }
}, 60_000);
afterAll(() => h?.stop());

test("a scan finds the same picture twice, a staging repeated far away and a background reused in another scene", async () => {
  // p0 and p4 are the same picture; p2 stages p0's figure on another background; p5 reuses p1's background.
  await upload(panelIds[0]!, await scene("#2050a0", "circle", "#d03030"));
  await upload(panelIds[1]!, await scene("#20a050", "bars", "#202020"));
  await upload(panelIds[2]!, await scene("#e09020", "circle", "#d03030"));
  await upload(panelIds[3]!, await scene("#909090", "bars", "#f0f0f0"));
  await upload(panelIds[4]!, await scene("#2050a0", "circle", "#d03030"));
  await upload(panelIds[5]!, await scene("#20a050", "circle", "#f0f0f0"));
  const { job } = await u.post<{ job: { id: string } }>(`/api/projects/${projectId}/duplicates/scan`, {}, 202);
  type Scan = { id: string; status: string; result: { groups: { kind: string; members: { panelId?: string }[] }[] } };
  const scan = await waitFor(
    async () => {
      const s = (await u.get<{ scan: Scan }>(`/api/projects/${projectId}/duplicates`)).scan;
      return s?.id === job.id && s.status === "completed" ? s : null;
    },
    { label: "scan", timeoutMs: 60_000 },
  );
  const of = (kind: string) =>
    scan.result.groups
      .filter((g) => g.kind === kind)
      .map((g) => g.members.map((m) => panelIds.indexOf(m.panelId!)).sort());
  expect(of("identical")).toContainEqual([0, 4]);
  expect(of("pose").flat()).toContain(2);
  expect(of("background")).toContainEqual([1, 5]);
  // Features are kept per image, so a second scan reads them back.
  expect((await h.deps.db.select().from(assetFeatures)).length).toBeGreaterThanOrEqual(6);
}, 120_000);
