import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, jobDone, seedPlannedProject, sharedPage } from "./helpers.ts";

// Comic effects: speed lines added on the Panel tab are saved on the panel and drawn into the page render.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "effects"));
  s = await seedPlannedProject(page, "E2E effects");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("effects: add speed lines on the Panel tab, saved and drawn", async () => {
  const a = api(page);
  const [panel] = await firstPagePanels(a, s.pageId);
  const gen = await a.post<{ job: { id: string } }>(`/panels/${panel!.id}/generate`);
  await jobDone(a, gen.job.id);
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}`);
  await page.getByText("Effects", { exact: true }).click();
  await page.getByLabel("Effect to add").selectOption("speed");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Speed lines: density").fill("0.9");
  await expect
    .poll(
      async () =>
        (await a.get<{ panel: { effects: { type: string }[] | null } }>(`/panels/${panel!.id}`)).panel.effects?.[0]
          ?.type,
    )
    .toBe("speed");
  const r = await page.request.get(`/api/pages/${s.pageId}/render.png?width=400`);
  expect(r.status()).toBe(200);
});
