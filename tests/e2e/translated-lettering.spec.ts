import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Translated lettering: a chapter's bubbles translated for another edition, one line edited by hand.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "lettering"));
  s = await seedPlannedProject(page, "E2E lettering");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("translated lettering: translate a chapter, edit a line", async () => {
  // The plan's dialogue onto the pages first: that is what gets translated.
  const a = api(page);
  const { pages } = await a.get<{ pages: { id: string }[] }>(`/chapters/${s.chapterId}`);
  for (const pg of pages) await a.post(`/pages/${pg.id}/letter-from-plan`);
  await page.goto(`${s.url}/chapters/${s.chapterId}`);
  await page.getByText("Translated lettering", { exact: true }).click();
  await page.getByLabel("Edition language").selectOption("es");
  await page.getByRole("button", { name: "Translate", exact: true }).click();
  await expect(page.getByText(/^\d+ of \d+ translated$/)).toBeVisible();
  const first = page.getByLabel(/^Translation of: /).first();
  await expect(first).toHaveValue(/^\[es\] /, { timeout: 60_000 });
  await first.fill("Hola");
  await page.getByRole("button", { name: "Save 1 edit" }).click();
  await expect(page.getByText("edited by hand").first()).toBeVisible();
});
