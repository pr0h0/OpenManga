import { and, assets, chapters, eq, narrationLines, pages, panels } from "@openmanga/db";
import {
  cropsToFrame,
  frameSizeFor,
  pickShorts,
  runtimeBudget,
  SHORTS_DEFAULT_MS,
  SHORTS_LIMIT_MS,
  SHORTS_MIN_MS,
  shortsLengthWarning,
  shortsScore,
  type TimingShot,
  timeGroup,
  timingFixes,
  timingIssues,
  timingSettings,
  type VideoAspect,
} from "@openmanga/domain";
import { computeCrop, softProof } from "@openmanga/image-utils";
import { NarrationLineVideo, type ProjectSettings, ShotVideo } from "@openmanga/schemas";
import {
  type BrandedProject,
  loadRenderPage,
  narrationSegmentsFor,
  panelAspect,
  planVideoShots,
  recordAudit,
  renderPageImage,
  renderProjectVideoCard,
} from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { badRequest, body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { readImageUpload } from "../lib/uploads.ts";

export const videoRoutes = new Hono<AppEnv>();

const VideoAspectParam = z.enum(["16:9", "9:16", "1:1"]).optional();

const PreviewQuery = z.object({
  cut: z.enum(["page", "panel"]).default("panel"),
  chapterId: z.string().uuid().optional(),
  pageId: z.string().uuid().optional(),
  panelId: z.string().uuid().optional(),
  /** A Shorts pick: comma-separated panel ids, played in story order without the intro and outro cards. */
  panelIds: z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").filter(Boolean) : undefined))
    .pipe(z.array(z.string().uuid()).max(100).optional()),
  language: z.string().trim().min(2).max(16).optional(),
  aspect: VideoAspectParam,
});

doc({
  method: "GET",
  path: "/api/video-preview",
  summary:
    "Shot list for the in-browser video preview (same shots and narration as the final render): per shot the page, panel crop/focus/zoom inputs and narration segments with audio. Scope: exactly one of chapterId, pageId, panelId, panelIds (a Shorts pick). aspect: 16:9 (default), 9:16 or 1:1.",
  tag: "exports",
});
videoRoutes.get("/video-preview", async (c) => {
  const q = query(c, PreviewQuery);
  const scopes = [q.chapterId, q.pageId, q.panelId, q.panelIds?.length].filter(Boolean).length;
  if (scopes !== 1) throw badRequest("Provide exactly one of chapterId, pageId, panelId, panelIds");
  // A pick is checked against the first panel's project; the planner ignores panels of any other project.
  const project = q.panelId
    ? await entityAccess(c, "panel", q.panelId, "read")
    : q.panelIds?.length
      ? await entityAccess(c, "panel", q.panelIds[0]!, "read")
      : q.pageId
        ? await entityAccess(c, "page", q.pageId, "read")
        : await entityAccess(c, "chapter", q.chapterId!, "read");
  const cut = q.panelId || q.panelIds ? "panel" : q.cut;
  return c.json(
    await previewPayload(c.get("deps").db, project, q, cut, q.language || project.language, { aspect: q.aspect }),
  );
});

const TimingQuery = z.object({
  /** The export's minimum hold to time against (default: the target runtime's shortest shot, else 2.5 s). */
  minHoldMs: z.coerce.number().int().min(500).max(30_000).optional(),
  language: z.string().trim().min(2).max(16).optional(),
});

/** Each chapter's share of the project's target runtime in ms, or an empty map without one. */
async function targetShares(db: AppEnv["Variables"]["deps"]["db"], project: { id: string; settings: ProjectSettings }) {
  const t = project.settings.targetRuntime;
  if (!t) return new Map<string, number>();
  const chs = await db
    .select({ id: chapters.id, source: chapters.sourceExcerpt, summary: chapters.summary })
    .from(chapters)
    .where(eq(chapters.projectId, project.id));
  const budget = runtimeBudget(
    t,
    chs.map((c) => ({ id: c.id, sourceChars: (c.source || c.summary).length })),
    project.settings.format,
  );
  return new Map(budget.chapters.map((c) => [c.id, Math.round((c.words / t.wordsPerMinute) * 60_000)]));
}

/**
 * A chapter's timing pass (panel cut): the shared timeline of its voiced narration, what is off and what could fix
 * it. Lines without audio yet count as silent, and `audio` says how much is voiced.
 */
export async function chapterTiming(
  db: AppEnv["Variables"]["deps"]["db"],
  project: Parameters<typeof previewPayload>[1] & { settings: ProjectSettings; language: string },
  chapterId: string,
  q: z.infer<typeof TimingQuery>,
  targetMs: number | null,
) {
  const payload = await previewPayload(db, project, { chapterId }, "panel", q.language || project.language);
  const shots: TimingShot[] = payload.shots.map((s) => ({
    key: s.key,
    label: s.label,
    panelId: s.panel?.id ?? null,
    sceneId: s.sceneId,
    joinNext: s.joinNext,
    minHoldMs: s.minHoldMs,
    lines: s.lines.map((l) => ({
      id: l.id,
      text: l.text,
      startOffsetMs: l.startOffsetMs,
      endOffsetMs: l.endOffsetMs,
      segments: l.segments.flatMap((x) => (x.durationMs ? [{ ms: x.durationMs, pauseAfterMs: x.pauseAfterMs }] : [])),
    })),
  }));
  const settings = timingSettings(project.settings.targetRuntime, q.minHoldMs);
  const { film, issues } = timingIssues(shots, settings);
  const segments = payload.shots.flatMap((s) => s.lines.flatMap((l) => l.segments));
  return {
    chapterId,
    settings,
    audio: { segments: segments.length, voiced: segments.filter((x) => x.durationMs).length },
    totalMs: Math.round(film.totalMs),
    targetMs,
    shots: shots.map((s, i) => ({
      key: s.key,
      label: s.label,
      panelId: s.panelId,
      joinNext: s.joinNext,
      minHoldMs: s.minHoldMs,
      startMs: Math.round(film.shots[i]!.startMs),
      holdMs: Math.round(film.shots[i]!.holdMs),
      narrationMs: s.lines.reduce((n, l) => n + l.segments.reduce((m, x) => m + x.ms, 0), 0),
      lines: s.lines.map((l) => ({ id: l.id, text: l.text, words: l.text.split(/\s+/).filter(Boolean).length })),
    })),
    issues,
    fixes: timingFixes(shots, settings, targetMs),
  };
}

doc({
  method: "GET",
  path: "/api/chapters/:id/timing",
  summary:
    "Timing pass for a chapter (panel cut), from its real narration audio: each shot's hold, what is off (shots past the longest-shot setting or under the shortest, a single picture held too long, dead air), the chapter's length against its share of the target runtime, and the fixes on offer with their effect: spread a long line over the next shots of its scene, set a shot's own hold, or rewrite lines to a word budget.",
  tag: "narration",
  query: TimingQuery,
});
videoRoutes.get("/chapters/:id/timing", async (c) => {
  const chapterId = uuidParam(c, "id");
  const project = await entityAccess(c, "chapter", chapterId, "read");
  const q = query(c, TimingQuery);
  const db = c.get("deps").db;
  return c.json(
    await chapterTiming(db, project, chapterId, q, (await targetShares(db, project)).get(chapterId) ?? null),
  );
});

const ApplyTiming = z.union([
  z.object({ spread: z.object({ lineId: z.string().uuid(), untilPanelId: z.string().uuid().nullable() }) }),
  z.object({
    hold: z.object({ panelId: z.string().uuid(), holdMs: z.number().int().min(500).max(60_000).nullable() }),
  }),
]);
doc({
  method: "POST",
  path: "/api/chapters/:id/timing/apply",
  summary:
    "Apply a timing fix in a chapter: `spread` stretches a narration line over the shots up to untilPanelId (null undoes it), keeping its offsets; `hold` sets a panel's own minimum hold as a video shot (null back to the export's). Existing art only; nothing is generated.",
  tag: "narration",
  body: ApplyTiming,
});
videoRoutes.post("/chapters/:id/timing/apply", async (c) => {
  const chapterId = uuidParam(c, "id");
  const p = await entityAccess(c, "chapter", chapterId, "write");
  const input = await body(c, ApplyTiming);
  const { db } = c.get("deps");
  const panelIn = async (id: string) =>
    (
      await db
        .select({ panel: panels })
        .from(panels)
        .innerJoin(pages, eq(pages.id, panels.pageId))
        .where(and(eq(panels.id, id), eq(pages.chapterId, chapterId)))
    )[0]?.panel;
  if ("spread" in input) {
    const [line] = await db
      .select()
      .from(narrationLines)
      .where(and(eq(narrationLines.id, input.spread.lineId), eq(narrationLines.chapterId, chapterId)));
    if (!line) throw notFound("Narration line");
    if (input.spread.untilPanelId && !(await panelIn(input.spread.untilPanelId))) throw notFound("Panel");
    const video = { ...NarrationLineVideo.parse(line.video ?? {}), untilPanelId: input.spread.untilPanelId };
    await db.update(narrationLines).set({ video }).where(eq(narrationLines.id, line.id));
  } else {
    const panel = await panelIn(input.hold.panelId);
    if (!panel) throw notFound("Panel");
    if (panel.approvalStatus === "locked") throw conflict("Panel is locked");
    const video = { ...ShotVideo.parse(panel.video ?? {}), holdMs: input.hold.holdMs };
    await db.update(panels).set({ video }).where(eq(panels.id, panel.id));
  }
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: "chapter.timing_apply",
    targetType: "chapter",
    targetId: chapterId,
    metadata: input,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/timing",
  summary:
    "Timing pass for every chapter of a project: its length against its target share, how much of its narration is voiced, and how many shots are off by kind.",
  tag: "narration",
  query: TimingQuery,
});
videoRoutes.get("/projects/:projectId/timing", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, TimingQuery);
  const db = c.get("deps").db;
  const shares = await targetShares(db, p);
  const chs = await db
    .select({ id: chapters.id, order: chapters.order, title: chapters.title })
    .from(chapters)
    .where(eq(chapters.projectId, p.id))
    .orderBy(chapters.order);
  const out = [];
  for (const ch of chs) {
    const t = await chapterTiming(db, p, ch.id, q, shares.get(ch.id) ?? null).catch(() => null);
    const count = (kind: string) => t?.issues.filter((i) => i.kind === kind).length ?? 0;
    out.push({
      ...ch,
      shots: t?.shots.length ?? 0,
      audio: t?.audio ?? { segments: 0, voiced: 0 },
      totalMs: t?.totalMs ?? 0,
      targetMs: shares.get(ch.id) ?? null,
      issues: { long: count("long"), flash: count("flash"), still: count("still"), silence: count("silence") },
    });
  }
  return c.json({ chapters: out });
});

const ShortsQuery = z.object({
  chapterId: z.string().uuid().optional(),
  language: z.string().trim().min(2).max(16).optional(),
  minHoldMs: z.coerce.number().int().min(500).max(30_000).default(1500),
  /** The cut's length: the pick fills up to it (default 180 s, YouTube's Shorts limit; up to 600 s). */
  lengthSeconds: z.coerce
    .number()
    .int()
    .min(SHORTS_MIN_MS / 1000)
    .max(SHORTS_LIMIT_MS / 1000)
    .default(SHORTS_DEFAULT_MS / 1000),
});
doc({
  method: "GET",
  path: "/api/projects/:projectId/shorts",
  summary:
    "Candidate shots for a Shorts cut of a chapter (or the whole project): every panel in story order with its hold (its own narration, at least minHoldMs), its narration text, a drama score, and `picked` for the automatic choice, which fills up to `lengthSeconds` (default 180, at most 600). `warning` is set when the length or the pick goes over YouTube's 3-minute Shorts limit. Render the pick with POST exports { kind: video_shorts, panelIds, video: { shortsSeconds } }.",
  tag: "exports",
});
videoRoutes.get("/projects/:projectId/shorts", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, ShortsQuery);
  if (q.chapterId) {
    const owner = await entityAccess(c, "chapter", q.chapterId, "read");
    if (owner.id !== p.id) throw notFound("Chapter");
  }
  const candidates = await shortsCandidates(
    c.get("deps").db,
    p,
    { chapterId: q.chapterId ?? null },
    q.language || p.language,
    q.minHoldMs,
  );
  const maxMs = q.lengthSeconds * 1000;
  const picked = new Set(pickShorts(candidates, { targetMs: maxMs, minMs: SHORTS_MIN_MS, maxMs }));
  const pickedMs = candidates.filter((x) => picked.has(x.id)).reduce((n, x) => n + x.holdMs, 0);
  return c.json({
    minMs: SHORTS_MIN_MS,
    maxMs,
    pickedMs,
    // The pick never runs past the length, so its total is the film's length.
    warning: shortsLengthWarning(pickedMs),
    shots: candidates.map((x) => ({ ...x, score: shortsScore(x), picked: picked.has(x.id) })),
  });
});

/**
 * Every panel of a scope as a Shorts candidate, in story order: its hold (its own narration through `timeGroup`, at
 * least `minHoldMs`, as the render times it), narration text and whether it has artwork.
 */
export async function shortsCandidates(
  db: AppEnv["Variables"]["deps"]["db"],
  project: Parameters<typeof planVideoShots>[1],
  scope: Parameters<typeof planVideoShots>[2],
  language: string,
  minHoldMs: number,
) {
  let planned: Awaited<ReturnType<typeof planVideoShots>>;
  try {
    planned = await planVideoShots(db, project, scope, "panel", language);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const byLine = await narrationSegmentsFor(
    db,
    planned.shots.flatMap((s) => s.lineIds),
  );
  const lineById = new Map(planned.lines.map((l) => [l.id, l]));
  return planned.shots.map((s) => {
    const lines = s.lineIds.map((id) => ({
      startOffsetMs: lineById.get(id)?.video?.startOffsetMs ?? 0,
      endOffsetMs: lineById.get(id)?.video?.endOffsetMs ?? 0,
      segments: (byLine.get(id) ?? []).flatMap(({ s: seg, a }) =>
        a?.durationMs ? [{ ms: a.durationMs, pauseAfterMs: seg.pauseAfterMs, text: seg.text }] : [],
      ),
    }));
    return {
      id: s.panel!.id,
      label: s.label,
      shotType: s.panel!.shotType,
      artAssetId: s.art?.id ?? null,
      hasArt: Boolean(s.art),
      text: lines.flatMap((l) => l.segments.map((x) => x.text)).join(" "),
      holdMs: timeGroup(lines, 1, { minHoldMs, fps: 30 }).holdMs,
    };
  });
}

doc({
  method: "GET",
  path: "/api/pages/:id/render.png",
  summary:
    "The lettered page as a PNG (deterministic composition), for previews. ?width= up to 1600 (default 1200). ?proof=cmyk soft-proofs it through a generic CMYK press profile and back (colours a press cannot print shift as they will on paper); ?proof=grey as a black-ink interior prints it. ?cutout=1 leaves what lies outside a decorative page edge transparent, as videos draw it.",
  tag: "pages",
});
videoRoutes.get("/pages/:id/render.png", async (c) => {
  const id = uuidParam(c, "id");
  const project = await entityAccess(c, "page", id, "read");
  const { width, proof, cutout } = query(
    c,
    z.object({
      width: z.coerce.number().int().min(200).max(1600).default(1200),
      proof: z.enum(["cmyk", "grey"]).optional(),
      cutout: z.enum(["1"]).optional(),
    }),
  );
  const { db, assets: assetSvc } = c.get("deps");
  const [page] = await db.select({ width: pages.width }).from(pages).where(eq(pages.id, id));
  if (!page) throw notFound("Page");
  const render = await loadRenderPage(db, assetSvc.storage, id, project.readingDirection);
  const img = await renderPageImage(render, "png", { scale: Math.min(1, width / page.width), cutout: cutout === "1" });
  return new Response(proof ? await softProof(img.data, proof) : img.data, {
    headers: { "content-type": "image/png", "cache-control": "private, max-age=30" },
  });
});

export const CardQuery = z.object({
  height: z.coerce.number().int().min(180).max(1440).default(1080),
  aspect: VideoAspectParam,
});

/** A project's intro or outro card PNG, the pixels the render encodes; 404 when that card is off. */
export async function videoCardResponse(
  deps: AppEnv["Variables"]["deps"],
  project: BrandedProject,
  which: string,
  q: z.infer<typeof CardQuery>,
  cacheControl: string,
) {
  if (which !== "intro" && which !== "outro") throw notFound("Card");
  const { frameW, frameH } = frameSizeFor(q.height, q.aspect);
  const png = await renderProjectVideoCard(deps.db, deps.assets, project, which, frameW, frameH);
  if (!png) throw notFound("Card");
  return new Response(png, { headers: { "content-type": "image/png", "cache-control": cacheControl } });
}

doc({
  method: "GET",
  path: "/api/projects/:projectId/video-card/:which.png",
  summary:
    "The project's intro or outro video card (`which`: intro|outro) as the render draws it, at ?height= (the short side) and ?aspect= (16:9, 9:16, 1:1). 404 when the card is off.",
  tag: "exports",
});
videoRoutes.get("/projects/:projectId/video-card/:file", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, CardQuery);
  return videoCardResponse(c.get("deps"), p, c.req.param("file").replace(/\.png$/, ""), q, "private, max-age=30");
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/video-logo",
  summary:
    "Upload a logo for the video watermark (multipart: file; PNG with transparency works best). Returns the asset; set it as settings.video.watermark.assetId with PATCH /api/projects/:projectId.",
  tag: "exports",
});
videoRoutes.post("/projects/:projectId/video-logo", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const up = await readImageUpload(c);
  const deps = c.get("deps");
  const asset = await deps.assets.store({
    projectId: p.id,
    ownerUserId: user(c).id,
    type: "source_image",
    data: up.data,
    mimeType: up.mime,
    width: up.width,
    height: up.height,
    metadata: { role: "video_logo", originalName: up.originalName },
  });
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "project.video_logo",
    targetType: "asset",
    targetId: asset.id,
    metadata: { bytes: up.data.byteLength },
    requestId: c.get("requestId"),
  });
  return c.json({ asset: { id: asset.id, width: asset.width, height: asset.height } }, 201);
});

/** What the preview needs to draw the project's branding: the cards' lengths and the logo's placement inputs. */
async function brandingPayload(
  db: AppEnv["Variables"]["deps"]["db"],
  projectId: string,
  settings: ProjectSettings | undefined,
  noCards = false,
) {
  const v = settings?.video;
  const wm = v?.watermark;
  const [logo] = wm ? await db.select().from(assets).where(eq(assets.id, wm.assetId)) : [];
  return {
    intro: noCards ? null : (v?.intro ?? null),
    outro: noCards ? null : (v?.outro ?? null),
    watermark:
      wm && logo?.width && logo.height && !logo.deletedAt && logo.projectId === projectId
        ? { ...wm, width: logo.width, height: logo.height }
        : null,
  };
}

/**
 * The preview's shot list: the same shots, crops, focus points, moves, fades, spans and narration as the final
 * render, plus the project's branding. Shared by the signed-in preview and a reader link's (which passes its own,
 * already checked, scope).
 */
export async function previewPayload(
  db: AppEnv["Variables"]["deps"]["db"],
  project: Parameters<typeof planVideoShots>[1] & { settings?: ProjectSettings; updatedAt?: Date | string },
  scope: Parameters<typeof planVideoShots>[2],
  cut: "page" | "panel",
  language: string,
  o: { aspect?: VideoAspect } = {},
) {
  const { frameW, frameH } = frameSizeFor(1080, o.aspect);
  const cropAspect = cropsToFrame(o.aspect ?? "16:9") ? frameW / frameH : undefined;
  let planned: Awaited<ReturnType<typeof planVideoShots>>;
  try {
    planned = await planVideoShots(db, project, scope, cut, language, { cropAspect });
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const byLine = await narrationSegmentsFor(
    db,
    planned.shots.flatMap((s) => s.lineIds),
  );
  const lineById = new Map(planned.lines.map((l) => [l.id, l]));
  return {
    cut,
    language,
    aspect: o.aspect ?? "16:9",
    branding: {
      ...(await brandingPayload(db, project.id, project.settings, Boolean(scope.panelIds?.length))),
      version: String(project.updatedAt ?? ""),
    },
    unplacedLines: planned.unplacedLines,
    disabledPanels: planned.disabledPanels,
    shots: planned.shots.map((s) => {
      const pn = s.panel;
      const art = s.art;
      // Vertical and square frames crop panel art to their own shape, like the render.
      const fill = Boolean(cropAspect && art?.width && art.height);
      const aspect = pn ? (fill ? cropAspect! : panelAspect(pn, s.page)) : null;
      return {
        key: s.key,
        label: s.label,
        joinNext: s.joinNext,
        minHoldMs: s.panel?.video?.holdMs ?? null,
        sceneId: s.panel?.sceneId ?? s.page.sceneId,
        fade: s.fade,
        motion: s.motion,
        page: {
          id: s.page.id,
          order: s.page.order,
          chapterOrder: s.page.chapterOrder,
          width: s.page.width,
          height: s.page.height,
          updatedAt: s.page.updatedAt,
        },
        panel:
          pn && aspect
            ? {
                id: pn.id,
                shotType: pn.shotType,
                frame: pn.frame,
                aspect,
                fill,
                focus: s.focus,
                art:
                  art?.width && art.height
                    ? {
                        assetId: art.id,
                        width: art.width,
                        height: art.height,
                        crop: computeCrop(art.width, art.height, aspect, pn.imageTransform),
                      }
                    : null,
              }
            : null,
        lines: s.lineIds.map((id) => {
          const v = lineById.get(id)?.video;
          return {
            id,
            text: lineById.get(id)?.text ?? "",
            startOffsetMs: v?.startOffsetMs ?? 0,
            endOffsetMs: v?.endOffsetMs ?? 0,
            segments: (byLine.get(id) ?? []).map(({ s: seg, a }) => ({
              id: seg.id,
              text: seg.text,
              pauseAfterMs: seg.pauseAfterMs,
              audioAssetId: a?.assetId ?? null,
              durationMs: a?.durationMs ?? null,
            })),
          };
        }),
      };
    }),
  };
}
