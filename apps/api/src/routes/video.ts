import { assets, eq, pages } from "@openmanga/db";
import { frameSizeFor } from "@openmanga/domain";
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

const PreviewQuery = z.object({
  cut: z.enum(["page", "panel"]).default("panel"),
  chapterId: z.string().uuid().optional(),
  pageId: z.string().uuid().optional(),
  panelId: z.string().uuid().optional(),
  language: z.string().trim().min(2).max(16).optional(),
});

doc({
  method: "GET",
  path: "/api/video-preview",
  summary:
    "Shot list for the in-browser video preview (same shots and narration as the final render): per shot the page, panel crop/focus/zoom inputs and narration segments with audio. Scope: exactly one of chapterId, pageId, panelId.",
  tag: "exports",
});
videoRoutes.get("/video-preview", async (c) => {
  const q = query(c, PreviewQuery);
  const scopes = [q.chapterId, q.pageId, q.panelId].filter(Boolean).length;
  if (scopes !== 1) throw badRequest("Provide exactly one of chapterId, pageId, panelId");
  const project = q.panelId
    ? await entityAccess(c, "panel", q.panelId, "read")
    : q.pageId
      ? await entityAccess(c, "page", q.pageId, "read")
      : await entityAccess(c, "chapter", q.chapterId!, "read");
  const cut = q.panelId ? "panel" : q.cut;
  return c.json(await previewPayload(c.get("deps").db, project, q, cut, q.language || project.language));
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

const CardQuery = z.object({ height: z.coerce.number().int().min(180).max(1440).default(1080) });

/** A project's intro or outro card PNG, the pixels the render encodes; 404 when that card is off. */
export async function videoCardResponse(
  deps: AppEnv["Variables"]["deps"],
  project: BrandedProject,
  which: string,
  height: number,
  cacheControl: string,
) {
  if (which !== "intro" && which !== "outro") throw notFound("Card");
  const { frameW, frameH } = frameSizeFor(height);
  const png = await renderProjectVideoCard(deps.db, deps.assets, project, which, frameW, frameH);
  if (!png) throw notFound("Card");
  return new Response(png, { headers: { "content-type": "image/png", "cache-control": cacheControl } });
}

doc({
  method: "GET",
  path: "/api/projects/:projectId/video-card/:which.png",
  summary:
    "The project's intro or outro video card (`which`: intro|outro) as the render draws it, at ?height= (16:9). 404 when the card is off.",
  tag: "exports",
});
videoRoutes.get("/projects/:projectId/video-card/:file", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { height } = query(c, CardQuery);
  return videoCardResponse(c.get("deps"), p, c.req.param("file").replace(/\.png$/, ""), height, "private, max-age=30");
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
) {
  const v = settings?.video;
  const wm = v?.watermark;
  const [logo] = wm ? await db.select().from(assets).where(eq(assets.id, wm.assetId)) : [];
  return {
    intro: v?.intro ?? null,
    outro: v?.outro ?? null,
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
) {
  let planned: Awaited<ReturnType<typeof planVideoShots>>;
  try {
    planned = await planVideoShots(db, project, scope, cut, language);
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
    branding: {
      ...(await brandingPayload(db, project.id, project.settings)),
      version: String(project.updatedAt ?? ""),
    },
    unplacedLines: planned.unplacedLines,
    disabledPanels: planned.disabledPanels,
    shots: planned.shots.map((s) => {
      const pn = s.panel;
      const art = s.art;
      const aspect = pn ? panelAspect(pn, s.page) : null;
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
