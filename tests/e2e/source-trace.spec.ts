import { expect, type Page, test } from "@playwright/test";
import { expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Story source: a chapter's text with each panel's part marked, linked both ways with the page editor.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "source-trace"));
  s = await seedPlannedProject(page, "E2E source trace");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("source trace: chapter text marked by panel, open a panel, and back from the panel to the chapter", async () => {
  await page.goto(`${s.url}/chapters/${s.chapterId}`);
  await page.getByText("Story source").click();
  const marker = page.getByRole("link", { name: "Open page 1, panel 1" });
  await expect(marker).toBeVisible();
  await marker.click();
  await expect(page).toHaveURL(/\/pages\/.+panelId=/);
  await page.getByText("From the story").click();
  await page.getByRole("link", { name: "See it in the chapter" }).click();
  await expect(page).toHaveURL(/\/chapters\/.+#source/);
  await expect(page.getByRole("link", { name: "Open page 1, panel 1" })).toBeVisible();
});
