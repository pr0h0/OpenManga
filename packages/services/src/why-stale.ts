import { type Database, sql } from "@openmanga/db";
import { splitParagraphs, stableStringify } from "@openmanga/domain";
import { type PipelineStage, pipelineStaleness, revisedStory } from "./staleness.ts";
import { chapterTrace } from "./trace.ts";

/** One out-of-date thing: what it is, what changed under it, and what bringing it up to date would redo. */
export type WhyItem = {
  label: string;
  why: string;
  redo: string;
  chapterId?: string;
  pageId?: string;
  panelId?: string;
};
export type WhyStage = { key: PipelineStage; items: WhyItem[]; more: number };

const CAP = 100;
const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
const list = (xs: string[]) => xs.filter(Boolean).join(", ");

/**
 * Why each pipeline stage is out of date, item by item, along story revision → chapter plan → prompts → panel →
 * artwork → narration → audio → render: the dependency behind each count of the staleness report, and what an
 * update would redo for it. Read-only, except that a stale chapter planned before tracing existed is traced first.
 */
export async function whyStale(
  db: Database,
  project: { id: string; language: string; settings: { narrationVoice: string; narrationSpeed: number } },
): Promise<WhyStage[]> {
  const rows = <T>(q: ReturnType<typeof sql>) => db.execute<T & Record<string, unknown>>(q);
  const { stale } = await pipelineStaleness(db, project);
  const out: Record<PipelineStage, WhyItem[]> = {
    story: [],
    plan: [],
    prompts: [],
    art: [],
    narration: [],
    audio: [],
    render: [],
  };

  // Story: the newest revision against the one the applied analysis read, by paragraph.
  const revised = await revisedStory(db, project.id);
  if (revised) {
    const [r] = await rows<{ new_n: number; new_t: string; old_n: number | null; old_t: string | null }>(sql`
      select r.revision_number as new_n, r.content as new_t, o.revision_number as old_n, o.content as old_t
      from story_revisions r
      left join story_revisions o on o.id = (select a.story_revision_id from story_analyses a
        where a.project_id = ${project.id} and a.status = 'applied' order by a.applied_at desc nulls last limit 1)
      where r.id = ${revised}`);
    const was = new Set(splitParagraphs(r?.old_t ?? "").map((p) => p.text));
    const now = new Set(splitParagraphs(r?.new_t ?? "").map((p) => p.text));
    const added = [...now].filter((p) => !was.has(p)).length;
    const removed = [...was].filter((p) => !now.has(p)).length;
    out.story.push({
      label: `Story revision ${r?.new_n}`,
      why: `Newer than revision ${r?.old_n ?? "?"} the project was built from: ${
        list([
          added ? `${n(added, "paragraph")} new or changed` : "",
          removed ? `${n(removed, "paragraph")} removed or changed` : "",
        ]) || "only spacing changed"
      }`,
      redo: "Re-analyse it; what it would change waits for your review before anything is applied",
    });
  }

  // Plan: chapters never planned, and chapters whose text changed after planning (with the panels it hits).
  for (const c of await rows<{ id: string; title: string }>(sql`
    select c.id, c.title from chapters c where c.project_id = ${project.id}
      and not exists (select 1 from pages p where p.chapter_id = c.id) order by c."order"`))
    out.plan.push({ label: c.title, chapterId: c.id, why: "Not planned yet", redo: "Plan it: new pages and panels" });
  for (const c of stale.plans) {
    const t = await chapterTrace(db, c.chapterId, project.language);
    const hit = t?.panels.filter((p) => p.changed) ?? [];
    out.plan.push({
      label: c.title,
      chapterId: c.chapterId,
      why: hit.length
        ? `Its text changed after planning: ${hit.length === 1 ? "1 panel tells" : `${hit.length} panels tell`} revised text (${hit
            .slice(0, 6)
            .map((p) => `page ${p.page} panel ${p.panel}`)
            .join(", ")}${hit.length > 6 ? ", …" : ""})`
        : "Its text changed after planning, but no panel's own text did (text was added, moved or reworded between)",
      redo: `Re-planning replaces its ${n(c.pages, "page")} and ${n(c.drawnPanels, "drawn panel")}; keeping it marks it current`,
    });
  }

  // Prompts: pages with a panel still to draw and nothing prepared, per chapter.
  for (const c of await rows<{ id: string; title: string; pages: number }>(sql`
    select c.id, c.title, count(distinct p.id)::int as pages from chapters c
      join pages p on p.chapter_id = c.id join panels pn on pn.page_id = p.id
    where c.project_id = ${project.id} and pn.active_artwork_asset_id is null and pn.prompt_draft is null
    group by c.id order by min(c."order")`))
    out.prompts.push({
      label: c.title,
      chapterId: c.id,
      why: `${n(c.pages, "page")} with panels to draw and no prepared prompt`,
      redo: `Prepare prompts: ${n(c.pages, "text request")}, one per page`,
    });

  // Art: undrawn panels per chapter, and each panel whose spec was edited after its artwork, with the fields.
  for (const c of await rows<{ id: string; title: string; k: number }>(sql`
    select c.id, c.title, count(*)::int as k from chapters c
      join pages p on p.chapter_id = c.id join panels pn on pn.page_id = p.id
    where c.project_id = ${project.id} and pn.active_artwork_asset_id is null
    group by c.id order by min(c."order")`))
    out.art.push({
      label: c.title,
      chapterId: c.id,
      why: `${n(c.k, "panel")} not drawn yet`,
      redo: `Draw ${n(c.k, "image")}`,
    });
  for (const p of await rows<{
    id: string;
    page_id: string;
    chapter_id: string;
    title: string;
    page: number;
    panel: number;
    now: Record<string, unknown> | null;
    was: Record<string, unknown> | null;
  }>(sql`
    select pn.id, pn.page_id, c.id as chapter_id, c.title, pg."order" as page, pn."order" as panel,
      (select ps.spec from panel_specs ps where ps.panel_id = pn.id order by ps.version_number desc limit 1) as now,
      (select ps.spec from panel_specs ps where ps.panel_id = pn.id and ps.created_at <= a.created_at
        order by ps.version_number desc limit 1) as was
    from panels pn join assets a on a.id = pn.active_artwork_asset_id
      join pages pg on pg.id = pn.page_id join chapters c on c.id = pg.chapter_id
    where pn.project_id = ${project.id}
      and exists (select 1 from panel_specs ps where ps.panel_id = pn.id and ps.source = 'user'
                  and ps.created_at > a.created_at)
    order by c."order", pg."order", pn."order"`)) {
    const keys = [...new Set([...Object.keys(p.now ?? {}), ...Object.keys(p.was ?? {})])];
    const fields = keys.filter((k) => stableStringify(p.now?.[k]) !== stableStringify(p.was?.[k]));
    out.art.push({
      label: `${p.title} · page ${p.page}, panel ${p.panel}`,
      chapterId: p.chapter_id,
      pageId: p.page_id,
      panelId: p.id,
      why: fields.length
        ? `Edited after its artwork was drawn: ${list(fields.slice(0, 8))}${fields.length > 8 ? ", …" : ""}`
        : "Its spec was saved again after its artwork was drawn",
      redo: "Draw it again (1 image); the current artwork stays as a version",
    });
  }

  // Narration: chapters without it, and chapters whose panels or dialogue changed after it was written.
  for (const c of await rows<{ id: string; title: string }>(sql`
    select c.id, c.title from chapters c where c.project_id = ${project.id}
      and exists (select 1 from panels pn join pages p on p.id = pn.page_id where p.chapter_id = c.id)
      and not exists (select 1 from narration_lines nl where nl.chapter_id = c.id and nl.language = ${project.language})
    order by c."order"`))
    out.narration.push({
      label: c.title,
      chapterId: c.id,
      why: "Has panels but no narration",
      redo: "Write its narration",
    });
  for (const c of stale.narration) {
    const touched = await rows<{ page: number; panel: number }>(sql`
      with w as (select max(created_at) as at from narration_lines
        where chapter_id = ${c.chapterId} and language = ${project.language})
      select p."order" as page, pn."order" as panel from panels pn join pages p on p.id = pn.page_id, w
      where p.chapter_id = ${c.chapterId} and (pn.created_at > w.at
        or exists (select 1 from panel_specs ps where ps.panel_id = pn.id and ps.created_at > w.at)
        or exists (select 1 from dialogue_lines d where d.panel_id = pn.id and d.updated_at > w.at))
      order by p."order", pn."order"`);
    out.narration.push({
      label: c.title,
      chapterId: c.chapterId,
      why: touched.length
        ? `Its panels or dialogue changed after it was written: ${touched
            .slice(0, 6)
            .map((t) => `page ${t.page} panel ${t.panel}`)
            .join(", ")}${touched.length > 6 ? ", …" : ""}`
        : "Its panels changed after it was written (panels removed, reordered or moved between pages)",
      redo: `Writing it again replaces its ${n(c.narrationLines, "line")} and their audio; keeping it marks it current`,
    });
  }

  // Audio: per chapter, segments without audio or with audio made from other text, voice or speed.
  const voice = project.settings.narrationVoice;
  const speed = project.settings.narrationSpeed;
  for (const c of await rows<{ id: string; title: string; none: number; text: number; voice: number; speed: number }>(
    sql`select c.id, c.title,
        count(*) filter (where a.asset_id is null)::int as none,
        count(*) filter (where a.asset_id is not null and a.text_sha256 <> s.text_sha256)::int as text,
        count(*) filter (where a.asset_id is not null and a.text_sha256 = s.text_sha256
          and a.voice <> coalesce(s.voice, ${voice}))::int as voice,
        count(*) filter (where a.asset_id is not null and a.text_sha256 = s.text_sha256
          and a.voice = coalesce(s.voice, ${voice})
          and abs(a.speed - coalesce(s.speed, ${speed})) > 0.001)::int as speed
      from narration_segments s
        join narration_lines nl on nl.id = s.narration_line_id
        join chapters c on c.id = nl.chapter_id
        left join audio_assets a on a.asset_id = s.active_audio_asset_id
      where nl.project_id = ${project.id} and nl.language = ${project.language}
      group by c.id order by min(c."order")`,
  )) {
    const k = c.none + c.text + c.voice + c.speed;
    if (!k) continue;
    out.audio.push({
      label: c.title,
      chapterId: c.id,
      why: list([
        c.none ? `${n(c.none, "segment")} without audio` : "",
        c.text ? `${n(c.text, "segment")} whose text or pronunciation changed` : "",
        c.voice ? `${n(c.voice, "segment")} in another voice` : "",
        c.speed ? `${n(c.speed, "segment")} at another speed` : "",
      ]),
      redo: `Synthesize ${n(k, "segment")}`,
    });
  }

  // Render: what changed after the newest whole-project video.
  const [film] = await rows<{ at: string | null }>(sql`
    select max(j.created_at)::text as at from export_jobs j
    where j.project_id = ${project.id} and j.kind in ('video_pages', 'video_panels') and j.status = 'completed'
      and j.chapter_id is null and j.options -> 'pageIds' is null and j.options -> 'video' -> 'maxDurationMs' is null
      and exists (select 1 from exports e where e.export_job_id = j.id)`);
  if (!film?.at) out.render.push({ label: "Video", why: "No whole-project video yet", redo: "Render the whole video" });
  else {
    const [ch] = await rows<Record<string, number>>(sql`
      select
        (select count(*)::int from panels where project_id = ${project.id} and updated_at > ${film.at}::timestamptz) as panels,
        (select count(*)::int from panels pn join assets a on a.id = pn.active_artwork_asset_id
          where pn.project_id = ${project.id} and a.created_at > ${film.at}::timestamptz) as artwork,
        (select count(*)::int from pages where project_id = ${project.id} and updated_at > ${film.at}::timestamptz) as pages,
        (select count(*)::int from narration_lines where project_id = ${project.id} and updated_at > ${film.at}::timestamptz) as narration,
        (select count(*)::int from narration_segments where project_id = ${project.id} and updated_at > ${film.at}::timestamptz) as audio,
        (select count(*)::int from dialogue_lines where project_id = ${project.id} and updated_at > ${film.at}::timestamptz) as dialogue,
        (select count(*)::int from sound_effects where project_id = ${project.id} and updated_at > ${film.at}::timestamptz) as sfx,
        (select count(*)::int from projects where id = ${project.id} and updated_at > ${film.at}::timestamptz) as settings`);
    const why = list([
      ch?.panels ? `${n(ch.panels, "panel")} edited` : "",
      ch?.artwork ? n(ch.artwork, "new artwork", "new artworks") : "",
      ch?.pages ? `${n(ch.pages, "page")} changed` : "",
      ch?.narration ? `${n(ch.narration, "narration line")} changed` : "",
      ch?.audio ? `${n(ch.audio, "narration segment")} changed` : "",
      ch?.dialogue ? `${n(ch.dialogue, "dialogue line")} changed` : "",
      ch?.sfx ? `${n(ch.sfx, "sound effect")} changed` : "",
      ch?.settings ? "project settings changed" : "",
    ]);
    if (why)
      out.render.push({
        label: "Video",
        why: `Since the newest video (${film.at.slice(0, 16)} UTC): ${why}`,
        redo: "Render it again; sections that did not change come from the render cache",
      });
  }

  return (Object.keys(out) as PipelineStage[]).map((key) => ({
    key,
    items: out[key].slice(0, CAP),
    more: Math.max(0, out[key].length - CAP),
  }));
}
