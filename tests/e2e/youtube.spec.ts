import { type Browser, expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, sharedPage } from "./helpers.ts";

// YouTube stats under mock mode: a channel connected through the fake Google consent screen, one video linked from
// its uploads and one pasted, the project's totals and first-48-hours curve, and one video's chart opened.

let s: { page: Page; errors: string[] };
let projectId = "";

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  s = await sharedPage(browser, "youtube");
  projectId = (await api(s.page).post<{ project: { id: string } }>("/projects", { title: "E2E stats" })).project.id;
});
test.afterAll(async () => {
  await s?.page.context().close();
});
test.afterEach(() => expectNoErrors(s.errors));

test("connect a channel, link videos, read the stats", async () => {
  const page = s.page;
  await page.goto(`/app/projects/${projectId}/youtube`);
  await expect(page.getByRole("heading", { name: "YouTube stats" })).toBeVisible();
  await expect(page.getByText("No videos linked yet")).toBeVisible();

  // The OAuth round trip: our page → fake consent → callback → back here.
  await page.getByRole("button", { name: "Connect a channel" }).click();
  await expect(page.getByRole("heading", { name: "Fake Google" })).toBeVisible();
  await page.getByLabel("Channel name").fill("E2E Channel");
  await page.getByRole("button", { name: "Allow" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/projects/${projectId}/youtube`));
  await expect(page.getByText("Connected E2E Channel")).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect E2E Channel" })).toBeVisible();

  // From the channel's uploads.
  await page.getByRole("button", { name: "Link a video" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Link a YouTube video" });
  await dialog.getByRole("tab", { name: "From my channel" }).click();
  await dialog.getByRole("button", { name: "Link", exact: true }).first().click();
  await expect(page.getByText("Video linked")).toBeVisible();
  await expect(dialog.getByText("Linked", { exact: true }).first()).toBeVisible();

  // A pasted link to someone else's video.
  await dialog.getByRole("tab", { name: "Paste a link" }).click();
  await dialog.getByLabel("Video link or id").fill("https://youtu.be/dQw4w9WgXcQ?si=share");
  await dialog.getByLabel("Label (optional)").fill("Reaction");
  await dialog.getByRole("button", { name: "Link video" }).click();
  await expect(dialog).toBeHidden();

  await expect(page.getByText("Views, all videos")).toBeVisible();
  await expect(page.getByText("2 videos ·").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "First 48 hours" })).toBeVisible();
  await expect(page.getByText(/· public counters/)).toBeVisible();

  // A connected video's chart: Analytics with its splits.
  await page.getByRole("button", { name: "Chart" }).first().click();
  await expect(page.getByText("Daily, from YouTube Analytics")).toBeVisible();
  await page.getByLabel("Metric").selectOption("estimatedMinutesWatched");
  await expect(page.getByRole("img", { name: "Watch time (minutes) per day" })).toBeVisible();
  await expect(page.getByText("Traffic sources (views)")).toBeVisible();

  // Unlink the pasted one.
  await page.getByRole("button", { name: "Unlink" }).last().click();
  await page.getByRole("dialog", { name: "Unlink this video?" }).getByRole("button", { name: "Unlink" }).click();
  await expect(page.getByText("Video unlinked")).toBeVisible();
  await expect(page.getByText("1 video ·").first()).toBeVisible();
});
