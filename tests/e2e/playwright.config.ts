import { defineConfig, devices } from "@playwright/test";

/** E2E runs against a running stack (docker compose) with mock AI providers by default. */
export default defineConfig({
  testDir: ".",
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  outputDir: process.env.E2E_OUTPUT_DIR ?? "./test-results",
  // E2E_HTML_REPORT adds the HTML report (CI uploads it when a run fails); outside the output dir, which is cleared.
  reporter: process.env.E2E_HTML_REPORT
    ? [["list"], ["html", { outputFolder: process.env.E2E_HTML_REPORT, open: "never" }]]
    : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3480",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport: { width: 1600, height: 1000 },
    ignoreHTTPSErrors: false,
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 } } }],
});
