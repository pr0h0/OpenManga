import {
  characterVersions,
  type Database,
  type DbOrTx,
  inArray,
  locationVersions,
  propVersions,
  sql,
} from "@openmanga/db";
import { hashOf, promptVisibleCharacter } from "@openmanga/domain";

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

/** The production pipeline's stages, in order: each one is made from the ones before it. */
export const PIPELINE_STAGES = ["story", "plan", "prompts", "art", "narration", "audio", "render"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * What is out of date along story → plan → prompts → art → narration → audio → render, for the project's own
 * language. Each stage counts what is missing or older than what it is made from:
 *
 * - story: the latest story revision is not the one the applied analysis read (a run re-analyses it and always
 *   stops for the user to review the changes before applying);
 * - plan: chapters with no pages;
 * - prompts: pages with a panel still to draw and no prepared prompt;
 * - art: panels without artwork, and panels whose spec was edited after their artwork was made (`staleArt`);
 * - narration: chapters with panels but no narration;
 * - audio: segments without audio, or whose audio was made from other text, voice or speed;
 * - render: no whole-project video yet, or anything it is drawn from changed after the newest one was queued.
 */
export async function pipelineStaleness(
  db: Database,
  project: { id: string; language: string; settings: { narrationVoice: string; narrationSpeed: number } },
) {
  const one = async <T>(q: ReturnType<typeof sql>) => (await db.execute<T & Record<string, unknown>>(q))[0]!;
  const story = { stale: Boolean(await revisedStory(db, project.id)) };
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
      (select count(*)::int from narration_segments s
        join narration_lines nl on nl.id = s.narration_line_id
        left join audio_assets a on a.asset_id = s.active_audio_asset_id
        where nl.project_id = ${project.id} and nl.language = ${project.language}
          and (a.asset_id is null or a.text_sha256 <> s.text_sha256
            or a.voice <> coalesce(s.voice, ${project.settings.narrationVoice})
            or abs(a.speed - coalesce(s.speed, ${project.settings.narrationSpeed})) > 0.001)) as audio`);
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
    { key: "plan", count: counts.plan, note: "chapters without a plan" },
    { key: "prompts", count: counts.prompts, note: "pages with panels to draw and no prepared prompt" },
    {
      key: "art",
      count: counts.missing_art + staleArt.length,
      note: `${counts.missing_art} panel(s) without artwork, ${staleArt.length} edited after their artwork`,
    },
    { key: "narration", count: counts.narration, note: "chapters with panels but no narration" },
    { key: "audio", count: counts.audio, note: "narration segments without up-to-date audio" },
    {
      key: "render",
      count: !render.rendered || render.changed ? 1 : 0,
      note: render.rendered ? "the video is older than what it is drawn from" : "no whole-project video yet",
    },
  ];
  return { stages, staleArt };
}
