import { toSessionUser } from "@openmanga/auth";
import {
  and,
  audioJobs,
  chapters,
  eq,
  exportJobs,
  generationJobs,
  inArray,
  isNull,
  type ProductionStep,
  type ProductionWarnings,
  pages,
  panels,
  productionRuns,
  projects,
  providerCredentials,
  sql,
  users,
} from "@openmanga/db";
import { BATCH_CAPABLE_PROVIDERS } from "@openmanga/domain";
import {
  PIPELINE_STAGES,
  type PipelineStage,
  pipelineStaleness,
  publishingStaleness,
  revisedStory,
  staleAudioFrom,
  staleChapters,
} from "@openmanga/services";
import { Hono } from "hono";
import type { AppEnv, Deps } from "../context.ts";
import { handleError, notFound } from "./http.ts";
import { withDeps } from "./middleware.ts";

type Run = typeof productionRuns.$inferSelect;
type Project = typeof projects.$inferSelect;
type AiChoice = { credentialId: string | null; model?: string | null; manual?: boolean } | null;
export type RunOptions = {
  reviewGates: boolean;
  preparePrompts: boolean;
  render: boolean;
  youtube: boolean;
  ai?: { text?: AiChoice; image?: AiChoice };
  /**
   * "Update production": only the steps from the first out-of-date stage on, and artwork whose panel was edited after
   * it was drawn is drawn again. A revised story is re-analysed (and always reviewed before it is applied); the
   * thumbnail and YouTube text are left to a person.
   */
  update?: boolean;
};

/** Which pipeline stage a step makes; steps of no stage run only in a full production run. */
const STAGE_OF: Partial<Record<(typeof STEPS)[number], PipelineStage>> = {
  analyze: "story",
  review_analysis: "story",
  apply: "story",
  references: "story",
  review_references: "story",
  review_plans: "plan",
  plan: "plan",
  prompts: "prompts",
  art: "art",
  review_narration: "narration",
  narration: "narration",
  audio: "audio",
  review_render: "render",
  render: "render",
  youtube_package: "render",
};

/** Every step, in order. Review steps pause the run for a person; the rest call the routes a person would. */
const STEPS = [
  "analyze",
  "review_analysis",
  "apply",
  "references",
  "review_references",
  "review_plans",
  "plan",
  "prompts",
  "art",
  "review_narration",
  "narration",
  "audio",
  "thumbnail",
  "youtube_text",
  "review_render",
  "render",
  "youtube_package",
] as const;

export const STEP_LABELS: Record<(typeof STEPS)[number], string> = {
  analyze: "Analyse the story",
  review_analysis: "Review the analysis",
  apply: "Apply the analysis",
  references: "Draw references",
  review_references: "Review the references",
  review_plans: "Chapters changed since they were planned",
  plan: "Plan every chapter",
  prompts: "Prepare panel prompts",
  art: "Generate missing artwork",
  review_narration: "Narration written before its chapter changed",
  narration: "Write narration",
  audio: "Synthesize narration",
  thumbnail: "Video thumbnail",
  youtube_text: "YouTube package text",
  review_render: "Review before the final render",
  render: "Render the video",
  youtube_package: "YouTube package export",
};

/**
 * The steps of a run. An update starts at the first stale stage and runs everything after it, since each stage is
 * made from the ones before: new artwork leaves the video stale even if the video was current. The analysis review is
 * always a step: a re-analysis stops there whatever the review setting (see START.review_analysis).
 */
export function initialSteps(o: RunOptions, stale: PipelineStage[] = []): ProductionStep[] {
  const from = Math.min(...stale.map((s) => PIPELINE_STAGES.indexOf(s)), PIPELINE_STAGES.length);
  return STEPS.filter((k) => {
    if (o.update) {
      const stage = STAGE_OF[k];
      if (!stage || PIPELINE_STAGES.indexOf(stage) < from) return false;
    }
    // Decisions only a person can make: a re-analysis to apply, and plans or narration made from text that has
    // changed since (redoing them replaces pages and artwork, or the narration). Skipped when there is nothing to decide.
    if (k === "review_analysis" || k === "review_plans" || k === "review_narration") return true;
    if (k.startsWith("review_")) return o.reviewGates && (k !== "review_render" || o.render);
    if (k === "prompts") return o.preparePrompts;
    if (k === "render") return o.render;
    if (k === "youtube_text") return o.youtube;
    if (k === "youtube_package") return o.youtube && o.render;
    return true;
  }).map((key) => ({ key, status: "pending" }));
}

// ---------------------------------------------------------------- calling routes as the run's user

const routers = new WeakMap<Deps, Hono<AppEnv>>();
async function router(deps: Deps) {
  let app = routers.get(deps);
  if (app) return app;
  // Loaded lazily: app.ts imports the route that imports this file.
  const { mountApiRoutes } = await import("../app.ts");
  app = new Hono<AppEnv>();
  app.onError(handleError);
  app.notFound((c) => handleError(notFound("Route"), c));
  app.use("*", withDeps(deps), async (c, next) => {
    c.set("user", (c.env as { user: AppEnv["Variables"]["user"] }).user);
    await next();
  });
  const api = new Hono<AppEnv>();
  mountApiRoutes(api);
  app.route("/api", api);
  routers.set(deps, app);
  return app;
}

/**
 * A route refused the call; `code` is the REST error code (budget_exceeded and instance_budget_exceeded pause the
 * run instead of failing it).
 */
class CallError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function caller(deps: Deps, run: Run) {
  const [u] = await deps.db.select().from(users).where(eq(users.id, run.userId));
  if (!u || u.status === "disabled")
    throw new CallError(403, "forbidden", "The account that started this run is disabled");
  const user = toSessionUser(u);
  const app = await router(deps);
  return async <T = Record<string, unknown>>(method: "GET" | "POST", path: string, body?: unknown) => {
    const res = await app.request(
      path,
      {
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { user },
    );
    const json = (await res.json().catch(() => ({}))) as T & { error?: { code?: string; message?: string } };
    if (!res.ok)
      throw new CallError(res.status, json.error?.code ?? "http_error", json.error?.message ?? `HTTP ${res.status}`);
    return json as T;
  };
}
type Call = Awaited<ReturnType<typeof caller>>;

// ---------------------------------------------------------------- steps

type Ctx = {
  deps: Deps;
  run: Run;
  project: Project;
  call: Call;
  o: RunOptions;
  step: ProductionStep;
  batch: { text: boolean; image: boolean };
};
type Started = Pick<ProductionStep, "status" | "jobIds" | "exportJobId" | "audioBatchIds" | "note"> & { ref?: string };

/**
 * Whether the run's text and image steps go through provider batches: the project's policy asks for it, and the
 * chosen key's provider has a batch API (DeepSeek, Meta and OpenRouter do not, and a pasted answer cannot wait in
 * one), so a policy never turns into refused requests.
 */
export async function batchModes(deps: Deps, p: Project, o: RunOptions) {
  const batchable = async (choice: AiChoice | undefined) => {
    if (!choice?.credentialId || choice.manual) return false;
    const [cred] = await deps.db
      .select({ kind: providerCredentials.kind })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, choice.credentialId));
    return Boolean(cred && BATCH_CAPABLE_PROVIDERS.has(cred.kind));
  };
  const policy = p.settings.batchPolicy;
  return {
    text: (policy === "hybrid" || policy === "cheapest") && (await batchable(o.ai?.text)),
    image: (policy === "images" || policy === "cheapest") && (await batchable(o.ai?.image)),
  };
}
const text = (x: Ctx) => ({ ai: x.o.ai?.text ?? null, batch: x.batch.text });
const image = (x: Ctx) => ({ ai: x.o.ai?.image ?? null });

async function chapterRows(x: Ctx) {
  return x.deps.db
    .select({
      id: chapters.id,
      pages: sql<number>`(select count(*)::int from pages p where p.chapter_id = "chapters"."id")`,
      panels: sql<number>`(select count(*)::int from panels pn join pages p on p.id = pn.page_id where p.chapter_id = "chapters"."id")`,
      lines: sql<number>`(select count(*)::int from narration_lines nl where nl.chapter_id = "chapters"."id" and nl.language = ${x.project.language})`,
    })
    .from(chapters)
    .where(eq(chapters.projectId, x.project.id))
    .orderBy(chapters.order);
}

/** Run each call, keeping the jobs of the ones that worked and counting the ones a route refused. */
async function each<T>(items: T[], fn: (t: T) => Promise<string[]>) {
  const jobIds: string[] = [];
  let refused = 0;
  let firstError = "";
  for (const it of items) {
    try {
      jobIds.push(...(await fn(it)));
    } catch (e) {
      if (e instanceof CallError && (e.code === "budget_exceeded" || e.status === 402)) throw e;
      refused++;
      firstError ||= e instanceof Error ? e.message : String(e);
    }
  }
  return { jobIds, note: refused ? `${refused} refused: ${firstError}` : undefined };
}

const START: Record<string, (x: Ctx) => Promise<Started>> = {
  async analyze(x) {
    // A built project is analysed again only when its story was revised after the analysis it was built from.
    const built = await hasChapters(x);
    if (built && !(await revisedStory(x.deps.db, x.project.id))) return { status: "skipped", note: "Already analysed" };
    const story = await x.call<{ latest: { id: string } | null }>("GET", `/api/projects/${x.project.id}/story`);
    if (!story.latest) throw new CallError(400, "no_story", "Add a story on the Story page first");
    const r = await x.call<{ job: { id: string }; analysis: { id: string } }>(
      "POST",
      `/api/story-revisions/${story.latest.id}/analyze`,
      text(x),
    );
    return {
      status: "running",
      jobIds: [r.job.id],
      ref: r.analysis.id,
      note: built ? "The story was revised: analysing the new revision" : undefined,
    };
  },
  async review_analysis(x) {
    if (prev(x, "analyze")?.status === "skipped") return { status: "skipped" };
    // A re-analysis can restructure chapters and cast, so it always waits for the user, whatever the review setting.
    if (await hasChapters(x))
      return {
        status: "review",
        note: "The revised story's analysis is ready. Review what it would change on the Story page; apply it there (choosing anything to remove), or continue to apply it keeping every existing chapter, character, place and prop.",
      };
    if (!x.o.reviewGates) return { status: "skipped" };
    return { status: "review", note: "Check the analysis on the Story page, then continue: it is applied next." };
  },
  async apply(x) {
    const a = prev(x, "analyze");
    if (a?.status === "skipped" || !a?.ref) return { status: "skipped" };
    const { analysis } = await x.call<{ analysis: { status: string } }>("GET", `/api/story-analyses/${a.ref}`);
    if (analysis.status === "applied") return { status: "done", note: "Applied on the Story page" };
    // Additive: existing chapters keep their pages, new ones are inserted, nothing is removed.
    await x.call("POST", `/api/story-analyses/${a.ref}/apply`, {});
    return { status: "done" };
  },
  async references(x) {
    const out = await each(["character", "location", "prop"] as const, async (subject) => {
      const r = await x.call<{ jobs: { id: string }[] }>("POST", `/api/projects/${x.project.id}/generations/bulk`, {
        ...image(x),
        batch: x.batch.image,
        scope: { references: subject },
        onlyMissing: true,
        confirm: true,
      });
      return r.jobs.map((j) => j.id);
    });
    return { status: out.jobIds.length ? "running" : "done", jobIds: out.jobIds, note: out.note };
  },
  async review_references() {
    return {
      status: "review",
      note: "Approve the references you want kept (Cast and World pages); unapproved ones do not pin identity.",
    };
  },
  async review_plans(x) {
    const { plans } = await staleChapters(x.deps.db, x.project);
    if (!plans.length) return { status: "skipped" };
    return {
      status: "review",
      note: `${plans.length} chapter(s) changed after they were planned. For each, keep the current pages or re-plan it (re-planning replaces its pages and artwork); continue when done. Chapters left undecided keep their pages.`,
    };
  },
  async plan(x) {
    const todo = (await chapterRows(x)).filter((c) => c.pages === 0);
    const out = await each(todo, async (c) => {
      const r = await x.call<{ job: { id: string } }>("POST", `/api/chapters/${c.id}/plan`, text(x));
      return [r.job.id];
    });
    // Re-plans the person asked for at the review are waited for like the run's own, so nothing is drawn on pages
    // that are about to be replaced.
    out.jobIds.push(...(await inFlight(x, "chapter_plan")));
    return { status: out.jobIds.length ? "running" : "done", jobIds: out.jobIds, note: out.note };
  },
  async prompts(x) {
    // Pages with a panel still to draw and no prepared prompt.
    const todo = await x.deps.db
      .selectDistinct({ id: pages.id })
      .from(pages)
      .innerJoin(panels, eq(panels.pageId, pages.id))
      .where(and(eq(pages.projectId, x.project.id), isNull(panels.activeArtworkAssetId), isNull(panels.promptDraft)));
    const out = await each(todo, async (p) => {
      const r = await x.call<{ job: { id: string } }>("POST", `/api/pages/${p.id}/prepare-prompts`, text(x));
      return [r.job.id];
    });
    return { status: out.jobIds.length ? "running" : "done", jobIds: out.jobIds, note: out.note };
  },
  async art(x) {
    const todo = (await chapterRows(x)).filter((c) => c.panels > 0);
    const out = await each(todo, async (c) => {
      const r = await x.call<{ jobs: { id: string }[] }>("POST", `/api/projects/${x.project.id}/generations/bulk`, {
        ...image(x),
        batch: x.batch.image,
        scope: { chapterId: c.id },
        onlyMissing: true,
        confirm: true,
      });
      return r.jobs.map((j) => j.id);
    });
    // An update also redraws artwork whose panel was edited after it was drawn.
    const stale = x.o.update ? (await pipelineStaleness(x.deps.db, x.project)).staleArt : [];
    for (let i = 0; i < stale.length; i += 500) {
      const r = await x.call<{ jobs: { id: string }[] }>("POST", `/api/projects/${x.project.id}/generations/bulk`, {
        ...image(x),
        batch: x.batch.image,
        scope: { panelIds: stale.slice(i, i + 500) },
        onlyMissing: false,
        confirm: true,
      });
      out.jobIds.push(...r.jobs.map((j) => j.id));
    }
    return { status: out.jobIds.length ? "running" : "done", jobIds: out.jobIds, note: out.note };
  },
  async review_narration(x) {
    const { narration } = await staleChapters(x.deps.db, x.project);
    if (!narration.length) return { status: "skipped" };
    return {
      status: "review",
      note: `${narration.length} chapter(s) changed after their narration was written. For each, keep the narration or write it again (which replaces it); continue when done.`,
    };
  },
  async narration(x) {
    const todo = (await chapterRows(x)).filter((c) => c.panels > 0 && c.lines === 0);
    const out = await each(todo, async (c) => {
      const r = await x.call<{ job: { id: string } }>("POST", `/api/chapters/${c.id}/narration/generate`, text(x));
      return [r.job.id];
    });
    out.jobIds.push(...(await inFlight(x, "narration_text")));
    return { status: out.jobIds.length ? "running" : "done", jobIds: out.jobIds, note: out.note };
  },
  async audio(x) {
    const todo = (await chapterRows(x)).filter((c) => c.lines > 0);
    const out = await each(todo, async (c) => {
      const r = await x.call<{ batchId: string; queued: number }>(
        "POST",
        `/api/chapters/${c.id}/narration/synthesize`,
        { onlyMissing: true },
      );
      return r.queued ? [r.batchId] : [];
    });
    // Synthesis is not a generation job: the batches are kept so stopping the run can cancel what is still queued.
    return { status: "running", audioBatchIds: out.jobIds, note: out.note };
  },
  async thumbnail(x) {
    if (x.project.settings.thumbnail) return { status: "skipped", note: "Already has one" };
    const r = await x.call<{ job: { id: string } }>("POST", `/api/projects/${x.project.id}/thumbnail`, {
      ...image(x),
      title: x.project.title,
    });
    return { status: "running", jobIds: [r.job.id] };
  },
  async youtube_text(x) {
    if (x.project.settings.youtubePackage?.titles.length) return { status: "skipped", note: "Already written" };
    const r = await x.call<{ job: { id: string } }>("POST", `/api/projects/${x.project.id}/youtube-package`, text(x));
    return { status: "running", jobIds: [r.job.id] };
  },
  async review_render() {
    return { status: "review", note: "Preview the video (Pages or a chapter), then continue to render it." };
  },
  async render(x) {
    const r = await x.call<{ job: { id: string } }>("POST", `/api/projects/${x.project.id}/exports`, {
      kind: x.project.settings.format === "film" ? "video_panels" : "video_pages",
      acknowledgeIssues: true,
    });
    return { status: "running", exportJobId: r.job.id };
  },
  async youtube_package(x) {
    const render = prev(x, "render");
    if (render?.exportJobId) {
      const [e] = await x.deps.db
        .select({ status: exportJobs.status })
        .from(exportJobs)
        .where(eq(exportJobs.id, render.exportJobId));
      if (e?.status !== "completed") return { status: "skipped", note: "The video did not render" };
    }
    const r = await x.call<{ job: { id: string } }>("POST", `/api/projects/${x.project.id}/exports`, {
      kind: "youtube_package",
      acknowledgeIssues: true,
    });
    return { status: "running", exportJobId: r.job.id };
  },
};

/** The project's jobs of this kind still in flight (e.g. a re-plan the person started at a review). */
async function inFlight(x: Ctx, kind: "chapter_plan" | "narration_text") {
  const rows = await x.deps.db
    .select({ id: generationJobs.id })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.projectId, x.project.id),
        eq(generationJobs.kind, kind),
        inArray(generationJobs.status, ["queued", "submitted", "processing", "paused", "awaiting_input"]),
      ),
    );
  return rows.map((r) => r.id);
}

async function hasChapters(x: Ctx) {
  const [n] = await x.deps.db
    .select({ c: sql<number>`count(*)::int` })
    .from(chapters)
    .where(eq(chapters.projectId, x.project.id));
  return (n?.c ?? 0) > 0;
}

function prev(x: Ctx, key: string) {
  return x.run.steps.find((s) => s.key === key) as (ProductionStep & { ref?: string }) | undefined;
}

const FINAL = ["completed", "failed", "cancelled"];

/** Whether the step's work is finished: "running" to keep waiting, "done", or a failure message. */
async function check(x: Ctx): Promise<"running" | "done" | { failed: string }> {
  const s = x.step;
  if (s.key === "audio") {
    const [r] = await x.deps.db.execute<{ busy: number }>(sql`
      select count(*)::int as busy from audio_jobs aj
      join narration_segments ns on ns.id = aj.segment_id
      join narration_lines nl on nl.id = ns.narration_line_id
      where nl.project_id = ${x.project.id} and aj.status in ('queued', 'processing')`);
    if ((r?.busy ?? 0) > 0) return "running";
    // Idle is not the same as voiced: check every segment has current audio, by the audio stage's own definition.
    const since = s.startedAt ?? new Date(0).toISOString();
    const stale = await x.deps.db.execute<{ id: string; chapter_id: string; tried: boolean; failed: boolean }>(sql`
      select s.id, nl.chapter_id,
        exists (select 1 from audio_jobs j where j.segment_id = s.id and j.created_at >= ${since}) as tried,
        (select j.status from audio_jobs j where j.segment_id = s.id order by j.created_at desc limit 1) = 'failed'
          as failed
      ${staleAudioFrom(x.project)}`);
    if (!stale.length) return "done";
    // Segments this step never queued (a chapter's request was refused or capped) are queued once more; failures
    // are not retried here, or a segment the voice provider always refuses would loop the run forever.
    const untried = stale.filter((r) => !r.tried);
    if (untried.length && !s.requeued) {
      s.requeued = true;
      const byChapter = new Map<string, string[]>();
      for (const r of untried) byChapter.set(r.chapter_id, [...(byChapter.get(r.chapter_id) ?? []), r.id]);
      for (const [chapterId, segmentIds] of byChapter) {
        const q = await x.call<{ batchId: string; queued: number }>(
          "POST",
          `/api/chapters/${chapterId}/narration/synthesize`,
          { onlyMissing: true, segmentIds },
        );
        if (q.queued) s.audioBatchIds = [...(s.audioBatchIds ?? []), q.batchId];
      }
      return "running";
    }
    // Left for the person: listed in the run's warnings at the end, and here on the step.
    const failed = stale.filter((r) => r.failed).length;
    s.note = `${stale.length} segment(s) without current audio${failed ? `, ${failed} failed` : ""}; see Narration`;
    return "done";
  }
  if (s.exportJobId) {
    const [e] = await x.deps.db
      .select({ status: exportJobs.status, reason: exportJobs.failureReason })
      .from(exportJobs)
      .where(eq(exportJobs.id, s.exportJobId));
    if (!e || !FINAL.includes(e.status)) return "running";
    // The exports come last and nothing else stands on them: a failure is noted, listed in the run's warnings, and
    // can be rendered again from the run card.
    if (e.status !== "completed") s.note = `Export ${e.status}: ${e.reason ?? "no reason given"}`;
    return "done";
  }
  if (!s.jobIds?.length) return "done";
  const jobs = await x.deps.db
    .select({ status: generationJobs.status, reason: generationJobs.failureReason })
    .from(generationJobs)
    .where(inArray(generationJobs.id, s.jobIds));
  if (jobs.some((j) => !FINAL.includes(j.status))) return "running";
  const failed = jobs.filter((j) => j.status !== "completed");
  // Analysis and planning are what everything after them stands on; elsewhere a few failures are noted and left
  // for the person (they show on the storyboard and in Generation) while the run carries on.
  if (failed.length && (s.key === "analyze" || failed.length === jobs.length))
    return { failed: failed[0]!.reason ?? "The job failed" };
  if (failed.length) s.note = `${failed.length} of ${jobs.length} failed; see Generation`;
  return "done";
}

/** After references are drawn, and no review was asked for: approve the newest draft of each subject lacking one. */
async function approveDrafts(x: Ctx) {
  const rows = await x.deps.db.execute<{ id: string }>(sql`
    select distinct on (coalesce(r.character_version_id, r.location_version_id, r.prop_version_id)) r.id
    from reference_assets r
    where r.project_id = ${x.project.id} and r.status = 'draft'
      and not exists (
        select 1 from reference_assets a
        where a.status in ('approved', 'locked')
          and coalesce(a.character_version_id, a.location_version_id, a.prop_version_id)
            = coalesce(r.character_version_id, r.location_version_id, r.prop_version_id))
    order by coalesce(r.character_version_id, r.location_version_id, r.prop_version_id), r.created_at desc`);
  for (const r of rows) await x.call("POST", `/api/references/${r.id}/status`, { status: "approved" }).catch(() => {});
}

/**
 * What a run that reached the end left unresolved, or null when nothing is: its failed jobs nobody retried, its failed
 * exports, and the project's panels without artwork, segments without current audio and panels flagged for review.
 */
export async function runWarnings(deps: Deps, run: Run): Promise<ProductionWarnings | null> {
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, run.projectId));
  if (!project) return null;
  const stepOf = new Map(run.steps.flatMap((s) => (s.jobIds ?? []).map((id) => [id, s.key] as const)));
  const failed = stepOf.size
    ? await deps.db
        .select({ id: generationJobs.id, kind: generationJobs.kind, reason: generationJobs.failureReason })
        .from(generationJobs)
        .where(
          and(
            inArray(generationJobs.id, [...stepOf.keys()]),
            eq(generationJobs.status, "failed"),
            isNull(generationJobs.retriedByJobId),
          ),
        )
    : [];
  const exportIds = run.steps.flatMap((s) => (s.exportJobId ? [s.exportJobId] : []));
  const failedExports = exportIds.length
    ? await deps.db
        .select({ id: exportJobs.id, kind: exportJobs.kind, reason: exportJobs.failureReason })
        .from(exportJobs)
        .where(and(inArray(exportJobs.id, exportIds), inArray(exportJobs.status, ["failed", "cancelled"])))
    : [];
  const [counts] = await deps.db.execute<{ no_art: number; review: number; audio: number }>(sql`
    select
      (select count(*)::int from panels pn where pn.project_id = ${project.id} and pn.active_artwork_asset_id is null)
        as no_art,
      (select count(*)::int from panels pn where pn.project_id = ${project.id} and pn.review is not null) as review,
      (select count(*)::int ${staleAudioFrom(project)}) as audio`);
  const w: ProductionWarnings = {
    failedJobs: failed.slice(0, 500).map((j) => ({ ...j, step: stepOf.get(j.id)! })),
    failedJobCount: failed.length,
    panelsWithoutArt: counts?.no_art ?? 0,
    segmentsWithoutAudio: counts?.audio ?? 0,
    panelsNeedingReview: counts?.review ?? 0,
    failedExports,
  };
  const any =
    w.failedJobCount + w.panelsWithoutArt + w.segmentsWithoutAudio + w.panelsNeedingReview + w.failedExports.length;
  return any ? w : null;
}

/**
 * An update leaves the YouTube text and the thumbnail headline to a person; when what they were written from changed,
 * its end says so (the run card offers Regenerate and Keep current).
 */
async function publishingNote(deps: Deps, run: Run) {
  if (!(run.options as RunOptions).update) return null;
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, run.projectId));
  if (!project) return null;
  const stale = (await publishingStaleness(deps.db, project)).filter((p) => p.stale);
  if (!stale.length) return null;
  return stale
    .map((p) =>
      p.key === "youtube_text" ? "YouTube text may be out of date" : "thumbnail headline may be out of date",
    )
    .join("; ")
    .replace(/^./, (ch) => ch.toUpperCase());
}

// ---------------------------------------------------------------- advancing

/** This process; every advance adds its own suffix, so two advances in one process exclude each other too. */
const PROCESS_ID = `${process.env.HOSTNAME ?? "api"}:${process.pid}:${crypto.randomUUID().slice(0, 8)}`;
const LEASE = sql`now() + interval '2 minutes'`;

/** The advance lost its lease (it expired and another process took the run) or the run stopped under it. */
class LeaseLost extends Error {}

/**
 * Move a run forward as far as it can go now: finish waiting steps, start the next, stop at a review or a wait.
 * Only the holder of the row's lease advances it, so API replicas (or a timer tick and a Continue click) never start
 * the same step twice; the lease is extended while the advance works and released when it returns. `owner` is for
 * tests that play two processes.
 */
export async function advanceRun(deps: Deps, runId: string, owner = `${PROCESS_ID}:${crypto.randomUUID()}`) {
  const claimed = await deps.db.execute(sql`
    update production_runs set lease_owner = ${owner}, lease_until = ${LEASE}
    where id = ${runId} and status = 'running'
      and (lease_until is null or lease_until < now() or lease_owner = ${owner})
    returning id`);
  if (!claimed.length) return;
  // A step that calls many routes (planning 30 chapters) can outlast the lease; keep it alive while working.
  const heartbeat = setInterval(
    () =>
      void deps.db
        .update(productionRuns)
        .set({ leaseUntil: LEASE })
        .where(and(eq(productionRuns.id, runId), eq(productionRuns.leaseOwner, owner)))
        .catch(() => {}),
    30_000,
  );
  try {
    const [run] = await deps.db.select().from(productionRuns).where(eq(productionRuns.id, runId));
    if (run?.status !== "running") return;
    const save = async (patch: Partial<Run>) => {
      Object.assign(run, patch);
      // Only while this advance still holds the lease and the run is still running: a run stopped meanwhile stays
      // stopped, and nothing done here after that is kept.
      const saved = await deps.db
        .update(productionRuns)
        .set({ ...patch, steps: run.steps, updatedAt: new Date(), leaseUntil: LEASE })
        .where(
          and(
            eq(productionRuns.id, run.id),
            eq(productionRuns.leaseOwner, owner),
            eq(productionRuns.status, "running"),
          ),
        )
        .returning({ id: productionRuns.id });
      if (!saved.length) throw new LeaseLost();
      await deps.events.publish(run.projectId, { type: "production.updated", runId: run.id, status: run.status });
    };
    let call: Call;
    try {
      call = await caller(deps, run);
    } catch (e) {
      await save({ status: "paused", reason: e instanceof Error ? e.message : String(e) });
      return;
    }
    for (let guard = 0; guard < STEPS.length * 2; guard++) {
      const step = run.steps.find((s) => s.status !== "done" && s.status !== "skipped");
      if (!step) {
        const warnings = await runWarnings(deps, run);
        await save(
          warnings
            ? { status: "completed_with_warnings", reason: await publishingNote(deps, run), warnings }
            : { status: "completed", reason: await publishingNote(deps, run), warnings: null },
        );
        return;
      }
      const [project] = await deps.db.select().from(projects).where(eq(projects.id, run.projectId));
      if (!project || project.deletedAt) {
        await save({ status: "cancelled", reason: "The project was removed" });
        return;
      }
      const o = run.options as RunOptions;
      const x: Ctx = { deps, run, project, call, o, step, batch: await batchModes(deps, project, o) };
      try {
        if (step.status === "review") {
          await save({ status: "waiting", reason: step.note ?? null });
          return;
        }
        if (step.status === "pending") {
          const started = await START[step.key]!(x);
          Object.assign(step, started, { startedAt: new Date().toISOString() });
          if (started.status === "done" || started.status === "skipped") step.finishedAt = new Date().toISOString();
          await save({});
          continue;
        }
        const before = JSON.stringify(step);
        const r = await check(x);
        if (r === "running") {
          // Waiting can still change the step (the audio step queuing what it missed); keep that.
          if (JSON.stringify(step) !== before) await save({});
          return;
        }
        if (typeof r === "object") {
          step.status = "failed";
          step.note = r.failed;
          await save({ status: "failed", reason: `${STEP_LABELS[step.key as keyof typeof STEP_LABELS]}: ${r.failed}` });
          return;
        }
        if (step.key === "references" && !x.o.reviewGates) await approveDrafts(x);
        step.status = "done";
        step.finishedAt = new Date().toISOString();
        await save({});
      } catch (e) {
        if (e instanceof LeaseLost) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        // Spending stops at the project's cap: pause, so raising the cap and continuing picks up right here.
        if (e instanceof CallError && (e.code === "budget_exceeded" || e.status === 402)) {
          const which = e.code === "instance_budget_exceeded" ? "Server budget ceiling reached" : "Budget cap reached";
          await save({ status: "paused", reason: `${which}: ${msg}` });
          return;
        }
        step.status = "failed";
        step.note = msg;
        await save({ status: "failed", reason: `${STEP_LABELS[step.key as keyof typeof STEP_LABELS]}: ${msg}` });
        return;
      }
    }
  } catch (e) {
    if (!(e instanceof LeaseLost)) throw e;
  } finally {
    clearInterval(heartbeat);
    await deps.db
      .update(productionRuns)
      .set({ leaseOwner: null, leaseUntil: null })
      .where(and(eq(productionRuns.id, runId), eq(productionRuns.leaseOwner, owner)));
  }
}

/**
 * What a run started that is still waiting to be worked on: generation jobs not yet taken by a worker (queued, waiting
 * in a provider batch, paused at the budget or waiting for a pasted answer), queued narration audio, and its export
 * if it has not finished. Work already running at a provider is left to finish: it is paid for, and a stopped run
 * acts on nothing it returns.
 */
export async function pendingWork(deps: Deps, run: Run) {
  const jobIds = run.steps.flatMap((s) => s.jobIds ?? []);
  const batchIds = run.steps.flatMap((s) => s.audioBatchIds ?? []);
  const exportIds = run.steps.flatMap((s) => (s.exportJobId ? [s.exportJobId] : []));
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
  return {
    generation: jobIds.length
      ? ids(
          await deps.db
            .select({ id: generationJobs.id })
            .from(generationJobs)
            .where(
              and(
                inArray(generationJobs.id, jobIds),
                inArray(generationJobs.status, ["queued", "submitted", "paused", "awaiting_input"]),
              ),
            ),
        )
      : [],
    audio: batchIds.length
      ? ids(
          await deps.db
            .select({ id: audioJobs.id })
            .from(audioJobs)
            .where(and(inArray(audioJobs.batchId, batchIds), eq(audioJobs.status, "queued"))),
        )
      : [],
    exports: exportIds.length
      ? ids(
          await deps.db
            .select({ id: exportJobs.id })
            .from(exportJobs)
            .where(and(inArray(exportJobs.id, exportIds), inArray(exportJobs.status, ["queued", "processing"]))),
        )
      : [],
  };
}

/** Cancel what `pendingWork` lists, through the same cancel paths as Generation, Narration and Exports. */
export async function cancelRunWork(deps: Deps, run: Run) {
  const work = await pendingWork(deps, run);
  let cancelled = 0;
  for (const id of work.generation) if ((await deps.jobs.cancelGeneration(id)) !== "not_cancellable") cancelled++;
  for (const id of work.audio) if ((await deps.jobs.cancelAudio(id)) === "cancelled") cancelled++;
  for (const id of work.exports) if ((await deps.jobs.cancelExport(id)) !== "not_cancellable") cancelled++;
  return cancelled;
}

/** Advance every running run; called on a timer by the API process. */
export async function tickProductionRuns(deps: Deps) {
  const rows = await deps.db
    .select({ id: productionRuns.id })
    .from(productionRuns)
    .where(eq(productionRuns.status, "running"));
  for (const r of rows)
    await advanceRun(deps, r.id).catch((e) =>
      deps.logger.error("production run failed to advance", { runId: r.id, error: String(e) }),
    );
}
