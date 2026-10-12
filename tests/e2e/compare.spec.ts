import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, seedPlannedProject, sharedPage } from "./helpers.ts";

// Model comparison: a panel drawn by two models side by side, one picked as its artwork.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "compare"));
  s = await seedPlannedProject(page, "E2E compare");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("compare models: draw with two, pick one", async () => {
  const a = api(page);
  const [panel] = await firstPagePanels(a, s.pageId);
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}`);
  await page.getByText("Compare models", { exact: true }).click();
  await page.getByRole("button", { name: "Draw with 2 models" }).click();
  const runs = page.getByRole("list", { name: "Comparison" });
  await expect(runs.getByRole("button", { name: "Use this one" }).first()).toBeEnabled({ timeout: 60_000 });
  await runs.getByRole("button", { name: "Use this one" }).first().click();
  await expect(page.getByText("Using that one")).toBeVisible();
  await expect
    .poll(
      async () =>
        (await a.get<{ panel: { activeArtworkAssetId: string | null } }>(`/panels/${panel!.id}`)).panel
          .activeArtworkAssetId,
    )
    .not.toBeNull();
});
