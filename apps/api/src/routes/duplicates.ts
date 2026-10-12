import { and, desc, eq, generationJobs } from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/** Near-duplicate finder: a scan without AI, and its newest report. */
export const duplicateRoutes = new Hono<AppEnv>();

doc({
  method: "POST",
  path: "/api/projects/:projectId/duplicates/scan",
  summary:
    "Scan the project for near-duplicates (a duplicate_scan job, no AI, no cost): near-identical panels, the same figure staging in panels that are not neighbours, the same background across different scenes, and near-identical cover or thumbnail art. Read the report from GET duplicates.",
  tag: "panels",
});
duplicateRoutes.post("/projects/:projectId/duplicates/scan", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const deps = c.get("deps");
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(tx, {
      projectId: p.id,
      userId: user(c).id,
      kind: "duplicate_scan",
      priority: PRIORITY.single,
      targetType: "project",
      targetId: p.id,
      input: {},
    }),
  );
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/duplicates",
  summary:
    "The newest near-duplicate scan: its status and, once done, groups by kind (identical, pose, background, thumbnail) with a score and their members (panel, page, chapter; or the cover asset).",
  tag: "panels",
});
duplicateRoutes.get("/projects/:projectId/duplicates", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const [job] = await c
    .get("deps")
    .db.select({
      id: generationJobs.id,
      status: generationJobs.status,
      result: generationJobs.result,
      failureReason: generationJobs.failureReason,
      createdAt: generationJobs.createdAt,
    })
    .from(generationJobs)
    .where(and(eq(generationJobs.projectId, p.id), eq(generationJobs.kind, "duplicate_scan")))
    .orderBy(desc(generationJobs.createdAt))
    .limit(1);
  return c.json({ scan: job ?? null });
});
