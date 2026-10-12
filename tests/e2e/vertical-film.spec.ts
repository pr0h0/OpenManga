import { expect, type Page, test } from "@playwright/test";
import { expectNoErrors, sharedPage } from "./helpers.ts";

// Native vertical projects: a narrated video of 9:16 shots, chosen in the wizard.

let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  ({ page, errors } = await sharedPage(browser, "vertical"));
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("the wizard creates a vertical film project; its settings show the 9:16 shot frame", async () => {
  await page.goto("/app/projects/new");
  await page.getByLabel("Title").fill("E2E vertical film");
  await page.getByLabel("Format").selectOption("film-9:16");
  await expect(page.getByText(/vertical 9:16 shot, planned and drawn tall/)).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();
  await page.getByRole("button", { name: "Create without analysis" }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
  await page.goto(`${page.url().replace(/\/$/, "")}/settings`);
  await expect(page.getByLabel("Shot frame")).toHaveValue("9:16");
  await expect(page.getByLabel("Export frame")).toHaveValue("9:16");
});
