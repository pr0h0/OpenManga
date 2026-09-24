import {
  and,
  asc,
  audioAssets,
  audioJobs,
  chapters,
  dialogueLines,
  eq,
  inArray,
  narrationLines,
  narrationSegments,
  pages,
  panels,
  projects,
  sql,
} from "@openmanga/db";
import {
  buildTimeline,
  DEFAULT_NARRATION_PAUSE_MS,
  draftBubble,
  PRIORITY,
  placeBubble,
  resolveLettering,
  segmentNarration,
} from "@openmanga/domain";
import { narrationV5 } from "@openmanga/prompts";
import { Bubble, type Frame, type ProjectSettings } from "@openmanga/schemas";
import { applyNarrationPauses } from "@openmanga/services";
import { sha256Hex } from "@openmanga/storage";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import {
  AiChoiceInput,
  assertBatchable,
  assertBudget,
  BatchInput,
  batchParameters,
  queueTextBatchSubmit,
  textRun,
  ttsRun,
} from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { rateLimit } from "../lib/middleware.ts";
import { doc } from "../lib/openapi.ts";

export const audioRoutes = new Hono<AppEnv>();

/** Ceilings for local speech synthesis, which runs on the operator's CPU rather than a caller's provider key. */
const MAX_QUEUED_PER_REQUEST = 2000;
const MAX_PENDING_AUDIO_JOBS = 5000;

async function lineWithAccess(c: Context<AppEnv>, id: string, action: "read" | "write" | "generate") {
  const [l] = await c.get("deps").db.select().from(narrationLines).where(eq(narrationLines.id, id));
  if (!l) throw notFound("Narration line");
  const project = await projectAccess(c, l.projectId, action);
  return { line: l, project };
}
async function segmentWithAccess(c: Context<AppEnv>, id: string, action: "read" | "write" | "generate") {
  const [s] = await c.get("deps").db.select().from(narrationSegments).where(eq(narrationSegments.id, id));
  if (!s) throw notFound("Narration segment");
  const project = await projectAccess(c, s.projectId, action);
  return { segment: s, project };
}

async function resegment(c: Context<AppEnv>, lineId: string, projectId: string, text: string, maxChars: number) {
  const { db } = c.get("deps");
  const old = await db
    .select()
    .from(narrationSegments)
    .where(eq(narrationSegments.narrationLineId, lineId))
    .orderBy(asc(narrationSegments.order));
  await db.delete(narrationSegments).where(eq(narrationSegments.narrationLineId, lineId));
  const [proj] = await db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, projectId));
  const segs = segmentNarration(text, maxChars, proj?.settings.narrationPauseMs);
  if (!segs.length) return [];
  // Keep the line's closing pause (a scene break or a hand-tuned value) on its new last segment.
  const closing = old.at(-1)?.pauseAfterMs;
  if (closing !== undefined) segs[segs.length - 1]!.pauseAfterMs = closing;
  return db
    .insert(narrationSegments)
    .values(
      segs.map((s, i) => {
        const prior = old.find((o) => o.text === s.text);
        return {
          projectId,
          narrationLineId: lineId,
          order: i,
          text: s.text,
          textSha256: sha256Hex(s.text),
          pauseAfterMs: s.pauseAfterMs,
          voice: prior?.voice ?? null,
          speed: prior?.speed ?? null,
          activeAudioAssetId: prior?.activeAudioAssetId ?? null,
        };
      }),
    )
    .returning();
}

doc({
  method: "GET",
  path: "/api/chapters/:id/narration",
  summary: "Narration lines, segments, audio and job states for a chapter",
  tag: "narration",
});
audioRoutes.get("/chapters/:id/narration", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "read");
  const { db } = c.get("deps");
  const language = c.req.query("language") || project.language;
  const lines = await db
    .select()
    .from(narrationLines)
    .where(and(eq(narrationLines.chapterId, chapterId), eq(narrationLines.language, language)))
    .orderBy(asc(narrationLines.order));
  const tracks = await db
    .select({ language: narrationLines.language, lines: sql<number>`count(*)::int` })
    .from(narrationLines)
    .where(eq(narrationLines.chapterId, chapterId))
    .groupBy(narrationLines.language);
  const lineIds = lines.map((l) => l.id);
  const segs = lineIds.length
    ? await db
        .select()
        .from(narrationSegments)
        .where(inArray(narrationSegments.narrationLineId, lineIds))
        .orderBy(asc(narrationSegments.order))
    : [];
  const audioIds = segs.map((s) => s.activeAudioAssetId).filter((x): x is string => Boolean(x));
  const audio = audioIds.length
    ? await db.select().from(audioAssets).where(inArray(audioAssets.assetId, audioIds))
    : [];
  const segIds = segs.map((s) => s.id);
  const jobs = segIds.length
    ? await db.execute<{
        segment_id: string;
        id: string;
        status: string;
        failure_reason: string | null;
        failure_code: string | null;
      }>(
        sql`select distinct on (segment_id) segment_id, id, status, failure_reason, failure_code from audio_jobs where segment_id in (${sql.join(
          segIds.map((s) => sql`${s}`),
          sql`, `,
        )}) order by segment_id, created_at desc`,
      )
    : [];
  const [chapter] = await db
    .select({ id: chapters.id, title: chapters.title })
    .from(chapters)
    .where(eq(chapters.id, chapterId));
  const settings = project.settings;
  return c.json({
    chapter,
    language,
    tracks,
    defaults: { voice: settings.narrationVoice, speed: settings.narrationSpeed },
    lines: lines.map((l) => ({
      ...l,
      segments: segs
        .filter((s) => s.narrationLineId === l.id)
        .map((s) => {
          const a = audio.find((x) => x.assetId === s.activeAudioAssetId);
          const j = [...jobs].find((x) => x.segment_id === s.id);
          const voice = s.voice ?? settings.narrationVoice;
          const speed = s.speed ?? settings.narrationSpeed;
          return {
            ...s,
            audio: a ?? null,
            stale: a ? a.textSha256 !== s.textSha256 || a.voice !== voice || Math.abs(a.speed - speed) > 0.001 : false,
            job: j
              ? { id: j.id, status: j.status, failureReason: j.failure_reason, failureCode: j.failure_code }
              : null,
          };
        }),
    })),
  });
});

/** Caption box using the project's narration style, sized to its text, pinned to the panel's top-left. */
async function narrationBox(c: Context<AppEnv>, settings: ProjectSettings, text: string, pageId: string, f: Frame) {
  const { db } = c.get("deps");
  const [pg] = await db
    .select({ w: pages.width, h: pages.height, dir: pages.readingDirection })
    .from(pages)
    .where(eq(pages.id, pageId));
  const W = pg?.w ?? 1024;
  const H = pg?.h ?? 1536;
  const { bubble, size } = draftBubble(text, "narration", resolveLettering(settings), W, H, f.width - 0.02);
  // Avoid bubbles and other captions already on the page.
  const taken = [
    ...(await db.select({ b: dialogueLines.bubble }).from(dialogueLines).where(eq(dialogueLines.pageId, pageId))).map(
      (r) => r.b,
    ),
    ...(await db.select({ b: narrationLines.box }).from(narrationLines).where(eq(narrationLines.pageId, pageId)))
      .map((r) => r.b)
      .filter((b): b is Bubble => Boolean(b)),
  ];
  const rect = placeBubble({
    panel: f,
    text,
    fontSize: bubble.fontSize,
    pageW: W,
    pageH: H,
    preferred: pg?.dir === "rtl" ? "top-right" : "top-left",
    avoid: taken,
    readingDirection: pg?.dir ?? "ltr",
    size,
  });
  return Bubble.parse({ ...bubble, ...rect, tail: false });
}

export const NewLine = z.object({
  text: z.string().trim().min(1).max(20_000),
  language: z.string().trim().min(2).max(16).optional(),
  panelId: z.string().uuid().nullable().default(null),
  showOnPage: z.boolean().default(false),
  afterLineId: z.string().uuid().optional(),
});
doc({
  method: "POST",
  path: "/api/chapters/:id/narration/lines",
  summary: "Add narration line (auto-segmented)",
  tag: "narration",
  body: NewLine,
});
audioRoutes.post("/chapters/:id/narration/lines", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "write");
  const input = await body(c, NewLine);
  const { db } = c.get("deps");
  let pageId: string | null = null;
  let box = null;
  if (input.panelId) {
    const [pn] = await db
      .select({ panel: panels, chapterId: pages.chapterId })
      .from(panels)
      .innerJoin(pages, eq(pages.id, panels.pageId))
      .where(eq(panels.id, input.panelId));
    if (!pn || pn.chapterId !== chapterId) throw badRequest("Panel is not in this chapter");
    pageId = pn.panel.pageId;
    if (input.showOnPage) {
      box = await narrationBox(c, project.settings, input.text, pageId, pn.panel.frame);
    }
  }
  const language = input.language || project.language;
  const line = await db.transaction(async (tx) => {
    const all = await tx
      .select()
      .from(narrationLines)
      .where(and(eq(narrationLines.chapterId, chapterId), eq(narrationLines.language, language)))
      .orderBy(asc(narrationLines.order));
    const after = input.afterLineId ? all.find((l) => l.id === input.afterLineId) : all.at(-1);
    const order = (after?.order ?? 0) + 1;
    await tx
      .update(narrationLines)
      .set({ order: sql`${narrationLines.order} + 1` })
      .where(
        and(
          eq(narrationLines.chapterId, chapterId),
          eq(narrationLines.language, language),
          sql`${narrationLines.order} >= ${order}`,
        ),
      );
    const [l] = await tx
      .insert(narrationLines)
      .values({
        projectId: project.id,
        chapterId,
        pageId,
        panelId: input.panelId,
        order,
        language,
        text: input.text,
        showOnPage: input.showOnPage,
        box,
      })
      .returning();
    return l!;
  });
  const segments = await resegment(c, line.id, project.id, line.text, c.get("deps").config.NARRATION_SEGMENT_MAX_CHARS);
  return c.json({ line, segments }, 201);
});

export const PatchLine = z.object({
  text: z.string().trim().min(1).max(20_000).optional(),
  panelId: z.string().uuid().nullable().optional(),
  showOnPage: z.boolean().optional(),
  box: Bubble.nullable().optional(),
  order: z.number().int().min(1).optional(),
});
doc({
  method: "PATCH",
  path: "/api/narration-lines/:id",
  summary: "Edit narration line (text changes re-segment; unchanged segments keep audio)",
  tag: "narration",
  body: PatchLine,
});
audioRoutes.patch("/narration-lines/:id", async (c) => {
  const { line, project } = await lineWithAccess(c, uuidParam(c, "id"), "write");
  const input = await body(c, PatchLine);
  const { db } = c.get("deps");
  let pageId = line.pageId;
  if (input.panelId !== undefined) {
    pageId = null;
    if (input.panelId) {
      const [pn] = await db
        .select()
        .from(panels)
        .where(and(eq(panels.id, input.panelId), eq(panels.projectId, project.id)));
      if (!pn) throw notFound("Panel");
      pageId = pn.pageId;
    }
  }
  let box = input.box;
  if (input.showOnPage && !line.box && box === undefined && pageId) {
    const [pn] =
      input.panelId || line.panelId
        ? await db
            .select()
            .from(panels)
            .where(eq(panels.id, (input.panelId ?? line.panelId)!))
        : [];
    const f = pn?.frame ?? { x: 0.05, y: 0.05, width: 0.9, height: 0.2 };
    box = await narrationBox(c, project.settings, input.text ?? line.text, pageId, f);
  }
  const [row] = await db
    .update(narrationLines)
    .set({ ...input, pageId, box })
    .where(eq(narrationLines.id, line.id))
    .returning();
  const segments =
    input.text && input.text !== line.text
      ? await resegment(c, line.id, project.id, input.text, c.get("deps").config.NARRATION_SEGMENT_MAX_CHARS)
      : undefined;
  return c.json({ line: row, segments });
});

doc({ method: "DELETE", path: "/api/narration-lines/:id", summary: "Delete narration line", tag: "narration" });
audioRoutes.delete("/narration-lines/:id", async (c) => {
  const { line } = await lineWithAccess(c, uuidParam(c, "id"), "write");
  await c.get("deps").db.delete(narrationLines).where(eq(narrationLines.id, line.id));
  return c.json({ ok: true });
});

const Resegment = z.object({ maxChars: z.number().int().min(40).max(2000).default(400) });
doc({
  method: "POST",
  path: "/api/narration-lines/:id/resegment",
  summary: "Re-split a line into TTS segments",
  tag: "narration",
  body: Resegment,
});
audioRoutes.post("/narration-lines/:id/resegment", async (c) => {
  const { line, project } = await lineWithAccess(c, uuidParam(c, "id"), "write");
  const { maxChars } = await body(c, Resegment);
  return c.json({ segments: await resegment(c, line.id, project.id, line.text, maxChars) });
});

const PausesInput = z.object({ language: z.string().trim().min(2).max(16).optional() });
doc({
  method: "POST",
  path: "/api/chapters/:id/narration/pauses",
  summary:
    "Re-apply the project's narration pause settings to every segment (scene/chapter ends get the longer break). Audio is untouched.",
  tag: "narration",
  body: PausesInput,
});
audioRoutes.post("/chapters/:id/narration/pauses", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "write");
  const { language } = await body(c, PausesInput);
  const updated = await applyNarrationPauses(
    c.get("deps").db,
    chapterId,
    language || project.language,
    project.settings,
  );
  return c.json({ updated });
});

export const GenerateNarration = z.object({
  style: z.string().max(500).default(""),
  replace: z.boolean().default(false),
  /** Overrides the project's narrationWordsPerPanel for this run. */
  wordsPerPanel: z.number().int().min(5).max(80).optional(),
  language: z.string().trim().min(2).max(16).optional(),
  batch: BatchInput,
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/chapters/:id/narration/generate",
  summary: "Queue DeepSeek narration writing for the chapter",
  tag: "narration",
  body: GenerateNarration,
});
audioRoutes.post("/chapters/:id/narration/generate", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "generate");
  const { ai, batch, ...input } = await body(c, GenerateNarration);
  const deps = c.get("deps");
  await assertBudget(c, project.id);
  const run = await textRun(c, ai);
  assertBatchable(c, batch, run.provider);
  const narrationBatchId = batch ? crypto.randomUUID() : null;
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(
      tx,
      {
        projectId: project.id,
        userId: user(c).id,
        kind: "narration_text",
        priority: PRIORITY.single,
        targetType: "chapter",
        targetId: chapterId,
        batchId: narrationBatchId,
        templateName: narrationV5.name,
        templateVersion: narrationV5.version,
        provider: run.provider,
        model: run.model,
        parameters: { ...run.parameters, ...batchParameters(batch) },
        input: { chapterId, ...input },
      },
      { enqueue: !batch },
    ),
  );
  if (narrationBatchId) await queueTextBatchSubmit(c, { projectId: project.id, batchId: narrationBatchId, ai });
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

export const PatchSegment = z.object({
  text: z.string().trim().min(1).max(4000).optional(),
  voice: z.string().max(64).nullable().optional(),
  speed: z.number().min(0.5).max(2).nullable().optional(),
  pauseAfterMs: z.number().int().min(0).max(10_000).optional(),
});
doc({
  method: "PATCH",
  path: "/api/narration-segments/:id",
  summary: "Edit segment text/voice/speed/pause",
  tag: "narration",
  body: PatchSegment,
});
audioRoutes.patch("/narration-segments/:id", async (c) => {
  const { segment } = await segmentWithAccess(c, uuidParam(c, "id"), "write");
  const input = await body(c, PatchSegment);
  const set: Partial<typeof narrationSegments.$inferInsert> = { ...input };
  if (input.text && input.text !== segment.text) {
    set.textSha256 = sha256Hex(input.text);
    // Detach the old audio: it speaks the previous text, and every export reader joins on this pointer alone.
    set.activeAudioAssetId = null;
  }
  const [row] = await c
    .get("deps")
    .db.update(narrationSegments)
    .set(set)
    .where(eq(narrationSegments.id, segment.id))
    .returning();
  return c.json({ segment: row });
});

const Split = z.object({ at: z.number().int().min(1) });
doc({
  method: "POST",
  path: "/api/narration-segments/:id/split",
  summary: "Split a segment at a character offset",
  tag: "narration",
  body: Split,
});
audioRoutes.post("/narration-segments/:id/split", async (c) => {
  const { segment, project } = await segmentWithAccess(c, uuidParam(c, "id"), "write");
  const { at } = await body(c, Split);
  const a = segment.text.slice(0, at).trim();
  const b = segment.text.slice(at).trim();
  if (!a || !b) throw badRequest("Split position must leave text on both sides");
  const { db } = c.get("deps");
  const rows = await db.transaction(async (tx) => {
    await tx
      .update(narrationSegments)
      .set({ order: sql`${narrationSegments.order} + 1` })
      .where(
        and(
          eq(narrationSegments.narrationLineId, segment.narrationLineId),
          sql`${narrationSegments.order} > ${segment.order}`,
        ),
      );
    const [first] = await tx
      .update(narrationSegments)
      .set({
        text: a,
        textSha256: sha256Hex(a),
        activeAudioAssetId: null,
        pauseAfterMs: project.settings.narrationPauseMs ?? DEFAULT_NARRATION_PAUSE_MS,
      })
      .where(eq(narrationSegments.id, segment.id))
      .returning();
    const [second] = await tx
      .insert(narrationSegments)
      .values({
        projectId: project.id,
        narrationLineId: segment.narrationLineId,
        order: segment.order + 1,
        text: b,
        textSha256: sha256Hex(b),
        voice: segment.voice,
        speed: segment.speed,
        pauseAfterMs: segment.pauseAfterMs,
      })
      .returning();
    return [first, second];
  });
  return c.json({ segments: rows });
});

doc({
  method: "POST",
  path: "/api/narration-segments/:id/merge-next",
  summary: "Merge segment with the following one",
  tag: "narration",
});
audioRoutes.post("/narration-segments/:id/merge-next", async (c) => {
  const { segment } = await segmentWithAccess(c, uuidParam(c, "id"), "write");
  const { db } = c.get("deps");
  const [next] = await db
    .select()
    .from(narrationSegments)
    .where(
      and(
        eq(narrationSegments.narrationLineId, segment.narrationLineId),
        sql`${narrationSegments.order} > ${segment.order}`,
      ),
    )
    .orderBy(asc(narrationSegments.order))
    .limit(1);
  if (!next) throw badRequest("No following segment to merge");
  const text = `${segment.text} ${next.text}`;
  const [row] = await db.transaction(async (tx) => {
    await tx.delete(narrationSegments).where(eq(narrationSegments.id, next.id));
    return tx
      .update(narrationSegments)
      .set({ text, textSha256: sha256Hex(text), activeAudioAssetId: null, pauseAfterMs: next.pauseAfterMs })
      .where(eq(narrationSegments.id, segment.id))
      .returning();
  });
  return c.json({ segment: row });
});

// ---- TTS

const FALLBACK_VOICES = [
  { id: "af_heart", name: "Heart", language: "en-us", gender: "female" },
  { id: "af_bella", name: "Bella", language: "en-us", gender: "female" },
  { id: "am_michael", name: "Michael", language: "en-us", gender: "male" },
  { id: "am_fenrir", name: "Fenrir", language: "en-us", gender: "male" },
  { id: "bf_emma", name: "Emma", language: "en-gb", gender: "female" },
  { id: "bm_george", name: "George", language: "en-gb", gender: "male" },
];

doc({ method: "GET", path: "/api/tts/status", summary: "Kokoro status and voices", tag: "narration" });
audioRoutes.get("/tts/status", async (c) => {
  const tts = c.get("deps").tts;
  if (!tts) return c.json({ enabled: false, status: { ok: false, state: "disabled" }, voices: [] });
  const status = await tts.health();
  const voices = status.ok ? await tts.voices().catch(() => FALLBACK_VOICES) : FALLBACK_VOICES;
  return c.json({ enabled: true, provider: tts.provider, status, voices });
});

const previewCache = new Map<string, Uint8Array>();
const Preview = z.object({
  voice: z.string().max(128).default(""),
  ai: AiChoiceInput,
  speed: z.number().min(0.5).max(2).default(1),
  text: z.string().trim().min(1).max(240).default("The rain continued through the night."),
});
doc({
  method: "POST",
  path: "/api/tts/preview",
  summary: "Short voice preview (WAV, max 240 chars)",
  tag: "narration",
  body: Preview,
});
audioRoutes.post(
  "/tts/preview",
  // Synchronous synthesis on the operator's CPU, off-queue: a handful of concurrent previews would starve narration.
  rateLimit({ key: "tts-preview", limit: () => 20, windowSec: 60, by: "user" }),
  async (c) => {
    const input = await body(c, Preview);
    const run = await ttsRun(c, input.ai, input.voice);
    const tts = (await c.get("deps").resolver.tts(input.ai ?? null, user(c).id))!;
    if (run.voice) input.voice = run.voice;
    // Scoped per user + provider so one user's key never serves another user's preview.
    const key = sha256Hex(
      `${user(c).id}|${input.ai?.credentialId ?? "default"}|${input.ai?.model ?? ""}|${input.voice}|${input.speed}|${input.text}`,
    );
    let wav = previewCache.get(key);
    if (!wav) {
      const r = await tts.synthesize({ text: input.text, voice: input.voice, speed: input.speed });
      wav = r.wav;
      previewCache.set(key, wav);
      if (previewCache.size > 50) previewCache.delete(previewCache.keys().next().value!);
    }
    return c.body(wav.slice().buffer as ArrayBuffer, 200, {
      "content-type": "audio/wav",
      "cache-control": "private, max-age=600",
    });
  },
);

export const Synth = z.object({
  voice: z.string().max(128).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  force: z.boolean().default(false),
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/narration-segments/:id/synthesize",
  summary: "Queue local Kokoro synthesis for one segment",
  tag: "narration",
  body: Synth,
});
audioRoutes.post("/narration-segments/:id/synthesize", async (c) => {
  const { segment, project } = await segmentWithAccess(c, uuidParam(c, "id"), "generate");
  const input = await body(c, Synth);
  const deps = c.get("deps");
  // The batch route skips segments that already have a job in flight; this one has to as well, or two clicks
  // synthesise the same line twice on the operator's CPU.
  const [inFlight] = await deps.db
    .select({ id: audioJobs.id })
    .from(audioJobs)
    .where(and(eq(audioJobs.segmentId, segment.id), inArray(audioJobs.status, ["queued", "processing"])))
    .limit(1);
  if (inFlight) throw conflict("This segment is already being synthesized");
  const voiceRun = await ttsRun(c, input.ai, input.voice);
  const voice = voiceRun.voice ?? input.voice ?? segment.voice ?? project.settings.narrationVoice;
  const speed = input.speed ?? segment.speed ?? project.settings.narrationSpeed;
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createAudioJob(tx, {
      projectId: project.id,
      userId: user(c).id,
      segmentId: segment.id,
      voice,
      speed,
      priority: PRIORITY.interactive,
      options: voiceRun.options,
    }),
  );
  await deps.jobs.kick();
  return c.json({ job, force: input.force }, 202);
});

export const SynthAll = z.object({
  onlyMissing: z.boolean().default(true),
  /** Voice for every segment when a BYOK provider is chosen (provider voices differ from Kokoro's). */
  voice: z.string().max(128).optional(),
  language: z.string().trim().min(2).max(16).optional(),
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/chapters/:id/narration/synthesize",
  summary: "Queue synthesis for all missing/stale segments of a chapter",
  tag: "narration",
  body: SynthAll,
});
audioRoutes.post("/chapters/:id/narration/synthesize", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "generate");
  const { onlyMissing, voice: voiceOverride, ai, language: lang } = await body(c, SynthAll);
  const language = lang || project.language;
  const deps = c.get("deps");
  const voiceRun = await ttsRun(c, ai, voiceOverride);
  const segs = await deps.db
    .select({ s: narrationSegments, a: audioAssets })
    .from(narrationSegments)
    .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
    .leftJoin(audioAssets, eq(audioAssets.assetId, narrationSegments.activeAudioAssetId))
    .where(and(eq(narrationLines.chapterId, chapterId), eq(narrationLines.language, language)))
    .orderBy(asc(narrationLines.order), asc(narrationSegments.order));
  const batchId = crypto.randomUUID();
  const pending = await deps.db
    .select({ segmentId: audioJobs.segmentId })
    .from(audioJobs)
    .where(and(eq(audioJobs.projectId, project.id), inArray(audioJobs.status, ["queued", "processing"])));
  const busy = new Set(pending.map((p) => p.segmentId));
  // Local synthesis is the operator's own CPU, not the caller's provider account, so it needs a ceiling that the
  // BYOK paths do not: refuse while a backlog is already running, and queue at most a chapter's worth per request.
  if (pending.length >= MAX_PENDING_AUDIO_JOBS)
    throw conflict(`This project already has ${pending.length} narration jobs in progress. Wait for them to finish.`);
  let queued = 0;
  let skippedOverCap = 0;
  await deps.db.transaction(async (tx) => {
    for (const { s, a } of segs) {
      if (queued >= MAX_QUEUED_PER_REQUEST) {
        skippedOverCap++;
        continue;
      }
      if (busy.has(s.id)) continue;
      const voice = voiceRun.voice ?? s.voice ?? project.settings.narrationVoice;
      const speed = s.speed ?? project.settings.narrationSpeed;
      const fresh =
        a &&
        a.provider === voiceRun.provider &&
        a.textSha256 === s.textSha256 &&
        a.voice === voice &&
        Math.abs(a.speed - speed) < 0.001;
      if (onlyMissing && fresh) continue;
      await deps.jobs.createAudioJob(tx, {
        projectId: project.id,
        userId: user(c).id,
        segmentId: s.id,
        voice,
        speed,
        batchId,
        priority: PRIORITY.page,
        options: voiceRun.options,
      });
      queued++;
    }
  });
  await deps.jobs.kick();
  return c.json({ batchId, queued, total: segs.length, skippedOverCap }, 202);
});

const ProgressQuery = z.object({ language: z.string().trim().min(2).max(16).optional() });
doc({
  method: "GET",
  path: "/api/projects/:projectId/narration/progress",
  summary: "Synthesis progress per chapter: segments, how many have audio, and what is still running",
  tag: "narration",
  query: ProgressQuery,
});
audioRoutes.get("/projects/:projectId/narration/progress", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const language = query(c, ProgressQuery).language || p.language;
  // One query for the whole project: synthesis runs chapter by chapter but is watched across all of them, and a
  // request per chapter would be a dozen round trips for a screen that polls.
  const rows = await c.get("deps").db.execute<{
    id: string;
    title: string;
    order: number;
    lines: number;
    segments: number;
    with_audio: number;
    queued: number;
    processing: number;
    failed: number;
  }>(sql`
    select ch.id, ch.title, ch."order",
      count(distinct nl.id)::int as lines,
      count(ns.id)::int as segments,
      count(ns.id) filter (where ns.active_audio_asset_id is not null)::int as with_audio,
      count(aj.id) filter (where aj.status = 'queued')::int as queued,
      count(aj.id) filter (where aj.status = 'processing')::int as processing,
      count(aj.id) filter (where aj.status = 'failed')::int as failed
    from chapters ch
    left join narration_lines nl on nl.chapter_id = ch.id and nl.language = ${language}
    left join narration_segments ns on ns.narration_line_id = nl.id
    left join audio_jobs aj on aj.segment_id = ns.id
    where ch.project_id = ${p.id}
    group by ch.id, ch.title, ch."order"
    having count(ns.id) > 0
    order by ch."order"`);
  const chapters = [...rows].map((r) => ({
    id: r.id,
    title: r.title,
    order: r.order,
    lines: r.lines,
    segments: r.segments,
    withAudio: r.with_audio,
    queued: r.queued,
    processing: r.processing,
    failed: r.failed,
  }));
  const sum = (k: "segments" | "withAudio" | "queued" | "processing" | "failed") =>
    chapters.reduce((n, ch) => n + ch[k], 0);
  return c.json({
    language,
    chapters,
    totals: {
      chapters: chapters.length,
      segments: sum("segments"),
      withAudio: sum("withAudio"),
      queued: sum("queued"),
      processing: sum("processing"),
      failed: sum("failed"),
    },
  });
});

doc({
  method: "GET",
  path: "/api/chapters/:id/narration/timeline",
  summary: "Machine-readable timeline manifest (panelId, audioAssetId, startMs, durationMs)",
  tag: "narration",
});
audioRoutes.get("/chapters/:id/narration/timeline", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "read");
  const language = c.req.query("language") || project.language;
  const rows = await c
    .get("deps")
    .db.select({ s: narrationSegments, l: narrationLines, a: audioAssets })
    .from(narrationSegments)
    .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
    .leftJoin(audioAssets, eq(audioAssets.assetId, narrationSegments.activeAudioAssetId))
    .where(and(eq(narrationLines.chapterId, chapterId), eq(narrationLines.language, language)))
    .orderBy(asc(narrationLines.order), asc(narrationSegments.order));
  return c.json(
    buildTimeline(
      chapterId,
      rows.map((r) => ({
        panelId: r.l.panelId,
        segmentId: r.s.id,
        audioAssetId: r.a?.assetId ?? null,
        durationMs: r.a?.durationMs ?? null,
        pauseAfterMs: r.s.pauseAfterMs,
        text: r.s.text,
      })),
    ),
  );
});

doc({
  method: "POST",
  path: "/api/audio-jobs/:id/cancel",
  summary: "Cancel a narration synthesis job that hasn't started",
  tag: "narration",
});
audioRoutes.post("/audio-jobs/:id/cancel", async (c) => {
  const id = uuidParam(c, "id");
  const deps = c.get("deps");
  const [job] = await deps.db.select().from(audioJobs).where(eq(audioJobs.id, id));
  if (!job) throw notFound("Audio job");
  await projectAccess(c, job.projectId, "generate");
  const result = await deps.jobs.cancelAudio(id);
  if (result === "not_cancellable") throw conflict(`Audio job is ${job.status} and can't be cancelled`);
  return c.json({ result });
});

doc({
  method: "POST",
  path: "/api/chapters/:id/narration/synthesize/cancel",
  summary: "Cancel all not-yet-started synthesis jobs for a chapter",
  tag: "narration",
});
audioRoutes.post("/chapters/:id/narration/synthesize/cancel", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "generate");
  const deps = c.get("deps");
  const queued = await deps.db
    .select({ id: audioJobs.id })
    .from(audioJobs)
    .innerJoin(narrationSegments, eq(narrationSegments.id, audioJobs.segmentId))
    .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
    .where(
      and(eq(audioJobs.projectId, project.id), eq(audioJobs.status, "queued"), eq(narrationLines.chapterId, chapterId)),
    );
  let cancelled = 0;
  for (const j of queued) if ((await deps.jobs.cancelAudio(j.id)) === "cancelled") cancelled++;
  return c.json({ cancelled, remaining: queued.length - cancelled });
});
