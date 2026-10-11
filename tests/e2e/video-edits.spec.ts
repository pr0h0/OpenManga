import { expect, type Page, test } from "@playwright/test";
import { expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Edit the video in words: an instruction proposes edits, one is changed, and they are applied.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "video-edits"));
  s = await seedPlannedProject(page, "E2E video edits");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("edit in words: propose, change a card's title, apply", async () => {
  await page.goto(`${s.url}/timing`);
  const box = page.getByRole("region", { name: "Edit in words" });
  await box.getByLabel("Instruction").fill("Add a title card before chapter 1 and fade at scene breaks");
  await box.getByRole("button", { name: "Propose edits" }).click();
  const edits = box.getByRole("list", { name: "Proposed edits" });
  await expect(edits.getByText("Fade to black at scene breaks: on")).toBeVisible({ timeout: 60_000 });
  await edits.getByLabel("Card title").fill("Part One");
  await box.getByRole("button", { name: "Apply 2 edit(s)" }).click();
  await expect(page.getByText("Applied 2 edit(s)")).toBeVisible();
  await page.goto(`${s.url}/settings`);
  await page.getByText(/^Chapter cards \(1 on\)/).click();
  await expect(page.getByLabel("Chapter 1 card title")).toHaveValue("Part One");
});
