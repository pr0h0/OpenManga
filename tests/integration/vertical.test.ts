import { afterAll, beforeAll, expect, test } from "bun:test";
import { asc, assets, dialogueLines, eq, inArray, pages, panels } from "@openmanga/db";
import { stripLayout } from "@openmanga/domain";
import { sharp } from "@openmanga/image-utils";
import { type PanelSeam, STRIP_HEIGHT_RATIOS } from "@openmanga/schemas";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let chapterId: string;

const STORY = `A courier named Sefu runs packages across the rooftops of a flooded city.
Tonight the package is a sealed jar that hums when it is near water.
He takes the long way, over the market roofs, because the canals have eyes.
Halfway across, the jar goes quiet, and every light below him goes out at once.
"Not tonight," Sefu says, to the jar and to the dark both.
Sefu stops running and looks down at the black water waiting between the buildings.`;

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "strip", email: "strip@example.com", password: "strip-pass-1234" },
    201,
  );
  const p = await alice.post<{
    project: { id: string; settings: { format: string; pageWidth: number; lettering?: { autoPlace?: boolean } } };
  }>(
    "/api/projects",
    { title: "Rooftop Courier", projectType: "manhwa", format: "vertical", story: { content: STORY } },
    201,
  );
  projectId = p.project.id;
  // A strip starts with no gutter and no margin: spacing belongs to the seam, not to every frame.
  expect(p.project.settings.format).toBe("vertical");
  expect(p.project.settings.pageWidth).toBe(800);
  // A strip letters itself: one full-width frame has only one place a balloon can go, and a webtoon read with
  // its speech left off is not the format.
  expect(p.project.settings.lettering?.autoPlace).toBe(true);
  // And only a strip: a comic page is composed around its balloons, so auto-placement stays off there.
  const comic = await alice.post<{ project: { settings: { lettering?: { autoPlace?: boolean } } } }>(
    "/api/projects",
    { title: "Still A Comic", projectType: "manga", story: { content: STORY } },
    201,
  );
  expect(comic.project.settings.lettering?.autoPlace ?? false).toBe(false);

  const story = await alice.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const an = await alice.post<{ job: { id: string } }>(`/api/story-revisions/${story.latest.id}/analyze`, {}, 202);
  await waitFor(
    async () => {
      const j = await alice.get<{ job: { status: string } }>(`/api/jobs/${an.job.id}`);
      return j.job.status === "completed" ? j : null;
    },
    { label: "analysis" },
  );
  const withAnalyses = await alice.get<{ analyses: { id: string }[] }>(`/api/projects/${projectId}/story`);
  await alice.post(`/api/story-analyses/${withAnalyses.analyses[0]!.id}/apply`, {});
  const chapters = await alice.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
  chapterId = chapters.chapters[0]!.id;
  const plan = await alice.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, {}, 202);
  await waitFor(
    async () => {
      const j = await alice.get<{ job: { status: string; failureReason: string | null } }>(`/api/jobs/${plan.job.id}`);
      return ["completed", "failed"].includes(j.job.status) ? j.job : null;
    },
    { label: "strip plan" },
  );
});
afterAll(async () => await h?.stop());

test("a strip plans one panel per page, with pacing on the page and the seam on the panel", async () => {
  const rows = await h.deps.db
    .select({ page: pages, panel: panels })
    .from(pages)
    .innerJoin(panels, eq(panels.pageId, pages.id))
    .where(eq(pages.projectId, projectId))
    .orderBy(asc(pages.order));
  expect(rows.length).toBeGreaterThan(3);
  // One frame per page: the strip discards page geometry, so a page is a panel.
  const perPage = new Map<string, number>();
  for (const r of rows) perPage.set(r.page.id, (perPage.get(r.page.id) ?? 0) + 1);
  expect([...perPage.values()].every((n) => n === 1)).toBe(true);

  // Height is pacing, so it has to actually vary, and only by the ratios the format defines.
  const allowed = new Set(Object.values(STRIP_HEIGHT_RATIOS).map((r) => Math.round(800 * r)));
  const heights = new Set(rows.map((r) => r.page.height));
  expect(heights.size).toBeGreaterThan(1);
  for (const height of heights) expect(allowed.has(height)).toBe(true);

  // Speech is placed, not merely planned: auto-placement is what turns a planned line into a balloon on the
  // page, and it is off by default everywhere else.
  const lines = await h.deps.db
    .select()
    .from(dialogueLines)
    .where(
      inArray(
        dialogueLines.panelId,
        rows.map((r) => r.panel.id),
      ),
    );
  expect(lines.length).toBeGreaterThan(0);

  // The planner authors the transition into each panel.
  const kinds = new Set(rows.map((r) => r.panel.seam?.kind).filter(Boolean));
  expect(kinds.size).toBeGreaterThan(1);
  expect(rows.some((r) => r.panel.seam?.kind === "butt" || r.panel.seam?.kind === "dissolve")).toBe(true);
});

test("the reader's strip and the exported image are laid out by the same arithmetic", async () => {
  const strip = await alice.get<{
    width: number;
    gap: number;
    blocks: { height: number; seam: PanelSeam | null }[];
  }>(`/api/chapters/${chapterId}/strip?width=800`);
  expect(strip.blocks.length).toBeGreaterThan(3);
  const expected = stripLayout(strip.blocks, { gap: strip.gap }).height;

  const job = await alice.post<{ job: { id: string } }>(
    `/api/projects/${projectId}/exports`,
    { kind: "webtoon", chapterId, webtoon: { width: 800, split: false, format: "png" }, acknowledgeIssues: true },
    202,
  );
  const done = await waitFor(
    async () => {
      const l = await alice.get<{ jobs: { id: string; status: string; files: { assetId: string }[] }[] }>(
        `/api/projects/${projectId}/exports`,
      );
      const j = l.jobs.find((x) => x.id === job.job.id);
      return j && ["completed", "failed"].includes(j.status) ? j : null;
    },
    { label: "webtoon export", timeoutMs: 240_000 },
  );
  expect(done.status).toBe("completed");
  const [asset] = await h.deps.db.select().from(assets).where(eq(assets.id, done.files[0]!.assetId));
  const meta = await sharp(await h.deps.assets.storage.read(asset!.storageKey), { limitInputPixels: false }).metadata();
  expect(meta.width).toBe(800);
  // The whole point of sharing stripLayout: what the reader scrolls is the height that gets stitched.
  expect(meta.height).toBe(expected);
});
