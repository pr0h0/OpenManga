import { afterAll, beforeAll, expect, test } from "bun:test";
import { ChapterPlan } from "@openmanga/schemas";
import { applyChapterPlan } from "@openmanga/services";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let characterId: string;
let versionId: string;
const outfit: Record<string, string> = {};
/** Chapter 1 page 1 panels 1-4, then chapter 2 page 1 panels 1-4, in reading order. */
const panels: string[] = [];

type Preview = { compiledPrompt: string; references: { label: string }[] };
type Worn = {
  characters: {
    characterId: string;
    worn: { outfitId: string; source: string; since: { panelId: string } | null } | null;
    here: { id: string; scope: string }[];
  }[];
};

const wardrobe = async (panelId: string) => {
  const p = await alice.get<Preview>(`/api/panels/${panelId}/prompt-preview`);
  return p.compiledPrompt.match(/WARDROBE:\n(.*)/)?.[1] ?? "";
};
const worn = async (panelId: string) => (await alice.get<Worn>(`/api/panels/${panelId}/outfits`)).characters[0]!.worn;
const dress = (panelId: string, name: string, scope: "onward" | "panel") =>
  alice.put(`/api/panels/${panelId}/outfits`, { characterId, outfitId: outfit[name], scope });
const setText = (panelId: string, text: string) =>
  alice.put(`/api/panels/${panelId}/spec`, {
    spec: {
      beat: "Mina stands in the rain",
      characters: [{ characterId, expression: "", pose: "", action: "", outfit: text, position: "" }],
    },
  });
const waitJob = (id: string) =>
  waitFor(
    async () => {
      const r = await alice.get<{ job: { status: string } }>(`/api/generations/${id}`);
      return ["completed", "failed", "cancelled"].includes(r.job.status) ? r.job : null;
    },
    { label: `job ${id}`, timeoutMs: 60_000 },
  );

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "dresser", email: "d@example.com", password: "dress-pass-12" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Change of Clothes" }, 201);
  projectId = p.project.id;
  const c = await alice.post<{ character: { id: string; currentVersionId: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Mina", description: { wardrobe: "grey school blazer and pleated skirt" } },
    201,
  );
  characterId = c.character.id;
  versionId = c.character.currentVersionId;
  const detail = await alice.get<{ outfits: { id: string; name: string }[] }>(`/api/characters/${characterId}`);
  outfit.Default = detail.outfits.find((o) => o.name === "Default")!.id;
  for (const [name, description] of [
    ["Rain Coat", "long yellow raincoat with a hood"],
    ["Pajamas", "blue striped pajamas"],
  ] as const) {
    const o = await alice.post<{ outfit: { id: string } }>(
      `/api/characters/${characterId}/outfits`,
      { name, description, characterVersionId: versionId },
      201,
    );
    outfit[name] = o.outfit.id;
  }
  for (const title of ["One", "Two"]) {
    const ch = await alice.post<{ chapter: { id: string } }>(`/api/projects/${projectId}/chapters`, { title }, 201);
    const page = await alice.post<{ page: { id: string } }>(
      `/api/chapters/${ch.chapter.id}/pages`,
      { layoutTemplate: "four-grid" },
      201,
    );
    const doc = await alice.get<{ panels: { id: string; order: number }[] }>(`/api/pages/${page.page.id}`);
    panels.push(...doc.panels.sort((a, b) => a.order - b.order).map((x) => x.id));
  }
  for (const id of panels) {
    await alice.patch(`/api/panels/${id}`, { characterVersionIds: [versionId] });
    await setText(id, "");
  }
});
afterAll(() => h?.stop());

test("with no change set, every panel wears the default outfit, by its description", async () => {
  expect(await wardrobe(panels[0]!)).toContain("Mina: Default: grey school blazer and pleated skirt");
  expect((await worn(panels[5]!))?.source).toBe("default");
});

test("a change from a panel on holds for the rest of the chapter and carries into the next", async () => {
  await dress(panels[2]!, "Rain Coat", "onward");
  expect(await wardrobe(panels[1]!)).toContain("Default: grey school blazer");
  for (const i of [2, 3, 4, 7]) expect(await wardrobe(panels[i]!)).toContain("Rain Coat: long yellow raincoat");
  const w = await worn(panels[4]!);
  expect(w).toEqual({
    outfitId: outfit["Rain Coat"]!,
    source: "onward",
    since: expect.objectContaining({ panelId: panels[2] }),
  });
});

test("'only this panel' dresses one panel and leaves the running outfit alone", async () => {
  await dress(panels[5]!, "Pajamas", "panel");
  expect(await wardrobe(panels[5]!)).toContain("Pajamas: blue striped pajamas");
  expect(await wardrobe(panels[6]!)).toContain("Rain Coat");
});

test("outfit text on a panel: a named outfit beats the inherited one; anything else is a detail of it", async () => {
  await setText(panels[6]!, "pajamas, hair down");
  expect((await worn(panels[6]!))?.source).toBe("text");
  expect(await wardrobe(panels[6]!)).toContain("Pajamas: blue striped pajamas (this panel: pajamas, hair down)");
  await setText(panels[6]!, "hood up, soaked");
  expect(await wardrobe(panels[6]!)).toContain(
    "Rain Coat: long yellow raincoat with a hood (this panel: hood up, soaked)",
  );
  // A change set on the panel itself outranks its text.
  await setText(panels[2]!, "pajamas");
  expect(await wardrobe(panels[2]!)).toContain("Rain Coat: long yellow raincoat with a hood");
  expect(await wardrobe(panels[2]!)).not.toContain("this panel: pajamas");
  await setText(panels[2]!, "");
});

test("the worn outfit's approved reference is sent, by id, wherever it is worn", async () => {
  const main = await alice.post<{ job: { id: string } }>(
    `/api/character-versions/${versionId}/references/generate`,
    { kind: "portrait" },
    202,
  );
  expect((await waitJob(main.job.id)).status).toBe("completed");
  const approveAll = async (outfitId: string | null) => {
    const d = await alice.get<{ references: { id: string; outfitId: string | null; status: string }[] }>(
      `/api/characters/${characterId}`,
    );
    for (const r of d.references.filter((x) => x.outfitId === outfitId && x.status === "draft"))
      await alice.post(`/api/references/${r.id}/status`, { status: "approved" });
  };
  await approveAll(null);
  const coat = await alice.post<{ job: { id: string } }>(
    `/api/character-versions/${versionId}/references/generate`,
    { kind: "outfit", outfitId: outfit["Rain Coat"] },
    202,
  );
  expect((await waitJob(coat.job.id)).status).toBe("completed");
  await approveAll(outfit["Rain Coat"]!);
  // Chapter two's first panel names nothing: it inherits the coat from chapter one, and so gets its picture.
  const pv = await alice.get<Preview>(`/api/panels/${panels[4]}/prompt-preview`);
  expect(pv.references.map((r) => r.label)).toContain("Mina outfit: Rain Coat");
  expect(pv.compiledPrompt).toContain('Mina wears the "Rain Coat" outfit shown in reference image 2');
  const before = await alice.get<Preview>(`/api/panels/${panels[1]}/prompt-preview`);
  expect(before.references.map((r) => r.label)).not.toContain("Mina outfit: Rain Coat");
});

test("the character's timeline lists every change in reading order, and removing one falls back", async () => {
  const t = await alice.get<{ timeline: { id: string; outfitName: string; scope: string; panelId: string }[] }>(
    `/api/characters/${characterId}/outfit-timeline`,
  );
  expect(t.timeline.map((x) => [x.outfitName, x.scope, x.panelId])).toEqual([
    ["Rain Coat", "onward", panels[2]!],
    ["Pajamas", "panel", panels[5]!],
  ]);
  await alice.del(`/api/outfit-assignments/${t.timeline[0]!.id}`);
  expect((await worn(panels[4]!))?.source).toBe("default");
  // Setting from here on replaces a one-panel pick on the same panel instead of hiding behind it.
  await dress(panels[5]!, "Rain Coat", "onward");
  const here = (await alice.get<Worn>(`/api/panels/${panels[5]}/outfits`)).characters[0]!.here;
  expect(here.map((x) => x.scope)).toEqual(["onward"]);
  expect(await wardrobe(panels[7]!)).toContain("Rain Coat");
});

test("an outfit of another character is refused", async () => {
  const other = await alice.post<{ character: { id: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Jun", description: { wardrobe: "denim jacket" } },
    201,
  );
  await alice.put(
    `/api/panels/${panels[0]}/outfits`,
    { characterId: other.character.id, outfitId: outfit.Pajamas, scope: "onward" },
    404,
  );
});

test("a chapter plan that names an outfit switches the character from that panel on", async () => {
  // Chapter three starts in the Rain Coat the change on chapter two left Mina in.
  const ch = await alice.post<{ chapter: { id: string } }>(
    `/api/projects/${projectId}/chapters`,
    { title: "Three" },
    201,
  );
  const panel = (outfitText: string) => ({
    spec: { beat: "Mina at home", characters: [{ characterId: "Mina", outfit: outfitText }] },
  });
  const plan = ChapterPlan.parse({
    scenes: [
      {
        title: "Home",
        pages: [{ panels: [panel("rain coat, dripping"), panel("Pajamas"), panel("")] }],
      },
    ],
  });
  for (const replace of [false, true]) {
    await applyChapterPlan(h.deps.db, ch.chapter.id, plan, { replace });
    const t = await alice.get<{ timeline: { chapterId: string; outfitName: string; scope: string }[] }>(
      `/api/characters/${characterId}/outfit-timeline`,
    );
    // Naming what she already wears changes nothing; naming Pajamas is one change, and re-planning does not stack it.
    expect(t.timeline.filter((x) => x.chapterId === ch.chapter.id).map((x) => [x.outfitName, x.scope])).toEqual([
      ["Pajamas", "onward"],
    ]);
  }
  const page = await alice.get<{ pages: { id: string }[] }>(`/api/chapters/${ch.chapter.id}`);
  const doc = await alice.get<{ panels: { id: string; order: number }[] }>(`/api/pages/${page.pages[0]!.id}`);
  const [first, , last] = doc.panels.sort((a, b) => a.order - b.order);
  expect(await wardrobe(first!.id)).toContain(
    "Rain Coat: long yellow raincoat with a hood (this panel: rain coat, dripping)",
  );
  expect(await wardrobe(last!.id)).toContain("Pajamas: blue striped pajamas");
});
