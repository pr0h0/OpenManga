import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, seedPlannedProject, sharedPage } from "./helpers.ts";

// Why is this stale: an out-of-date stage on the production card opens what changed under it and what an update redoes.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "why-stale"));
  s = await seedPlannedProject(page, "E2E why stale");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("why stale: a chapter whose text changed after planning is explained on the overview", async () => {
  const a = api(page);
  const { chapter } = await a.get<{ chapter: { sourceExcerpt: string } }>(`/chapters/${s.chapterId}`);
  await a.patch(`/chapters/${s.chapterId}`, { sourceExcerpt: `${chapter.sourceExcerpt}\nThe rain stopped.` });
  await page.goto(s.url);
  await page.getByRole("button", { name: /^Plan \d+$/ }).click();
  const why = page.getByRole("region", { name: "Why Plan is out of date" });
  await expect(why.getByText(/^Its text changed after planning/)).toBeVisible();
  await expect(why.getByText(/^Update: Re-planning replaces its \d+ pages?/)).toBeVisible();
});
