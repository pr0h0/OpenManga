import { type Database, projectMembers, sql } from "@openmanga/db";
import { UNPRICED_USAGE } from "@openmanga/services";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { user } from "../lib/http.ts";
import { rateLimit } from "../lib/middleware.ts";
import { doc } from "../lib/openapi.ts";

const OPERATION_LABELS: Record<string, string> = {
  character_reference: "Character refs",
  location_reference: "Location refs",
  prop_reference: "Prop refs",
  style_reference: "Style refs",
  panel_generation: "Panels",
  panel_edit: "Edits",
  cover: "Covers",
  story_analysis: "Story analysis",
  story_rewrite: "Story rewrite",
  chapter_plan: "Planning",
  page_prompts: "Prompt prep",
  narration_text: "Narration text",
  expert_chat: "Expert chat",
  expert_image: "Expert chat image",
};

/**
 * Cost dashboard data. scope = project id, list of project ids, or null for everything (admin). `ownerId` adds that
 * user's spend outside any project (expert chats), which no project scope would otherwise show.
 */
export async function usageSummary(db: Database, scope: string | string[] | null, ownerId?: string) {
  const projectFilter =
    scope === null
      ? sql`true`
      : typeof scope === "string"
        ? sql`u.project_id = ${scope}`
        : scope.length
          ? sql`u.project_id in (${sql.join(
              scope.map((s) => sql`${s}`),
              sql`, `,
            )})`
          : sql`false`;
  const filter = ownerId ? sql`(${projectFilter} or (u.project_id is null and u.user_id = ${ownerId}))` : projectFilter;
  const windows = await db.execute<{ win: string; cost: number; calls: number }>(sql`
    select w.win, coalesce(sum(u.estimated_cost_usd),0)::float as cost, count(u.id)::int as calls
    from (values ('today', date_trunc('day', now())), ('7d', now() - interval '7 days'), ('30d', now() - interval '30 days'), ('lifetime', '-infinity'::timestamptz)) as w(win, since)
    left join ai_usage u on u.created_at >= w.since and ${filter}
    group by w.win`);
  const providers = await db.execute<{
    provider: string;
    model: string;
    cost: number;
    calls: number;
    text_in: number;
    text_out: number;
    image_in: number;
    image_out: number;
    cached: number;
    images: number;
    unpriced: number;
  }>(sql`
    select u.provider, u.model, coalesce(sum(u.estimated_cost_usd),0)::float as cost, count(*)::int as calls,
      sum(u.text_input_tokens)::int as text_in, sum(u.text_output_tokens)::int as text_out,
      sum(u.image_input_tokens)::int as image_in, sum(u.image_output_tokens)::int as image_out, sum(u.cached_input_tokens)::int as cached,
      sum(u.images)::int as images, count(*) filter (where ${UNPRICED_USAGE})::int as unpriced
    from ai_usage u where ${filter} group by u.provider, u.model order by cost desc`);
  const operations = await db.execute<{
    operation: string;
    cost: number;
    calls: number;
    avg_latency: number;
    failures: number;
  }>(sql`
    select u.operation, coalesce(sum(u.estimated_cost_usd),0)::float as cost, count(*)::int as calls, coalesce(avg(u.latency_ms),0)::int as avg_latency,
      count(*) filter (where not u.success)::int as failures
    from ai_usage u where ${filter} group by u.operation order by cost desc`);
  const daily = await db.execute<{ day: string; provider: string; cost: number }>(sql`
    select to_char(date_trunc('day', u.created_at), 'YYYY-MM-DD') as day, u.provider, coalesce(sum(u.estimated_cost_usd),0)::float as cost
    from ai_usage u where ${filter} and u.created_at >= now() - interval '30 days' group by 1, 2 order by 1`);
  const jobFilter =
    scope === null
      ? sql`true`
      : typeof scope === "string"
        ? sql`g.project_id = ${scope}`
        : scope.length
          ? sql`g.project_id in (${sql.join(
              scope.map((s) => sql`${s}`),
              sql`, `,
            )})`
          : sql`false`;
  const experiments = await db.execute<{
    ref_size: string;
    generations: number;
    avg_image_input_tokens: number;
    avg_cost: number;
    avg_latency: number;
  }>(sql`
    select coalesce(gi.metadata->>'maxWidth','?') || 'x' || coalesce(gi.metadata->>'maxHeight','?') as ref_size,
      count(distinct g.id)::int as generations,
      coalesce(avg(u.image_input_tokens),0)::float as avg_image_input_tokens,
      coalesce(avg(u.estimated_cost_usd),0)::float as avg_cost,
      coalesce(avg(u.latency_ms),0)::int as avg_latency
    from generation_jobs g
    join generation_inputs gi on gi.job_id = g.id and gi.metadata ? 'maxWidth'
    left join ai_usage u on u.generation_job_id = g.id
    where g.kind = 'panel_generation' and g.status = 'completed' and ${jobFilter}
    group by 1 order by 2 desc`);
  const [quality] = await db.execute<{
    generated_panels: number;
    regenerated_panels: number;
    approved_panels: number;
  }>(sql`
    select count(distinct g.target_id)::int as generated_panels,
      count(distinct g.target_id) filter (where (select count(*) from generation_jobs g2 where g2.target_id = g.target_id and g2.kind in ('panel_generation','panel_edit') and g2.status = 'completed') > 1)::int as regenerated_panels,
      count(distinct p.id) filter (where p.approval_status in ('approved','locked'))::int as approved_panels
    from generation_jobs g left join panels p on p.id = g.target_id
    where g.kind = 'panel_generation' and g.status = 'completed' and ${jobFilter}`);
  const w = Object.fromEntries([...windows].map((r) => [r.win, { costUsd: r.cost, calls: r.calls }]));
  const provs = [...providers];
  const isImageSpend = (p: { images: number; image_out: number }) => p.images > 0 || p.image_out > 0;
  return {
    windows: w,
    /** Calls against a model with no rate snapshot: their cost is recorded as 0, so every total here is a floor. */
    unpricedCalls: provs.reduce((s, p) => s + p.unpriced, 0),
    // Per provider, plus a modality split from the recorded tokens. The old fixed buckets were named by
    // modality but summed by provider, so image models on a text-first provider (Meta Muse) were reported as
    // text spend, and BYOK providers outside the four named ones were reported nowhere.
    breakdown: {
      byProvider: provs.reduce<Record<string, number>>((acc, p) => {
        acc[p.provider] = (acc[p.provider] ?? 0) + p.cost;
        return acc;
      }, {}),
      // Either signal makes it image spend: the recorded image count (flat-per-image providers bill no image
      // tokens at all) or billed image output tokens (rows written before the images column existed, and billed
      // failures, carry no count). Text is everything that is not image, so no row can fall out of both buckets.
      imagesUsd: provs.filter(isImageSpend).reduce((s, p) => s + p.cost, 0),
      textUsd: provs.filter((p) => !isImageSpend(p)).reduce((s, p) => s + p.cost, 0),
      mockUsd: provs.filter((p) => p.provider === "mock").reduce((s, p) => s + p.cost, 0),
      kokoroLocalUsd: 0,
    },
    providers: provs,
    operations: [...operations].map((o) => ({ ...o, label: OPERATION_LABELS[o.operation] ?? o.operation })),
    daily: [...daily],
    referenceExperiments: [...experiments],
    quality: {
      generatedPanels: quality?.generated_panels ?? 0,
      regeneratedPanels: quality?.regenerated_panels ?? 0,
      approvedPanels: quality?.approved_panels ?? 0,
      regenerationRate: quality?.generated_panels ? quality.regenerated_panels / quality.generated_panels : 0,
      acceptanceRate: quality?.generated_panels ? quality.approved_panels / quality.generated_panels : 0,
    },
  };
}

export const usageRoutes = new Hono<AppEnv>();
/** Seven aggregates over every project the caller belongs to: cheap to ask for, expensive to answer. */
const usageLimit = rateLimit({ key: "usage", limit: () => 30, windowSec: 60, by: "user" });
doc({ method: "GET", path: "/api/usage", summary: "Cost dashboard across your projects", tag: "usage" });
usageRoutes.get("/", usageLimit, async (c) => {
  const { db } = c.get("deps");
  const ids = (
    await db
      .select({ id: projectMembers.projectId })
      .from(projectMembers)
      .where(sql`${projectMembers.userId} = ${user(c).id}`)
  ).map((r) => r.id);
  return c.json(await usageSummary(db, ids, user(c).id));
});
