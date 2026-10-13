import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, jobDone, seedPlannedProject, sharedPage } from "./helpers.ts";

// AI video: a shot animated into a clip with the free model, text put on screen; an ad's script from a brief.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "aivideo"));
  s = await seedPlannedProject(page, "E2E AI video");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("a drawn shot becomes a clip with the free model, then gets text on screen", async () => {
  test.setTimeout(120_000);
  const a = api(page);
  const [panel] = await firstPagePanels(a, s.pageId);
  await jobDone(a, (await a.post<{ job: { id: string } }>(`/panels/${panel!.id}/generate`)).job.id);
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}`);
  const box = page.locator("details", { hasText: "Video clip" }).first();
  await box.locator("summary").click();
  // Paid models are listed with their price but cannot run without a fal key.
  await expect(box.getByLabel("Video model").locator("option[disabled]").first()).toHaveText(/add a fal key/);
  await box.getByLabel("Length (s)").fill("3");
  await box.getByRole("button", { name: "Make clip" }).click();
  await expect(box.getByRole("list", { name: "Clips" }).getByText(/playing/)).toBeVisible({ timeout: 60_000 });
  await expect(box.getByLabel("This shot's clip")).toBeVisible();
  const text = box.getByPlaceholder("e.g. 30% OFF — TODAY ONLY");
  await text.fill("ORDER TODAY");
  await text.blur();
  await box.getByLabel("Text style").selectOption("cta");
  await expect
    .poll(async () => {
      const r = await a.get<{ panel: { video: { onScreenText?: { style: string } | null; clipAssetId?: string } } }>(
        `/panels/${panel!.id}`,
      );
      return [r.panel.video?.onScreenText?.style ?? null, Boolean(r.panel.video?.clipAssetId)];
    })
    .toEqual(["cta", true]);
});

test("an ad's script is written from a brief and saved as the story", async () => {
  await page.goto(`${s.url}/story`);
  await page.getByRole("button", { name: "Ad from a brief" }).click();
  await page.getByLabel("Product or service").fill("Glowtide desk lamp");
  await page.getByLabel("Call to action").fill("Order today");
  await page.getByRole("button", { name: "Write the script" }).click();
  await expect(page.getByText("Ad script saved as a new revision")).toBeVisible({ timeout: 60_000 });
});
