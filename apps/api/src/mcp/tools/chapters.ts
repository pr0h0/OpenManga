import { chapters, count, eq, pages, scenes } from "@openmanga/db";
import { asPatch } from "@openmanga/schemas";
import { z } from "zod";
import { BeatsInput, ChapterInput, PatchChapter, SceneInput } from "../../routes/chapters.ts";
import { defineMcpTool, IdempotencyKey, Passthrough } from "../registry.ts";
import { toolError } from "../runtime.ts";
import {
  AiInput,
  aiLabel,
  cls,
  jobView,
  links,
  Paging,
  page,
  projectOf,
  restAi,
  stamp,
  textSpend,
  Uuid,
} from "./common.ts";

const EXCERPT = 2000;

type PanelRow = Record<string, unknown> & {
  id: string;
  pageId: string;
  storyBeat: string;
  activeArtworkAssetId: string | null;
  review: unknown;
};

export const chapterTools = [
  defineMcpTool({
    name: "list_chapters",
    title: "List chapters",
    description:
      "A project's chapters in order, with scene/page/panel counts, how many panels have artwork, narration coverage and whether a plan exists. Read-only. Work chapter by chapter: get_chapter, then run_chapter_plan.",
    input: z.object({ projectId: Uuid }),
    output: z.object({ chapters: z.array(Passthrough) }),
    scopes: ["chapters:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/chapters"],
    actionKeys: [],
    handler: async ({ projectId }, ctx) => ({
      data: await ctx.invoke("GET", `/api/projects/${projectId}/chapters`),
      links: { chapters: ctx.deps.urls.appUrl(`projects/${projectId}/chapters`) },
    }),
  }),

  defineMcpTool({
    name: "translate_lettering",
    title: "Translated lettering",
    description:
      "A chapter's speech bubbles and on-page captions in another language, for a translated edition of the same art. get: every line with its original, its translation (or null), stale (the original changed since) and edited. translate: a text job translating them (asynchronous; poll get_job; ai.manual=true asks you for a LetteringTranslation answer; a provider run spends the user's credits). edit: lines [{sourceType, sourceId, text}] saved as hand edits (empty text removes one). Exports and page renders take `language` for the edition.",
    input: z.object({
      action: z.enum(["get", "translate", "edit"]),
      chapterId: Uuid,
      language: z.string().min(2).max(16).describe("The edition's language code, e.g. es, ja."),
      lines: z
        .array(z.object({ sourceType: z.enum(["dialogue", "caption"]), sourceId: Uuid, text: z.string().max(1000) }))
        .max(1000)
        .optional(),
      ai: AiInput,
      batch: z.boolean().optional(),
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["chapters:read"],
    scopesFor: (a) =>
      a.action === "translate"
        ? ["chapters:write", "generations:run"]
        : a.action === "edit"
          ? ["chapters:write"]
          : ["chapters:read"],
    sensitivity: "spend",
    idempotent: false,
    routes: [
      "GET /api/chapters/:id/lettering",
      "PUT /api/chapters/:id/lettering",
      "POST /api/chapters/:id/lettering/translate",
    ],
    actionKeys: ["lettering.translate", "lettering.edit"],
    classify: async (a, ctx) => {
      const project = await projectOf(ctx, "chapter", a.chapterId);
      if (a.action === "get") return cls("read", "lettering.read", project, "Read translated lettering");
      if (a.action === "edit") return cls("write", "lettering.edit", project, "Edit translated lettering");
      return cls(
        textSpend(a.ai, "write"),
        "lettering.translate",
        project,
        `Translate lettering into ${a.language} ${aiLabel(a.ai)}`,
      );
    },
    handler: async (a, ctx) => {
      if (a.action === "get")
        return {
          data: await ctx.invoke(
            "GET",
            `/api/chapters/${a.chapterId}/lettering?language=${encodeURIComponent(a.language)}`,
          ),
        };
      if (a.action === "edit") {
        if (!a.lines?.length) throw toolError(400, "bad_request", "lines are required for edit");
        return {
          data: await ctx.invoke("PUT", `/api/chapters/${a.chapterId}/lettering`, {
            body: { language: a.language, lines: a.lines },
          }),
        };
      }
      const r = await ctx.invoke<{ job: Record<string, unknown> & { id: string; projectId: string } }>(
        "POST",
        `/api/chapters/${a.chapterId}/lettering/translate`,
        { body: { language: a.language, ai: await restAi(ctx, a.ai), batch: a.batch } },
      );
      return { data: { job: jobView(r.job) }, links: { job: links(ctx).job(r.job.projectId, r.job.id) } };
    },
  }),

  defineMcpTool({
    name: "get_chapter_source",
    title: "Get chapter source trace",
    description:
      "Where a chapter's panels, scenes and narration lines come from in its text: the text the plan reads, each panel's character span (start/end), each scene's, the narration lines by panel, and where the chapter sits in the newest story revision. Panels whose text was revised after planning are `changed`, with `was` the text they were planned from: those are what a story revision affects. Traced without AI. Read-only.",
    input: z.object({ chapterId: Uuid }),
    output: z.object({ text: z.string(), panels: z.array(Passthrough), changed: z.number() }).passthrough(),
    scopes: ["chapters:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/chapters/:id/source"],
    actionKeys: [],
    handler: async ({ chapterId }, ctx) => ({
      data: await ctx.invoke<{ text: string; panels: unknown[]; changed: number }>(
        "GET",
        `/api/chapters/${chapterId}/source`,
      ),
    }),
  }),

  defineMcpTool({
    name: "get_chapter",
    title: "Get chapter",
    description: `One chapter: memory (summary, opening/closing state, continuity), scenes with their beats, and pages with panel counts. The source excerpt is cut to ${EXCERPT} characters unless includeSource=true. Panels are listed by list_chapter_panels (paginated) and in detail by get_page / get_panel. Read-only.`,
    input: z.object({ chapterId: Uuid, includeSource: z.boolean().default(false) }),
    output: z.object({ chapter: Passthrough, scenes: z.array(Passthrough), pages: z.array(Passthrough) }).passthrough(),
    scopes: ["chapters:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/chapters/:id"],
    actionKeys: [],
    handler: async ({ chapterId, includeSource }, ctx) => {
      const r = await ctx.invoke<{
        chapter: Record<string, unknown> & { projectId: string; sourceExcerpt: string; lastPlan: unknown };
        pages: (Record<string, unknown> & { panels?: unknown })[];
      }>("GET", `/api/chapters/${chapterId}`);
      const { lastPlan, sourceExcerpt, ...chapter } = r.chapter;
      return {
        data: {
          ...r,
          chapter: {
            ...chapter,
            hasPlan: Boolean(lastPlan),
            sourceLength: sourceExcerpt.length,
            sourceExcerpt: includeSource ? sourceExcerpt : sourceExcerpt.slice(0, EXCERPT),
          },
          // Panel thumbnails are for drawing the UI grid; an agent reads panels through list_chapter_panels.
          pages: r.pages.map(({ panels: _p, ...pg }) => pg),
        },
        links: { chapter: links(ctx).chapter(chapter.projectId as string, chapterId) },
      };
    },
  }),

  defineMcpTool({
    name: "manage_chapter",
    title: "Create / edit / delete chapter",
    description:
      "create: add a chapter to a project (title, summary, sourceExcerpt: the story text this chapter covers). update: edit its fields and chapter memory, reorder it, or set planStatus (approve/lock the plan), or publishAt (ISO time, null to unpublish: when the chapter appears on its series' reader page). delete: remove the chapter with its pages and panels (generated images stay in the asset library) — delete class, may need approval.",
    input: z.object({
      action: z.enum(["create", "update", "delete"]),
      projectId: Uuid.optional().describe("For create."),
      chapterId: Uuid.optional().describe("For update and delete."),
      fields: PatchChapter.optional().describe("create: title (required), summary, sourceExcerpt. update: any."),
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["chapters:write"],
    sensitivity: "delete",
    idempotent: false,
    routes: ["POST /api/projects/:projectId/chapters", "PATCH /api/chapters/:id", "DELETE /api/chapters/:id"],
    actionKeys: ["chapter.create", "chapter.update", "chapter.delete"],
    classify: async ({ action, projectId, chapterId }, ctx) => {
      if (action === "create") {
        if (!projectId) throw toolError(400, "bad_request", "projectId is required to create a chapter");
        return cls("write", "chapter.create", projectId, "Create a chapter");
      }
      if (!chapterId) throw toolError(400, "bad_request", "chapterId is required");
      const p = await projectOf(ctx, "chapter", chapterId);
      if (action === "delete") {
        const target = await stamp(ctx, chapters, chapterId, ["title", "updatedAt"]);
        return cls(
          "delete",
          "chapter.delete",
          p,
          `Delete chapter "${String(target.title)}" with its pages and panels`,
          { target },
        );
      }
      return cls("write", "chapter.update", p, "Edit a chapter");
    },
    handler: async ({ action, projectId, chapterId, fields }, ctx) => {
      if (action === "create")
        return {
          data: await ctx.invoke("POST", `/api/projects/${projectId}/chapters`, {
            body: ChapterInput.parse(fields ?? {}),
          }),
        };
      if (action === "delete") return { data: await ctx.invoke("DELETE", `/api/chapters/${chapterId}`) };
      return { data: await ctx.invoke("PATCH", `/api/chapters/${chapterId}`, { body: fields ?? {} }) };
    },
  }),

  defineMcpTool({
    name: "run_chapter_plan",
    title: "Plan chapter",
    description:
      "Queue planning of a chapter into scenes, pages and panels (for a film project: shots; for a vertical strip: one panel per page). Asynchronous: returns a job; poll get_job. With ai.manual=true (no key, no spending) the job asks several questions in turn: first a ChapterOutline, then one ScenePages per scene — each time it is awaiting_input, call get_manual_prompt and submit_manual_answer, until the job completes. A chapter that already has pages needs replace=true, which replaces them (sensitive; may need approval). A provider run spends credits (may need approval). One plan per chapter at a time.",
    input: z.object({
      chapterId: Uuid,
      replace: z.boolean().default(false),
      targetPages: z.number().int().min(1).max(60).optional(),
      ai: AiInput,
      batch: z.boolean().optional(),
      idempotencyKey: IdempotencyKey,
    }),
    output: z.object({ job: Passthrough }),
    scopes: ["chapters:write", "generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/chapters/:id/plan"],
    actionKeys: ["chapter.plan", "chapter.replan"],
    classify: async ({ chapterId, replace, ai }, ctx) => {
      const p = await projectOf(ctx, "chapter", chapterId);
      const [n] = await ctx.deps.db.select({ n: count() }).from(pages).where(eq(pages.chapterId, chapterId));
      const replacing = replace && (n?.n ?? 0) > 0;
      return cls(
        textSpend(ai, replacing ? "sensitive-write" : "write"),
        replacing ? "chapter.replan" : "chapter.plan",
        p,
        `${replacing ? `Re-plan the chapter, replacing its ${n?.n} pages,` : "Plan the chapter"} ${aiLabel(ai)}`,
        {
          target: replacing
            ? { pages: n?.n, ...(await stamp(ctx, chapters, chapterId, ["planStatus", "updatedAt"])) }
            : undefined,
        },
      );
    },
    handler: async ({ chapterId, replace, targetPages, ai, batch }, ctx) => {
      const r = await ctx.invoke<{ job: Record<string, unknown> & { id: string; projectId: string } }>(
        "POST",
        `/api/chapters/${chapterId}/plan`,
        { body: { replace, targetPages, batch, ai: await restAi(ctx, ai) } },
      );
      return { data: { job: jobView(r.job) }, links: { job: links(ctx).job(r.job.projectId, r.job.id) } };
    },
  }),

  defineMcpTool({
    name: "manage_scene",
    title: "Create / edit scene",
    description:
      "create: add a scene to a chapter. update: edit a scene's fields, location, cast and continuity state. replace_beats: replace a scene's story beats with the given list. delete: remove the scene (its pages stay, unassigned; delete class, may need approval).",
    input: z.object({
      action: z.enum(["create", "update", "replace_beats", "delete"]),
      chapterId: Uuid.optional().describe("For create."),
      sceneId: Uuid.optional().describe("For update and replace_beats."),
      fields: asPatch(SceneInput).optional().describe("create needs title."),
      beats: BeatsInput.shape.beats.optional(),
    }),
    output: Passthrough,
    scopes: ["chapters:write"],
    sensitivity: "delete",
    idempotent: false,
    routes: [
      "POST /api/chapters/:id/scenes",
      "PATCH /api/scenes/:id",
      "PUT /api/scenes/:id/beats",
      "DELETE /api/scenes/:id",
    ],
    actionKeys: ["scene.create", "scene.update", "scene.beats", "scene.delete"],
    classify: async ({ action, chapterId, sceneId }, ctx) =>
      action === "create"
        ? cls("write", "scene.create", await projectOf(ctx, "chapter", chapterId ?? ""), "Create a scene")
        : action === "delete"
          ? cls("delete", "scene.delete", await projectOf(ctx, "scene", sceneId ?? ""), "Delete a scene", {
              target: await stamp(ctx, scenes, sceneId ?? "", ["title", "updatedAt"]),
            })
          : cls(
              "write",
              action === "update" ? "scene.update" : "scene.beats",
              await projectOf(ctx, "scene", sceneId ?? ""),
              "Edit a scene",
            ),
    handler: async ({ action, chapterId, sceneId, fields, beats }, ctx) => {
      if (action === "delete") return { data: await ctx.invoke("DELETE", `/api/scenes/${sceneId}`) };
      if (action === "create")
        return {
          data: await ctx.invoke("POST", `/api/chapters/${chapterId}/scenes`, { body: SceneInput.parse(fields ?? {}) }),
        };
      if (action === "replace_beats")
        return { data: await ctx.invoke("PUT", `/api/scenes/${sceneId}/beats`, { body: { beats: beats ?? [] } }) };
      return { data: await ctx.invoke("PATCH", `/api/scenes/${sceneId}`, { body: fields ?? {} }) };
    },
  }),

  defineMcpTool({
    name: "list_chapter_panels",
    title: "List chapter panels",
    description:
      "A chapter's panels in reading order as compact summaries (page, shot, camera, story beat, cast and location version ids, status, approval, whether it has artwork, review flags). Paginated (default 25, max 100). Detail: get_panel. Read-only.",
    input: z.object({ chapterId: Uuid, ...Paging }),
    output: z
      .object({ items: z.array(Passthrough), total: z.number(), nextOffset: z.number().nullable() })
      .passthrough(),
    scopes: ["panels:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/chapters/:id/panels"],
    actionKeys: [],
    handler: async ({ chapterId, limit, offset }, ctx) => {
      const { panels } = await ctx.invoke<{ panels: PanelRow[] }>("GET", `/api/chapters/${chapterId}/panels`);
      const slim = panels.map((p) => ({
        id: p.id,
        pageId: p.pageId,
        pageOrder: p.pageOrder,
        order: p.order,
        sceneId: p.sceneId,
        shotType: p.shotType,
        cameraAngle: p.cameraAngle,
        storyBeat: p.storyBeat.length > 300 ? `${p.storyBeat.slice(0, 300)}…` : p.storyBeat,
        characterVersionIds: p.characterVersionIds,
        locationVersionId: p.locationVersionId,
        propVersionIds: p.propVersionIds,
        status: p.status,
        approvalStatus: p.approvalStatus,
        hasArtwork: Boolean(p.activeArtworkAssetId),
        hasPromptOverride: Boolean(p.promptOverride),
        hasPreparedPrompt: Boolean(p.promptDraft),
        review: p.review ?? null,
      }));
      return { data: page(slim, limit, offset) };
    },
  }),
];
