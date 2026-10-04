import {
  and,
  asc,
  chapters,
  characters,
  continuityFindings,
  dialogueLines,
  eq,
  type FindingPlace,
  inArray,
  narrationLines,
  pages,
  panels,
  projects,
  scenes,
  sql,
} from "@openmanga/db";
import { factLine, stateLine } from "@openmanga/domain";
import { continuityCheckV1 } from "@openmanga/prompts";
import { ContinuityReport, type PanelSpec } from "@openmanga/schemas";
import { bibleEntriesFor, loadBible } from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";
import { InputError, type ProjectJob } from "../lib/runner.ts";
import { structured } from "./text.ts";

/** At most this many panels and narration lines go into one check, so a feature-length chapter still fits. */
const MAX_PANELS = 400;
const MAX_LINES = 400;

/**
 * Compares one chapter (its scenes, panel specs, dialogue and narration) with the story bible in effect there and
 * with its neighbours, then replaces the chapter's open findings with what it found. Findings once ignored or
 * explained are not raised again. Each fixed rule's verdict stays on the job's result, read by the rule checks view.
 */
export async function continuityCheck(deps: WorkerDeps, job: ProjectJob) {
  const chapterId = String(job.input.chapterId);
  const [chapter] = await deps.db.select().from(chapters).where(eq(chapters.id, chapterId));
  if (!chapter) throw new InputError("Chapter no longer exists");
  const neighbours = await deps.db
    .select()
    .from(chapters)
    .where(eq(chapters.projectId, job.projectId))
    .orderBy(asc(chapters.order));
  const prev = neighbours.filter((c) => c.order < chapter.order).at(-1);
  const next = neighbours.find((c) => c.order > chapter.order);
  const [project] = await deps.db
    .select({ language: projects.language })
    .from(projects)
    .where(eq(projects.id, job.projectId));

  const sceneRows = await deps.db
    .select()
    .from(scenes)
    .where(eq(scenes.chapterId, chapterId))
    .orderBy(asc(scenes.order));
  const panelRows = (
    await deps.db
      .select({
        id: panels.id,
        pageId: pages.id,
        pageOrder: pages.order,
        order: panels.order,
        sceneId: panels.sceneId,
        beat: panels.storyBeat,
        spec: sql<PanelSpec | null>`(select spec from panel_specs s where s.panel_id = ${panels.id} order by s.version_number desc limit 1)`,
      })
      .from(panels)
      .innerJoin(pages, eq(pages.id, panels.pageId))
      .where(eq(pages.chapterId, chapterId))
      .orderBy(asc(pages.order), asc(panels.order))
  ).slice(0, MAX_PANELS);
  const cast = await deps.db
    .select({ id: characters.id, name: characters.name, key: characters.analysisKey })
    .from(characters)
    .where(eq(characters.projectId, job.projectId));
  const nameOf = (id: string) => cast.find((c) => c.id === id || c.key === id)?.name ?? id;
  const spoken = panelRows.length
    ? await deps.db
        .select({ panelId: dialogueLines.panelId, text: dialogueLines.text, speaker: characters.name })
        .from(dialogueLines)
        .leftJoin(characters, eq(characters.id, dialogueLines.characterId))
        .where(
          inArray(
            dialogueLines.panelId,
            panelRows.map((p) => p.id),
          ),
        )
        .orderBy(asc(dialogueLines.order))
    : [];
  const lines = (
    await deps.db
      .select({ id: narrationLines.id, text: narrationLines.text })
      .from(narrationLines)
      .where(and(eq(narrationLines.chapterId, chapterId), eq(narrationLines.language, project?.language ?? "en")))
      .orderBy(asc(narrationLines.order))
  ).slice(0, MAX_LINES);

  const sceneNumber = (id: string | null) => sceneRows.find((s) => s.id === id)?.order ?? null;
  const panelRef = (p: (typeof panelRows)[number]) => `p${p.pageOrder}.${p.order}`;
  const present = [...new Set(panelRows.flatMap((p) => (p.spec?.characters ?? []).map((c) => nameOf(c.characterId))))];
  const at = { chapter: chapter.order };
  const bible = await loadBible(deps.db, job.projectId);
  const picked = bibleEntriesFor(bible, at, {
    names: present,
    text: [chapter.title, chapter.summary, chapter.sourceExcerpt, ...panelRows.map((p) => p.beat)]
      .concat(lines.map((l) => l.text))
      .join("\n"),
    allFixed: true,
    maxFacts: 80,
    maxStates: 80,
  });
  const rules = picked.facts.filter((f) => f.fixed);
  const facts = picked.facts.filter((f) => !f.fixed);
  const ref = {
    rules: new Map(rules.map((f, i) => [`R${i + 1}`, f])),
    facts: new Map(facts.map((f, i) => [`F${i + 1}`, f])),
  };

  const r = await structured(
    deps,
    job,
    continuityCheckV1.build({
      projectData: {
        chapter: { number: chapter.order, title: chapter.title, summary: chapter.summary },
        bible: {
          fixedRules: [...ref.rules].map(([id, f]) => ({ ref: id, rule: factLine(f) })),
          facts: [...ref.facts].map(([id, f]) => ({ ref: id, fact: factLine(f) })),
          characterStates: picked.states.map((s, i) => ({
            ref: `S${i + 1}`,
            character: s.character,
            state: stateLine(s, at),
          })),
        },
        previousChapter: prev
          ? {
              number: prev.order,
              title: prev.title,
              summary: prev.summary,
              closingState: prev.closingState,
              characterStateChanges: prev.characterStateChanges,
              revealedFacts: prev.revealedFacts,
            }
          : null,
        earlierRevealedFacts: neighbours.filter((c) => c.order < (prev?.order ?? 0)).flatMap((c) => c.revealedFacts),
        nextChapter: next ? { number: next.order, title: next.title, summary: next.summary } : null,
        scenes: sceneRows.map((s) => ({
          number: s.order,
          title: s.title,
          summary: s.summary,
          startState: s.initialState,
          endState: s.finalState,
          changes: s.continuityDeltas,
        })),
        panels: panelRows.map((p) => ({
          ref: panelRef(p),
          scene: sceneNumber(p.sceneId),
          beat: p.beat,
          action: p.spec?.action || undefined,
          characters: (p.spec?.characters ?? []).map((c) => ({
            name: nameOf(c.characterId),
            outfit: c.outfit || undefined,
            action: c.action || undefined,
          })),
          continuity: p.spec?.continuityRequirements?.length ? p.spec.continuityRequirements : undefined,
          dialogue: spoken
            .filter((d) => d.panelId === p.id)
            .map((d) => `${d.speaker ?? "?"}: ${d.text}`)
            .slice(0, 6),
        })),
        narration: lines.map((l, i) => ({ ref: `n${i + 1}`, text: l.text })),
      },
    }),
    ContinuityReport,
    "ContinuityReport",
    16_000,
  );

  const placeOf = (where: string): FindingPlace => {
    const w = where.trim();
    const p = /^p(\d+)\.(\d+)$/i.exec(w);
    if (p) {
      const panel = panelRows.find((x) => x.pageOrder === Number(p[1]) && x.order === Number(p[2]));
      if (panel) return { ref: panelRef(panel), panelId: panel.id, pageId: panel.pageId };
    }
    const n = /^n(\d+)$/i.exec(w);
    if (n && lines[Number(n[1]) - 1]) return { ref: `n${n[1]}`, narrationLineId: lines[Number(n[1]) - 1]!.id };
    const s = /scene\s*(\d+)/i.exec(w);
    if (s) return { ref: `scene ${s[1]}`, sceneNumber: Number(s[1]) };
    return { ref: "chapter" };
  };
  const signature = (place: FindingPlace, quote: string) => `${place.ref}|${quote.trim().toLowerCase()}`;
  const ruleVerdicts = r.data.rules
    .map((v) => ({ fact: ref.rules.get(v.rule.toUpperCase()), verdict: v.verdict, note: v.note }))
    .filter((v) => v.fact)
    .map((v) => ({ factId: v.fact!.id, verdict: v.verdict, note: v.note }));
  // A rule the answer left out was not reported broken.
  for (const f of rules)
    if (!ruleVerdicts.some((v) => v.factId === f.id)) ruleVerdicts.push({ factId: f.id, verdict: "pass", note: "" });

  const stored = await deps.db.transaction(async (tx) => {
    const settled = await tx
      .select({ place: continuityFindings.place, quote: continuityFindings.quote })
      .from(continuityFindings)
      .where(
        and(eq(continuityFindings.chapterId, chapterId), inArray(continuityFindings.status, ["ignored", "explained"])),
      );
    const seen = new Set(settled.map((s) => signature(s.place, s.quote)));
    await tx
      .delete(continuityFindings)
      .where(and(eq(continuityFindings.chapterId, chapterId), eq(continuityFindings.status, "open")));
    const rows = r.data.findings
      .map((f) => {
        const against = f.against?.toUpperCase() ?? "";
        return {
          projectId: job.projectId,
          chapterId,
          jobId: job.id,
          severity: f.severity,
          message: f.message,
          quote: f.quote,
          evidence: f.evidence,
          place: placeOf(f.where),
          factId: (ref.rules.get(against) ?? ref.facts.get(against))?.id ?? null,
        };
      })
      .filter((f) => !seen.has(signature(f.place, f.quote)));
    if (rows.length) await tx.insert(continuityFindings).values(rows);
    return rows.length;
  });
  return {
    chapterId,
    findings: stored,
    repeatsSkipped: r.data.findings.length - stored,
    rules: ruleVerdicts,
    repaired: r.repaired,
  };
}
