import { assets, assetVariants, type Database, eq, inArray, instanceSettings, sql } from "@openmanga/db";
import {
  type RetentionCandidate,
  type RetentionKind,
  type RetentionPolicy,
  selectForRetention,
} from "@openmanga/domain";
import type { AssetService } from "./assets.ts";

export const STORAGE_POLICY_KEY = "storagePolicy";
/** What an `approve` policy is waiting to delete (a summary; the files are chosen again when it is approved). */
export const STORAGE_PENDING_KEY = "storagePending";

export async function getStoragePolicy(db: Database): Promise<RetentionPolicy | null> {
  const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.key, STORAGE_POLICY_KEY));
  return (row?.value as RetentionPolicy | undefined) ?? null;
}

/**
 * Every stored byte (files and their derivatives), and every file the policy may delete with its kind, size and age.
 * Each file appears once, under the first kind it matches. Panel versions are only AI-drawn art no panel shows, not
 * locked and not used as a reference; uploads are never candidates, since they cannot be made again.
 */
export async function storageCandidates(db: Database) {
  const [total] = await db.execute<{ bytes: number }>(sql`
    select (select coalesce(sum(byte_size), 0) from assets)::float8
      + (select coalesce(sum(byte_size), 0) from asset_variants)::float8 as bytes`);
  const rows = await db.execute<{ id: string; kind: RetentionKind; bytes: number; created_at: string }>(sql`
    with sized as (
      select a.*, a.byte_size + coalesce((select sum(v.byte_size) from asset_variants v where v.asset_id = a.id), 0)
        as total_bytes
      from assets a
    ), tagged as (
      select id, total_bytes, created_at, case
          when metadata ? 'renderSection' then 'render_cache'
          when id in (select asset_id from exports) then 'export'
          when deleted_at is not null and status <> 'locked'
            and not exists (select 1 from panels p where p.active_artwork_asset_id = sized.id) then 'trash'
          when type = 'panel_art' and generation_job_id is not null and deleted_at is null and status not in ('approved', 'locked')
            and not exists (select 1 from panels p where p.active_artwork_asset_id = sized.id)
            and not exists (select 1 from reference_assets r where r.asset_id = sized.id) then 'panel_version'
          when type = 'audio' and deleted_at is null
            and not exists (select 1 from narration_segments s where s.active_audio_asset_id = sized.id) then 'audio_take'
        end as kind
      from sized
    )
    select id, kind, total_bytes::float8 as bytes, created_at from tagged where kind is not null
    union all
    select v.id, 'prompt_reference', v.byte_size::float8, coalesce(v.last_used_at, v.created_at)
    from asset_variants v where v.variant = 'prompt_ref'`);
  const candidates: RetentionCandidate[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    bytes: r.bytes,
    createdAt: r.created_at,
  }));
  return { totalBytes: total?.bytes ?? 0, candidates };
}

/** What the policy would delete right now (a dry run); null when there is no policy or it is off. */
export async function planStorage(db: Database, policy: RetentionPolicy | null, now = new Date()) {
  if (!policy?.enabled || (policy.maxAgeDays === null && policy.maxTotalGb === null)) return null;
  const { totalBytes, candidates } = await storageCandidates(db);
  return { totalBytes, ...selectForRetention(candidates, totalBytes, policy, now) };
}
export type StoragePlan = NonNullable<Awaited<ReturnType<typeof planStorage>>>;

/** Deletes the chosen files and their derivatives from disk and the database, oldest first. */
export async function applyStoragePlan(db: Database, store: AssetService, plan: StoragePlan) {
  const variants = plan.selected.filter((c) => c.kind === "prompt_reference").map((c) => c.id);
  for (let i = 0; i < variants.length; i += 500) {
    const rows = await db
      .select()
      .from(assetVariants)
      .where(inArray(assetVariants.id, variants.slice(i, i + 500)));
    for (const v of rows) await store.storage.delete(v.storageKey).catch(() => {});
    if (rows.length)
      await db.delete(assetVariants).where(
        inArray(
          assetVariants.id,
          rows.map((v) => v.id),
        ),
      );
  }
  const files = plan.selected.filter((c) => c.kind !== "prompt_reference").map((c) => c.id);
  let deleted = variants.length;
  for (let i = 0; i < files.length; i += 500) {
    const rows = await db
      .select()
      .from(assets)
      .where(inArray(assets.id, files.slice(i, i + 500)));
    for (const a of rows) {
      await store.hardDelete(a);
      deleted++;
    }
  }
  return deleted;
}

/** The summary an `approve` policy shows in the app's warning until it is resolved. */
export const pendingSummary = (plan: StoragePlan, now = new Date()) => ({
  computedAt: now.toISOString(),
  files: plan.files,
  bytes: plan.bytes,
  totalBytes: plan.totalBytes,
  afterBytes: plan.afterBytes,
  overLimitBytes: plan.overLimitBytes,
  reasons: plan.reasons,
  byKind: plan.byKind,
});
export type StoragePending = ReturnType<typeof pendingSummary>;

export async function setStoragePending(db: Database, pending: StoragePending | null) {
  if (!pending) {
    await db.delete(instanceSettings).where(eq(instanceSettings.key, STORAGE_PENDING_KEY));
    return;
  }
  await db
    .insert(instanceSettings)
    .values({ key: STORAGE_PENDING_KEY, value: pending })
    .onConflictDoUpdate({ target: instanceSettings.key, set: { value: pending, updatedAt: new Date() } });
}

export async function getStoragePending(db: Database): Promise<StoragePending | null> {
  const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.key, STORAGE_PENDING_KEY));
  return (row?.value as StoragePending | undefined) ?? null;
}
