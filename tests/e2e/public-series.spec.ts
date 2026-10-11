import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, jobDone, STORY, sharedPage } from "./helpers.ts";

// A series' reader page: the owner turns it on and publishes a chapter; a signed-out reader reads it.

let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  ({ page, errors } = await sharedPage(browser, "pubseries"));
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("reader page: turn it on, publish a chapter, read it signed out", async ({ browser }) => {
  test.setTimeout(180_000);
  const a = api(page);
  const { series } = await a.post<{ series: { id: string } }>("/series", { title: "E2E Rain City" });
  const ep = await a.post<{ project: { id: string } }>(`/series/${series.id}/episodes`, {
    title: "Night one",
    story: { content: STORY, inputKind: "story" },
  });
  const { latest } = await a.get<{ latest: { id: string } }>(`/projects/${ep.project.id}/story`);
  const an = await a.post<{ job: { id: string }; analysis: { id: string } }>(`/story-revisions/${latest.id}/analyze`);
  await jobDone(a, an.job.id);
  await a.post(`/story-analyses/${an.analysis.id}/apply`);
  const { chapters } = await a.get<{ chapters: { id: string }[] }>(`/projects/${ep.project.id}/chapters`);
  await jobDone(a, (await a.post<{ job: { id: string } }>(`/chapters/${chapters[0]!.id}/plan`)).job.id);

  await page.goto(`/app/series/${series.id}`);
  const card = page.getByRole("region", { name: "Reader page" });
  await card.getByLabel("Visibility").selectOption("unlisted");
  await card.getByLabel("Address (/s/…)").fill(`e2e-rain-${Date.now().toString(36)}`);
  await card.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Reader page saved")).toBeVisible();
  await card.getByText(/Episode 1: Night one/).click();
  await card.getByRole("button", { name: "Publish now" }).first().click();
  await expect(card.getByRole("button", { name: "Unpublish" })).toBeVisible();
  const link = await card.getByRole("link", { name: /\/s\// }).textContent();
  const slug = link!.split("/s/")[1]!;

  const reader = await (await browser.newContext({ baseURL: test.info().project.use.baseURL })).newPage();
  await reader.goto(`/app/s/${slug}`);
  await expect(reader.getByRole("heading", { name: "E2E Rain City", level: 2 })).toBeVisible();
  await reader.getByRole("button", { name: "Read" }).first().click();
  await expect(reader.getByAltText("Page 1")).toBeVisible();
  await reader.context().close();
});
