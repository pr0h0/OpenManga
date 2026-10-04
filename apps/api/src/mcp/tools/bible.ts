import { ProposedFact, ProposedState } from "@openmanga/schemas";
import { z } from "zod";
import { FactPatch, StatePatch } from "../../routes/bible.ts";
import { defineMcpTool, IdempotencyKey, Passthrough } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { AiInput, aiLabel, cls, jobView, links, projectOf, restAi, textSpend, Uuid } from "./common.ts";

const continuityTools = [
  defineMcpTool({
    name: "run_continuity_check",
    title: "Check continuity",
    description:
      "Compare one chapter (chapterId) or every chapter with panels or narration against the story bible (facts, character states, fixed rules) and the neighbouring chapters: one text job per chapter. Without confirm=true returns only the chapter count and estimated cost; with it, queues the jobs (asynchronous; poll get_job, then get_continuity_report). Findings replace the chapter's open ones; each fixed rule gets pass/warn/fail. ai.manual=true (no provider, no spending) asks you for a ContinuityReport per chapter via get_manual_prompt / submit_manual_answer; a provider run spends the user's credits (may need approval).",
    input: z.object({
      projectId: Uuid,
      chapterId: Uuid.optional(),
      confirm: z.boolean().default(false),
      ai: AiInput,
      batch: z.boolean().optional(),
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["story:read", "generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/continuity-checks"],
    actionKeys: ["continuity.check"],
    classify: async ({ projectId, ai, confirm }) =>
      cls(
        confirm ? textSpend(ai, "write") : "read",
        "continuity.check",
        projectId,
        confirm ? `Check continuity ${aiLabel(ai)}` : "Estimate a continuity check",
      ),
    handler: async ({ projectId, chapterId, confirm, ai, batch }, ctx) => ({
      data: await ctx.invoke("POST", `/api/projects/${projectId}/continuity-checks`, {
        body: { chapterId, confirm, ai: await restAi(ctx, ai), batch },
      }),
      links: { bible: ctx.deps.urls.appUrl(`projects/${projectId}/bible`) },
    }),
  }),

  defineMcpTool({
    name: "get_continuity_report",
    title: "Get continuity report",
    description:
      "A project's continuity findings (severity, message, the quoted line or beat, the bible entry or neighbouring chapter it contradicts, where: a panel ref with panelId/pageId, a narration line, a scene or the chapter; status open, fixed, ignored or explained) and every fixed rule's pass/warn/fail per chapter from its latest check. Filter by chapterId and status (open, resolved, all). Read-only.",
    input: z.object({
      projectId: Uuid,
      chapterId: Uuid.optional(),
      status: z.enum(["open", "resolved", "all"]).default("open"),
    }),
    output: Passthrough,
    scopes: ["story:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/continuity"],
    actionKeys: [],
    handler: async ({ projectId, chapterId, status }, ctx) => ({
      data: await ctx.invoke("GET", `/api/projects/${projectId}/continuity`, {
        query: { status, ...(chapterId ? { chapterId } : {}) },
      }),
    }),
  }),
];

export const bibleTools = [
  defineMcpTool({
    name: "get_story_bible",
    title: "Get story bible",
    description:
      "A project's story bible: facts (kind, subject, text, chapter range by chapter id, fixed = a rule that must hold, visual = reaches image prompts) and character states (a character's injury, look, outfit, item, location, rank or knowledge from a chapter and optional scene number on), with the chapters and cast they refer to and the latest extraction job. With chapterId (and sceneNumber), also inEffect: exactly what planning and narration of that chapter receive. Read-only.",
    input: z.object({
      projectId: Uuid,
      chapterId: Uuid.optional(),
      sceneNumber: z.number().int().min(1).optional(),
    }),
    output: Passthrough,
    scopes: ["story:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/bible"],
    actionKeys: [],
    handler: async ({ projectId, chapterId, sceneNumber }, ctx) => ({
      data: await ctx.invoke("GET", `/api/projects/${projectId}/bible`, {
        query: {
          ...(chapterId ? { chapterId } : {}),
          ...(sceneNumber ? { sceneNumber: String(sceneNumber) } : {}),
        },
      }),
      links: { bible: ctx.deps.urls.appUrl(`projects/${projectId}/bible`) },
    }),
  }),

  defineMcpTool({
    name: "manage_story_bible",
    title: "Edit story bible",
    description:
      "add_fact (projectId, fact: kind, text, optional subject, fixed, visual, fromChapterId, untilChapterId — inclusive chapter ids), edit_fact / delete_fact (id), add_state (projectId, state: characterId, kind, text, optional chapterId, sceneNumber, untilChapterId, outfitId), edit_state / delete_state (id). Facts and states in effect reach chapter planning, panel prompts, narration and panel images from then on. Deleting is the delete class (may need approval).",
    input: z.object({
      action: z.enum(["add_fact", "edit_fact", "delete_fact", "add_state", "edit_state", "delete_state"]),
      projectId: Uuid.optional().describe("For add_fact and add_state."),
      id: Uuid.optional().describe("The fact or state, for edit and delete."),
      fact: FactPatch.optional(),
      state: StatePatch.optional(),
    }),
    output: Passthrough,
    scopes: ["story:write"],
    sensitivity: "delete",
    idempotent: false,
    routes: [
      "POST /api/projects/:projectId/bible/facts",
      "PATCH /api/bible-facts/:id",
      "DELETE /api/bible-facts/:id",
      "POST /api/projects/:projectId/bible/states",
      "PATCH /api/character-states/:id",
      "DELETE /api/character-states/:id",
    ],
    actionKeys: [
      "bible.fact.create",
      "bible.fact.update",
      "bible.fact.delete",
      "bible.state.create",
      "bible.state.update",
      "bible.state.delete",
    ],
    classify: async ({ action, projectId, id }, ctx) => {
      const [verb, what] = action.split("_") as ["add" | "edit" | "delete", "fact" | "state"];
      const key = `bible.${what}.${verb === "add" ? "create" : verb === "edit" ? "update" : "delete"}`;
      const project =
        verb === "add"
          ? (projectId ?? "")
          : await projectOf(ctx, what === "fact" ? "bible_fact" : "character_state", id ?? "");
      return cls(verb === "delete" ? "delete" : "write", key, project, `${verb} a story bible ${what}`);
    },
    handler: async ({ action, projectId, id, fact, state }, ctx) => {
      const need = (v: string | undefined, name: string) => {
        if (!v) throw toolError(400, "bad_request", `${name} is required for ${action}`);
        return v;
      };
      switch (action) {
        case "add_fact":
          return {
            data: await ctx.invoke("POST", `/api/projects/${need(projectId, "projectId")}/bible/facts`, {
              body: fact ?? {},
            }),
          };
        case "edit_fact":
          return { data: await ctx.invoke("PATCH", `/api/bible-facts/${need(id, "id")}`, { body: fact ?? {} }) };
        case "delete_fact":
          return { data: await ctx.invoke("DELETE", `/api/bible-facts/${need(id, "id")}`) };
        case "add_state":
          return {
            data: await ctx.invoke("POST", `/api/projects/${need(projectId, "projectId")}/bible/states`, {
              body: state ?? {},
            }),
          };
        case "edit_state":
          return { data: await ctx.invoke("PATCH", `/api/character-states/${need(id, "id")}`, { body: state ?? {} }) };
        default:
          return { data: await ctx.invoke("DELETE", `/api/character-states/${need(id, "id")}`) };
      }
    },
  }),

  defineMcpTool({
    name: "run_bible_extraction",
    title: "Extract bible from story",
    description:
      "Queue a text job that proposes story bible facts and character states from the project's chapters (or one chapter) and their chapter memory. Saves nothing: review the proposal in get_job's result.data (or get_story_bible's extraction), then apply_bible_extraction. Asynchronous: returns a job; poll get_job. ai.manual=true (no provider, no spending) parks it for a BibleExtraction answer via get_manual_prompt / submit_manual_answer; a provider run spends the user's credits (may need approval).",
    input: z.object({
      projectId: Uuid,
      chapterId: Uuid.optional().describe("Only this chapter; omitted for all chapters."),
      ai: AiInput,
      batch: z.boolean().optional(),
      idempotencyKey: IdempotencyKey,
    }),
    output: z.object({ job: Passthrough }).passthrough(),
    scopes: ["story:write", "generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/bible/extract"],
    actionKeys: ["bible.extract"],
    classify: async ({ projectId, ai }) =>
      cls(textSpend(ai, "write"), "bible.extract", projectId, `Extract the story bible ${aiLabel(ai)}`),
    handler: async ({ projectId, chapterId, ai, batch }, ctx) => {
      const r = await ctx.invoke<{ job: Record<string, unknown> & { id: string } }>(
        "POST",
        `/api/projects/${projectId}/bible/extract`,
        { body: { chapterId, ai: await restAi(ctx, ai), batch } },
      );
      return { data: { job: jobView(r.job) }, links: { job: links(ctx).job(projectId, r.job.id) } };
    },
  }),

  defineMcpTool({
    name: "apply_bible_extraction",
    title: "Apply bible extraction",
    description:
      "Save a completed extraction's facts and states into the story bible: all of them, or the reviewed lists you pass (BibleExtraction shape: characters by name, chapters by number). Entries naming no character or chapter are skipped and listed. Applying twice is refused (409 already_applied) unless again=true. Not asynchronous.",
    input: z.object({
      jobId: Uuid,
      facts: z.array(ProposedFact).max(300).optional(),
      states: z.array(ProposedState).max(300).optional(),
      again: z.boolean().optional(),
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["story:write"],
    sensitivity: "write",
    idempotent: false,
    routes: ["POST /api/bible-extractions/:id/apply"],
    actionKeys: ["bible.extraction.apply"],
    classify: async ({ jobId }, ctx) =>
      cls(
        "write",
        "bible.extraction.apply",
        await projectOf(ctx, "generation", jobId),
        "Save the extracted facts and states to the story bible",
      ),
    handler: async ({ jobId, facts, states, again }, ctx) => ({
      data: await ctx.invoke("POST", `/api/bible-extractions/${jobId}/apply`, { body: { facts, states, again } }),
    }),
  }),
  ...continuityTools,
];
