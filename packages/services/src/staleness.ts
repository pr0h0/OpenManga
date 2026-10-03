import {
  characterVersions,
  type Database,
  type DbOrTx,
  inArray,
  locationVersions,
  propVersions,
  sql,
} from "@openmanga/db";
import { hashOf, type Pronunciation, promptVisibleCharacter, segmentTextSha } from "@openmanga/domain";

export type ReferenceSubject = "character" | "location" | "prop" | "style";

export const characterFingerprint = (v: {
  description: Parameters<typeof promptVisibleCharacter>[0];
  immutableTraits: string[];
}) => hashOf(promptVisibleCharacter(v.description, v.immutableTraits));

const descriptionFingerprint = (description: unknown) => hashOf(description ?? {});

/**
 * Current fingerprints of subject versions' prompt-visible descriptions. A reference whose stored fingerprint
 * differs was made from an older description and silently undermines any bible fix until regenerated.
 * Styles are not fingerprinted (their references are the style itself).
 */
export async function versionFingerprints(
  db: Database | DbOrTx,
  subject: ReferenceSubject,
  versionIds: string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(versionIds)];
  if (!ids.length || subject === "style") return new Map();
  if (subject === "character") {
    const rows = await db.select().from(characterVersions).where(inArray(characterVersions.id, ids));
    return new Map(rows.map((r) => [r.id, characterFingerprint(r)]));
  }
  const table = subject === "location" ? locationVersions : propVersions;
  const rows = await db
    .select({ id: table.id, description: table.description })
    .from(table)
    .where(inArray(table.id, ids));
  return new Map(rows.map((r) => [r.id, descriptionFingerprint(r.description)]));
}

export async function versionFingerprint(db: Database | DbOrTx, subject: ReferenceSubject, versionId: string) {
  return (await versionFingerprints(db, subject, [versionId])).get(versionId) ?? null;
}

export const isStale = (ref: { sourceFingerprint: string | null }, current: string | undefined) =>
  Boolean(ref.sourceFingerprint && current && ref.sourceFingerprint !== current);

/**
 * The latest story revision when it is newer than the one the applied analysis read, or null: the story was revised
 * after the project was built from it. A project never analysed (or built by hand) has nothing to re-analyse.
 */
export async function revisedStory(db: Database, projectId: string) {
  const [row] = await db.execute<{ id: string | null }>(sql`
    select r.id from story_revisions r
    where r.project_id = ${projectId}
      and r.id <> (select a.story_revision_id from story_analyses a
                   where a.project_id = ${projectId} and a.status = 'applied'
                   order by a.applied_at desc nulls last limit 1)
      and r.revision_number = (select max(revision_number) from story_revisions where project_id = ${projectId})`);
  return row?.id ?? null;
}

/**
 * `from … where …` over the project's narration segments (alias `s`) in its own language that have no audio, or audio
 * made from other text, voice or speed: what the audio stage counts and a production run's audio step waits for.
 */
export const staleAudioFrom = (project: {
  id: string;
  language: string;
  settings: { narrationVoice: string; narrationSpeed: number };
}) => sql`from narration_segments s
  join narration_lines nl on nl.id = s.narration_line_id
  left join audio_assets a on a.asset_id = s.active_audio_asset_id
  where nl.project_id = ${project.id} and nl.language = ${project.language}
    and (a.asset_id is null or a.text_sha256 <> s.text_sha256
      or a.voice <> coalesce(s.voice, ${project.settings.narrationVoice})
      or abs(a.speed - coalesce(s.speed, ${project.settings.narrationSpeed})) > 0.001)`;

/**
 * Re-hashes the project's narration segments after its pronunciation dictionary changed. A segment's hash is of what
 * the voice says, so only segments whose spoken text changed get a new hash: their audio reads as stale (the audio
 * stage, the narration page, "synthesize missing"), and every other segment keeps its audio. Returns how many changed.
 */
export async function rehashNarrationSegments(
  db: Database | DbOrTx,
  projectId: string,
  dictionary: readonly Pronunciation[],
) {
  const rows = await db.execute<{ id: string; text: string; text_sha256: string }>(
    sql`select id, text, text_sha256 from narration_segments where project_id = ${projectId}`,
  );
  const changed = [...rows]
    .map((r) => ({ id: r.id, sha: segmentTextSha(r.text, dictionary), was: r.text_sha256 }))
    .filter((r) => r.sha !== r.was);
  // Chunked so a project with thousands of segments stays within a statement's parameter limit.
  for (let i = 0; i < changed.length; i += 1000) {
    const chunk = changed.slice(i, i + 1000);
    await db.execute(sql`update narration_segments s set text_sha256 = v.sha, updated_at = now()
      from (values ${sql.join(
        chunk.map((r) => sql`(${r.id}::uuid, ${r.sha})`),
        sql`, `,
      )}) as v(id, sha) where s.id = v.id`);
  }
  return changed.length;
}

/**
 * The chapter text a plan is made from, as the planner reads it (the source excerpt, or the summary when there is
 * none), trimmed: a re-analysis that only moves the whitespace around a chapter does not change it. `c` is the SQL
 * name or alias of the chapters row.
 */
const chapterText = (c: string) =>
  sql.raw(`btrim(coalesce(nullif(btrim(${c}.source_excerpt, E' \\n\\r\\t'), ''), ${c}.summary), E' \\n\\r\\t')`);

/**
 * Fingerprint of what a chapter's plan is made from: recorded when the chapter is planned (or the person keeps the
 * plan), and compared with the current one to tell a plan made from text that has changed since.
 */
export const planSourceFingerprint = (c: string) => sql`md5(${chapterText(c)})`;

/**
 * Fingerprint of what a chapter's narration is written from: its panels in reading order with their story beat and
 * dialogue (what the narration prompt narrates, panel by panel).
 */
export const narrationSourceFingerprint = (c: string) => sql`md5(coalesce((
  select string_agg(pn.id::text || ':' || pn.story_beat || ':' || coalesce((
      select string_agg(d.text, '|' order by d."order", d.id) from dialogue_lines d where d.panel_id = pn.id), ''),
    E'\\n' order by p."order", pn."order", pn.id)
  from panels pn join pages p on p.id = pn.page_id where p.chapter_id = ${sql.raw(c)}.id), ''))`;

/** Record a chapter's plan fingerprint as of now (it was just planned, or the person keeps the plan as it is). */
export async function recordPlanFingerprint(db: Database | DbOrTx, chapterId: string) {
  await db.execute(
    sql`update chapters set plan_fingerprint = ${planSourceFingerprint("chapters")} where id = ${chapterId}`,
  );
}

/** Record a chapter's narration fingerprint as of now (its narration was just written, or the person keeps it). */
export async function recordNarrationFingerprint(db: Database | DbOrTx, chapterId: string) {
  await db.execute(
    sql`update chapters set narration_fingerprint = ${narrationSourceFingerprint("chapters")} where id = ${chapterId}`,
  );
}

/**
 * Chapters that have pages but whose text changed after they were planned, and chapters that have narration but
 * whose panels or dialogue changed after it was written (in the project's language). Neither is redone on its own:
 * re-planning replaces pages and artwork, so a person keeps the current one or asks for it again.
 */
export async function staleChapters(db: Database, project: { id: string; language: string }) {
  const rows = await db.execute<{
    id: string;
    title: string;
    order: number;
    pages: number;
    panels: number;
    drawn: number;
    lines: number;
    plan: boolean;
    narration: boolean;
  }>(sql`
    select * from (
      select c.id, c.title, c."order",
        (select count(*)::int from pages p where p.chapter_id = c.id) as pages,
        (select count(*)::int from panels pn join pages p on p.id = pn.page_id where p.chapter_id = c.id) as panels,
        (select count(*)::int from panels pn join pages p on p.id = pn.page_id
          where p.chapter_id = c.id and pn.active_artwork_asset_id is not null) as drawn,
        (select count(*)::int from narration_lines nl where nl.chapter_id = c.id and nl.language = ${project.language})
          as lines,
        c.plan_fingerprint is not null and c.plan_fingerprint <> ${planSourceFingerprint("c")} as plan,
        c.narration_fingerprint is not null and c.narration_fingerprint <> ${narrationSourceFingerprint("c")}
          as narration
      from chapters c where c.project_id = ${project.id}) x
    where (x.plan and x.pages > 0) or (x.narration and x.lines > 0)
    order by x."order"`);
  const view = (r: (typeof rows)[number]) => ({
    chapterId: r.id,
    title: r.title,
    pages: r.pages,
    panels: r.panels,
    drawnPanels: r.drawn,
    narrationLines: r.lines,
  });
  return {
    plans: rows.filter((r) => r.plan && r.pages > 0).map(view),
    narration: rows.filter((r) => r.narration && r.lines > 0).map(view),
  };
}

/** The production pipeline's stages, in order: each one is made from the ones before it. */
export const PIPELINE_STAGES = ["story", "plan", "prompts", "art", "narration", "audio", "render"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * What is out of date along story → plan → prompts → art → narration → audio → render, for the project's own
 * language. Each stage counts what is missing or older than what it is made from:
 *
 * - story: the latest story revision is not the one the applied analysis read (a run re-analyses it and always
 *   stops for the user to review the changes before applying);
 * - plan: chapters with no pages, and chapters whose text changed after they were planned (`stale.plans`);
 * - prompts: pages with a panel still to draw and no prepared prompt;
 * - art: panels without artwork, and panels whose spec was edited after their artwork was made (`staleArt`);
 * - narration: chapters with panels but no narration, and chapters whose panels or dialogue changed after their
 *   narration was written (`stale.narration`);
 * - audio: segments without audio, or whose audio was made from other text, voice or speed;
 * - render: no whole-project video yet, or anything it is drawn from changed after the newest one was queued.
 */
export async function pipelineStaleness(
  db: Database,
  project: { id: string; language: string; settings: { narrationVoice: string; narrationSpeed: number } },
) {
  const one = async <T>(q: ReturnType<typeof sql>) => (await db.execute<T & Record<string, unknown>>(q))[0]!;
  const story = { stale: Boolean(await revisedStory(db, project.id)) };
  const stale = await staleChapters(db, project);
  const counts = await one<{
    plan: number;
    prompts: number;
    missing_art: number;
    narration: number;
    audio: number;
  }>(sql`
    select
      (select count(*)::int from chapters c where c.project_id = ${project.id}
        and not exists (select 1 from pages p where p.chapter_id = c.id)) as plan,
      (select count(distinct p.id)::int from pages p join panels pn on pn.page_id = p.id
        where p.project_id = ${project.id} and pn.active_artwork_asset_id is null and pn.prompt_draft is null) as prompts,
      (select count(*)::int from panels pn where pn.project_id = ${project.id} and pn.active_artwork_asset_id is null)
        as missing_art,
      (select count(*)::int from chapters c where c.project_id = ${project.id}
        and exists (select 1 from panels pn join pages p on p.id = pn.page_id where p.chapter_id = c.id)
        and not exists (select 1 from narration_lines nl where nl.chapter_id = c.id and nl.language = ${project.language}))
        as narration,
      (select count(*)::int ${staleAudioFrom(project)}) as audio`);
  const staleArt = (
    await db.execute<{ id: string }>(sql`
      select pn.id from panels pn join assets a on a.id = pn.active_artwork_asset_id
      where pn.project_id = ${project.id}
        and exists (select 1 from panel_specs ps where ps.panel_id = pn.id and ps.source = 'user'
                    and ps.created_at > a.created_at)`)
  ).map((r) => r.id);
  const render = await one<{ rendered: boolean; changed: boolean }>(sql`
    with film as (
      select j.created_at from export_jobs j
      where j.project_id = ${project.id} and j.kind in ('video_pages', 'video_panels') and j.status = 'completed'
        and j.chapter_id is null and j.options -> 'pageIds' is null and j.options -> 'video' -> 'maxDurationMs' is null
        and exists (select 1 from exports e where e.export_job_id = j.id)
      order by j.created_at desc limit 1)
    select exists (select 1 from film) as rendered,
      coalesce((select greatest(
        (select max(pn.updated_at) from panels pn where pn.project_id = ${project.id}),
        (select max(a.created_at) from panels pn join assets a on a.id = pn.active_artwork_asset_id
          where pn.project_id = ${project.id}),
        (select max(p.updated_at) from pages p where p.project_id = ${project.id}),
        (select max(nl.updated_at) from narration_lines nl where nl.project_id = ${project.id}),
        (select max(s.updated_at) from narration_segments s where s.project_id = ${project.id}),
        (select max(d.updated_at) from dialogue_lines d where d.project_id = ${project.id}),
        (select max(x.updated_at) from sound_effects x where x.project_id = ${project.id}),
        (select pr.updated_at from projects pr where pr.id = ${project.id})
      ) > (select created_at from film)), false) as changed`);
  const stages: { key: PipelineStage; count: number; note: string }[] = [
    {
      key: "story",
      count: story.stale ? 1 : 0,
      note: "The story was revised after it was analysed: an update re-analyses it and waits for your review",
    },
    {
      key: "plan",
      count: counts.plan + stale.plans.length,
      note: `${counts.plan} chapter(s) without a plan, ${stale.plans.length} whose text changed after planning`,
    },
    { key: "prompts", count: counts.prompts, note: "pages with panels to draw and no prepared prompt" },
    {
      key: "art",
      count: counts.missing_art + staleArt.length,
      note: `${counts.missing_art} panel(s) without artwork, ${staleArt.length} edited after their artwork`,
    },
    {
      key: "narration",
      count: counts.narration + stale.narration.length,
      note: `${counts.narration} chapter(s) with panels but no narration, ${stale.narration.length} changed after it was written`,
    },
    { key: "audio", count: counts.audio, note: "narration segments without up-to-date audio" },
    {
      key: "render",
      count: !render.rendered || render.changed ? 1 : 0,
      note: render.rendered ? "the video is older than what it is drawn from" : "no whole-project video yet",
    },
  ];
  return { stages, staleArt, stale };
}
