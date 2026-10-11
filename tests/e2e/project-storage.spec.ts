import { expect, type Page, test } from "@playwright/test";
import { expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// A project's storage policy: kept per kind and capped, set by its owner in project settings.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  ({ page, errors } = await sharedPage(browser, "pstorage"));
  s = await seedPlannedProject(page, "E2E storage");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("project storage: a policy with its own age for exports and a cap", async () => {
  await page.goto(`${s.url}/settings`);
  const box = page.getByRole("region", { name: "Storage" });
  await box.getByText("Use a storage policy for this project").click();
  await box.getByLabel("Storage cap (GB)").fill("5");
  await box.getByLabel("Export files: how long").selectOption("days");
  await box.getByLabel("Export files: days").fill("90");
  await box.getByRole("button", { name: "Save storage policy" }).click();
  await expect(page.getByText("Storage policy saved")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("region", { name: "Storage" }).getByLabel("Export files: days")).toHaveValue("90");
  await expect(page.getByRole("region", { name: "Storage" }).getByText(/of its 5(\.0+)? GB cap/)).toBeVisible();
});
