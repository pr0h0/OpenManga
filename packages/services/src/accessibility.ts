import {
  and,
  asc,
  chapters,
  characters,
  type Database,
  dialogueLines,
  eq,
  inArray,
  narrationLines,
  pages,
  panels,
  projects,
  soundEffects,
} from "@openmanga/db";
import { expectedReadingOrder, type LetteringIssue, letteringIssues, panelAltText } from "@openmanga/domain";

/**
 * Each page's alt text: its panels' in reading order (a panel's own, or one made from its story beat, dialogue and
 * sound effects), and each panel's with whether it was written by hand.
 */
export async function altTextFor(db: Database, pageIds: string[]) {
  const out = new Map<
    string,
    { alt: string; panels: { panelId: string; alt: string; custom: boolean; suggested: string }[] }
  >();
  if (!pageIds.length) return out;
  const pns = await db
    .select({ id: panels.id, pageId: panels.pageId, beat: panels.storyBeat, altText: panels.altText })
    .from(panels)
    .where(inArray(panels.pageId, pageIds))
    .orderBy(asc(panels.order));
  const lines = await db
    .select({ panelId: dialogueLines.panelId, text: dialogueLines.text, speaker: characters.name })
    .from(dialogueLines)
    .leftJoin(characters, eq(characters.id, dialogueLines.characterId))
    .where(inArray(dialogueLines.pageId, pageIds))
    .orderBy(asc(dialogueLines.order));
  const sfx = await db
    .select({ panelId: soundEffects.panelId, text: soundEffects.text })
    .from(soundEffects)
    .where(inArray(soundEffects.pageId, pageIds));
  for (const id of pageIds) out.set(id, { alt: "", panels: [] });
  for (const p of pns) {
    const suggested = panelAltText({
      beat: p.beat,
      dialogue: lines.filter((l) => l.panelId === p.id).map((l) => ({ speaker: l.speaker, text: l.text })),
      sfx: sfx.filter((s) => s.panelId === p.id).map((s) => s.text),
    });
    const alt = p.altText?.trim() || suggested;
    out.get(p.pageId)!.panels.push({ panelId: p.id, alt, custom: Boolean(p.altText?.trim()), suggested });
  }
  for (const v of out.values()) v.alt = v.panels.map((p) => p.alt).join(" ");
  return out;
}

/**
 * What stands between a project (or a chapter) and readers who use a screen reader or read small: panels with no
 * description to make alt text from, pages whose panel order differs from where the panels sit, and lettering too
 * faint or too small for the format.
 */
export async function accessibilityReport(db: Database, projectId: string, chapterId?: string | null) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("Project not found");
  const format = project.settings.format ?? "comic";
  const rtl = project.readingDirection === "rtl";
  const pgs = await db
    .select({ id: pages.id, order: pages.order, width: pages.width, chapter: chapters.order })
    .from(pages)
    .innerJoin(chapters, eq(chapters.id, pages.chapterId))
    .where(and(eq(pages.projectId, projectId), chapterId ? eq(pages.chapterId, chapterId) : undefined))
    .orderBy(asc(chapters.order), asc(pages.order));
  const ids = pgs.map((p) => p.id);
  const alts = await altTextFor(db, ids);
  const pns = ids.length
    ? await db
        .select({ id: panels.id, pageId: panels.pageId, order: panels.order, frame: panels.frame })
        .from(panels)
        .where(inArray(panels.pageId, ids))
        .orderBy(asc(panels.order))
    : [];
  const lines = ids.length
    ? await db
        .select({
          id: dialogueLines.id,
          pageId: dialogueLines.pageId,
          text: dialogueLines.text,
          bubble: dialogueLines.bubble,
        })
        .from(dialogueLines)
        .where(inArray(dialogueLines.pageId, ids))
    : [];
  const readingOrder: { pageId: string; chapter: number; page: number; panels: number; expected: number[] }[] = [];
  const lettering: (LetteringIssue & { pageId: string; chapter: number; page: number })[] = [];
  for (const pg of pgs) {
    const mine = pns.filter((p) => p.pageId === pg.id);
    // A strip or a film shot is one panel per page: nothing to order.
    if (format === "comic" && mine.length > 1) {
      const expected = expectedReadingOrder(mine, rtl);
      const actual = mine.map((p) => p.id);
      if (expected.join() !== actual.join())
        readingOrder.push({
          pageId: pg.id,
          chapter: pg.chapter,
          page: pg.order,
          panels: mine.length,
          // Each panel's number, in the order a reader would take them.
          expected: expected.map((id) => mine.find((p) => p.id === id)!.order),
        });
    }
    for (const issue of letteringIssues(
      lines.filter((l) => l.pageId === pg.id),
      pg.width,
      format,
    ))
      lettering.push({ ...issue, pageId: pg.id, chapter: pg.chapter, page: pg.order });
  }
  const panelAlts = [...alts.values()].flatMap((a) => a.panels);
  return {
    altText: {
      panels: panelAlts.length,
      written: panelAlts.filter((p) => p.custom).length,
      // A panel with no story beat, no words and no sound has nothing to describe it by.
      empty: panelAlts.filter((p) => !p.alt.replace(/[.\s]/g, "")).map((p) => p.panelId),
    },
    readingOrder,
    lettering,
  };
}

/** The narration as one text, chapter by chapter, for readers and listeners who need it. */
export async function narrationTranscript(
  db: Database,
  projectId: string,
  opts: { chapterId?: string | null; language: string },
) {
  const [project] = await db.select({ title: projects.title }).from(projects).where(eq(projects.id, projectId));
  const rows = await db
    .select({ chapter: chapters.order, title: chapters.title, text: narrationLines.text })
    .from(narrationLines)
    .innerJoin(chapters, eq(chapters.id, narrationLines.chapterId))
    .where(
      and(
        eq(chapters.projectId, projectId),
        eq(narrationLines.language, opts.language),
        opts.chapterId ? eq(chapters.id, opts.chapterId) : undefined,
      ),
    )
    .orderBy(asc(chapters.order), asc(narrationLines.order));
  const out = [`# ${project?.title ?? ""}`, ""];
  let current = -1;
  for (const r of rows) {
    if (r.chapter !== current) {
      current = r.chapter;
      out.push(`## Chapter ${r.chapter}: ${r.title}`, "");
    }
    out.push(r.text.trim(), "");
  }
  return out.join("\n");
}
