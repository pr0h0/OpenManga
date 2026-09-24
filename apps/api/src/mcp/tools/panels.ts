import { count, eq, inArray, pages, panels } from "@openmanga/db";
import { z } from "zod";
import {
  AddPanel,
  ApplyLettering,
  CreatePage,
  DocumentPatch,
  GenerateInput,
  NewDialogue,
  NewSfx,
  PatchDialogue,
  PatchPage,
  PatchPanel,
  SetOutfit,
} from "../../routes/pages.ts";
import { defineMcpTool, IdempotencyKey, Passthrough, type ToolContext } from "../registry.ts";
import { toolError } from "../runtime.ts";
import {
  AiInput,
  aiLabel,
  cls,
  ImageAiInput,
  jobView,
  links,
  projectOf,
  restAi,
  stamp,
  textSpend,
  Uuid,
} from "./common.ts";

type Jobbed = { job: Record<string, unknown> & { id: string; projectId: string } };

/** How many panels a chapter- or project-wide lettering change touches, to decide whether it is a bulk edit. */
async function panelCount(ctx: ToolContext, pageId: string, scope: "page" | "chapter" | "project") {
  const [pg] = await ctx.deps.db.select().from(pages).where(eq(pages.id, pageId));
  if (!pg) throw toolError(404, "not_found", "Page not found");
  const where =
    scope === "page"
      ? eq(panels.pageId, pageId)
      : scope === "chapter"
        ? inArray(
            panels.pageId,
            ctx.deps.db.select({ id: pages.id }).from(pages).where(eq(pages.chapterId, pg.chapterId)),
          )
        : eq(panels.projectId, pg.projectId);
  const [n] = await ctx.deps.db.select({ n: count() }).from(panels).where(where);
  return n?.n ?? 0;
}

export const panelTools = [
  defineMcpTool({
    name: "get_page",
    title: "Get page",
    description:
      "One page's editor document: its panels with their current specs, speech bubbles, SFX and on-page narration boxes, the chapter and neighbouring pages. Read-only.",
    input: z.object({ pageId: Uuid }),
    output: Passthrough,
    scopes: ["chapters:read", "panels:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/pages/:id"],
    actionKeys: [],
    handler: async ({ pageId }, ctx) => {
      const r = await ctx.invoke<Record<string, unknown> & { page: { projectId: string } }>(
        "GET",
        `/api/pages/${pageId}`,
      );
      return { data: r, links: { page: links(ctx).page(r.page.projectId, pageId) } };
    },
  }),

  defineMcpTool({
    name: "manage_page",
    title: "Edit pages",
    description:
      "create: add a page to a chapter with a layout template. update: edit the page plan (purpose, pacing, emphasis, hook, size, status, scene, order). set_layout: swap the layout template (keeps panels, adds empty ones if needed). add_panel: add a panel (or duplicate one). reorder_panels: set the reading order. update_document: move/resize/reorder panels and commit bubble/SFX/caption geometry in one atomic write (replaces those values; sensitive). delete: remove the page (delete class).",
    input: z.object({
      action: z.enum(["create", "update", "set_layout", "add_panel", "reorder_panels", "update_document", "delete"]),
      chapterId: Uuid.optional().describe("For create."),
      pageId: Uuid.optional().describe("For every other action."),
      create: CreatePage.optional(),
      update: PatchPage.optional(),
      layoutTemplate: z.string().max(64).optional(),
      addPanel: AddPanel.optional(),
      panelIds: z
        .array(Uuid)
        .min(1)
        .max(50)
        .optional()
        .describe("For reorder_panels: every panel id, in reading order."),
      document: DocumentPatch.optional(),
    }),
    output: Passthrough,
    scopes: ["chapters:write", "panels:write"],
    scopesFor: (a) =>
      a.action === "create" || a.action === "update" || a.action === "delete" || a.action === "set_layout"
        ? ["chapters:write"]
        : ["panels:write"],
    sensitivity: "delete",
    idempotent: false,
    routes: [
      "POST /api/chapters/:id/pages",
      "PATCH /api/pages/:id",
      "POST /api/pages/:id/layout",
      "POST /api/pages/:id/panels",
      "POST /api/pages/:id/reorder-panels",
      "PATCH /api/pages/:id/document",
      "DELETE /api/pages/:id",
    ],
    actionKeys: [
      "page.create",
      "page.update",
      "page.layout",
      "panel.create",
      "page.reorder",
      "page.document",
      "page.delete",
    ],
    classify: async (a, ctx) => {
      if (a.action === "create")
        return cls("write", "page.create", await projectOf(ctx, "chapter", a.chapterId ?? ""), "Add a page");
      const p = await projectOf(ctx, "page", a.pageId ?? "");
      if (a.action === "delete")
        return cls("delete", "page.delete", p, "Delete a page and its panels", {
          target: await stamp(ctx, pages, a.pageId!),
        });
      if (a.action === "update_document")
        return cls("sensitive-write", "page.document", p, "Replace the page's panel and lettering geometry", {
          target: await stamp(ctx, pages, a.pageId!),
        });
      const key = {
        update: "page.update",
        set_layout: "page.layout",
        add_panel: "panel.create",
        reorder_panels: "page.reorder",
      }[a.action];
      return cls("write", key, p, `Page: ${a.action}`);
    },
    handler: async (a, ctx) => {
      const id = a.pageId;
      switch (a.action) {
        case "create":
          return { data: await ctx.invoke("POST", `/api/chapters/${a.chapterId}/pages`, { body: a.create ?? {} }) };
        case "update":
          return { data: await ctx.invoke("PATCH", `/api/pages/${id}`, { body: a.update ?? {} }) };
        case "set_layout":
          return {
            data: await ctx.invoke("POST", `/api/pages/${id}/layout`, { body: { layoutTemplate: a.layoutTemplate } }),
          };
        case "add_panel":
          return { data: await ctx.invoke("POST", `/api/pages/${id}/panels`, { body: a.addPanel ?? {} }) };
        case "reorder_panels":
          return {
            data: await ctx.invoke("POST", `/api/pages/${id}/reorder-panels`, { body: { panelIds: a.panelIds } }),
          };
        case "update_document":
          return { data: await ctx.invoke("PATCH", `/api/pages/${id}/document`, { body: a.document ?? {} }) };
        case "delete":
          return { data: await ctx.invoke("DELETE", `/api/pages/${id}`) };
      }
    },
  }),

  defineMcpTool({
    name: "manage_lettering",
    title: "Lettering",
    description:
      "App lettering: text drawn by OpenManga over the artwork (no image calls, nothing spent). letter_from_plan: place the dialogue and SFX the chapter plan kept for each panel of the page. add_dialogue / update_dialogue: a speech bubble (auto-placed without geometry). add_sfx: a vector sound effect. apply_defaults: apply the project's lettering style/fit to a page, chapter or project. clear: remove bubbles, SFX and on-page captions from a page, chapter or project (narration lines and audio are kept). Chapter- or project-wide changes over many panels are sensitive.",
    input: z.object({
      action: z.enum(["letter_from_plan", "add_dialogue", "update_dialogue", "add_sfx", "apply_defaults", "clear"]),
      pageId: Uuid.optional().describe("Every action except update_dialogue."),
      dialogueId: Uuid.optional().describe("For update_dialogue."),
      dialogue: NewDialogue.optional(),
      dialogueUpdate: PatchDialogue.optional(),
      sfx: NewSfx.optional(),
      applyDefaults: ApplyLettering.optional(),
      scope: z.enum(["page", "chapter", "project"]).default("page").describe("For clear."),
    }),
    output: Passthrough,
    scopes: ["panels:write"],
    sensitivity: "sensitive-write",
    idempotent: false,
    routes: [
      "POST /api/pages/:id/letter-from-plan",
      "POST /api/pages/:id/dialogue",
      "PATCH /api/dialogue/:id",
      "POST /api/pages/:id/sfx",
      "POST /api/pages/:id/lettering/apply-defaults",
      "POST /api/pages/:id/lettering/clear",
    ],
    actionKeys: ["lettering.from_plan", "lettering.edit", "lettering.apply_defaults", "lettering.clear"],
    classify: async (a, ctx) => {
      if (a.action === "update_dialogue") {
        const { dialogueLines } = await import("@openmanga/db");
        const [d] = await ctx.deps.db
          .select({ p: dialogueLines.projectId })
          .from(dialogueLines)
          .where(eq(dialogueLines.id, a.dialogueId ?? ""));
        if (!d) throw toolError(404, "not_found", "Bubble not found");
        return cls("write", "lettering.edit", d.p, "Edit a speech bubble");
      }
      const p = await projectOf(ctx, "page", a.pageId ?? "");
      if (a.action === "clear" || a.action === "apply_defaults") {
        const scope = a.action === "clear" ? a.scope : (a.applyDefaults?.scope ?? "page");
        const n = await panelCount(ctx, a.pageId!, scope);
        const big = scope !== "page" && n > ctx.deps.config.MCP_BULK_APPROVAL_THRESHOLD;
        const key = a.action === "clear" ? "lettering.clear" : "lettering.apply_defaults";
        return cls(
          big || (a.action === "clear" && scope !== "page") ? "sensitive-write" : "write",
          key,
          p,
          `${a.action === "clear" ? "Clear" : "Restyle"} lettering on the ${scope} (${n} panels)`,
        );
      }
      return cls(
        "write",
        a.action === "letter_from_plan" ? "lettering.from_plan" : "lettering.edit",
        p,
        `Lettering: ${a.action}`,
      );
    },
    handler: async (a, ctx) => {
      switch (a.action) {
        case "letter_from_plan":
          return { data: await ctx.invoke("POST", `/api/pages/${a.pageId}/letter-from-plan`) };
        case "add_dialogue":
          return { data: await ctx.invoke("POST", `/api/pages/${a.pageId}/dialogue`, { body: a.dialogue }) };
        case "update_dialogue":
          return { data: await ctx.invoke("PATCH", `/api/dialogue/${a.dialogueId}`, { body: a.dialogueUpdate ?? {} }) };
        case "add_sfx":
          return { data: await ctx.invoke("POST", `/api/pages/${a.pageId}/sfx`, { body: a.sfx }) };
        case "apply_defaults":
          return {
            data: await ctx.invoke("POST", `/api/pages/${a.pageId}/lettering/apply-defaults`, {
              body: a.applyDefaults ?? {},
            }),
          };
        case "clear":
          return {
            data: await ctx.invoke("POST", `/api/pages/${a.pageId}/lettering/clear`, { body: { scope: a.scope } }),
          };
      }
    },
  }),

  defineMcpTool({
    name: "get_panel",
    title: "Get panel",
    description:
      "One panel: fields (shot, camera, story beat, cast/location/prop versions, prompt override, approval), its current PanelSpec (full history with includeSpecHistory), artwork versions, recent jobs and the cast's names. Read-only.",
    input: z.object({ panelId: Uuid, includeSpecHistory: z.boolean().default(false) }),
    output: Passthrough,
    scopes: ["panels:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/panels/:id"],
    actionKeys: [],
    handler: async ({ panelId, includeSpecHistory }, ctx) => {
      const r = await ctx.invoke<{
        panel: { projectId: string; pageId: string };
        specs: unknown[];
        jobs: Record<string, unknown>[];
      }>("GET", `/api/panels/${panelId}`);
      return {
        data: {
          ...r,
          specs: includeSpecHistory ? r.specs : r.specs.slice(0, 1),
          specVersions: r.specs.length,
          jobs: r.jobs.slice(0, 10).map(jobView),
        },
        links: { panel: links(ctx).panel(r.panel.projectId, r.panel.pageId, panelId) },
      };
    },
  }),

  defineMcpTool({
    name: "update_panel",
    title: "Update panel",
    description:
      "Edit a panel: shot type, camera angle, story beat, cast (characterVersionIds), location and prop versions, prompt override, frame, scene, approval status; and/or save a new PanelSpec version (`spec`: the whole spec object, shaped like get_panel specs[0].spec). Locked panels are read-only. Setting approvalStatus to approved/locked is sensitive. Nothing is generated; use generate_panel for artwork.",
    input: PatchPanel.extend({
      panelId: Uuid,
      spec: z
        .record(z.string(), z.unknown())
        .optional()
        .describe("A complete PanelSpec to save as a new spec version."),
    }),
    output: Passthrough,
    scopes: ["panels:write"],
    sensitivity: "sensitive-write",
    idempotent: true,
    routes: ["PATCH /api/panels/:id", "PUT /api/panels/:id/spec"],
    actionKeys: ["panel.update", "panel.approve"],
    classify: async ({ panelId, approvalStatus }, ctx) => {
      const p = await projectOf(ctx, "panel", panelId);
      const approving = approvalStatus === "approved" || approvalStatus === "locked";
      return cls(
        approving ? "sensitive-write" : "write",
        approving ? "panel.approve" : "panel.update",
        p,
        approving ? `Set the panel to ${approvalStatus}` : "Edit a panel",
        {
          target: approving ? await stamp(ctx, panels, panelId, ["approvalStatus", "updatedAt"]) : undefined,
        },
      );
    },
    handler: async ({ panelId, spec, ...patch }, ctx) => {
      const out: Record<string, unknown> = {};
      if (Object.keys(patch).length)
        Object.assign(out, await ctx.invoke("PATCH", `/api/panels/${panelId}`, { body: patch }));
      if (spec) Object.assign(out, await ctx.invoke("PUT", `/api/panels/${panelId}/spec`, { body: { spec } }));
      return { data: out };
    },
  }),

  defineMcpTool({
    name: "manage_panel_outfits",
    title: "Panel outfits",
    description:
      "get: what each character on the panel wears, where that was decided, and the outfits they could wear. set: dress a character in an outfit from this panel onward (until the next change, across chapters) or on this panel only. remove: delete an outfit change (assignmentId); the panels it covered fall back to the previous one.",
    input: z.object({
      action: z.enum(["get", "set", "remove"]),
      panelId: Uuid.optional(),
      set: SetOutfit.optional(),
      assignmentId: Uuid.optional(),
    }),
    output: Passthrough,
    scopes: ["panels:read", "panels:write"],
    scopesFor: (a) => (a.action === "get" ? ["panels:read"] : ["panels:write"]),
    sensitivity: "write",
    idempotent: true,
    routes: ["GET /api/panels/:id/outfits", "PUT /api/panels/:id/outfits", "DELETE /api/outfit-assignments/:id"],
    actionKeys: ["panel.outfit"],
    classify: async (a, ctx) => {
      if (a.action === "remove") {
        const { outfitAssignments } = await import("@openmanga/db");
        const [o] = await ctx.deps.db
          .select({ p: outfitAssignments.projectId })
          .from(outfitAssignments)
          .where(eq(outfitAssignments.id, a.assignmentId ?? ""));
        if (!o) throw toolError(404, "not_found", "Outfit change not found");
        return cls("write", "panel.outfit", o.p, "Remove an outfit change");
      }
      const p = await projectOf(ctx, "panel", a.panelId ?? "");
      return cls(a.action === "get" ? "read" : "write", "panel.outfit", p, "Change what a character wears");
    },
    handler: async (a, ctx) => {
      if (a.action === "get") return { data: await ctx.invoke("GET", `/api/panels/${a.panelId}/outfits`) };
      if (a.action === "set")
        return { data: await ctx.invoke("PUT", `/api/panels/${a.panelId}/outfits`, { body: a.set }) };
      return { data: await ctx.invoke("DELETE", `/api/outfit-assignments/${a.assignmentId}`) };
    },
  }),

  defineMcpTool({
    name: "get_panel_prompt",
    title: "Preview panel prompt",
    description:
      "The image prompt a panel would be generated with and its reference plan (which character/location/prop references are sent, at what size), without generating anything. Optionally for a specific saved key/model. Read-only.",
    input: z.object({ panelId: Uuid, credentialId: Uuid.optional(), model: z.string().max(200).optional() }),
    output: Passthrough,
    scopes: ["panels:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/panels/:id/prompt-preview"],
    actionKeys: [],
    handler: async ({ panelId, credentialId, model }, ctx) => ({
      data: await ctx.invoke("GET", `/api/panels/${panelId}/prompt-preview`, { query: { credentialId, model } }),
    }),
  }),

  defineMcpTool({
    name: "prepare_page_prompts",
    title: "Prepare page prompts",
    description:
      "Queue text-model preparation of the image prompts for every panel on a page (a PanelPromptDraft). Asynchronous: returns a job; poll get_job. Manual mode (ai.manual=true) asks you for the PanelPromptDraft via get_manual_prompt / submit_manual_answer; a provider run spends credits (may need approval).",
    input: z.object({ pageId: Uuid, ai: AiInput, batch: z.boolean().optional(), idempotencyKey: IdempotencyKey }),
    output: z.object({ job: Passthrough }),
    scopes: ["panels:write", "generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/pages/:id/prepare-prompts"],
    actionKeys: ["page.prepare_prompts"],
    classify: async ({ pageId, ai }, ctx) =>
      cls(
        textSpend(ai, "write"),
        "page.prepare_prompts",
        await projectOf(ctx, "page", pageId),
        `Prepare the page's panel prompts ${aiLabel(ai)}`,
      ),
    handler: async ({ pageId, ai, batch }, ctx) => {
      const r = await ctx.invoke<Jobbed>("POST", `/api/pages/${pageId}/prepare-prompts`, {
        body: { ai: await restAi(ctx, ai), batch },
      });
      return { data: { job: jobView(r.job) }, links: { job: links(ctx).job(r.job.projectId, r.job.id) } };
    },
  }),

  defineMcpTool({
    name: "generate_panel",
    title: "Generate panel artwork",
    description:
      "Queue artwork generation for one panel. Always creates a new artwork version (older ones are kept) and spends the user's image-provider credits (may need approval). operation: same_prompt, or a regeneration variant with an instruction. Returns a generation job immediately; poll get_job. For many panels use estimate_bulk_generation + run_bulk_generation.",
    input: GenerateInput.omit({ ai: true }).extend({ panelId: Uuid, ai: ImageAiInput, idempotencyKey: IdempotencyKey }),
    output: z.object({ job: Passthrough }),
    scopes: ["generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/panels/:id/generate"],
    actionKeys: ["panel.generate"],
    classify: async ({ panelId, operation, ai }, ctx) =>
      cls(
        "spend",
        "panel.generate",
        await projectOf(ctx, "panel", panelId),
        `Generate artwork for a panel (${operation}) with ${ai?.provider ?? "the chosen image key"}; spends image-provider credits`,
        {
          target: await stamp(ctx, panels, panelId, ["approvalStatus", "updatedAt"]),
        },
      ),
    handler: async ({ panelId, ai, idempotencyKey: _k, ...body }, ctx) => {
      const r = await ctx.invoke<Jobbed>("POST", `/api/panels/${panelId}/generate`, {
        body: { ...body, ai: await restAi(ctx, ai) },
      });
      return { data: { job: jobView(r.job) }, links: { job: links(ctx).job(r.job.projectId, r.job.id) } };
    },
  }),

  defineMcpTool({
    name: "manage_panel_artwork",
    title: "Panel artwork versions",
    description:
      "list: a panel's artwork versions. activate: make an earlier version the panel's active artwork (sensitive). trash: move an old, inactive version to trash (delete class). Masked edits and uploading your own artwork need the OpenManga UI.",
    input: z.object({ action: z.enum(["list", "activate", "trash"]), panelId: Uuid, assetId: Uuid.optional() }),
    output: Passthrough,
    scopes: ["panels:read", "panels:write"],
    scopesFor: (a) => (a.action === "list" ? ["panels:read"] : ["panels:write"]),
    sensitivity: "delete",
    idempotent: true,
    routes: [
      "GET /api/panels/:id/versions",
      "POST /api/panels/:id/versions/:assetId/activate",
      "DELETE /api/panels/:id/versions/:assetId",
    ],
    actionKeys: ["panel.artwork_activate", "panel.artwork_trash"],
    classify: async ({ action, panelId }, ctx) => {
      const p = await projectOf(ctx, "panel", panelId);
      if (action === "list") return cls("read", "panel.artwork_list", p, "List artwork");
      return cls(
        action === "activate" ? "sensitive-write" : "delete",
        action === "activate" ? "panel.artwork_activate" : "panel.artwork_trash",
        p,
        action === "activate" ? "Switch the panel's active artwork" : "Trash an old artwork version",
        {
          target: await stamp(ctx, panels, panelId, ["activeArtworkAssetId", "updatedAt"]),
        },
      );
    },
    handler: async ({ action, panelId, assetId }, ctx) => {
      if (action === "list") return { data: await ctx.invoke("GET", `/api/panels/${panelId}/versions`) };
      if (!assetId) throw toolError(400, "bad_request", "assetId is required");
      if (action === "activate")
        return { data: await ctx.invoke("POST", `/api/panels/${panelId}/versions/${assetId}/activate`) };
      return { data: await ctx.invoke("DELETE", `/api/panels/${panelId}/versions/${assetId}`) };
    },
  }),

  defineMcpTool({
    name: "run_panel_check",
    title: "Check panel artwork",
    description:
      "Queue a vision consistency check of a panel's active artwork (expected cast and headcount; a PanelCheck). Asynchronous: returns a job; poll get_job. Manual mode shows you the image in get_manual_prompt and asks for the PanelCheck answer; a provider run spends credits (may need approval). dismiss_review instead clears the panel's review flag.",
    input: z.object({
      panelId: Uuid,
      action: z.enum(["check", "dismiss_review"]).default("check"),
      ai: AiInput,
      batch: z.boolean().optional(),
    }),
    output: Passthrough,
    scopes: ["panels:write", "generations:run"],
    scopesFor: (a) => (a.action === "dismiss_review" ? ["panels:write"] : ["generations:run"]),
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/panels/:id/check", "POST /api/panels/:id/review/dismiss"],
    actionKeys: ["panel.check", "panel.review_dismiss"],
    classify: async ({ panelId, action, ai }, ctx) => {
      const p = await projectOf(ctx, "panel", panelId);
      return action === "dismiss_review"
        ? cls("write", "panel.review_dismiss", p, "Clear the panel's review flag")
        : cls(textSpend(ai, "write"), "panel.check", p, `Check the panel's artwork ${aiLabel(ai)}`);
    },
    handler: async ({ panelId, action, ai, batch }, ctx) => {
      if (action === "dismiss_review")
        return { data: await ctx.invoke("POST", `/api/panels/${panelId}/review/dismiss`) };
      const r = await ctx.invoke<Jobbed>("POST", `/api/panels/${panelId}/check`, {
        body: { ai: await restAi(ctx, ai), batch },
      });
      return { data: { job: jobView(r.job) } };
    },
  }),

  defineMcpTool({
    name: "manage_panel",
    title: "Split / delete panel",
    description:
      "split: split a panel into two (horizontal or vertical). delete: remove a panel (delete class, may need approval).",
    input: z.object({
      action: z.enum(["split", "delete"]),
      panelId: Uuid,
      direction: z.enum(["horizontal", "vertical"]).optional(),
    }),
    output: Passthrough,
    scopes: ["panels:write"],
    sensitivity: "delete",
    idempotent: false,
    routes: ["POST /api/panels/:id/split", "DELETE /api/panels/:id"],
    actionKeys: ["panel.split", "panel.delete"],
    classify: async ({ action, panelId }, ctx) => {
      const p = await projectOf(ctx, "panel", panelId);
      return action === "delete"
        ? cls("delete", "panel.delete", p, "Delete a panel", { target: await stamp(ctx, panels, panelId) })
        : cls("write", "panel.split", p, "Split a panel");
    },
    handler: async ({ action, panelId, direction }, ctx) =>
      action === "delete"
        ? { data: await ctx.invoke("DELETE", `/api/panels/${panelId}`) }
        : {
            data: await ctx.invoke("POST", `/api/panels/${panelId}/split`, {
              body: { direction: direction ?? "horizontal" },
            }),
          },
  }),
];
