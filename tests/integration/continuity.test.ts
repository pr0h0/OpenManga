import { afterAll, beforeAll, expect, test } from "bun:test";
import { ChapterPlan } from "@openmanga/schemas";
import { applyChapterPlan } from "@openmanga/services";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;

const continuityOf = async (panelId: string) => {
  const p = await alice.get<{ compiledPrompt: string }>(`/api/panels/${panelId}/prompt-preview`);
  return p.compiledPrompt.match(/CONTINUITY:\n([\s\S]*?)(\n\n|$)/)?.[1] ?? "";
};

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post("/api/auth/register", { username: "keeper", email: "k@example.com", password: "keep-pass-12" }, 201);
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Torn Sleeve" }, 201);
  projectId = p.project.id;
  for (const name of ["Mina", "Jun"])
    await alice.post(`/api/projects/${projectId}/characters`, { name, description: { hair: "black" } }, 201);
});
afterAll(() => h?.stop());

test("what an earlier scene changed for good carries into later scenes, for the people it is about", async () => {
  const ch = await alice.post<{ chapter: { id: string } }>(
    `/api/projects/${projectId}/chapters`,
    { title: "One" },
    201,
  );
  const panel = (who: string) => ({ spec: { beat: `${who} waits`, characters: [{ characterId: who }] } });
  const plan = ChapterPlan.parse({
    scenes: [
      {
        title: "The fight",
        continuityDeltas: ["Mina: left sleeve torn"],
        finalState: { Mina: "soaked from the rain" },
        pages: [{ panels: [panel("Mina")] }],
      },
      { title: "Afterwards", pages: [{ panels: [panel("Mina"), panel("Jun")] }] },
      { title: "Next day", initialState: { Mina: "dry, rested" }, pages: [{ panels: [panel("Mina")] }] },
    ],
  });
  await applyChapterPlan(h.deps.db, ch.chapter.id, plan, { replace: false });
  const detail = await alice.get<{ pages: { id: string }[] }>(`/api/chapters/${ch.chapter.id}`);
  const firstPanel = async (i: number) =>
    (await alice.get<{ panels: { id: string; order: number }[] }>(`/api/pages/${detail.pages[i]!.id}`)).panels.sort(
      (a, b) => a.order - b.order,
    );
  const [minaAfter, junAfter] = await firstPanel(1);
  const after = await continuityOf(minaAfter!.id);
  expect(after).toContain("Mina: left sleeve torn");
  // The scene states no starting state, so it starts where the fight ended.
  expect(after).toContain("Mina: soaked from the rain");
  // Jun is not in the panel: Mina's sleeve is not his continuity.
  expect(await continuityOf(junAfter!.id)).not.toContain("sleeve");
  // A scene with its own starting state keeps it, and the torn sleeve still shows.
  const [nextDay] = await firstPanel(2);
  const next = await continuityOf(nextDay!.id);
  expect(next).toContain("Mina: dry, rested");
  expect(next).not.toContain("soaked");
  expect(next).toContain("Mina: left sleeve torn");
});
