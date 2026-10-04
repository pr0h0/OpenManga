import { eq, generationJobs, narrationFindings } from "@openmanga/db";
import { z } from "zod";
import { GenerateNarration, NewLine, PatchLine, PatchSegment } from "../../routes/audio.ts";
import { ApplyFixInput, FixInput, LintInput } from "../../routes/narration-qa.ts";
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
      "add_line: add a narration line to a chapter (auto-split into TTS segments), optionally tied to a panel and shown on the page. update_line: edit text (re-segments; unchanged segments keep their audio), panel, on-page box, order, or its video span and offsets (`video`). delete_line (delete class). resegment_line: re-split a line. update_segment: text, voice, speed, pause. split_segment / merge_segment. apply_pauses: re-apply the project's pause settings to a chapter. No audio is produced here; use synthesize_narration.",
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

  defineMcpTool({
    name: "run_narration_lint",
    title: "Check narration (QA)",
    description:
      "Narration QA for a chapter (chapterId) or every chapter with narration (projectId). The deterministic checks (repeated sentence openings, flat rhythm, a name used too often, near-duplicate lines, narration restating the panel's dialogue, chapters that open or end alike, crowded shots, silent stretches, pace from real audio) run at once and are stored as findings; the answer says how many were found, are new, remain and were resolved since the last run. semantic=true also queues the AI check per chapter (meaning repeated in other words, facts explained again, lines that only describe the frame) as narration_lint jobs: manual mode (ai.manual=true) asks you for a NarrationLintReport; a provider run spends credits (may need approval). audio=true also queues one audio_check job over the voiced audio (silent, clipped or stalled segments, lines much louder or quieter than their chapter, chapters out of step in loudness; plus each chapter's integrated LUFS, loudness range and true peak); no model, nothing spent. Read findings with get_narration_qa.",
    input: LintInput.omit({ ai: true }).extend({
      chapterId: Uuid.optional(),
      projectId: Uuid.optional(),
      ai: AiInput,
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["narration:write", "generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/chapters/:id/narration/lint", "POST /api/projects/:projectId/narration/lint"],
    actionKeys: ["narration.lint"],
    classify: async ({ chapterId, projectId, semantic, audio, ai }, ctx) => {
      if (!chapterId === !projectId) throw toolError(400, "bad_request", "Pass either chapterId or projectId");
      return cls(
        semantic ? textSpend(ai, "write") : "write",
        "narration.lint",
        chapterId ? await projectOf(ctx, "chapter", chapterId) : projectId!,
        `Check the narration of ${chapterId ? "a chapter" : "every chapter"}${semantic ? ` with the AI check ${aiLabel(ai)}` : ""}${audio ? " and its audio" : ""}`,
      );
    },
    handler: async ({ chapterId, projectId, ai, idempotencyKey: _k, ...body }, ctx) => {
      const path = chapterId
        ? `/api/chapters/${chapterId}/narration/lint`
        : `/api/projects/${projectId}/narration/lint`;
      const r = await ctx.invoke<Record<string, unknown>>("POST", path, {
        body: { ...body, ai: body.semantic ? await restAi(ctx, ai) : undefined },
      });
      return {
        data: {
          ...r,
          ...(r.job ? { job: jobView(r.job as Record<string, unknown>) } : {}),
          ...(Array.isArray(r.jobs) ? { jobs: (r.jobs as Record<string, unknown>[]).map(jobView) } : {}),
          ...(r.audioJob ? { audioJob: jobView(r.audioJob as Record<string, unknown>) } : {}),
        },
      };
    },
  }),

  defineMcpTool({
    name: "get_narration_qa",
    title: "Narration QA findings and density",
    description:
      "view=findings: a project's narration QA findings (type, chapter, line ids, severity, explanation, status open/ignored/fixed, whether a rewrite can fix it, and `check`: rule, ai or audio; audio findings are fixed by voicing the line again) with counts by status, type and chapter, the text of the flagged lines, and `audio`: each chapter's loudness from the newest audio check; filter by chapterId, status or kind. view=density: words, words per shot, silent shots and words per minute (from current audio) per chapter, and shot by shot with chapterId. Read-only.",
    input: z.object({
      projectId: Uuid,
      view: z.enum(["findings", "density"]).default("findings"),
      chapterId: Uuid.optional(),
      status: z.enum(["open", "ignored", "fixed"]).optional(),
      kind: z.string().max(40).optional(),
      language: z.string().max(16).optional(),
    }),
    output: Passthrough,
    scopes: ["narration:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/projects/:projectId/narration/findings", "GET /api/projects/:projectId/narration/density"],
    actionKeys: [],
    handler: async ({ projectId, view, chapterId, status, kind, language }, ctx) => ({
      data:
        view === "density"
          ? await ctx.invoke("GET", `/api/projects/${projectId}/narration/density`, { query: { chapterId, language } })
          : await ctx.invoke("GET", `/api/projects/${projectId}/narration/findings`, {
              query: { chapterId, status, kind, language },
            }),
    }),
  }),

  defineMcpTool({
    name: "update_narration_finding",
    title: "Ignore or reopen a narration finding",
    description:
      "status=ignored: dismiss a narration QA finding; it stays ignored while later checks find the same problem on the same lines. status=open reopens it.",
    input: z.object({ findingId: Uuid, status: z.enum(["open", "ignored"]) }),
    output: Passthrough,
    scopes: ["narration:write"],
    sensitivity: "write",
    idempotent: true,
    routes: ["PATCH /api/narration-findings/:id"],
    actionKeys: ["narration.finding"],
    classify: async ({ findingId, status }, ctx) => {
      const [f] = await ctx.deps.db
        .select({ p: narrationFindings.projectId })
        .from(narrationFindings)
        .where(eq(narrationFindings.id, findingId));
      if (!f) throw toolError(404, "not_found", "Finding not found");
      return cls("write", "narration.finding", f.p, `Mark a narration finding ${status}`);
    },
    handler: async ({ findingId, status }, ctx) => ({
      data: await ctx.invoke("PATCH", `/api/narration-findings/${findingId}`, { body: { status } }),
    }),
  }),

  defineMcpTool({
    name: "propose_narration_fix",
    title: "Propose narration fixes",
    description:
      "Queue a narration_fix job that rewrites only the lines the chosen findings (from get_narration_qa, all on this chapter) flag, keeping every other line. The job result holds proposals as { lineId, before, after }; nothing changes until apply_narration_fix. Silences and pace cannot be fixed by rewriting and are refused. Manual mode (ai.manual=true) asks you for a NarrationFix; a provider run spends credits (may need approval).",
    input: FixInput.omit({ ai: true }).extend({ chapterId: Uuid, ai: AiInput, idempotencyKey: IdempotencyKey }),
    output: z.object({ job: Passthrough }).passthrough(),
    scopes: ["narration:write", "generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/chapters/:id/narration/fix"],
    actionKeys: ["narration.fix"],
    classify: async ({ chapterId, findingIds, ai }, ctx) =>
      cls(
        textSpend(ai, "write"),
        "narration.fix",
        await projectOf(ctx, "chapter", chapterId),
        `Propose rewrites for ${findingIds.length} narration finding(s) ${aiLabel(ai)}`,
      ),
    handler: async ({ chapterId, ai, idempotencyKey: _k, ...body }, ctx) => {
      const r = await ctx.invoke<{ job: Record<string, unknown> }>("POST", `/api/chapters/${chapterId}/narration/fix`, {
        body: { ...body, ai: await restAi(ctx, ai) },
      });
      return { data: { ...r, job: jobView(r.job) } };
    },
  }),

  defineMcpTool({
    name: "apply_narration_fix",
    title: "Apply narration fixes",
    description:
      "Apply a completed propose_narration_fix job (jobId): rewrites its lines (or only lineIds), skipping any line edited since; marks its findings fixed; re-voices only the changed segments of lines that had audio (revoice, default true: the local voice unless ai names a speech key, which spends); and re-runs the deterministic checks on the chapter, returning how they compare (found, introduced, remaining, resolved). recheck=true also queues the AI check again on the model the fix used.",
    input: ApplyFixInput.omit({ ai: true }).extend({ chapterId: Uuid, ai: TtsAi }),
    output: Passthrough,
    scopes: ["narration:write"],
    sensitivity: "spend",
    idempotent: false,
    routes: ["POST /api/chapters/:id/narration/fix/apply"],
    actionKeys: ["narration.fix_apply"],
    classify: async ({ chapterId, jobId, revoice, recheck, ai }, ctx) => {
      const [job] = await ctx.deps.db
        .select({ parameters: generationJobs.parameters })
        .from(generationJobs)
        .where(eq(generationJobs.id, jobId));
      const paidVoice = revoice && Boolean(ai?.credentialId || ai?.provider);
      const paidCheck = recheck && job?.parameters.manual !== true;
      return cls(
        paidVoice || paidCheck ? "spend" : "write",
        "narration.fix_apply",
        await projectOf(ctx, "chapter", chapterId),
        `Apply narration fixes${paidVoice ? ", re-voicing with a speech provider" : ""}${paidCheck ? ", and re-check with the AI model (spends credits)" : ""}`,
      );
    },
    handler: async ({ chapterId, ai, ...body }, ctx) => ({
      data: await ctx.invoke("POST", `/api/chapters/${chapterId}/narration/fix/apply`, {
        body: { ...body, ai: ai ? await restAi(ctx, ai) : undefined },
      }),
    }),
  }),

  defineMcpTool({
    name: "delete_narration_audio",
    title: "Delete narration audio",
    description:
      "Delete synthesized narration audio from disk: a chapter's (chapterId; every take, or one track with language) or the whole project's (projectId, including takes of deleted lines). The narration text is kept and can be synthesized again with synthesize_narration. Refused while synthesis is running there. Cannot be undone. Always a delete-class action (may need the user's approval).",
    input: z.object({
      chapterId: Uuid.optional(),
      projectId: Uuid.optional(),
      language: z.string().trim().min(2).max(16).optional().describe("Chapter only: delete just this track."),
    }),
    output: z.object({ files: z.number(), bytes: z.number(), segments: z.number() }).passthrough(),
    scopes: ["narration:write"],
    sensitivity: "delete",
    idempotent: true,
    routes: ["DELETE /api/chapters/:id/narration/audio", "DELETE /api/projects/:projectId/narration/audio"],
    actionKeys: ["narration.delete_audio"],
    classify: async ({ chapterId, projectId, language }, ctx) => {
      if (!chapterId === !projectId) throw toolError(400, "bad_request", "Pass either chapterId or projectId");
      return cls(
        "delete",
        "narration.delete_audio",
        chapterId ? await projectOf(ctx, "chapter", chapterId) : projectId!,
        `Delete ${chapterId ? "a chapter's" : "the whole project's"} narration audio${language ? ` (${language})` : ""}`,
      );
    },
    handler: async ({ chapterId, projectId, language }, ctx) => ({
      data: chapterId
        ? await ctx.invoke("DELETE", `/api/chapters/${chapterId}/narration/audio`, { query: { language } })
        : await ctx.invoke("DELETE", `/api/projects/${projectId}/narration/audio`),
    }),
  }),
  defineMcpTool({
    name: "get_timing",
    title: "Timing pass",
    description:
      "The timing pass, from the real narration audio (panel cut). chapterId: each shot's hold, what is off (long: past the longest-shot setting; flash: under the shortest; still: one picture too long; silence: dead air), the chapter's length against its share of the target runtime, and the fixes on offer, each with its effect on the holds and the length: spread (a long line over the next shots of its scene), holds (a shot's own minimum hold) and trim (word budgets to land on target). projectId: every chapter's length, target and issue counts. Apply with apply_timing_fix and retime_narration. Read-only.",
    input: z.object({
      chapterId: Uuid.optional(),
      projectId: Uuid.optional(),
      minHoldMs: z.number().int().min(500).max(30_000).optional().describe("The export minimum hold to time against."),
      language: z.string().max(16).optional(),
    }),
    output: Passthrough,
    scopes: ["narration:read"],
    sensitivity: "read",
    idempotent: true,
    routes: ["GET /api/chapters/:id/timing", "GET /api/projects/:projectId/timing"],
    actionKeys: [],
    handler: async ({ chapterId, projectId, ...query }, ctx) => {
      if (chapterId) return { data: await ctx.invoke("GET", `/api/chapters/${chapterId}/timing`, { query }) };
      if (projectId) return { data: await ctx.invoke("GET", `/api/projects/${projectId}/timing`, { query }) };
      throw toolError(400, "bad_request", "chapterId or projectId is required");
    },
  }),

  defineMcpTool({
    name: "apply_timing_fix",
    title: "Apply a timing fix",
    description:
      "Apply a fix get_timing offered, in a chapter. spread: stretch a narration line over the shots up to untilPanelId (null undoes it). hold: set a panel's own minimum hold as a video shot, in ms (null back to the export's). Existing art only; nothing is generated or spent.",
    input: z.object({
      chapterId: Uuid,
      spread: z.object({ lineId: Uuid, untilPanelId: Uuid.nullable() }).optional(),
      hold: z.object({ panelId: Uuid, holdMs: z.number().int().min(500).max(60_000).nullable() }).optional(),
    }),
    output: Passthrough,
    scopes: ["narration:write", "panels:write"],
    sensitivity: "write",
    idempotent: true,
    routes: ["POST /api/chapters/:id/timing/apply"],
    actionKeys: ["timing.apply"],
    classify: async ({ chapterId, spread }, ctx) =>
      cls(
        "write",
        "timing.apply",
        await projectOf(ctx, "chapter", chapterId),
        spread ? "Spread a narration line over the next shots" : "Set a shot's own hold",
      ),
    handler: async ({ chapterId, spread, hold }, ctx) => {
      if (Boolean(spread) === Boolean(hold)) throw toolError(400, "bad_request", "Give exactly one of spread or hold");
      return {
        data: await ctx.invoke("POST", `/api/chapters/${chapterId}/timing/apply`, {
          body: spread ? { spread } : { hold },
        }),
      };
    },
  }),

  defineMcpTool({
    name: "retime_narration",
    title: "Trim or expand narration",
    description:
      "The timing pass's trim or expand. start: a text job rewrites only the given lines, each to its word budget (get_timing fixes.trim suggests them); nothing changes until applied, and the job's result (get_job) lists each line before and after. apply: keep the rewrites for lineIds from that job, then only those lines are re-voiced (their unchanged segments keep their audio). start spends text-provider credits unless ai.manual; apply re-voices with the local voice for free, or spends with a speech key (ttsAi). Either may need approval.",
    input: z.object({
      action: z.enum(["start", "apply"]),
      chapterId: Uuid,
      lines: z
        .array(z.object({ lineId: Uuid, words: z.number().int().min(3).max(400) }))
        .optional()
        .describe("start: the lines and their word budgets."),
      ai: AiInput,
      jobId: Uuid.optional().describe("apply: the finished start job."),
      lineIds: z.array(Uuid).optional().describe("apply: the rewrites to keep."),
      ttsAi: TtsAi,
      idempotencyKey: IdempotencyKey,
    }),
    output: Passthrough,
    scopes: ["narration:write", "generations:run"],
    sensitivity: "spend",
    idempotent: false,
    routes: [
      "POST /api/chapters/:id/narration/retime",
      "POST /api/chapters/:id/narration/retime/:jobId/apply",
      "POST /api/chapters/:id/narration/synthesize",
    ],
    actionKeys: ["narration.retime", "narration.retime_apply"],
    classify: async (a, ctx) => {
      const p = await projectOf(ctx, "chapter", a.chapterId);
      if (a.action === "start")
        return cls(
          textSpend(a.ai, "write"),
          "narration.retime",
          p,
          `Rewrite ${a.lines?.length ?? 0} narration line(s) to a word budget ${aiLabel(a.ai)}`,
        );
      const paid = Boolean(a.ttsAi?.credentialId || a.ttsAi?.provider);
      return cls(
        paid ? "spend" : "write",
        "narration.retime_apply",
        p,
        `Replace ${a.lineIds?.length ?? 0} narration line(s) with their rewrites and re-voice them ${paid ? "with a speech provider; spends credits" : "with the local voice (free)"}`,
      );
    },
    handler: async (a, ctx) => {
      if (a.action === "start") {
        if (!a.lines?.length) throw toolError(400, "bad_request", "start needs lines");
        const r = await ctx.invoke<{ job: Record<string, unknown> }>(
          "POST",
          `/api/chapters/${a.chapterId}/narration/retime`,
          { body: { lines: a.lines, ai: await restAi(ctx, a.ai) } },
        );
        return { data: { job: jobView(r.job) } };
      }
      if (!a.jobId || !a.lineIds?.length) throw toolError(400, "bad_request", "apply needs jobId and lineIds");
      const applied = await ctx.invoke<{ applied: { lineId: string }[] }>(
        "POST",
        `/api/chapters/${a.chapterId}/narration/retime/${a.jobId}/apply`,
        { body: { lineIds: a.lineIds } },
      );
      const lineIds = applied.applied.map((x) => x.lineId);
      const voice = lineIds.length
        ? await ctx.invoke("POST", `/api/chapters/${a.chapterId}/narration/synthesize`, {
            body: { lineIds, onlyMissing: true, ai: a.ttsAi ? await restAi(ctx, a.ttsAi) : undefined },
          })
        : null;
      return { data: { ...applied, synthesis: voice } };
    },
  }),
];
