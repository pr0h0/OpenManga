import { and, eq, exportJobs, ne, notInArray } from "@openmanga/db";
import { z } from "zod";
import { ExportOptions } from "../../routes/exports.ts";
import { defineMcpTool, IdempotencyKey, Passthrough } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { AiInput, aiLabel, cls, jobView, links, projectOf, restAi, textSpend, Uuid } from "./common.ts";

export const exportTools = [
  defineMcpTool({
    name: "create_export",
    title: "Create export",
    description:
      "Queue an export job: pages as PNG/JPG, PDF (including Amazon KDP print sizes with full bleed; `pdf.toc` adds a contents page, `pdf.rectoChapters` blank pages so chapters open on a right-hand page, `pdf.metadata` the title, author, subject, keywords and language), a print cover (`print_cover`: one PDF with back, spine and front plus bleed, the spine sized from the interior's page count and `print.paper`; needs the project cover art and a print `pdf.pageSize`), a print preflight (`print_preflight`: a JSON report of the PDF the same `pdf` options make: resolution, total ink, colour shift, fonts, lettering outside the safe area, page count), layered files for finishing in Photoshop or Clip Studio (`psd_pages`: one layered PSD per page with a group per panel of its art, frame and hidden layout guide, then effects, captions and dialogue as named layers; `layered_package`: per page the text-free page, the lettering as SVG and every layer as its own PNG, with manifest.json giving each file's placement, stacking order and text), CBZ comic archive, fixed-layout EPUB, webtoon strip, YouTube package (the newest full video of the scope with its thumbnail, subtitles, chapter timestamps and publishing text), ZIP package, project JSON, narration audio, timeline, agent package, or video (pages / panels; `video.aspect` 16:9, 9:16 or 1:1), or a Shorts cut (`video_shorts` with `panelIds` from suggest_shorts or suggest_repurpose; `label` names the file, e.g. Trailer; `video.captions` bottom, center or two_line draws the narration into the picture), or repurposed images (`carousel`: the panelIds as 1:1 or 4:5 images, zipped; `quote_image`: the first panel with `still.text` set on it). `social` { title, caption } ships as a caption file. Deterministic composition, no AI calls and nothing spent; still treated as sensitive (may need approval). Run get_project_checks check=readiness first; acknowledgeIssues=true exports despite reported issues. Asynchronous: returns the job (not a file); poll get_job until completed, which then lists the files, or list_exports.",
    input: ExportOptions.extend({ projectId: Uuid, idempotencyKey: IdempotencyKey }),
    output: z.object({ job: Passthrough }).passthrough(),
    scopes: ["exports:create"],
    sensitivity: "sensitive-write",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/exports"],
    actionKeys: ["project.export"],
    classify: async ({ projectId, kind, chapterId }) =>
      cls(
        "sensitive-write",
        "project.export",
        projectId,
        `Export ${chapterId ? "a chapter" : "the project"} as ${kind}`,
      ),
    handler: async ({ projectId, idempotencyKey: _k, ...body }, ctx) => {
      const r = await ctx.invoke<{ job: Record<string, unknown> }>("POST", `/api/projects/${projectId}/exports`, {
        body,
      });
      return { data: { ...r, job: jobView(r.job) }, links: { exports: links(ctx).exports(projectId) } };
    },
  }),

  defineMcpTool({
    name: "suggest_shorts",
    title: "Suggest a Shorts cut",
    description:
      "Candidate shots for a Shorts cut (a trailer of key shots) of a chapter or the whole project: every panel in story order with its hold, narration text, a drama score and `picked` for the automatic choice (dramatic shots spread across the story, filling up to lengthSeconds: default 180, at most 600). `warning` is set when the length or the pick goes over 3 minutes, which YouTube uploads as a regular video rather than a Short. Change the pick freely, then render it with create_export kind=video_shorts, panelIds and the same video.shortsSeconds. Read-only.",
    input: z.object({
      projectId: Uuid,
      chapterId: Uuid.optional(),
      language: z.string().max(16).optional(),
      minHoldMs: z.number().int().min(500).max(30_000).optional(),
      lengthSeconds: z.number().int().min(30).max(600).optional(),
    }),
    output: z.object({ shots: z.array(Passthrough) }).passthrough(),
    scopes: ["exports:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/shorts"],
    actionKeys: [],
    handler: async ({ projectId, ...query }, ctx) => ({
      data: await ctx.invoke<{ shots: Record<string, unknown>[] }>("GET", `/api/projects/${projectId}/shorts`, {
        query,
      }),
    }),
  }),

  defineMcpTool({
    name: "suggest_repurpose",
    title: "Suggest a repurposing plan",
    description:
      "Repurposing a finished project: `items` is the saved plan (settings.repurpose), `suggestion` a fresh one (`shorts` non-overlapping Shorts of 30–60 s from distinct parts of the story, a 60–90 s trailer, a 15–30 s teaser, a 10-panel carousel and 3 quote images with their lines), `candidates` every panel with its hold, narration, art and quotable lines. Save an edited plan with update_project settings.repurpose.items, write titles and captions with write_social_copy, then render each item with create_export (short/trailer/teaser: video_shorts with panelIds, label, video.shortsSeconds, video.aspect and video.captions; carousel; quote_image), passing its title and caption as `social`. Read-only.",
    input: z.object({
      projectId: Uuid,
      shorts: z.number().int().min(1).max(10).optional().describe("How many Shorts to suggest (default 3)."),
      language: z.string().max(16).optional(),
      minHoldMs: z.number().int().min(500).max(30_000).optional(),
    }),
    output: Passthrough,
    scopes: ["exports:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/repurpose"],
    actionKeys: [],
    handler: async ({ projectId, ...query }, ctx) => ({
      data: await ctx.invoke("GET", `/api/projects/${projectId}/repurpose`, { query }),
    }),
  }),

  defineMcpTool({
    name: "write_social_copy",
    title: "Write social titles and captions",
    description:
      "A text job that writes a social title and caption for each saved repurposing item (itemIds, default all), from its narration; they replace the items' current title and caption in settings.repurpose when the job completes (poll get_job). Spends text-provider credits unless ai.manual; may need approval.",
    input: z.object({
      projectId: Uuid,
      itemIds: z.array(z.string().max(40)).max(40).optional(),
      ai: AiInput,
      idempotencyKey: IdempotencyKey,
    }),
    output: z.object({ job: Passthrough }).passthrough(),
    scopes: ["generations:run", "projects:write"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/repurpose/copy"],
    actionKeys: ["repurpose.copy"],
    classify: async ({ projectId, itemIds, ai }) =>
      cls(
        textSpend(ai, "write"),
        "repurpose.copy",
        projectId,
        `Write social titles and captions for ${itemIds?.length ?? "all"} repurposing item(s) ${aiLabel(ai)}`,
      ),
    handler: async ({ projectId, itemIds, ai }, ctx) => {
      const r = await ctx.invoke<{ job: Record<string, unknown> }>(
        "POST",
        `/api/projects/${projectId}/repurpose/copy`,
        {
          body: { itemIds, ai: await restAi(ctx, ai) },
        },
      );
      return { data: { job: jobView(r.job) } };
    },
  }),

  defineMcpTool({
    name: "list_exports",
    title: "List exports",
    description:
      "A project's export jobs (newest first) and their downloadable files (file names, sizes, types). Read-only.",
    input: z.object({ projectId: Uuid, limit: z.number().int().min(1).max(100).default(25) }),
    output: z.object({ jobs: z.array(Passthrough) }).passthrough(),
    scopes: ["exports:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/exports"],
    actionKeys: [],
    handler: async ({ projectId, limit }, ctx) => {
      const r = await ctx.invoke<{ jobs: Record<string, unknown>[] }>("GET", `/api/projects/${projectId}/exports`);
      return { data: { ...r, jobs: r.jobs.slice(0, limit) }, links: { exports: links(ctx).exports(projectId) } };
    },
  }),

  defineMcpTool({
    name: "delete_exports",
    title: "Delete exports",
    description:
      "Delete export files from disk now instead of waiting for their 30-day expiry: one export (exportId) or every finished export of a project (projectId with all=true; running exports and import records are kept). A queued or running export must be cancelled first (control_job). Cannot be undone, but an export can be queued again. Always a delete-class action (may need the user's approval).",
    input: z.object({
      exportId: Uuid.optional().describe("One export job (ids from list_exports)."),
      projectId: Uuid.optional().describe("With all=true: every finished export of this project."),
      all: z.boolean().default(false),
    }),
    output: z.object({ exports: z.number(), files: z.number(), bytes: z.number() }).passthrough(),
    scopes: ["exports:create"],
    sensitivity: "delete",
    idempotent: true,
    routes: ["DELETE /api/exports/:id", "DELETE /api/projects/:projectId/exports"],
    actionKeys: ["export.delete", "export.delete_all"],
    classify: async ({ exportId, projectId, all }, ctx) => {
      if (exportId) {
        const [job] = await ctx.deps.db
          .select({ status: exportJobs.status, kind: exportJobs.kind })
          .from(exportJobs)
          .where(eq(exportJobs.id, exportId));
        if (!job) throw toolError(404, "not_found", "Export not found");
        return cls("delete", "export.delete", await projectOf(ctx, "job", exportId), `Delete a ${job.kind} export`, {
          target: job,
        });
      }
      if (!projectId || !all)
        throw toolError(400, "bad_request", "Pass exportId, or projectId with all=true to delete every export");
      // What would go, so an approval given before another export finished does not delete that one as well.
      const target = (
        await ctx.deps.db
          .select({ id: exportJobs.id })
          .from(exportJobs)
          .where(
            and(
              eq(exportJobs.projectId, projectId),
              ne(exportJobs.kind, "project_import"),
              notInArray(exportJobs.status, ["queued", "processing", "cancel_requested"]),
            ),
          )
      )
        .map((j) => j.id)
        .sort();
      return cls("delete", "export.delete_all", projectId, `Delete all ${target.length} finished exports`, { target });
    },
    handler: async ({ exportId, projectId }, ctx) =>
      exportId
        ? { data: await ctx.invoke("DELETE", `/api/exports/${exportId}`) }
        : {
            data: await ctx.invoke("DELETE", `/api/projects/${projectId}/exports`),
            links: { exports: links(ctx).exports(projectId!) },
          },
  }),
];
