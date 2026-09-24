import { z } from "zod";
import { ExportOptions } from "../../routes/exports.ts";
import { defineMcpTool, IdempotencyKey, Passthrough } from "../registry.ts";
import { cls, jobView, links, Uuid } from "./common.ts";

export const exportTools = [
  defineMcpTool({
    name: "create_export",
    title: "Create export",
    description:
      "Queue an export job: pages as PNG/JPG, PDF, webtoon strip, ZIP package, project JSON, narration audio, timeline, agent package, or video (pages / panels). Deterministic composition, no AI calls and nothing spent; still treated as sensitive (may need approval). Run get_project_checks check=readiness first; acknowledgeIssues=true exports despite reported issues. Asynchronous: returns the job (not a file); poll get_job until completed, which then lists the files, or list_exports.",
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
];
