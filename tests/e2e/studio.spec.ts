import { expect, type Page, test } from "@playwright/test";

const STORY = `Chapter 1: The Rooftop

Rain hammered the city as Woo Jin climbed onto the rooftop. Woo Jin pulled his jacket tighter.
Footsteps echoed from the stairwell. "Who's there?" Woo Jin asked.
Kim Do-yun stepped out of the shadows. Kim Do-yun smiled.
"You shouldn't have come alone," Kim Do-yun said. The door slammed shut with a BANG.`;

const id = Date.now().toString(36);
const user = { username: `e2e_${id}`, email: `e2e_${id}@example.com`, password: "e2e-password-123" };

/** Collect uncaught page errors and app console errors (ignores third-party injections such as CDN beacons). */
function watchErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    const t = m.text();
    if (
      m.type() === "error" &&
      !/Failed to load resource|EventSource|net::ERR|Content Security Policy|cloudflareinsights/.test(t)
    )
      errors.push(`console: ${t}`);
  });
  return errors;
}

test("full studio flow in the browser (mock AI)", async ({ page }) => {
  const errors = watchErrors(page);

  await test.step("register", async () => {
    await page.goto("/app/register");
    await page.getByLabel("Username").fill(user.username);
    await page.getByLabel("Email").fill(user.email);
    await page.getByLabel("Password (min 10 characters)").fill(user.password);
    await page.getByLabel("Confirm password").fill(user.password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  });

  await test.step("logout and login with username", async () => {
    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await page.getByLabel("Username or email").fill(user.username);
    await page.getByLabel("Password").fill(user.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "Projects", exact: true })).toBeVisible();
  });

  await test.step("wizard: create project, analyze, review, apply", async () => {
    await page.getByRole("link", { name: "New project" }).click();
    await page.getByLabel("Title").fill(`E2E ${id}`);
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel(/Paste your story/).fill(STORY);
    await page.getByRole("button", { name: /Create & analyze/ }).click();
    await page.getByRole("button", { name: "Review" }).click({ timeout: 60_000 });
    await expect(page.getByRole("heading", { name: /Characters \(/ })).toBeVisible();
    await page.getByRole("button", { name: /Apply to project/ }).click();
    await expect(page.getByRole("heading", { name: "Production pipeline" })).toBeVisible({ timeout: 30_000 });
  });

  const projectUrl = page.url().replace(/\/$/, "");

  await test.step("cast: generate a full-resolution reference and approve it", async () => {
    await page.goto(`${projectUrl}/cast`);
    await page.getByText("Woo Jin", { exact: true }).first().click();
    await expect(page.getByText("Appearance v1")).toBeVisible();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    const approve = page.getByRole("button", { name: "Approve", exact: true }).last();
    await expect(async () => {
      await expect(page.getByRole("img", { name: /portrait|reference/i }).first()).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 60_000 });
    await approve.click();
    await expect(page.getByText(/prompt ref/i).first()).toBeVisible({ timeout: 15_000 });
  });

  await test.step("chapters: plan the chapter", async () => {
    await page.goto(`${projectUrl}/chapters`);
    await page.getByRole("button", { name: "Plan chapter" }).first().click();
    await expect(async () => {
      await page.goto(`${projectUrl}/pages`);
      await expect(page.getByRole("link", { name: "Open page 1 in editor" })).toBeVisible({ timeout: 3000 });
    }).toPass({ timeout: 60_000 });
  });

  await test.step("page editor: select panel, generate, versions, add bubble", async () => {
    await page.getByRole("link", { name: "Open page 1 in editor" }).click();
    await expect(page.getByLabel("Page canvas")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("tab", { name: "Panel" }).click();
    await page.locator("aside button, [role=tabpanel] button").filter({ hasText: /^1/ }).first().click();
    await page.getByRole("tab", { name: "Prompt" }).click();
    await page
      .getByRole("button", { name: /^(Generate|Regenerate)$/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Versions" }).click();
    await expect(
      page
        .getByRole("img")
        .filter({ hasNot: page.locator("canvas") })
        .first(),
    ).toBeVisible({ timeout: 60_000 });
    await page.getByRole("tab", { name: "Lettering" }).click();
    await page.getByLabel("New bubble text").fill("Who's there?");
    await page
      .getByRole("button", { name: /Add bubble/ })
      .first()
      .click();
    await expect(page.getByText("Who's there?").first()).toBeVisible();
  });

  await test.step("every screen renders without crashing", async () => {
    for (const path of [
      "",
      "/story",
      "/cast",
      "/world",
      "/chapters",
      "/pages",
      "/generation",
      "/narration",
      "/assets",
      "/exports",
      "/usage",
      "/settings",
    ]) {
      await page.goto(`${projectUrl}${path}`);
      await expect(page.locator("main")).toBeVisible();
      await page.waitForTimeout(800);
      await expect(page.getByText("Something went wrong")).toHaveCount(0);
    }
    for (const path of ["/app/usage", "/app/account", "/app/admin", "/app/"]) {
      await page.goto(path);
      await page.waitForTimeout(500);
    }
  });

  await test.step("generation inspector shows compiled prompt", async () => {
    await page.goto(`${projectUrl}/generation`);
    await page.getByRole("link", { name: "Panel", exact: true }).first().click();
    await expect(page.getByText("STRICT EXCLUSIONS:").first()).toBeVisible();
  });

  await test.step("exports: queue a page export and see it complete", async () => {
    await page.goto(`${projectUrl}/exports`);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    // Only one panel was generated earlier, so the readiness check blocks and asks to confirm.
    // Auto-waits for the dialog rather than probing before the request has come back.
    await page
      .getByRole("button", { name: "Export anyway" })
      .click({ timeout: 15_000 })
      .catch(() => {});
    await expect(page.getByText(/completed/i).first()).toBeVisible({ timeout: 60_000 });
  });

  expect(errors, errors.join("\n")).toEqual([]);
});
