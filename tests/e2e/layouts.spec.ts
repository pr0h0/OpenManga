import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, seedPlannedProject, sharedPage, until } from "./helpers.ts";

// Custom page layouts: one saved from a page, turned on for the project, and a chapter re-laid with it.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(180_000);
  ({ page, errors } = await sharedPage(browser, "layouts"));
  s = await seedPlannedProject(page, "E2E layouts");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("layouts: save a page's layout, use it in the project, re-lay the chapter with it, delete it", async () => {
  const a = api(page);
  await page.goto(`${s.url}/pages/${s.pageId}`);
  await page.getByRole("tab", { name: "Page" }).click();
  await page.getByLabel("Layout name").fill("My first layout");
  await page.getByRole("button", { name: "Save as layout" }).click();
  await expect(page.getByRole("button", { name: "Use layout My first layout" })).toBeVisible();

  await page.goto(`${s.url}/settings`);
  const sec = page.locator("section", { has: page.getByRole("heading", { name: "Page layouts" }) });
  await sec
    .getByLabel(/Use in this project/)
    .first()
    .check();
  await until(async () => {
    const { project } = await a.get<{ project: { settings: { layouts?: unknown[] } } }>(`/projects/${s.projectId}`);
    return (project.settings.layouts?.length ?? 0) === 1;
  }, "project layouts saved");

  await page.goto(`${s.url}/chapters/${s.chapterId}`);
  await page.getByRole("button", { name: "Apply layouts" }).click();
  await expect(page.getByText(/page\(s\) re-laid/)).toBeVisible();
  const { pages } = await a.get<{ pages: { id: string; layoutTemplate: string | null }[] }>(`/chapters/${s.chapterId}`);
  expect(pages.find((p) => p.id === s.pageId)!.layoutTemplate).toMatch(/^custom:/);

  await page.goto(`${s.url}/pages/${s.pageId}`);
  await page.getByRole("tab", { name: "Page" }).click();
  await page.getByRole("button", { name: "Delete layout My first layout" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("button", { name: "Use layout My first layout" })).toHaveCount(0);
  const { layouts } = await a.get<{ layouts: unknown[] }>("/layouts");
  expect(layouts).toHaveLength(0);
  const { project } = await a.get<{ project: { settings: { layouts?: unknown[] } } }>(`/projects/${s.projectId}`);
  expect(project.settings.layouts ?? []).toHaveLength(0);
});
