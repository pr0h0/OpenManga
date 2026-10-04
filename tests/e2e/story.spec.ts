import { expect, type Page, test } from "@playwright/test";
import { api, eventually, expectNoErrors, seedProducedProject, sharedPage } from "./helpers.ts";

// Story and narration tools on one produced, voiced project: story bible, story coverage, narration QA, timing and
// the pronunciation dictionary. The order matters only at the end: the pronunciation entry marks audio out of date.

let page: Page;
let errors: string[];
let s: Awaited<ReturnType<typeof seedProducedProject>>;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  ({ page, errors } = await sharedPage(browser, "story"));
  s = await seedProducedProject(page, "E2E story tools");
  const a = api(page);
  // A narration line that breaks a fixed rule for the continuity check, two near-duplicate lines for the rule
  // checks, and two the mock AI check reads as one repeated meaning (fixable).
  for (const text of [
    "Woo Jin raised the pistol he had found. [[mock:contradiction]]",
    "The stairwell lamp flickered twice and went dark.",
    "The stairwell lamp flickered twice and went dark!",
    "Woo Jin knew the rooftop was a trap. [[mock:lint]]",
    "He was certain someone had planned this ambush. [[mock:lint]]",
  ])
    await a.post(`/chapters/${s.chapterId}/narration/lines`, { text });
});
test.afterAll(() => page?.context().close());
test.afterEach(() => expectNoErrors(errors));

test("story bible: facts, states, filters, extraction, continuity and rule checks", async () => {
  await page.goto(`${s.url}/bible`);
  await expect(page.getByRole("heading", { name: "Story bible" })).toBeVisible();

  await test.step("add a fixed rule", async () => {
    await page.getByRole("button", { name: "Add fact" }).click();
    const d = page.getByRole("dialog", { name: "Add fact" });
    await d.getByLabel("Kind").selectOption("rule");
    await d.getByLabel("Fact").fill("No dragons fly over the city.");
    await d.getByLabel(/Fixed/).check();
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d).toBeHidden();
    await expect(page.getByText("No dragons fly over the city.")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Facts (1)" })).toBeVisible();
  });

  await test.step("add a character state", async () => {
    await page.getByRole("tab", { name: /^Timeline/ }).click();
    await page.getByRole("button", { name: "Add state" }).click();
    const d = page.getByRole("dialog", { name: "Add state" });
    await d.getByLabel("Character").selectOption({ label: "Woo Jin" });
    await d.getByLabel("Kind").selectOption("injury");
    await d.getByLabel("State").fill("Sprained left ankle.");
    await d.getByRole("button", { name: "Save" }).click();
    await expect(d).toBeHidden();
    await expect(page.getByText("Sprained left ankle.")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Timeline (1)" })).toBeVisible();
  });

  await test.step("filter the facts", async () => {
    await page.getByRole("tab", { name: /^Facts/ }).click();
    await page.getByLabel("Search", { exact: true }).fill("dragons");
    await expect(page.getByText("No dragons fly over the city.")).toBeVisible();
    await page.getByLabel("Kind").selectOption("character");
    await expect(page.getByText("Nothing matches these filters.")).toBeVisible();
    await page.getByLabel("Kind").selectOption("");
    await page.getByLabel("Search", { exact: true }).fill("");
  });

  await test.step("extract from the story and apply one proposed entry", async () => {
    await page.getByRole("button", { name: "Extract from story" }).click();
    await page
      .getByRole("dialog", { name: "Extract bible from story" })
      .getByRole("button", { name: "Extract" })
      .click();
    await eventually(page, () =>
      expect(page.getByRole("heading", { name: "Review the extracted bible" })).toBeVisible({ timeout: 3000 }),
    );
    // Keep only the world rule: untick every other proposed fact and state.
    const proposal = page.locator("section", {
      has: page.getByRole("heading", { name: "Review the extracted bible" }),
    });
    const boxes = proposal.getByRole("checkbox");
    const n = await boxes.count();
    for (let i = 0; i < n; i++) {
      const box = boxes.nth(i);
      const label = (await box.locator("xpath=..").innerText()).trim();
      if (!label.includes("No guns exist")) await box.uncheck();
    }
    await proposal.getByRole("button", { name: "Save 1 facts, 0 states" }).click();
    await expect(page.getByText("Saved 1 facts and 0 states")).toBeVisible();
    await expect(page.getByRole("heading", { name: "Review the extracted bible" })).toBeHidden();
    await expect(page.getByText("No guns exist in this world.")).toBeVisible();
    await expect(page.getByRole("tab", { name: "Facts (2)" })).toBeVisible();
  });

  await test.step("continuity: run a check and see the queue", async () => {
    await page.getByRole("tab", { name: "Continuity" }).click();
    await page.getByRole("button", { name: "Check continuity" }).click();
    await page
      .getByRole("dialog", { name: "Check continuity" })
      .getByRole("button", { name: "Check 1 chapter" })
      .click();
    await expect(page.getByText("Continuity check queued")).toBeVisible();
    // The narration line with a pistol breaks a fixed rule: the queue shows it as an open contradiction.
    await expect(page.getByText(/contradicts the bible/).first()).toBeVisible({ timeout: 60_000 });
  });

  await test.step("rule checks list the rules with their verdicts", async () => {
    await page.getByRole("tab", { name: "Rule checks" }).click();
    const rule = page.locator("li", { hasText: "No dragons fly over the city." });
    await expect(rule).toBeVisible();
    await expect(rule.getByText(/ch\. 1: (pass|fail|unclear)/)).toBeVisible();
    await expect(page.locator("li", { hasText: "No guns exist in this world." })).toBeVisible();
  });
});

test("story coverage: run the check from the Story page and read the report", async () => {
  await page.goto(`${s.url}/story`);
  await expect(page.getByRole("heading", { name: "Story coverage" })).toBeVisible();
  await page.getByRole("button", { name: "Check coverage" }).click();
  await expect(page.getByText(/Revision 1, \d+ paragraphs in 1 part\(s\), checked/)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText(/^Left out · \d+$/)).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Story weight" })).toBeVisible();
});

test("narration QA: rule checks, the AI check, a fix shown as a diff and applied, and density", async () => {
  await page.goto(`${s.url}/narration/qa?chapterId=${s.chapterId}`);
  await expect(page.getByRole("heading", { name: "Narration QA" })).toBeVisible();
  await expect(page.getByText("No open findings")).toBeVisible();

  await test.step("rule checks find the near-duplicate lines", async () => {
    await page.getByRole("button", { name: "Run checks" }).click();
    await expect(page.getByText(/^Checks: /)).toBeVisible();
    await expect(page.locator("li", { hasText: "The stairwell lamp flickered twice" }).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: /Findings \([1-9]\d* open\)/ })).toBeVisible();
  });

  await test.step("the AI check flags the repeated meaning", async () => {
    await page.getByRole("button", { name: "Check with AI" }).click();
    await expect(page.getByText(/^AI check: /)).toBeVisible({ timeout: 60_000 });
    await expect(page.locator("li", { hasText: "Woo Jin knew the rooftop was a trap." })).toBeVisible();
  });

  await test.step("fix selected: review the diff and apply it", async () => {
    const finding = page.locator("li", { hasText: "Woo Jin knew the rooftop was a trap." });
    await finding.getByRole("checkbox", { name: "Select to fix" }).check();
    await page.getByRole("button", { name: "Fix selected (1)" }).click();
    const review = page.getByRole("dialog", { name: /^Proposed fixes/ });
    await expect(review).toBeVisible({ timeout: 60_000 });
    // Before and after, line by line: the marker is gone from the rewrite.
    await expect(review.getByText(/\[\[mock:lint\]\]/).first()).toBeVisible();
    await review.getByRole("button", { name: /^Apply 2 line\(s\)/ }).click();
    await expect(page.getByText(/^Applied 2 line\(s\)/)).toBeVisible();
    await expect(review).toBeHidden();
    await expect(page.locator("li", { hasText: "Woo Jin knew the rooftop was a trap." })).toHaveCount(0);
  });

  await test.step("the density tab counts words per shot", async () => {
    await page.getByRole("tab", { name: "Density" }).click();
    await expect(page.getByRole("columnheader", { name: "Words / shot" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Shot by shot" })).toBeVisible();
  });
});

test("timing: the voiced chapter's shots and lengths, and one fix applied", async () => {
  // Shots should hold at least 12 s, and the export minimum drops to 1 s below: the shots without narration of their
  // own then fall short of the shot length, and each is offered a longer hold of its own.
  await api(page).patch(`/projects/${s.projectId}`, {
    settings: { targetRuntime: { minutes: 5, wordsPerMinute: 150, minShotSeconds: 12, maxShotSeconds: 20 } },
  });
  await page.goto(`${s.url}/timing?chapterId=${s.chapterId}`);
  await expect(page.getByRole("heading", { name: "Timing" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Voiced" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Shots" })).toBeVisible();
  expect(await page.locator("ol li", { hasText: /\d+(\.\d)? s$/ }).count()).toBeGreaterThan(1);
  await expect(page.getByText(/\d+\/\d+ narration segments voiced/)).toBeVisible();
  await page.getByLabel("Minimum hold (s)").fill("1");
  await page.getByLabel("Minimum hold (s)").blur();
  const fixes = page.locator(".card", { has: page.getByRole("heading", { name: "Rebalance holds" }) });
  const apply = fixes.getByRole("button", { name: "Apply", exact: true });
  await expect(apply.first()).toBeVisible();
  const offered = await apply.count();
  expect(offered).toBeGreaterThan(0);
  await expect(fixes.getByText(/held to the shortest-shot length, 12(\.0)? s/).first()).toBeVisible();
  await apply.first().click();
  await expect(page.getByText("Applied", { exact: true })).toBeVisible();
  await expect(apply).toHaveCount(offered - 1);
  await api(page).patch(`/projects/${s.projectId}`, { settings: { targetRuntime: null } });
});

test("pronunciation: an entry in settings marks the affected narration audio out of date", async () => {
  await page.goto(`${s.url}/narration?chapterId=${s.chapterId}`);
  await expect(page.getByText("outdated")).toHaveCount(0);
  await page.goto(`${s.url}/settings`);
  const section = page.locator("section", { has: page.getByRole("heading", { name: "Pronunciation" }) });
  await section.getByRole("button", { name: "Add entry" }).click();
  await section.getByLabel("Written term").fill("Woo Jin");
  await section.getByLabel("Spoken as").fill("Woo Jeen");
  await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
  await page.goto(`${s.url}/narration?chapterId=${s.chapterId}`);
  // Only the lines that say the name: their audio is marked outdated, the rest keep theirs.
  await expect(page.getByText("outdated").first()).toBeVisible();
});
