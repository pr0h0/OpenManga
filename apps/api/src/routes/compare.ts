import { aiUsage, and, asc, eq, generationJobs, panels, sql } from "@openmanga/db";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess } from "../lib/access.ts";
import { AiChoiceInput, assertBudget, checkImageChoice } from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * Model comparison: one panel drawn by several image models side by side, each run's time, cost and visual check,
 * then the winner made the panel's artwork. Runs are ordinary panel generations whose artwork is kept, not activated.
 */
export const compareRoutes = new Hono<AppEnv>();

const CompareInput = z.object({ runs: z.array(AiChoiceInput.unwrap().unwrap()).min(2).max(4) });
doc({
  method: "POST",
  path: "/api/panels/:id/compare",
  summary:
    "Draw the panel with 2-4 image models at once (each an ai choice: credentialId and model). Each run is a panel generation that spends that key's credits; its artwork is kept as a version but not made active, and is checked when the project's visual checks are on. Read them with GET compare; pick the winner with POST compare/pick.",
  tag: "panels",
  body: CompareInput,
});
compareRoutes.post("/panels/:id/compare", async (c) => {
  const panelId = uuidParam(c, "id");
  const project = await entityAccess(c, "panel", panelId, "generate");
  const { runs } = await body(c, CompareInput);
  const deps = c.get("deps");
  const [pn] = await deps.db
    .select({ approvalStatus: panels.approvalStatus })
    .from(panels)
    .where(eq(panels.id, panelId));
  if (pn?.approvalStatus === "locked") throw conflict("Panel is locked");
  await assertBudget(c, project.id);
  for (const ai of runs) await checkImageChoice(c, ai);
  const compareId = crypto.randomUUID();
  const jobs = [];
  for (const ai of runs)
    jobs.push(
      await deps.planner.enqueuePanel(panelId, user(c).id, { priority: 1, ai, compareId, operation: "compare" }),
    );
  await deps.jobs.kick();
  return c.json({ compareId, jobs }, 202);
});

doc({
  method: "GET",
  path: "/api/panels/:id/compare",
  summary:
    "The panel's newest model comparison: per run its provider and model, status, artwork, time taken (ms), estimated cost (USD) and visual check (verdict and problems, when the checks are on).",
  tag: "panels",
});
compareRoutes.get("/panels/:id/compare", async (c) => {
  const panelId = uuidParam(c, "id");
  await entityAccess(c, "panel", panelId, "read");
  const { db } = c.get("deps");
  const [latest] = await db
    .select({ id: sql<string>`${generationJobs.parameters}->>'compare'` })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.targetId, panelId),
        eq(generationJobs.kind, "panel_generation"),
        sql`${generationJobs.parameters} ? 'compare'`,
      ),
    )
    .orderBy(sql`${generationJobs.createdAt} desc`)
    .limit(1);
  if (!latest) return c.json({ compareId: null, runs: [] });
  const rows = await db
    .select({
      jobId: generationJobs.id,
      status: generationJobs.status,
      provider: generationJobs.provider,
      model: generationJobs.model,
      ai: sql<{ credentialId?: string | null } | null>`${generationJobs.parameters}->'ai'`,
      failureReason: generationJobs.failureReason,
      startedAt: generationJobs.startedAt,
      finishedAt: generationJobs.finishedAt,
      assetId: sql<string | null>`${generationJobs.result}->>'assetId'`,
      // The outer column is named in full: unqualified, "id" would resolve to the subquery's own ai_usage.id.
      costUsd: sql<number>`coalesce((select sum(u.estimated_cost_usd)::float from ${aiUsage} u where u.generation_job_id = "generation_jobs"."id"), 0)`,
    })
    .from(generationJobs)
    .where(and(eq(generationJobs.targetId, panelId), sql`${generationJobs.parameters}->>'compare' = ${latest.id}`))
    .orderBy(asc(generationJobs.createdAt));
  const checks = await db
    .select({
      assetId: sql<string>`${generationJobs.input}->>'assetId'`,
      status: generationJobs.status,
      result: generationJobs.result,
    })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.targetId, panelId),
        eq(generationJobs.kind, "panel_check"),
        sql`${generationJobs.input}->>'assetId' in (${sql.join(
          [...rows.map((r) => r.assetId).filter(Boolean), "00000000-0000-0000-0000-000000000000"].map((a) => sql`${a}`),
          sql`, `,
        )})`,
      ),
    );
  return c.json({
    compareId: latest.id,
    runs: rows.map((r) => {
      const ck = checks.find((x) => x.assetId === r.assetId);
      return {
        jobId: r.jobId,
        status: r.status,
        provider: r.provider,
        model: r.model,
        credentialId: r.ai?.credentialId ?? null,
        failureReason: r.failureReason,
        assetId: r.assetId,
        durationMs: r.startedAt && r.finishedAt ? r.finishedAt.getTime() - r.startedAt.getTime() : null,
        costUsd: Math.round(Number(r.costUsd) * 10000) / 10000,
        check: ck ? { status: ck.status, ...((ck.result as Record<string, unknown> | null) ?? {}) } : null,
      };
    }),
  });
});

const Pick = z.object({ jobId: z.string().uuid() });
doc({
  method: "POST",
  path: "/api/panels/:id/compare/pick",
  summary:
    "Use a comparison run's artwork as the panel's: it becomes the active version. Returns the run's provider, model and credential, to draw more panels with it.",
  tag: "panels",
  body: Pick,
});
compareRoutes.post("/panels/:id/compare/pick", async (c) => {
  const panelId = uuidParam(c, "id");
  const project = await entityAccess(c, "panel", panelId, "write");
  const { jobId } = await body(c, Pick);
  const deps = c.get("deps");
  const [job] = await deps.db.select().from(generationJobs).where(eq(generationJobs.id, jobId));
  if (!job || job.targetId !== panelId || typeof job.parameters.compare !== "string") throw notFound("Comparison run");
  const assetId = (job.result as { assetId?: string } | null)?.assetId;
  if (job.status !== "completed" || !assetId) throw badRequest(`That run is ${job.status}`);
  const [pn] = await deps.db.select().from(panels).where(eq(panels.id, panelId));
  if (pn?.approvalStatus === "locked") throw conflict("Panel is locked");
  await deps.db
    .update(panels)
    .set({ activeArtworkAssetId: assetId, status: "ready", qa: null })
    .where(eq(panels.id, panelId));
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: project.id,
    action: "panel.compare_pick",
    targetType: "panel",
    targetId: panelId,
    metadata: { jobId, assetId, provider: job.provider, model: job.model },
    requestId: c.get("requestId"),
  });
  return c.json({
    assetId,
    provider: job.provider,
    model: job.model,
    credentialId: (job.parameters.ai as { credentialId?: string | null } | undefined)?.credentialId ?? null,
  });
});
