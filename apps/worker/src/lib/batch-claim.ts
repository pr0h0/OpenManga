import { sql } from "@openmanga/db";
import type { WorkerDeps } from "../context.ts";

/**
 * Serialises find-or-submit for one idempotency key across every worker and every submitter. Without it two
 * submitters can both pass the "already submitted?" check and each pay for a batch, while only one handle is
 * kept: the other is paid for, never polled and never ingested. The lock is transaction-scoped, so it is released
 * when this transaction commits — by which time the row written inside it is visible to the next holder.
 */
export async function withBatchClaim<T>(deps: WorkerDeps, idempotencyKey: string, fn: () => Promise<T>): Promise<T> {
  return deps.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${idempotencyKey}))`);
    return fn();
  });
}
