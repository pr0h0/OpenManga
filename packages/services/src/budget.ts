import { aiUsage, type Database, eq, instanceSettings, projects, sql } from "@openmanga/db";

export type BudgetStatus = {
  limitUsd: number | null;
  spentUsd: number;
  remainingUsd: number | null;
  exceeded: boolean;
  /** Billable calls made against a model nobody has priced: real spend that `spentUsd` cannot see. */
  unpricedCalls: number;
};

/**
 * An ai_usage row whose cost could not be computed: no rate snapshot, but real billable quantity. Its
 * estimated_cost_usd is 0, so every total built from that column is a floor. Local synthesis really is free
 * (metadata.local) and is not counted. Unqualified so it can be dropped into any single-table ai_usage query.
 */
export const UNPRICED_USAGE = sql`rate_snapshot_id is null and metadata->>'local' is distinct from 'true'
  and text_input_tokens + text_output_tokens + image_input_tokens + image_output_tokens + images + characters > 0`;

/** Project spend from recorded usage against the project's optional budget cap. */
export async function projectBudget(db: Database, projectId: string): Promise<BudgetStatus> {
  const [row] = await db
    .select({
      settings: projects.settings,
      spent: sql<string>`(select coalesce(sum(${aiUsage.estimatedCostUsd}), 0) from ${aiUsage} where ${aiUsage.projectId} = ${projectId})`,
      unpriced: sql<number>`(select count(*)::int from ${aiUsage} where ${aiUsage.projectId} = ${projectId} and ${UNPRICED_USAGE})`,
    })
    .from(projects)
    .where(eq(projects.id, projectId));
  const spentUsd = Number(row?.spent ?? 0);
  const limit = row?.settings.budgetUsd;
  const limitUsd = typeof limit === "number" ? limit : null;
  return {
    limitUsd,
    spentUsd,
    remainingUsd: limitUsd === null ? null : Math.max(0, limitUsd - spentUsd),
    exceeded: limitUsd !== null && spentUsd >= limitUsd,
    unpricedCalls: row?.unpriced ?? 0,
  };
}

export type InstanceBudget = {
  /** The ceiling in USD for this calendar month (UTC), or null for none. */
  limitUsd: number | null;
  /** Where the ceiling comes from: set in Admin, the `INSTANCE_BUDGET_USD_MONTHLY` default, or nowhere. */
  source: "admin" | "env" | "none";
  spentUsd: number;
  remainingUsd: number | null;
  exceeded: boolean;
  /** Start of the month being counted (UTC). */
  monthStart: string;
};

/** The admin-set ceiling: a number, null for "no ceiling", or undefined when nothing is stored (use the env). */
export async function storedInstanceBudget(db: Database): Promise<number | null | undefined> {
  const [row] = await db.select().from(instanceSettings).where(eq(instanceSettings.key, "budget"));
  if (!row) return undefined;
  const v = row.value.monthlyUsd;
  return typeof v === "number" ? v : null;
}

/**
 * The whole server's AI spend this calendar month (UTC) against its ceiling: the admin's value when one is stored,
 * else `envDefault` (`INSTANCE_BUDGET_USD_MONTHLY`). Every recorded call counts, whoever's key paid for it, since
 * the point is one number an operator can hold a shared install to. The mock provider costs nothing real.
 */
export async function instanceBudget(db: Database, envDefault: number | undefined): Promise<InstanceBudget> {
  const stored = await storedInstanceBudget(db);
  const limitUsd = stored !== undefined ? stored : (envDefault ?? null);
  const [row] = await db.execute<{ spent: string; month_start: string }>(sql`
    select coalesce(sum(estimated_cost_usd), 0) as spent, to_char(m.start, 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as month_start
    from (select date_trunc('month', now() at time zone 'UTC') as start) m
    left join ${aiUsage} u on u.created_at >= m.start at time zone 'UTC' and u.provider <> 'mock'
    group by m.start`);
  const spentUsd = Number(row?.spent ?? 0);
  return {
    limitUsd,
    source: stored !== undefined ? "admin" : envDefault !== undefined ? "env" : "none",
    spentUsd,
    remainingUsd: limitUsd === null ? null : Math.max(0, limitUsd - spentUsd),
    exceeded: limitUsd !== null && spentUsd >= limitUsd,
    monthStart: row?.month_start ?? "",
  };
}

/** The refusal shown when the server's ceiling stops work, shared by the API's 402 and the worker's pause. */
export const instanceBudgetReason = (b: InstanceBudget) =>
  `this server's monthly AI budget of $${b.limitUsd!.toFixed(2)} is reached ($${b.spentUsd.toFixed(2)} spent since ${b.monthStart.slice(0, 10)})`;
