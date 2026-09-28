import { and, desc, eq, inArray, productionRuns } from "@openmanga/db";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { AiChoiceInput } from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { advanceRun, initialSteps, STEP_LABELS } from "../lib/production.ts";

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
});

const view = (r: typeof productionRuns.$inferSelect) => ({
  ...r,
  steps: r.steps.map((s) => ({ ...s, label: STEP_LABELS[s.key as keyof typeof STEP_LABELS] ?? s.key })),
});

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
  };
  const [run] = await db
    .insert(productionRuns)
    .values({ projectId: p.id, userId: user(c).id, options, steps: initialSteps(options) })
    .returning();
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: "production_run.start",
    targetType: "production_run",
    targetId: run!.id,
    metadata: { reviewGates: options.reviewGates, render: options.render },
    requestId: c.get("requestId"),
  });
  void advanceRun(c.get("deps"), run!.id);
  return c.json({ run: view(run!) }, 201);
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
  return c.json({ runs: rows.map(view) });
});

async function runWithAccess(c: Parameters<typeof uuidParam>[0], id: string) {
  const [run] = await c.get("deps").db.select().from(productionRuns).where(eq(productionRuns.id, id));
  if (!run) throw notFound("Run");
  await projectAccess(c, run.projectId, "generate");
  return run;
}

doc({
  method: "POST",
  path: "/api/production-runs/:id/continue",
  summary: "Continue a run: past a review step, after raising the budget cap, or retrying the step that failed",
  tag: "production",
});
productionRoutes.post("/production-runs/:id/continue", async (c) => {
  const run = await runWithAccess(c, uuidParam(c, "id"));
  if (run.status === "completed" || run.status === "cancelled") throw conflict(`The run is ${run.status}`);
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

doc({
  method: "POST",
  path: "/api/production-runs/:id/cancel",
  summary: "Stop a run. Jobs it already queued finish on their own; cancel them in Generation if needed.",
  tag: "production",
});
productionRoutes.post("/production-runs/:id/cancel", async (c) => {
  const run = await runWithAccess(c, uuidParam(c, "id"));
  const { db, events } = c.get("deps");
  await db
    .update(productionRuns)
    .set({ status: "cancelled", reason: "Cancelled", updatedAt: new Date() })
    .where(eq(productionRuns.id, run.id));
  await events.publish(run.projectId, { type: "production.updated", runId: run.id, status: "cancelled" });
  return c.json({ ok: true });
});
