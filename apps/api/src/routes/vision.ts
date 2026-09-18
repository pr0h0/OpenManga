import { and, assets, desc, eq, generationJobs, inArray, projectMembers, projects, sql } from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { imageDescribeV1 } from "@openmanga/prompts";
import { ImageAspect } from "@openmanga/schemas";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import {
  AiChoiceInput,
  assertBatchable,
  assertBudget,
  BatchInput,
  batchParameters,
  queueTextBatchSubmit,
  textRun,
} from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { readImageUpload } from "../lib/uploads.ts";

export const visionRoutes = new Hono<AppEnv>();

const DescribeInput = z.object({
  /** Which aspects to report on. Empty means the overview only. */
  aspects: z.array(ImageAspect).max(12).default([]),
  /** The caller's own question about the image, answered in `custom`. */
  custom: z.string().trim().max(2000).default(""),
  /** What the image is, e.g. "frame from a trailer" — context, not an instruction. */
  note: z.string().trim().max(500).default(""),
  batch: BatchInput,
  ai: AiChoiceInput,
});

/**
 * Everything that can refuse the request, before anything is written. An upload that is going to be rejected for
 * want of a key must not leave a stored image behind.
 */
async function checkDescribe(
  c: Parameters<typeof projectAccess>[0],
  projectId: string,
  input: z.infer<typeof DescribeInput>,
) {
  await assertBudget(c, projectId);
  const run = await textRun(c, input.ai);
  assertBatchable(c, input.batch, run.provider);
  return run;
}

/** Queues the description job for an image that is already an asset of this project. */
async function queueDescribe(
  c: Parameters<typeof projectAccess>[0],
  opts: {
    projectId: string;
    assetId: string;
    input: z.infer<typeof DescribeInput>;
    run: Awaited<ReturnType<typeof textRun>>;
  },
) {
  const deps = c.get("deps");
  const { input, run } = opts;
  const batchId = input.batch ? crypto.randomUUID() : null;
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(
      tx,
      {
        projectId: opts.projectId,
        userId: user(c).id,
        kind: "image_describe",
        priority: PRIORITY.single,
        targetType: "asset",
        targetId: opts.assetId,
        batchId,
        templateName: imageDescribeV1.name,
        templateVersion: imageDescribeV1.version,
        provider: run.provider,
        model: run.model,
        parameters: { ...run.parameters, ...batchParameters(input.batch) },
        input: { assetId: opts.assetId, aspects: input.aspects, custom: input.custom, note: input.note },
      },
      { enqueue: !input.batch },
    ),
  );
  if (batchId) await queueTextBatchSubmit(c, { projectId: opts.projectId, batchId, ai: input.ai });
  await deps.jobs.kick();
  return job;
}

doc({
  method: "POST",
  path: "/api/projects/:projectId/images/describe",
  summary:
    "Upload a reference image and describe it (multipart: file, plus the JSON fields of the describe body as form values). Returns the stored asset and a queued image_describe job; read the result from /api/generations/:id",
  tag: "vision",
  body: DescribeInput,
});
visionRoutes.post("/projects/:projectId/images/describe", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  const up = await readImageUpload(c);
  // The rest of the body rides along as form fields, since the image makes this multipart.
  const raw = {
    aspects: JSON.parse(String(up.form.get("aspects") ?? "[]")) as unknown,
    custom: String(up.form.get("custom") ?? ""),
    note: String(up.form.get("note") ?? ""),
    batch: String(up.form.get("batch") ?? "") === "true",
    ai: up.form.get("ai") ? (JSON.parse(String(up.form.get("ai"))) as unknown) : null,
  };
  const parsed = DescribeInput.safeParse(raw);
  if (!parsed.success) throw badRequest(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));

  const deps = c.get("deps");
  // Refuse before storing: a missing key or an exhausted budget must not leave an orphan image behind.
  const run = await checkDescribe(c, p.id, parsed.data);
  const asset = await deps.assets.store({
    projectId: p.id,
    ownerUserId: user(c).id,
    type: "source_image",
    data: up.data,
    mimeType: up.mime,
    width: up.width,
    height: up.height,
    metadata: { uploaded: true, originalName: up.originalName, describedFor: parsed.data.aspects },
  });
  await deps.assets.ensureThumbnail(asset).catch(() => {});
  const job = await queueDescribe(c, { projectId: p.id, assetId: asset.id, input: parsed.data, run });
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "image.describe",
    targetType: "asset",
    targetId: asset.id,
    metadata: { aspects: parsed.data.aspects, custom: Boolean(parsed.data.custom) },
    requestId: c.get("requestId"),
  });
  return c.json({ asset, job }, 202);
});

doc({
  method: "POST",
  path: "/api/assets/:id/describe",
  summary: "Describe an image already in this project (a panel, a reference, or one uploaded earlier)",
  tag: "vision",
  body: DescribeInput,
});
visionRoutes.post("/assets/:id/describe", async (c) => {
  const assetId = uuidParam(c, "id");
  const deps = c.get("deps");
  const [asset] = await deps.db.select().from(assets).where(eq(assets.id, assetId));
  if (!asset) throw notFound("Asset");
  // An asset can exist outside a project (an avatar, say); describing one bills a project, so it needs one.
  if (!asset.projectId) throw badRequest("That image does not belong to a project");
  await projectAccess(c, asset.projectId, "generate");
  if (!asset.mimeType.startsWith("image/")) throw badRequest("That asset is not an image");
  const input = await body(c, DescribeInput);
  const run = await checkDescribe(c, asset.projectId, input);
  const job = await queueDescribe(c, { projectId: asset.projectId, assetId, input, run });
  return c.json({ job }, 202);
});

const HistoryQuery = z.object({
  /** "project" limits to one project; "all" (the default) spans every project the caller is a member of. */
  scope: z.enum(["project", "all"]).default("all"),
  projectId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z
    .string()
    .regex(/^[^|]+\|[0-9a-f-]{36}$/)
    .optional(),
});

doc({
  method: "GET",
  path: "/api/image-descriptions",
  summary:
    "Past image descriptions with their image, inputs and result. Spans every project you are a member of by default (?scope=project&projectId= limits it), so a style read from one reference can be applied in another project without paying to describe it again",
  tag: "vision",
  query: HistoryQuery,
});
visionRoutes.get("/image-descriptions", async (c) => {
  const u = user(c);
  const deps = c.get("deps");
  const q = query(c, HistoryQuery);
  const memberOf = deps.db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, u.id));
  if (q.scope === "project") {
    if (!q.projectId) throw badRequest("scope=project needs a projectId");
    await projectAccess(c, q.projectId, "read");
  }
  const [at, id] = q.cursor?.split("|") ?? [];
  const rows = await deps.db
    .select({
      id: generationJobs.id,
      projectId: generationJobs.projectId,
      projectTitle: projects.title,
      status: generationJobs.status,
      createdAt: generationJobs.createdAt,
      input: generationJobs.input,
      result: generationJobs.result,
      failureReason: generationJobs.failureReason,
      model: generationJobs.model,
    })
    .from(generationJobs)
    .innerJoin(projects, eq(projects.id, generationJobs.projectId))
    .where(
      and(
        eq(generationJobs.kind, "image_describe"),
        eq(generationJobs.userId, u.id),
        q.scope === "project"
          ? eq(generationJobs.projectId, q.projectId!)
          : inArray(generationJobs.projectId, memberOf),
        at && id ? sql`(${generationJobs.createdAt}, ${generationJobs.id}) < (${at}, ${id}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(generationJobs.createdAt), desc(generationJobs.id))
    .limit(q.limit);
  const last = rows.at(-1);
  return c.json({
    descriptions: rows.map((r) => ({
      ...r,
      assetId: (r.input as { assetId?: string }).assetId ?? null,
      aspects: (r.input as { aspects?: string[] }).aspects ?? [],
      custom: (r.input as { custom?: string }).custom ?? "",
      note: (r.input as { note?: string }).note ?? "",
      description: (r.result as { description?: unknown } | null)?.description ?? null,
      input: undefined,
      result: undefined,
    })),
    nextCursor: rows.length === q.limit && last ? `${last.createdAt.toISOString()}|${last.id}` : null,
  });
});

doc({
  method: "DELETE",
  path: "/api/image-descriptions/:id",
  summary: "Remove a description from the library, with the image it was read from",
  tag: "vision",
});
visionRoutes.delete("/image-descriptions/:id", async (c) => {
  const id = uuidParam(c, "id");
  const deps = c.get("deps");
  const [job] = await deps.db.select().from(generationJobs).where(eq(generationJobs.id, id));
  if (job?.kind !== "image_describe") throw notFound("Description");
  await projectAccess(c, job.projectId, "write");
  if (job.userId && job.userId !== user(c).id) throw notFound("Description");
  // Mid-flight is the only state worth refusing: the handler is holding this row. A job that has not started
  // (or is parked in a provider batch) is cancelled first, so binning a stuck item is possible.
  if (job.status === "processing") throw conflict("That description is running; wait for it to finish or cancel it");
  if (job.status === "queued" || job.status === "submitted") await deps.jobs.cancelGeneration(job.id);

  const assetId = (job.input as { assetId?: string }).assetId;
  await deps.db.delete(generationJobs).where(eq(generationJobs.id, id));
  // The uploaded image goes with it, unless something else adopted it in the meantime — a reference on a version,
  // a panel's artwork, or another description still pointing at it.
  if (assetId) {
    const [asset] = await deps.db.select().from(assets).where(eq(assets.id, assetId));
    const [stillUsed] = asset
      ? await deps.db.execute<{ n: number }>(sql`select (
          (select count(*) from reference_assets where asset_id = ${assetId})
          + (select count(*) from panels where active_artwork_asset_id = ${assetId})
          + (select count(*) from generation_jobs where kind = 'image_describe' and input->>'assetId' = ${assetId})
        )::int as n`)
      : [];
    if (asset && asset.type === "source_image" && (stillUsed?.n ?? 0) === 0)
      await deps.assets.hardDelete(asset).catch(() => {});
  }
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: job.projectId,
    action: "image.describe.delete",
    targetType: "asset",
    targetId: assetId,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});
