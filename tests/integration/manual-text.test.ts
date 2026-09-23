import { afterAll, beforeAll, expect, test } from "bun:test";
import { aiUsage, eq, generationJobs, narrationLines, storyAnalyses } from "@openmanga/db";
import { mockImagePng, mockStoryAnalysis, mockTextCompletion } from "@openmanga/testing";
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
  expect((reparked.parameters as { manualAnswers?: unknown[] }).manualAnswers).toEqual([]);
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

/**
 * Stands in for the chat a person pastes the prompt into: split the copied prompt back into its messages, answer
 * them the way the mock model would, and hand back the reply as text. Nothing here is special to the test — it is
 * copy, answer, paste.
 */
const chat = (prompt: string) => {
  const messages = [
    ...prompt.matchAll(/^### (system|user|assistant)\n([\s\S]*?)(?=\n\n### (?:system|user|assistant)\n|$(?![\s\S]))/gm),
  ].map((m) => ({ role: m[1]!, content: m[2]! }));
  return JSON.stringify(mockTextCompletion(messages));
};

test("a chapter planned scene by scene parks once per call, and each paste answers its own prompt", async () => {
  // Planning makes an outline call and then one call per scene. Each has its own prompt and its own schema, so a
  // keyless plan is a sequence of pastes — and an answer must never be replayed into a call it was not given for.
  const p = await alice.post<{ project: { id: string } }>(
    "/api/projects",
    { title: "Planned By Hand", story: { content: STORY } },
    201,
  );
  const s = await alice.get<{ latest: { id: string } }>(`/api/projects/${p.project.id}/story`);
  const an = await alice.post<{ job: { id: string } }>(
    `/api/story-revisions/${s.latest.id}/analyze`,
    { ai: { manual: true } },
    202,
  );
  jobId = an.job.id;
  await waitForStatus("awaiting_input", "analysis parked");
  await alice.post(`/api/generations/${jobId}/manual`, { text: chat((await jobStatus()).compiledPrompt!) }, 202);
  await waitForStatus("completed", "analysis answered");
  const [analysis] = await h.deps.db.select().from(storyAnalyses).where(eq(storyAnalyses.projectId, p.project.id));
  await alice.post(`/api/story-analyses/${analysis!.id}/apply`, {});
  const chapters = await alice.get<{ chapters: { id: string }[] }>(`/api/projects/${p.project.id}/chapters`);

  const plan = await alice.post<{ job: { id: string } }>(
    `/api/chapters/${chapters.chapters[0]!.id}/plan`,
    { ai: { manual: true } },
    202,
  );
  jobId = plan.job.id;
  const asked: string[] = [];
  for (let turn = 0; turn < 20; turn++) {
    const row = await waitFor(
      async () => {
        const r = await jobStatus();
        return ["awaiting_input", "completed", "failed"].includes(r.status) ? r : null;
      },
      { label: `plan turn ${turn}`, timeoutMs: 30_000 },
    );
    if (row.status !== "awaiting_input") break;
    // Every park must be a fresh question, never a rejection of the previous answer.
    expect(row.failureReason).toBeNull();
    asked.push(row.compiledPrompt!.match(/\[template:([a-z-]+)-v\d+\]/)?.[1] ?? "?");
    await alice.post(`/api/generations/${jobId}/manual`, { text: chat(row.compiledPrompt!) }, 202);
  }

  const done = await jobStatus();
  expect(done.status).toBe("completed");
  // The outline first, then one scene-pages call per scene it named.
  expect(asked[0]).toBe("chapter-outline");
  expect(asked.length).toBeGreaterThan(1);
  expect(asked.slice(1).every((t) => t === "scene-pages")).toBe(true);
  const pageRows = await alice.get<{ pages: unknown[] }>(`/api/chapters/${chapters.chapters[0]!.id}`);
  expect(pageRows.pages.length).toBeGreaterThan(0);
}, 120_000);

/** Starts a keyless analysis on a fresh project and waits for it to park. */
const parkedAnalysis = async (title: string) => {
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title, story: { content: STORY } }, 201);
  const s = await alice.get<{ latest: { id: string } }>(`/api/projects/${p.project.id}/story`);
  const j = await alice.post<{ job: { id: string } }>(
    `/api/story-revisions/${s.latest.id}/analyze`,
    { ai: { manual: true } },
    202,
  );
  jobId = j.job.id;
  await waitForStatus("awaiting_input", `${title} parked`);
  return { projectId: p.project.id, jobId: j.job.id };
};

test("a parked job can be cancelled, and a retry starts fresh instead of replaying old answers", async () => {
  const { jobId: parked } = await parkedAnalysis("Cancelled While Waiting");
  // Give it one rejected answer and one accepted-shape answer history, so there is something a retry could leak.
  await h.deps.db
    .update(generationJobs)
    .set({ parameters: { manual: true, ai: { manual: true }, manualAnswers: ["stale answer"] } })
    .where(eq(generationJobs.id, parked));

  const cancelled = await alice.post<{ result: string }>(`/api/generations/${parked}/cancel`);
  expect(cancelled.result).toBe("cancelled");
  expect((await jobStatus()).status).toBe("cancelled");

  const retry = await alice.post<{ job: { id: string; parameters: Record<string, unknown> } }>(
    `/api/generations/${parked}/retry`,
    {},
    202,
  );
  expect(retry.job.parameters.manualAnswers).toBeUndefined();
  expect(retry.job.parameters.manual).toBe(true);
  jobId = retry.job.id;
  const again = await waitForStatus("awaiting_input", "retry parked fresh");
  // A fresh park, not a replay of "stale answer" failing validation.
  expect(again.failureReason).toBeNull();
});

test("a bad answer partway through a plan drops only itself, and the plan carries on", async () => {
  // The real shape of this failure: the outline was answered fine, then one scene's answer is wrong. The outline
  // answer must survive the rejection, or the user would have to start the whole chapter over.
  const p = await alice.post<{ project: { id: string } }>(
    "/api/projects",
    { title: "Bad Scene Answer", story: { content: STORY } },
    201,
  );
  const s = await alice.get<{ latest: { id: string } }>(`/api/projects/${p.project.id}/story`);
  const an = await alice.post<{ job: { id: string } }>(
    `/api/story-revisions/${s.latest.id}/analyze`,
    { ai: { manual: true } },
    202,
  );
  jobId = an.job.id;
  await waitForStatus("awaiting_input", "analysis parked");
  await alice.post(`/api/generations/${jobId}/manual`, { text: chat((await jobStatus()).compiledPrompt!) }, 202);
  await waitForStatus("completed", "analysis answered");
  const [analysis] = await h.deps.db.select().from(storyAnalyses).where(eq(storyAnalyses.projectId, p.project.id));
  await alice.post(`/api/story-analyses/${analysis!.id}/apply`, {});
  const chapters = await alice.get<{ chapters: { id: string }[] }>(`/api/projects/${p.project.id}/chapters`);

  const plan = await alice.post<{ job: { id: string } }>(
    `/api/chapters/${chapters.chapters[0]!.id}/plan`,
    { ai: { manual: true } },
    202,
  );
  jobId = plan.job.id;
  const outlinePrompt = (await waitForStatus("awaiting_input", "outline parked")).compiledPrompt!;
  await alice.post(`/api/generations/${jobId}/manual`, { text: chat(outlinePrompt) }, 202);
  const scenePark = await waitFor(
    async () => {
      const r = await jobStatus();
      return r.status === "awaiting_input" && r.compiledPrompt !== outlinePrompt ? r : null;
    },
    { label: "first scene parked", timeoutMs: 30_000 },
  );
  expect((scenePark.parameters as { manualAnswers: string[] }).manualAnswers).toHaveLength(1);

  // Wrong answer for the scene: the outline again, which does not fit ScenePages.
  await alice.post(`/api/generations/${jobId}/manual`, { text: chat(outlinePrompt) }, 202);
  const rejected = await waitFor(
    async () => {
      const r = await jobStatus();
      return r.status === "awaiting_input" && r.failureReason ? r : null;
    },
    { label: "scene answer rejected", timeoutMs: 30_000 },
  );
  expect(rejected.failureReason).toContain("Invalid ScenePages");
  // The prompt on screen after a rejection is the one that was answered wrongly — the scene's — not the outline,
  // which an earlier successful call in the same run would otherwise have left behind.
  expect(rejected.compiledPrompt).toBe(scenePark.compiledPrompt);
  // The outline answer survives; only the bad scene answer is gone.
  expect((rejected.parameters as { manualAnswers: string[] }).manualAnswers).toHaveLength(1);

  // And the plan carries on from where it was, to completion.
  for (let turn = 0; turn < 20; turn++) {
    const row = await waitFor(
      async () => {
        const r = await jobStatus();
        return ["awaiting_input", "completed", "failed"].includes(r.status) ? r : null;
      },
      { label: `resume turn ${turn}`, timeoutMs: 30_000 },
    );
    if (row.status !== "awaiting_input") break;
    await alice.post(`/api/generations/${jobId}/manual`, { text: chat(row.compiledPrompt!) }, 202);
  }
  expect((await jobStatus()).status).toBe("completed");
}, 120_000);

test("an answer wrapped in chat prose and a code fence is accepted", async () => {
  const { projectId: pid, jobId: parked } = await parkedAnalysis("Fenced Reply");
  const reply = `Sure! Here is the analysis you asked for:\n\n\`\`\`json\n${JSON.stringify(mockStoryAnalysis(STORY), null, 2)}\n\`\`\`\n\nLet me know if you want changes.`;
  await alice.post(`/api/generations/${parked}/manual`, { text: reply }, 202);
  await waitForStatus("completed", "fenced reply accepted");
  const [analysis] = await h.deps.db.select().from(storyAnalyses).where(eq(storyAnalyses.projectId, pid));
  expect(analysis!.status).toBe("completed");
});

test("an answer can be uploaded as a file instead of pasted", async () => {
  const { jobId: parked } = await parkedAnalysis("Uploaded Reply");
  const form = new FormData();
  form.set("file", new File([JSON.stringify(mockStoryAnalysis(STORY))], "answer.json", { type: "application/json" }));
  const res = await alice.raw("POST", `/api/generations/${parked}/manual`, form);
  expect(res.status).toBe(202);
  await waitForStatus("completed", "uploaded reply accepted");
});

test("someone else's parked job can be neither read nor answered", async () => {
  const { jobId: parked } = await parkedAnalysis("Alice Only");
  const bob = h.client();
  await bob.post("/api/auth/register", { username: "bobby", email: "bob@example.com", password: "bob-pass-1234" }, 201);
  const read = await bob.raw("GET", `/api/generations/${parked}/manual`);
  expect([403, 404]).toContain(read.status);
  const answer = await bob.raw("POST", `/api/generations/${parked}/manual`, { text: "{}" });
  expect([403, 404]).toContain(answer.status);
  // And Alice's job is untouched by the attempt.
  expect((await jobStatus()).status).toBe("awaiting_input");
});

test("an answer posted to a job that is not waiting is refused", async () => {
  const { jobId: parked } = await parkedAnalysis("Answered Twice");
  await alice.post(`/api/generations/${parked}/manual`, { text: JSON.stringify(mockStoryAnalysis(STORY)) }, 202);
  await waitForStatus("completed", "first answer");
  const second = await alice.raw("POST", `/api/generations/${parked}/manual`, { text: "{}" });
  expect(second.status).toBe(409);
});

test("a question about an image hands over the image, since a copied prompt cannot carry it", async () => {
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Describe By Hand" }, 201);
  const form = new FormData();
  form.set(
    "file",
    new File([await mockImagePng({ width: 64, height: 64, prompt: "ref" })], "ref.png", { type: "image/png" }),
  );
  form.set("aspects", JSON.stringify(["style"]));
  form.set("ai", JSON.stringify({ manual: true }));
  const res = await alice.raw("POST", `/api/projects/${p.project.id}/images/describe`, form);
  expect(res.status).toBe(202);
  jobId = ((await res.json()) as { job: { id: string } }).job.id;
  await waitForStatus("awaiting_input", "describe parked");

  const view = await alice.get<ManualView & { attachments: string[] }>(`/api/generations/${jobId}/manual`);
  // The image the provider would have been sent is named, and marked in the prompt where it belongs.
  expect(view.attachments).toHaveLength(1);
  expect(view.prompt).toContain(`[attach image 1: asset ${view.attachments[0]}]`);
  // And it is an image the user can actually fetch.
  const img = await alice.raw("GET", `/cdn/a/${view.attachments[0]}`);
  expect(img.status).toBe(200);

  await alice.post(`/api/generations/${jobId}/manual`, { text: chat(view.prompt) }, 202);
  const done = await waitFor(
    async () => {
      const r = await jobStatus();
      return ["completed", "awaiting_input", "failed"].includes(r.status) && r.status !== "awaiting_input" ? r : null;
    },
    { label: "describe answered", timeoutMs: 30_000 },
  );
  expect(done.status).toBe("completed");
});

/** Answers every question a keyless job asks, by copying each prompt into the chat and pasting the reply. */
const answerAll = async (id: string, label: string) => {
  jobId = id;
  const asked: string[] = [];
  for (let turn = 0; turn < 40; turn++) {
    const row = await waitFor(
      async () => {
        const r = await jobStatus();
        return ["awaiting_input", "completed", "failed", "cancelled"].includes(r.status) ? r : null;
      },
      { label: `${label} turn ${turn}`, timeoutMs: 30_000 },
    );
    if (row.status !== "awaiting_input") {
      expect(row.status).toBe("completed");
      return asked;
    }
    expect(row.failureReason).toBeNull();
    asked.push(row.compiledPrompt!.match(/\[template:([a-z-]+)-v\d+\]/)?.[1] ?? "?");
    await alice.post(`/api/generations/${id}/manual`, { text: chat(row.compiledPrompt!) }, 202);
  }
  throw new Error(`${label} never finished`);
};

test("the whole text pipeline runs with no key: analysis, plan, panel prompts and narration", async () => {
  const manual = { ai: { manual: true } };
  const p = await alice.post<{ project: { id: string } }>(
    "/api/projects",
    { title: "Every Step By Hand", story: { content: STORY } },
    201,
  );
  const pid = p.project.id;
  const s = await alice.get<{ latest: { id: string } }>(`/api/projects/${pid}/story`);

  const an = await alice.post<{ job: { id: string } }>(`/api/story-revisions/${s.latest.id}/analyze`, manual, 202);
  expect(await answerAll(an.job.id, "analysis")).toEqual(["story-analysis"]);
  const [analysis] = await h.deps.db.select().from(storyAnalyses).where(eq(storyAnalyses.projectId, pid));
  await alice.post(`/api/story-analyses/${analysis!.id}/apply`, {});
  const chapterId = (await alice.get<{ chapters: { id: string }[] }>(`/api/projects/${pid}/chapters`)).chapters[0]!.id;

  const plan = await alice.post<{ job: { id: string } }>(`/api/chapters/${chapterId}/plan`, manual, 202);
  await answerAll(plan.job.id, "plan");
  const chapter = await alice.get<{ pages: { id: string }[] }>(`/api/chapters/${chapterId}`);
  expect(chapter.pages.length).toBeGreaterThan(0);

  const prompts = await alice.post<{ job: { id: string } }>(
    `/api/pages/${chapter.pages[0]!.id}/prepare-prompts`,
    manual,
    202,
  );
  expect(await answerAll(prompts.job.id, "panel prompts")).toEqual(["panel-prompts"]);
  const pageDoc = await alice.get<{ panels: { promptDraft: unknown }[] }>(`/api/pages/${chapter.pages[0]!.id}`);
  expect(pageDoc.panels.some((x) => x.promptDraft)).toBe(true);

  const narration = await alice.post<{ job: { id: string } }>(
    `/api/chapters/${chapterId}/narration/generate`,
    manual,
    202,
  );
  expect(await answerAll(narration.job.id, "narration")).toEqual(["narration"]);
  const lines = await h.deps.db.select().from(narrationLines).where(eq(narrationLines.projectId, pid));
  expect(lines.length).toBeGreaterThan(0);

  // Four operations, several round trips, and not a cent: nothing was sent to anyone.
  const usage = await h.deps.db.select().from(aiUsage).where(eq(aiUsage.projectId, pid));
  expect(usage.every((u) => Number(u.estimatedCostUsd) === 0 && u.textInputTokens === 0)).toBe(true);
}, 180_000);
