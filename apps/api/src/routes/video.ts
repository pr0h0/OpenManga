import { assets, eq, pages } from "@openmanga/db";
import {
  cropsToFrame,
  frameSizeFor,
  pickShorts,
  SHORTS_MAX_MS,
  SHORTS_MIN_MS,
  SHORTS_TARGET_MS,
  shortsScore,
  timeGroup,
  type VideoAspect,
} from "@openmanga/domain";
import { computeCrop } from "@openmanga/image-utils";
import type { ProjectSettings } from "@openmanga/schemas";
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
import { badRequest, notFound, query, user, uuidParam } from "../lib/http.ts";
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

const ShortsQuery = z.object({
  chapterId: z.string().uuid().optional(),
  language: z.string().trim().min(2).max(16).optional(),
  minHoldMs: z.coerce.number().int().min(500).max(30_000).default(1500),
  targetSeconds: z.coerce
    .number()
    .int()
    .min(15)
    .max(60)
    .default(SHORTS_TARGET_MS / 1000),
});
doc({
  method: "GET",
  path: "/api/projects/:projectId/shorts",
  summary:
    "Candidate shots for a Shorts cut of a chapter (or the whole project): every panel in story order with its hold (its own narration, at least minHoldMs), its narration text, a drama score, and `picked` for the automatic 30–60 s choice. Render the pick with POST exports { kind: video_shorts, panelIds }.",
  tag: "exports",
});
videoRoutes.get("/projects/:projectId/shorts", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, ShortsQuery);
  if (q.chapterId) {
    const owner = await entityAccess(c, "chapter", q.chapterId, "read");
    if (owner.id !== p.id) throw notFound("Chapter");
  }
  const { db } = c.get("deps");
  let planned: Awaited<ReturnType<typeof planVideoShots>>;
  try {
    planned = await planVideoShots(db, p, { chapterId: q.chapterId ?? null }, "panel", q.language || p.language);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  const byLine = await narrationSegmentsFor(
    db,
    planned.shots.flatMap((s) => s.lineIds),
  );
  const lineById = new Map(planned.lines.map((l) => [l.id, l]));
  const candidates = planned.shots.map((s) => {
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
      holdMs: timeGroup(lines, 1, { minHoldMs: q.minHoldMs, fps: 30 }).holdMs,
    };
  });
  const picked = new Set(
    pickShorts(candidates, { targetMs: q.targetSeconds * 1000, minMs: SHORTS_MIN_MS, maxMs: SHORTS_MAX_MS }),
  );
  return c.json({
    minMs: SHORTS_MIN_MS,
    maxMs: SHORTS_MAX_MS,
    shots: candidates.map((x) => ({ ...x, score: shortsScore(x), picked: picked.has(x.id) })),
  });
});

doc({
  method: "GET",
  path: "/api/pages/:id/render.png",
  summary: "The lettered page as a PNG (deterministic composition), for previews. ?width= up to 1600 (default 1200).",
  tag: "pages",
});
videoRoutes.get("/pages/:id/render.png", async (c) => {
  const id = uuidParam(c, "id");
  const project = await entityAccess(c, "page", id, "read");
  const { width } = query(c, z.object({ width: z.coerce.number().int().min(200).max(1600).default(1200) }));
  const { db, assets: assetSvc } = c.get("deps");
  const [page] = await db.select({ width: pages.width }).from(pages).where(eq(pages.id, id));
  if (!page) throw notFound("Page");
  const render = await loadRenderPage(db, assetSvc.storage, id, project.readingDirection);
  const img = await renderPageImage(render, "png", { scale: Math.min(1, width / page.width) });
  return new Response(img.data, {
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
