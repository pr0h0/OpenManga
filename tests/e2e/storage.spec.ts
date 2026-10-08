import { type Browser, expect, type Page, test } from "@playwright/test";
import { api, expectNoErrors, watchErrors } from "./helpers.ts";

// The server's storage policy, as an administrator: the warning an approve-mode policy puts on every page (no way to
// dismiss it), Review leading to Admin → Storage, and turning the policy off clearing it. Approve mode deletes nothing
// on its own, so the other specs' files are safe.

const username = process.env.E2E_ADMIN_USERNAME;
const password = process.env.E2E_ADMIN_PASSWORD;
let page: Page;
let errors: string[];

test.skip(!username || !password, "needs E2E_ADMIN_USERNAME and E2E_ADMIN_PASSWORD (the e2e workflow sets them)");

test.beforeAll(async ({ browser }: { browser: Browser }) => {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 1600, height: 1000 },
  });
  page = await context.newPage();
  errors = watchErrors(page);
  await api(page).post("/auth/login", { identifier: username, password });
});
test.afterAll(async () => {
  // Whatever happened above, leave no policy behind for the other specs.
  await api(page)
    .put("/admin/storage/policy", { enabled: false, maxAgeDays: 30, maxTotalGb: 100, mode: "approve" })
    .catch(() => {});
  await page?.context().close();
});
test.afterEach(() => expectNoErrors(errors));

test("an approve policy's warning stays on every page until the policy is resolved", async () => {
  await page.goto("/app/admin?tab=storage");
  await expect(page.getByRole("heading", { name: "Storage policy" })).toBeVisible();
  await expect(page.getByText(/stored, .* of it expendable/)).toBeVisible();

  await test.step("a size limit far below what is stored, asking first", async () => {
    await page.getByLabel("Apply a storage policy").check();
    await page.getByLabel("Delete files older than (days)").fill("");
    await page.getByLabel("Keep total storage under (GB)").fill("0.000001");
    await page.getByLabel("Ask me first").check();
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText("Storage policy saved")).toBeVisible();
  });

  await test.step("the warning is on every page, with no way to dismiss it", async () => {
    for (const path of ["/app/", "/app/account", "/app/usage"]) {
      await page.goto(path);
      const alert = page.getByRole("alert").filter({ hasText: /over the limit|due for deletion/ });
      await expect(alert).toBeVisible();
      await expect(alert.getByRole("button")).toHaveCount(0);
      await expect(alert.getByRole("link", { name: "Review" })).toBeVisible();
    }
  });

  await test.step("Review opens Admin → Storage; turning the policy off clears it", async () => {
    await page.getByRole("alert").getByRole("link", { name: "Review" }).click();
    await expect(page).toHaveURL(/\/admin\?tab=storage/);
    await expect(page.getByRole("heading", { name: "Storage policy" })).toBeVisible();
    await page.getByLabel("Apply a storage policy").uncheck();
    await page.getByRole("button", { name: "Save policy" }).click();
    await expect(page.getByText("Storage policy saved")).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: /over the limit|due for deletion/ })).toHaveCount(0);
  });
});
