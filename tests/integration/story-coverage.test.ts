import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;

const STORY = `Chapter 1: The Lamp

Ines rowed out to Vell as the light came on by itself.

Tomas met her on the jetty and said the lamp had a mind of its own. [[mock:twice]]

Ines found a second logbook hidden under the stairs, written in a hand she knew. [[mock:skip]]

Chapter 2: The Storm

The storm hit Vell at midnight and Ines climbed to the lamp room.

At three in the morning the lamp turned, and Tomas smiled.`;

type Job = { id: string; status: string };
type Coverage = {
  report: {
    storyRevisionId: string;
    parts: number;
    findings: {
      kind: string;
      severity: string;
      spans: { start: number; end: number; paragraphs: string[]; excerpt: string }[];
      chapterIds: string[];
    }[];
    shares: { chapterId: string; sourceShare: number; panelShare: number }[];
  } | null;
  stale: { story: boolean; plan: boolean } | null;
  running: Job | null;
  chapters: { id: string; order: number }[];
};

const done = (id: string, statuses = ["completed", "failed"]) =>
  waitFor(
    async () => {
      const r = await alice.get<{ job: Job & { failureReason: string | null } }>(`/api/generations/${id}`);
      return statuses.includes(r.job.status) ? r.job : null;
    },
    { label: `job ${id}`, timeoutMs: 60_000 },
  );

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "reader", email: "cov@example.com", password: "cover-pass-12" },
    201,
  );
  ({
    project: { id: projectId },
  } = await alice.post<{ project: { id: string } }>(
    "/api/projects",
    { title: "Coverage", story: { content: STORY } },
    201,
  ));
});
afterAll(() => h?.stop());

test("coverage needs an applied story", async () => {
  await alice.post(`/api/projects/${projectId}/story/coverage`, {}, 409);
  expect((await alice.get<Coverage>(`/api/projects/${projectId}/story/coverage`)).report).toBeNull();
});

test("left out, told twice and shares, each linked to its source span and chapter", async () => {
  const story = await alice.get<{ latest: { id: string; content: string } }>(`/api/projects/${projectId}/story`);
  const a = await alice.post<{ job: Job; analysis: { id: string } }>(
    `/api/story-revisions/${story.latest.id}/analyze`,
    {},
    202,
  );
  expect((await done(a.job.id)).status).toBe("completed");
  await alice.post(`/api/story-analyses/${a.analysis.id}/apply`, {});
  const { chapters } = await alice.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
  expect(chapters.length).toBe(2);
  for (const ch of chapters) {
    const p = await alice.post<{ job: Job }>(`/api/chapters/${ch.id}/plan`, {}, 202);
    expect((await done(p.job.id)).status).toBe("completed");
  }

  const r = await alice.post<{ job: Job }>(`/api/projects/${projectId}/story/coverage`, {}, 202);
  const job = await done(r.job.id);
  expect(job.status).toBe("completed");
  const cov = await alice.get<Coverage>(`/api/projects/${projectId}/story/coverage`);
  const report = cov.report!;
  expect(report.storyRevisionId).toBe(story.latest.id);
  expect(cov.stale).toEqual({ story: false, plan: false });

  const left = report.findings.find((f) => f.kind === "left_out")!;
  expect(left.severity).toBe("high");
  // The span is the paragraph itself, by its offsets in the revision.
  const span = left.spans[0]!;
  expect(story.latest.content.slice(span.start, span.end)).toStartWith("Ines found a second logbook");
  expect(span.excerpt).toBe(story.latest.content.slice(span.start, span.end));

  const twice = report.findings.find((f) => f.kind === "repeated")!;
  expect(twice.chapterIds.sort()).toEqual(chapters.map((c) => c.id).sort());
  expect(story.latest.content.slice(twice.spans[0]!.start, twice.spans[0]!.end)).toContain("Tomas met her");

  expect(report.shares.map((s) => s.chapterId).sort()).toEqual(chapters.map((c) => c.id).sort());
  expect(report.shares.reduce((n, s) => n + s.panelShare, 0)).toBeCloseTo(1, 5);
});

test("paste mode asks one question per part and holds every answer to its paragraphs", async () => {
  const r = await alice.post<{ job: Job }>(`/api/projects/${projectId}/story/coverage`, { ai: { manual: true } }, 202);
  await done(r.job.id, ["awaiting_input"]);
  const view = await alice.get<{ prompt: string; format: { name: string } }>(`/api/generations/${r.job.id}/manual`);
  expect(view.format.name).toBe("StoryCoverageMap");
  expect(view.prompt).toContain("[P1]");
  // An answer that leaves a paragraph out is sent back with the missing keys.
  await alice.post(
    `/api/generations/${r.job.id}/manual`,
    { text: JSON.stringify({ paragraphs: [{ paragraph: "P1", weight: 3, coveredBy: ["C1"] }] }) },
    202,
  );
  const again = await done(r.job.id, ["awaiting_input"]);
  expect((again as { failureReason: string | null }).failureReason).toContain("missing");
  const keys = [...view.prompt.matchAll(/\[(P\d+)\]/g)].map((m) => m[1]!);
  await alice.post(
    `/api/generations/${r.job.id}/manual`,
    {
      text: JSON.stringify({
        paragraphs: [...new Set(keys)].map((k) => ({ paragraph: k, weight: 2, coveredBy: ["C1"] })),
      }),
    },
    202,
  );
  expect((await done(r.job.id)).status).toBe("completed");
  const cov = await alice.get<Coverage>(`/api/projects/${projectId}/story/coverage`);
  // Everything told by chapter 1: chapter 2 has panels for none of the story.
  expect(cov.report!.findings.some((f) => f.kind === "more_room")).toBe(true);
  expect(cov.report!.findings.some((f) => f.kind === "left_out")).toBe(false);
});
