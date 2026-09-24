import { z } from "zod";
import { GenerateNarration, NewLine, PatchLine, PatchSegment } from "../../routes/audio.ts";
import { defineMcpTool, IdempotencyKey, Passthrough } from "../registry.ts";
import { toolError } from "../runtime.ts";
import { AiInput, aiLabel, cls, jobView, links, projectOf, restAi, textSpend, Uuid } from "./common.ts";

/** Speech: without a key it is the server's local Kokoro voice (nothing spent); with one, a paid provider. */
const TtsAi = z
  .object({
    credentialId: Uuid.optional().describe("A saved speech-provider key; omit for the server's local voice (free)."),
    provider: z.string().max(40).optional(),
    model: z.string().max(200).optional(),
  })
  .optional();

export const narrationTools = [
  defineMcpTool({
    name: "get_chapter_narration",
    title: "Get chapter narration",
    description:
      "view=lines: a chapter's narration lines, their TTS segments, audio and job states. view=timeline: the machine-readable timeline (panelId, audioAssetId, startMs, durationMs). Optionally one language. Read-only.",
    input: z.object({
      chapterId: Uuid,
      view: z.enum(["lines", "timeline"]).default("lines"),
      language: z.string().max(16).optional(),
    }),
    output: Passthrough,
    scopes: ["narration:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/chapters/:id/narration", "GET /api/chapters/:id/narration/timeline"],
    actionKeys: [],
    handler: async ({ chapterId, view, language }, ctx) => ({
      data: await ctx.invoke("GET", `/api/chapters/${chapterId}/narration${view === "timeline" ? "/timeline" : ""}`, {
        query: { language },
      }),
    }),
  }),

  defineMcpTool({
    name: "get_narration_status",
    title: "Narration progress",
    description:
      "Synthesis progress for every chapter of a project: segments, how many have audio, what is still running. Read-only.",
    input: z.object({ projectId: Uuid, language: z.string().max(16).optional() }),
    output: Passthrough,
    scopes: ["narration:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/narration/progress"],
    actionKeys: [],
    handler: async ({ projectId, language }, ctx) => ({
      data: await ctx.invoke("GET", `/api/projects/${projectId}/narration/progress`, { query: { language } }),
      links: { narration: links(ctx).narration(projectId) },
    }),
  }),

  defineMcpTool({
    name: "edit_narration",
    title: "Edit narration",
    description:
      "add_line: add a narration line to a chapter (auto-split into TTS segments), optionally tied to a panel and shown on the page. update_line: edit text (re-segments; unchanged segments keep their audio), panel, on-page box or order. delete_line (delete class). resegment_line: re-split a line. update_segment: text, voice, speed, pause. split_segment / merge_segment. apply_pauses: re-apply the project's pause settings to a chapter. No audio is produced here; use synthesize_narration.",
    input: z.object({
      action: z.enum([
        "add_line",
        "update_line",
        "delete_line",
        "resegment_line",
        "update_segment",
        "split_segment",
        "merge_segment",
        "apply_pauses",
      ]),
      chapterId: Uuid.optional().describe("For add_line and apply_pauses."),
      lineId: Uuid.optional(),
      segmentId: Uuid.optional(),
      line: NewLine.optional(),
      lineUpdate: PatchLine.optional(),
      segmentUpdate: PatchSegment.optional(),
      maxChars: z.number().int().min(40).max(2000).optional(),
      at: z.number().int().min(1).optional().describe("split_segment: character offset."),
      language: z.string().max(16).optional(),
    }),
    output: Passthrough,
    scopes: ["narration:write"],
    sensitivity: "delete",
    idempotent: false,
    routes: [
      "POST /api/chapters/:id/narration/lines",
      "PATCH /api/narration-lines/:id",
      "DELETE /api/narration-lines/:id",
      "POST /api/narration-lines/:id/resegment",
      "PATCH /api/narration-segments/:id",
      "POST /api/narration-segments/:id/split",
      "POST /api/narration-segments/:id/merge-next",
      "POST /api/chapters/:id/narration/pauses",
    ],
    actionKeys: ["narration.edit", "narration.delete_line"],
    classify: async (a, ctx) => {
      const p =
        a.action === "add_line" || a.action === "apply_pauses"
          ? await projectOf(ctx, "chapter", a.chapterId ?? "")
          : a.lineId
            ? await projectOf(ctx, "narration_line", a.lineId)
            : await projectOf(ctx, "narration_segment", a.segmentId ?? "");
      return a.action === "delete_line"
        ? cls("delete", "narration.delete_line", p, "Delete a narration line and its audio")
        : cls("write", "narration.edit", p, `Narration: ${a.action}`);
    },
    handler: async (a, ctx) => {
      const need = (v: string | undefined, n: string) => {
        if (!v) throw toolError(400, "bad_request", `${n} is required`);
        return v;
      };
      switch (a.action) {
        case "add_line":
          return {
            data: await ctx.invoke("POST", `/api/chapters/${need(a.chapterId, "chapterId")}/narration/lines`, {
              body: a.line,
            }),
          };
        case "update_line":
          return {
            data: await ctx.invoke("PATCH", `/api/narration-lines/${need(a.lineId, "lineId")}`, {
              body: a.lineUpdate ?? {},
            }),
          };
        case "delete_line":
          return { data: await ctx.invoke("DELETE", `/api/narration-lines/${need(a.lineId, "lineId")}`) };
        case "resegment_line":
          return {
            data: await ctx.invoke("POST", `/api/narration-lines/${need(a.lineId, "lineId")}/resegment`, {
              body: { maxChars: a.maxChars },
            }),
          };
        case "update_segment":
          return {
            data: await ctx.invoke("PATCH", `/api/narration-segments/${need(a.segmentId, "segmentId")}`, {
              body: a.segmentUpdate ?? {},
            }),
          };
        case "split_segment":
          return {
            data: await ctx.invoke("POST", `/api/narration-segments/${need(a.segmentId, "segmentId")}/split`, {
              body: { at: a.at },
            }),
          };
        case "merge_segment":
          return {
            data: await ctx.invoke("POST", `/api/narration-segments/${need(a.segmentId, "segmentId")}/merge-next`),
          };
        case "apply_pauses":
          return {
            data: await ctx.invoke("POST", `/api/chapters/${need(a.chapterId, "chapterId")}/narration/pauses`, {
              body: { language: a.language },
            }),
          };
      }
    },
  }),

  defineMcpTool({
    name: "run_narration_generation",
    title: "Write narration",
    description:
      "Queue the text model writing narration lines for a chapter, tied to its panels (a NarrationDraft). replace=true replaces existing lines (sensitive). Asynchronous: returns a job; poll get_job. Manual mode (ai.manual=true, no spending) asks you for the NarrationDraft via get_manual_prompt / submit_manual_answer; a provider run spends credits (may need approval). Then synthesize_narration for audio.",
    input: GenerateNarration.omit({ ai: true, batch: true }).extend({
      chapterId: Uuid,
      ai: AiInput,
      batch: z.boolean().optional(),
      idempotencyKey: IdempotencyKey,
    }),
    output: z.object({ job: Passthrough }).passthrough(),
    scopes: ["narration:write", "generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/chapters/:id/narration/generate"],
    actionKeys: ["narration.generate", "narration.regenerate"],
    classify: async ({ chapterId, replace, ai }, ctx) =>
      cls(
        textSpend(ai, replace ? "sensitive-write" : "write"),
        replace ? "narration.regenerate" : "narration.generate",
        await projectOf(ctx, "chapter", chapterId),
        `${replace ? "Rewrite (replace)" : "Write"} the chapter's narration ${aiLabel(ai)}`,
      ),
    handler: async ({ chapterId, ai, idempotencyKey: _k, ...body }, ctx) => {
      const r = await ctx.invoke<{ job: Record<string, unknown> }>(
        "POST",
        `/api/chapters/${chapterId}/narration/generate`,
        {
          body: { ...body, ai: await restAi(ctx, ai) },
        },
      );
      return { data: { ...r, job: jobView(r.job) } };
    },
  }),

  defineMcpTool({
    name: "synthesize_narration",
    title: "Synthesize narration audio",
    description:
      "Queue speech synthesis for one segment (segmentId) or every missing/stale segment of a chapter (chapterId). Without ai.credentialId it uses the server's local voice (Kokoro; free). With a speech-provider key it spends the user's credits (may need approval). Asynchronous: returns audio jobs; poll get_job or get_narration_status. cancel=true (with chapterId) instead cancels the chapter's not-yet-started synthesis.",
    input: z.object({
      segmentId: Uuid.optional(),
      chapterId: Uuid.optional(),
      voice: z.string().max(128).optional(),
      speed: z.number().min(0.5).max(2).optional(),
      force: z.boolean().default(false).describe("Segment: re-synthesize even if audio exists."),
      onlyMissing: z.boolean().default(true).describe("Chapter: only segments without current audio."),
      language: z.string().max(16).optional(),
      ai: TtsAi,
      cancel: z.boolean().default(false),
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["narration:write"],
    sensitivity: "spend",
    idempotent: false,
    routes: [
      "POST /api/narration-segments/:id/synthesize",
      "POST /api/chapters/:id/narration/synthesize",
      "POST /api/chapters/:id/narration/synthesize/cancel",
    ],
    actionKeys: ["narration.synthesize", "narration.cancel"],
    classify: async (a, ctx) => {
      const p = a.chapterId
        ? await projectOf(ctx, "chapter", a.chapterId)
        : await projectOf(ctx, "narration_segment", a.segmentId ?? "");
      if (a.cancel) return cls("write", "narration.cancel", p, "Cancel narration synthesis");
      const paid = Boolean(a.ai?.credentialId || a.ai?.provider);
      return cls(
        paid ? "spend" : "write",
        "narration.synthesize",
        p,
        `Synthesize narration for ${a.chapterId ? "the chapter" : "one segment"} ${paid ? "with a speech provider; spends credits" : "with the local voice (free)"}`,
      );
    },
    handler: async (a, ctx) => {
      if (!a.chapterId && !a.segmentId) throw toolError(400, "bad_request", "chapterId or segmentId is required");
      const ai = a.ai ? await restAi(ctx, a.ai) : undefined;
      if (a.cancel) {
        if (!a.chapterId) throw toolError(400, "bad_request", "Cancel one segment's audio job with control_job.");
        return { data: await ctx.invoke("POST", `/api/chapters/${a.chapterId}/narration/synthesize/cancel`) };
      }
      if (a.chapterId)
        return {
          data: await ctx.invoke("POST", `/api/chapters/${a.chapterId}/narration/synthesize`, {
            body: { onlyMissing: a.onlyMissing, voice: a.voice, language: a.language, ai },
          }),
        };
      return {
        data: await ctx.invoke("POST", `/api/narration-segments/${a.segmentId}/synthesize`, {
          body: { voice: a.voice, speed: a.speed, force: a.force, ai },
        }),
      };
    },
  }),
];
