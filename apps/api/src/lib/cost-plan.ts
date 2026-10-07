import { inArray, panels, sql } from "@openmanga/db";
import {
  batchModel,
  IMAGE_KINDS,
  NARRATION_BYTES_PER_SECOND,
  narrationSeconds,
  type PlanKind,
  planUnitsUsd,
  type RateSnapshot,
  sumUsd,
  type UsageTokens,
} from "@openmanga/domain";
import { pipelineStaleness, projectBudget } from "@openmanga/services";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import type { ProjectRecord } from "./access.ts";
import { checkImageChoice, textRun } from "./ai.ts";
import { user } from "./http.ts";
import { batchModes, callAs, type RunOptions } from "./production.ts";

/** Panels a chapter is planned into when there is no target runtime and no planned chapter to learn from. */
const DEFAULT_PANELS_PER_CHAPTER = 40;
const PANELS_PER_PAGE = 4;
/** Artwork plus its derivatives, when the server has none to measure. */
const DEFAULT_ART_BYTES = 2_200_000;
const DEFAULT_REFERENCES = 12;

type Usd = number | null;
export type ChapterPlanRow = {
  id: string;
  order: number;
  title: string;
  /** Not planned yet: panel and page counts are estimates (target runtime, or this server's planned chapters). */
  estimated: boolean;
  panels: number;
  plan: { needed: boolean; usd: Usd };
  prompts: { pages: number; usd: Usd };
  art: { panels: number; usd: Usd; batched: boolean };
  narration: { needed: boolean; usd: Usd };
  audio: { segments: number; seconds: number; usd: number };
  storageBytes: number;
  usd: Usd;
};

/** Average usage per unit of each kind on this server over the last 90 days (summed per job: repairs, retries). */
async function usageHistory(db: AppEnv["Variables"]["deps"]["db"]) {
  const rows = await db.execute<{
    kind: string;
    n: number;
    ti: number;
    to: number;
    ci: number;
    ii: number;
    io: number;
    im: number;
  }>(sql`
    select case when g.kind in ('character_reference', 'location_reference', 'prop_reference') then 'reference'
      else g.kind end as kind, count(*)::int as n,
      avg(j.ti)::float8 as ti, avg(j.to)::float8 as to, avg(j.ci)::float8 as ci,
      avg(j.ii)::float8 as ii, avg(j.io)::float8 as io, avg(j.im)::float8 as im
    from (
      select u.generation_job_id as id, sum(u.text_input_tokens) as ti, sum(u.text_output_tokens) as to,
        sum(u.cached_input_tokens) as ci, sum(u.image_input_tokens) as ii, sum(u.image_output_tokens) as io,
        sum(u.images) as im
      from ai_usage u where u.success and u.generation_job_id is not null and u.created_at > now() - interval '90 days'
      group by u.generation_job_id
    ) j join generation_jobs g on g.id = j.id
    where g.kind in ('story_analysis', 'chapter_plan', 'page_prompts', 'narration_text', 'youtube_package',
      'panel_generation', 'character_reference', 'location_reference', 'prop_reference', 'thumbnail')
    group by 1`);
  const out: Partial<Record<PlanKind, UsageTokens>> = {};
  for (const r of rows)
    out[r.kind as PlanKind] = {
      textInputTokens: r.ti,
      textOutputTokens: r.to,
      cachedInputTokens: r.ci,
      imageInputTokens: r.ii,
      imageOutputTokens: r.io,
      images: r.im,
    };
  return out;
}

/**
 * What a production run with these options would still do and what it would cost, chapter by chapter, before it
 * spends anything: the same steps and "only what is missing" rules the run follows, priced with the chosen models'
 * rates and this server's average usage per job, plus the disk the new artwork and narration will take. Chapters not
 * planned yet are estimated (from the target runtime, or the size of chapters already planned) and marked so.
 */
export async function costPlan(c: Context<AppEnv>, p: ProjectRecord, o: RunOptions) {
  const deps = c.get("deps");
  const db = deps.db;
  const warnings: string[] = [];
  const batch = await batchModes(deps, p, o);
  // A model with no key, or none chosen, prices as unknown rather than failing the plan.
  const pick = async <T>(f: () => Promise<T>) => f().catch((e: Error) => (warnings.push(e.message), null));
  const textModel = await pick(() => textRun(c, o.ai?.text ?? null));
  const imageModel = await pick(() => checkImageChoice(c, o.ai?.image ?? null));
  const manualText = textModel?.provider === "manual";
  const rate = async (m: { provider: string; model: string } | null, batched: boolean) =>
    m ? deps.usage.rateFor(m.provider, batched ? batchModel(m.model) : m.model) : null;
  const textRate = manualText ? null : await rate(textModel, batch.text);
  const imageRate = await rate(imageModel, batch.image);
  if (textModel && !manualText && !textRate) warnings.push(`No price is known for ${textModel.model}`);
  if (imageModel && !imageRate) warnings.push(`No price is known for ${imageModel.model}`);
  const history = await usageHistory(db);
  const price = (kind: PlanKind, count: number): Usd => {
    if (!IMAGE_KINDS.has(kind) && manualText) return 0;
    return planUnitsUsd(kind, count, IMAGE_KINDS.has(kind) ? imageRate : textRate, history);
  };

  const call = await callAs(deps, user(c));
  const runtime = await call<{
    chapters: { id: string; order: number; title: string; budget: { shots: number; pages: number } | null }[];
  }>("GET", `/api/projects/${p.id}/runtime`);
  const rows = await db.execute<{
    id: string;
    pages: number;
    panels: number;
    without_art: number;
    prompt_pages: number;
    lines: number;
    unvoiced: number;
    unvoiced_words: number;
  }>(sql`
    select c.id,
      (select count(*)::int from pages pg where pg.chapter_id = c.id) as pages,
      (select count(*)::int from panels pn join pages pg on pg.id = pn.page_id where pg.chapter_id = c.id) as panels,
      (select count(*)::int from panels pn join pages pg on pg.id = pn.page_id where pg.chapter_id = c.id
        and pn.active_artwork_asset_id is null and pn.approval_status <> 'locked'
        and pn.status not in ('queued', 'generating')) as without_art,
      (select count(distinct pg.id)::int from pages pg join panels pn on pn.page_id = pg.id where pg.chapter_id = c.id
        and pn.active_artwork_asset_id is null and pn.prompt_draft is null) as prompt_pages,
      (select count(*)::int from narration_lines nl where nl.chapter_id = c.id and nl.language = ${p.language}) as lines,
      (select count(*)::int from narration_segments s join narration_lines nl on nl.id = s.narration_line_id
        where nl.chapter_id = c.id and nl.language = ${p.language} and not exists (select 1 from audio_assets a
          where a.asset_id = s.active_audio_asset_id and a.text_sha256 = s.text_sha256)) as unvoiced,
      (select coalesce(sum(array_length(regexp_split_to_array(trim(s.text), '\\s+'), 1)), 0)::int
        from narration_segments s join narration_lines nl on nl.id = s.narration_line_id
        where nl.chapter_id = c.id and nl.language = ${p.language} and not exists (select 1 from audio_assets a
          where a.asset_id = s.active_audio_asset_id and a.text_sha256 = s.text_sha256)) as unvoiced_words
    from chapters c where c.project_id = ${p.id}`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  // How big a chapter turns out on this server, and what a drawn panel takes on disk.
  const [sizes] = await db.execute<{ panels: number | null; art: number | null }>(sql`
    select (select avg(n)::float8 from (select count(*) as n from panels pn join pages pg on pg.id = pn.page_id
        group by pg.chapter_id) x) as panels,
      (select avg(a.byte_size + coalesce((select sum(v.byte_size) from asset_variants v where v.asset_id = a.id), 0))::float8
        from assets a where a.id in (select active_artwork_asset_id from panels where active_artwork_asset_id is not null
          order by updated_at desc limit 500)) as art`);
  const panelsPerChapter = Math.round(sizes?.panels ?? DEFAULT_PANELS_PER_CHAPTER);
  const artBytes = sizes?.art ?? DEFAULT_ART_BYTES;
  const wordsPerPanel = p.settings.narrationWordsPerPanel ?? 21;
  const wpm = p.settings.targetRuntime?.wordsPerMinute ?? 150;
  // An update redraws artwork whose panel was edited after it was drawn, as the run's art step does.
  const stale = o.update ? (await pipelineStaleness(db, p)).staleArt : [];

  const chapters: ChapterPlanRow[] = runtime.chapters.map((ch) => {
    const r = byId.get(ch.id);
    const planned = (r?.pages ?? 0) > 0;
    const estPanels = ch.budget?.shots ?? panelsPerChapter;
    const panelCount = planned ? r!.panels : estPanels;
    const toDraw = planned ? r!.without_art : estPanels;
    const promptPages = !o.preparePrompts
      ? 0
      : planned
        ? r!.prompt_pages
        : (ch.budget?.pages ?? Math.ceil(estPanels / PANELS_PER_PAGE));
    const narrate = (r?.lines ?? 0) === 0;
    // A chapter with no narration yet gets about one line per panel at the project's words per panel.
    const words = narrate ? panelCount * wordsPerPanel : (r?.unvoiced_words ?? 0);
    const seconds = Math.round(narrationSeconds(words, wpm));
    const row = {
      id: ch.id,
      order: ch.order,
      title: ch.title,
      estimated: !planned,
      panels: panelCount,
      plan: { needed: !planned, usd: planned ? 0 : price("chapter_plan", 1) },
      prompts: { pages: promptPages, usd: price("page_prompts", promptPages) },
      art: { panels: toDraw, usd: price("panel_generation", toDraw), batched: batch.image && toDraw > 0 },
      narration: { needed: narrate, usd: narrate ? price("narration_text", 1) : 0 },
      // The run voices with the local voice: no provider, nothing spent.
      audio: { segments: narrate ? panelCount : (r?.unvoiced ?? 0), seconds, usd: 0 },
      storageBytes: Math.round(toDraw * artBytes + seconds * NARRATION_BYTES_PER_SECOND),
      usd: null as Usd,
    };
    row.usd = sumUsd([row.plan.usd, row.prompts.usd, row.art.usd, row.narration.usd]);
    return row;
  });
  if (stale.length) {
    const extra = await db
      .select({
        id: panels.id,
        chapterId: sql<string>`(select chapter_id from pages where pages.id = ${panels.pageId})`,
      })
      .from(panels)
      .where(inArray(panels.id, stale));
    for (const s of extra) {
      const row = chapters.find((ch) => ch.id === s.chapterId);
      if (!row) continue;
      row.art.panels++;
      row.art.usd = price("panel_generation", row.art.panels);
      row.art.batched = batch.image;
      row.storageBytes += Math.round(artBytes);
      row.usd = sumUsd([row.plan.usd, row.prompts.usd, row.art.usd, row.narration.usd]);
    }
  }

  // Project-wide steps, with the run's own rules for whether each one still has work.
  const analysed = runtime.chapters.length > 0;
  const references = await Promise.all(
    (["character", "location", "prop"] as const).map((subject) =>
      call<{ count: number }>("POST", `/api/projects/${p.id}/generations/bulk`, {
        ai: o.ai?.image ?? null,
        batch: batch.image,
        scope: { references: subject },
        onlyMissing: true,
        confirm: false,
      })
        .then((r) => r.count)
        .catch(() => 0),
    ),
  );
  // Before the analysis there is no cast yet: as many references as this server's projects usually draw.
  const refCount = analysed ? references.reduce((n, x) => n + x, 0) : DEFAULT_REFERENCES;
  const project = {
    analysis: { needed: !analysed, usd: analysed ? 0 : price("story_analysis", 1) },
    references: { count: refCount, estimated: !analysed, usd: price("reference", refCount), batched: batch.image },
    thumbnail: { needed: !p.settings.thumbnail, usd: p.settings.thumbnail ? 0 : price("thumbnail", 1) },
    youtube: {
      needed: o.youtube && !p.settings.youtubePackage?.titles.length,
      usd: o.youtube && !p.settings.youtubePackage?.titles.length ? price("youtube_package", 1) : 0,
    },
    storageBytes: Math.round(refCount * artBytes + (p.settings.thumbnail ? 0 : artBytes)),
  };

  const projectUsd = sumUsd([project.analysis.usd, project.references.usd, project.thumbnail.usd, project.youtube.usd]);
  const usd = sumUsd([projectUsd, ...chapters.map((ch) => ch.usd)]);
  const batchedUsd = sumUsd([
    project.references.batched ? project.references.usd : 0,
    ...chapters.map((ch) => (ch.art.batched ? ch.art.usd : 0)),
  ]);
  const budget = await projectBudget(db, p.id);
  const remaining = budget.limitUsd === null ? null : Math.max(0, budget.limitUsd - budget.spentUsd);
  if (usd !== null && remaining !== null && usd > remaining)
    warnings.push(
      `About $${usd.toFixed(2)} of work, but $${remaining.toFixed(2)} is left under the budget cap: the run pauses when it reaches the cap.`,
    );
  return {
    models: {
      text: manualText ? { provider: "manual", model: "manual", free: true } : textModel,
      image: imageModel,
      batch,
      rates: { text: rateView(textRate), image: rateView(imageRate) },
      // Whether prices come from this server's own past jobs or the built-in assumptions.
      fromHistory: Object.keys(history),
    },
    project,
    chapters,
    totals: {
      usd,
      nowUsd: usd === null || batchedUsd === null ? null : usd - batchedUsd,
      batchedUsd,
      storageBytes: project.storageBytes + chapters.reduce((n, ch) => n + ch.storageBytes, 0),
      panelsToDraw: chapters.reduce((n, ch) => n + ch.art.panels, 0),
      estimatedChapters: chapters.filter((ch) => ch.estimated).length,
    },
    budget: { ...budget, remainingUsd: remaining },
    warnings,
  };
}

const rateView = (r: RateSnapshot | null) =>
  r ? { provider: r.provider, model: r.model, effectiveFrom: r.effectiveFrom } : null;
