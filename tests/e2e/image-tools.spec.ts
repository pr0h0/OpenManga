import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, jobDone, seedPlannedProject, sharedPage } from "./helpers.ts";

// Image tools: a quick upscale and an AI relight, each a new artwork version.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "image-tools"));
  s = await seedPlannedProject(page, "E2E image tools");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("image tools: upscale at once, relight as an edit, both new versions", async () => {
  const a = api(page);
  const [panel] = await firstPagePanels(a, s.pageId);
  const gen = await a.post<{ job: { id: string } }>(`/panels/${panel!.id}/generate`);
  await jobDone(a, gen.job.id);
  const count = async () => (await a.get<{ versions: unknown[] }>(`/panels/${panel!.id}/versions`)).versions.length;
  const before = await count();
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}`);
  await page.getByText("Image tools", { exact: true }).click();
  await page.getByRole("button", { name: "Upscale 2x" }).click();
  await expect(page.getByText("Done: a new version is active")).toBeVisible();
  await page.getByLabel("New light").fill("cold moonlight from above");
  await page.getByRole("button", { name: "Relight" }).click();
  await expect(page.getByText("Edit queued")).toBeVisible();
  await expect.poll(count, { timeout: 60_000 }).toBe(before + 2);
});
