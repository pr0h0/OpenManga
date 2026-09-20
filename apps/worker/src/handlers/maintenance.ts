import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  and,
  assets,
  assetVariants,
  audioJobs,
  eq,
  exportJobs,
  exportsTable,
  generationJobs,
  inArray,
  lt,
  or,
  passwordResetTokens,
  sessions,
  sql,
} from "@openmanga/db";
import type { QueueName } from "@openmanga/queue";
import { KeyRing, rotateCredentials } from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";

/** Periodic cleanup. Only disposable data is removed; canonical assets and version history are kept. */
export async function runMaintenance(deps: WorkerDeps) {
  const now = new Date();
  const log = deps.logger.child({ task: "maintenance" });
  const result: Record<string, number> = {};

  result.expiredSessions = (
    await deps.db
      .delete(sessions)
      .where(or(lt(sessions.expiresAt, now), lt(sessions.revokedAt, new Date(now.getTime() - 7 * 86400_000))))
      .returning({ id: sessions.id })
  ).length;
  result.expiredResetTokens = (
    await deps.db
      .delete(passwordResetTokens)
      .where(
        or(
          lt(passwordResetTokens.expiresAt, new Date(now.getTime() - 86400_000)),
          sql`${passwordResetTokens.usedAt} is not null`,
        ),
      )
      .returning({ id: passwordResetTokens.id })
  ).length;

  // Prompt-reference derivatives are reproducible: drop ones unused for 30 days.
  const staleVariants = await deps.db
    .select()
    .from(assetVariants)
    .where(
      and(
        eq(assetVariants.variant, "prompt_ref"),
        lt(assetVariants.lastUsedAt, new Date(now.getTime() - 30 * 86400_000)),
      ),
    )
    .limit(1000);
  for (const v of staleVariants) await deps.assets.storage.delete(v.storageKey).catch(() => {});
  if (staleVariants.length)
    await deps.db.delete(assetVariants).where(
      inArray(
        assetVariants.id,
        staleVariants.map((v) => v.id),
      ),
    );
  result.promptDerivativesRemoved = staleVariants.length;

  // Expired export files (the export job record stays for history).
  const expired = await deps.db
    .select({ e: exportsTable, a: assets })
    .from(exportsTable)
    .innerJoin(assets, eq(assets.id, exportsTable.assetId))
    .where(lt(exportsTable.expiresAt, now))
    .limit(500);
  for (const { a } of expired) await deps.assets.hardDelete(a);
  result.expiredExports = expired.length;

  // Trashed assets older than 30 days (never locked / never active artwork).
  const trashed = await deps.db
    .select()
    .from(assets)
    .where(
      and(
        lt(assets.deletedAt, new Date(now.getTime() - 30 * 86400_000)),
        sql`${assets.status} <> 'locked'`,
        sql`not exists (select 1 from panels p where p.active_artwork_asset_id = ${assets.id})`,
      ),
    )
    .limit(500);
  for (const a of trashed) await deps.assets.hardDelete(a);
  result.trashedAssetsPurged = trashed.length;

  // Temp files older than 6h (failed/abandoned processing).
  result.tempEntriesRemoved = 0;
  try {
    for (const name of await readdir(deps.config.TEMP_ROOT)) {
      const p = join(deps.config.TEMP_ROOT, name);
      const s = await stat(p).catch(() => null);
      if (s && now.getTime() - s.mtimeMs > 6 * 3600_000) {
        await rm(p, { recursive: true, force: true });
        result.tempEntriesRemoved++;
      }
    }
  } catch {}

  /**
   * Jobs abandoned by a crashed worker become failed so the UI and retries work. Liveness decides that, not
   * elapsed time: a row is only stalled if nothing has written to it for STALLED_JOB_TIMEOUT_MINUTES *and* Redis
   * no longer reports the job as active. A 2h+ video export writes progress throughout, so it stays alive — the
   * old duration-only rule failed such an export at the two-hour mark while it was still rendering, and then the
   * phantom "failed" row left the single export slot occupied until someone restarted the worker by hand.
   */
  const quietSince = new Date(now.getTime() - deps.config.STALLED_JOB_TIMEOUT_MINUTES * 60_000);
  /** Ids of quiet `processing` rows that no worker is still running. Generation jobs name their own queue. */
  const abandoned = async (
    table: typeof generationJobs | typeof audioJobs | typeof exportJobs,
    queueOf: (row: { id: string; queue: string | null }) => QueueName,
  ) => {
    const quiet = await deps.db
      .select({ id: table.id, queue: "queue" in table ? table.queue : sql<string | null>`null` })
      .from(table)
      .where(and(eq(table.status, "processing"), lt(table.updatedAt, quietSince)))
      .limit(500);
    const ids: string[] = [];
    for (const row of quiet) {
      const queue = queueOf(row);
      // A worker still holding the job is doing real work, however long it has been quiet.
      if ((await deps.queue.state(queue, row.id).catch(() => null)) === "active") continue;
      ids.push(row.id);
      // Drop a leftover queue entry so it cannot start later against a row we just failed.
      await deps.queue.removeWaiting(queue, row.id).catch(() => false);
    }
    return ids;
  };

  const stuck = await abandoned(generationJobs, (r) => (r.queue ?? "image-generation") as QueueName);
  if (stuck.length)
    await deps.db
      .update(generationJobs)
      .set({
        status: "failed",
        failureCode: "stalled",
        failureReason: "The worker stopped while processing this job. Retry it.",
        finishedAt: now,
      })
      .where(inArray(generationJobs.id, stuck));
  result.stalledJobs = stuck.length;

  // Panels whose batch submitter died. A batched panel is left `queued` on purpose — only the submitter hands it
  // to the provider — so if that job failed for good, nothing will ever move it and the batch reads as idle
  // rather than broken. The stalled sweep above cannot see them: they are `queued`, not `processing`.
  const stranded = await deps.db.execute<{ id: string }>(sql`
    select j.id from generation_jobs j
    join generation_jobs s
      on s.batch_id = j.batch_id and s.kind in ('image_batch_submit', 'text_batch_submit') and s.status = 'failed'
    where j.status = 'queued' and (j.parameters->>'batchMode')::boolean is true
      and j.kind not in ('image_batch_submit', 'text_batch_submit')
      and not exists (
        select 1 from generation_jobs r
        where r.batch_id = j.batch_id and r.kind in ('image_batch_submit', 'text_batch_submit')
          and r.status in ('queued', 'processing')
      )
    limit 2000`);
  const strandedIds = [...stranded].map((r) => r.id);
  if (strandedIds.length) {
    for (const id of strandedIds) await deps.queue.removeWaiting("image-generation", id).catch(() => false);
    await deps.db
      .update(generationJobs)
      .set({
        status: "failed",
        failureCode: "batch_submit_failed",
        failureReason: "The batch this panel was waiting in could not be submitted. Retry it.",
        finishedAt: now,
      })
      .where(inArray(generationJobs.id, strandedIds));
  }
  result.strandedBatchJobs = strandedIds.length;

  const stuckAudio = await abandoned(audioJobs, () => "tts");
  if (stuckAudio.length)
    await deps.db
      .update(audioJobs)
      .set({
        status: "failed",
        failureCode: "stalled",
        failureReason: "Worker stopped during synthesis",
        finishedAt: now,
      })
      .where(inArray(audioJobs.id, stuckAudio));
  const stuckExports = await abandoned(exportJobs, () => "export");
  if (stuckExports.length)
    await deps.db
      .update(exportJobs)
      .set({ status: "failed", failureReason: "Worker stopped during export", finishedAt: now })
      .where(inArray(exportJobs.id, stuckExports));

  await deps.db.execute(
    sql`delete from outbox where status = 'published' and published_at < now() - interval '7 days'`,
  );
  const rot = await rotateCredentials(deps.db, new KeyRing(deps.config), { logger: log });
  result.credentialsRotated = rot.rotated;
  result.credentialRotationFailures = rot.failed;
  log.info("maintenance complete", result);
  return result;
}
