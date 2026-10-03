import { eq, sql, storyRevisions } from "@openmanga/db";
import {
  type CoveragePlanChapter,
  chunkParagraphs,
  coverageFindings,
  type ParagraphMapping,
  splitParagraphs,
} from "@openmanga/domain";
import { storyCoverageV1 } from "@openmanga/prompts";
import { storyCoverageFor } from "@openmanga/schemas";
import type { WorkerDeps } from "../context.ts";
import { InputError, type ProjectJob } from "../lib/runner.ts";
import { structured } from "./text.ts";

/** Source characters per request: a long story is mapped part by part. */
const CHUNK_CHARS = 12_000;
/** Scene detail per request; chapters away from the part are named by their summary only. */
const DETAIL_CHARS = 24_000;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * Maps the story source (the revision the job names) to the plan, part by part, then measures what was left out,
 * told twice, or given far more or less room than its weight. Each part's request carries every chapter's summary
 * and the scenes of the chapters around that part, so it stays within context however long the story is.
 */
export async function storyCoverage(deps: WorkerDeps, job: ProjectJob) {
  const [rev] = await deps.db
    .select()
    .from(storyRevisions)
    .where(eq(storyRevisions.id, String(job.input.storyRevisionId)));
  if (!rev || rev.projectId !== job.projectId) throw new InputError("Story revision no longer exists");
  const language = String(job.input.language);
  const chapterRows = await deps.db.execute<{
    id: string;
    order: number;
    title: string;
    summary: string;
    excerpt: string;
    words: number;
  }>(sql`
    select c.id, c."order", c.title, c.summary, c.source_excerpt as excerpt,
      coalesce((select sum(array_length(regexp_split_to_array(trim(nl.text), '\\s+'), 1)) from narration_lines nl
        where nl.chapter_id = c.id and nl.language = ${language}), 0)::int as words
    from chapters c where c.project_id = ${job.projectId} order by c."order"`);
  const sceneRows = await deps.db.execute<{
    id: string;
    chapter_id: string;
    title: string;
    summary: string;
    panels: number;
    beats: string[] | null;
  }>(sql`
    select s.id, s.chapter_id, s.title, s.summary,
      (select count(*)::int from panels pn where pn.scene_id = s.id) as panels,
      (select array_agg(left(pn.story_beat, 90) order by pg."order", pn."order") from panels pn
        join pages pg on pg.id = pn.page_id where pn.scene_id = s.id and pn.story_beat <> '') as beats
    from scenes s where s.project_id = ${job.projectId} order by s.chapter_id, s."order"`);
  const chapterPanels = await deps.db.execute<{ chapter_id: string; panels: number }>(sql`
    select pg.chapter_id, count(*)::int as panels from panels pn join pages pg on pg.id = pn.page_id
    where pn.project_id = ${job.projectId} group by pg.chapter_id`);
  if (!chapterRows.length) throw new InputError("The project has no chapters to compare the story with");

  const plan: (CoveragePlanChapter & { summary: string; start: number | null })[] = [...chapterRows].map((c) => {
    // Where the chapter starts in the source, from the analysis' excerpt, when it can be found.
    const probe = squash(c.excerpt).slice(0, 80);
    const at = probe.length >= 20 ? squash(rev.content).indexOf(probe) : -1;
    return {
      id: c.id,
      key: `C${c.order}`,
      order: c.order,
      title: c.title,
      summary: c.summary,
      words: c.words,
      panels: chapterPanels.find((p) => p.chapter_id === c.id)?.panels ?? 0,
      start: at >= 0 ? at : null,
      scenes: [...sceneRows]
        .filter((s) => s.chapter_id === c.id)
        .map((s, i) => ({ id: s.id, key: `C${c.order}.S${i + 1}`, title: s.title, panels: s.panels })),
    };
  });
  const sceneInfo = new Map([...sceneRows].map((s) => [s.id, s]));
  const paragraphs = splitParagraphs(rev.content);
  if (!paragraphs.length) throw new InputError("The story revision is empty");
  const chunks = chunkParagraphs(paragraphs, CHUNK_CHARS);
  const squashedAt = (offset: number) => squash(rev.content.slice(0, offset)).length;
  const known = new Set(plan.flatMap((c) => [c.key, ...c.scenes.map((s) => s.key)]));
  const mapping = new Map<string, ParagraphMapping>();
  let repaired = false;

  for (const [i, chunk] of chunks.entries()) {
    // The chapters this part falls in (by where their excerpts start), with one on either side; by proportion when
    // the excerpts cannot be found in the source.
    const from = squashedAt(chunk[0]!.start);
    const to = squashedAt(chunk.at(-1)!.end);
    const located = plan.filter((c) => c.start !== null);
    let near: number[];
    if (located.length >= Math.ceil(plan.length / 2)) {
      const idx = plan
        .map((c, k) => ({
          k,
          start: c.start ?? Number.POSITIVE_INFINITY,
          end: plan[k + 1]?.start ?? Number.POSITIVE_INFINITY,
        }))
        .filter((c) => c.start <= to && c.end >= from)
        .map((c) => c.k);
      near = idx.length ? idx : [0];
    } else {
      const a = Math.floor((i / chunks.length) * plan.length);
      const b = Math.ceil(((i + 1) / chunks.length) * plan.length) - 1;
      near = Array.from({ length: b - a + 1 }, (_, k) => a + k);
    }
    const detailed = new Set([Math.min(...near) - 1, ...near, Math.max(...near) + 1]);
    let budget = DETAIL_CHARS;
    const chapters = plan.map((c, k) => {
      const base = { key: c.key, title: c.title, summary: c.summary.slice(0, 300) };
      if (!detailed.has(k) || budget <= 0) return base;
      const scenes = c.scenes.map((s) => {
        const info = sceneInfo.get(s.id);
        return {
          key: s.key,
          title: s.title,
          summary: (info?.summary ?? "").slice(0, 300),
          beats: (info?.beats ?? []).slice(0, 15),
        };
      });
      budget -= JSON.stringify(scenes).length;
      return { ...base, scenes };
    });
    const r = await structured(
      deps,
      job,
      storyCoverageV1.build({
        part: { index: i + 1, of: chunks.length },
        paragraphs: chunk.map((p) => ({ key: p.key, text: p.text })),
        plan: { chapters },
      }),
      storyCoverageFor(chunk.map((p) => p.key)),
      "StoryCoverageMap",
      16_000,
    );
    repaired ||= r.repaired;
    const inChunk = new Set(chunk.map((p) => p.key));
    for (const p of r.data.paragraphs) {
      const key = p.paragraph.trim().toUpperCase();
      if (!inChunk.has(key)) continue;
      mapping.set(key, {
        weight: p.weight,
        coveredBy: [...new Set(p.coveredBy.map((k) => k.trim().toUpperCase()).filter((k) => known.has(k)))],
      });
    }
  }

  const { findings, shares } = coverageFindings(paragraphs, mapping, plan);
  const ids = new Map(plan.flatMap((c) => [[c.key, c.id] as const, ...c.scenes.map((s) => [s.key, s.id] as const)]));
  return {
    storyRevisionId: rev.id,
    revisionNumber: rev.revisionNumber,
    language,
    parts: chunks.length,
    findings,
    shares,
    paragraphs: paragraphs.map((p) => ({
      key: p.key,
      start: p.start,
      end: p.end,
      weight: mapping.get(p.key)?.weight ?? null,
      coveredBy: (mapping.get(p.key)?.coveredBy ?? []).map((k) => ids.get(k)!),
    })),
    repaired,
  };
}
