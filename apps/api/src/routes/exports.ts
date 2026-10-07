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
  panels,
  sql,
} from "@openmanga/db";
import { captionsSupported, providerSupports, SHORTS_DEFAULT_MS, shortsLengthWarning } from "@openmanga/domain";
import { ShortsCaptions } from "@openmanga/schemas";
import {
  issuesForExport,
  printCoverCheck,
  projectReadiness,
  recordAudit,
  sweepRenderSections,
} from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, jobAccess, projectAccess } from "../lib/access.ts";
import { ApiError, badRequest, body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { shortsCandidates } from "./video.ts";

export const exportRoutes = new Hono<AppEnv>();

const PageSize = z.enum([
  "source",
  "A4",
  "A5",
  "B5",
  "letter",
  "tankobon",
  "kdp_5x8",
  "kdp_5_5x8_5",
  "kdp_6x9",
  "kdp_7x10",
  "kdp_8_5x11",
]);

export const ExportOptions = z.object({
  kind: z.enum([
    "png_pages",
    "jpg_pages",
    "pdf",
    "cbz",
    "epub",
    "webtoon",
    "zip_package",
    "project_json",
    "narration_audio",
    "timeline",
    "agent_package",
    "video_pages",
    "video_panels",
    "video_shorts",
    "youtube_package",
    "carousel",
    "quote_image",
    "print_cover",
    "print_preflight",
  ]),
  chapterId: z.string().uuid().nullable().default(null),
  pageIds: z.array(z.string().uuid()).max(500).optional(),
  /**
   * video_shorts, carousel, quote_image: the picked panels (see GET /api/projects/:projectId/shorts and .../repurpose),
   * in story order. A quote image uses the first.
   */
  panelIds: z.array(z.string().uuid()).min(1).max(100).optional(),
  /** A name for this cut or set ("Trailer", "Short 2"), used in the file names. */
  label: z.string().trim().max(60).optional(),
  /** Social copy shipped next to the file as caption.txt. */
  social: z.object({ title: z.string().max(150).default(""), caption: z.string().max(2200).default("") }).optional(),
  /** carousel and quote_image: the image shape (1080×1080 or 1080×1350), and the quote image's line. */
  still: z
    .object({ aspect: z.enum(["1:1", "4:5"]).default("4:5"), text: z.string().trim().max(300).default("") })
    .default({ aspect: "4:5", text: "" }),
  scale: z.number().min(0.25).max(3).default(1),
  jpgQuality: z.number().int().min(40).max(100).default(90),
  pdf: z
    .object({
      /** kdp_* are Amazon KDP trim sizes, printed full bleed (margin and bleed are then ignored). */
      pageSize: PageSize.default("source"),
      marginMm: z.number().min(0).max(50).default(0),
      bleedMm: z.number().min(0).max(10).default(0),
      dpi: z.number().int().min(72).max(600).default(300),
      readingDirection: z.enum(["ltr", "rtl", "vertical"]).optional(),
      /** Every chapter opens on a right-hand (odd) page: a blank page goes before any that would open on a left one. */
      rectoChapters: z.boolean().default(false),
      /** A contents page after the cover: each chapter with the PDF page it starts on. */
      toc: z.boolean().default(false),
      /** Book metadata written into the PDF. Defaults: the export's title, the project's author, description, language. */
      metadata: z
        .object({
          title: z.string().trim().max(300).optional(),
          author: z.string().trim().max(200).optional(),
          subject: z.string().trim().max(2000).optional(),
          keywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
          language: z.string().trim().min(2).max(16).optional(),
        })
        .optional(),
    })
    .default({ pageSize: "source", marginMm: 0, bleedMm: 0, dpi: 300, rectoChapters: false, toc: false }),
  /**
   * print_cover: the paper decides the spine (KDP's per-page thickness: white 0.002252", cream 0.0025", color
   * 0.002347"), or give paperThicknessMm for another printer. The page count defaults to the interior's, counted as
   * the PDF export prints it with the same pdf.toc and pdf.rectoChapters.
   */
  print: z
    .object({
      paper: z.enum(["white", "cream", "color"]).default("white"),
      pageCount: z.number().int().min(1).max(2000).optional(),
      paperThicknessMm: z.number().min(0.03).max(0.3).optional(),
    })
    .default({ paper: "white" }),
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
      /** The frame's short side. Default: the project's video output setting, else 1080. */
      height: z.union([z.literal(720), z.literal(1080), z.literal(1440)]).optional(),
      fps: z.number().int().min(12).max(60).default(30),
      minHoldMs: z.number().int().min(500).max(30_000).default(2500),
      /** "scroll": 3/5 width, travelling the whole page top to bottom over its hold (the continuous scroll cut). */
      framing: z.enum(["width", "height", "scroll"]).default("width"),
      /** Page cut share of the frame width; default 0.6 landscape, 1 vertical or square. */
      pageWidthRatio: z.number().min(0.3).max(1).optional(),
      pageHeightRatio: z.number().min(0.5).max(1).default(0.96),
      maxScrollPxPerSec: z.number().min(10).max(400).default(60),
      /** Panel cut: Ken Burns travel over each hold, 0.06 = 6%. */
      zoom: z.number().min(0).max(0.2).default(0.06),
      /** Silence after each shot's narration before the cut. */
      breathMs: z.number().int().min(0).max(2000).default(150),
      /** A partial render for checking: stop after the shot that reaches this length (whole shots only). */
      maxDurationMs: z.number().int().min(10_000).max(86_400_000).optional(),
      /**
       * Frame shape: landscape, vertical (Shorts, Reels) or square. Default: the project's video output setting, else
       * 16:9; video_shorts always defaults to 9:16.
       */
      aspect: z.enum(["16:9", "9:16", "1:1"]).optional(),
      /**
       * video_shorts: the cut's length in seconds (default 180, YouTube's Shorts limit; up to 600). The film ends before
       * the shot that would pass it. Over 180 the response carries a warning: YouTube uploads it as a regular video.
       */
      shortsSeconds: z.number().int().min(15).max(600).optional(),
      /**
       * video_shorts: captions drawn into the picture from the narration (off by default). "bottom" a clean line low in
       * the frame, "center" a few large words at a time, "two_line" two lines at the bottom. Other videos keep the .srt.
       */
      captions: ShortsCaptions.optional(),
    })
    .default({
      fps: 30,
      minHoldMs: 2500,
      framing: "width",
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
  // Viewers download what exists; making a new export queues server work every member then sees, so it is an edit.
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, ExportOptions);
  const captions = input.kind === "video_shorts" ? input.video.captions : undefined;
  if (captions && captions !== "off" && !captionsSupported(input.language || p.language))
    throw badRequest(
      "Captions can't be drawn in this narration language yet: the render image has no font for its script. Turn captions off; the .srt file still comes with the video.",
    );
  // Filled here, so the stored options say what was rendered whoever asked: the app, an agent or a production run.
  const output = p.settings.video?.output;
  input.video.height ??= output?.height ?? 1080;
  if (input.kind !== "video_shorts") input.video.aspect ??= output?.aspect;
  if (
    // Narration and its timeline are built per chapter; every page-based kind streams, so it can take the project.
    ["narration_audio", "timeline"].includes(input.kind) &&
    !input.chapterId &&
    !input.pageIds?.length
  ) {
    throw badRequest("Choose a chapter (or pages) to export");
  }
  if (input.chapterId && (await entityAccess(c, "chapter", input.chapterId, "read")).id !== p.id)
    throw notFound("Chapter");
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
  if (input.kind === "quote_image" && !input.still.text) throw badRequest("Write the quote (still.text)");
  if (input.kind === "print_cover") {
    const check = await printCoverCheck(deps.db, p, input, { ...input.pdf, print: input.print });
    if (!check) throw badRequest("Choose a print size for the cover (pdf.pageSize other than source)");
    const block = check.layout.issues.find((i) => i.severity === "block");
    if (block) throw badRequest(block.message);
  }
  if (["video_shorts", "carousel", "quote_image"].includes(input.kind)) {
    if (!input.panelIds?.length) throw badRequest("Pick the panels (panelIds)");
    const own = await deps.db
      .select({ id: panels.id })
      .from(panels)
      .where(and(eq(panels.projectId, p.id), inArray(panels.id, input.panelIds)));
    if (own.length !== new Set(input.panelIds).size) throw notFound("Panel");
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
  // A long Shorts cut is allowed, but YouTube will not take it as a Short: say so where the request was made. The film
  // is the picked shots up to the chosen length.
  let warning: string | null = null;
  if (input.kind === "video_shorts") {
    const picked = new Set(input.panelIds);
    const shots = await shortsCandidates(
      deps.db,
      p,
      { panelIds: input.panelIds },
      input.language || p.language,
      input.video.minHoldMs,
    );
    const pickMs = shots.filter((s) => picked.has(s.id)).reduce((n, s) => n + s.holdMs, 0);
    warning = shortsLengthWarning(Math.min(pickMs, (input.video.shortsSeconds ?? SHORTS_DEFAULT_MS / 1000) * 1000));
  }
  return c.json({ job, ...(warning ? { warnings: [warning] } : {}) }, 202);
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
    await jobAccess(c, gen, "read");
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
  await projectAccess(c, job.projectId, "write");
  const result = await deps.jobs.cancelExport(id);
  if (result === "not_cancellable") throw conflict(`Export is already ${job.status}`);
  return c.json({ result });
});

export const CoverCheckQuery = z.object({
  pageSize: PageSize.exclude(["source"]).default("kdp_6x9"),
  paper: z.enum(["white", "cream", "color"]).default("white"),
  pageCount: z.coerce.number().int().min(1).max(2000).optional(),
  paperThicknessMm: z.coerce.number().min(0.03).max(0.3).optional(),
  chapterId: z.string().uuid().optional(),
  toc: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
  rectoChapters: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true"),
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/print/cover",
  query: CoverCheckQuery,
  summary:
    "Check a print cover before rendering it: the interior's page count (as the PDF prints it with ?toc= and ?rectoChapters=, or ?pageCount=), the spine width for ?paper=, the full cover size with bleed, the safe areas and barcode box, the text layout, and issues (no cover art, art under 300 DPI, no spine text under 79 pages, text that had to be shortened). ?pageSize= is a print size (default kdp_6x9).",
  tag: "exports",
});
exportRoutes.get("/projects/:projectId/print/cover", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, CoverCheckQuery);
  if (q.chapterId && (await entityAccess(c, "chapter", q.chapterId, "read")).id !== p.id) throw notFound("Chapter");
  const check = await printCoverCheck(
    c.get("deps").db,
    p,
    { chapterId: q.chapterId ?? null },
    {
      pageSize: q.pageSize,
      toc: q.toc,
      rectoChapters: q.rectoChapters,
      print: { paper: q.paper, pageCount: q.pageCount, paperThicknessMm: q.paperThicknessMm },
    },
  );
  return c.json({ pageCount: check!.pageCount, layout: check!.layout });
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

// ---------------------------------------------------------------- deleting exports

const RUNNING_EXPORT = new Set(["queued", "processing", "cancel_requested"]);

/** Deletes export jobs and their files from disk now (not after the 30-day expiry). */
async function deleteExportJobs(c: Context<AppEnv>, projectId: string, jobIds: string[]) {
  const deps = c.get("deps");
  if (!jobIds.length) return { exports: 0, files: 0, bytes: 0 };
  const files = await deps.db
    .select({ a: assets })
    .from(exportsTable)
    .innerJoin(assets, eq(assets.id, exportsTable.assetId))
    .where(inArray(exportsTable.exportJobId, jobIds));
  let bytes = 0;
  for (const { a } of files) {
    await deps.assets.hardDelete(a);
    bytes += a.byteSize;
  }
  await deps.db.delete(exportJobs).where(and(eq(exportJobs.projectId, projectId), inArray(exportJobs.id, jobIds)));
  // Cached video sections go with the last export that claimed them.
  await sweepRenderSections(deps.db, deps.assets, projectId);
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId,
    action: "export.delete",
    metadata: { exports: jobIds.length, files: files.length, bytes },
    requestId: c.get("requestId"),
  });
  return { exports: jobIds.length, files: files.length, bytes };
}

doc({
  method: "DELETE",
  path: "/api/exports/:id",
  summary: "Delete an export and its files from disk now. A queued or running export has to be cancelled first.",
  tag: "exports",
});
exportRoutes.delete("/exports/:id", async (c) => {
  const id = uuidParam(c, "id");
  const [job] = await c.get("deps").db.select().from(exportJobs).where(eq(exportJobs.id, id));
  if (!job) throw notFound("Export");
  await projectAccess(c, job.projectId, "delete");
  if (RUNNING_EXPORT.has(job.status)) throw conflict("This export is still running. Cancel it first.");
  return c.json(await deleteExportJobs(c, job.projectId, [id]));
});

doc({
  method: "DELETE",
  path: "/api/projects/:projectId/exports",
  summary:
    "Delete every finished export of the project and their files from disk now. Running exports and import records are kept.",
  tag: "exports",
});
exportRoutes.delete("/projects/:projectId/exports", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "delete");
  const jobs = await c
    .get("deps")
    .db.select({ id: exportJobs.id, status: exportJobs.status, kind: exportJobs.kind })
    .from(exportJobs)
    .where(eq(exportJobs.projectId, p.id));
  const ids = jobs.filter((j) => !RUNNING_EXPORT.has(j.status) && j.kind !== "project_import").map((j) => j.id);
  const out = await deleteExportJobs(c, p.id, ids);
  return c.json({ ...out, skippedRunning: jobs.filter((j) => RUNNING_EXPORT.has(j.status)).length });
});
