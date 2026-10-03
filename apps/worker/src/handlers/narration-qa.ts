import { and, eq, inArray, narrationFindings } from "@openmanga/db";
import { type LintFinding, languageName, splitSentences } from "@openmanga/domain";
import { narrationFixV1, narrationLintV1 } from "@openmanga/prompts";
import { NarrationFix, NarrationLintReport } from "@openmanga/schemas";
import { loadNarrationQa, type QaChapter, saveFindings } from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";
import { InputError, type ProjectJob } from "../lib/runner.ts";
import { structured } from "./text.ts";

/** Lines are named L1, L2, … in the prompts: short for the model, and mapped back to ids here. */
const keyed = (c: QaChapter) => c.lines.map((l, i) => ({ key: `L${i + 1}`, line: l }));

/** Earlier chapters' narration budget in the lint prompt, nearest chapters first. */
const EARLIER_CHARS = 30_000;

async function chapterOf(deps: WorkerDeps, job: ProjectJob) {
  const language = String(job.input.language);
  const all = await loadNarrationQa(deps.db, job.projectId, language);
  const chapter = all.find((c) => c.id === String(job.input.chapterId));
  if (!chapter) throw new InputError("Chapter no longer exists");
  if (!chapter.lines.length) throw new InputError("The chapter has no narration to check");
  return { all, chapter, language };
}

/**
 * Semantic narration lint for one chapter: meaning repeated in other words (here and against earlier chapters),
 * facts explained again, and lines that only describe their frame. Earlier chapters go in as their summary and the
 * first sentence of each line, so a long project stays within context.
 */
export async function narrationLint(deps: WorkerDeps, job: ProjectJob) {
  const { all, chapter, language } = await chapterOf(deps, job);
  const shots = new Map(chapter.shots.map((s) => [s.id, s]));
  const lines = keyed(chapter);
  const earlier: { order: number; title: string; summary: string; narration: string[] }[] = [];
  let budget = EARLIER_CHARS;
  // ponytail: earlier chapters shortened to first sentences and cut off at a character budget, nearest first; a
  // very long project's first chapters drop out of view. Chunking them into several calls if that ever matters.
  for (const c of all.filter((o) => o.order < chapter.order && o.lines.length).reverse()) {
    const entry = {
      order: c.order,
      title: c.title,
      summary: c.summary.slice(0, 400),
      narration: c.lines.map((l) => (splitSentences(l.text)[0] ?? l.text).slice(0, 160)),
    };
    budget -= JSON.stringify(entry).length;
    if (budget < 0) break;
    earlier.unshift(entry);
  }
  const r = await structured(
    deps,
    job,
    narrationLintV1.build({
      chapter: { order: chapter.order, title: chapter.title, summary: chapter.summary },
      lines: lines.map(({ key, line }) => {
        const shot = line.panelId ? shots.get(line.panelId) : undefined;
        return {
          key,
          text: line.text,
          frame: shot?.frame || undefined,
          dialogue: shot?.dialogue.length ? shot.dialogue : undefined,
        };
      }),
      earlierChapters: earlier,
    }),
    NarrationLintReport,
    "NarrationLintReport",
    16_000,
  );
  const byKey = new Map(lines.map(({ key, line }) => [key, line.id]));
  const byOrder = new Map(all.map((c) => [c.order, c.id]));
  // Keys the answer made up are dropped; a finding left with no line is no finding.
  const findings: LintFinding[] = r.data.findings.flatMap((f) => {
    const lineIds = [
      ...new Set(f.lines.map((k) => byKey.get(k.trim().toUpperCase())).filter((x): x is string => Boolean(x))),
    ];
    if (!lineIds.length) return [];
    return [
      {
        kind: f.type,
        severity: f.severity,
        lineIds,
        relatedChapterIds: f.relatedChapters
          .map((n) => byOrder.get(n))
          .filter((x): x is string => Boolean(x) && x !== chapter.id),
        message: f.explanation,
      },
    ];
  });
  const comparison = await saveFindings(deps.db, {
    projectId: job.projectId,
    chapterId: chapter.id,
    language,
    source: "ai",
    findings,
  });
  await deps.events.publish(job.projectId, { type: "narration.updated", chapterId: chapter.id });
  return { chapterId: chapter.id, language, repaired: r.repaired, ...comparison };
}

/**
 * Proposes rewrites of the lines the chosen findings flag, and nothing else. The answer is checked against the
 * flagged lines and returned as before/after pairs: nothing is written until the user applies it.
 */
export async function narrationFix(deps: WorkerDeps, job: ProjectJob) {
  const { chapter, language } = await chapterOf(deps, job);
  const ids = Array.isArray(job.input.findingIds) ? (job.input.findingIds as string[]) : [];
  const findings = ids.length
    ? await deps.db
        .select()
        .from(narrationFindings)
        .where(and(inArray(narrationFindings.id, ids), eq(narrationFindings.chapterId, chapter.id)))
    : [];
  if (!findings.length) throw new InputError("None of the chosen findings is still open on this chapter");
  const lines = keyed(chapter);
  const keyOf = new Map(lines.map(({ key, line }) => [line.id, key]));
  const flagged = new Set(findings.flatMap((f) => f.lineIds.map((id) => keyOf.get(id)).filter(Boolean)));
  if (!flagged.size) throw new InputError("The flagged lines no longer exist");
  const shots = new Map(chapter.shots.map((s) => [s.id, s]));
  const r = await structured(
    deps,
    job,
    narrationFixV1.build({
      language: `${languageName(language)} (${language})`,
      findings: findings.map((f) => ({
        lines: f.lineIds.map((id) => keyOf.get(id)).filter((k): k is string => Boolean(k)),
        problem: `${f.kind.replaceAll("_", " ")}: ${f.message}`,
      })),
      lines: lines.map(({ key, line }) => {
        const shot = flagged.has(key) && line.panelId ? shots.get(line.panelId) : undefined;
        return {
          key,
          text: line.text,
          frame: shot?.frame || undefined,
          dialogue: shot?.dialogue.length ? shot.dialogue : undefined,
        };
      }),
    }),
    NarrationFix,
    "NarrationFix",
    16_000,
  );
  const byKey = new Map(lines.map(({ key, line }) => [key, line]));
  const proposals = r.data.lines.flatMap((p) => {
    const key = p.line.trim().toUpperCase();
    const line = byKey.get(key);
    // Only flagged lines may change, each once; an unchanged "rewrite" is no proposal.
    if (!line || !flagged.has(key) || line.text.trim() === p.text.trim()) return [];
    flagged.delete(key);
    return [{ lineId: line.id, key, before: line.text, after: p.text.trim() }];
  });
  return { chapterId: chapter.id, language, findingIds: findings.map((f) => f.id), proposals, repaired: r.repaired };
}
