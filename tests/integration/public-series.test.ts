import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, letteringTranslations } from "@openmanga/db";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: Rooftop

Woo Jin climbed onto the rooftop in the rain. "Who's there?" Woo Jin asked.

Chapter 2: Alley

Kim Do-yun waited in the alley below, smiling.`;

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let anon: TestClient;
let seriesId: string;
let projectId: string;
let ch1: string;
let ch2: string;

type Pub = {
  series: { title: string; cover: string | null; links: { feed: string; share: string } };
  languages: string[];
  episodes: { number: number; chapters: { id: string; available: boolean; publishAt: string }[] }[];
};

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  anon = h.client();
  await u.post("/api/auth/register", { username: "pub", email: "pu@example.com", password: "pub-pass-12345" }, 201);
  seriesId = (
    await u.post<{ series: { id: string } }>(
      "/api/series",
      { title: "Rain City", description: "Two strangers, one rooftop." },
      201,
    )
  ).series.id;
  projectId = (
    await u.post<{ project: { id: string } }>(
      `/api/series/${seriesId}/episodes`,
      { title: "Night one", story: { content: STORY, inputKind: "story" } },
      201,
    )
  ).project.id;
  const { latest } = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const a = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${latest.id}/analyze`,
    {},
    202,
  );
  const done = (id: string) =>
    waitFor(
      async () => {
        const r = await u.get<{ job: { status: string } }>(`/api/generations/${id}`);
        return ["completed", "failed"].includes(r.job.status) ? r.job : null;
      },
      { label: "job", timeoutMs: 60_000 },
    );
  await done(a.job.id);
  await u.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
  const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
  [ch1, ch2] = [chapters[0]!.id, chapters[1]!.id];
  await done((await u.post<{ job: { id: string } }>(`/api/chapters/${ch1}/plan`, {}, 202)).job.id);
}, 120_000);
afterAll(() => h?.stop());

test("a series' reader page is off until turned on; unlisted makes an unguessable address", async () => {
  const off = await u.get<{ series: { visibility: string; publicSlug: string | null } }>(`/api/series/${seriesId}`);
  expect(off.series.visibility).toBe("off");
  const on = await u.patch<{ series: { publicSlug: string } }>(`/api/series/${seriesId}`, { visibility: "unlisted" });
  expect(on.series.publicSlug).toMatch(/^[a-z0-9x]{12}$/);
  await u.patch(`/api/series/${seriesId}`, { publicSlug: "rain-city" });
  // Another series cannot take the address.
  const other = (await u.post<{ series: { id: string } }>("/api/series", { title: "Other" }, 201)).series.id;
  await u.patch(`/api/series/${other}`, { visibility: "public", publicSlug: "rain-city" }, 409);
  await u.patch(`/api/series/${other}`, { publicSlug: "Bad slug!" }, 422);
  // Nothing is published yet.
  const pub = await anon.get<Pub>("/api/public/series/rain-city");
  expect(pub.series.title).toBe("Rain City");
  expect(pub.episodes[0]!.chapters).toEqual([]);
});

test("published chapters are readable, scheduled ones listed without their pages, in every translated language", async () => {
  await u.patch(`/api/chapters/${ch1}`, { publishAt: new Date(Date.now() - 60_000).toISOString() });
  const later = new Date(Date.now() + 7 * 86_400_000).toISOString();
  await u.patch(`/api/chapters/${ch2}`, { publishAt: later });
  await h.deps.db.insert(letteringTranslations).values({
    projectId,
    sourceType: "dialogue",
    sourceId: crypto.randomUUID(),
    language: "es",
    text: "¿Quién está ahí?",
    sourceSha256: "x",
  });
  const pub = await anon.get<Pub>("/api/public/series/RAIN-CITY");
  expect(pub.languages).toEqual(["en", "es"]);
  expect(pub.episodes[0]!.chapters.map((c) => [c.id, c.available])).toEqual([
    [ch1, true],
    [ch2, false],
  ]);
  const view = await anon.get<{ pages: { id: string }[]; next: string | null }>(
    `/api/public/series/rain-city/chapters/${ch1}`,
  );
  expect(view.pages.length).toBeGreaterThan(0);
  expect(view.next).toBeNull();
  await anon.get(`/api/public/series/rain-city/chapters/${ch2}`, 404);
  const png = await anon.raw(
    "GET",
    `/api/public/series/rain-city/pages/${view.pages[0]!.id}.png?width=400&language=es`,
  );
  expect(png.status).toBe(200);
  expect(png.headers.get("content-type")).toBe("image/png");
  // The feed lists what is out, not what is coming.
  const feed = await (await anon.raw("GET", "/api/public/series/rain-city/feed.xml")).text();
  expect(feed).toContain("<title>Rain City</title>");
  expect(feed).toContain(`<guid isPermaLink="false">${ch1}</guid>`);
  expect(feed).not.toContain(ch2);
});

test("the social preview page: title, description, feed; unlisted kept out of search engines", async () => {
  const html = await anon.raw("GET", "/s/rain-city");
  expect(html.status).toBe(200);
  expect(html.headers.get("x-robots-tag")).toBe("noindex");
  const text = await html.text();
  expect(text).toContain('<meta property="og:title" content="Rain City">');
  expect(text).toContain('content="Two strangers, one rooftop."');
  expect(text).toContain('<meta name="robots" content="noindex">');
  expect(text).toContain("feed.xml");
  await u.patch(`/api/series/${seriesId}`, { visibility: "public" });
  const pub = await anon.raw("GET", "/s/rain-city");
  expect(pub.headers.get("x-robots-tag")).toBeNull();
  expect(await pub.text()).not.toContain("noindex");
  // Off: gone for readers.
  await u.patch(`/api/series/${seriesId}`, { visibility: "off" });
  await anon.get("/api/public/series/rain-city", 404);
  expect((await anon.raw("GET", "/s/rain-city")).status).toBe(404);
});
