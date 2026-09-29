import {
  and,
  asc,
  audioAssets,
  chapters,
  type Database,
  eq,
  inArray,
  narrationLines,
  narrationSegments,
  pages,
  panels,
} from "@openmanga/db";
import { readingOrder } from "@openmanga/domain";

export type VideoCut = "page" | "panel";
export type VideoScope = {
  chapterId?: string | null;
  pageId?: string | null;
  panelId?: string | null;
  /** A selection of pages (in reading order, whatever order they are given in). */
  pageIds?: string[] | null;
};

type PageRow = typeof pages.$inferSelect & { chapterOrder: number };
type PanelRow = typeof panels.$inferSelect;

export type PlannedShot = {
  key: string;
  label: string;
  page: PageRow;
  /** Panel cut only. */
  panel: PanelRow | null;
  panelIndex: number | null;
  /** Narration line ids spoken over this shot, in order. */
  lineIds: string[];
};

/**
 * The shot list of a narrated video — shared by the final render and the in-browser preview so both show the same
 * shots with the same narration. Page cut: one shot per page. Panel cut: one shot per panel in reading order.
 * Narration goes to its panel's shot (or its page's); lines attached only to a page play over that page's first
 * panel. Scope: a single panel (panel cut), a page, a chapter, or the whole project (all nulls).
 */
export async function planVideoShots(
  db: Database,
  project: { id: string; readingDirection: "ltr" | "rtl" | "vertical" },
  scope: VideoScope,
  cut: VideoCut,
  language: string,
) {
  const panelRow = scope.panelId ? (await db.select().from(panels).where(eq(panels.id, scope.panelId)))[0] : null;
  if (scope.panelId && !panelRow) throw new Error("Panel not found");
  const pageId = scope.pageId ?? panelRow?.pageId ?? null;
  const pageRows: PageRow[] = (
    await db
      .select({ page: pages, chapterOrder: chapters.order })
      .from(pages)
      .innerJoin(chapters, eq(chapters.id, pages.chapterId))
      .where(
        pageId
          ? eq(pages.id, pageId)
          : scope.pageIds?.length
            ? and(eq(chapters.projectId, project.id), inArray(pages.id, scope.pageIds))
            : scope.chapterId
              ? eq(pages.chapterId, scope.chapterId)
              : eq(chapters.projectId, project.id),
      )
      .orderBy(asc(chapters.order), asc(pages.order))
  ).map((r) => ({ ...r.page, chapterOrder: r.chapterOrder }));
  if (!pageRows.length) throw new Error(scope.chapterId ? "This chapter has no pages" : "There are no pages to render");

  const chapterIds = [...new Set(pageRows.map((p) => p.chapterId))];
  const lines = await db
    .select()
    .from(narrationLines)
    .where(and(inArray(narrationLines.chapterId, chapterIds), eq(narrationLines.language, language)))
    .orderBy(asc(narrationLines.order));
  const panelRows = await db
    .select()
    .from(panels)
    .where(
      inArray(
        panels.pageId,
        pageRows.map((p) => p.id),
      ),
    )
    .orderBy(asc(panels.order));
  const ordered = new Map(
    pageRows.map((pg) => [
      pg.id,
      readingOrder(
        panelRows.filter((p) => p.pageId === pg.id),
        pg.readingDirection ?? project.readingDirection,
      ),
    ]),
  );

  let shots: PlannedShot[];
  if (cut === "page") {
    shots = pageRows.map((pg) => ({
      key: pg.id,
      label: `Ch. ${pg.chapterOrder} · page ${pg.order}`,
      page: pg,
      panel: null,
      panelIndex: null,
      lineIds: [],
    }));
    const byPage = new Map(shots.map((s) => [s.page.id, s]));
    const pageOfPanel = new Map(panelRows.map((p) => [p.id, p.pageId]));
    for (const l of lines) {
      const pid = l.pageId ?? (l.panelId ? pageOfPanel.get(l.panelId) : undefined);
      if (pid) byPage.get(pid)?.lineIds.push(l.id);
    }
  } else {
    shots = pageRows.flatMap((pg) =>
      (ordered.get(pg.id) ?? []).map((pn, k) => ({
        key: pn.id,
        label: `Ch. ${pg.chapterOrder} · page ${pg.order} · panel ${k + 1}`,
        page: pg,
        panel: pn,
        panelIndex: k + 1,
        lineIds: [] as string[],
      })),
    );
    const byPanel = new Map(shots.map((s) => [s.panel!.id, s]));
    const firstOfPage = new Map(
      [...ordered.entries()].map(([pid, list]) => [pid, list[0] ? byPanel.get(list[0].id) : undefined]),
    );
    for (const l of lines) {
      const shot = (l.panelId && byPanel.get(l.panelId)) || (l.pageId && firstOfPage.get(l.pageId)) || undefined;
      shot?.lineIds.push(l.id);
    }
    if (scope.panelId) shots = shots.filter((s) => s.panel!.id === scope.panelId);
  }
  if (!shots.length) throw new Error("There are no panels to render");
  const inScope = new Set(shots.flatMap((s) => s.lineIds));
  const unplacedLines = lines.filter(
    (l) => !inScope.has(l.id) && !scope.pageId && !scope.pageIds?.length && !scope.panelId,
  ).length;
  return { shots, lines, unplacedLines };
}

/** Segments with their synthesized audio for the given lines, grouped per line in order. */
export async function narrationSegmentsFor(db: Database, lineIds: string[]) {
  if (!lineIds.length)
    return new Map<string, { s: typeof narrationSegments.$inferSelect; a: typeof audioAssets.$inferSelect | null }[]>();
  const rows = await db
    .select({ s: narrationSegments, a: audioAssets })
    .from(narrationSegments)
    .leftJoin(audioAssets, eq(audioAssets.assetId, narrationSegments.activeAudioAssetId))
    .where(inArray(narrationSegments.narrationLineId, lineIds))
    .orderBy(asc(narrationSegments.order));
  const byLine = new Map<string, typeof rows>();
  for (const r of rows) byLine.set(r.s.narrationLineId, [...(byLine.get(r.s.narrationLineId) ?? []), r]);
  return byLine;
}
