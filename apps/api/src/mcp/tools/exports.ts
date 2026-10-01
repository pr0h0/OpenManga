import { and, eq, exportJobs, ne, notInArray } from "@openmanga/db";
import { z } from "zod";
import { ExportOptions } from "../../routes/exports.ts";
import { defineMcpTool, IdempotencyKey, Passthrough } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { cls, jobView, links, projectOf, Uuid } from "./common.ts";

export const exportTools = [
  defineMcpTool({
    name: "create_export",
    title: "Create export",
    description:
      "Queue an export job: pages as PNG/JPG, PDF (including Amazon KDP print sizes with full bleed), CBZ comic archive, fixed-layout EPUB, webtoon strip, YouTube package (the newest full video of the scope with its thumbnail, subtitles, chapter timestamps and publishing text), ZIP package, project JSON, narration audio, timeline, agent package, or video (pages / panels). Deterministic composition, no AI calls and nothing spent; still treated as sensitive (may need approval). Run get_project_checks check=readiness first; acknowledgeIssues=true exports despite reported issues. Asynchronous: returns the job (not a file); poll get_job until completed, which then lists the files, or list_exports.",
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
