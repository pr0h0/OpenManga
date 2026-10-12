import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, seedPlannedProject, sharedPage } from "./helpers.ts";

// Coverage sheet: nine setups of one panel's moment, two picks turned into new panels.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "coverage"));
  s = await seedPlannedProject(page, "E2E coverage");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("coverage sheet: draw one, pick two setups, add them as new panels", async () => {
  const a = api(page);
  const [panel] = await firstPagePanels(a, s.pageId);
  const pagesBefore = (await a.get<{ pages: unknown[] }>(`/chapters/${s.chapterId}`)).pages.length;
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}`);
  await page.getByText("Coverage sheet", { exact: true }).click();
  await page.getByRole("button", { name: "Draw coverage sheet" }).click();
  await expect(page.getByRole("button", { name: "1. Wide" })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "1. Wide" }).click();
  await page.getByRole("button", { name: "4. Close-up" }).click();
  await page.getByRole("button", { name: "Add 2 as new panels" }).click();
  await expect(page.getByText("2 panels added after this one")).toBeVisible();
  expect((await a.get<{ pages: unknown[] }>(`/chapters/${s.chapterId}`)).pages.length).toBe(pagesBefore + 1);
});
