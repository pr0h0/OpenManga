import { expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, STORY, sharedPage, until } from "./helpers.ts";

// Production runs from the Overview page: a run to the end with the final-output gate and the Health page, Update
// production after a revised story (paused for review, chapters kept as they are), and stopping a run with its jobs.

let page: Page;
let errors: string[];

test.beforeAll(async ({ browser }) => {
  ({ page, errors } = await sharedPage(browser, "prod"));
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

type Run = {
  id: string;
  status: string;
  pendingJobs: number;
  steps: { key: string; status: string; jobIds?: string[] }[];
};

async function newProject(title: string) {
  const a = api(page);
  const { project } = await a.post<{ project: { id: string } }>("/projects", {
    title,
    story: { content: STORY, inputKind: "story" },
  });
  // A run spends without asking, so it needs a cap first.
  await a.patch(`/projects/${project.id}`, { settings: { budgetUsd: 50 } });
  return { id: project.id, url: `/app/projects/${project.id}` };
}

const card = () => page.locator(".card", { has: page.getByRole("heading", { name: "Production run" }) });
/** The run's status line, e.g. "completed with warnings" (capitalised only by CSS). */
const runStatus = (re: RegExp) => card().locator("p > span.font-medium").filter({ hasText: re });

test("produce, the final-output gate, Health, then Update production after a revised story", async () => {
  test.setTimeout(420_000);
  const p = await newProject("E2E production");
  const a = api(page);

  await test.step("produce with review gates and the render off", async () => {
    await page.goto(p.url);
    await card().getByRole("button", { name: "Produce" }).click();
    const d = page.getByRole("dialog", { name: "Produce this project" });
    await d.getByLabel(/Pause for my review/).uncheck();
    await d.getByLabel("Render the video at the end").uncheck();
    await d.getByRole("button", { name: "Start" }).click();
    await expect(d).toBeHidden();
    await expect(runStatus(/^running$/i)).toBeVisible();
  });

  await test.step("the run ends finished, or finished with its unresolved list", async () => {
    await expect(runStatus(/^completed( with warnings)?$/i)).toBeVisible({ timeout: 240_000 });
    const { runs } = await a.get<{ runs: Run[] }>(`/projects/${p.id}/production-runs`);
    expect(["completed", "completed_with_warnings"]).toContain(runs[0]!.status);
    if (runs[0]!.status === "completed_with_warnings")
      await expect(card().getByText(/^Finished with \d+ unresolved items?/)).toBeVisible();
    await expect(card().getByText("Draw references")).toBeVisible();
  });

  await test.step("Health shows the verdict", async () => {
    await page.goto(`${p.url}/health`);
    await expect(page.getByRole("heading", { name: "Health" })).toBeVisible();
    await expect(page.getByText(/(Ready to publish|\d+ blocking issues?)$/).first()).toBeVisible();
    await expect(page.getByText(/^Spend \$/)).toBeVisible();
  });

  await test.step("revise the story: Update production stops at the review", async () => {
    // A new chapter. Its heading lands in chapter 1's text, so chapter 1's plan goes out of date once applied.
    await a.post(`/projects/${p.id}/story/revisions`, {
      content: `${STORY}\n\nChapter 2: Dawn\n\nWoo Jin walked home at dawn. The city was quiet and grey.`,
    });
    await page.goto(p.url);
    await card().getByRole("button", { name: "Update production" }).click();
    const d = page.getByRole("dialog", { name: "Update the production" });
    // Review gates off: a revised story's analysis still waits for the user.
    await d.getByLabel(/Pause for my review/).uncheck();
    await d.getByLabel("Render the video at the end").uncheck();
    await d.getByRole("button", { name: "Start" }).click();
    await expect(d).toBeHidden();
    await expect(runStatus(/^waiting$/i)).toBeVisible({ timeout: 60_000 });
    await expect(card().getByRole("link", { name: /Review it on the Story page/ })).toBeVisible();
  });

  await test.step("continue, and keep the changed chapter's plan as it is", async () => {
    await card().getByRole("button", { name: "Continue" }).click();
    await expect(card().getByText(/^Chapters changed since they were planned — 1 chapter/)).toBeVisible({
      timeout: 60_000,
    });
    // The card refreshes what is out of date when the run's status changes; waiting → waiting is not a change, so a
    // reload shows the list (a known gap in the card, not in the run).
    await page.reload();
    const stale = card().getByText("Chapters whose text changed after they were planned");
    await expect(stale).toBeVisible();
    await card().getByRole("button", { name: "Keep current" }).first().click();
    await expect(stale).toBeHidden();
    const { stalePlans } = await a.get<{ stalePlans: unknown[] }>(`/projects/${p.id}/staleness`);
    expect(stalePlans).toEqual([]);
  });
});

test("stopping a run cancels its queued jobs", async () => {
  const p = await newProject("E2E stop a run");
  const a = api(page);
  // Paste-mode text keeps the analysis waiting for an answer: a job the run queued that has not started.
  await a.post(`/projects/${p.id}/production-runs`, {
    reviewGates: false,
    render: false,
    ai: { text: { manual: true }, image: null },
  });
  const run = await until(async () => {
    const { runs } = await a.get<{ runs: Run[] }>(`/projects/${p.id}/production-runs`);
    return runs[0]?.pendingJobs ? runs[0] : null;
  }, "a queued job");
  const jobId = run.steps.find((st) => st.key === "analyze")!.jobIds![0]!;

  await page.goto(p.url);
  await expect(runStatus(/^running$/i)).toBeVisible();
  await card().getByRole("button", { name: "Stop" }).click();
  const d = page.getByRole("dialog", { name: "Stop the production run" });
  await expect(d.getByText("1 job not started yet would be cancelled.", { exact: false })).toBeVisible();
  await expect(d.getByLabel(/Stop and cancel its queued jobs/)).toBeChecked();
  await d.getByRole("button", { name: "Stop" }).click();
  await expect(d).toBeHidden();
  await expect(runStatus(/^cancelled$/i)).toBeVisible();

  await page.goto(`${p.url}/generation/${jobId}`);
  await expect(page.getByText("cancelled").first()).toBeVisible();
  const { job } = await a.get<{ job: { status: string } }>(`/generations/${jobId}`);
  expect(job.status).toBe("cancelled");
});
