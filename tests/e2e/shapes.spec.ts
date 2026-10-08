import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, seedPlannedProject, sharedPage, until } from "./helpers.ts";

// Panel shapes in the page editor: a point added on an edge and dragged out, saved as a polygon outline.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "shapes"));
  s = await seedPlannedProject(page, "E2E shapes");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

/** The screen centre of the `i`-th Konva node with this name. */
const nodeAt = (name: string, i: number) =>
  page.evaluate(
    ([n, k]) => {
      const st = (
        window as unknown as { Konva: { stages: { find: (s: string) => unknown[]; container: () => HTMLElement }[] } }
      ).Konva.stages[0]!;
      const node = st.find(`.${n}`)[k as number] as {
        getClientRect: () => { x: number; y: number; width: number; height: number };
      };
      const r = node.getClientRect();
      const b = st.container().getBoundingClientRect();
      return { x: b.left + r.x + r.width / 2, y: b.top + r.y + r.height / 2 };
    },
    [name, i] as const,
  );
const count = (name: string) =>
  page.evaluate(
    (n) =>
      (window as unknown as { Konva: { stages: { find: (s: string) => unknown[] }[] } }).Konva.stages[0]!.find(`.${n}`)
        .length,
    name,
  );

test("panel shape: add a point on the top edge, drag it out, saved as an outline; reset to a rectangle", async () => {
  const a = api(page);
  const [panel] = await firstPagePanels(a, s.pageId);
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}`);
  await page.getByRole("button", { name: "Edit shape" }).click();
  await expect.poll(() => count("shape-point")).toBe(4);
  const plus = await nodeAt("shape-add", 0);
  await page.mouse.click(plus.x, plus.y);
  await expect.poll(() => count("shape-point")).toBe(5);
  const pt = await nodeAt("shape-point", 1);
  await page.mouse.move(pt.x, pt.y);
  await page.mouse.down();
  await page.mouse.move(pt.x + 10, pt.y + 30, { steps: 6 });
  await page.mouse.move(pt.x + 20, pt.y + 60, { steps: 6 });
  await page.mouse.up();
  await page.getByRole("button", { name: "Done editing shape" }).click();
  const frame = await until(async () => {
    const r = await a.get<{ panels: { id: string; frame: { points?: { x: number; y: number }[] } }[] }>(
      `/pages/${s.pageId}`,
    );
    return r.panels.find((p) => p.id === panel!.id)?.frame.points ?? null;
  }, "outline saved");
  expect(frame.length).toBe(5);
  // The dragged point went down into the panel: a notch in its top edge.
  expect(frame[1]!.y).toBeGreaterThan(0);

  await page.getByRole("button", { name: "Reset to rectangle" }).click();
  await until(async () => {
    const r = await a.get<{ panels: { id: string; frame: { points?: unknown } }[] }>(`/pages/${s.pageId}`);
    return r.panels.find((p) => p.id === panel!.id)?.frame.points === undefined;
  }, "back to a rectangle");
});

test("edges: a torn page and brush borders in settings, a burnt panel of its own, drawn in the page image", async () => {
  await page.goto(`${s.url}/settings`);
  const sec = page.locator("section", { has: page.getByRole("heading", { name: "Page and panel edges" }) });
  await sec.getByLabel("Page edge", { exact: true }).selectOption("torn");
  await sec.getByLabel("Panel borders", { exact: true }).selectOption("brush");
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  const a = api(page);
  await until(async () => {
    const { project } = await a.get<{ project: { settings: { edges?: { page?: { style: string } } } } }>(
      `/projects/${s.projectId}`,
    );
    return project.settings.edges?.page?.style === "torn";
  }, "edges saved");

  const [panel] = await firstPagePanels(a, s.pageId);
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}`);
  await page.getByLabel("Panel border", { exact: true }).selectOption("burnt");
  await until(async () => {
    const r = await a.get<{ panels: { id: string; frame: { edge?: { style: string } } }[] }>(`/pages/${s.pageId}`);
    return r.panels.find((p) => p.id === panel!.id)?.frame.edge?.style === "burnt";
  }, "panel border saved");
  // Back to the project's default.
  await page.getByLabel("Panel border", { exact: true }).selectOption("");
  await until(async () => {
    const r = await a.get<{ panels: { id: string; frame: { edge?: unknown } }[] }>(`/pages/${s.pageId}`);
    return r.panels.find((p) => p.id === panel!.id)?.frame.edge === undefined;
  }, "panel border cleared");
  const png = await page.request.get(`/api/pages/${s.pageId}/render.png?width=400&cutout=1`);
  expect(png.status()).toBe(200);
});

test("editor drags: a panel stops at the page edge without jumping, and the image zooms and moves", async () => {
  const a = api(page);
  const panels = await firstPagePanels(a, s.pageId);
  const target = panels.at(-1)!;
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${target.id}`);
  // The canvas loads after the page: wait for its panels before reading them.
  await page.waitForFunction(
    (id) =>
      Boolean(
        (window as unknown as { Konva?: { stages: { findOne: (s: string) => unknown }[] } }).Konva?.stages[0]?.findOne(
          `#panel-${id}`,
        ),
      ),
    target.id,
  );
  const nodeX = () =>
    page.evaluate(
      (id) =>
        (
          window as unknown as { Konva: { stages: { findOne: (s: string) => { x: () => number } }[] } }
        ).Konva.stages[0]!.findOne(`#panel-${id}`).x(),
      target.id,
    );
  const box = await page.evaluate((id) => {
    const st = (
      window as unknown as { Konva: { stages: { findOne: (s: string) => unknown; container: () => HTMLElement }[] } }
    ).Konva.stages[0]!;
    const r = (
      st.findOne(`#panel-${id}`) as { getClientRect: () => { x: number; y: number; width: number; height: number } }
    ).getClientRect();
    const b = st.container().getBoundingClientRect();
    return { x: b.left + r.x + r.width / 2, y: b.top + r.y + r.height / 2 };
  }, target.id);
  // Far past the right edge: it follows only as far as the page allows, and stays there on release.
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + i * 60, box.y);
  const during = await nodeX();
  await page.mouse.up();
  expect(Math.abs((await nodeX()) - during)).toBeLessThan(1);

  // The image: zoom in with the slider, then drag it.
  const doc = await a.get<{ panels: { id: string; activeArtworkAssetId: string | null }[] }>(`/pages/${s.pageId}`);
  if (doc.panels.find((p) => p.id === target.id)?.activeArtworkAssetId) {
    await page.getByRole("button", { name: "Move / zoom image on page" }).click();
    await page.getByLabel("Image zoom").fill("2");
    await page.mouse.move(box.x - 100, box.y);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(box.x - 100 + i * 8, box.y + i * 6);
    await page.mouse.up();
    await until(async () => {
      const r = await a.get<{ panels: { id: string; imageTransform: { scale: number; focalX: number } }[] }>(
        `/pages/${s.pageId}`,
      );
      const t = r.panels.find((p) => p.id === target.id)!.imageTransform;
      return t.scale === 2 && t.focalX !== 0.5;
    }, "image zoomed and moved");
  }
});
