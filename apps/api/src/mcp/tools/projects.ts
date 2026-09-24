import { projects } from "@openmanga/db";
import { z } from "zod";
import { CreateProject, UpdateProject } from "../../routes/projects.ts";
import { defineMcpTool, IdempotencyKey, Passthrough } from "../registry.ts";
import { cls, grantProject, links, Paging, page, requireCreate, stamp, Uuid } from "./common.ts";

const ProjectSummary = z
  .object({ id: z.string(), title: z.string(), projectType: z.string(), status: z.string() })
  .passthrough();

type ProjectRow = Record<string, unknown> & {
  id: string;
  title: string;
  description: string;
  settings: { format?: string };
};

export const projectTools = [
  defineMcpTool({
    name: "list_projects",
    title: "List projects",
    description:
      "List the user's projects this connection may see, newest activity first, with chapter/panel/generation counts and spend. Paginated (default 25, max 100). Use get_project for detail. Read-only.",
    input: z.object({ status: z.enum(["active", "archived", "trash", "all"]).default("active"), ...Paging }),
    output: z.object({
      items: z.array(ProjectSummary),
      total: z.number(),
      offset: z.number(),
      limit: z.number(),
      nextOffset: z.number().nullable(),
    }),
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects"],
    actionKeys: [],
    handler: async ({ status, limit, offset }, ctx) => {
      const { projects: rows } = await ctx.invoke<{ projects: ProjectRow[] }>("GET", "/api/projects", {
        query: { status },
      });
      const slim = rows.map((p) => ({
        id: p.id,
        title: p.title,
        description: p.description.slice(0, 300),
        projectType: p.projectType,
        format: p.settings.format ?? "comic",
        language: p.language,
        status: p.status,
        deletedAt: p.deletedAt,
        updatedAt: p.updatedAt,
        stats: p.stats,
        url: links(ctx).project(p.id),
      }));
      return { data: page(slim, limit, offset) };
    },
  }),

  defineMcpTool({
    name: "get_project",
    title: "Get project",
    description:
      "One project's overview: settings (format, language, budget, narration, lettering), counts (chapters, pages, panels, panels with art, cast, active jobs, spend) and current style. Read-only. Next: get_story, list_chapters, list_library.",
    input: z.object({ projectId: Uuid }),
    output: Passthrough,
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId"],
    actionKeys: [],
    handler: async ({ projectId }, ctx) => ({
      data: await ctx.invoke("GET", `/api/projects/${projectId}`),
      links: { project: links(ctx).project(projectId) },
    }),
  }),

  defineMcpTool({
    name: "create_project",
    title: "Create project",
    description:
      "Create a new project (optionally with its first story revision in `story`). Needs the connection's permission to create projects; a connection limited to selected projects is granted the new one automatically. `format`: comic pages, vertical strip, or film (16:9 shots). New projects start with a $5 budget cap. Not asynchronous. Next: save_story_revision / run_story_analysis.",
    input: CreateProject.extend({ idempotencyKey: IdempotencyKey }),
    output: z.object({ project: Passthrough }),
    scopes: ["projects:create"],
    sensitivity: "write",
    idempotent: false,
    routes: ["POST /api/projects"],
    actionKeys: ["project.create"],
    classify: async (a) => cls("write", "project.create", null, `Create project "${a.title}"`),
    handler: async ({ idempotencyKey: _k, ...body }, ctx) => {
      requireCreate(ctx);
      const { project } = await ctx.invoke<{ project: { id: string } }>("POST", "/api/projects", { body });
      await grantProject(ctx, project.id);
      return { data: { project }, links: { project: links(ctx).project(project.id) } };
    },
  }),

  defineMcpTool({
    name: "update_project",
    title: "Update project",
    description:
      "Change a project's title, description, type, language, reading direction, colour mode or `settings` (merged into the current settings: budgetUsd, narration voice/speed, lettering defaults, imageQuality, ...). Raising or clearing the budget cap is sensitive and may need the user's approval. The format cannot change once pages exist.",
    input: UpdateProject.extend({ projectId: Uuid }),
    output: z.object({ project: Passthrough }),
    scopes: ["projects:write"],
    sensitivity: "sensitive-write",
    idempotent: true,
    routes: ["PATCH /api/projects/:projectId"],
    actionKeys: ["project.update", "project.budget"],
    classify: async ({ projectId, settings }, ctx) => {
      const budget = settings && "budgetUsd" in settings;
      return cls(
        budget ? "sensitive-write" : "write",
        budget ? "project.budget" : "project.update",
        projectId,
        budget ? `Change the project budget cap to ${String(settings.budgetUsd ?? "none")}` : "Update project settings",
        { target: budget ? await stamp(ctx, projects, projectId) : undefined },
      );
    },
    handler: async ({ projectId, ...body }, ctx) => ({
      data: await ctx.invoke("PATCH", `/api/projects/${projectId}`, { body }),
      links: { project: links(ctx).project(projectId) },
    }),
  }),

  defineMcpTool({
    name: "set_project_status",
    title: "Archive / trash / restore project",
    description:
      "archive / unarchive a project, move it to trash, or restore it from trash. Trash removes it from normal use (delete class: may need approval). Permanent deletion is delete_project.",
    input: z.object({ projectId: Uuid, action: z.enum(["archive", "unarchive", "trash", "restore"]) }),
    output: z.object({ project: Passthrough }),
    scopes: ["projects:write"],
    sensitivity: "delete",
    idempotent: true,
    routes: ["POST /api/projects/:projectId/status"],
    actionKeys: ["project.archive", "project.unarchive", "project.trash", "project.restore"],
    classify: async ({ projectId, action }, ctx) =>
      cls(action === "trash" ? "delete" : "write", `project.${action}`, projectId, `${action} the project`, {
        target: await stamp(ctx, projects, projectId, ["status", "deletedAt"]),
      }),
    handler: async ({ projectId, action }, ctx) => ({
      data: await ctx.invoke("POST", `/api/projects/${projectId}/status`, { body: { action } }),
    }),
  }),

  defineMcpTool({
    name: "delete_project",
    title: "Delete project permanently",
    description:
      "PERMANENTLY delete a project that is already in trash, with all its files. Cannot be undone. Always a delete-class action (may need the user's approval).",
    input: z.object({ projectId: Uuid }),
    output: z.object({ ok: z.boolean() }),
    scopes: ["projects:write"],
    sensitivity: "delete",
    idempotent: false,
    routes: ["DELETE /api/projects/:projectId"],
    actionKeys: ["project.delete"],
    classify: async ({ projectId }, ctx) => {
      const target = await stamp(ctx, projects, projectId, ["title", "deletedAt", "updatedAt"]);
      return cls(
        "delete",
        "project.delete",
        projectId,
        `Permanently delete project "${String(target.title)}" and its files`,
        {
          target,
        },
      );
    },
    handler: async ({ projectId }, ctx) => ({ data: await ctx.invoke("DELETE", `/api/projects/${projectId}`) }),
  }),

  defineMcpTool({
    name: "duplicate_project",
    title: "Duplicate project",
    description:
      "Deep-copy a project (story, cast, chapters, pages, panels, artwork references) into a new project. Needs permission to create projects; sensitive (may need approval). The copy is granted to this connection.",
    input: z.object({ projectId: Uuid, idempotencyKey: IdempotencyKey }),
    output: z.object({ project: Passthrough }),
    scopes: ["projects:read", "projects:create"],
    sensitivity: "sensitive-write",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/duplicate"],
    actionKeys: ["project.duplicate"],
    classify: async ({ projectId }) =>
      cls("sensitive-write", "project.duplicate", projectId, "Duplicate the whole project into a new one"),
    handler: async ({ projectId }, ctx) => {
      requireCreate(ctx);
      const { project } = await ctx.invoke<{ project: { id: string } }>("POST", `/api/projects/${projectId}/duplicate`);
      await grantProject(ctx, project.id);
      return { data: { project }, links: { project: links(ctx).project(project.id) } };
    },
  }),

  defineMcpTool({
    name: "search_project",
    title: "Search project",
    description: "Search one project's characters, places, props, chapters, scenes and panels by text. Read-only.",
    input: z.object({ projectId: Uuid, q: z.string().trim().min(1).max(100) }),
    output: Passthrough,
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/search"],
    actionKeys: [],
    handler: async ({ projectId, q }, ctx) => ({
      data: await ctx.invoke("GET", `/api/projects/${projectId}/search`, { query: { q } }),
    }),
  }),

  defineMcpTool({
    name: "get_project_checks",
    title: "Readiness / preflight",
    description:
      "check=readiness: what an export would lack (missing artwork, narration coverage and audio, draft or superseded versions) and whether the user has a usable provider key. check=preflight: a dry run before image generation (risky vocabulary, stale or missing references, lighting issues). Optionally limited to a chapter (or a page for preflight). Read-only; run before bulk generation or export.",
    input: z.object({
      projectId: Uuid,
      check: z.enum(["readiness", "preflight"]),
      chapterId: Uuid.optional(),
      pageId: Uuid.optional(),
      language: z.string().max(16).optional(),
    }),
    output: Passthrough,
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/readiness", "GET /api/projects/:projectId/preflight"],
    actionKeys: [],
    handler: async ({ projectId, check, chapterId, pageId, language }, ctx) => ({
      data: await ctx.invoke("GET", `/api/projects/${projectId}/${check}`, {
        query: check === "readiness" ? { chapterId, language } : { chapterId, pageId },
      }),
    }),
  }),

  defineMcpTool({
    name: "get_project_usage",
    title: "Project usage and cost",
    description:
      "A project's AI usage and estimated cost breakdown (by kind, provider and model) and its budget. Read-only.",
    input: z.object({ projectId: Uuid }),
    output: Passthrough,
    scopes: ["usage:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/usage"],
    actionKeys: [],
    handler: async ({ projectId }, ctx) => ({ data: await ctx.invoke("GET", `/api/projects/${projectId}/usage`) }),
  }),
];
