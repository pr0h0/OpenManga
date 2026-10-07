import { type Browser, expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, firstPagePanels, jobDone, seedPlannedProject, sharedPage } from "./helpers.ts";

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

/** One MCP tool call as an agent connection would make it: the server is stateless, so a single JSON-RPC request. */
async function mcpCall(page: Page, token: string, name: string, args: Record<string, unknown>) {
  const r = await page.request.post("/mcp", {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    data: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  const text = await r.text();
  const line = text.startsWith("{") ? text : (text.split("\n").find((l) => l.startsWith("data:")) ?? "").slice(5);
  const json = JSON.parse(line) as { result?: { isError?: boolean; structuredContent?: { data: unknown } } };
  expect(json.result?.isError, text.slice(0, 300)).toBeFalsy();
  return json.result!.structuredContent!.data as Record<string, unknown>;
}

test("comments from an agent: marked MCP for everyone, named only for the member whose connection it is", async () => {
  const [, panel] = await firstPagePanels(api(owner.page), s.pageId);
  const { token } = await api(owner.page).post<{ token: string }>("/agents/tokens", {
    name: "E2E audit",
    scopes: ["panels:read", "panels:write"],
    projectAccess: "all",
    approvalMode: "ALLOW_ALL",
  });
  const posted = await mcpCall(owner.page, token, "post_comment", {
    panelId: panel!.id,
    body: "Audit: the lamp from page 1 is missing here.",
  });
  const commentId = (posted.comment as { id: string }).id;
  const where = `${s.url}/pages/${s.pageId}?panelId=${panel!.id}&tab=comments`;

  await test.step("the owner sees which of their connections wrote it", async () => {
    await owner.page.goto(where);
    await expect(owner.page.getByText("Audit: the lamp from page 1 is missing here.")).toBeVisible();
    await expect(owner.page.getByText("MCP · E2E audit")).toBeVisible();
  });

  await test.step("another member sees only that an agent wrote it", async () => {
    await member.page.goto(where);
    await expect(member.page.getByText("Audit: the lamp from page 1 is missing here.")).toBeVisible();
    await expect(member.page.getByText("MCP", { exact: true })).toBeVisible();
    await expect(member.page.getByText("E2E audit")).toHaveCount(0);
  });

  await test.step("a hand-written reply says so; the agent resolves the thread", async () => {
    await member.page.getByRole("button", { name: "Reply", exact: true }).click();
    const reply = member.page.getByLabel("Reply", { exact: true });
    await reply.fill("On it.");
    await reply.press("Control+Enter");
    await expect(member.page.getByText("On it.")).toBeVisible();
    await expect(member.page.getByText("by hand").first()).toBeVisible();
    await mcpCall(owner.page, token, "resolve_comment", { commentId });
    // Resolved threads fold away under "Show N resolved".
    for (const p of [member.page, owner.page]) {
      await p.reload();
      await p.getByRole("button", { name: /^Show \d+ resolved$/ }).click();
      await expect(p.getByText(`Resolved by @${owner.user.username}`)).toBeVisible();
    }
    await expect(member.page.getByText("E2E audit")).toHaveCount(0);
    await expect(owner.page.getByText("MCP · E2E audit")).toHaveCount(2);
  });
});

test("review: a pinned, assigned thread on the artwork, and a guest's comment through a reader link", async () => {
  const a = api(owner.page);
  const panels = await firstPagePanels(a, s.pageId);
  const panel = panels[2] ?? panels[0]!;
  const gen = await a.post<{ job: { id: string } }>(`/panels/${panel.id}/generate`, {});
  await jobDone(a, gen.job.id);
  const page = owner.page;
  await page.goto(`${s.url}/pages/${s.pageId}?panelId=${panel.id}&tab=comments`);

  await test.step("pin a spot on the artwork and assign the thread to the member", async () => {
    const artwork = page.getByRole("img", { name: "Panel artwork" });
    await expect(artwork).toBeVisible();
    await page.getByRole("button", { name: "Pin a spot" }).click();
    await artwork.click({ position: { x: 20, y: 20 } });
    await expect(page.getByRole("button", { name: "Remove the pin" })).toBeVisible();
    await page.getByLabel("Assign the new thread to").selectOption({ label: `@${member.user.username}` });
    await page.getByLabel("Comment on this panel").fill("This hand needs fixing");
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    const thread = page.locator("li.card", { hasText: "This hand needs fixing" });
    await expect(thread.getByTitle("Pinned spot on the artwork")).toHaveText("1");
    await expect(thread.getByLabel("Assigned to")).toHaveValue(/.+/);
  });

  await test.step("the member is told it is theirs", async () => {
    await member.page.goto("/app/");
    await member.page.getByRole("button", { name: /^Notifications, \d+ unread$/ }).click();
    await expect(
      member.page.getByRole("button", { name: new RegExp(`@${owner.user.username} assigned you a thread`) }),
    ).toBeVisible();
  });

  await test.step("a guest comments through a reader link that allows it", async () => {
    const { share } = await a.post<{ share: { token: string } }>(`/projects/${s.projectId}/shares`, {
      chapterId: null,
      allowComments: true,
    });
    const anon = await owner.page.context().browser()!.newContext({ baseURL: test.info().project.use.baseURL });
    const reader = await anon.newPage();
    await reader.goto(`/app/read/${share.token}`);
    await reader.getByRole("button", { name: "Comments" }).click();
    const drawer = reader.getByRole("complementary", { name: "Comments" });
    await drawer.getByLabel("Your name").fill("Ana");
    await drawer.getByLabel("Your comment").fill("Lovely art on this page");
    await drawer.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(reader.getByText("Comment sent")).toBeVisible();
    await expect(drawer.getByText("Ana (guest)")).toBeVisible();
    await anon.close();
    await page.goto("/app/");
    await page.getByRole("button", { name: /^Notifications, \d+ unread$/ }).click();
    await expect(page.getByRole("button", { name: /Ana \(guest\) commented through a reader link/ })).toBeVisible();
  });
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
