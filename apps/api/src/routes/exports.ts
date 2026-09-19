import {
  and,
  assets,
  audioJobs,
  chapters,
  desc,
  eq,
  exportJobs,
  exportsTable,
  generationJobs,
  inArray,
  pages,
  sql,
} from "@openmanga/db";
import { providerSupports } from "@openmanga/domain";
import { issuesForExport, projectReadiness, recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { ApiError, badRequest, body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

export const exportRoutes = new Hono<AppEnv>();

export const ExportOptions = z.object({
  kind: z.enum([
    "png_pages",
    "jpg_pages",
    "pdf",
    "webtoon",
    "zip_package",
    "project_json",
    "narration_audio",
    "timeline",
    "agent_package",
    "video_pages",
    "video_panels",
  ]),
  chapterId: z.string().uuid().nullable().default(null),
  pageIds: z.array(z.string().uuid()).max(500).optional(),
  scale: z.number().min(0.25).max(3).default(1),
  jpgQuality: z.number().int().min(40).max(100).default(90),
  pdf: z
    .object({
      pageSize: z.enum(["source", "A4", "A5", "B5", "letter", "tankobon"]).default("source"),
      marginMm: z.number().min(0).max(50).default(0),
      bleedMm: z.number().min(0).max(10).default(0),
      dpi: z.number().int().min(72).max(600).default(300),
      readingDirection: z.enum(["ltr", "rtl", "vertical"]).optional(),
    })
    .default({ pageSize: "source", marginMm: 0, bleedMm: 0, dpi: 300 }),
  webtoon: z
    .object({
      width: z.number().int().min(320).max(2000).optional(),
      gap: z.number().int().min(0).max(1000).optional(),
      split: z.boolean().default(true),
      maxChunkHeight: z.number().int().min(1000).max(40_000).optional(),
      format: z.enum(["png", "jpg"]).default("jpg"),
    })
    .default({ split: true, format: "jpg" }),
  audio: z
    .object({ format: z.enum(["wav", "mp3", "ogg"]).default("mp3"), normalize: z.boolean().default(true) })
    .default({ format: "mp3", normalize: true }),
  includeAssets: z.boolean().default(true),
  video: z
    .object({
      height: z.union([z.literal(720), z.literal(1080), z.literal(1440)]).default(1080),
      fps: z.number().int().min(12).max(60).default(30),
      minHoldMs: z.number().int().min(500).max(30_000).default(2500),
      framing: z.enum(["width", "height"]).default("width"),
      pageWidthRatio: z.number().min(0.3).max(1).default(0.6),
      pageHeightRatio: z.number().min(0.5).max(1).default(0.96),
      maxScrollPxPerSec: z.number().min(10).max(400).default(60),
      /** Panel cut: Ken Burns travel over each hold, 0.06 = 6%. */
      zoom: z.number().min(0).max(0.2).default(0.06),
      /** Silence after each shot's narration before the cut. */
      breathMs: z.number().int().min(0).max(2000).default(150),
    })
    .default({
      height: 1080,
      fps: 30,
      minHoldMs: 2500,
      framing: "width",
      pageWidthRatio: 0.6,
      pageHeightRatio: 0.96,
      maxScrollPxPerSec: 60,
      zoom: 0.06,
      breathMs: 150,
    }),
  /** Narration track language for narration/timeline/agent/video exports (default: project language). */
  language: z.string().trim().min(2).max(16).optional(),
  /** Export even though the readiness check found problems (the issues are recorded in the package). */
  acknowledgeIssues: z.boolean().default(false),
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/exports",
  summary:
    "Queue an export JOB (deterministic composition, no AI calls). Returns 202 { job } — the job, not a file: poll GET /api/jobs/:id (or list GET /api/projects/:projectId/exports) until status is completed, then download its files.",
  tag: "exports",
  body: ExportOptions,
});
exportRoutes.post("/projects/:projectId/exports", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const input = await body(c, ExportOptions);
  if (
    ["png_pages", "jpg_pages", "pdf", "webtoon", "narration_audio", "timeline"].includes(input.kind) &&
    !input.chapterId &&
    !input.pageIds?.length
  ) {
    throw badRequest("Choose a chapter (or pages) to export");
  }
  if (input.chapterId) await entityAccess(c, "chapter", input.chapterId, "read");
  const deps = c.get("deps");
  // Page ids come from the body, so they are checked here as well: without this an export could render pages
  // belonging to someone else's project and store the result as the caller's own file.
  if (input.pageIds?.length) {
    const own = await deps.db
      .select({ id: pages.id })
      .from(pages)
      .where(and(eq(pages.projectId, p.id), inArray(pages.id, input.pageIds)));
    if (own.length !== new Set(input.pageIds).size) throw notFound("Page");
  }
  const active = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(exportJobs)
    .where(and(eq(exportJobs.projectId, p.id), inArray(exportJobs.status, ["queued", "processing"])));
  if ((active[0]?.n ?? 0) >= 5) throw conflict("Too many exports in progress for this project");
  const readiness = await projectReadiness(deps.db, p.id, { chapterId: input.chapterId, language: input.language });
  const issues = issuesForExport(readiness, input.kind);
  if (issues.some((i) => i.severity === "block") && !input.acknowledgeIssues)
    throw new ApiError(409, "export_not_ready", `This export has ${issues.length} readiness issue(s)`, {
      issues,
      language: readiness.language,
    });
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createExportJob(tx, {
      projectId: p.id,
      userId: user(c).id,
      kind: input.kind,
      chapterId: input.chapterId,
      options: input,
    }),
  );
  await deps.jobs.kick();
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "export.create",
    targetId: job.id,
    metadata: { kind: input.kind },
    requestId: c.get("requestId"),
  });
  return c.json({ job }, 202);
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/exports",
  summary: "Export jobs and downloadable files",
  tag: "exports",
});
exportRoutes.get("/projects/:projectId/exports", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const jobs = await db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.projectId, p.id))
    .orderBy(desc(exportJobs.createdAt))
    .limit(100);
  const files = jobs.length
    ? await db
        .select({ e: exportsTable, byteSize: assets.byteSize, mimeType: assets.mimeType })
        .from(exportsTable)
        .innerJoin(assets, eq(assets.id, exportsTable.assetId))
        .where(
          inArray(
            exportsTable.exportJobId,
            jobs.map((j) => j.id),
          ),
        )
    : [];
  // Which chapter an export covers is otherwise invisible in the history: every video of a project looks alike.
  const chapterIds = [...new Set(jobs.map((j) => j.chapterId).filter((x): x is string => Boolean(x)))];
  const chapterRows = chapterIds.length
    ? await db
        .select({ id: chapters.id, title: chapters.title, order: chapters.order })
        .from(chapters)
        .where(inArray(chapters.id, chapterIds))
    : [];
  return c.json({
    jobs: jobs.map((j) => ({
      ...j,
      chapter: chapterRows.find((ch) => ch.id === j.chapterId) ?? null,
      files: files
        .filter((f) => f.e.exportJobId === j.id)
        .map((f) => ({ ...f.e, byteSize: f.byteSize, mimeType: f.mimeType })),
    })),
  });
});

doc({
  method: "GET",
  path: "/api/jobs/:id",
  summary:
    "Poll any job you can read by id: generation (image/text), narration audio, or export/import. Returns { type, job } plus files for completed exports.",
  tag: "jobs",
});
exportRoutes.get("/jobs/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [gen] = await db.select().from(generationJobs).where(eq(generationJobs.id, id));
  if (gen) {
    await projectAccess(c, gen.projectId, "read");
    return c.json({ type: "generation", job: gen });
  }
  const [audio] = await db.select().from(audioJobs).where(eq(audioJobs.id, id));
  if (audio) {
    await projectAccess(c, audio.projectId, "read");
    return c.json({ type: "audio", job: audio });
  }
  const [exp] = await db.select().from(exportJobs).where(eq(exportJobs.id, id));
  if (!exp) throw notFound("Job");
  await projectAccess(c, exp.projectId, "read");
  const files = await db
    .select({ e: exportsTable, byteSize: assets.byteSize, mimeType: assets.mimeType })
    .from(exportsTable)
    .innerJoin(assets, eq(assets.id, exportsTable.assetId))
    .where(eq(exportsTable.exportJobId, id));
  return c.json({
    type: exp.kind === "project_import" ? "import" : "export",
    job: { ...exp, files: files.map((f) => ({ ...f.e, byteSize: f.byteSize, mimeType: f.mimeType })) },
  });
});

doc({ method: "POST", path: "/api/exports/:id/cancel", summary: "Cancel a queued export", tag: "exports" });
exportRoutes.post("/exports/:id/cancel", async (c) => {
  const id = uuidParam(c, "id");
  const deps = c.get("deps");
  const [job] = await deps.db.select().from(exportJobs).where(eq(exportJobs.id, id));
  if (!job) throw notFound("Export");
  await projectAccess(c, job.projectId, "read");
  if (job.status === "queued") {
    await deps.queue.removeWaiting("export", job.id);
    await deps.db.update(exportJobs).set({ status: "cancelled", finishedAt: new Date() }).where(eq(exportJobs.id, id));
    return c.json({ result: "cancelled" });
  }
  if (job.status === "processing") {
    await deps.db.update(exportJobs).set({ status: "cancel_requested" }).where(eq(exportJobs.id, id));
    return c.json({ result: "cancel_requested" });
  }
  throw conflict(`Export is already ${job.status}`);
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/readiness",
  summary:
    "Export readiness: missing artwork, narration coverage/audio, superseded or draft versions, and whether the caller has a usable provider key for further generation (?chapterId=&language=)",
  tag: "exports",
});
exportRoutes.get("/projects/:projectId/readiness", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, z.object({ chapterId: z.string().uuid().optional(), language: z.string().max(16).optional() }));
  if (q.chapterId) await entityAccess(c, "chapter", q.chapterId, "read");
  const deps = c.get("deps");
  const creds = await deps.credentials.list(user(c).id);
  const usable = (cap: "text" | "image") => creds.some((x) => providerSupports(x.kind, cap));
  return c.json({
    ...(await projectReadiness(deps.db, p.id, q)),
    // BYOK: exports need no key, but anything still to generate does — surface it with the other gaps.
    credentials: {
      text: Boolean(deps.providers.text) || usable("text"),
      image: Boolean(deps.providers.image) || usable("image"),
      mockMode: deps.config.AI_MOCK_MODE,
    },
  });
});
