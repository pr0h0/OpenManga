import { expect, type Page, test } from "@playwright/test";
import { expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Hook variants: an alternative opening written on the Exports page and chosen for a panel-cut video.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "hooks"));
  s = await seedPlannedProject(page, "E2E hooks");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("hook variants: write one over two panels, save it, pick it as the opening", async () => {
  await page.goto(`${s.url}/exports`);
  await page
    .getByRole("combobox", { name: /^Format/ })
    .first()
    .selectOption("video_panels");
  await page.getByText(/^Hook variants \(0\)/).click();
  await page.getByRole("button", { name: "Add a hook" }).click();
  const hook = page.getByRole("list", { name: "Hook variants" }).getByRole("listitem").first();
  await hook.getByLabel("Hook name").fill("Mystery");
  await hook.getByLabel("Narration").fill("Nobody climbs this roof at night. Tonight, two people did.");
  await hook.getByLabel("Pick panels from").selectOption({ index: 1 });
  const boxes = hook.getByRole("checkbox");
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await expect(hook.getByText("Opening panels (2/6, in story order)")).toBeVisible();
  await page.getByRole("button", { name: "Save hook variants" }).click();
  await expect(page.getByText("Hook variants saved")).toBeVisible();
  await page.getByLabel("Opening").selectOption({ label: "Hook: Mystery" });
  await expect(page.getByLabel("Opening")).not.toHaveValue("");
});
