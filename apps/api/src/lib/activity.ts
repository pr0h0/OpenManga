import { activityStats, type Database, sql } from "@openmanga/db";
import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import type { AppEnv } from "../context.ts";

/**
 * Local usage stats (see `activityStats`): counted in memory and written as daily totals every few seconds, so a busy
 * editor's autosaves cost one upsert per key rather than one per request. Nothing here leaves the instance.
 */
type Row = typeof activityStats.$inferInsert;
/** Per database (one in production; tests run several apps in one process). */
const buffers = new Map<Database, { rows: Map<string, Row>; timer: ReturnType<typeof setTimeout> }>();
const FLUSH_MS = 15_000;

const today = () => new Date().toISOString().slice(0, 10);

export function recordActivity(
  db: Database,
  r: Pick<Row, "userId" | "kind" | "source" | "key"> & { count?: number; errors?: number; ms?: number },
) {
  let b = buffers.get(db);
  if (!b) {
    const timer = setTimeout(() => void flushActivity(db), FLUSH_MS);
    timer.unref?.();
    b = { rows: new Map(), timer };
    buffers.set(db, b);
  }
  const day = today();
  const id = [r.userId, day, r.kind, r.source, r.key].join("\u0000");
  const row = b.rows.get(id) ?? {
    userId: r.userId,
    day,
    kind: r.kind,
    source: r.source,
    key: r.key,
    count: 0,
    errors: 0,
    ms: 0,
  };
  row.count! += r.count ?? 1;
  row.errors! += r.errors ?? 0;
  // A day holds at most 86.4M ms per key; clamped so a bad client value can't overflow the column.
  row.ms = Math.min(row.ms! + Math.max(0, Math.round(r.ms ?? 0)), 2_000_000_000);
  b.rows.set(id, row);
}

/** Write what is buffered for one database, or all of them. Called on a timer, at shutdown, and before a read. */
export async function flushActivity(db?: Database) {
  if (!db) {
    await Promise.all([...buffers.keys()].map((d) => flushActivity(d)));
    return;
  }
  const b = buffers.get(db);
  if (!b) return;
  clearTimeout(b.timer);
  buffers.delete(db);
  const rows = [...b.rows.values()];
  if (!rows.length) return;
  await db
    .insert(activityStats)
    .values(rows)
    .onConflictDoUpdate({
      target: [activityStats.userId, activityStats.day, activityStats.kind, activityStats.source, activityStats.key],
      set: {
        count: sql`${activityStats.count} + excluded.count`,
        errors: sql`${activityStats.errors} + excluded.errors`,
        ms: sql`least(${activityStats.ms}::bigint + excluded.ms, 2000000000)::int`,
      },
    })
    // Stats are best effort: a failed write drops these totals rather than failing anything the user did.
    .catch(() => {});
}

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Counts each write request a user makes by its route pattern (`POST /api/pages/:id/panels`), never its ids,
 * body or query. Reads are left out: screens and polling would drown the actions people actually take.
 */
export const trackActions: MiddlewareHandler<AppEnv> = async (c, next) => {
  const start = performance.now();
  await next();
  const u = c.get("user");
  if (READS.has(c.req.method) || !u || u.settings?.activityTracking === false) return;
  const pattern = routePath(c, -1);
  // Unmatched paths (a 404 for a route that does not exist) would store whatever was typed.
  if (!pattern || pattern.includes("*")) return;
  // The stats' own reports and clearing are not something the user did in the app.
  if (pattern.startsWith("/api/me/activity")) return;
  const source = c.get("service") ? "agent" : c.get("sessionId") ? "web" : "run";
  recordActivity(c.get("deps").db, {
    userId: u.id,
    kind: "action",
    source,
    key: `${c.req.method} ${pattern.startsWith("/api") ? pattern : `/api${pattern}`}`,
    errors: c.res.status >= 400 ? 1 : 0,
    ms: performance.now() - start,
  });
};
