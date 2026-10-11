import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, jobDone, seedPlannedProject, sharedPage } from "./helpers.ts";

// The asset library: an image favourited, tagged in bulk, filtered by tag, and its origin shown.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "assetlib"));
  s = await seedPlannedProject(page, "E2E asset library");
  const a = api(page);
  const { pages } = await a.get<{ pages: { id: string }[] }>(`/chapters/${s.chapterId}`);
  const [panel] = await firstPagePanels(a, pages[0]!.id);
  await jobDone(a, (await a.post<{ job: { id: string } }>(`/panels/${panel!.id}/generate`)).job.id);
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("asset library: favourite, bulk tag, filter by tag, see where an image came from", async () => {
  await page.goto(`${s.url}/assets`);
  const grid = page.getByLabel("Assets", { exact: true });
  await grid.getByRole("button", { name: "Favourite" }).first().click();
  await page.getByRole("tab", { name: "Favourites" }).click();
  await expect(grid.getByRole("button", { name: "Unfavourite" })).toHaveCount(1);
  await page.getByRole("tab", { name: "All" }).click();
  await grid.getByRole("checkbox").first().check();
  const bulk = page.getByRole("region", { name: "Bulk actions" });
  await bulk.getByLabel("Tag or collection").fill("rooftop");
  await bulk.getByRole("button", { name: "Tag", exact: true }).click();
  await expect(page.getByText(/^1 done/)).toBeVisible();
  await page.getByLabel("Tag", { exact: true }).selectOption("rooftop");
  await expect(grid.getByText("#rooftop")).toHaveCount(1);
  await grid.getByText("#rooftop").click();
  await expect(page.getByRole("region", { name: "Where it came from" }).getByText("Generated")).toBeVisible();
});
