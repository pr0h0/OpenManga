import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq, panels, sql } from "@openmanga/db";
import { mockImagePng } from "@openmanga/testing";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let pageId: string;
let versionId: string;
let panelIds: string[];

type Guide = { assetId: string; strength: "loose" | "strict" } | null;
type Preview = { compiledPrompt: string; references: { index: number; role: string; assetId: string }[] };
type JobDetail = {
  job: { status: string; templateVersion: number; compiledPrompt: string };
  inputs: { role: string; assetId: string; sentAs: string; width: number; height: number }[];
};

const form = async (label: string, strength?: string) => {
  const f = new FormData();
  f.set("file", new File([(await mockImagePng({ width: 300, height: 200, prompt: label })) as BlobPart], "s.png"));
  if (strength) f.set("strength", strength);
  return f;
};
const guideOf = async (panelId: string) =>
  (await h.deps.db.select().from(panels).where(eq(panels.id, panelId)))[0]!.guide as Guide;
const waitJob = (id: string) =>
  waitFor(
    async () => {
      const r = await alice.get<JobDetail>(`/api/generations/${id}`);
      return ["completed", "failed", "cancelled"].includes(r.job.status) ? r : null;
    },
    { label: `job ${id}`, timeoutMs: 60_000 },
  );

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "sketcher", email: "s@example.com", password: "sketch-pass-12" },
    201,
  );
  const p = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Thumbnails First" }, 201);
  projectId = p.project.id;
  const c = await alice.post<{ character: { id: string; currentVersionId: string } }>(
    `/api/projects/${projectId}/characters`,
    { name: "Mina", description: { hair: "short black bob" } },
    201,
  );
  versionId = c.character.currentVersionId;
  const ref = await alice.post<{ job: { id: string } }>(
    `/api/character-versions/${versionId}/references/generate`,
    { kind: "portrait" },
    202,
  );
  expect((await waitJob(ref.job.id)).job.status).toBe("completed");
  const d = await alice.get<{ references: { id: string }[] }>(`/api/characters/${c.character.id}`);
  for (const r of d.references) await alice.post(`/api/references/${r.id}/status`, { status: "approved" });
  const ch = await alice.post<{ chapter: { id: string } }>(
    `/api/projects/${projectId}/chapters`,
    { title: "One" },
    201,
  );
  const page = await alice.post<{ page: { id: string } }>(
    `/api/chapters/${ch.chapter.id}/pages`,
    { layoutTemplate: "four-grid" },
    201,
  );
  pageId = page.page.id;
  const doc = await alice.get<{ panels: { id: string; order: number }[] }>(`/api/pages/${pageId}`);
  panelIds = doc.panels.sort((a, b) => a.order - b.order).map((x) => x.id);
  await alice.patch(`/api/panels/${panelIds[0]}`, { characterVersionIds: [versionId] });
}, 120_000);
afterAll(() => h?.stop());

test("an uploaded guide is stored as a sanitised project image and set on the panel", async () => {
  const res = await alice.raw("POST", `/api/panels/${panelIds[0]}/guide`, await form("pose"));
  expect(res.status).toBe(201);
  const out = (await res.json()) as { panel: { guide: Guide }; asset: { id: string; width: number } };
  expect(out.asset.width).toBe(300);
  expect(out.panel.guide).toEqual({ assetId: out.asset.id, strength: "loose" });
  expect(await guideOf(panelIds[0]!)).toEqual({ assetId: out.asset.id, strength: "loose" });

  const bad = new FormData();
  bad.set("file", new File(["not an image"], "x.txt", { type: "text/plain" }));
  expect((await alice.raw("POST", `/api/panels/${panelIds[0]}/guide`, bad)).status).toBe(415);
  expect((await alice.raw("POST", `/api/panels/${panelIds[0]}/guide`, await form("x", "exact"))).status).toBe(400);
});

test("the planner sends the guide after the identity reference, with its layout-only wording", async () => {
  const guide = (await guideOf(panelIds[0]!))!;
  const p = await alice.get<Preview>(`/api/panels/${panelIds[0]}/prompt-preview`);
  expect(p.references.map((r) => r.role)).toEqual(["character_ref", "layout_guide"]);
  expect(p.references[1]!.assetId).toBe(guide.assetId);
  expect(p.compiledPrompt).toContain("Mina is the person shown in reference image 1");
  expect(p.compiledPrompt).toContain("Reference image 2 is a rough layout/pose sketch: use it as a loose guide");
  expect(p.compiledPrompt).toContain("Ignore its drawing style, line quality and any text");

  await alice.patch(`/api/panels/${panelIds[0]}`, { guide: { ...guide, strength: "strict" } });
  const strict = await alice.get<Preview>(`/api/panels/${panelIds[0]}/prompt-preview`);
  expect(strict.compiledPrompt).toContain("Reference image 2 is a rough layout/pose sketch: follow its composition");
});

test("generation records the guide as a small derivative input, and so does a regeneration", async () => {
  const guide = (await guideOf(panelIds[0]!))!;
  for (const body of [{}, { operation: "change_pose", instruction: "arms crossed" }]) {
    const r = await alice.post<{ job: { id: string } }>(`/api/panels/${panelIds[0]}/generate`, body, 202);
    const done = await waitJob(r.job.id);
    expect(done.job.status).toBe("completed");
    expect(done.job.templateVersion).toBe(9);
    expect(done.job.compiledPrompt).toContain("layout/pose sketch");
    expect(done.inputs.map((i) => i.role)).toEqual(["character_ref", "layout_guide"]);
    const g = done.inputs[1]!;
    expect(g.assetId).toBe(guide.assetId);
    expect(g.sentAs).toBe("prompt_ref_derivative");
    expect(g.width).toBeLessThanOrEqual(192);
  }
});

test("duplicating a panel keeps its guide; another project's image cannot be set", async () => {
  const guide = await guideOf(panelIds[0]!);
  const dup = await alice.post<{ panel: { id: string; guide: Guide } }>(
    `/api/pages/${pageId}/panels`,
    { duplicateOf: panelIds[0] },
    201,
  );
  expect(dup.panel.guide).toEqual(guide);

  const other = await alice.post<{ project: { id: string } }>("/api/projects", { title: "Elsewhere" }, 201);
  const ch = await alice.post<{ chapter: { id: string } }>(
    `/api/projects/${other.project.id}/chapters`,
    { title: "X" },
    201,
  );
  const pg = await alice.post<{ page: { id: string } }>(
    `/api/chapters/${ch.chapter.id}/pages`,
    { layoutTemplate: "full-page" },
    201,
  );
  const otherPanel = (await alice.get<{ panels: { id: string }[] }>(`/api/pages/${pg.page.id}`)).panels[0]!.id;
  await alice.patch(`/api/panels/${otherPanel}`, { guide }, 400);

  // Any image of the project works, e.g. the panel's own artwork from another panel.
  const art = (await h.deps.db.select().from(panels).where(eq(panels.id, panelIds[0]!)))[0]!.activeArtworkAssetId!;
  await alice.patch(`/api/panels/${panelIds[1]}`, { guide: { assetId: art, strength: "strict" } });
  expect(await guideOf(panelIds[1]!)).toEqual({ assetId: art, strength: "strict" });
});

test("a masked edit leaves the guide out; removing it drops it from the next generation", async () => {
  const mask = await alice.raw("POST", `/api/panels/${panelIds[0]}/mask`, await form("mask"));
  const { asset } = (await mask.json()) as { asset: { id: string } };
  // A mask is not artwork, so it cannot be a guide.
  await alice.patch(`/api/panels/${panelIds[1]}`, { guide: { assetId: asset.id, strength: "loose" } }, 400);
  const e = await alice.post<{ job: { id: string } }>(
    `/api/panels/${panelIds[0]}/edit`,
    { maskAssetId: asset.id, instruction: "fix the hand" },
    202,
  );
  const edit = await waitJob(e.job.id);
  expect(edit.inputs.map((i) => i.role)).not.toContain("layout_guide");

  await alice.patch(`/api/panels/${panelIds[0]}`, { guide: null });
  expect(await guideOf(panelIds[0]!)).toBeNull();
  const p = await alice.get<Preview>(`/api/panels/${panelIds[0]}/prompt-preview`);
  expect(p.references.map((r) => r.role)).toEqual(["character_ref"]);
  expect(p.compiledPrompt).not.toContain("layout/pose sketch");
});

test("a locked panel refuses a new guide", async () => {
  await h.deps.db.update(panels).set({ approvalStatus: "locked" }).where(eq(panels.id, panelIds[2]!));
  expect((await alice.raw("POST", `/api/panels/${panelIds[2]}/guide`, await form("late"))).status).toBe(409);
});

test("a duplicated project's guides are its own copies", async () => {
  const dup = await alice.post<{ project: { id: string } }>(`/api/projects/${projectId}/duplicate`, {}, 201);
  const rows = await h.deps.db.execute<{ same: boolean; art: boolean }>(sql`
    select a.project_id = p.project_id as same,
      exists (select 1 from panels q where q.active_artwork_asset_id = a.id) as art
    from panels p join assets a on a.id = (p.guide->>'assetId')::uuid
    where p.project_id = ${dup.project.id} order by art`);
  // The duplicated panel's sketch and the panel that reuses artwork as its guide.
  expect([...rows]).toEqual([
    { same: true, art: false },
    { same: true, art: true },
  ]);
});
