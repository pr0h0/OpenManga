import { and, asc, assetFeatures, assets, chapters, eq, inArray, isNull, pages, panels, sql } from "@openmanga/db";
import { type DuplicateItem, groupDuplicates, type ImageFeatures, imageFeatures } from "@openmanga/image-utils";
import type { WorkerDeps } from "../context.ts";
import type { ProjectJob } from "../lib/runner.ts";

/**
 * Near-duplicate scan of a project, without AI: every panel's active artwork in reading order and the project's
 * cover and thumbnail art, compared by small cached features. The groups are kept on the job's result.
 */
export async function duplicateScan(deps: WorkerDeps, job: ProjectJob) {
  const rows = await deps.db
    .select({
      panelId: panels.id,
      assetId: panels.activeArtworkAssetId,
      sceneId: panels.sceneId,
      pageId: pages.id,
      page: pages.order,
      panel: panels.order,
      chapterId: chapters.id,
      chapter: chapters.order,
      chapterTitle: chapters.title,
    })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .innerJoin(chapters, eq(chapters.id, pages.chapterId))
    .where(and(eq(panels.projectId, job.projectId), sql`${panels.activeArtworkAssetId} is not null`))
    .orderBy(asc(chapters.order), asc(pages.order), asc(panels.order));
  const thumbs = await deps.db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.projectId, job.projectId), eq(assets.type, "cover"), isNull(assets.deletedAt)));
  const ids = [...new Set([...rows.map((r) => r.assetId!), ...thumbs.map((t) => t.id)])];

  // Features are computed once per asset (artwork never changes in place) and kept.
  const known = ids.length ? await deps.db.select().from(assetFeatures).where(inArray(assetFeatures.assetId, ids)) : [];
  const features = new Map<string, ImageFeatures>(known.map((k) => [k.assetId, k]));
  for (const id of ids) {
    if (features.has(id)) continue;
    const a = await deps.assets.get(id);
    if (!a || a.deletedAt) continue;
    try {
      const f = await imageFeatures(await deps.assets.read(a));
      await deps.db
        .insert(assetFeatures)
        .values({ assetId: id, ...f })
        .onConflictDoNothing();
      features.set(id, f);
    } catch (e) {
      deps.logger.warn("duplicate scan skipped an image", { assetId: id, error: (e as Error).message });
    }
  }

  const items: DuplicateItem[] = [];
  for (const [seq, r] of rows.entries()) {
    const f = features.get(r.assetId!);
    if (f) items.push({ id: r.panelId, seq, scene: r.sceneId, ...f });
  }
  for (const t of thumbs) {
    const f = features.get(t.id);
    if (f) items.push({ id: t.id, seq: -1, scene: null, thumbnail: true, ...f });
  }
  const byPanel = new Map(rows.map((r) => [r.panelId, r]));
  const groups = groupDuplicates(items).map((g) => ({
    kind: g.kind,
    score: g.score,
    members: g.ids.map((id) => {
      const r = byPanel.get(id);
      return r
        ? {
            panelId: r.panelId,
            assetId: r.assetId!,
            pageId: r.pageId,
            chapterId: r.chapterId,
            chapter: r.chapter,
            chapterTitle: r.chapterTitle,
            page: r.page,
            panel: r.panel,
          }
        : { assetId: id };
    }),
  }));
  return { scannedAt: new Date().toISOString(), panels: rows.length, thumbnails: thumbs.length, groups };
}
