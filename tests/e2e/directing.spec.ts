import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, seedPlannedProject, sharedPage } from "./helpers.ts";

// Directing controls: camera height and a figure's staging set on the Panel tab reach the panel prompt.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "directing"));
  s = await seedPlannedProject(page, "E2E directing");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("directing: set a camera height and a focus subject, save, and the prompt says so", async () => {
  const a = api(page);
  const [panel] = await firstPagePanels(a, s.pageId);
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}`);
  await page.getByText("Directing", { exact: true }).click();
  await page.getByLabel("Camera height").selectOption("knee");
  await page.getByLabel("Focus subject").fill("the rain on the glass");
  await page.getByRole("button", { name: "Save panel spec" }).click();
  await expect
    .poll(async () => (await a.get<{ compiledPrompt: string }>(`/panels/${panel!.id}/prompt-preview`)).compiledPrompt)
    .toContain("Camera at knee height");
  const { compiledPrompt } = await a.get<{ compiledPrompt: string }>(`/panels/${panel!.id}/prompt-preview`);
  expect(compiledPrompt).toContain("Focus subject: the rain on the glass.");
});
