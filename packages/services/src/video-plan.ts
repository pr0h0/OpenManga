import {
  and,
  asc,
  assets,
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
import { fadeCuts, type Motion, readingOrder, resolveMotions } from "@openmanga/domain";
import { focusInCrop } from "@openmanga/image-utils";

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
  /** This shot shares one hold with the next: a narration line spans the cut between them. */
  joinNext: boolean;
  /** Fade from black into this shot, and to black at its end (scene breaks). */
  fade: { in: boolean; out: boolean };
  /** Panel cut: the active artwork, the image focus inside the visible crop, and the camera move. */
  art: typeof assets.$inferSelect | null;
  focus: { x: number; y: number };
  motion: Motion | null;
};

/** On-page aspect of a panel: its frame at the page's size. */
export const panelAspect = (pn: Pick<PanelRow, "frame">, pg: { width: number; height: number }) =>
  (pn.frame.width * pg.width) / Math.max(1, pn.frame.height * pg.height);

/**
 * The shot list of a narrated video — shared by the final render and the in-browser preview so both show the same
 * shots, holds, moves and fades with the same narration. Page cut: one shot per page. Panel cut: one shot per panel in
 * reading order. Narration goes to its panel's shot (or its page's); lines attached only to a page play over that
 * page's first panel. Scope: a single panel (panel cut), a page, a chapter, or the whole project (all nulls).
 *
 * A disabled panel is left out with its narration (a page whose panels are all disabled leaves the page cut too),
 * except when it is the scope itself, so its own preview still plays. A line with `video.untilPanelId` joins its
 * shot to every following shot up to that panel's.
 */
export async function planVideoShots(
  db: Database,
  project: {
    id: string;
    readingDirection: "ltr" | "rtl" | "vertical";
    settings?: { video?: { fadeAtSceneBreaks?: boolean } | null };
  },
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
  const off = (pn: PanelRow) => Boolean(pn.video?.disabled) && pn.id !== scope.panelId;
  const disabled = new Set(panelRows.filter(off).map((p) => p.id));
  const shot = (pg: PageRow, panel: PanelRow | null, k: number | null, label: string): PlannedShot => ({
    key: panel?.id ?? pg.id,
    label,
    page: pg,
    panel,
    panelIndex: k,
    lineIds: [],
    joinNext: false,
    fade: { in: false, out: false },
    art: null,
    focus: { x: 0.5, y: 0.5 },
    motion: null,
  });
  // Every panel (disabled ones too) mapped to the shot it shows in, or the last shot before it: where a span ends.
  const shotOfPanel = new Map<string, number>();

  let shots: PlannedShot[] = [];
  if (cut === "page") {
    for (const pg of pageRows) {
      const list = ordered.get(pg.id) ?? [];
      if (!list.length || list.some((p) => !disabled.has(p.id)))
        shots.push(shot(pg, null, null, `Ch. ${pg.chapterOrder} · page ${pg.order}`));
      for (const pn of list) shotOfPanel.set(pn.id, shots.length - 1);
    }
    const byPage = new Map(shots.map((s) => [s.page.id, s]));
    const pageOfPanel = new Map(panelRows.map((p) => [p.id, p.pageId]));
    for (const l of lines) {
      if (l.panelId && disabled.has(l.panelId)) continue;
      const pid = l.pageId ?? (l.panelId ? pageOfPanel.get(l.panelId) : undefined);
      if (pid) byPage.get(pid)?.lineIds.push(l.id);
    }
  } else {
    for (const pg of pageRows)
      (ordered.get(pg.id) ?? []).forEach((pn, k) => {
        if (!disabled.has(pn.id))
          shots.push(shot(pg, pn, k + 1, `Ch. ${pg.chapterOrder} · page ${pg.order} · panel ${k + 1}`));
        shotOfPanel.set(pn.id, shots.length - 1);
      });
    const byPanel = new Map(shots.map((s) => [s.panel!.id, s]));
    const firstOfPage = new Map(
      [...ordered.entries()].map(([pid, list]) => [pid, list.map((p) => byPanel.get(p.id)).find(Boolean)]),
    );
    for (const l of lines) {
      if (l.panelId && disabled.has(l.panelId)) continue;
      const s = (l.panelId && byPanel.get(l.panelId)) || (l.pageId && firstOfPage.get(l.pageId)) || undefined;
      s?.lineIds.push(l.id);
    }
    if (scope.panelId) shots = shots.filter((s) => s.panel!.id === scope.panelId);
  }
  if (!shots.length) throw new Error("There are no panels to render");

  // Spans: a line stretched up to a later panel joins every cut between its shot and that panel's.
  const index = new Map(shots.map((s, i) => [s, i]));
  const shotOfLine = new Map(shots.flatMap((s) => s.lineIds.map((id) => [id, index.get(s)!] as const)));
  for (const l of lines) {
    const from = shotOfLine.get(l.id);
    const to = l.video?.untilPanelId ? shotOfPanel.get(l.video.untilPanelId) : undefined;
    if (from === undefined || to === undefined || scope.panelId) continue;
    for (let i = from; i < Math.min(to, shots.length - 1); i++) shots[i]!.joinNext = true;
  }

  // Scene breaks fade through black; a page's override is its first panel's.
  const firstPanel = (s: PlannedShot) => s.panel ?? (ordered.get(s.page.id) ?? []).find((p) => !disabled.has(p.id));
  const cuts = fadeCuts(
    shots.map((s) => ({ sceneId: s.panel?.sceneId ?? s.page.sceneId, fade: firstPanel(s)?.video?.fade })),
    project.settings?.video?.fadeAtSceneBreaks ?? false,
  );
  shots.forEach((s, i) => {
    s.fade = { in: cuts[i]!, out: cuts[i + 1] ?? false };
  });

  if (cut === "panel") {
    const artIds = shots.map((s) => s.panel!.activeArtworkAssetId).filter((x): x is string => Boolean(x));
    const arts = artIds.length ? await db.select().from(assets).where(inArray(assets.id, artIds)) : [];
    for (const s of shots) {
      const pn = s.panel!;
      s.art = arts.find((a) => a.id === pn.activeArtworkAssetId) ?? null;
      if (s.art?.width && s.art.height)
        s.focus = focusInCrop(s.art.width, s.art.height, panelAspect(pn, s.page), pn.imageTransform);
    }
    const motions = resolveMotions(
      shots.map((s) => ({ motion: s.panel!.video?.motion, shotType: s.panel!.shotType, focus: s.focus })),
    );
    shots.forEach((s, i) => {
      s.motion = motions[i]!;
    });
  }

  const inScope = new Set(shots.flatMap((s) => s.lineIds));
  const unplacedLines = lines.filter(
    (l) =>
      !inScope.has(l.id) &&
      !(l.panelId && disabled.has(l.panelId)) &&
      !scope.pageId &&
      !scope.pageIds?.length &&
      !scope.panelId,
  ).length;
  return { shots, lines, unplacedLines, disabledPanels: disabled.size };
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
