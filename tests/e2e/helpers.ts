import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";

/** A short story that analyses into one chapter with two named characters under mock AI. */
export const STORY = `Chapter 1: The Rooftop

Rain hammered the city as Woo Jin climbed onto the rooftop. Woo Jin pulled his jacket tighter.
Footsteps echoed from the stairwell. "Who's there?" Woo Jin asked.
Kim Do-yun stepped out of the shadows. Kim Do-yun smiled.
"You shouldn't have come alone," Kim Do-yun said. The door slammed shut with a BANG.`;

/** Collect uncaught page errors and app console errors (ignores third-party injections such as CDN beacons). */
export function watchErrors(page: Page) {
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

/** JSON API calls with the browser context's session and CSRF cookie, as the SPA makes them. */
export function api(page: Page) {
  const req: APIRequestContext = page.request;
  const csrf = async () => (await page.context().cookies()).find((c) => c.name === "om_csrf")?.value;
  const call = async <T>(method: string, path: string, data?: unknown): Promise<T> => {
    const headers: Record<string, string> = {};
    if (method !== "GET") {
      if (!(await csrf())) await req.get("/api/auth/me");
      const token = await csrf();
      if (token) headers["x-csrf-token"] = decodeURIComponent(token);
    }
    const r = await req.fetch(`/api${path}`, { method, headers, data });
    if (!r.ok()) throw new Error(`${method} ${path} → ${r.status()} ${await r.text()}`);
    return (r.status() === 204 ? null : await r.json()) as T;
  };
  return {
    // biome-ignore lint/suspicious/noExplicitAny: test helper; callers that read the body name its type
    get: <T = any>(path: string) => call<T>("GET", path),
    // biome-ignore lint/suspicious/noExplicitAny: as above
    post: <T = any>(path: string, data: unknown = {}) => call<T>("POST", path, data),
    // biome-ignore lint/suspicious/noExplicitAny: as above
    patch: <T = any>(path: string, data: unknown = {}) => call<T>("PATCH", path, data),
  };
}
export type Api = ReturnType<typeof api>;

/** Register a fresh user through the API; the session cookie lands in the page's context. */
export async function signUp(page: Page, prefix: string) {
  const id = `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  const user = { username: id, email: `${id}@example.com`, password: "e2e-password-123" };
  await api(page).post("/auth/register", user);
  return user;
}

/**
 * A signed-in page shared by the tests of a file (made in `beforeAll`), so the file seeds its project once.
 * `errors` collects page errors; `afterEach` checks and clears it.
 */
export async function sharedPage(browser: Browser, prefix: string) {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: { width: 1600, height: 1000 },
  });
  const page = await context.newPage();
  const errors = watchErrors(page);
  const user = await signUp(page, prefix);
  return { page, errors, user };
}

/** Fail the test on page errors collected since the last check. */
export function expectNoErrors(errors: string[]) {
  const seen = errors.splice(0);
  expect(seen, seen.join("\n")).toEqual([]);
}

/** Poll `fn` until it returns something truthy. */
export async function until<T>(fn: () => Promise<T | null | undefined | false>, label: string, timeoutMs = 120_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/** Reload until `check` passes: for screens that do not poll for the result of a job they started. */
export async function eventually(page: Page, check: () => Promise<void>, timeout = 90_000) {
  await expect(async () => {
    try {
      await check();
    } catch (e) {
      await page.reload();
      throw e;
    }
  }).toPass({ timeout, intervals: [2000, 3000, 5000] });
}

/** Wait for a generation job to finish. */
export const jobDone = (a: Api, id: string) =>
  until(async () => {
    const { job } = await a.get<{ job: { status: string; failureReason?: string } }>(`/generations/${id}`);
    if (job.status === "failed") throw new Error(`job ${id} failed: ${job.failureReason}`);
    return job.status === "completed" ? job : null;
  }, `job ${id}`);

type Run = { id: string; status: string; reason: string | null; steps: { key: string; status: string }[] };

/** The latest production run of a project once it settles into one of `want`. */
export function runSettles(a: Api, projectId: string, want: string[], timeoutMs = 240_000) {
  return until(
    async () => {
      const { runs } = await a.get<{ runs: Run[] }>(`/projects/${projectId}/production-runs`);
      const run = runs[0];
      if (run && want.includes(run.status)) return run;
      if (run?.status === "failed") throw new Error(`run failed: ${run.reason}`);
      return null;
    },
    `run ${want.join("/")}`,
    timeoutMs,
  );
}

type Seed = { projectId: string; chapterId: string; pageId: string; url: string };

async function seedOf(a: Api, projectId: string): Promise<Seed> {
  const { chapters } = await a.get<{ chapters: { id: string }[] }>(`/projects/${projectId}/chapters`);
  const detail = await a.get<{ pages: { id: string }[] }>(`/chapters/${chapters[0]!.id}`);
  return { projectId, chapterId: chapters[0]!.id, pageId: detail.pages[0]!.id, url: `/app/projects/${projectId}` };
}

/**
 * A project produced end to end by a production run with mock AI: analysed, cast drawn, one chapter planned, drawn,
 * narrated and voiced. About a minute (the API advances runs on a 10 s timer), so a file makes one and shares it.
 */
export async function seedProducedProject(page: Page, title: string, story = STORY) {
  const a = api(page);
  const { project } = await a.post<{ project: { id: string } }>("/projects", {
    title,
    story: { content: story, inputKind: "story" },
  });
  await a.patch(`/projects/${project.id}`, { settings: { budgetUsd: 50 } });
  await a.post(`/projects/${project.id}/production-runs`, { reviewGates: false, render: false, youtube: false });
  await runSettles(a, project.id, ["completed", "completed_with_warnings"]);
  return seedOf(a, project.id);
}

/** A project with its story analysed and applied and its first chapter planned (no art, no narration): seconds. */
export async function seedPlannedProject(page: Page, title: string, story = STORY) {
  const a = api(page);
  const { project } = await a.post<{ project: { id: string } }>("/projects", {
    title,
    story: { content: story, inputKind: "story" },
  });
  const { latest } = await a.get<{ latest: { id: string } }>(`/projects/${project.id}/story`);
  const an = await a.post<{ job: { id: string }; analysis: { id: string } }>(`/story-revisions/${latest.id}/analyze`);
  await jobDone(a, an.job.id);
  await a.post(`/story-analyses/${an.analysis.id}/apply`);
  const { chapters } = await a.get<{ chapters: { id: string }[] }>(`/projects/${project.id}/chapters`);
  const plan = await a.post<{ job: { id: string } }>(`/chapters/${chapters[0]!.id}/plan`);
  await jobDone(a, plan.job.id);
  return seedOf(a, project.id);
}

/** The project's panels on its first page, in order. */
export async function firstPagePanels(a: Api, pageId: string) {
  const r = await a.get<{ panels: { id: string }[] }>(`/pages/${pageId}`);
  return r.panels;
}
