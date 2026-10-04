import { afterAll, beforeAll, expect, test } from "bun:test";
import { assetVariants, eq, panels, sql } from "@openmanga/db";
import { sharp } from "@openmanga/image-utils";
import { mockImagePng } from "@openmanga/testing";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;
let projectId: string;
let pageId: string;
let versionId: string;
let panelIds: string[];

type Guide = { assetId: string; strength: "loose" | "strict"; pose?: string } | null;
type Preview = { compiledPrompt: string; references: { index: number; role: string; assetId: string }[] };
type JobDetail = {
  job: { status: string; templateVersion: number; compiledPrompt: string };
  inputs: { role: string; assetId: string; variantId: string; sentAs: string; width: number; height: number }[];
};

const form = async (label: string, strength?: string) => {
  const f = new FormData();
  f.set("file", new File([(await mockImagePng({ width: 1600, height: 900, prompt: label })) as BlobPart], "s.png"));
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
  expect(out.asset.width).toBe(1600);
  expect(out.panel.guide).toEqual({ assetId: out.asset.id, strength: "loose", pose: "" });
  expect(await guideOf(panelIds[0]!)).toEqual({ assetId: out.asset.id, strength: "loose", pose: "" });

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
  expect(strict.compiledPrompt).not.toContain("Pose, in words");

  // A typed pose rides with the sketch in POSE / LAYOUT, and clearing it removes the line again.
  await alice.patch(`/api/panels/${panelIds[0]}`, { guide: { ...guide, strength: "strict", pose: "hands on hips" } });
  expect((await guideOf(panelIds[0]!))?.pose).toBe("hands on hips");
  const worded = await alice.get<Preview>(`/api/panels/${panelIds[0]}/prompt-preview`);
  expect(worded.compiledPrompt.split("\n\n")[1]).toContain("Pose, in words: hands on hips");
  await alice.patch(`/api/panels/${panelIds[0]}`, { guide: { ...guide, strength: "strict", pose: "" } });
});

test("generation sends the guide large and lossless (the identity reference stays small), and so does a regeneration", async () => {
  const guide = (await guideOf(panelIds[0]!))!;
  for (const body of [{}, { operation: "change_pose", instruction: "arms crossed" }]) {
    const r = await alice.post<{ job: { id: string } }>(`/api/panels/${panelIds[0]}/generate`, body, 202);
    const done = await waitJob(r.job.id);
    expect(done.job.status).toBe("completed");
    expect(done.job.templateVersion).toBe(12);
    expect(done.job.compiledPrompt).toContain("layout/pose sketch");
    expect(done.job.compiledPrompt).toContain("POSE / LAYOUT:\nCopy the pose of every figure");
    expect(done.inputs.map((i) => i.role)).toEqual(["character_ref", "layout_guide"]);
    const g = done.inputs[1]!;
    expect(g.assetId).toBe(guide.assetId);
    expect(g.sentAs).toBe("prompt_ref_derivative");
    // What the provider gets: the stored variant the worker reads, not just the recorded numbers.
    const [variant] = await h.deps.db.select().from(assetVariants).where(eq(assetVariants.id, g.variantId));
    const sent = await sharp(Buffer.from(await h.deps.assets.readVariant(variant!))).metadata();
    expect(Math.max(sent.width!, sent.height!)).toBeGreaterThanOrEqual(768);
    expect(sent.format).toBe("png");
    expect(Math.max(done.inputs[0]!.width, done.inputs[0]!.height)).toBeLessThanOrEqual(288);
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
  expect(await guideOf(panelIds[1]!)).toEqual({ assetId: art, strength: "strict", pose: "" });
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

test("describe pose reads the guide in a queued vision job and changes nothing on the panel", async () => {
  const p = panelIds[1]!;
  const spec = async () =>
    (await alice.get<{ specs: { spec: { composition?: string } }[] }>(`/api/panels/${p}`)).specs[0]?.spec.composition;
  const before = await spec();
  const r = await alice.post<{ job: { id: string; kind: string; targetId: string } }>(
    `/api/panels/${p}/guide/describe`,
    {},
    202,
  );
  expect(r.job.kind).toBe("image_describe");
  expect(r.job.targetId).toBe((await guideOf(p))!.assetId);
  const done = (await waitJob(r.job.id)) as unknown as {
    job: { status: string; templateName: string; templateVersion: number; result: { description: unknown } };
  };
  expect(done.job.status).toBe("completed");
  expect(done.job.templateName).toBe("image-describe");
  expect(done.job.templateVersion).toBe(2);
  expect((done.job.result.description as { pose: { summary: string } }).pose.summary).toContain("hands on hips");
  // Review first: the composition is only written when the user saves it.
  expect(await spec()).toBe(before);

  // A panel without a guide has nothing to describe.
  await alice.post(`/api/panels/${panelIds[3]}/guide/describe`, {}, 400);
});
