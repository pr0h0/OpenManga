import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, generationJobs } from "@openmanga/db";
import { ChapterPlan } from "@openmanga/schemas";
import { applyChapterPlan } from "@openmanga/services";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let jin: string;
let ch1: string;
let ch2: string;
let ch3: string;
let armour: string;

type Bible = {
  facts: { id: string; text: string; source: string }[];
  states: { id: string; text: string; outfitId: string | null }[];
  extraction: { id: string; status: string; result: { applied?: unknown } | null } | null;
  inEffect: { fixedRules: string[]; facts: string[]; characterStates: Record<string, string[]> } | null;
};

const job = async (id: string) => (await h.deps.db.select().from(generationJobs).where(eq(generationJobs.id, id)))[0]!;
const finished = (id: string, label: string) =>
  waitFor(
    async () => {
      const j = await job(id);
      return j.status === "completed" || j.status === "failed" ? j : null;
    },
    { label, timeoutMs: 60_000 },
  );
const promptOf = async (panelId: string) =>
  (await alice.get<{ compiledPrompt: string }>(`/api/panels/${panelId}/prompt-preview`)).compiledPrompt;

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post("/api/auth/register", { username: "canon", email: "c@example.com", password: "canon-pass-12" }, 201);
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "The Belt" }, 201);
  projectId = p.project.id;
  const c = await alice.post<{ character: { id: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Jin", description: { hair: "black" } },
    201,
  );
  jin = c.character.id;
  await alice.post(`/api/projects/${projectId}/characters`, { name: "Hana", description: { hair: "red" } }, 201);
  armour = (
    await alice.post<{ outfit: { id: string } }>(
      `/api/characters/${jin}/outfits`,
      { name: "Fight armour", description: "dented steel plates" },
      201,
    )
  ).outfit.id;
  const chapter = async (title: string, sourceExcerpt: string) =>
    (
      await alice.post<{ chapter: { id: string } }>(
        `/api/projects/${projectId}/chapters`,
        { title, sourceExcerpt },
        201,
      )
    ).chapter.id;
  ch1 = await chapter("Rain", "Jin waits in the rain with Hana outside the gym.");
  ch2 = await chapter("Final", "Jin steps into the ring and lifts the championship belt.");
  ch3 = await chapter("After", "Hana reads the letter alone.");
});
afterAll(() => h?.stop());

test("facts and states are added with checked ranges, characters and outfits", async () => {
  const fact = (b: Record<string, unknown>, status = 201) =>
    alice.post<{ fact: { id: string } }>(`/api/projects/${projectId}/bible/facts`, b, status);
  await fact({ kind: "character", subject: "Jin", text: "Scar on the LEFT jaw.", fixed: true, visual: true });
  await fact({ kind: "rule", text: "No guns exist in this world.", fixed: true, visual: true });
  await fact({ kind: "object", subject: "Jin", text: "Holds the championship belt.", fromChapterId: ch2 });
  await fact({ kind: "character", subject: "Mara", text: "Mara is a spy." });
  await fact({ kind: "term", text: "x", fromChapterId: ch2, untilChapterId: ch1 }, 400);
  const other = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Other" }, 201);
  const foreign = await alice.post<{ chapter: { id: string } }>(
    `/api/projects/${other.project.id}/chapters`,
    { title: "Elsewhere" },
    201,
  );
  await fact({ kind: "term", text: "x", fromChapterId: foreign.chapter.id }, 400);

  const state = (b: Record<string, unknown>, status = 201) =>
    alice.post(`/api/projects/${projectId}/bible/states`, b, status);
  await state({ characterId: jin, kind: "injury", text: "Right arm in a sling.", chapterId: ch1, untilChapterId: ch1 });
  await state({ characterId: jin, kind: "outfit", text: "Wears his fight armour.", chapterId: ch2, outfitId: armour });
  await state({ characterId: jin, kind: "knowledge", text: "Knows the letter is forged.", chapterId: ch3 });
  await state({ characterId: jin, kind: "injury", text: "x", sceneNumber: 2 }, 400);

  const bible = await alice.get<Bible>(`/api/projects/${projectId}/bible`);
  expect(bible.facts).toHaveLength(4);
  expect(bible.states).toHaveLength(3);
});

test("what is in effect depends on the chapter and on who and what it mentions", async () => {
  const at = (chapterId: string) =>
    alice.get<Bible>(`/api/projects/${projectId}/bible?chapterId=${chapterId}`).then((b) => b.inEffect!);
  const one = await at(ch1);
  expect(one.fixedRules).toEqual(["Jin (character): Scar on the LEFT jaw.", "(rule) No guns exist in this world."]);
  expect(one.facts).toEqual([]);
  expect(one.characterStates).toEqual({ Jin: ["injury: Right arm in a sling."] });
  const two = await at(ch2);
  expect(two.facts).toEqual(["Jin (object): Holds the championship belt."]);
  expect(two.characterStates).toEqual({ Jin: ["outfit: Wears his fight armour."] });
  // Chapter 3 does not mention Jin: neither his facts nor his states are sent there.
  const three = await at(ch3);
  expect(three.fixedRules).toEqual(["(rule) No guns exist in this world."]);
  expect(three.characterStates).toEqual({});
});

test("planning, panel prompts, narration and panel images receive the bible in effect", async () => {
  const plan = await alice.post<{ job: { id: string } }>(`/api/chapters/${ch1}/plan`, {}, 202);
  const planned = await finished(plan.job.id, "chapter plan");
  expect(planned.status).toBe("completed");
  expect(planned.compiledPrompt).toContain("[template:scene-pages-v3]");
  expect(planned.compiledPrompt).toContain("Scar on the LEFT jaw.");
  expect(planned.compiledPrompt).toContain("Right arm in a sling.");
  expect(planned.compiledPrompt).not.toContain("championship belt.");
  expect(planned.compiledPrompt).not.toContain("Mara is a spy");

  const narration = await alice.post<{ job: { id: string } }>(`/api/chapters/${ch1}/narration/generate`, {}, 202);
  const narrated = await finished(narration.job.id, "narration");
  expect(narrated.status).toBe("completed");
  expect(narrated.compiledPrompt).toContain("[template:narration-v6]");
  expect(narrated.compiledPrompt).toContain("No guns exist in this world.");
  expect(narrated.compiledPrompt).not.toContain("championship belt.");

  const detail = await alice.get<{ pages: { id: string }[] }>(`/api/chapters/${ch1}`);
  const prep = await alice.post<{ job: { id: string } }>(`/api/pages/${detail.pages[0]!.id}/prepare-prompts`, {}, 202);
  const prepared = await finished(prep.job.id, "panel prompts");
  expect(prepared.compiledPrompt).toContain("[template:panel-prompts-v5]");
  expect(prepared.compiledPrompt).toContain("context.bible");
  expect(prepared.compiledPrompt).toContain("No guns exist in this world.");
});

test("panel images get visible canon and the outfit the bible puts the character in", async () => {
  const panel = { spec: { beat: "Jin raises the belt", characters: [{ characterId: "Jin" }] } };
  await applyChapterPlan(
    h.deps.db,
    ch2,
    ChapterPlan.parse({ scenes: [{ title: "The ring", pages: [{ panels: [panel] }] }] }),
    { replace: true },
  );
  const detail = await alice.get<{ pages: { id: string }[] }>(`/api/chapters/${ch2}`);
  const page = await alice.get<{ panels: { id: string }[] }>(`/api/pages/${detail.pages[0]!.id}`);
  const prompt = await promptOf(page.panels[0]!.id);
  expect(prompt).toContain("STORY CANON (must hold)");
  expect(prompt).toContain("Jin (character): Scar on the LEFT jaw.");
  // Not visual: the belt fact is for the planner and narration, not the image.
  expect(prompt).not.toContain("Holds the championship belt.");
  // The sling ended with chapter 1.
  expect(prompt).not.toContain("sling");
  expect(prompt).toMatch(/WARDROBE:\n.*Jin: Fight armour: dented steel plates/);
});

test("extracting proposes facts and states; applying saves them once", async () => {
  const run = await alice.post<{ job: { id: string } }>(`/api/projects/${projectId}/bible/extract`, {}, 202);
  const done = await finished(run.job.id, "bible extraction");
  expect(done.status).toBe("completed");
  expect(done.compiledPrompt).toContain("=== Chapter 3: After ===");
  const data = (done.result as { data: { facts: unknown[]; states: { fromChapter: number }[] } }).data;
  expect(data.facts.length).toBeGreaterThan(0);
  expect(data.states.at(-1)!.fromChapter).toBe(3);
  const before = await alice.get<Bible>(`/api/projects/${projectId}/bible`);
  expect(before.extraction?.id).toBe(run.job.id);

  const applied = await alice.post<{ facts: number; states: number; skipped: unknown[] }>(
    `/api/bible-extractions/${run.job.id}/apply`,
    {
      states: [
        ...(data.states as Record<string, unknown>[]),
        { character: "Nobody", kind: "item", text: "a coin", fromChapter: 1 },
      ],
    },
  );
  expect(applied.facts).toBe(data.facts.length);
  expect(applied.states).toBe(data.states.length);
  expect(applied.skipped).toHaveLength(1);
  await alice.post(`/api/bible-extractions/${run.job.id}/apply`, {}, 409);
  const after = await alice.get<Bible>(`/api/projects/${projectId}/bible`);
  expect(after.facts.filter((f) => f.source === "extracted")).toHaveLength(applied.facts);
  expect(after.extraction?.result?.applied).toBeTruthy();
});

test("extraction works without a key: it parks for a pasted BibleExtraction", async () => {
  const run = await alice.post<{ job: { id: string } }>(
    `/api/projects/${projectId}/bible/extract`,
    { chapterId: ch2, ai: { manual: true } },
    202,
  );
  await waitFor(async () => ((await job(run.job.id)).status === "awaiting_input" ? true : null), {
    label: "parked",
    timeoutMs: 30_000,
  });
  const view = await alice.get<{ prompt: string }>(`/api/generations/${run.job.id}/manual`);
  expect(view.prompt).toContain("=== Chapter 2: Final ===");
  expect(view.prompt).not.toContain("=== Chapter 1");
  await alice.post(
    `/api/generations/${run.job.id}/manual`,
    {
      text: JSON.stringify({
        facts: [{ kind: "place", subject: "the ring", text: "Ropes are red." }],
        states: [{ character: "jin", kind: "look", text: "Shaved head.", fromChapter: 2 }],
      }),
    },
    202,
  );
  const done = await finished(run.job.id, "pasted extraction");
  expect(done.status).toBe("completed");
  const applied = await alice.post<{ states: number }>(`/api/bible-extractions/${run.job.id}/apply`, {});
  // Character names match regardless of case.
  expect(applied.states).toBe(1);
});

test("a duplicated project keeps its bible, pointed at its own chapters and cast", async () => {
  const dup = await alice.post<{ project: { id: string } }>(`/api/projects/${projectId}/duplicate`, {}, 201);
  const src = await alice.get<Bible>(`/api/projects/${projectId}/bible`);
  const copy = await alice.get<Bible & { chapters: { id: string }[] }>(`/api/projects/${dup.project.id}/bible`);
  expect(copy.facts).toHaveLength(src.facts.length);
  expect(copy.states).toHaveLength(src.states.length);
  const outfit = copy.states.find((s) => s.outfitId);
  expect(outfit?.outfitId).not.toBe(armour);
  expect(copy.chapters.map((c) => c.id)).not.toContain(ch1);
});
