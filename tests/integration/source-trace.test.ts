import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

const TEXT = [
  "Mira climbed the lighthouse stairs in the storm.",
  "At the top she found the lamp dark and the keeper gone.",
  "Down in the harbour, a fishing boat drifted toward the rocks.",
  "Its captain waved a red lantern at the black tower.",
].join("\n");

type Trace = {
  text: string;
  panels: { panelId: string; start: number | null; end: number | null; changed: boolean; was: string | null }[];
  scenes: unknown[];
  narration: unknown[];
  changed: number;
};

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let chapterId: string;
let panelIds: string[];

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "tracer", email: "tr@example.com", password: "trace pass 12" }, 201);
  projectId = (
    await u.post<{ project: { id: string } }>("/api/projects", { title: "Trace", story: { content: TEXT } }, 201)
  ).project.id;
  chapterId = (
    await u.post<{ chapter: { id: string } }>(
      `/api/projects/${projectId}/chapters`,
      { title: "Lighthouse", sourceExcerpt: TEXT },
      201,
    )
  ).chapter.id;
  const pageId = (
    await u.post<{ page: { id: string } }>(
      `/api/chapters/${chapterId}/pages`,
      { layoutTemplate: "two-horizontal" },
      201,
    )
  ).page.id;
  const doc = await u.get<{ panels: { id: string; order: number }[] }>(`/api/pages/${pageId}`);
  panelIds = doc.panels.sort((a, b) => a.order - b.order).map((p) => p.id);
  await u.patch(`/api/panels/${panelIds[0]}`, { storyBeat: "Mira climbs the lighthouse stairs in the storm" });
  await u.patch(`/api/panels/${panelIds[1]}`, { storyBeat: "The captain waves a red lantern from the boat" });
}, 60_000);
afterAll(() => h?.stop());

test("panels planned before tracing are traced on first read, in order, covering the text", async () => {
  const t = await u.get<Trace>(`/api/chapters/${chapterId}/source`);
  expect(t.text).toBe(TEXT);
  const [a, b] = t.panels;
  expect(TEXT.slice(a!.start!, a!.end!)).toStartWith("Mira climbed");
  expect(TEXT.slice(a!.start!, a!.end!)).toContain("keeper gone");
  expect(TEXT.slice(b!.start!, b!.end!)).toStartWith("Down in the harbour");
  expect(b!.end).toBe(TEXT.length);
  expect(t.changed).toBe(0);
});

test("a story revision under a panel marks exactly that panel changed; tracing again clears it", async () => {
  await u.patch(`/api/chapters/${chapterId}`, {
    sourceExcerpt: `A new first line.\n${TEXT.replace("red lantern", "green flare")}`,
  });
  const t = await u.get<Trace>(`/api/chapters/${chapterId}/source`);
  // The first panel's text only moved; the second panel's was rewritten.
  expect(t.panels.map((p) => p.changed)).toEqual([false, true]);
  expect(t.panels[1]!.was).toContain("red lantern");
  expect(t.text.slice(t.panels[0]!.start!, t.panels[0]!.end!)).toStartWith("Mira climbed");
  const again = await u.post<Trace>(`/api/chapters/${chapterId}/source/trace`, {});
  expect(again.changed).toBe(0);
  expect(again.text.slice(again.panels[1]!.start!, again.panels[1]!.end!)).toContain("green flare");
});

test("planning traces every new panel", async () => {
  const { latest } = await u.get<{ latest: { id: string } }>(`/api/projects/${projectId}/story`);
  const an = await u.post<{ job: { id: string }; analysis: { id: string } }>(
    `/api/story-revisions/${latest.id}/analyze`,
    {},
    202,
  );
  await waitFor(
    async () =>
      (await u.get<{ job: { status: string } }>(`/api/generations/${an.job.id}`)).job.status === "completed" || null,
    { label: "analysis" },
  );
  await u.post(`/api/story-analyses/${an.analysis.id}/apply`, {});
  const { chapters } = await u.get<{ chapters: { id: string }[] }>(`/api/projects/${projectId}/chapters`);
  const planned = chapters.find((c) => c.id !== chapterId)!;
  const plan = await u.post<{ job: { id: string } }>(`/api/chapters/${planned.id}/plan`, {}, 202);
  await waitFor(
    async () =>
      (await u.get<{ job: { status: string } }>(`/api/generations/${plan.job.id}`)).job.status === "completed" || null,
    { label: "plan" },
  );
  const { panels } = await u.get<{ panels: { sourceSpan: { text: string } | null }[] }>(
    `/api/chapters/${planned.id}/panels`,
  );
  expect(panels.length).toBeGreaterThan(0);
  expect(panels.every((p) => p.sourceSpan && p.sourceSpan.text.length > 0)).toBe(true);
}, 120_000);
