import { expect, type Page, test } from "@playwright/test";
import { expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Prompt lab: the narration rules rewritten, previewed as a diff, saved as v1 and back to the built-in.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "prompt-lab"));
  s = await seedPlannedProject(page, "E2E prompt lab");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("prompt lab: rewrite the narration rules, preview, save, revert", async () => {
  await page.goto(`${s.url}/prompts`);
  await page.getByRole("button", { name: /^Narration instructions/ }).click();
  const editor = page.getByRole("region", { name: "Narration instructions" });
  const rules = editor.getByLabel("Rules");
  await rules.fill(`${await rules.inputValue()}\nNarrate like a weary noir detective.`);
  await editor.getByRole("button", { name: "Preview" }).click();
  await expect(editor.getByLabel("Diff")).toContainText("+ Narrate like a weary noir detective.");
  await expect(editor.getByLabel("Compiled prompt")).toContainText("[template:narration-v");
  await editor.getByRole("button", { name: /^Save as v1/ }).click();
  await expect(page.getByRole("button", { name: /^Narration instructions.*Project rules v1/ })).toBeVisible();
  await page
    .getByRole("region", { name: "Narration instructions" })
    .getByRole("button", { name: "Use the built-in" })
    .click();
  await expect(page.getByRole("button", { name: /^Narration instructions.*Built-in v/ })).toBeVisible();
});
