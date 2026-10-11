import { expect, type Page, test } from "@playwright/test";
import { expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Near-duplicate finder: a scan run from the storyboard reports what it compared.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "duplicates"));
  s = await seedPlannedProject(page, "E2E duplicates");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("near-duplicates: scan the project from the storyboard", async () => {
  await page.goto(`${s.url}/storyboard?chapterId=${s.chapterId}`);
  await page.getByRole("button", { name: "Near-duplicates" }).click();
  await page.getByRole("button", { name: "Scan the project" }).click();
  await expect(page.getByText(/panels scanned/)).toBeVisible({ timeout: 60_000 });
});
