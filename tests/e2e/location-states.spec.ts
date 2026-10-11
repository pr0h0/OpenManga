import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Location states: a state added on the place's page, then picked by hand on a scene that is there.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "location-states"));
  s = await seedPlannedProject(page, "E2E location states");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("location states: add one with its words, pick it on a scene", async () => {
  const a = api(page);
  const { scenes } = await a.get<{ scenes: { id: string; title: string; locationId: string | null }[] }>(
    `/chapters/${s.chapterId}`,
  );
  const scene = scenes.find((x) => x.locationId)!;
  await page.goto(`${s.url}/world/locations/${scene.locationId}`);
  const states = page.getByRole("region", { name: "Location states" });
  await states.getByLabel("New state name").fill("after the fire");
  await states.getByRole("button", { name: "Add" }).click();
  await states.getByLabel("What differs (after the fire)").fill("walls blackened");
  await states.getByLabel("Time or weather words (after the fire)").fill("ash, smoke");
  await states.getByLabel("Time or weather words (after the fire)").blur();
  await expect
    .poll(
      async () =>
        (await a.get<{ states: { keywords: string[] }[] }>(`/locations/${scene.locationId}/states`)).states[0]
          ?.keywords,
    )
    .toEqual(["ash", "smoke"]);

  await page.goto(`${s.url}/chapters/${s.chapterId}`);
  await page
    .getByRole("button", { name: new RegExp(scene.title) })
    .first()
    .click();
  await page.getByLabel("Location state").selectOption({ label: "after the fire" });
  await page.getByRole("button", { name: "Save scene" }).click();
  await expect
    .poll(async () => {
      const r = await a.get<{ scenes: { id: string; locationStateId: string | null }[] }>(`/chapters/${s.chapterId}`);
      return r.scenes.find((x) => x.id === scene.id)?.locationStateId;
    })
    .toBeTruthy();
});
