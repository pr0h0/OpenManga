import { assets, eq } from "@openmanga/db";
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
import { badRequest, body, notFound, user, uuidParam } from "../lib/http.ts";
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

/** Queues the description job for an image that is already an asset of this project. */
async function queueDescribe(
  c: Parameters<typeof projectAccess>[0],
  opts: {
    projectId: string;
    assetId: string;
    input: z.infer<typeof DescribeInput>;
  },
) {
  const deps = c.get("deps");
  const { input } = opts;
  await assertBudget(c, opts.projectId);
  const run = await textRun(c, input.ai);
  assertBatchable(c, input.batch, run.provider);
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
  const job = await queueDescribe(c, { projectId: p.id, assetId: asset.id, input: parsed.data });
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
  const job = await queueDescribe(c, { projectId: asset.projectId, assetId, input });
  return c.json({ job }, 202);
});
