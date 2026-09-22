import { afterAll, beforeAll, expect, test } from "bun:test";
import { aiUsage, eq, generationJobs, storyAnalyses } from "@openmanga/db";
import { mockStoryAnalysis } from "@openmanga/testing";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let jobId: string;

const STORY = `Ines repairs lighthouses that nobody visits any more.
The keeper at Vell says the lamp turns by itself on the nights he forgets to wind it.
She stays awake to watch, and at three in the morning the lamp turns.
Ines writes the hour in her notebook and decides not to fix what is already working.`;

type ManualView = {
  jobId: string;
  kind: string;
  status: string;
  prompt: string;
  awaitingAnswer: boolean;
  lastError: string | null;
};
const jobStatus = async () => {
  const [row] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  return row!;
};
const waitForStatus = (status: string, label: string) =>
  waitFor(async () => ((await jobStatus()).status === status ? await jobStatus() : null), { label, timeoutMs: 30_000 });

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "handwritten", email: "hand@example.com", password: "pasted-pass-12" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>(
    "/api/projects",
    { title: "No Keys At All", story: { content: STORY } },
    201,
  );
  projectId = p.project.id;
});
afterAll(() => h?.stop());

test("a keyless run parks with the prompt a provider would have been sent", async () => {
  const story = await alice.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const started = await alice.post<{ job: { id: string } }>(
    `/api/story-revisions/${story.latest.id}/analyze`,
    { ai: { manual: true } },
    202,
  );
  jobId = started.job.id;
  const parked = await waitForStatus("awaiting_input", "job parked for a pasted answer");
  // Nothing was sent anywhere, so the run is recorded against no provider and holds no worker slot.
  expect(parked.provider).toBe("manual");

  const view = await alice.get<ManualView>(`/api/generations/${jobId}/manual`);
  expect(view.awaitingAnswer).toBe(true);
  expect(view.lastError).toBeNull();
  // The prompt is the handler's own, so it carries the schema the answer has to satisfy — which is the part that
  // makes pasting into an ordinary chat work at all.
  expect(view.prompt.length).toBeGreaterThan(200);
  expect(view.prompt).toContain("StoryAnalysis");
});

test("an answer that does not fit the schema is rejected, with the reason, and can be pasted again", async () => {
  await alice.post(`/api/generations/${jobId}/manual`, { text: '{"not": "a story analysis"}' }, 202);
  const reparked = await waitForStatus("awaiting_input", "job parked again after a bad answer");
  expect(reparked.failureReason).toContain("Invalid StoryAnalysis");

  const view = await alice.get<ManualView>(`/api/generations/${jobId}/manual`);
  expect(view.awaitingAnswer).toBe(true);
  expect(view.lastError).toContain("Invalid StoryAnalysis");
  // The rejected answer is gone rather than kept and retried, so the next paste is a fresh attempt.
  expect((reparked.parameters as { manualAnswer?: unknown }).manualAnswer).toBeUndefined();
});

test("a valid pasted answer finishes the job exactly as a provider's would", async () => {
  await alice.post(`/api/generations/${jobId}/manual`, { text: JSON.stringify(mockStoryAnalysis(STORY)) }, 202);
  const done = await waitForStatus("completed", "job finished from the pasted answer");
  expect(done.failureReason).toBeNull();

  // The analysis is a real, reviewable analysis — not a special kind of record.
  const [analysis] = await h.deps.db.select().from(storyAnalyses).where(eq(storyAnalyses.projectId, projectId));
  expect(analysis!.status).toBe("completed");
  expect((analysis!.result as { characters: unknown[] }).characters.length).toBeGreaterThan(0);

  // And it applies through the ordinary route, creating the same entities an API answer would have.
  await alice.post(`/api/story-analyses/${analysis!.id}/apply`, {});
  const chapters = await alice.get<{ chapters: unknown[] }>(`/api/projects/${projectId}/chapters`);
  expect(chapters.chapters.length).toBeGreaterThan(0);
});

test("nothing was billed, because nothing was sent", async () => {
  const usage = await h.deps.db.select().from(aiUsage).where(eq(aiUsage.projectId, projectId));
  expect(usage.every((u) => Number(u.estimatedCostUsd ?? 0) === 0)).toBe(true);
  expect(usage.every((u) => u.textInputTokens === 0 && u.textOutputTokens === 0)).toBe(true);
});

test("a job that is not a manual run has no prompt to answer", async () => {
  const story = await alice.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const real = await alice.post<{ job: { id: string } }>(`/api/story-revisions/${story.latest.id}/analyze`, {}, 202);
  const res = await alice.raw("GET", `/api/generations/${real.job.id}/manual`);
  expect(res.status).toBe(409);
});
