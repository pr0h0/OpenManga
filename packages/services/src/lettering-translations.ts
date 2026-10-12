import {
  and,
  asc,
  characters,
  type DbOrTx,
  dialogueLines,
  eq,
  inArray,
  letteringTranslations,
  narrationLines,
  pages,
  panels,
} from "@openmanga/db";
import { hashOf } from "@openmanga/domain";

export type LetteringLine = {
  sourceType: "dialogue" | "caption";
  sourceId: string;
  pageId: string;
  page: number;
  panel: number | null;
  kind: "dialogue" | "thought" | "shout" | "whisper" | "caption";
  speaker: string | null;
  text: string;
};

const KIND: Record<string, LetteringLine["kind"]> = { thought: "thought", shout: "shout", whisper: "whisper" };

/**
 * A chapter's lettering in reading order: speech bubbles, and the on-page captions of its narration in the project's
 * language (the boxes the page shows). What a translated edition re-letters.
 */
export async function chapterLettering(db: DbOrTx, chapterId: string, language: string): Promise<LetteringLine[]> {
  const pgs = await db
    .select({ id: pages.id, order: pages.order })
    .from(pages)
    .where(eq(pages.chapterId, chapterId))
    .orderBy(asc(pages.order));
  if (!pgs.length) return [];
  const pageOrder = new Map(pgs.map((p) => [p.id, p.order]));
  const pns = await db
    .select({ id: panels.id, order: panels.order })
    .from(panels)
    .where(
      inArray(
        panels.pageId,
        pgs.map((p) => p.id),
      ),
    );
  const panelOrder = new Map(pns.map((p) => [p.id, p.order]));
  const dialogue = await db
    .select({ d: dialogueLines, speaker: characters.name })
    .from(dialogueLines)
    .leftJoin(characters, eq(characters.id, dialogueLines.characterId))
    .where(
      inArray(
        dialogueLines.pageId,
        pgs.map((p) => p.id),
      ),
    );
  const captions = await db
    .select()
    .from(narrationLines)
    .where(
      and(
        eq(narrationLines.chapterId, chapterId),
        eq(narrationLines.language, language),
        eq(narrationLines.showOnPage, true),
      ),
    );
  const lines: (LetteringLine & { order: number })[] = [
    ...dialogue.map(({ d, speaker }) => ({
      sourceType: "dialogue" as const,
      sourceId: d.id,
      pageId: d.pageId,
      page: pageOrder.get(d.pageId) ?? 0,
      panel: d.panelId ? (panelOrder.get(d.panelId) ?? null) : null,
      kind: KIND[d.bubble.type] ?? ("dialogue" as const),
      speaker,
      text: d.text,
      order: d.order,
    })),
    ...captions
      .filter((n) => n.pageId && n.box)
      .map((n) => ({
        sourceType: "caption" as const,
        sourceId: n.id,
        pageId: n.pageId!,
        page: pageOrder.get(n.pageId!) ?? 0,
        panel: n.panelId ? (panelOrder.get(n.panelId) ?? null) : null,
        kind: "caption" as const,
        speaker: null,
        text: n.text,
        order: n.order,
      })),
  ];
  return lines
    .sort((a, b) => a.page - b.page || (a.panel ?? 0) - (b.panel ?? 0) || a.order - b.order)
    .map(({ order: _o, ...l }) => l);
}

/** The hash a translation keeps of its original, to tell when the original changed under it. */
export const sourceSha = (text: string) => hashOf(text.trim());

/** Translations of these lines into `language`, by source id. */
export async function translationsOf(db: DbOrTx, sourceIds: string[], language: string) {
  if (!sourceIds.length) return new Map<string, typeof letteringTranslations.$inferSelect>();
  const rows = await db
    .select()
    .from(letteringTranslations)
    .where(and(inArray(letteringTranslations.sourceId, sourceIds), eq(letteringTranslations.language, language)));
  return new Map(rows.map((r) => [r.sourceId, r]));
}

/** Saves translations; a hand-edited one is kept unless `edited` is set on the new one too. */
export async function saveTranslations(
  db: DbOrTx,
  projectId: string,
  language: string,
  rows: { sourceType: "dialogue" | "caption"; sourceId: string; text: string; original: string; edited: boolean }[],
) {
  const existing = await translationsOf(
    db,
    rows.map((r) => r.sourceId),
    language,
  );
  let saved = 0;
  for (const r of rows) {
    const prev = existing.get(r.sourceId);
    if (prev?.edited && !r.edited) continue;
    await db
      .insert(letteringTranslations)
      .values({
        projectId,
        sourceType: r.sourceType,
        sourceId: r.sourceId,
        language,
        text: r.text,
        sourceSha256: sourceSha(r.original),
        edited: r.edited,
      })
      .onConflictDoUpdate({
        target: [letteringTranslations.sourceType, letteringTranslations.sourceId, letteringTranslations.language],
        set: { text: r.text, sourceSha256: sourceSha(r.original), edited: r.edited, updatedAt: new Date() },
      });
    saved++;
  }
  return saved;
}
