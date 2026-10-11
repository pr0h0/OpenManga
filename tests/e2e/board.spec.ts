import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, seedPlannedProject, sharedPage } from "./helpers.ts";

// Reference board: an image added and noted, dropped onto a character, then used as a panel's layout guide.

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nO3PUQkAIBTAwBfHOEY0qiH8OITBAtxm7fN1wwUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY8dgFu3SDEQw1b6AAAAABJRU5ErkJggg==",
  "base64",
);

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "board"));
  s = await seedPlannedProject(page, "E2E board");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("board: add an image, note it, use it as a character reference and a layout guide", async () => {
  const a = api(page);
  await page.goto(`${s.url}/board`);
  await page
    .getByLabel("Add images to the board")
    .setInputFiles({ name: "mood.png", mimeType: "image/png", buffer: PNG });
  const card = page.getByRole("listitem", { name: "Board image" });
  await expect(card).toHaveCount(1);
  await card.getByLabel("Note").fill("the blue night light");
  await card.getByLabel("Note").blur();
  await card.getByLabel("Which one").selectOption({ index: 1 });
  await card.getByRole("button", { name: "Use as reference" }).click();
  await expect(page.getByText("Added as a draft reference")).toBeVisible();
  await expect
    .poll(async () => (await a.get<{ items: { note: string }[] }>(`/projects/${s.projectId}/board`)).items[0]?.note)
    .toBe("the blue night light");

  const [panel] = await firstPagePanels(a, s.pageId);
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}`);
  await page.getByRole("button", { name: "From board" }).click();
  await page.getByRole("option", { name: "the blue night light" }).click();
  await expect(page.getByText("Layout guide set from the board")).toBeVisible();
});
