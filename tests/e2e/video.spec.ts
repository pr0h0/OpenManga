import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, seedProducedProject, sharedPage } from "./helpers.ts";

// Video and repurposing on one produced project (drawn, narrated, voiced): repurpose plan and a carousel export, the
// Shorts suggestion, a panel's shot settings and layout guide, video branding, and the reader link's video preview.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedProducedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  ({ page, errors } = await sharedPage(browser, "video"));
  s = await seedProducedProject(page, "E2E video tools");
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("repurpose: suggest a plan, adjust a pick, write copy, render the carousel", async () => {
  await page.goto(`${s.url}/repurpose`);
  await expect(page.getByRole("heading", { name: "Repurpose" })).toBeVisible();
  await page.getByRole("button", { name: "Suggest plan" }).click();
  const carousel = page.locator("li.card", { has: page.getByText("Carousel", { exact: true }) });
  await expect(carousel).toBeVisible();

  await test.step("adjust the carousel's picks and save the plan", async () => {
    const count = carousel.getByText(/^\d+ panel\(s\)/);
    const before = Number((await count.innerText()).match(/^\d+/)![0]);
    await carousel.getByText("Adjust the picks").click();
    // Untick a picked panel, or tick one when nothing is picked.
    const picked = carousel.getByRole("checkbox", { checked: true });
    if (before > 1) await picked.first().uncheck();
    else await carousel.getByRole("checkbox", { checked: false }).first().check();
    await expect(count).toHaveText(new RegExp(`^${before > 1 ? before - 1 : before + 1} panel\\(s\\)`));
    await page.getByRole("button", { name: "Save plan" }).click();
    await expect(page.getByText("Plan saved")).toBeVisible();
  });

  await test.step("write titles and captions", async () => {
    await page.getByRole("button", { name: "Write titles and captions" }).click();
    // The mock writes in a moment; the copy lands in the saved plan and the page reloads it.
    await expect(carousel.getByLabel("Title")).not.toHaveValue("", { timeout: 60_000 });
    await expect(carousel.getByLabel("Caption")).not.toHaveValue("");
  });

  await test.step("render the carousel and see the export complete", async () => {
    await carousel.getByRole("button", { name: "Render", exact: true }).click();
    await expect(page.getByText("1 export(s) queued — download them from Exports")).toBeVisible();
    await page.goto(`${s.url}/exports`);
    const row = page.locator("li.card", { hasText: "Carousel images (ZIP)" });
    await expect(row.getByText("completed")).toBeVisible({ timeout: 60_000 });
  });
});

test("exports: a Shorts export suggests a 9:16 pick of shots and renders it with captions", async () => {
  await page.goto(`${s.url}/exports`);
  await page
    .getByRole("combobox", { name: /^Format/ })
    .first()
    .selectOption("video_shorts");
  await expect(page.getByLabel("Shape")).toHaveValue("9:16");
  // The automatic pick: some shots chosen and their running length.
  await expect(page.getByText(/^[1-9]\d* shot\(s\) · \d+\.\d s$/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Preview the Short" })).toBeVisible();

  await test.step("render it with captions drawn in", async () => {
    await page.getByLabel("Captions").selectOption("bottom");
    // A Shorts cut is its picked shots only, so the readiness check never stops it.
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect(page.getByText("Export queued")).toBeVisible();
    type Job = { kind: string; status: string; options: { video?: { captions?: string } } };
    await expect
      .poll(
        async () =>
          (await api(page).get<{ jobs: Job[] }>(`/projects/${s.projectId}/exports`)).jobs.find(
            (j) => j.kind === "video_shorts",
          )?.status,
        { timeout: 120_000 },
      )
      .toBe("completed");
    const { jobs } = await api(page).get<{ jobs: Job[] }>(`/projects/${s.projectId}/exports`);
    expect(jobs.find((j) => j.kind === "video_shorts")?.options.video?.captions).toBe("bottom");
  });
});

test("page editor: a shot's video settings and a drawn layout guide", async () => {
  const a = api(page);
  const [panel] = await firstPagePanels(a, s.pageId);
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}`);
  await expect(page.getByLabel("Page canvas")).toBeVisible({ timeout: 30_000 });

  await test.step("set a camera move and leave the shot out", async () => {
    // Both controls show the saved panel, so each change is waited for before the next builds on it.
    await page.getByLabel("Camera move").selectOption("push-in");
    await expect.poll(async () => (await a.get(`/pages/${s.pageId}`)).panels[0].video?.motion).toBe("push-in");
    await page.getByLabel("Leave this shot and its narration out of videos").click();
    await expect(page.getByLabel("Leave this shot and its narration out of videos")).toBeChecked();
    await expect
      .poll(async () => (await a.get(`/pages/${s.pageId}`)).panels[0].video)
      .toMatchObject({ motion: "push-in", disabled: true });
    await page.reload();
    await expect(page.getByLabel("Camera move")).toHaveValue("push-in");
    await expect(page.getByLabel("Leave this shot and its narration out of videos")).toBeChecked();
  });

  await test.step("draw a layout guide, save it, and describe the pose", async () => {
    await page.getByRole("button", { name: "Draw guide" }).click();
    const d = page.getByRole("dialog", { name: "Draw layout guide" });
    const canvas = d.getByLabel("Drawing canvas for the layout guide");
    await expect(canvas).toBeVisible();
    const box = (await canvas.boundingBox())!;
    for (const [x1, y1, x2, y2] of [
      [0.3, 0.2, 0.3, 0.8],
      [0.2, 0.4, 0.4, 0.4],
      [0.6, 0.3, 0.8, 0.7],
    ] as const) {
      await page.mouse.move(box.x + box.width * x1, box.y + box.height * y1);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * x2, box.y + box.height * y2, { steps: 8 });
      await page.mouse.up();
    }
    await d.getByRole("button", { name: "Save guide" }).click();
    await expect(page.getByText("Layout guide saved")).toBeVisible();
    await expect(d).toBeHidden();
    await expect(page.getByRole("img", { name: "Layout guide" })).toBeVisible();
    const pose = page.getByLabel("Pose, in words (optional)");
    await pose.fill("one figure standing on the left, arms out");
    await pose.blur();
    await expect
      .poll(async () => (await a.get(`/pages/${s.pageId}`)).panels[0].guide?.pose)
      .toBe("one figure standing on the left, arms out");
  });
});

test("video branding: an intro card in project settings", async () => {
  const a = api(page);
  await page.goto(`${s.url}/settings`);
  await page.getByLabel("Intro card", { exact: true }).check();
  await page.getByLabel("Intro card title").fill("Rooftop Recaps");
  await expect
    .poll(async () => (await a.get(`/projects/${s.projectId}`)).project.settings.video?.intro?.title)
    .toBe("Rooftop Recaps");
  await page.reload();
  await expect(page.getByLabel("Intro card", { exact: true })).toBeChecked();
  await expect(page.getByLabel("Intro card title")).toHaveValue("Rooftop Recaps");
});

test("reader link: the shared chapter plays as a video preview", async () => {
  await page.goto(s.url);
  await page.getByRole("button", { name: "Share" }).click();
  const d = page.getByRole("dialog", { name: "Share a reader link" });
  await d.getByRole("button", { name: "Create link" }).click();
  const link = d.getByRole("link", { name: "Open" }).or(d.getByTitle("Open")).first();
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href"))!;
  // A fresh context: the reader needs no account.
  const anon = await page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL });
  const reader = await anon.newPage();
  await reader.goto(new URL(href).pathname);
  await reader.getByRole("button", { name: "Play this chapter as a video preview" }).click();
  await reader.getByRole("button", { name: "Play", exact: true }).first().click();
  await expect(reader.getByRole("button", { name: "Pause", exact: true }).first()).toBeVisible();
  await anon.close();
});

test("shot variety: a run of the same framing is flagged on the storyboard and on Health", async () => {
  const a = api(page);
  const { panels } = await a.get<{ panels: { id: string }[] }>(`/chapters/${s.chapterId}/panels`);
  // Three rare shots in a row, from one angle: a framing run whatever the planner chose around them.
  for (const p of panels.slice(0, 3))
    await a.patch(`/panels/${p.id}`, { shotType: "extreme-wide", cameraAngle: "birds-eye" });

  await page.goto(`${s.url}/storyboard?chapterId=${s.chapterId}&filter=repeated`);
  await expect(page.getByRole("tab", { name: /^Repeated shot \d+$/, selected: true })).toBeVisible();
  await expect(page.getByText(/^\d+ extreme-wide shots in a row from the same birds-eye angle$/).first()).toBeVisible();
  expect(await page.getByText(/extreme-wide shots in a row/).count()).toBeGreaterThanOrEqual(3);

  await page.goto(`${s.url}/health`);
  await expect(page.getByText(/run\(s\) of panels repeating the same shot/)).toBeVisible();
});

test("thumbnail variants: each headline on the same art, and one put in use", async () => {
  const a = api(page);
  const { project } = await a.get<{ project: { settings: { thumbnail?: { title: string } } } }>(
    `/projects/${s.projectId}`,
  );
  expect(project.settings.thumbnail).toBeTruthy();
  await a.patch(`/projects/${s.projectId}`, {
    settings: {
      youtubePackage: {
        titles: ["The rooftop"],
        description: "D",
        tags: [],
        pinnedComment: "",
        thumbnailHeadlines: ["The duel", "Who lit it?"],
      },
    },
  });
  await page.goto(`${s.url}/exports`);
  const duel = page.getByRole("img", { name: "Thumbnail: The duel" });
  await expect(duel).toBeVisible();
  // Composited from the saved art: a real image came back, not a broken one.
  await expect.poll(() => duel.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(480);
  await expect(page.getByRole("img", { name: "Thumbnail: Who lit it?" })).toBeVisible();

  const card = page.locator("li", { has: page.getByRole("img", { name: "Thumbnail: Who lit it?" }) });
  await card.getByRole("button", { name: "Use" }).click();
  await expect(page.getByText("Thumbnail headline updated")).toBeVisible();
  await expect(card.getByText("In use")).toBeVisible();
  await expect
    .poll(async () => (await a.get(`/projects/${s.projectId}`)).project.settings.thumbnail?.title)
    .toBe("Who lit it?");
});
