import { and, assets, type Database, sql } from "@openmanga/db";
import type { AssetService } from "./assets.ts";

/**
 * Rendered video sections are kept between exports: one encoded clip per shot (or card), stored as an `export` asset
 * with `metadata.renderSection = { key }`, where the key hashes everything that decides the clip's pixels and length.
 * A render claims every key of its film in its export job's `result.sectionKeys` before it encodes anything, reuses
 * the clips it finds and stores the ones it encodes.
 *
 * This deletes the sections no export claims any more: keys not listed by a queued or running video export, or by a
 * completed one whose files still exist. That covers a deleted export, an expired one (its files went) and a
 * superseded one (a newer render of the same series dropped its claim). Returns the number deleted.
 */
export async function sweepRenderSections(db: Database, assetSvc: AssetService, projectId?: string) {
  const orphans = await db
    .select()
    .from(assets)
    .where(
      and(
        sql`${assets.metadata} ? 'renderSection'`,
        projectId ? sql`${assets.projectId} = ${projectId}` : undefined,
        sql`not exists (
          select 1 from export_jobs j
          where j.project_id = ${assets.projectId}
            and j.status in ('queued', 'processing', 'completed')
            and j.result -> 'sectionKeys' ? (${assets.metadata} -> 'renderSection' ->> 'key')
            and (j.status <> 'completed' or exists (select 1 from exports e where e.export_job_id = j.id)))`,
      ),
    )
    .limit(5000);
  for (const a of orphans) await assetSvc.hardDelete(a);
  return orphans.length;
}
