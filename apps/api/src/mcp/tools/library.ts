import {
  characterAliases,
  characters,
  characterVersions,
  eq,
  locations,
  locationVersions,
  props,
  propVersions,
  referenceAssets,
} from "@openmanga/db";
import { asPatch } from "@openmanga/schemas";
import { z } from "zod";
import { CreateCharacter, Migrate, OutfitInput } from "../../routes/characters.ts";
import { GenerateRef } from "../../routes/references.ts";
import { SetStyle } from "../../routes/world.ts";
import { defineMcpTool, IdempotencyKey, Passthrough, type ToolContext } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { cls, ImageAiInput, jobView, projectOf, restAi, stamp, Uuid } from "./common.ts";

const Kind = z.enum(["character", "location", "prop"]);
type Kind = z.infer<typeof Kind>;
const plural = { character: "characters", location: "locations", prop: "props" } as const;
const versionPath = { character: "character-versions", location: "location-versions", prop: "prop-versions" } as const;
const entityTable = { character: characters, location: locations, prop: props } as const;
const versionTable = { character: characterVersions, location: locationVersions, prop: propVersions } as const;

async function entityProject(ctx: ToolContext, kind: Kind, id: string) {
  const t = entityTable[kind];
  const [row] = await ctx.deps.db.select({ p: t.projectId }).from(t).where(eq(t.id, id));
  if (!row) throw toolError(404, "not_found", `${kind} not found`);
  return row.p;
}

async function versionProject(ctx: ToolContext, kind: Kind, versionId: string) {
  const v = versionTable[kind];
  const e = entityTable[kind];
  const fk =
    kind === "character"
      ? characterVersions.characterId
      : kind === "location"
        ? locationVersions.locationId
        : propVersions.propId;
  const [row] = await ctx.deps.db
    .select({ p: e.projectId, status: v.status, updatedAt: v.updatedAt })
    .from(v)
    .innerJoin(e, eq(e.id, fk))
    .where(eq(v.id, versionId));
  if (!row) throw toolError(404, "not_found", "Version not found");
  return { projectId: row.p, target: { status: row.status, updatedAt: row.updatedAt.toISOString() } };
}

export const libraryTools = [
  defineMcpTool({
    name: "list_library",
    title: "List cast, world and styles",
    description:
      "kind=characters: the cast with current version, status and reference readiness. kind=locations / props: the world entities. kind=styles: the project's style versions with references. kind=style_presets: built-in presets. Read-only.",
    input: z.object({
      projectId: Uuid,
      kind: z.enum(["characters", "locations", "props", "styles", "style_presets"]),
      trash: z.boolean().default(false).describe("Characters only: list trashed ones instead."),
    }),
    output: Passthrough,
    scopes: ["library:read"],
    sensitivity: "read",
    idempotent: true,
    routes: [
      "GET /api/projects/:projectId/characters",
      "GET /api/projects/:projectId/locations",
      "GET /api/projects/:projectId/props",
      "GET /api/projects/:projectId/style",
      "GET /api/style-presets",
    ],
    actionKeys: [],
    handler: async ({ projectId, kind, trash }, ctx) => {
      if (kind === "style_presets")
        return { data: await ctx.invoke("GET", "/api/style-presets", { query: { projectId } }) };
      if (kind === "styles") return { data: await ctx.invoke("GET", `/api/projects/${projectId}/style`) };
      return {
        data: await ctx.invoke("GET", `/api/projects/${projectId}/${kind}`, {
          query: trash ? { trash: 1 } : undefined,
        }),
      };
    },
  }),

  defineMcpTool({
    name: "get_library_item",
    title: "Get character / location / prop",
    description:
      "One character, location or prop with all its versions (draft / approved / locked / superseded), references and, for characters, aliases and outfits. Read-only.",
    input: z.object({ kind: Kind, id: Uuid }),
    output: Passthrough,
    scopes: ["library:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/characters/:id", "GET /api/locations/:id", "GET /api/props/:id"],
    actionKeys: [],
    handler: async ({ kind, id }, ctx) => ({ data: await ctx.invoke("GET", `/api/${plural[kind]}/${id}`) }),
  }),

  defineMcpTool({
    name: "create_library_item",
    title: "Create character / location / prop",
    description:
      "Add a character (name, role, description = visual bible fields, aliases), location or prop (name, description) to a project, with a first draft version. Normal write. The description fields are the same as get_answer_schema StoryAnalysis explains for characters/locations/props.",
    input: z.object({
      projectId: Uuid,
      kind: Kind,
      name: z.string().trim().min(1).max(120),
      role: CreateCharacter.shape.role.optional(),
      description: z.record(z.string(), z.unknown()).default({}),
      aliases: CreateCharacter.shape.aliases.optional(),
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["library:write"],
    sensitivity: "write",
    idempotent: false,
    routes: [
      "POST /api/projects/:projectId/characters",
      "POST /api/projects/:projectId/locations",
      "POST /api/projects/:projectId/props",
    ],
    actionKeys: ["character.create", "location.create", "prop.create"],
    classify: async ({ projectId, kind, name }) =>
      cls("write", `${kind}.create`, projectId, `Create ${kind} "${name}"`),
    handler: async ({ projectId, kind, name, role, description, aliases }, ctx) => ({
      data: await ctx.invoke("POST", `/api/projects/${projectId}/${plural[kind]}`, {
        body: kind === "character" ? { name, role, description, aliases } : { name, description },
      }),
    }),
  }),

  defineMcpTool({
    name: "update_library_item",
    title: "Rename / switch version / trash",
    description:
      "update: rename (and for characters change role). switch_version: make another version the current one (new panels and generation use it; existing panels keep theirs) — sensitive. trash / restore: move to or back from trash (trash is delete class).",
    input: z.object({
      kind: Kind,
      id: Uuid,
      action: z.enum(["update", "switch_version", "trash", "restore"]),
      name: z.string().trim().min(1).max(120).optional(),
      role: CreateCharacter.shape.role.optional(),
      currentVersionId: Uuid.optional(),
    }),
    output: Passthrough,
    scopes: ["library:write"],
    sensitivity: "delete",
    idempotent: true,
    routes: [
      "PATCH /api/characters/:id",
      "PATCH /api/locations/:id",
      "PATCH /api/props/:id",
      "DELETE /api/characters/:id",
      "POST /api/characters/:id/restore",
      "DELETE /api/locations/:id",
      "POST /api/locations/:id/restore",
      "DELETE /api/props/:id",
      "POST /api/props/:id/restore",
    ],
    actionKeys: [
      "character.update",
      "character.switch_version",
      "character.trash",
      "character.restore",
      "location.*",
      "prop.*",
    ],
    classify: async ({ kind, id, action }, ctx) => {
      const p = await entityProject(ctx, kind, id);
      const sensitivity = action === "trash" ? "delete" : action === "switch_version" ? "sensitive-write" : "write";
      return cls(sensitivity, `${kind}.${action}`, p, `${action.replace("_", " ")} ${kind}`, {
        target:
          sensitivity === "write"
            ? undefined
            : await stamp(ctx, entityTable[kind], id, ["currentVersionId", "deletedAt", "updatedAt"]),
      });
    },
    handler: async ({ kind, id, action, name, role, currentVersionId }, ctx) => {
      if (action === "trash") return { data: await ctx.invoke("DELETE", `/api/${plural[kind]}/${id}`) };
      if (action === "restore") return { data: await ctx.invoke("POST", `/api/${plural[kind]}/${id}/restore`) };
      const body =
        action === "switch_version" ? { currentVersionId } : kind === "character" ? { name, role } : { name };
      return { data: await ctx.invoke("PATCH", `/api/${plural[kind]}/${id}`, { body }) };
    },
  }),

  defineMcpTool({
    name: "manage_library_version",
    title: "Versions of a character / location / prop",
    description:
      "Approved and locked versions are immutable: to change one, create a new version (it starts as a draft copy of the current one), edit the draft, then approve it. create: new version (makeCurrent=true also switches the entity to it: sensitive). edit: change a DRAFT version's description (characters also immutableTraits, changeNote). set_status: approve / lock / supersede (sensitive; locking also locks its approved references). delete: delete a draft version no panel uses (delete class).",
    input: z.object({
      kind: Kind,
      action: z.enum(["create", "edit", "set_status", "delete"]),
      entityId: Uuid.optional().describe("For create."),
      versionId: Uuid.optional().describe("For edit, set_status, delete."),
      fromVersionId: Uuid.optional(),
      makeCurrent: z.boolean().default(true),
      description: z.record(z.string(), z.unknown()).optional(),
      immutableTraits: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
      changeNote: z.string().max(500).optional(),
      status: z.enum(["draft", "approved", "locked", "superseded"]).optional(),
    }),
    output: Passthrough,
    scopes: ["library:write"],
    sensitivity: "delete",
    idempotent: false,
    routes: [
      "POST /api/characters/:id/versions",
      "PATCH /api/character-versions/:id",
      "POST /api/character-versions/:id/status",
      "DELETE /api/character-versions/:id",
      "POST /api/locations/:id/versions",
      "PATCH /api/location-versions/:id",
      "POST /api/location-versions/:id/status",
      "POST /api/props/:id/versions",
      "PATCH /api/prop-versions/:id",
      "POST /api/prop-versions/:id/status",
    ],
    actionKeys: [
      "<kind>_version.create",
      "<kind>_version.create_current",
      "<kind>_version.edit",
      "<kind>_version.<status>",
      "<kind>_version.delete",
    ],
    classify: async (a, ctx) => {
      if (a.action === "create") {
        const p = await entityProject(ctx, a.kind, a.entityId ?? "");
        return a.makeCurrent
          ? cls(
              "sensitive-write",
              `${a.kind}_version.create_current`,
              p,
              `Create a new ${a.kind} version and make it current`,
              {
                target: await stamp(ctx, entityTable[a.kind], a.entityId!, ["currentVersionId", "updatedAt"]),
              },
            )
          : cls("write", `${a.kind}_version.create`, p, `Create a new draft ${a.kind} version`);
      }
      const { projectId, target } = await versionProject(ctx, a.kind, a.versionId ?? "");
      if (a.action === "edit")
        return cls("write", `${a.kind}_version.edit`, projectId, `Edit a draft ${a.kind} version`);
      if (a.action === "delete")
        return cls("delete", `${a.kind}_version.delete`, projectId, `Delete a draft ${a.kind} version`, { target });
      if (!a.status) throw toolError(400, "bad_request", "status is required");
      return cls(
        a.status === "draft" ? "write" : "sensitive-write",
        `${a.kind}_version.${a.status}`,
        projectId,
        `Set a ${a.kind} version to ${a.status}`,
        {
          target,
        },
      );
    },
    handler: async (a, ctx) => {
      const vp = versionPath[a.kind];
      if (a.action === "create")
        return {
          data: await ctx.invoke("POST", `/api/${plural[a.kind]}/${a.entityId}/versions`, {
            body: {
              fromVersionId: a.fromVersionId,
              description: a.description,
              makeCurrent: a.makeCurrent,
              ...(a.kind === "character" ? { immutableTraits: a.immutableTraits, changeNote: a.changeNote ?? "" } : {}),
            },
          }),
        };
      if (a.action === "edit")
        return {
          data: await ctx.invoke("PATCH", `/api/${vp}/${a.versionId}`, {
            body:
              a.kind === "character"
                ? { description: a.description, immutableTraits: a.immutableTraits, changeNote: a.changeNote }
                : { description: a.description },
          }),
        };
      if (a.action === "delete") return { data: await ctx.invoke("DELETE", `/api/${vp}/${a.versionId}`) };
      return { data: await ctx.invoke("POST", `/api/${vp}/${a.versionId}/status`, { body: { status: a.status } }) };
    },
  }),

  defineMcpTool({
    name: "manage_character_details",
    title: "Aliases and outfits",
    description:
      "add_alias / remove_alias: names the story also uses for a character. add_outfit / update_outfit / delete_outfit: outfit variants (name, description, isDefault, optionally tied to a version). outfit_timeline: every outfit change of the character in reading order (read-only). Normal writes; delete_outfit is delete class.",
    input: z.object({
      action: z.enum(["add_alias", "remove_alias", "add_outfit", "update_outfit", "delete_outfit", "outfit_timeline"]),
      characterId: Uuid.optional(),
      aliasId: Uuid.optional(),
      alias: z.string().trim().min(1).max(120).optional(),
      outfitId: Uuid.optional(),
      outfit: asPatch(OutfitInput)
        .optional()
        .describe("add_outfit needs name; update_outfit changes only the fields sent."),
    }),
    output: Passthrough,
    scopes: ["library:read", "library:write"],
    scopesFor: (a) => (a.action === "outfit_timeline" ? ["library:read"] : ["library:write"]),
    sensitivity: "delete",
    idempotent: false,
    routes: [
      "POST /api/characters/:id/aliases",
      "DELETE /api/character-aliases/:id",
      "POST /api/characters/:id/outfits",
      "PATCH /api/character-outfits/:id",
      "DELETE /api/character-outfits/:id",
      "GET /api/characters/:id/outfit-timeline",
    ],
    actionKeys: ["character.alias", "character.outfit", "character.outfit_delete"],
    classify: async (a, ctx) => {
      if (a.action === "remove_alias") {
        const [al] = await ctx.deps.db
          .select({ c: characterAliases.characterId })
          .from(characterAliases)
          .where(eq(characterAliases.id, a.aliasId ?? ""));
        if (!al) throw toolError(404, "not_found", "Alias not found");
        return cls("write", "character.alias", await projectOf(ctx, "character", al.c), "Remove an alias");
      }
      if (a.action === "update_outfit" || a.action === "delete_outfit") {
        const p = await projectOf(ctx, "outfit", a.outfitId ?? "");
        return a.action === "delete_outfit"
          ? cls("delete", "character.outfit_delete", p, "Delete an outfit")
          : cls("write", "character.outfit", p, "Edit an outfit");
      }
      const p = await projectOf(ctx, "character", a.characterId ?? "");
      if (a.action === "outfit_timeline") return cls("read", "character.outfit_timeline", p, "Outfit timeline");
      return cls(
        "write",
        a.action === "add_alias" ? "character.alias" : "character.outfit",
        p,
        a.action.replace("_", " "),
      );
    },
    handler: async (a, ctx) => {
      switch (a.action) {
        case "add_alias":
          return {
            data: await ctx.invoke("POST", `/api/characters/${a.characterId}/aliases`, { body: { alias: a.alias } }),
          };
        case "remove_alias":
          return { data: await ctx.invoke("DELETE", `/api/character-aliases/${a.aliasId}`) };
        case "add_outfit":
          return {
            data: await ctx.invoke("POST", `/api/characters/${a.characterId}/outfits`, { body: a.outfit ?? {} }),
          };
        case "update_outfit":
          return { data: await ctx.invoke("PATCH", `/api/character-outfits/${a.outfitId}`, { body: a.outfit ?? {} }) };
        case "delete_outfit":
          return { data: await ctx.invoke("DELETE", `/api/character-outfits/${a.outfitId}`) };
        case "outfit_timeline":
          return { data: await ctx.invoke("GET", `/api/characters/${a.characterId}/outfit-timeline`) };
      }
    },
  }),

  defineMcpTool({
    name: "migrate_character_panels",
    title: "Migrate panels to another character version",
    description:
      "Explicitly move panels (all of them, or panelIds) from one version of a character to another, so they are drawn with the new appearance on their next generation. Refused when the target version has no approved reference unless force=true (panels then lose identity pinning). Sensitive: may need approval. Nothing is regenerated.",
    input: Migrate.extend({ characterId: Uuid }),
    output: Passthrough,
    scopes: ["library:write", "panels:write"],
    sensitivity: "sensitive-write",
    idempotent: true,
    routes: ["POST /api/characters/:id/migrate-panels"],
    actionKeys: ["character_version.migrate_panels"],
    classify: async ({ characterId, toVersionId, panelIds }, ctx) => {
      const p = await projectOf(ctx, "character", characterId);
      return cls(
        "sensitive-write",
        "character_version.migrate_panels",
        p,
        `Move ${panelIds?.length ?? "all"} panels of a character to another version`,
        {
          target: (await versionProject(ctx, "character", toVersionId)).target,
        },
      );
    },
    handler: async ({ characterId, ...body }, ctx) => ({
      data: await ctx.invoke("POST", `/api/characters/${characterId}/migrate-panels`, { body }),
    }),
  }),

  defineMcpTool({
    name: "manage_references",
    title: "Reference images",
    description:
      "generate: queue a reference image for a character/location/prop version or a project style (kind: portrait, full_body, multi-angle and the other reference kinds; optional outfit for characters). Spends image-provider credits (may need approval); asynchronous, returns a job. set_status: approve / lock / unapprove a reference (approval makes it the identity reference sent with panel generation; sensitive). make_primary: make it the version's primary reference (sensitive). trash: move it to trash (delete class). Uploading your own reference needs the OpenManga UI.",
    input: z.object({
      action: z.enum(["generate", "set_status", "make_primary", "trash"]),
      subject: z.enum(["character", "location", "prop", "style"]).optional().describe("For generate."),
      versionId: Uuid.optional().describe("For generate: the version (or project style) id."),
      referenceId: Uuid.optional().describe("For set_status, make_primary, trash."),
      generate: GenerateRef.omit({ ai: true }).optional(),
      status: z.enum(["draft", "approved", "locked", "superseded"]).optional(),
      ai: ImageAiInput,
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["library:write", "generations:run"],
    scopesFor: (a) => (a.action === "generate" ? ["library:write", "generations:run"] : ["library:write"]),
    sensitivity: "spend",
    idempotent: false,
    routes: [
      "POST /api/character-versions/:id/references/generate",
      "POST /api/location-versions/:id/references/generate",
      "POST /api/prop-versions/:id/references/generate",
      "POST /api/project-styles/:id/references/generate",
      "POST /api/references/:id/status",
      "POST /api/references/:id/primary",
      "DELETE /api/references/:id",
    ],
    actionKeys: ["reference.generate", "reference.<status>", "reference.primary", "reference.trash"],
    classify: async (a, ctx) => {
      if (a.action === "generate") {
        if (!a.subject || !a.versionId) throw toolError(400, "bad_request", "subject and versionId are required");
        const p =
          a.subject === "style"
            ? await projectOf(ctx, "project_style", a.versionId)
            : (await versionProject(ctx, a.subject, a.versionId)).projectId;
        return cls(
          "spend",
          "reference.generate",
          p,
          `Generate a ${a.generate?.kind ?? "full_body"} ${a.subject} reference; spends image-provider credits`,
        );
      }
      const p = await projectOf(ctx, "reference", a.referenceId ?? "");
      const target = await stamp(ctx, referenceAssets, a.referenceId!, ["status", "isPrimary"]);
      if (a.action === "trash") return cls("delete", "reference.trash", p, "Trash a reference image", { target });
      if (a.action === "make_primary")
        return cls("sensitive-write", "reference.primary", p, "Make a reference the primary one", { target });
      if (!a.status) throw toolError(400, "bad_request", "status is required");
      return cls(
        a.status === "draft" ? "write" : "sensitive-write",
        `reference.${a.status}`,
        p,
        `Set a reference to ${a.status}`,
        { target },
      );
    },
    handler: async (a, ctx) => {
      if (a.action === "generate") {
        const base = a.subject === "style" ? "project-styles" : versionPath[a.subject as Kind];
        const r = await ctx.invoke<{ job?: Record<string, unknown> }>(
          "POST",
          `/api/${base}/${a.versionId}/references/generate`,
          {
            body: { ...(a.generate ?? {}), ai: await restAi(ctx, a.ai) },
          },
        );
        return { data: r.job ? { ...r, job: jobView(r.job) } : r };
      }
      if (a.action === "trash") return { data: await ctx.invoke("DELETE", `/api/references/${a.referenceId}`) };
      if (a.action === "make_primary")
        return { data: await ctx.invoke("POST", `/api/references/${a.referenceId}/primary`) };
      return {
        data: await ctx.invoke("POST", `/api/references/${a.referenceId}/status`, { body: { status: a.status } }),
      };
    },
  }),

  defineMcpTool({
    name: "project_style",
    title: "Project style",
    description:
      "get: the project's style history with references. set: a new style version from a preset key and/or a custom description/definition; it becomes current, so all later generation uses it (sensitive). make_current: switch back to an earlier style version (sensitive).",
    input: z.object({
      projectId: Uuid.optional().describe("For get and set."),
      action: z.enum(["get", "set", "make_current"]),
      style: SetStyle.optional(),
      styleId: Uuid.optional().describe("For make_current."),
    }),
    output: Passthrough,
    scopes: ["library:read", "library:write"],
    scopesFor: (a) => (a.action === "get" ? ["library:read"] : ["library:write"]),
    sensitivity: "sensitive-write",
    idempotent: false,
    routes: [
      "GET /api/projects/:projectId/style",
      "POST /api/projects/:projectId/style",
      "POST /api/project-styles/:id/make-current",
    ],
    actionKeys: ["style.set", "style.make_current"],
    classify: async (a, ctx) => {
      if (a.action === "make_current")
        return cls(
          "sensitive-write",
          "style.make_current",
          await projectOf(ctx, "project_style", a.styleId ?? ""),
          "Switch the project to an earlier style",
        );
      if (!a.projectId) throw toolError(400, "bad_request", "projectId is required");
      return a.action === "get"
        ? cls("read", "style.get", a.projectId, "Read style")
        : cls(
            "sensitive-write",
            "style.set",
            a.projectId,
            `Set a new project style (${a.style?.stylePresetKey ?? "custom"})`,
          );
    },
    handler: async (a, ctx) => {
      if (a.action === "get") return { data: await ctx.invoke("GET", `/api/projects/${a.projectId}/style`) };
      if (a.action === "set")
        return { data: await ctx.invoke("POST", `/api/projects/${a.projectId}/style`, { body: a.style ?? {} }) };
      return { data: await ctx.invoke("POST", `/api/project-styles/${a.styleId}/make-current`) };
    },
  }),
];
