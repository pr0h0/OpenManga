import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Accessibility: a panel's alt text written by hand, and the checks on Health.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  ({ page, errors } = await sharedPage(browser, "a11y"));
  s = await seedPlannedProject(page, "E2E accessibility");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("alt text on the Panel tab, counted on Health", async () => {
  const { pages } = await api(page).get<{ pages: { id: string }[] }>(`/chapters/${s.chapterId}`);
  await page.goto(`${s.url}/pages/${pages[0]!.id}`);
  const alt = page.locator("details", { hasText: "Alt text" }).first();
  await alt.locator("summary").click();
  await alt.getByRole("button", { name: "Start from the suggestion" }).click();
  await expect(alt.getByRole("textbox")).not.toHaveValue("");
  await alt.getByRole("textbox").fill("A lone figure on a wet rooftop.");
  await alt.getByRole("button", { name: "Save alt text" }).click();
  await expect(page.getByText("Alt text saved")).toBeVisible();
  await page.goto(`${s.url}/health`);
  const box = page.getByRole("region", { name: "Accessibility" });
  await expect(box.getByText(/Alt text: 1 of \d+ panels written by hand/)).toBeVisible();
  await expect(box.getByRole("link", { name: "Narration transcript" })).toBeVisible();
});
