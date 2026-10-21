import { activityStats, and, eq, gte, sql } from "@openmanga/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { flushActivity, recordActivity } from "../lib/activity.ts";
import { body, query, requireAdmin, user } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * Local usage stats: the signed-in user's own, and anonymous totals for an administrator. Mounted for the browser
 * only, never on the router MCP tools call.
 */
export const activityRoutes = new Hono<AppEnv>();

/**
 * A screen's route template, as the app's router names it: literal segments and `$params` only. A segment with a
 * digit is refused, so a real id (a uuid, a token) can't be stored by a client that sent the path it was on.
 */
const RouteTemplate = z
  .string()
  .max(200)
  .regex(
    /^\/(?:(?:\$[a-zA-Z]{1,40}|[a-z][a-z-]{0,40})(?:\/|$))*$/,
    "Expected a route template like /projects/$projectId",
  );

const PostActivity = z.object({
  pages: z
    .array(
      z.object({
        route: RouteTemplate,
        visits: z.number().int().min(0).max(1_000),
        /** Active time on the screen since the last report; a report covers about a minute. */
        ms: z.number().int().min(0).max(3_600_000),
      }),
    )
    .max(50),
});
doc({
  method: "POST",
  path: "/api/me/activity",
  summary: "Report time on screens (route templates only); ignored when the user turned stats off",
  tag: "activity",
  body: PostActivity,
});
activityRoutes.post("/me/activity", async (c) => {
  const u = user(c);
  const { pages } = await body(c, PostActivity);
  if (u.settings?.activityTracking !== false)
    for (const p of pages)
      recordActivity(c.get("deps").db, {
        userId: u.id,
        kind: "page",
        source: "web",
        key: p.route,
        count: p.visits,
        ms: p.ms,
      });
  return c.json({ ok: true });
});

const Range = z.object({ days: z.coerce.number().int().min(1).max(3650).optional() });
const since = (days?: number) =>
  days ? new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10) : null;

doc({
  method: "GET",
  path: "/api/me/activity",
  summary: "Your usage stats (optionally the last `days` days)",
  tag: "activity",
});
activityRoutes.get("/me/activity", async (c) => {
  const u = user(c);
  const { days } = query(c, Range);
  await flushActivity(c.get("deps").db);
  const from = since(days);
  const rows = await c
    .get("deps")
    .db.select({
      kind: activityStats.kind,
      source: activityStats.source,
      key: activityStats.key,
      count: sql<string>`sum(${activityStats.count})::bigint`,
      errors: sql<string>`sum(${activityStats.errors})::bigint`,
      ms: sql<string>`sum(${activityStats.ms})::bigint`,
      days: sql<number>`count(distinct ${activityStats.day})::int`,
    })
    .from(activityStats)
    .where(and(eq(activityStats.userId, u.id), from ? gte(activityStats.day, from) : undefined))
    .groupBy(activityStats.kind, activityStats.source, activityStats.key);
  return c.json({ enabled: u.settings?.activityTracking !== false, since: from, ...split(rows) });
});

doc({ method: "DELETE", path: "/api/me/activity", summary: "Delete all your usage stats", tag: "activity" });
activityRoutes.delete("/me/activity", async (c) => {
  const u = user(c);
  await flushActivity(c.get("deps").db);
  await c.get("deps").db.delete(activityStats).where(eq(activityStats.userId, u.id));
  return c.json({ ok: true });
});

doc({
  method: "GET",
  path: "/api/admin/activity",
  summary: "Usage totals across all users, with how many used each screen or action (no per-user rows)",
  tag: "activity",
});
activityRoutes.get("/admin/activity", requireAdmin, async (c) => {
  const { days } = query(c, Range);
  await flushActivity(c.get("deps").db);
  const from = since(days);
  const rows = await c
    .get("deps")
    .db.select({
      kind: activityStats.kind,
      source: activityStats.source,
      key: activityStats.key,
      count: sql<string>`sum(${activityStats.count})::bigint`,
      errors: sql<string>`sum(${activityStats.errors})::bigint`,
      ms: sql<string>`sum(${activityStats.ms})::bigint`,
      users: sql<number>`count(distinct ${activityStats.userId})::int`,
      days: sql<number>`count(distinct ${activityStats.day})::int`,
    })
    .from(activityStats)
    .where(from ? gte(activityStats.day, from) : undefined)
    .groupBy(activityStats.kind, activityStats.source, activityStats.key);
  const [total] = await c
    .get("deps")
    .db.select({ users: sql<number>`count(distinct ${activityStats.userId})::int` })
    .from(activityStats)
    .where(from ? gte(activityStats.day, from) : undefined);
  return c.json({ since: from, users: total?.users ?? 0, ...split(rows) });
});

type Agg = {
  kind: string;
  source: string;
  key: string;
  /** Sums come back as bigint strings: a long range can pass the integer limit. */
  count: string;
  errors: string;
  ms: string;
  days: number;
  users?: number;
};

/** Screens by time spent, actions by use. */
function split(rows: Agg[]) {
  return {
    pages: rows
      .filter((r) => r.kind === "page")
      .map((r) => ({ route: r.key, visits: Number(r.count), ms: Number(r.ms), days: r.days, users: r.users }))
      .sort((a, b) => b.ms - a.ms),
    actions: rows
      .filter((r) => r.kind === "action")
      .map((r) => ({
        action: r.key,
        source: r.source,
        count: Number(r.count),
        errors: Number(r.errors),
        ms: Number(r.ms),
        days: r.days,
        users: r.users,
      }))
      .sort((a, b) => b.count - a.count),
  };
}
