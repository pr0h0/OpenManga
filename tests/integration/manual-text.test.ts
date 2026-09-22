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

test("pasting a provider's own answer into another project produces the same result", async () => {
  // The claim under test: a pasted answer is not a second-class input. So run one project through the provider,
  // take the exact answer it gave, paste it into a second project, and compare what each produced.
  const mk = async (title: string) => {
    const p = await alice.post<{ project: { id: string } }>("/api/projects", { title, story: { content: STORY } }, 201);
    const s = await alice.get<{ latest: { id: string } }>(`/api/projects/${p.project.id}/story`);
    return { projectId: p.project.id, revisionId: s.latest.id };
  };
  const shape = async (projectId: string) => {
    const [analysis] = await h.deps.db.select().from(storyAnalyses).where(eq(storyAnalyses.projectId, projectId));
    await alice.post(`/api/story-analyses/${analysis!.id}/apply`, {});
    const cast = await alice.get<{ characters: { name: string; role: string }[] }>(
      `/api/projects/${projectId}/characters`,
    );
    const chapters = await alice.get<{ chapters: { order: number; title: string }[] }>(
      `/api/projects/${projectId}/chapters`,
    );
    return {
      result: analysis!.result,
      characters: cast.characters.map((c) => `${c.role}:${c.name}`).sort(),
      chapters: chapters.chapters.map((c) => `${c.order}:${c.title}`).sort(),
    };
  };

  // A: the ordinary path, answered by the provider.
  const a = await mk("Answered by the provider");
  const aJob = await alice.post<{ job: { id: string } }>(`/api/story-revisions/${a.revisionId}/analyze`, {}, 202);
  await waitFor(
    async () => {
      const [row] = await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, aJob.job.id));
      return row?.status === "completed" ? row : null;
    },
    { label: "provider-answered analysis", timeoutMs: 30_000 },
  );
  const first = await shape(a.projectId);

  // B: the same story, keyless, answered by pasting exactly what A's provider returned.
  const b = await mk("Answered by hand");
  const bJob = await alice.post<{ job: { id: string } }>(
    `/api/story-revisions/${b.revisionId}/analyze`,
    { ai: { manual: true } },
    202,
  );
  jobId = bJob.job.id;
  await waitForStatus("awaiting_input", "second project parked");
  await alice.post(`/api/generations/${bJob.job.id}/manual`, { text: JSON.stringify(first.result) }, 202);
  await waitForStatus("completed", "second project finished from the paste");
  const second = await shape(b.projectId);

  expect(second.result).toEqual(first.result);
  expect(second.characters).toEqual(first.characters);
  expect(second.chapters).toEqual(first.chapters);
  expect(second.characters.length).toBeGreaterThan(0);
});
