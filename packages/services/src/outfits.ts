import {
  and,
  asc,
  assets,
  chapters,
  characterOutfits,
  type DbOrTx,
  desc,
  eq,
  inArray,
  isNull,
  outfitAssignments,
  pages,
  panels,
  referenceAssets,
} from "@openmanga/db";

export type OutfitRow = typeof characterOutfits.$inferSelect;

/**
 * Where a panel's outfit came from: set on this panel ("panel" for this one only, "onward" from here to the next
 * change, carried across pages and chapters), named in the panel's own outfit text, or the character's default.
 */
export type OutfitSource = "panel" | "onward" | "text" | "default";

export type TimelineEntry = {
  id: string;
  characterId: string;
  outfitId: string;
  outfitName: string;
  panelId: string;
  scope: "onward" | "panel";
  chapterId: string;
  chapterOrder: number;
  chapterTitle: string;
  pageId: string;
  pageOrder: number;
  panelOrder: number;
};

export type ResolvedOutfit = { outfit: OutfitRow; source: OutfitSource; assignment?: TimelineEntry };

type Position = { chapterOrder: number; pageOrder: number; panelOrder: number };
const compare = (a: Position, b: Position) =>
  a.chapterOrder - b.chapterOrder || a.pageOrder - b.pageOrder || a.panelOrder - b.panelOrder;

/** The outfit a free-text description names: the text contains the outfit's name, or the name contains the text. */
export function outfitNamedIn(outfits: OutfitRow[], text: string | null | undefined): OutfitRow | null {
  const wanted = (text ?? "").toLowerCase().trim();
  if (!wanted) return null;
  // Longest name first, so "Rain Coat (torn)" wins over "Rain Coat" when the text says the former.
  const byLength = [...outfits].sort((a, b) => b.name.length - a.name.length);
  return (
    byLength.find((o) => {
      const name = o.name.toLowerCase().trim();
      return name.length > 0 && (wanted.includes(name) || name.includes(wanted));
    }) ?? null
  );
}

/** Every outfit change of these characters, in reading order. */
export async function outfitTimeline(db: DbOrTx, characterIds: string[]): Promise<TimelineEntry[]> {
  if (!characterIds.length) return [];
  return db
    .select({
      id: outfitAssignments.id,
      characterId: outfitAssignments.characterId,
      outfitId: outfitAssignments.outfitId,
      outfitName: characterOutfits.name,
      panelId: outfitAssignments.panelId,
      scope: outfitAssignments.scope,
      chapterId: chapters.id,
      chapterOrder: chapters.order,
      chapterTitle: chapters.title,
      pageId: pages.id,
      pageOrder: pages.order,
      panelOrder: panels.order,
    })
    .from(outfitAssignments)
    .innerJoin(characterOutfits, eq(characterOutfits.id, outfitAssignments.outfitId))
    .innerJoin(panels, eq(panels.id, outfitAssignments.panelId))
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .innerJoin(chapters, eq(chapters.id, pages.chapterId))
    .where(inArray(outfitAssignments.characterId, characterIds))
    .orderBy(asc(chapters.order), asc(pages.order), asc(panels.order), asc(outfitAssignments.scope));
}

/**
 * The outfit each character wears on a panel. `text` is the panel's free-text outfit for that character: when it
 * names an outfit it overrides one carried from an earlier panel, and otherwise it stays a detail of the one worn. A character with no outfit
 * resolved (free text naming none, and no default) is left out, and keeps the free text or the bible's wardrobe.
 */
export async function resolveOutfits(
  db: DbOrTx,
  panelId: string,
  /** `versionId`: the appearance version the panel pins, which decides the default outfit (see below). */
  characters: { id: string; text?: string | null; versionId?: string }[],
): Promise<Map<string, ResolvedOutfit>> {
  const out = new Map<string, ResolvedOutfit>();
  const ids = characters.map((c) => c.id);
  if (!ids.length) return out;
  const [here] = await db
    .select({ chapterOrder: chapters.order, pageOrder: pages.order, panelOrder: panels.order })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .innerJoin(chapters, eq(chapters.id, pages.chapterId))
    .where(eq(panels.id, panelId));
  if (!here) return out;
  const outfits = await db
    .select()
    .from(characterOutfits)
    .where(inArray(characterOutfits.characterId, ids))
    .orderBy(asc(characterOutfits.createdAt));
  const timeline = await outfitTimeline(db, ids);
  for (const c of characters) {
    const mine = outfits.filter((o) => o.characterId === c.id);
    const changes = timeline.filter((t) => t.characterId === c.id);
    const only = changes.find((t) => t.panelId === panelId && t.scope === "panel");
    const onward = changes.filter((t) => t.scope === "onward" && compare(t, here) <= 0).at(-1);
    const named = outfitNamedIn(mine, c.text);
    // What is said on this panel beats what it inherits: a change set here, then an outfit its own text names, then
    // the last change carried from an earlier panel.
    const set = only ?? (onward?.panelId === panelId || !named ? onward : undefined);
    const setOutfit = set && mine.find((o) => o.id === set.outfitId);
    if (set && setOutfit) out.set(c.id, { outfit: setOutfit, source: set.scope, assignment: set });
    else if (named) out.set(c.id, { outfit: named, source: "text" });
    else if (!c.text?.trim()) {
      // The default outfit mirrors the wardrobe of the version it was made for. A panel on another version falls
      // back to that version's own wardrobe instead, so a new look is not dressed in the old one's clothes.
      const d = mine.find(
        (o) => o.isDefault && (!c.versionId || !o.characterVersionId || o.characterVersionId === c.versionId),
      );
      if (d) out.set(c.id, { outfit: d, source: "default" });
    }
  }
  return out;
}

/** The wardrobe line for a resolved outfit: its description, plus the panel's own outfit text as a detail. */
export function wardrobeText(r: ResolvedOutfit, all: OutfitRow[], text: string | null | undefined): string {
  const base = r.outfit.description.trim() ? `${r.outfit.name}: ${r.outfit.description.trim()}` : r.outfit.name;
  const detail = (text ?? "").trim();
  // Text that names a different outfit contradicts the one set here; the set outfit wins.
  const other = outfitNamedIn(all, detail);
  if (!detail || (other && other.id !== r.outfit.id) || detail.toLowerCase() === r.outfit.name.toLowerCase().trim())
    return base;
  return `${base} (this panel: ${detail})`;
}

/** The approved (or locked) reference drawn for this outfit on a character version, newest primary first. */
export async function outfitReferenceAssets(db: DbOrTx, outfitIds: string[], characterVersionId: string) {
  if (!outfitIds.length) return new Map<string, typeof assets.$inferSelect>();
  const rows = await db
    .select({ outfitId: referenceAssets.outfitId, asset: assets })
    .from(referenceAssets)
    .innerJoin(assets, eq(assets.id, referenceAssets.assetId))
    .where(
      and(
        inArray(referenceAssets.outfitId, outfitIds),
        eq(referenceAssets.characterVersionId, characterVersionId),
        inArray(referenceAssets.status, ["approved", "locked"]),
        isNull(assets.deletedAt),
      ),
    )
    .orderBy(desc(referenceAssets.isPrimary), desc(referenceAssets.createdAt));
  const out = new Map<string, typeof assets.$inferSelect>();
  for (const r of rows) if (r.outfitId && !out.has(r.outfitId)) out.set(r.outfitId, r.asset);
  return out;
}
