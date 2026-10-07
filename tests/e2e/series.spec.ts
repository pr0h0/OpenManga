import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, STORY, sharedPage, until } from "./helpers.ts";

// A series: its library's cast linked into a new episode, an update that leaves the episode behind, and a sync.

let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  ({ page, errors } = await sharedPage(browser, "series"));
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("series: a library character follows into an episode, falls behind, and syncs", async () => {
  await page.goto("/app/series");
  await page.getByPlaceholder("Title").fill("E2E Tales");
  await page.getByRole("button", { name: "Create" }).click();
  await page.getByRole("link", { name: /E2E Tales/ }).click();
  await expect(page.getByRole("region", { name: "Library" })).toBeVisible();
  const seriesId = page.url().split("/series/")[1]!;
  const a = api(page);
  const { series } = await a.get<{ series: { libraryProjectId: string } }>(`/series/${seriesId}`);
  const { character } = await a.post<{ character: { id: string } }>(`/projects/${series.libraryProjectId}/characters`, {
    name: "Woo Jin",
    role: "protagonist",
    description: { hair: "short black hair" },
  });

  const add = page.getByRole("form", { name: "Add episode" });
  await add.getByLabel("Title").fill("Episode one");
  await add.getByLabel("Story (optional)").fill(STORY);
  await add.getByRole("button", { name: "Add episode" }).click();
  await expect(page.getByRole("link", { name: "Episode one" })).toBeVisible();
  await expect(page.getByText("in step")).toBeVisible();

  const { episodes } = await a.get<{ episodes: { id: string }[] }>(`/series/${seriesId}`);
  await page.goto(`/app/projects/${episodes[0]!.id}/cast`);
  await expect(page.getByText("from series")).toBeVisible();
  await expect(page.getByRole("link", { name: "Series · episode 1" })).toBeVisible();

  // A new approved version in the library: the episode is one behind until synced from its row.
  const { version } = await a.post<{ version: { id: string } }>(`/characters/${character.id}/versions`, {
    description: { hair: "long silver hair" },
  });
  await a.post(`/character-versions/${version.id}/status`, { status: "approved" });
  await page.goto(`/app/series/${seriesId}`);
  await page.getByRole("button", { name: /1 behind · sync/ }).click();
  await expect(page.getByText("in step")).toBeVisible();
  await until(
    async () =>
      (await a.get<{ characters: { syncedVersionId: string | null }[] }>(`/projects/${episodes[0]!.id}/characters`))
        .characters[0]?.syncedVersionId === version.id,
    "episode synced",
  );
});
