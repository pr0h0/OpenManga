import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "@openmanga/db";
import { unzipSync, zipSync } from "fflate";
import { type startHarness as Start, startHarness, type TestClient, waitFor } from "./harness.ts";

const STORY = `Chapter 1: The Rooftop

Woo Jin climbed onto the rooftop in the rain. Woo Jin held the old sword his father left him.
"Who's there?" Woo Jin asked, hearing footsteps behind him.
Kim Do-yun stepped out of the shadows near the stairwell. Kim Do-yun smiled coldly.
"You shouldn't be here," Kim Do-yun said. The door slammed shut with a BANG.
Woo Jin tightened his grip on the sword as the city lights flickered below.`;

type H = Awaited<ReturnType<typeof Start>>;
type Job = { id: string; status: string };
type ExportJob = {
  id: string;
  kind: string;
  status: string;
  failureReason: string | null;
  result: { projectId: string; warnings: string[]; counts: Record<string, number> } | null;
  files: { assetId: string; fileName: string }[];
};

let h: H;
let alice: TestClient;
let bob: TestClient;

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  bob = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "alice", email: "alice@example.com", password: "pw alice 12" },
    201,
  );
  await bob.post("/api/auth/register", { username: "bob", email: "bob@example.com", password: "pw bob 1234" }, 201);
}, 60_000);
afterAll(async () => {
  await h?.stop();
});

const waitGen = (id: string) =>
  waitFor(
    async () => {
      const r = await alice.get<{ job: Job }>(`/api/generations/${id}`);
      return ["completed", "failed", "cancelled"].includes(r.job.status) ? r.job : null;
    },
    { label: `job ${id}`, timeoutMs: 60_000 },
  );

const waitExport = (projectId: string, jobId: string) =>
  waitFor(
    async () => {
      const l = await alice.get<{ jobs: ExportJob[] }>(`/api/projects/${projectId}/exports`);
      const j = l.jobs.find((x) => x.id === jobId);
      return j && ["completed", "failed", "cancelled"].includes(j.status) ? j : null;
    },
    { label: `export job ${jobId}`, timeoutMs: 120_000 },
  );

async function exportAndDownload(projectId: string, kind: "zip_package" | "project_json") {
  const r = await alice.post<{ job: { id: string } }>(
    `/api/projects/${projectId}/exports`,
    { kind, chapterId: null, includeAssets: true, acknowledgeIssues: true },
    202,
  );
  const done = await waitExport(projectId, r.job.id);
  expect(`${done.status}:${done.failureReason ?? ""}`).toBe("completed:");
  const res = await alice.raw("GET", `/cdn/a/${done.files[0]!.assetId}`);
  expect(res.status).toBe(200);
  return { data: new Uint8Array(await res.arrayBuffer()), name: done.files[0]!.fileName };
}

/** Raw body, the path the web client uses: the upload is streamed to disk rather than buffered. */
async function importFile(data: Uint8Array<ArrayBuffer>, name: string) {
  const r = await alice.json<{ project: { id: string }; job: { id: string; kind: string } }>(
    "POST",
    `/api/projects/import?name=${encodeURIComponent(name)}`,
    new Blob([new Uint8Array(data)], { type: "application/zip" }),
    202,
  );
  expect(r.job.kind).toBe("project_import");
  return { projectId: r.project.id, job: await waitExport(r.project.id, r.job.id) };
}

async function counts(projectId: string) {
  const [row] = await h.deps.db.execute<Record<string, number>>(sql`
    select
      (select count(*)::int from characters where project_id = ${projectId} and deleted_at is null) as characters,
      (select count(*)::int from chapters where project_id = ${projectId}) as chapters,
      (select count(*)::int from pages where project_id = ${projectId}) as pages,
      (select count(*)::int from panels where project_id = ${projectId}) as panels,
      (select count(*)::int from dialogue_lines where project_id = ${projectId}) as dialogue,
      (select count(*)::int from narration_lines where project_id = ${projectId}) as narration`);
  return row!;
}

/**
 * Puts a non-default value on every field the interchange format used to drop, so the round trip can prove it
 * carries them. Written straight to the database: several have no route of their own (a locked revision, a
 * reference's outfit link), and what is under test is the export/import pair, not the routes that set them.
 */
async function markDetails(projectId: string, pageId: string, panelId: string) {
  const db = h.deps.db;
  await db.execute(sql`update story_revisions set locked_at = now() where project_id = ${projectId}`);
  await db.execute(sql`update pages set reading_direction = 'rtl', status = 'approved' where id = ${pageId}`);
  await db.execute(sql`update narration_segments set pause_after_ms = 900 where project_id = ${projectId}`);
  // The oldest artwork version, so a permuted history would show up as the approval landing on the wrong one.
  await db.execute(sql`
    update assets set status = 'approved' where id = (
      select id from assets where project_id = ${projectId} and type = 'panel_art' and deleted_at is null
      order by created_at, id limit 1)`);
  const description = JSON.stringify({
    kind: "sword",
    material: "steel",
    size: "arm length",
    colors: "dull grey",
    keyFeatures: ["chipped edge"],
    immutableTraits: ["chipped edge"],
    summary: "The old sword Woo Jin's father left him.",
  });
  const [prop] = await db.execute<{ id: string }>(
    sql`insert into props (project_id, name) values (${projectId}, 'Old sword') returning id`,
  );
  const [version] = await db.execute<{ id: string }>(sql`
    insert into prop_versions (prop_id, version_number, description, status)
    values (${prop!.id}, 1, ${description}::jsonb, 'approved') returning id`);
  await db.execute(sql`update props set current_version_id = ${version!.id} where id = ${prop!.id}`);
  await db.execute(sql`
    update panels set prop_version_ids = ${JSON.stringify([version!.id])}::jsonb, approval_status = 'approved'
    where id = ${panelId}`);
  // Outfit wardrobe: the planner joins reference_assets.outfit_id -> character_outfits, so both ends must survive.
  const [outfit] = await db.execute<{ id: string }>(sql`
    insert into character_outfits (character_id, character_version_id, name, description, is_default)
    select v.character_id, v.id, 'Rooftop coat', 'A long wet coat.', false
    from reference_assets r join character_versions v on v.id = r.character_version_id
    where r.project_id = ${projectId} limit 1 returning id`);
  await db.execute(sql`
    update reference_assets set outfit_id = ${outfit!.id}, status = 'approved'
    where project_id = ${projectId} and character_version_id is not null`);
  // An outfit change on the panel: it must come back pointing at the imported character, outfit and panel.
  await db.execute(sql`
    insert into outfit_assignments (project_id, character_id, outfit_id, panel_id, scope)
    select ${projectId}, o.character_id, o.id, ${panelId}, 'onward' from character_outfits o where o.id = ${outfit!.id}`);
}

/** The same fields read back, as counts that must match between the source project and its re-import. */
async function details(projectId: string) {
  const [row] = await h.deps.db.execute<Record<string, number | string>>(sql`
    select
      (select count(*)::int from story_revisions
        where project_id = ${projectId} and locked_at is not null) as locked_revisions,
      (select count(*)::int from pages
        where project_id = ${projectId} and reading_direction = 'rtl' and status = 'approved') as rtl_approved_pages,
      (select count(*)::int from narration_segments
        where project_id = ${projectId} and pause_after_ms = 900) as tuned_pauses,
      (select count(*)::int from panels
        where project_id = ${projectId} and approval_status = 'approved'
          and jsonb_array_length(prop_version_ids) = 1) as approved_panels_with_props,
      (select count(*)::int from panels p join prop_versions pv
          on pv.id = (p.prop_version_ids->>0)::uuid join props pr on pr.id = pv.prop_id
        where p.project_id = ${projectId} and pr.project_id = ${projectId}) as resolvable_prop_pins,
      (select count(*)::int from reference_assets r join character_outfits o on o.id = r.outfit_id
        join characters c on c.id = o.character_id
        where r.project_id = ${projectId} and c.project_id = ${projectId}
          and o.character_version_id = r.character_version_id) as outfit_references,
      (select string_agg(a.scope || ':' || o.name, ',') from outfit_assignments a
        join character_outfits o on o.id = a.outfit_id join characters c on c.id = a.character_id
        join panels p on p.id = a.panel_id
        where a.project_id = ${projectId} and c.project_id = ${projectId} and p.project_id = ${projectId}
          and o.character_id = c.id) as outfit_changes,
      (select string_agg(status::text, ',' order by created_at, id) from assets
        where project_id = ${projectId} and type = 'panel_art' and deleted_at is null) as artwork_statuses`);
  return row!;
}

const artworkShas = async (projectId: string) =>
  (
    await h.deps.db.execute<{ sha256: string }>(sql`
      select a.sha256 from panels p join assets a on a.id = p.active_artwork_asset_id
      where p.project_id = ${projectId} order by a.sha256`)
  ).map((r) => r.sha256);

describe("project import", () => {
  let sourceId = "";

  test("build a source project (story -> cast -> plan -> panel -> lettering -> narration)", async () => {
    const p = await alice.post<{ project: { id: string } }>(
      "/api/projects",
      { title: "Import Source", story: { content: STORY, inputKind: "story" } },
      201,
    );
    sourceId = p.project.id;
    const story = await alice.get<{ latest: { id: string } }>(`/api/projects/${sourceId}/story`);
    const a = await alice.post<{ job: Job; analysis: { id: string } }>(
      `/api/story-revisions/${story.latest.id}/analyze`,
      {},
      202,
    );
    expect((await waitGen(a.job.id)).status).toBe("completed");
    await alice.post(`/api/story-analyses/${a.analysis.id}/apply`, {});

    const cast = await alice.get<{ characters: { id: string; name: string; currentVersionId: string }[] }>(
      `/api/projects/${sourceId}/characters`,
    );
    const woo = cast.characters.find((c) => c.name === "Woo Jin")!;
    const g = await alice.post<{ job: Job }>(
      `/api/character-versions/${woo.currentVersionId}/references/generate`,
      { kind: "portrait" },
      202,
    );
    expect((await waitGen(g.job.id)).status).toBe("completed");

    const chs = await alice.get<{ chapters: { id: string }[] }>(`/api/projects/${sourceId}/chapters`);
    const chapterId = chs.chapters[0]!.id;
    const plan = await alice.post<{ job: Job }>(`/api/chapters/${chapterId}/plan`, {}, 202);
    expect((await waitGen(plan.job.id)).status).toBe("completed");
    const ch = await alice.get<{ pages: { id: string }[] }>(`/api/chapters/${chapterId}`);
    const pageId = ch.pages[0]!.id;
    const page = await alice.get<{ panels: { id: string }[] }>(`/api/pages/${pageId}`);
    const panelId = page.panels[0]!.id;
    await alice.patch(`/api/panels/${panelId}`, { characterVersionIds: [woo.currentVersionId] });
    const gen = await alice.post<{ job: Job }>(`/api/panels/${panelId}/generate`, {}, 202);
    expect((await waitGen(gen.job.id)).status).toBe("completed");

    await alice.post(`/api/pages/${pageId}/dialogue`, { panelId, text: "Who's there?" }, 201);
    const line = await alice.post<{ segments: { id: string }[] }>(
      `/api/chapters/${chapterId}/narration/lines`,
      { text: "The rain would not stop that night.", panelId },
      201,
    );
    await alice.post(`/api/chapters/${chapterId}/narration/synthesize`, { onlyMissing: true }, 202);
    await waitFor(
      async () => {
        const r = await alice.get<{ lines: { segments: { audio: unknown }[] }[] }>(
          `/api/chapters/${chapterId}/narration`,
        );
        return r.lines.every((l) => l.segments.every((s) => s.audio)) ? r : null;
      },
      { label: "tts" },
    );
    expect(line.segments.length).toBeGreaterThan(0);

    // A second version, so the panel has an artwork history whose order the round trip has to preserve.
    const regen = await alice.post<{ job: Job }>(`/api/panels/${panelId}/generate`, {}, 202);
    expect((await waitGen(regen.job.id)).status).toBe("completed");
    await markDetails(sourceId, pageId, panelId);
    const src = await details(sourceId);
    expect(src.artwork_statuses).toBe("approved,draft");
    for (const [k, v] of Object.entries(src)) expect(`${k}=${v}`).not.toBe(`${k}=0`);
  }, 240_000);

  test("zip_package round-trips into a new project owned by the importer", async () => {
    const zip = await exportAndDownload(sourceId, "zip_package");
    const { projectId, job } = await importFile(zip.data, zip.name);
    expect(`${job.status}:${job.failureReason ?? ""}`).toBe("completed:");
    expect(job.result?.projectId).toBe(projectId);
    expect(projectId).not.toBe(sourceId);

    const [src, dst] = [await counts(sourceId), await counts(projectId)];
    expect(dst).toEqual(src);
    expect(src.panels).toBeGreaterThan(0);
    expect(src.dialogue).toBeGreaterThan(0);
    expect(src.narration).toBeGreaterThan(0);
    const srcArt = await artworkShas(sourceId);
    expect(srcArt.length).toBeGreaterThan(0);
    expect(await artworkShas(projectId)).toEqual(srcArt);
    // Lossless: pauses, lock, approvals, page direction, prop pins, outfit links and artwork order all come back.
    expect(await details(projectId)).toEqual(await details(sourceId));
    expect((await details(sourceId)).outfit_changes).toBe("onward:Rooftop coat");

    const [audio] = await h.deps.db.execute<{ n: number }>(sql`
      select count(*)::int as n from narration_segments s join audio_assets aa on aa.asset_id = s.active_audio_asset_id
      where s.project_id = ${projectId}`);
    expect(audio!.n).toBeGreaterThan(0);
    const [refs] = await h.deps.db.execute<{ n: number }>(
      sql`select count(*)::int as n from reference_assets where project_id = ${projectId} and subject_type = 'character'`,
    );
    expect(refs!.n).toBeGreaterThan(0);

    const ov = await alice.get<{ project: { title: string; status: string } }>(`/api/projects/${projectId}`);
    expect(ov.project.title).toBe("Import Source");
    expect(ov.project.status).toBe("active");
    await bob.get(`/api/projects/${projectId}`, 404);
    await bob.get(`/api/projects/${projectId}/exports`, 404);
  }, 240_000);

  test("a ZIP wrapped in one directory imports too (GitHub's Download ZIP shape)", async () => {
    const zip = await exportAndDownload(sourceId, "zip_package");
    const entries = unzipSync(new Uint8Array(zip.data));
    const wrapped = zipSync(Object.fromEntries(Object.entries(entries).map(([n, d]) => [`samples-main/${n}`, d])), {
      level: 0,
    });
    const { projectId, job } = await importFile(wrapped, "samples-main.zip");
    expect(`${job.status}:${job.failureReason ?? ""}`).toBe("completed:");
    expect(job.result!.warnings).toEqual([]);
    expect(await artworkShas(projectId)).toEqual(await artworkShas(sourceId));
  }, 240_000);

  test("project_json import completes with warnings about missing files", async () => {
    const json = await exportAndDownload(sourceId, "project_json");
    const { projectId, job } = await importFile(json.data, json.name);
    expect(`${job.status}:${job.failureReason ?? ""}`).toBe("completed:");
    expect(job.result!.warnings.length).toBeGreaterThan(0);
    const c = await counts(projectId);
    expect(c.panels).toBe((await counts(sourceId)).panels);
    expect(await artworkShas(projectId)).toEqual([]);
  }, 120_000);

  test("an upload over IMPORT_MAX_UPLOAD_MB is refused with the configured limit in the message", async () => {
    const original = h.deps.config.IMPORT_MAX_UPLOAD_MB;
    (h.deps.config as { IMPORT_MAX_UPLOAD_MB: number }).IMPORT_MAX_UPLOAD_MB = 1;
    try {
      // The size check runs before the file is even sniffed, so the content does not matter.
      const form = new FormData();
      form.set("file", new File([new Uint8Array(2 * 1024 * 1024)], "big.zip"));
      const res = await alice.json<{ error: { code: string; message: string } }>(
        "POST",
        "/api/projects/import",
        form,
        413,
      );
      expect(res.error.code).toBe("too_large");
      expect(res.error.message).toContain("1 MB");
    } finally {
      (h.deps.config as { IMPORT_MAX_UPLOAD_MB: number }).IMPORT_MAX_UPLOAD_MB = original;
    }
  }, 60_000);

  test("an archive holding two projects imports one and says which it ignored", async () => {
    const zip = await exportAndDownload(sourceId, "zip_package");
    const entries = unzipSync(new Uint8Array(zip.data));
    // What a repository of several sample projects looks like when GitHub zips it.
    const wrapped = zipSync(
      Object.fromEntries([
        ...Object.entries(entries).map(([n, d]) => [`samples-main/comic/${n}`, d]),
        ...Object.entries(entries).map(([n, d]) => [`samples-main/film/${n}`, d]),
      ]),
      { level: 0 },
    );
    const { projectId, job } = await importFile(wrapped, "samples-main.zip");
    expect(`${job.status}:${job.failureReason ?? ""}`).toBe("completed:");
    expect(job.result!.warnings.join(" ")).toContain("contains 2 projects");
    // The one it did restore is whole, not a mixture of the two.
    expect(await artworkShas(projectId)).toEqual(await artworkShas(sourceId));
  }, 240_000);

  test("an oversized multipart upload is refused before the body is parsed", async () => {
    // The 413 has to come from the declared length: parsing a 1.5 GB multipart body is what used to fail, and it
    // surfaced as a 502 rather than a message telling the caller to stream it.
    const form = new FormData();
    form.set("file", new File([new Uint8Array(1024)], "big.zip"));
    const res = await alice.raw("POST", "/api/projects/import", form, {
      "content-length": String(200 * 1024 * 1024),
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error.message).toContain("raw body");
  }, 60_000);

  test("a multipart upload still works", async () => {
    const zip = await exportAndDownload(sourceId, "zip_package");
    const form = new FormData();
    form.set("file", new File([new Uint8Array(zip.data)], zip.name));
    const r = await alice.json<{ project: { id: string }; job: { id: string } }>(
      "POST",
      "/api/projects/import",
      form,
      202,
    );
    const job = await waitExport(r.project.id, r.job.id);
    expect(`${job.status}:${job.failureReason ?? ""}`).toBe("completed:");
    expect(await artworkShas(r.project.id)).toEqual(await artworkShas(sourceId));
  }, 240_000);

  test("garbage and invalid documents are rejected", async () => {
    const form = new FormData();
    form.set("file", new File(["definitely not a project"], "x.zip"));
    await alice.json("POST", "/api/projects/import", form, 400);

    // valid JSON but not an interchange document: accepted by the API, failed by the worker, placeholder archived
    const { projectId, job } = await importFile(new TextEncoder().encode('{"hello":"world"}'), "bad.json");
    expect(job.status).toBe("failed");
    expect(job.failureReason).toContain("Not a valid OpenManga project file");
    const ov = await alice.get<{ project: { title: string; status: string } }>(`/api/projects/${projectId}`);
    expect(ov.project.status).toBe("archived");
    expect(ov.project.title.startsWith("[import failed] ")).toBe(true);
  }, 60_000);
});
