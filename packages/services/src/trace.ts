import {
  asc,
  chapters,
  type DbOrTx,
  dialogueLines,
  eq,
  inArray,
  narrationLines,
  pages,
  panels,
  scenes,
  sql,
  storyRevisions,
} from "@openmanga/db";
import { locateSpan, traceSpans } from "@openmanga/domain";

/** The chapter text a plan is made from, as the planner reads it: the source excerpt, or the summary when empty. */
const planText = (c: { sourceExcerpt: string; summary: string }) => (c.sourceExcerpt.trim() || c.summary).trim();

async function chapterPanels(db: DbOrTx, chapterId: string) {
  const rows = await db
    .select({
      id: panels.id,
      pageId: panels.pageId,
      sceneId: panels.sceneId,
      order: panels.order,
      pageOrder: pages.order,
      storyBeat: panels.storyBeat,
      plannedLettering: panels.plannedLettering,
      sourceSpan: panels.sourceSpan,
    })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .where(eq(pages.chapterId, chapterId))
    .orderBy(asc(pages.order), asc(panels.order));
  const lines = rows.length
    ? await db
        .select({ panelId: dialogueLines.panelId, text: dialogueLines.text })
        .from(dialogueLines)
        .where(
          inArray(
            dialogueLines.panelId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  return rows.map((r) => ({
    ...r,
    dialogue: [
      ...lines.filter((l) => l.panelId === r.id).map((l) => l.text),
      ...(r.plannedLettering?.dialogue.map((d) => d.text) ?? []),
    ],
  }));
}

/** Traces every panel of a chapter to the chapter's current text and stores it (after planning, or on request). */
export async function traceChapter(db: DbOrTx, chapterId: string) {
  const [ch] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
  if (!ch) return 0;
  const rows = await chapterPanels(db, chapterId);
  const spans = traceSpans(
    planText(ch),
    rows.map((r) => ({ beat: r.storyBeat, dialogue: r.dialogue })),
  );
  for (const [i, r] of rows.entries())
    await db
      .update(panels)
      .set({ sourceSpan: spans[i] ?? null })
      .where(eq(panels.id, r.id));
  return rows.length;
}

/**
 * A chapter's text with where each panel, scene and narration line came from in it. A panel whose traced text is no
 * longer in the chapter (the story was revised under it) is `changed`, with the text it was planned from. Panels
 * never traced (planned before tracing existed) are traced now, unless some are changed: tracing again would hide that.
 */
export async function chapterTrace(db: DbOrTx, chapterId: string, language: string) {
  const [ch] = await db.select().from(chapters).where(eq(chapters.id, chapterId));
  if (!ch) return null;
  const text = planText(ch);
  let rows = await chapterPanels(db, chapterId);
  const located = () => rows.map((r) => (r.sourceSpan ? locateSpan(text, r.sourceSpan) : null));
  let at = located();
  if (rows.some((r) => !r.sourceSpan) && !at.some((l) => l?.changed)) {
    await traceChapter(db, chapterId);
    rows = await chapterPanels(db, chapterId);
    at = located();
  }
  const panelViews = rows.map((r, i) => ({
    panelId: r.id,
    pageId: r.pageId,
    sceneId: r.sceneId,
    page: r.pageOrder,
    panel: r.order,
    start: at[i]?.start ?? null,
    end: at[i]?.end ?? null,
    changed: at[i]?.changed ?? false,
    /** The text it was planned from, when that is no longer in the chapter. */
    was: at[i]?.changed ? r.sourceSpan!.text : null,
  }));
  const sc = await db
    .select({ id: scenes.id, title: scenes.title, order: scenes.order })
    .from(scenes)
    .where(eq(scenes.chapterId, chapterId))
    .orderBy(asc(scenes.order));
  const sceneViews = sc.map((s) => {
    const own = panelViews.filter((p) => p.sceneId === s.id && p.start !== null && !p.changed);
    return {
      sceneId: s.id,
      title: s.title,
      start: own.length ? Math.min(...own.map((p) => p.start!)) : null,
      end: own.length ? Math.max(...own.map((p) => p.end!)) : null,
      changed: panelViews.some((p) => p.sceneId === s.id && p.changed),
    };
  });
  const narration = await db
    .select({ id: narrationLines.id, panelId: narrationLines.panelId, text: narrationLines.text })
    .from(narrationLines)
    .where(sql`${narrationLines.chapterId} = ${chapterId} and ${narrationLines.language} = ${language}`)
    .orderBy(asc(narrationLines.order));
  // Where the chapter sits in the newest story revision (null when its text is not in it verbatim).
  const [rev] = await db
    .select({ number: storyRevisions.revisionNumber, at: sql<number>`strpos(content, ${text.slice(0, 200)}) - 1` })
    .from(storyRevisions)
    .where(eq(storyRevisions.projectId, ch.projectId))
    .orderBy(sql`${storyRevisions.revisionNumber} desc`)
    .limit(1);
  return {
    text,
    revision: rev && text ? { number: rev.number, offset: rev.at >= 0 ? rev.at : null } : null,
    panels: panelViews,
    scenes: sceneViews,
    narration: narration.map((n) => ({ lineId: n.id, panelId: n.panelId, text: n.text })),
    changed: panelViews.filter((p) => p.changed).length,
  };
}
