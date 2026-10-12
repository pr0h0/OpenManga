import { afterAll, beforeAll, expect, test } from "bun:test";
import { ChapterPlan } from "@openmanga/schemas";
import { applyChapterPlan } from "@openmanga/services";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let chapterId: string;

type Line = {
  sourceType: string;
  sourceId: string;
  pageId: string;
  text: string;
  translation: string | null;
  stale: boolean;
  edited: boolean;
};
type Data = { lines: Line[]; translated: number; job: { id: string; status: string } | null };
const lettering = () => u.get<Data>(`/api/chapters/${chapterId}/lettering?language=es`);
const png = async (pageId: string, language?: string) =>
  Buffer.from(
    await (
      await u.raw("GET", `/api/pages/${pageId}/render.png?width=400${language ? `&language=${language}` : ""}`)
    ).arrayBuffer(),
  );

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post("/api/auth/register", { username: "babel", email: "ba@example.com", password: "babel-pass-123" }, 201);
  projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Editions" }, 201)).project.id;
  await u.patch(`/api/projects/${projectId}`, { settings: { lettering: { autoPlace: true } } });
  chapterId = (await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201))
    .chapter.id;
  await applyChapterPlan(
    h.deps.db,
    chapterId,
    ChapterPlan.parse({
      scenes: [
        {
          title: "Dock",
          pages: [
            {
              panels: [
                {
                  spec: { beat: "Ines shouts across the dock" },
                  dialogue: [{ speaker: "", text: "Where is the keeper?", kind: "shout" }],
                  narration: ["The storm had not let up for three days."],
                },
                { spec: { beat: "Tomas shrugs" }, dialogue: [{ speaker: "", text: "Gone to the mainland." }] },
              ],
            },
          ],
        },
      ],
    }),
    { replace: true },
  );
}, 60_000);
afterAll(() => h?.stop());

test("a chapter's bubbles and captions translated, edited by hand, lettered into the same page", async () => {
  const before = await lettering();
  expect(before.lines.map((l) => [l.sourceType, l.text])).toEqual([
    ["dialogue", "Where is the keeper?"],
    ["caption", "The storm had not let up for three days."],
    ["dialogue", "Gone to the mainland."],
  ]);
  expect(before.translated).toBe(0);
  await u.post(`/api/chapters/${chapterId}/lettering/translate`, { language: "en" }, 400);
  await u.post(`/api/chapters/${chapterId}/lettering/translate`, { language: "es" }, 202);
  const done = await waitFor(
    async () => {
      const d = await lettering();
      return d.job?.status === "completed" ? d : null;
    },
    { label: "translation", timeoutMs: 60_000 },
  );
  expect(done.translated).toBe(3);
  expect(done.lines[0]!.translation).toBe("[es] Where is the keeper?");

  // A hand edit stays through another machine translation.
  const first = done.lines[0]!;
  await u.put(`/api/chapters/${chapterId}/lettering`, {
    language: "es",
    lines: [{ sourceType: "dialogue", sourceId: first.sourceId, text: "¿Dónde está el farero?" }],
  });
  await u.post(`/api/chapters/${chapterId}/lettering/translate`, { language: "es" }, 202);
  const again = await waitFor(
    async () => {
      const d = await lettering();
      return d.job?.status === "completed" && d.job.id !== done.job!.id ? d : null;
    },
    { label: "second translation", timeoutMs: 60_000 },
  );
  expect(again.lines[0]).toMatchObject({ translation: "¿Dónde está el farero?", edited: true });
  // A line that is not this chapter's is refused.
  await u.put(
    `/api/chapters/${chapterId}/lettering`,
    { language: "es", lines: [{ sourceType: "dialogue", sourceId: crypto.randomUUID(), text: "x" }] },
    400,
  );

  // The Spanish edition is the same page with other text; the original is unchanged.
  const pageId = first.pageId;
  const original = await png(pageId);
  expect((await png(pageId, "es")).equals(original)).toBe(false);
  expect((await png(pageId, "fr")).equals(original)).toBe(true);

  // The original changing marks its translation stale.
  const { pages } = await u.get<{ pages: { id: string }[] }>(`/api/chapters/${chapterId}`);
  const doc = await u.get<{ dialogue: { id: string; text: string }[] }>(`/api/pages/${pages[0]!.id}`);
  const bubble = doc.dialogue.find((b) => b.text === "Gone to the mainland.")!;
  await u.patch(`/api/pages/${pages[0]!.id}/document`, { dialogue: [{ id: bubble.id, text: "Gone to the city." }] });
  expect((await lettering()).lines.find((l) => l.sourceId === bubble.id)!.stale).toBe(true);
}, 150_000);

test("a page export in the edition's language", async () => {
  const r = await u.post<{ job: { id: string } }>(
    `/api/projects/${projectId}/exports`,
    { kind: "png_pages", chapterId, language: "es", acknowledgeIssues: true },
    202,
  );
  const done = await waitFor(
    async () => {
      const l = await u.get<{ jobs: { id: string; status: string; failureReason: string | null }[] }>(
        `/api/projects/${projectId}/exports`,
      );
      const j = l.jobs.find((x) => x.id === r.job.id);
      return j && ["completed", "failed"].includes(j.status) ? j : null;
    },
    { label: "export", timeoutMs: 90_000 },
  );
  expect(`${done.status}:${done.failureReason ?? ""}`).toBe("completed:");
}, 120_000);
