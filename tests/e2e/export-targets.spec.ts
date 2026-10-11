import { expect, type Page, test } from "@playwright/test";
import { expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Export targets: a platform preset sets the export and checks the platform's limits before it is made.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "targets"));
  s = await seedPlannedProject(page, "E2E targets");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("a platform target sets the export and checks it: WEBTOON Canvas passes, KDP needs more pages", async () => {
  await page.goto(`${s.url}/exports`);
  await page.getByLabel("Export for").selectOption("webtoon_canvas");
  await expect(page.getByRole("combobox", { name: /^Format/ }).first()).toHaveValue("webtoon");
  const check = page.getByRole("region", { name: "Platform check" });
  await expect(check.getByText(/800 px wide, at most 1280 px tall/)).toBeVisible();
  await expect(
    check.getByText("Within WEBTOON Canvas's limits so far; the files are checked again once made."),
  ).toBeVisible();
  await page.getByLabel("Export for").selectOption("kdp_paperback");
  await expect(page.getByRole("combobox", { name: /^Format/ }).first()).toHaveValue("pdf");
  await expect(check.getByText(/pages; Amazon KDP paperback \(6×9 in\) needs at least 24\./)).toBeVisible();
});
