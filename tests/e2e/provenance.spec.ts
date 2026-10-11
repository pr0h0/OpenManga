import { expect, type Page, test } from "@playwright/test";
import { expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Provenance: an export with its record of what made it.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  ({ page, errors } = await sharedPage(browser, "provenance"));
  s = await seedPlannedProject(page, "E2E provenance");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("an export with a provenance record ships it next to the files", async () => {
  await page.goto(`${s.url}/exports`);
  await page
    .getByRole("combobox", { name: /^Format/ })
    .first()
    .selectOption("png_pages");
  await page.getByText("Include a provenance record").click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  // No artwork yet: the readiness check asks first.
  await page.getByRole("button", { name: "Export anyway" }).click();
  await expect(page.getByRole("link", { name: /_provenance\.json/ })).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("link", { name: /_provenance\.md/ })).toBeVisible();
});
