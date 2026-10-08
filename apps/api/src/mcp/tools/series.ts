import { z } from "zod";
import { defineMcpTool, IdempotencyKey, Passthrough, type ToolContext } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { cls, requireCreate, Uuid } from "./common.ts";

/** A series spans projects, so only a connection that sees every project may read or change one. */
const requireAllProjects = (ctx: ToolContext) => {
  if (ctx.actor.projectAccess !== "all")
    throw toolError(
      403,
      "project_not_granted",
      "Series span several projects: only a connection with access to all projects can use them. The user can change that in OpenManga → Agent access.",
    );
};

export const seriesTools = [
  defineMcpTool({
    name: "list_series",
    title: "List series",
    description:
      "The user's series: projects that share one library (cast, places, props, style, story bible) and a channel profile. Each has a libraryProjectId, a project you read and edit with the usual project tools (list_library, manage_story_bible, project_style ...), and its episode count. Read-only; needs a connection with access to all projects.",
    input: z.object({}),
    output: z.object({ series: z.array(Passthrough) }),
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/series"],
    actionKeys: [],
    handler: async (_a, ctx) => {
      requireAllProjects(ctx);
      return { data: await ctx.invoke("GET", "/api/series") };
    },
  }),

  defineMcpTool({
    name: "get_series",
    title: "Get series",
    description:
      "A series dashboard: each episode's status, chapters, panels drawn, spend, exports, open comments and `behind` (library entries, style or facts it has not synced yet), with totals and the library's counts. With `appearances` { kind: character|location|prop, id: a library entry's id }, instead every appearance of that entry across the episodes, per chapter. Read-only.",
    input: z.object({
      seriesId: Uuid,
      appearances: z.object({ kind: z.enum(["character", "location", "prop"]), id: Uuid }).optional(),
    }),
    output: Passthrough,
    scopes: ["projects:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/series/:id", "GET /api/series/:id/appearances"],
    actionKeys: [],
    handler: async ({ seriesId, appearances }, ctx) => {
      requireAllProjects(ctx);
      return {
        data: appearances
          ? await ctx.invoke("GET", `/api/series/${seriesId}/appearances`, { query: appearances })
          : await ctx.invoke("GET", `/api/series/${seriesId}`),
      };
    },
  }),

  defineMcpTool({
    name: "manage_series",
    title: "Manage series",
    description:
      "Create and run series. action=create { title, description?, channelProfileId?, projectType?, format? } makes a series and its library project. update { seriesId, title?, description?, channelProfileId? }. add_episode { seriesId, title, story? } makes a new episode project linked to the whole library. adopt { seriesId, projectId, applyProfile? } makes one of the user's projects the next episode (same-named cast becomes linked). detach { seriesId, projectId }. sync { seriesId, projectId? } brings episodes in step with the library (new versions pointing at the same reference images). split { seriesId, story, perEpisode?, confirm? } splits a long story into episodes at its chapter headings (without confirm: a preview). Creating projects needs the connection's permission to create projects; everything may need the user's approval.",
    input: z.object({
      action: z.enum(["create", "update", "add_episode", "adopt", "detach", "sync", "split"]),
      seriesId: Uuid.optional(),
      projectId: Uuid.optional(),
      title: z.string().max(200).optional(),
      description: z.string().max(5000).optional(),
      channelProfileId: Uuid.nullable().optional(),
      projectType: z.string().max(40).optional(),
      format: z.string().max(20).optional(),
      story: z.string().max(2_000_000).optional(),
      perEpisode: z.number().int().min(1).max(50).optional(),
      applyProfile: z.boolean().optional(),
      confirm: z.boolean().optional(),
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["projects:write"],
    scopesFor: (a) =>
      a.action === "create" || a.action === "add_episode" || (a.action === "split" && a.confirm)
        ? ["projects:write", "projects:create"]
        : ["projects:write"],
    sensitivity: "sensitive-write",
    idempotent: false,
    routes: [
      "POST /api/series",
      "PATCH /api/series/:id",
      "POST /api/series/:id/episodes",
      "POST /api/series/:id/adopt",
      "POST /api/series/:id/episodes/:projectId/detach",
      "POST /api/series/:id/sync",
      "POST /api/series/:id/split",
    ],
    actionKeys: ["series.manage"],
    classify: async (a) =>
      cls(
        a.action === "sync" || a.action === "update" || (a.action === "split" && !a.confirm)
          ? "write"
          : "sensitive-write",
        `series.${a.action}`,
        a.projectId ?? null,
        a.action === "create" ? `Create series "${a.title ?? ""}"` : `Series: ${a.action.replace("_", " ")}`,
      ),
    handler: async (a, ctx) => {
      requireAllProjects(ctx);
      const need = (v: unknown, what: string) => {
        if (v === undefined || v === null || v === "") throw toolError(422, "validation_error", `${what} is required`);
      };
      if (a.action !== "create") need(a.seriesId, "seriesId");
      const base = `/api/series/${a.seriesId}`;
      switch (a.action) {
        case "create":
          requireCreate(ctx);
          need(a.title, "title");
          return {
            data: await ctx.invoke("POST", "/api/series", {
              body: {
                title: a.title,
                description: a.description ?? "",
                channelProfileId: a.channelProfileId ?? null,
                projectType: a.projectType,
                format: a.format,
              },
            }),
          };
        case "update":
          return {
            data: await ctx.invoke("PATCH", base, {
              body: { title: a.title, description: a.description, channelProfileId: a.channelProfileId },
            }),
          };
        case "add_episode":
          requireCreate(ctx);
          need(a.title, "title");
          return {
            data: await ctx.invoke("POST", `${base}/episodes`, {
              body: { title: a.title, ...(a.story ? { story: { content: a.story, inputKind: "story" } } : {}) },
            }),
          };
        case "adopt":
          need(a.projectId, "projectId");
          return {
            data: await ctx.invoke("POST", `${base}/adopt`, {
              body: { projectId: a.projectId, applyProfile: a.applyProfile ?? false },
            }),
          };
        case "detach":
          need(a.projectId, "projectId");
          return { data: await ctx.invoke("POST", `${base}/episodes/${a.projectId}/detach`, { body: {} }) };
        case "sync":
          return {
            data: await ctx.invoke("POST", `${base}/sync`, { body: a.projectId ? { projectId: a.projectId } : {} }),
          };
        case "split":
          need(a.story, "story");
          if (a.confirm) requireCreate(ctx);
          return {
            data: await ctx.invoke("POST", `${base}/split`, {
              body: { story: a.story, perEpisode: a.perEpisode ?? 3, confirm: a.confirm ?? false },
            }),
          };
      }
    },
  }),
];
