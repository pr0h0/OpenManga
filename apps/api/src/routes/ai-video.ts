import {
  and,
  asc,
  assets,
  characters,
  characterVersions,
  desc,
  eq,
  generationJobs,
  inArray,
  isNull,
  locations,
  locationVersions,
  pages,
  panels,
  projects,
  sql,
} from "@openmanga/db";
import {
  clipDuration,
  clipResolution,
  estimateClipUsd,
  LOCAL_VIDEO_MODEL,
  PRIORITY,
  ProviderError,
  providerSupports,
  VIDEO_MODELS,
  type VideoClipAspect,
  type VideoModel,
  videoModel,
} from "@openmanga/domain";
import { adScriptV1, panelClipV1 } from "@openmanga/prompts";
import { AdBrief, type ShotVideo } from "@openmanga/schemas";
import { recordAudit } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { AiChoiceInput, assertBudget, textRun } from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * AI video: a shot's video clip from its image (or its words alone) by a video model, played in video renders in
 * place of the still and its camera move. Every server has the free still-motion model; paid models (fal) run on
 * the user's own key and are priced per second before anything is queued. Also an ad's script from its brief.
 */
export const aiVideoRoutes = new Hono<AppEnv>();

/** A video run: the user's key (null for the free local model) and a model of VIDEO_MODELS. */
const VideoChoice = z.object({
  credentialId: z.string().uuid().nullable().default(null),
  model: z.string().trim().min(1).max(200).default(LOCAL_VIDEO_MODEL),
});
type VideoChoice = z.infer<typeof VideoChoice>;

const ClipOptions = z.object({
  /** Wanted length; the model's closest offered length at or above it is used. */
  seconds: z.number().min(1).max(20).default(5),
  resolution: z.enum(["480p", "720p", "1080p"]).default("720p"),
  /** Frame shape; default the project's video shape. */
  aspect: z.enum(["16:9", "9:16", "1:1"]).optional(),
  /** Ask for sound, on models that make it. */
  audio: z.boolean().default(false),
  seed: z.number().int().min(0).max(2 ** 31).nullable().default(null),
  /** What moves, for this run only (the shot's own clipPrompt otherwise, then its beat). */
  prompt: z.string().trim().max(1500).nullable().optional(),
  /** A project image to land on as the last frame (models with endFrame), e.g. the next shot's art. */
  endAssetId: z.string().uuid().nullable().optional(),
});

/** The model a choice names, after checking the key can run it. */
async function videoRun(c: Context<AppEnv>, choice: VideoChoice) {
  const m = videoModel(choice.model);
  if (!m) throw badRequest(`Unknown video model ${choice.model}`);
  if (m.provider !== "local" && !choice.credentialId) throw badRequest(`${m.label} needs one of your provider keys`);
  try {
    const p = await c.get("deps").resolver.video(choice, user(c).id);
    return { model: m, provider: m.provider === "local" ? "local" : p.provider };
  } catch (e) {
    if (e instanceof ProviderError) throw badRequest(e.message);
    throw e;
  }
}

const projectAspect = (p: { settings: { video?: { output?: { aspect?: VideoClipAspect } } } }): VideoClipAspect =>
  p.settings.video?.output?.aspect ?? "16:9";

/** The clip prompt for a panel, compiled now so the job stores exactly what was asked. */
async function clipPrompt(
  c: Context<AppEnv>,
  pn: typeof panels.$inferSelect,
  m: VideoModel,
  seconds: number,
  opts: { prompt?: string | null; fromImage: boolean; endFrame: boolean },
) {
  const deps = c.get("deps");
  const { style } = await deps.planner.styleContext(pn.projectId);
  const cast = pn.characterVersionIds.length
    ? await deps.db
        .select({ name: characters.name, bible: characterVersions.description })
        .from(characterVersions)
        .innerJoin(characters, eq(characters.id, characterVersions.characterId))
        .where(inArray(characterVersions.id, pn.characterVersionIds))
    : [];
  const [loc] = pn.locationVersionId
    ? await deps.db
        .select({ name: locations.name, d: locationVersions.description })
        .from(locationVersions)
        .innerJoin(locations, eq(locations.id, locationVersions.locationId))
        .where(eq(locationVersions.id, pn.locationVersionId))
    : [];
  const video = (pn.video ?? {}) as Partial<ShotVideo>;
  return panelClipV1.compile({
    style,
    beat: pn.storyBeat,
    action: opts.prompt?.trim() || video.clipPrompt || null,
    shotType: pn.shotType,
    cameraAngle: pn.cameraAngle,
    motion: video.motion ?? "auto",
    seconds,
    fromImage: opts.fromImage,
    cast: cast.map((x) => ({
      name: x.name,
      look: x.bible.summary || [x.bible.hair, x.bible.wardrobe].filter(Boolean).join("; "),
    })),
    location: loc ? `${loc.name}${loc.d.summary ? ` — ${loc.d.summary}` : ""}` : null,
    endFrame: opts.endFrame && m.endFrame,
  });
}

type Planned = {
  panel: typeof panels.$inferSelect;
  model: VideoModel;
  ai: VideoChoice;
  seconds: number;
  resolution: "480p" | "720p" | "1080p";
  audio: boolean;
  usd: number;
};

/** What one run of one panel would make and cost; throws when the panel cannot be animated by that model. */
function planClip(
  pn: typeof panels.$inferSelect,
  m: VideoModel,
  ai: VideoChoice,
  o: z.infer<typeof ClipOptions>,
): Planned {
  if (!pn.activeArtworkAssetId && !m.textToVideo)
    throw badRequest(`${m.label} animates the shot's image: draw the shot first`);
  if (pn.activeArtworkAssetId && !m.imageToVideo) throw badRequest(`${m.label} makes clips from words only`);
  const seconds = clipDuration(m, o.seconds);
  const resolution = clipResolution(m, o.resolution);
  const audio = o.audio && m.audio;
  return { panel: pn, model: m, ai, seconds, resolution, audio, usd: estimateClipUsd(m, seconds, resolution, audio) };
}

/** Queues the planned clips (one job each) in one transaction; the caller has checked access and budget. */
async function enqueueClips(
  c: Context<AppEnv>,
  project: { id: string; settings: { video?: { output?: { aspect?: VideoClipAspect } } } },
  planned: Planned[],
  o: z.infer<typeof ClipOptions> & { activate: boolean; compareId?: string },
) {
  const deps = c.get("deps");
  const aspect = o.aspect ?? projectAspect(project);
  if (o.endAssetId) {
    const end = await deps.assets.get(o.endAssetId);
    if (!end || end.deletedAt || end.projectId !== project.id || !end.mimeType.startsWith("image/"))
      throw badRequest("The last frame must be an image of this project");
  }
  const { style: look } = await deps.planner.styleContext(project.id);
  const style = look.definition?.photoreal ? "realistic" : /cartoon/i.test(look.presetName ?? "") ? "cartoon" : "anime";
  const jobs = [];
  for (const p of planned) {
    const fromImage = Boolean(p.panel.activeArtworkAssetId);
    const compiled = await clipPrompt(c, p.panel, p.model, p.seconds, {
      prompt: o.prompt,
      fromImage,
      endFrame: Boolean(o.endAssetId),
    });
    const video = (p.panel.video ?? {}) as Partial<ShotVideo>;
    jobs.push(
      await deps.db.transaction((tx) =>
        deps.jobs.createGenerationJob(tx, {
          projectId: project.id,
          userId: user(c).id,
          kind: "panel_clip",
          priority: planned.length > 1 && !o.compareId ? PRIORITY.chapter : PRIORITY.single,
          targetType: "panel",
          targetId: p.panel.id,
          templateName: panelClipV1.name,
          templateVersion: panelClipV1.version,
          compiledPrompt: compiled,
          provider: p.model.provider,
          model: p.model.id,
          parameters: {
            ai: { credentialId: p.ai.credentialId, model: p.model.id },
            estimatedUsd: p.usd,
            ...(o.compareId ? { compare: o.compareId } : {}),
          },
          input: {
            panelId: p.panel.id,
            pageId: p.panel.pageId,
            sourceAssetId: p.panel.activeArtworkAssetId,
            endAssetId: o.endAssetId && p.model.endFrame ? o.endAssetId : null,
            seconds: p.seconds,
            resolution: p.resolution,
            aspect: p.model.aspects.includes(aspect) ? aspect : p.model.aspects[0],
            audio: p.audio,
            seed: o.seed,
            motion: video.motion ?? "auto",
            style,
            activate: o.activate,
          },
        }),
      ),
    );
  }
  await deps.jobs.kick();
  return jobs;
}

doc({
  method: "GET",
  path: "/api/video-models",
  summary:
    "Video models a shot's clip can be made with: each one's provider, lengths, resolutions, shapes, end-frame and sound support, list price per second and whether the caller can run it (the free still-motion model always; a paid one with one of their keys for its provider, listed in `credentials`).",
  tag: "panels",
});
aiVideoRoutes.get("/video-models", async (c) => {
  const creds = (await c.get("deps").credentials.list(user(c).id)).filter((x) => providerSupports(x.kind, "video"));
  return c.json({
    models: VIDEO_MODELS.map((m) => ({
      ...m,
      usable: m.provider === "local" || creds.some((x) => x.kind === m.provider),
    })),
    credentials: creds.map((x) => ({ id: x.id, kind: x.kind, label: x.label })),
  });
});

doc({
  method: "GET",
  path: "/api/panels/:id/clips",
  summary:
    "A shot's video clips, newest first (each with its model, length, size, cost and the job that made it), the one it plays (`activeAssetId`, null for its still), the clips being made, and the prompt a clip would be asked with now.",
  tag: "panels",
});
aiVideoRoutes.get("/panels/:id/clips", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "panel", id, "read");
  const deps = c.get("deps");
  const [pn] = await deps.db.select().from(panels).where(eq(panels.id, id));
  if (!pn) throw notFound("Panel");
  const clips = await deps.db
    .select({
      assetId: assets.id,
      createdAt: assets.createdAt,
      durationMs: assets.durationMs,
      width: assets.width,
      height: assets.height,
      metadata: assets.metadata,
      jobId: assets.generationJobId,
      costUsd: sql<number>`coalesce((select sum(u.estimated_cost_usd)::float from ai_usage u where u.generation_job_id = ${assets.generationJobId}), 0)`,
    })
    .from(assets)
    .where(
      and(
        eq(assets.projectId, pn.projectId),
        eq(assets.type, "panel_clip"),
        isNull(assets.deletedAt),
        sql`${assets.metadata}->>'panelId' = ${id}`,
      ),
    )
    .orderBy(desc(assets.createdAt))
    .limit(30);
  const running = await deps.db
    .select({
      jobId: generationJobs.id,
      status: generationJobs.status,
      model: generationJobs.model,
      failureReason: generationJobs.failureReason,
      createdAt: generationJobs.createdAt,
      compare: sql<string | null>`${generationJobs.parameters}->>'compare'`,
    })
    .from(generationJobs)
    .where(and(eq(generationJobs.kind, "panel_clip"), eq(generationJobs.targetId, id)))
    .orderBy(desc(generationJobs.createdAt))
    .limit(10);
  const video = (pn.video ?? {}) as Partial<ShotVideo>;
  const local = videoModel(LOCAL_VIDEO_MODEL)!;
  return c.json({
    activeAssetId: video.clipAssetId ?? null,
    clipPrompt: video.clipPrompt ?? null,
    clipAudio: video.clipAudio ?? "mute",
    hasArt: Boolean(pn.activeArtworkAssetId),
    clips: clips.map((x) => {
      const m = x.metadata as Record<string, unknown>;
      return {
        assetId: x.assetId,
        createdAt: x.createdAt,
        durationMs: x.durationMs,
        width: x.width,
        height: x.height,
        provider: m.provider ?? null,
        model: m.model ?? null,
        seconds: m.seconds ?? null,
        resolution: m.resolution ?? null,
        audio: Boolean(m.audio),
        jobId: x.jobId,
        costUsd: Math.round(Number(x.costUsd) * 10000) / 10000,
      };
    }),
    jobs: running,
    prompt: await clipPrompt(c, pn, local, 5, { fromImage: Boolean(pn.activeArtworkAssetId), endFrame: false }),
  });
});

const GenerateInput = ClipOptions.extend({
  /** One run, or 2-4 to compare models on the same shot (each kept as a version, none made active). */
  runs: z.array(VideoChoice).min(1).max(4),
  /** Price it without queueing anything. */
  dryRun: z.boolean().default(false),
});
doc({
  method: "POST",
  path: "/api/panels/:id/clips",
  summary:
    "Make a video clip of the shot: from its artwork (image-to-video) or, on models that can, from its words alone. Each run names a model and the key to run it with (credentialId null: the free still-motion model). One run becomes the shot's clip when it lands; 2-4 runs compare models and are kept as versions to pick from. Paid runs spend the key's credits at the model's price per second (`estimate`); dryRun=true only prices it. Asynchronous: returns the jobs; poll get_job or GET clips.",
  tag: "panels",
  body: GenerateInput,
});
aiVideoRoutes.post("/panels/:id/clips", async (c) => {
  const id = uuidParam(c, "id");
  const project = await entityAccess(c, "panel", id, "generate");
  const input = await body(c, GenerateInput);
  const deps = c.get("deps");
  const [pn] = await deps.db.select().from(panels).where(eq(panels.id, id));
  if (!pn) throw notFound("Panel");
  const planned: Planned[] = [];
  for (const ai of input.runs) planned.push(planClip(pn, (await videoRun(c, ai)).model, ai, input));
  const estimate = {
    usd: Math.round(planned.reduce((n, p) => n + p.usd, 0) * 10000) / 10000,
    runs: planned.map((p) => ({ model: p.model.id, seconds: p.seconds, resolution: p.resolution, usd: p.usd })),
  };
  if (input.dryRun) return c.json({ estimate });
  await assertBudget(c, project.id, estimate.usd);
  const compareId = planned.length > 1 ? crypto.randomUUID() : undefined;
  const jobs = await enqueueClips(c, project, planned, { ...input, activate: !compareId, compareId });
  return c.json({ estimate, compareId: compareId ?? null, jobs }, 202);
});

const UseInput = z.object({ assetId: z.string().uuid().nullable() });
doc({
  method: "POST",
  path: "/api/panels/:id/clips/use",
  summary:
    "Choose what the shot plays in video renders: one of its clips (assetId), or null for its still with its camera move.",
  tag: "panels",
  body: UseInput,
});
aiVideoRoutes.post("/panels/:id/clips/use", async (c) => {
  const id = uuidParam(c, "id");
  const project = await entityAccess(c, "panel", id, "write");
  const { assetId } = await body(c, UseInput);
  const deps = c.get("deps");
  const [pn] = await deps.db.select().from(panels).where(eq(panels.id, id));
  if (!pn) throw notFound("Panel");
  if (pn.approvalStatus === "locked") throw conflict("Panel is locked");
  if (assetId) {
    const a = await deps.assets.get(assetId);
    if (!a || a.deletedAt || a.type !== "panel_clip" || (a.metadata as { panelId?: string }).panelId !== id)
      throw notFound("Clip");
  }
  const video = { ...((pn.video ?? {}) as Partial<ShotVideo>), clipAssetId: assetId } as ShotVideo;
  await deps.db.update(panels).set({ video }).where(eq(panels.id, id));
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: project.id,
    action: "panel.clip_use",
    targetType: "panel",
    targetId: id,
    metadata: { assetId },
    requestId: c.get("requestId"),
  });
  return c.json({ activeAssetId: assetId });
});

doc({
  method: "DELETE",
  path: "/api/clips/:assetId",
  summary: "Move a clip to the trash; a shot that played it goes back to its still.",
  tag: "panels",
});
aiVideoRoutes.delete("/clips/:assetId", async (c) => {
  const deps = c.get("deps");
  const a = await deps.assets.get(uuidParam(c, "assetId"));
  const panelId = (a?.metadata as { panelId?: string } | undefined)?.panelId;
  if (!a || a.deletedAt || a.type !== "panel_clip" || !panelId) throw notFound("Clip");
  await entityAccess(c, "panel", panelId, "write");
  await deps.db.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, a.id));
  await deps.db
    .update(panels)
    .set({ video: sql`jsonb_set(${panels.video}, '{clipAssetId}', 'null'::jsonb)` })
    .where(and(eq(panels.id, panelId), sql`${panels.video}->>'clipAssetId' = ${a.id}`));
  return c.body(null, 204);
});

const ChapterInput = ClipOptions.extend({
  ai: VideoChoice,
  /** Skip shots that already play a clip. */
  onlyMissing: z.boolean().default(true),
  dryRun: z.boolean().default(false),
});
doc({
  method: "POST",
  path: "/api/chapters/:id/clips",
  summary:
    "Make a clip for every drawn shot of a chapter (skipping disabled shots, and with onlyMissing those that already play one) with one model. dryRun=true returns how many and the estimated cost without queueing; otherwise the budget is checked against the estimate first. Each clip becomes its shot's when it lands.",
  tag: "chapters",
  body: ChapterInput,
});
aiVideoRoutes.post("/chapters/:id/clips", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "generate");
  const input = await body(c, ChapterInput);
  const deps = c.get("deps");
  const m = (await videoRun(c, input.ai)).model;
  const rows = await deps.db
    .select({ panel: panels })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .where(eq(pages.chapterId, chapterId))
    .orderBy(asc(pages.order), asc(panels.order));
  const planned: Planned[] = [];
  const skipped: { panelId: string; reason: string }[] = [];
  for (const { panel } of rows) {
    const v = (panel.video ?? {}) as Partial<ShotVideo>;
    if (v.disabled) continue;
    if (input.onlyMissing && v.clipAssetId) continue;
    try {
      planned.push(planClip(panel, m, input.ai, input));
    } catch (e) {
      skipped.push({ panelId: panel.id, reason: (e as Error).message });
    }
  }
  const estimate = {
    shots: planned.length,
    seconds: planned.reduce((n, p) => n + p.seconds, 0),
    usd: Math.round(planned.reduce((n, p) => n + p.usd, 0) * 10000) / 10000,
    model: m.id,
  };
  if (input.dryRun || !planned.length) return c.json({ estimate, skipped, jobs: [] });
  if (planned.length > 200) throw badRequest("At most 200 clips at once: animate the chapter in parts");
  await assertBudget(c, project.id, estimate.usd);
  const jobs = await enqueueClips(c, project, planned, { ...input, activate: true });
  return c.json({ estimate, skipped, jobs }, 202);
});

const AdInput = z.object({ brief: AdBrief, ai: AiChoiceInput });
doc({
  method: "POST",
  path: "/api/projects/:id/ad-script",
  summary:
    "Write an ad's script from its brief (product, audience, key message, offer, call to action, notes, length, tone): a text job whose answer is saved as a new story revision (a screenplay of scenes with what is seen, the voiceover and text on screen), ready for analysis and planning like any story. The brief is kept in settings.ad. ai.manual=true asks you for an AdScript answer instead of a provider.",
  tag: "stories",
  body: AdInput,
});
aiVideoRoutes.post("/projects/:id/ad-script", async (c) => {
  const projectId = uuidParam(c, "id");
  const project = await projectAccess(c, projectId, "generate");
  const { brief, ai } = await body(c, AdInput);
  const deps = c.get("deps");
  if (!ai?.manual) await assertBudget(c, projectId);
  const run = await textRun(c, ai);
  const { style } = await deps.planner.styleContext(projectId);
  await deps.db
    .update(projects)
    .set({ settings: { ...project.settings, ad: brief } })
    .where(eq(projects.id, projectId));
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(tx, {
      projectId,
      userId: user(c).id,
      kind: "ad_script",
      priority: PRIORITY.single,
      targetType: "project",
      targetId: projectId,
      templateName: adScriptV1.name,
      templateVersion: adScriptV1.version,
      provider: run.provider,
      model: run.model,
      parameters: run.parameters,
      input: {
        brief,
        language: project.language,
        look: style.definition?.photoreal
          ? "photorealistic live action"
          : (style.presetName ?? style.customDescription) || "illustrated",
      },
    }),
  );
  await deps.jobs.kick();
  return c.json({ job }, 202);
});
