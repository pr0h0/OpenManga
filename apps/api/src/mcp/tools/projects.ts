import { projects } from "@openmanga/db";
import { ProjectStorage } from "@openmanga/schemas";
import { z } from "zod";
import { CreateProject, UpdateProject } from "../../routes/projects.ts";
import { defineMcpTool, IdempotencyKey, Passthrough } from "../registry.ts";
import { toolError } from "../runtime.ts";
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
    name: "list_channel_profiles",
    title: "List channel profiles",
    description:
      "The user's channel profiles: publication identities (default preset, target runtime, narrator voice and speed, image quality, reference and batch policy, branding, thumbnail style, YouTube title rules, description template and tags, video output). Pass a profile's id as create_project's profileId. Read-only.",
    input: z.object({}),
    output: z.object({ profiles: z.array(Passthrough) }),
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/channel-profiles"],
    actionKeys: [],
    handler: async (_a, ctx) => ({ data: await ctx.invoke("GET", "/api/channel-profiles") }),
  }),

  defineMcpTool({
    name: "create_project",
    title: "Create project",
    description:
      "Create a new project (optionally with its first story revision in `story`). Needs the connection's permission to create projects; a connection limited to selected projects is granted the new one automatically. `format`: comic pages, vertical strip, or film (16:9 shots; `filmFrame` 9:16 plans and draws every shot vertical for Shorts and renders vertical without cropping). `profileId` (from list_channel_profiles) starts it from one of the user's channel profiles: its preset, voice, quality, branding and logo, thumbnail style, YouTube rules and video output are copied in; values given here still win for type, format and style. New projects start with a $5 budget cap. Not asynchronous. Next: save_story_revision / run_story_analysis.",
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
      "Change a project's title, description, type, language, reading direction, colour mode or `settings` (merged into the current settings: budgetUsd, narration voice/speed, `pronunciation` (the whole dictionary: [{ term, spoken, caseSensitive?, wholeWord? }], applied only to what the voice says; segments whose spoken text changes get stale audio), lettering defaults, imageQuality, `video` for scene-break fades, a watermark (an image of this project) and intro/outro cards, ...). Raising or clearing the budget cap is sensitive and may need the user's approval. The format cannot change once pages exist.",
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
      "check=readiness: what an export would lack (missing artwork, narration coverage and audio, draft or superseded versions) and whether the user has a usable provider key. check=preflight: a dry run before image generation (risky vocabulary, stale or missing references, lighting issues). check=shot_variety: per chapter, runs of panels in reading order that repeat a shot (the same size 4+ times in a row, or the same size and angle 3+ times), to vary with update_panel shotType / cameraAngle before drawing. Optionally limited to a chapter (or a page for preflight). Read-only; run before bulk generation or export.",
    input: z.object({
      projectId: Uuid,
      check: z.enum(["readiness", "preflight", "shot_variety"]),
      chapterId: Uuid.optional(),
      pageId: Uuid.optional(),
      language: z.string().max(16).optional(),
    }),
    output: Passthrough,
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: [
      "GET /api/projects/:projectId/readiness",
      "GET /api/projects/:projectId/preflight",
      "GET /api/projects/:projectId/shot-variety",
    ],
    actionKeys: [],
    handler: async ({ projectId, check, chapterId, pageId, language }, ctx) => ({
      data: await ctx.invoke("GET", `/api/projects/${projectId}/${check.replace("_", "-")}`, {
        query:
          check === "readiness"
            ? { chapterId, language }
            : check === "preflight"
              ? { chapterId, pageId }
              : { chapterId },
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

  defineMcpTool({
    name: "get_youtube_stats",
    title: "YouTube stats",
    description:
      "How the project's published videos do on YouTube. Without linkId: every linked video (film or short, its channel, the export or Short it came from) with current views, likes and comments, total thumbnail impressions on connected channels, its first-48-hours curve (views at each hour since publishing, null where nothing was measured), and totals across videos, film against Shorts and per channel. With linkId (an id from that list): the video's daily history (`source` analytics for a connected channel: views, watch minutes, average view duration and percentage, subscribers gained and lost, likes, comments, shares, plus traffic source, country, device and content-type splits, and `tail` the views since the last Analytics day; `source` snapshots otherwise), and daily impressions and click-through rate from the reach reports. Linking videos and connecting channels happen in the app. Read-only.",
    input: z.object({ projectId: Uuid, linkId: Uuid.optional() }),
    output: Passthrough,
    scopes: ["stats:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/youtube", "GET /api/projects/:projectId/youtube/links/:linkId/history"],
    actionKeys: [],
    handler: async ({ projectId, linkId }, ctx) => ({
      data: await ctx.invoke(
        "GET",
        linkId ? `/api/projects/${projectId}/youtube/links/${linkId}/history` : `/api/projects/${projectId}/youtube`,
      ),
    }),
  }),
  defineMcpTool({
    name: "project_storage",
    title: "Project storage policy",
    description:
      "A project's own storage policy and cap. get: the policy, the bytes stored (and whether over the cap), what may be deleted by kind (render_cache, export, panel_version, audio_take, trash, prompt_reference) and a dry run of what the policy would delete now. set (owner): { enabled, maxAgeDays, kindAges (a kind's own age in days, null for no age limit), capGb } — applied at each hourly maintenance pass; while the project is over its cap, AI work and exports are refused (storage_cap_exceeded). apply (owner): delete what the dry run lists now — delete class, may need approval. Artwork a panel shows, approved art, references, uploads and narration in use are never deleted.",
    input: z.object({
      action: z.enum(["get", "set", "apply"]),
      projectId: Uuid,
      policy: ProjectStorage.optional(),
    }),
    output: Passthrough,
    scopes: ["projects:read"],
    scopesFor: (a) => (a.action === "get" ? ["projects:read"] : ["projects:write"]),
    sensitivity: "delete",
    idempotent: false,
    routes: [
      "GET /api/projects/:projectId/storage",
      "PUT /api/projects/:projectId/storage",
      "POST /api/projects/:projectId/storage/apply",
    ],
    actionKeys: ["project.storage_policy", "project.storage_apply"],
    classify: async (a) =>
      a.action === "get"
        ? cls("read", "project.storage_read", a.projectId, "Read the storage policy")
        : a.action === "set"
          ? cls("sensitive-write", "project.storage_policy", a.projectId, "Set the project's storage policy")
          : cls("delete", "project.storage_apply", a.projectId, "Delete expendable files under the storage policy now"),
    handler: async (a, ctx) => {
      const path = `/api/projects/${a.projectId}/storage`;
      if (a.action === "get") return { data: await ctx.invoke("GET", path) };
      if (a.action === "apply") return { data: await ctx.invoke("POST", `${path}/apply`) };
      if (!a.policy) throw toolError(400, "bad_request", "policy is required for set");
      return { data: await ctx.invoke("PUT", path, { body: a.policy }) };
    },
  }),

  defineMcpTool({
    name: "prompt_lab",
    title: "Prompt lab",
    description:
      "A project's own rules for its built-in prompts (chapter planning, panel prompts, narration; extra rules appended to panel image prompts). list: the prompts for this project's format, each with its built-in rules, the active version and all versions. preview: the compiled prompt with rules (unsaved, a version, or the active one) and its diff from the built-in; panel images need panelIds (up to 3). save: rules (and a note) as the next version, made active. activate: a version, or 0 for the built-in. The template header, the data rule and the answer format can never be changed.",
    input: z.object({
      action: z.enum(["list", "preview", "save", "activate"]),
      projectId: Uuid,
      template: z.string().max(40).optional().describe("For preview, save and activate: a name from list."),
      rules: z.string().max(30_000).optional(),
      note: z.string().max(200).optional(),
      version: z.number().int().min(0).optional(),
      panelIds: z.array(Uuid).max(3).optional(),
    }),
    output: Passthrough,
    scopes: ["projects:read"],
    scopesFor: (a) => (a.action === "save" || a.action === "activate" ? ["projects:write"] : ["projects:read"]),
    sensitivity: "sensitive-write",
    idempotent: false,
    routes: [
      "GET /api/projects/:projectId/prompt-lab",
      "POST /api/projects/:projectId/prompt-lab/:name",
      "POST /api/projects/:projectId/prompt-lab/:name/activate",
      "POST /api/projects/:projectId/prompt-lab/:name/preview",
    ],
    actionKeys: ["prompt.override"],
    classify: async (a) =>
      a.action === "save" || a.action === "activate"
        ? cls(
            "sensitive-write",
            "prompt.override",
            a.projectId,
            `Change the project's ${a.template ?? ""} prompt rules`,
          )
        : cls("read", "prompt.read", a.projectId, "Read the prompt lab"),
    handler: async (a, ctx) => {
      if (a.action === "list") return { data: await ctx.invoke("GET", `/api/projects/${a.projectId}/prompt-lab`) };
      if (!a.template) throw toolError(400, "bad_request", "template is required");
      const base = `/api/projects/${a.projectId}/prompt-lab/${encodeURIComponent(a.template)}`;
      if (a.action === "save")
        return { data: await ctx.invoke("POST", base, { body: { rules: a.rules ?? "", note: a.note } }) };
      if (a.action === "activate")
        return { data: await ctx.invoke("POST", `${base}/activate`, { body: { version: a.version ?? 0 } }) };
      return {
        data: await ctx.invoke("POST", `${base}/preview`, {
          body: { rules: a.rules, version: a.version || undefined, panelIds: a.panelIds ?? [] },
        }),
      };
    },
  }),
];
