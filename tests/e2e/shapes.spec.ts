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
