import { type Browser, expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, seedPlannedProject, sharedPage } from "./helpers.ts";

// People and channels: a second user invited by username who accepts in their own browser, a panel comment that
// mentions them and reaches their notification bell, channel profiles through the new-project wizard, and an
// expert's reply turned into a project.

let owner: { page: Page; errors: string[]; user: { username: string } };
let member: { page: Page; errors: string[]; user: { username: string } };
let s: Awaited<ReturnType<typeof seedPlannedProject>>;

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  owner = await sharedPage(browser, "owner");
  member = await sharedPage(browser, "member");
  s = await seedPlannedProject(owner.page, "E2E collab");
});
test.afterAll(async () => {
  await owner?.page.context().close();
  await member?.page.context().close();
});
test.afterEach(() => {
  expectNoErrors(owner.errors);
  expectNoErrors(member.errors);
});

test("members: invite by username, accept in a second browser, marked Shared", async () => {
  const page = owner.page;
  await page.goto(s.url);
  await page.getByRole("button", { name: "Members" }).click();
  const d = page.getByRole("dialog", { name: "Members" });
  await d.getByLabel("Username or email").fill(member.user.username);
  await d.getByLabel("Role").selectOption("editor");
  await d.getByRole("button", { name: "Invite" }).click();
  await expect(page.getByText("Invitation sent")).toBeVisible();
  await expect(d.getByRole("heading", { name: "Pending invitations" })).toBeVisible();

  const other = member.page;
  await other.goto("/app/");
  const invites = other.getByRole("region", { name: "Invitations" });
  await expect(invites.getByText("E2E collab")).toBeVisible();
  await invites.getByRole("button", { name: "Accept" }).click();
  await expect(other).toHaveURL(new RegExp(`/projects/${s.projectId}`));
  await other.goto("/app/");
  const card = other.locator("li, a, div.card", { hasText: "E2E collab" }).filter({ hasText: "Shared" }).first();
  await expect(card).toBeVisible();
  await expect(card.getByText(`@${owner.user.username} · editor`)).toBeVisible();
});

test("panel comments: a mention reaches the member's notification bell", async () => {
  const [panel] = await firstPagePanels(api(owner.page), s.pageId);
  const page = owner.page;
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel!.id}&tab=comments`);
  const box = page.getByLabel("Comment on this panel");
  await box.fill("Can you check the pose here?");
  await page.getByRole("button", { name: `@${member.user.username}` }).click();
  await expect(box).toHaveValue(new RegExp(`@${member.user.username} $`));
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByText("Can you check the pose here?")).toBeVisible();

  const other = member.page;
  await other.goto("/app/");
  const bell = other.getByRole("button", { name: /^Notifications, 1 unread$/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const note = other.getByRole("button", { name: new RegExp(`@${owner.user.username} mentioned you in E2E collab`) });
  await expect(note).toBeVisible();
  await note.click();
  await expect(other).toHaveURL(new RegExp(`/pages/${s.pageId}`));
  await expect(other.getByText("Can you check the pose here?")).toBeVisible();
});

test("channel profiles: voice, pronunciation and branding, picked in the wizard, re-applied with a diff", async () => {
  const page = owner.page;
  const name = "E2E Channel";

  await test.step("create a profile", async () => {
    await page.goto("/app/profiles");
    await page.getByRole("button", { name: "New profile" }).click();
    await page.getByLabel("Name").fill(name);
    await page.getByLabel("Voice").selectOption("am_michael");
    const pron = page.locator("section", { has: page.getByRole("heading", { name: "Pronunciation" }) });
    await pron.getByRole("button", { name: "Add entry" }).click();
    await pron.getByLabel("Written term").fill("Woo Jin");
    await pron.getByLabel("Spoken as").fill("Woo Jeen");
    await page.getByLabel("Intro card", { exact: true }).check();
    await page.getByLabel("Intro card title").fill("Rooftop Recaps");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Profile saved")).toBeVisible();
    await expect(page.locator("li", { hasText: name })).toBeVisible();
  });

  await test.step("the new-project wizard picks it", async () => {
    await page.locator("li", { hasText: name }).getByRole("link", { name: "New project" }).click();
    await expect(page.getByLabel("Channel profile")).toHaveValue(/.+/);
    await expect(page.getByLabel("Channel profile").locator("option:checked")).toHaveText(name);
    await page.getByLabel("Title", { exact: true }).fill("E2E from a profile");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Create without analysis" }).click();
    await expect(page.getByText(`From profile ${name}`, { exact: false })).toBeVisible();
  });
  const projectUrl = page.url();
  const projectId = projectUrl.match(/projects\/([0-9a-f-]{36})/)![1]!;
  const { project } = await api(page).get(`/projects/${projectId}`);
  expect(project.settings).toMatchObject({
    narrationVoice: "am_michael",
    pronunciation: [{ term: "Woo Jin", spoken: "Woo Jeen" }],
    video: { intro: { title: "Rooftop Recaps" } },
  });

  await test.step("change the profile, then Re-apply shows the diff", async () => {
    await page.goto("/app/profiles");
    await page.locator("li", { hasText: name }).getByRole("button", { name: "Edit" }).click();
    await page.getByLabel("Voice").selectOption("bf_emma");
    await page.getByRole("button", { name: "Save profile" }).click();
    await expect(page.getByText("Profile saved")).toBeVisible();
    await page.goto(projectUrl);
    await page.getByRole("button", { name: "Re-apply profile" }).click();
    const d = page.getByRole("dialog", { name: "Apply a channel profile" });
    const change = d.locator("li", { hasText: "Narrator voice" });
    await expect(change).toContainText("am_michael");
    await expect(change).toContainText("bf_emma");
    await d.getByRole("button", { name: "Apply 1 change" }).click();
    await expect(d).toBeHidden();
    await expect
      .poll(async () => (await api(page).get(`/projects/${projectId}`)).project.settings.narrationVoice)
      .toBe("bf_emma");
  });
});

test("experts: a reply becomes a new project through its output action", async () => {
  const page = owner.page;
  await page.goto("/app/experts");
  await page.getByRole("button", { name: "Start chat" }).first().click();
  const input = page.getByPlaceholder(/Message the expert/);
  await input.fill("A premise about a lighthouse that keeps its own hours");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText(/Mock expert reply to: A premise about a lighthouse/).first()).toBeVisible({
    timeout: 60_000,
  });
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByRole("button", { name: "Review and apply" }).click({ timeout: 60_000 });
  const d = page.getByRole("dialog");
  await expect(d.getByLabel("Title", { exact: true })).not.toHaveValue("");
  await d.getByRole("button", { name: "Create project" }).click();
  // A concept opens the project it made.
  await expect(page.getByText("Project created")).toBeVisible();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}/);
  await expect(page.getByRole("heading", { name: "Production run" })).toBeVisible();
});
