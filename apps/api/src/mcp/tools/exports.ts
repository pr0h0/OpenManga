import { and, eq, exportJobs, ne, notInArray } from "@openmanga/db";
import { VideoEditOp } from "@openmanga/schemas";
import { narrationTranscript, type Provenance, provenanceMarkdown } from "@openmanga/services";
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
      "Queue an export job: pages as PNG/JPG, PDF (including Amazon KDP print sizes with full bleed; `pdf.toc` adds a contents page, `pdf.rectoChapters` blank pages so chapters open on a right-hand page, `pdf.metadata` the title, author, subject, keywords and language), a print cover (`print_cover`: one PDF with back, spine and front plus bleed, the spine sized from the interior's page count and `print.paper`; needs the project cover art and a print `pdf.pageSize`), a print preflight (`print_preflight`: a JSON report of the PDF the same `pdf` options make: resolution, total ink, colour shift, fonts, lettering outside the safe area, page count), layered files for finishing in Photoshop or Clip Studio (`psd_pages`: one layered PSD per page with a group per panel of its art, frame and hidden layout guide, then effects, captions and dialogue as named layers; `layered_package`: per page the text-free page, the lettering as SVG and every layer as its own PNG, with manifest.json giving each file's placement, stacking order and text), CBZ comic archive, fixed-layout EPUB, webtoon strip, YouTube package (the newest full video of the scope with its thumbnail, subtitles, chapter timestamps and publishing text), ZIP package, project JSON, narration audio, timeline, agent package, or video (pages / panels; `video.aspect` 16:9, 9:16 or 1:1), or a Shorts cut (`video_shorts` with `panelIds` from suggest_shorts or suggest_repurpose; `label` names the file, e.g. Trailer; `video.captions` bottom, center or two_line draws the narration into the picture; `video.hook` is a line the narrator says before the first shot), a hook variant (`video.hookId`, one of the project's settings.video.hooks: alternative openings, each its own narration over chosen panels, then the intro card and the film; video_panels only), or repurposed images (`carousel`: the panelIds as 1:1 or 4:5 images, zipped; `quote_image`: the first panel with `still.text` set on it). `social` { title, caption } ships as a caption file. `language`: for pages, PDF, CBZ, EPUB and webtoon the translated lettering edition (translate_lettering), for narration and video the narration track. `target` (an export_targets key, e.g. webtoon_canvas, kdp_paperback) checks the files made against that platform's limits (the job's result.targetCheck). `provenance`=true ships a provenance record (`_provenance.json` and `.md`, as get_provenance) with the files. Deterministic composition, no AI calls and nothing spent; still treated as sensitive (may need approval). Run get_project_checks check=readiness first; acknowledgeIssues=true exports despite reported issues. Asynchronous: returns the job (not a file); poll get_job until completed, which then lists the files, or list_exports.",
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
    name: "edit_video",
    title: "Edit the video in words",
    description:
      'Change the video\'s timeline from an instruction, e.g. "make chapter 4 faster", "cut every silence over 900 ms", "add a title card before chapter 8". propose: a text job turns the instruction into edits (asynchronous; poll get_job: result.edits lists each with its op, a label and what it would change now; result.dropped what could not be done; ai.manual=true asks you for a VideoEditPlan answer; a provider run spends the user\'s credits). apply: the job\'s edits, or `ops` (a subset, or changed: pauses {chapterId|null, maxPauseMs, pauseScale}, holds {chapterId|null, holdMs|null}, shot {panelId, disabled, motion, fade}, card {which intro|outro|chapter, chapterId, card {title, subtitle, durationMs}|null}, scene_fades {on}); waits for the user\'s approval. Existing art and audio only: nothing is drawn or voiced.',
    input: z.object({
      action: z.enum(["propose", "apply"]),
      projectId: Uuid,
      instruction: z.string().min(3).max(2000).optional().describe("propose: what to change, in words."),
      jobId: Uuid.optional().describe("apply: the propose job."),
      ops: z.array(VideoEditOp).max(60).optional().describe("apply: the edits to apply; left out, all proposed."),
      ai: AiInput,
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["generations:run"],
    scopesFor: (a) =>
      a.action === "apply" ? ["projects:write", "narration:write", "panels:write"] : ["generations:run"],
    sensitivity: "sensitive-write",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/video-edits", "POST /api/projects/:projectId/video-edits/:jobId/apply"],
    actionKeys: ["video.edit_propose", "video.edit_apply"],
    classify: async (a) =>
      a.action === "apply"
        ? cls(
            "sensitive-write",
            "video.edit_apply",
            a.projectId,
            `Apply ${a.ops ? a.ops.length : "the proposed"} video edits`,
          )
        : cls(textSpend(a.ai, "write"), "video.edit_propose", a.projectId, `Propose video edits ${aiLabel(a.ai)}`),
    handler: async (a, ctx) => {
      if (a.action === "apply") {
        if (!a.jobId) throw toolError(400, "bad_request", "jobId is required for apply");
        return {
          data: await ctx.invoke("POST", `/api/projects/${a.projectId}/video-edits/${a.jobId}/apply`, {
            body: { ops: a.ops },
          }),
        };
      }
      if (!a.instruction) throw toolError(400, "bad_request", "instruction is required for propose");
      const r = await ctx.invoke<{ job: Record<string, unknown> & { id: string; projectId: string } }>(
        "POST",
        `/api/projects/${a.projectId}/video-edits`,
        { body: { instruction: a.instruction, ai: await restAi(ctx, a.ai) } },
      );
      return { data: { job: jobView(r.job) }, links: { job: links(ctx).job(r.job.projectId, r.job.id) } };
    },
  }),

  defineMcpTool({
    name: "export_targets",
    title: "Platform export targets",
    description:
      "Platform presets for exports (YouTube, Shorts, TikTok, Reels, Instagram carousel, WEBTOON Canvas, Tapas, KDP, PDF). list: each target's export kind, the options it sets, its limits (length, file and image sizes, image count, strip image height, page count) and notes on safe areas, naming and codecs. check: a target against the project before exporting (chapterId, else the whole project; durationMs for a Shorts cut's length, images for a carousel's slides). Pass `target` to create_export to have the files checked once made (the job's result.targetCheck). Read-only.",
    input: z.object({
      action: z.enum(["list", "check"]),
      projectId: Uuid.optional(),
      key: z.string().max(40).optional(),
      chapterId: Uuid.optional(),
      minHoldMs: z.number().int().min(500).max(30_000).optional(),
      durationMs: z.number().int().min(0).optional(),
      images: z.number().int().min(0).max(1000).optional(),
    }),
    output: Passthrough,
    scopes: ["exports:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/export-targets", "GET /api/projects/:projectId/export-targets/:key/check"],
    actionKeys: [],
    handler: async ({ action, projectId, key, ...query }, ctx) => {
      if (action === "list") return { data: await ctx.invoke("GET", "/api/export-targets") };
      if (!projectId || !key) throw toolError(400, "bad_request", "projectId and key are required for check");
      return {
        data: await ctx.invoke("GET", `/api/projects/${projectId}/export-targets/${encodeURIComponent(key)}/check`, {
          query,
        }),
      };
    },
  }),

  defineMcpTool({
    name: "get_accessibility",
    title: "Accessibility checks and transcript",
    description:
      "check: for a chapter or the project, without AI — how many panels have alt text written by hand (the rest are described from their beat, words and sounds; set one with update_panel altText), panels with nothing to describe them by, comic pages whose panel order differs from where the panels sit (with the order a reader takes), and lettering too faint (WCAG contrast under 4.5) or too small for the format. transcript: the narration as one Markdown text, chapter by chapter, in a language. Read-only.",
    input: z.object({
      action: z.enum(["check", "transcript"]),
      projectId: Uuid,
      chapterId: Uuid.optional(),
      language: z.string().min(2).max(16).optional(),
    }),
    output: Passthrough,
    scopes: ["chapters:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/accessibility", "GET /api/projects/:projectId/transcript"],
    actionKeys: [],
    handler: async ({ action, projectId, chapterId, language }, ctx) => {
      if (action === "check")
        return { data: await ctx.invoke("GET", `/api/projects/${projectId}/accessibility`, { query: { chapterId } }) };
      // Read through the API first: it checks this connection's access to the project.
      const { project } = await ctx.invoke<{ project: { language: string } }>("GET", `/api/projects/${projectId}`);
      const transcript = await narrationTranscript(ctx.deps.db, projectId, {
        chapterId,
        language: language ?? project.language,
      });
      return { data: { transcript } };
    },
  }),

  defineMcpTool({
    name: "get_provenance",
    title: "Provenance record",
    description:
      "Where an output comes from, for a chapter or the whole project: the app build, story revision, each panel's artwork with the job, provider, model, template version, prompt hash and prompt-lab rules that made it (or the upload or tool), the references the panels draw on with their licence notes, narration voices, lettering fonts and their licences, each panel's video clip (provider, model, job, prompt hash, parts) and the music bed with its licence note. format md: a page a person reads. create_export with provenance=true ships the same record with the files. Read-only.",
    input: z.object({
      projectId: Uuid,
      chapterId: Uuid.optional(),
      format: z.enum(["json", "md"]).default("json"),
    }),
    output: Passthrough,
    scopes: ["exports:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/provenance"],
    actionKeys: [],
    handler: async ({ projectId, chapterId, format }, ctx) => {
      const record = await ctx.invoke<Provenance>("GET", `/api/projects/${projectId}/provenance`, {
        query: { chapterId },
      });
      return { data: format === "md" ? { markdown: provenanceMarkdown(record) } : record };
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
