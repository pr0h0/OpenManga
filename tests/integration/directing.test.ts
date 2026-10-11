import { afterAll, beforeAll, expect, test } from "bun:test";
import { startHarness, type TestClient } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let u: TestClient;
let projectId: string;
let panelId: string;
let jin: string;

type Spec = Record<string, unknown> & { characters: unknown[] };
const promptOf = async (id: string) =>
  (await u.get<{ compiledPrompt: string }>(`/api/panels/${id}/prompt-preview`)).compiledPrompt;

beforeAll(async () => {
  h = await startHarness();
  u = h.client();
  await u.post(
    "/api/auth/register",
    { username: "director", email: "di@example.com", password: "director-pass-1" },
    201,
  );
  projectId = (await u.post<{ project: { id: string } }>("/api/projects", { title: "Staging" }, 201)).project.id;
  const c = await u.post<{ character: { id: string; currentVersionId: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Jin", description: { hair: "black" } },
    201,
  );
  jin = c.character.id;
  const chapterId = (
    await u.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title: "One" }, 201)
  ).chapter.id;
  const { page } = await u.post<{ page: { id: string } }>(
    `/api/chapters/${chapterId}/pages`,
    { layoutTemplate: "full-page" },
    201,
  );
  panelId = (await u.get<{ panels: { id: string }[] }>(`/api/pages/${page.id}`)).panels[0]!.id;
  const { character } = await u.get<{ character: { currentVersionId: string } }>(`/api/characters/${jin}`);
  await u.patch(`/api/panels/${panelId}`, { characterVersionIds: [character.currentVersionId] });
}, 60_000);
afterAll(() => h?.stop());

test("directing saved with the spec reaches the panel prompt, figures by name", async () => {
  const spec: Spec = {
    beat: "Jin opens the letter",
    shotType: "medium",
    cameraAngle: "low",
    characters: [{ characterId: jin, position: "left third" }],
    direction: {
      cameraHeight: "knee",
      lens: "telephoto",
      depthOfField: "shallow",
      purpose: "reveal",
      focus: "the letter",
      figures: [
        {
          characterId: jin,
          view: "profile",
          facing: "screen-right",
          eyeLine: "down at the letter",
          holding: "the letter",
        },
        { characterId: crypto.randomUUID(), view: "back" },
      ],
    },
  };
  await u.put(`/api/panels/${panelId}/spec`, { spec });
  const p = await promptOf(panelId);
  expect(p).toContain(
    "Jin — left third, in profile, facing screen right, looking down at the letter, holding the letter",
  );
  expect(p).toContain("Camera at knee height");
  expect(p).toContain("Shot purpose: reveal something the reader has not seen yet.");
  expect(p).toContain("Focus subject: the letter.");
  // A figure for someone not in the panel is left out.
  expect(p).not.toContain("seen from behind");
  // Kept with the spec version: get_panel shows it back.
  const { specs } = await u.get<{ specs: { spec: Spec }[] }>(`/api/panels/${panelId}`);
  expect(specs[0]!.spec.direction).toMatchObject({ cameraHeight: "knee", focus: "the letter" });
  // A bad value is refused.
  await u.put(`/api/panels/${panelId}/spec`, { spec: { ...spec, direction: { cameraHeight: "space" } } }, 422);
});
