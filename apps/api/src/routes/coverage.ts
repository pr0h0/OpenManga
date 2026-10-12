import { and, desc, eq, generationJobs, generationOutputs, pages, panelSpecs, panels, sql } from "@openmanga/db";
import { defaultTemplateForCount } from "@openmanga/domain";
import { cropRegion, gridCell } from "@openmanga/image-utils";
import { COVERAGE_CELLS } from "@openmanga/prompts";
import type { StoredPanelSpec } from "@openmanga/schemas";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess } from "../lib/access.ts";
import { AiChoiceInput, assertBudget, checkImageChoice } from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { layoutFrames } from "../lib/layouts.ts";
import { doc } from "../lib/openapi.ts";

/**
 * Coverage sheets: one image of a panel's moment from nine camera setups (wide, full, medium, close, extreme close,
 * over the shoulder, insert, low, high). Picked cells become panels: each crop is the panel's strict layout guide and
 * its setup the panel's shot type and angle, so the panel is then drawn at full size in that framing.
 */
export const coverageRoutes = new Hono<AppEnv>();

doc({
  method: "POST",
  path: "/api/panels/:id/coverage",
  summary:
    "Draw a coverage sheet for the panel: one image (an image-generation job) of its moment from nine camera setups in a 3x3 grid, with the panel's references. Nothing on the panel changes; pick cells with POST /api/coverage-sheets/:jobId/use.",
  tag: "panels",
  body: z.object({ ai: AiChoiceInput }),
});
coverageRoutes.post("/panels/:id/coverage", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "panel", id, "generate");
  const { ai } = await body(c, z.object({ ai: AiChoiceInput }));
  await assertBudget(c, p.id);
  await checkImageChoice(c, ai);
  const deps = c.get("deps");
  const job = await deps.planner.enqueueCoverage(id, user(c).id, { ai });
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

doc({
  method: "GET",
  path: "/api/panels/:id/coverage",
  summary:
    "The panel's coverage sheets, newest first: each job's status and, once done, the sheet's asset; `cells` names the nine setups in grid order.",
  tag: "panels",
});
coverageRoutes.get("/panels/:id/coverage", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "panel", id, "read");
  const rows = await c
    .get("deps")
    .db.select({
      jobId: generationJobs.id,
      status: generationJobs.status,
      failureReason: generationJobs.failureReason,
      createdAt: generationJobs.createdAt,
      assetId: sql<string | null>`(${generationJobs.result} ->> 'assetId')`,
    })
    .from(generationJobs)
    .where(and(eq(generationJobs.kind, "coverage_sheet"), eq(generationJobs.targetId, id)))
    .orderBy(desc(generationJobs.createdAt))
    .limit(10);
  return c.json({ sheets: rows, cells: COVERAGE_CELLS.map((x) => x.label) });
});

const UseInput = z.object({
  /** Cells by number, 1-9 in reading order. */
  cells: z.array(z.number().int().min(1).max(9)).min(1).max(9),
  /** this: the one cell reframes the panel itself; new: each cell becomes a new panel after it. */
  mode: z.enum(["this", "new"]).default("new"),
});
doc({
  method: "POST",
  path: "/api/coverage-sheets/:jobId/use",
  summary:
    "Turn picked cells of a coverage sheet into panels. mode=this (one cell): the panel takes the cell as a strict layout guide and its setup's shot type and angle. mode=new: the picks become new panels with the panel's cast, place, props and spec, each with its cell as guide and its setup's framing, on a new page right after (a comic page holds up to 5; film and strips get one page per pick). Nothing is drawn.",
  tag: "panels",
  body: UseInput,
});
coverageRoutes.post("/coverage-sheets/:jobId/use", async (c) => {
  const deps = c.get("deps");
  const [job] = await deps.db
    .select()
    .from(generationJobs)
    .where(eq(generationJobs.id, uuidParam(c, "jobId")));
  if (job?.kind !== "coverage_sheet" || !job.targetId) throw notFound("Coverage sheet");
  const project = await entityAccess(c, "panel", job.targetId, "write");
  const assetId = (job.result as { assetId?: string } | null)?.assetId;
  if (job.status !== "completed" || !assetId) throw conflict(`This coverage sheet is ${job.status}`);
  const input = await body(c, UseInput);
  const cells = [...new Set(input.cells)];
  if (input.mode === "this" && cells.length !== 1) throw badRequest("Pick one cell to reframe this panel");
  const paged = project.settings.format !== "film" && project.settings.format !== "vertical";
  if (input.mode === "new" && paged && cells.length > 5)
    throw badRequest("A page holds at most 5 panels: pick 5 or fewer");
  const [src] = await deps.db.select().from(panels).where(eq(panels.id, job.targetId));
  if (!src) throw notFound("Panel");
  if (input.mode === "this" && src.approvalStatus === "locked") throw conflict("Panel is locked");
  const sheet = await deps.assets.get(assetId);
  if (!sheet || sheet.deletedAt || !sheet.width || !sheet.height) throw notFound("Coverage sheet image");
  const data = await deps.assets.read(sheet);
  const [latest] = await deps.db
    .select()
    .from(panelSpecs)
    .where(eq(panelSpecs.panelId, src.id))
    .orderBy(desc(panelSpecs.versionNumber))
    .limit(1);
  const base: StoredPanelSpec | null = latest?.spec ?? null;

  // Each pick's crop, stored as a project image, and the framing it gives.
  const picks: { cell: number; guideAssetId: string; shotType: string; cameraAngle: string }[] = [];
  for (const n of cells) {
    const crop = await cropRegion(data, gridCell(sheet.width!, sheet.height!, n - 1));
    const a = await deps.assets.store({
      projectId: project.id,
      ownerUserId: user(c).id,
      type: "source_image",
      data: crop.data,
      mimeType: crop.mime,
      width: crop.width,
      height: crop.height,
      parentAssetId: sheet.id,
      metadata: { role: "panel_guide", coverageSheetJobId: job.id, cell: n },
    });
    const setup = COVERAGE_CELLS[n - 1]!;
    picks.push({ cell: n, guideAssetId: a.id, shotType: setup.shotType, cameraAngle: setup.cameraAngle });
  }
  const specFor = (p: (typeof picks)[number]): StoredPanelSpec =>
    ({
      ...(base ?? { beat: src.storyBeat || "New panel", characters: [], continuityRequirements: [], propIds: [] }),
      shotType: p.shotType,
      cameraAngle: p.cameraAngle,
      dialogueIds: [],
      narrationIds: [],
      sfxIds: [],
    }) as StoredPanelSpec;

  const result = await deps.db.transaction(async (tx) => {
    const nextVersion = async (panelId: string) =>
      ((
        await tx
          .select({ n: sql<number>`coalesce(max(${panelSpecs.versionNumber}),0)::int` })
          .from(panelSpecs)
          .where(eq(panelSpecs.panelId, panelId))
      )[0]?.n ?? 0) + 1;
    if (input.mode === "this") {
      const p = picks[0]!;
      await tx
        .insert(panelSpecs)
        .values({ panelId: src.id, versionNumber: await nextVersion(src.id), spec: specFor(p), source: "user" });
      await tx
        .update(panels)
        .set({
          shotType: p.shotType,
          cameraAngle: p.cameraAngle,
          promptDraft: null,
          guide: { assetId: p.guideAssetId, strength: "strict", pose: src.guide?.pose ?? "" },
        })
        .where(eq(panels.id, src.id));
      return { panelIds: [src.id], pageIds: [src.pageId] };
    }
    // New panels on new pages right after the source panel's page.
    const [srcPage] = await tx.select().from(pages).where(eq(pages.id, src.pageId));
    const groups = paged ? [picks] : picks.map((p) => [p]);
    const panelIds: string[] = [];
    const pageIds: string[] = [];
    let order = srcPage!.order;
    for (const group of groups) {
      const key = paged ? defaultTemplateForCount(group.length).key : "full-page";
      const frames = layoutFrames(key, project, user(c), srcPage!.readingDirection ?? project.readingDirection)!;
      order++;
      await tx
        .update(pages)
        .set({ order: sql`${pages.order} + 1` })
        .where(and(eq(pages.chapterId, srcPage!.chapterId), sql`${pages.order} >= ${order}`));
      const [pg] = await tx
        .insert(pages)
        .values({
          projectId: project.id,
          chapterId: srcPage!.chapterId,
          sceneId: srcPage!.sceneId,
          order,
          layoutTemplate: key,
          width: srcPage!.width,
          height: srcPage!.height,
          readingDirection: srcPage!.readingDirection,
        })
        .returning();
      pageIds.push(pg!.id);
      for (const [i, p] of group.entries()) {
        const [pn] = await tx
          .insert(panels)
          .values({
            projectId: project.id,
            pageId: pg!.id,
            sceneId: src.sceneId,
            order: i + 1,
            frame: frames[i]!,
            shotType: p.shotType,
            cameraAngle: p.cameraAngle,
            storyBeat: src.storyBeat,
            locationVersionId: src.locationVersionId,
            characterVersionIds: src.characterVersionIds,
            propVersionIds: src.propVersionIds,
            guide: { assetId: p.guideAssetId, strength: "strict", pose: "" },
          })
          .returning();
        await tx.insert(panelSpecs).values({ panelId: pn!.id, versionNumber: 1, spec: specFor(p), source: "user" });
        panelIds.push(pn!.id);
      }
    }
    return { panelIds, pageIds };
  });
  await deps.db.update(generationOutputs).set({ activated: true }).where(eq(generationOutputs.jobId, job.id));
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: project.id,
    action: "coverage.use",
    targetType: "panel",
    targetId: src.id,
    metadata: { jobId: job.id, cells, mode: input.mode, panels: result.panelIds.length },
    requestId: c.get("requestId"),
  });
  return c.json({ ...result, picks: picks.map((p) => ({ cell: p.cell, label: COVERAGE_CELLS[p.cell - 1]!.label })) });
});
