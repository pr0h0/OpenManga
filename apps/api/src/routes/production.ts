import { and, desc, eq, inArray, productionRuns, projects, sql } from "@openmanga/db";
import {
  pipelineStaleness,
  projectReadiness,
  publishingStaleness,
  recordAudit,
  youtubeSourceFingerprint,
} from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Deps } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { AiChoiceInput } from "../lib/ai.ts";
import { ApiError, badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { advanceRun, cancelRunWork, FAILED_CHECK, initialSteps, pendingWork, STEP_LABELS } from "../lib/production.ts";

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
    "What is out of date along story → plan → prompts → art → narration → audio → render, stage by stage (count and a note), plus stalePlans (chapters with pages whose text changed after planning) and staleNarration (chapters whose text or panels changed after their narration was written), each with its page, panel, drawn-panel and narration-line counts. Start an update with POST production-runs { update: true }; resolve a chapter with POST /api/chapters/:id/keep or by re-planning it. publishing flags the YouTube text and the thumbnail headline when what they were written from changed (never regenerated on their own): regenerate them, or POST keep-current.",
  tag: "production",
});
productionRoutes.get("/projects/:projectId/staleness", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const { stages, staleArt, stale } = await pipelineStaleness(db, p);
  return c.json({
    stages,
    staleArtPanels: staleArt.length,
    stalePlans: stale.plans,
    staleNarration: stale.narration,
    publishing: await publishingStaleness(db, p),
  });
});

/** One line of the health report: what, how many, whether it stops the project being ready, and where it is fixed. */
type HealthItem = {
  key: string;
  label: string;
  count: number;
  /** "block": the project is not ready to publish while it stands; "info": worth knowing. The label says how many. */
  severity: "block" | "info";
  /** An in-app path under the project (and search params) where it is dealt with. */
  link: { to: string; search?: Record<string, string> };
};

doc({
  method: "GET",
  path: "/api/projects/:projectId/health",
  summary:
    "Project health in one report: a verdict (ready to publish, or how many blocking issues), and items each with a count, a severity (block or info) and where to fix it: export readiness (artwork, narration, audio), the video, failed visual checks, what is out of date (stages, changed chapters, YouTube text and thumbnail), unfinished and failed generation, open comments, spend against the budget and disk use.",
  tag: "production",
});
productionRoutes.get("/projects/:projectId/health", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const [staleness, readiness, publishing] = await Promise.all([
    pipelineStaleness(db, p),
    projectReadiness(db, p.id),
    publishingStaleness(db, p),
  ]);
  const [n] = await db.execute<{
    active: number;
    failed: number;
    audio_active: number;
    exports_active: number;
    comments: number;
    checks: number;
    spend: number;
    disk: number;
  }>(sql`select
    (select count(*)::int from generation_jobs where project_id = ${p.id}
      and status in ('queued', 'submitted', 'processing', 'paused', 'awaiting_input')) as active,
    (select count(*)::int from generation_jobs where project_id = ${p.id} and status = 'failed'
      and retried_by_job_id is null) as failed,
    (select count(*)::int from audio_jobs where project_id = ${p.id} and status in ('queued', 'processing')) as audio_active,
    (select count(*)::int from export_jobs where project_id = ${p.id} and status in ('queued', 'processing')) as exports_active,
    (select count(*)::int from panel_comments where project_id = ${p.id} and thread_id is null
      and resolved_at is null and deleted_at is null) as comments,
    (select count(*)::int from panels pn where pn.project_id = ${p.id} and ${FAILED_CHECK}) as checks,
    (select coalesce(sum(estimated_cost_usd), 0)::float from ai_usage where project_id = ${p.id}) as spend,
    (select coalesce(sum(a.byte_size), 0)::float8 from assets a where a.project_id = ${p.id})
      + (select coalesce(sum(v.byte_size), 0)::float8 from asset_variants v join assets a on a.id = v.asset_id
        where a.project_id = ${p.id}) as disk`);
  const stage = (k: string) => staleness.stages.find((s) => s.key === k)!;
  const items: HealthItem[] = [
    // What an export would ship incomplete: the same checks as Exports' readiness, blocking ones first.
    ...readiness.issues.map((i) => ({
      key: `readiness.${i.code}${i.chapterId ? `.${i.chapterId}` : ""}`,
      label: `${i.chapterLabel ? `${i.chapterLabel}: ` : ""}${i.message}`,
      count: i.count,
      severity: i.severity,
      link:
        i.area === "art"
          ? {
              to: "/projects/$projectId/storyboard",
              search: { ...(i.chapterId ? { chapterId: i.chapterId } : {}), filter: "noArt" },
            }
          : { to: "/projects/$projectId/narration", search: i.chapterId ? { chapterId: i.chapterId } : undefined },
    })),
    {
      key: "video",
      label: stage("render").note,
      count: stage("render").count,
      severity: "block",
      link: { to: "/projects/$projectId/exports" },
    },
    {
      key: "checks",
      label: `${n?.checks ?? 0} panel(s) whose artwork failed a visual check`,
      count: n?.checks ?? 0,
      severity: "block",
      link: { to: "/projects/$projectId/storyboard", search: { filter: "mismatch" } },
    },
    ...staleness.stages
      .filter((s) => s.key !== "render")
      .map((s) => ({
        key: `stale.${s.key}`,
        label: `Out of date (${s.key}): ${s.key === "story" ? s.note : `${s.count} — ${s.note}`}`,
        count: s.count,
        severity: "info" as const,
        link: { to: s.key === "story" ? "/projects/$projectId/story" : "/projects/$projectId" },
      })),
    ...publishing.map((f) => ({
      key: `publishing.${f.key}`,
      label: `${f.key === "youtube_text" ? "YouTube text" : "Thumbnail headline"} may be out of date: ${f.reasons.join("; ")}`,
      count: f.stale ? 1 : 0,
      severity: "info" as const,
      link: { to: "/projects/$projectId" },
    })),
    {
      key: "generation.active",
      label: `${(n?.active ?? 0) + (n?.audio_active ?? 0) + (n?.exports_active ?? 0)} job(s) still queued or running (generation, narration audio, exports)`,
      count: (n?.active ?? 0) + (n?.audio_active ?? 0) + (n?.exports_active ?? 0),
      severity: "info",
      link: { to: "/projects/$projectId/generation" },
    },
    {
      key: "generation.failed",
      label: `${n?.failed ?? 0} failed generation job(s) not retried`,
      count: n?.failed ?? 0,
      severity: "info",
      link: { to: "/projects/$projectId/generation" },
    },
    {
      key: "comments",
      label: `${n?.comments ?? 0} open comment thread(s)`,
      count: n?.comments ?? 0,
      severity: "info",
      link: { to: "/projects/$projectId/comments" },
    },
  ];
  const blocking = items.filter((i) => i.severity === "block" && i.count > 0).length;
  return c.json({
    verdict: { ready: blocking === 0, blocking },
    items: items.filter((i) => i.count > 0),
    spend: { usd: n?.spend ?? 0, budgetUsd: p.settings.budgetUsd ?? null },
    disk: { totalBytes: n?.disk ?? 0 },
  });
});

const KeepCurrent = z.object({ item: z.enum(["youtube_text", "thumbnail"]) });
doc({
  method: "POST",
  path: "/api/projects/:projectId/keep-current",
  summary:
    "Keep the YouTube text (item=youtube_text) or the thumbnail headline (item=thumbnail) as it is although what it was written from changed: records the current title and chapters, so it is no longer flagged. Regenerating instead is POST youtube-package, or setting settings.thumbnail.title.",
  tag: "production",
  body: KeepCurrent,
});
productionRoutes.post("/projects/:projectId/keep-current", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const { item } = await body(c, KeepCurrent);
  const { db } = c.get("deps");
  const sources =
    item === "youtube_text"
      ? { youtubeText: await youtubeSourceFingerprint(db, p), youtubeTextAt: new Date().toISOString() }
      : { thumbnailTitle: p.title };
  await db
    .update(projects)
    .set({
      settings: sql`${projects.settings} || jsonb_build_object('publishingSources',
        coalesce(${projects.settings} -> 'publishingSources', '{}'::jsonb) || ${JSON.stringify(sources)}::jsonb)`,
    })
    .where(eq(projects.id, p.id));
  return c.json({ ok: true });
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
