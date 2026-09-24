import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, panels } from "@openmanga/db";
import { ChapterPlan } from "@openmanga/schemas";
import { applyChapterPlan } from "@openmanga/services";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let minaId: string;

type Page = {
  panels: { id: string; order: number; frame: { x: number; y: number; width: number; height: number } }[];
  dialogue: { panelId: string; characterId: string | null; text: string; bubble: { x: number; y: number } }[];
  sfx: { panelId: string; text: string }[];
};

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "letterer", email: "l@example.com", password: "letter-pass-12" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Words Later" }, 201);
  projectId = p.project.id;
  const c = await alice.post<{ character: { id: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Mina", description: { hair: "black" } },
    201,
  );
  minaId = c.character.id;
});
afterAll(() => h?.stop());

test("with automatic lettering off, the plan's dialogue waits on the panel and letters the page on request", async () => {
  const ch = await alice.post<{ chapter: { id: string } }>(
    `/api/projects/${projectId}/chapters`,
    { title: "One" },
    201,
  );
  const plan = ChapterPlan.parse({
    scenes: [
      {
        title: "Door",
        pages: [
          {
            layoutTemplate: "two-horizontal",
            panels: [
              {
                spec: {
                  beat: "Mina hears a knock",
                  characters: [{ characterId: "Mina", position: "right foreground" }],
                  negativeSpace: { area: "upper left", purpose: "dialogue" },
                },
                dialogue: [{ speaker: "Mina", text: "Who's there?" }],
                sfx: ["KNOCK"],
              },
              { spec: { beat: "The door", characters: [] } },
            ],
          },
        ],
      },
    ],
  });
  await applyChapterPlan(h.deps.db, ch.chapter.id, plan, { replace: false });
  const detail = await alice.get<{ pages: { id: string }[] }>(`/api/chapters/${ch.chapter.id}`);
  const pageId = detail.pages[0]!.id;

  // Clean page, but the words are not lost.
  const before = await alice.get<Page>(`/api/pages/${pageId}`);
  expect(before.dialogue).toHaveLength(0);
  expect(before.sfx).toHaveLength(0);
  const first = before.panels.sort((a, b) => a.order - b.order)[0]!;
  const [row] = await h.deps.db.select().from(panels).where(eq(panels.id, first.id));
  expect(row!.plannedLettering).toEqual({
    dialogue: [{ speakerId: minaId, text: "Who's there?", kind: "normal", preferredQuadrant: undefined }],
    sfx: ["KNOCK"],
  });

  expect(await alice.post<{ lines: number; sfx: number }>(`/api/pages/${pageId}/letter-from-plan`)).toEqual({
    lines: 1,
    sfx: 1,
  });
  const after = await alice.get<Page>(`/api/pages/${pageId}`);
  expect(after.dialogue.map((d) => [d.panelId, d.characterId, d.text])).toEqual([[first.id, minaId, "Who's there?"]]);
  expect(after.sfx.map((s) => s.text)).toEqual(["KNOCK"]);
  // The plan said the upper left of the panel is free, and that is where the bubble went.
  const b = after.dialogue[0]!.bubble;
  expect(b.x).toBeLessThan(first.frame.x + first.frame.width / 2);
  expect(b.y).toBeLessThan(first.frame.y + first.frame.height / 2);

  // Lettered once: asking again places nothing new.
  expect(await alice.post<{ lines: number; sfx: number }>(`/api/pages/${pageId}/letter-from-plan`)).toEqual({
    lines: 0,
    sfx: 0,
  });
});
