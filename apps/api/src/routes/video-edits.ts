import { and, eq, generationJobs } from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { videoEditV1 } from "@openmanga/prompts";
import { VideoEditOp } from "@openmanga/schemas";
import { applyVideoEdits, recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { AiChoiceInput, assertBudget, textRun } from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * "Edit the video in words": an instruction ("make chapter 4 faster", "cut every silence over 900 ms", "add a title
 * card before chapter 8") becomes a list of timeline edits on a text job; the user applies all, some or changed ones.
 */
export const videoEditRoutes = new Hono<AppEnv>();

const Propose = z.object({ instruction: z.string().trim().min(3).max(2000), ai: AiChoiceInput });
doc({
  method: "POST",
  path: "/api/projects/:projectId/video-edits",
  summary:
    "Queue a text job that turns an instruction about the video into timeline edits (pauses, shot holds, a shot's motion, fade or whether it plays, intro/outro/chapter title cards, scene-break fades). Nothing changes yet: the job's result lists each edit with what it would change, to apply with /api/projects/:projectId/video-edits/:jobId/apply.",
  tag: "exports",
  body: Propose,
});
videoEditRoutes.post("/projects/:projectId/video-edits", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  const { instruction, ai } = await body(c, Propose);
  const deps = c.get("deps");
  await assertBudget(c, p.id);
  const run = await textRun(c, ai);
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(tx, {
      projectId: p.id,
      userId: user(c).id,
      kind: "video_edit",
      priority: PRIORITY.single,
      targetType: "project",
      targetId: p.id,
      templateName: videoEditV1.name,
      templateVersion: videoEditV1.version,
      provider: run.provider,
      model: run.model,
      parameters: run.parameters,
      input: { instruction },
    }),
  );
  await deps.jobs.kick();
  return c.json({ job }, 202);
});

const Apply = z.object({
  /** The edits to apply: the proposal's, ticked and possibly changed. Left out, every edit it proposed. */
  ops: z.array(VideoEditOp).max(60).optional(),
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/video-edits/:jobId/apply",
  summary:
    "Apply a finished video-edit proposal: all of its edits, or the given ops (a subset, or changed). Each is worked out again against the project as it is now and all are written together; returns what each changed.",
  tag: "exports",
  body: Apply,
});
videoEditRoutes.post("/projects/:projectId/video-edits/:jobId/apply", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const deps = c.get("deps");
  const [job] = await deps.db
    .select()
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.id, uuidParam(c, "jobId")),
        eq(generationJobs.kind, "video_edit"),
        eq(generationJobs.projectId, p.id),
      ),
    );
  if (!job) throw notFound("Video edit");
  if (job.status !== "completed") throw conflict("The proposal has not finished yet");
  const input = await body(c, Apply);
  const proposed = ((job.result?.edits ?? []) as { op: VideoEditOp }[]).map((e) => e.op);
  const ops = input.ops ?? proposed;
  if (!ops.length) throw badRequest("No edits to apply");
  let applied: Awaited<ReturnType<typeof applyVideoEdits>>;
  try {
    applied = await applyVideoEdits(deps.db, p, ops);
  } catch (e) {
    throw badRequest((e as Error).message);
  }
  await deps.db
    .update(generationJobs)
    .set({ result: { ...job.result, applied, appliedAt: new Date().toISOString() } })
    .where(eq(generationJobs.id, job.id));
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "video.edit_apply",
    targetType: "project",
    targetId: p.id,
    metadata: { jobId: job.id, edits: applied.length, changed: input.ops !== undefined },
    requestId: c.get("requestId"),
  });
  return c.json({ applied });
});
