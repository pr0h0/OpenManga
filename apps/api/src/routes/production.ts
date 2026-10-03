import { and, desc, eq, inArray, productionRuns } from "@openmanga/db";
import { pipelineStaleness, recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { AiChoiceInput } from "../lib/ai.ts";
import { ApiError, badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { advanceRun, cancelRunWork, initialSteps, pendingWork, STEP_LABELS } from "../lib/production.ts";

export const productionRoutes = new Hono<AppEnv>();

const ACTIVE = ["running", "waiting", "paused"] as const;

const StartRun = z.object({
  /** Pause for a person after the analysis, after the references and before the final render. */
  reviewGates: z.boolean().default(true),
  preparePrompts: z.boolean().default(true),
  render: z.boolean().default(true),
  /** Also write the YouTube text and export the package (defaults to on for film projects). */
  youtube: z.boolean().optional(),
  ai: z.object({ text: AiChoiceInput, image: AiChoiceInput }).default({ text: null, image: null }),
  /** Update production: run only the out-of-date stages (see GET staleness) and what follows from them. */
  update: z.boolean().default(false),
});

/** A run as the API shows it; an active one also says how many jobs stopping it would cancel (`pendingJobs`). */
const view = async (deps: Deps, r: typeof productionRuns.$inferSelect) => {
  const work = (ACTIVE as readonly string[]).includes(r.status) ? await pendingWork(deps, r) : null;
  return {
    ...r,
    steps: r.steps.map((s) => ({ ...s, label: STEP_LABELS[s.key as keyof typeof STEP_LABELS] ?? s.key })),
    pendingJobs: work ? work.generation.length + work.audio.length + work.exports.length : 0,
  };
};

doc({
  method: "POST",
  path: "/api/projects/:projectId/production-runs",
  summary:
    "Start a production run: the whole pipeline (analysis, references, plans, prompts, art, narration, audio, thumbnail, render) step by step, reusing whatever already exists. Needs a budget cap; stops at it.",
  tag: "production",
  body: StartRun,
});
productionRoutes.post("/projects/:projectId/production-runs", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  const input = await body(c, StartRun);
  const { db } = c.get("deps");
  // A run spends without asking at every step, so it only runs inside a cap the owner set.
  if (p.settings.budgetUsd == null)
    throw badRequest("Set an AI budget cap in project settings first: a production run spends up to it unattended.");
  const [active] = await db
    .select({ id: productionRuns.id })
    .from(productionRuns)
    .where(and(eq(productionRuns.projectId, p.id), inArray(productionRuns.status, [...ACTIVE])));
  if (active) throw conflict("This project already has a production run in progress.");
  const options = {
    reviewGates: input.reviewGates,
    preparePrompts: input.preparePrompts,
    render: input.render,
    youtube: input.youtube ?? p.settings.format === "film",
    ai: input.ai,
    update: input.update,
  };
  const stale = input.update
    ? (await pipelineStaleness(db, p)).stages.filter((s) => s.count > 0).map((s) => s.key)
    : [];
  const steps = initialSteps(options, stale);
  if (!steps.length) throw conflict("Nothing is out of date.");
  const [run] = await db
    .insert(productionRuns)
    .values({ projectId: p.id, userId: user(c).id, options, steps })
    .returning();
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: "production_run.start",
    targetType: "production_run",
    targetId: run!.id,
    metadata: { reviewGates: options.reviewGates, render: options.render, update: options.update },
    requestId: c.get("requestId"),
  });
  void advanceRun(c.get("deps"), run!.id);
  return c.json({ run: await view(c.get("deps"), run!) }, 201);
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/staleness",
  summary:
    "What is out of date along story → plan → prompts → art → narration → audio → render, stage by stage (count and a note), plus stalePlans (chapters with pages whose text changed after planning) and staleNarration (chapters whose text or panels changed after their narration was written), each with its page, panel, drawn-panel and narration-line counts. Start an update with POST production-runs { update: true }; resolve a chapter with POST /api/chapters/:id/keep or by re-planning it.",
  tag: "production",
});
productionRoutes.get("/projects/:projectId/staleness", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { stages, staleArt, stale } = await pipelineStaleness(c.get("deps").db, p);
  return c.json({ stages, staleArtPanels: staleArt.length, stalePlans: stale.plans, staleNarration: stale.narration });
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/production-runs",
  summary: "Recent production runs",
  tag: "production",
});
productionRoutes.get("/projects/:projectId/production-runs", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const rows = await c
    .get("deps")
    .db.select()
    .from(productionRuns)
    .where(eq(productionRuns.projectId, p.id))
    .orderBy(desc(productionRuns.createdAt))
    .limit(10);
  return c.json({ runs: await Promise.all(rows.map((r) => view(c.get("deps"), r))) });
});

async function runWithAccess(c: Parameters<typeof uuidParam>[0], id: string, action: "read" | "generate" = "generate") {
  const [run] = await c.get("deps").db.select().from(productionRuns).where(eq(productionRuns.id, id));
  if (!run) throw notFound("Run");
  await projectAccess(c, run.projectId, action);
  return run;
}

doc({
  method: "GET",
  path: "/api/production-runs/:id",
  summary: "One production run and its steps",
  tag: "production",
});
productionRoutes.get("/production-runs/:id", async (c) =>
  c.json({ run: await view(c.get("deps"), await runWithAccess(c, uuidParam(c, "id"), "read")) }),
);

doc({
  method: "POST",
  path: "/api/production-runs/:id/continue",
  summary: "Continue a run: past a review step, after raising the budget cap, or retrying the step that failed",
  tag: "production",
});
productionRoutes.post("/production-runs/:id/continue", async (c) => {
  const run = await runWithAccess(c, uuidParam(c, "id"));
  // A run acts as the member who started it, on their keys: continuing it is theirs to do. Anyone who can generate
  // may still cancel it.
  if (run.userId !== user(c).id)
    throw new ApiError(403, "not_your_run", "Another member started this run; only they can continue it.");
  if (run.status === "completed" || run.status === "completed_with_warnings" || run.status === "cancelled")
    throw conflict(`The run is ${run.status.replaceAll("_", " ")}`);
  const steps = run.steps.map((s) => {
    if (s.status === "review") return { ...s, status: "done" as const, finishedAt: new Date().toISOString() };
    // A failed step starts over; whatever it had already made is found and reused.
    if (s.status === "failed") return { key: s.key, status: "pending" as const };
    return s;
  });
  const { db } = c.get("deps");
  await db
    .update(productionRuns)
    .set({ status: "running", reason: null, steps, updatedAt: new Date() })
    .where(eq(productionRuns.id, run.id));
  void advanceRun(c.get("deps"), run.id);
  return c.json({ ok: true });
});

const CancelRun = z.object({
  /** Also cancel the jobs the run queued that have not started (default). False stops the orchestration only. */
  jobs: z.boolean().default(true),
});

doc({
  method: "POST",
  path: "/api/production-runs/:id/cancel",
  summary:
    "Stop a run, and by default cancel what it queued that has not started: generation jobs (queued, in a provider batch, paused or waiting for an answer), queued narration audio and its export. Jobs already running at a provider finish, and the stopped run acts on nothing they return. { jobs: false } stops the run only.",
  tag: "production",
  body: CancelRun,
});
productionRoutes.post("/production-runs/:id/cancel", async (c) => {
  const run = await runWithAccess(c, uuidParam(c, "id"));
  // An empty body is the default: stop and cancel.
  const input = CancelRun.parse(await c.req.json().catch(() => ({})));
  const deps = c.get("deps");
  // Stopped first, so the runner starts nothing new while the jobs are being cancelled.
  await deps.db
    .update(productionRuns)
    .set({ status: "cancelled", reason: "Cancelled", updatedAt: new Date() })
    .where(eq(productionRuns.id, run.id));
  const cancelled = input.jobs ? await cancelRunWork(deps, run) : 0;
  await deps.events.publish(run.projectId, { type: "production.updated", runId: run.id, status: "cancelled" });
  return c.json({ ok: true, cancelled });
});
