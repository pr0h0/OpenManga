import { expect, type Page, test } from "@playwright/test";
import { expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Story timeline: extracted from the story, reviewed and saved, then an event added by hand.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "timeline"));
  s = await seedPlannedProject(page, "E2E timeline");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("timeline: extract from the story, save the reviewed events, add one by hand", async () => {
  await page.goto(`${s.url}/timeline`);
  await page.getByRole("button", { name: "Extract from story" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Extract" }).click();
  const review = page.getByRole("region", { name: "Review the extracted timeline" });
  await expect(review).toBeVisible({ timeout: 60_000 });
  await review.getByRole("button", { name: /^Save \d+ events$/ }).click();
  const list = page.getByRole("list", { name: "Timeline" });
  // The mock gives the first character a birth 17 years before the first chapter's event.
  await expect(list.getByText(/, 17$/).first()).toBeVisible();
  await expect(list.getByText("17 years later")).toBeVisible();

  await page.getByRole("button", { name: "Add event" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("What happens").fill("The lamp is relit");
  await dialog.getByLabel("Story day").fill("1");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(list.getByRole("article", { name: "The lamp is relit" })).toBeVisible();
});
