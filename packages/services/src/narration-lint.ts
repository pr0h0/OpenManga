import { and, type DbOrTx, eq, inArray, narrationFindings, sql } from "@openmanga/db";
import {
  findingKey,
  hashOf,
  type LintChapter,
  type LintFinding,
  lintNarrationRules,
  RULE_FINDING_KINDS,
} from "@openmanga/domain";
import type { PanelSpec, ProjectSettings } from "@openmanga/schemas";

/** Rule findings a rewrite of the flagged lines cannot fix: they need lines added or the voice changed. */
export const UNFIXABLE_KINDS: readonly string[] = ["silent_stretch", "pace"];

export type QaChapter = LintChapter & { summary: string };

const frameOf = (spec: PanelSpec | null, beat: string) =>
  [spec?.beat || beat, spec?.action, spec?.composition, spec?.emotion && `mood: ${spec.emotion}`]
    .filter(Boolean)
    .join("; ")
    .slice(0, 300);

/**
 * Everything the narration checks read for one language track, for the whole project in a handful of queries:
 * chapters in order, their lines, their panels (shots) with dialogue and a frame description, and how much of the
 * narration is voiced with current audio.
 */
export async function loadNarrationQa(db: DbOrTx, projectId: string, language: string): Promise<QaChapter[]> {
  const chapterRows = await db.execute<{ id: string; order: number; title: string; summary: string }>(
    sql`select id, "order", title, summary from chapters where project_id = ${projectId} order by "order"`,
  );
  const lines = await db.execute<{
    id: string;
    chapter_id: string;
    text: string;
    panel_id: string | null;
    until: string | null;
  }>(sql`select id, chapter_id, text, panel_id, video ->> 'untilPanelId' as until from narration_lines
    where project_id = ${projectId} and language = ${language} order by chapter_id, "order"`);
  const shots = await db.execute<{ id: string; chapter_id: string; beat: string; spec: PanelSpec | null }>(sql`
    select pn.id, pg.chapter_id, pn.story_beat as beat,
      (select spec from panel_specs s where s.panel_id = pn.id order by s.version_number desc limit 1) as spec
    from panels pn join pages pg on pg.id = pn.page_id
    where pn.project_id = ${projectId} order by pg.chapter_id, pg."order", pn."order"`);
  const dialogue = await db.execute<{ panel_id: string; text: string }>(
    sql`select panel_id, text from dialogue_lines where project_id = ${projectId} and panel_id is not null order by "order"`,
  );
  const voiced = await db.execute<{ chapter_id: string; text: string; ms: number }>(sql`
    select nl.chapter_id, s.text, a.duration_ms as ms from narration_segments s
    join narration_lines nl on nl.id = s.narration_line_id
    join audio_assets a on a.asset_id = s.active_audio_asset_id and a.text_sha256 = s.text_sha256
    where nl.project_id = ${projectId} and nl.language = ${language}`);
  const said = new Map<string, string[]>();
  for (const d of dialogue) said.set(d.panel_id, [...(said.get(d.panel_id) ?? []), d.text]);
  return [...chapterRows].map((c) => {
    const audio = [...voiced].filter((v) => v.chapter_id === c.id);
    const ms = audio.reduce((n, v) => n + v.ms, 0);
    return {
      id: c.id,
      order: c.order,
      title: c.title,
      summary: c.summary,
      lines: [...lines]
        .filter((l) => l.chapter_id === c.id)
        .map((l) => ({ id: l.id, text: l.text, panelId: l.panel_id, untilPanelId: l.until })),
      shots: [...shots]
        .filter((s) => s.chapter_id === c.id)
        .map((s) => ({ id: s.id, dialogue: said.get(s.id) ?? [], frame: frameOf(s.spec, s.beat) })),
      audio: ms ? { ms, words: audio.reduce((n, v) => n + (v.text.match(/[\p{L}\p{N}']+/gu)?.length ?? 0), 0) } : null,
    };
  });
}

/** How a re-run compares with what was there before: so a fix that brings a new pile of findings shows it. */
export type LintComparison = { found: number; introduced: number; remaining: number; resolved: number };

/**
 * Replaces one source's findings for a chapter track with a new run's. Findings found again keep their row and
 * status (an ignored one stays ignored; a fixed one reopens, because the fix did not take); findings no longer found
 * are deleted; new ones are added as open.
 */
export async function saveFindings(
  db: DbOrTx,
  x: { projectId: string; chapterId: string; language: string; source: "rule" | "ai"; findings: LintFinding[] },
): Promise<LintComparison> {
  const next = new Map(x.findings.map((f) => [hashOf(findingKey(f)), f]));
  const where = and(
    eq(narrationFindings.chapterId, x.chapterId),
    eq(narrationFindings.language, x.language),
    eq(narrationFindings.source, x.source),
  );
  const before = await db.select().from(narrationFindings).where(where);
  const gone = before.filter((b) => !next.has(b.fingerprint)).map((b) => b.id);
  if (gone.length) await db.delete(narrationFindings).where(inArray(narrationFindings.id, gone));
  let remaining = 0;
  for (const b of before) {
    const f = next.get(b.fingerprint);
    if (!f) continue;
    remaining++;
    await db
      .update(narrationFindings)
      .set({ message: f.message, severity: f.severity, status: b.status === "fixed" ? "open" : b.status })
      .where(eq(narrationFindings.id, b.id));
  }
  const known = new Set(before.map((b) => b.fingerprint));
  const added = [...next].filter(([fp]) => !known.has(fp));
  if (added.length)
    await db.insert(narrationFindings).values(
      added.map(([fingerprint, f]) => ({
        projectId: x.projectId,
        chapterId: x.chapterId,
        language: x.language,
        source: x.source,
        kind: f.kind,
        severity: f.severity,
        lineIds: f.lineIds,
        relatedChapterIds: f.relatedChapterIds,
        message: f.message,
        fingerprint,
      })),
    );
  return { found: next.size, introduced: added.length, remaining, resolved: gone.length };
}

/**
 * Runs the deterministic checks on some chapters (all with narration or panels when none are named) and stores the
 * findings. Cheap: no model, a few queries for the whole project.
 */
export async function lintNarrationChapters(
  db: DbOrTx,
  project: { id: string; settings: Pick<ProjectSettings, "narrationWordsPerPanel" | "targetRuntime"> },
  language: string,
  chapterIds?: string[],
) {
  const all = await loadNarrationQa(db, project.id, language);
  const names = (
    await db.execute<{ name: string }>(
      sql`select name from characters where project_id = ${project.id} and deleted_at is null`,
    )
  ).map((r) => r.name);
  const opts = {
    names,
    wordsPerShot: project.settings.narrationWordsPerPanel ?? 21,
    wordsPerMinute: project.settings.targetRuntime?.wordsPerMinute ?? 150,
  };
  const out: ({ chapterId: string } & LintComparison)[] = [];
  for (const c of all) {
    if (chapterIds ? !chapterIds.includes(c.id) : !c.lines.length) continue;
    const others = all.filter((o) => o.id !== c.id && o.lines.length);
    const findings = lintNarrationRules(c, others, opts);
    out.push({
      chapterId: c.id,
      ...(await saveFindings(db, { projectId: project.id, chapterId: c.id, language, source: "rule", findings })),
    });
  }
  return out;
}

export const isRuleKind = (kind: string) => (RULE_FINDING_KINDS as readonly string[]).includes(kind);
