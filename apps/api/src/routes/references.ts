import {
  and,
  assets,
  assetVariants,
  desc,
  eq,
  inArray,
  isNull,
  REFERENCE_KINDS,
  type ReferenceKind,
  referenceAssets,
} from "@openmanga/db";
import { canTransition } from "@openmanga/domain";
import { isStale, recordAudit, versionFingerprint, versionFingerprints } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { AiChoiceInput, assertBudget, checkImageChoice } from "../lib/ai.ts";
import { badRequest, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { readImageUpload } from "../lib/uploads.ts";

export type Subject = "character" | "location" | "prop" | "style";

const assetTypeFor = {
  character: "character_reference",
  location: "location_reference",
  prop: "prop_reference",
  style: "style_reference",
} as const;
const versionColumn = {
  character: referenceAssets.characterVersionId,
  location: referenceAssets.locationVersionId,
  prop: referenceAssets.propVersionId,
  style: referenceAssets.projectStyleId,
} as const;

export async function listReferences(c: Context<AppEnv>, subject: Subject, versionIds: string[]) {
  if (!versionIds.length) return [];
  const { db } = c.get("deps");
  const rows = await db
    .select({ ref: referenceAssets, asset: assets })
    .from(referenceAssets)
    .innerJoin(assets, eq(assets.id, referenceAssets.assetId))
    .where(and(inArray(versionColumn[subject], versionIds), isNull(assets.deletedAt)))
    .orderBy(desc(referenceAssets.createdAt));
  const fingerprints = await versionFingerprints(db, subject, versionIds);
  const variants = rows.length
    ? await db
        .select()
        .from(assetVariants)
        .where(
          and(
            inArray(
              assetVariants.assetId,
              rows.map((r) => r.asset.id),
            ),
            eq(assetVariants.variant, "prompt_ref"),
          ),
        )
    : [];
  return rows.map((r) => ({
    ...r.ref,
    /** Made from an older description of this version: regenerate so the image matches the words. */
    stale: isStale(
      r.ref,
      fingerprints.get(String(r.ref.characterVersionId ?? r.ref.locationVersionId ?? r.ref.propVersionId)),
    ),
    asset: {
      id: r.asset.id,
      width: r.asset.width,
      height: r.asset.height,
      mimeType: r.asset.mimeType,
      byteSize: r.asset.byteSize,
      sha256: r.asset.sha256,
      createdAt: r.asset.createdAt,
      generationJobId: r.asset.generationJobId,
      metadata: r.asset.metadata,
    },
    promptDerivatives: variants
      .filter((v) => v.assetId === r.asset.id)
      .map((v) => ({
        id: v.id,
        width: v.width,
        height: v.height,
        byteSize: v.byteSize,
        mimeType: v.mimeType,
        params: v.params,
      })),
  }));
}

export const GenerateRef = z.object({
  kind: z.enum(REFERENCE_KINDS).exclude(["uploaded"]).default("full_body"),
  extraInstruction: z.string().max(2000).optional(),
  outfitId: z.string().uuid().optional(),
  ai: AiChoiceInput,
});

/** Registers generate/upload endpoints for a subject's version path, e.g. /character-versions/:id/references. */
export function mountReferenceEndpoints(
  app: Hono<AppEnv>,
  subject: Subject,
  versionPath: string,
  access: (
    c: Context<AppEnv>,
    id: string,
    action: "read" | "write" | "generate",
  ) => Promise<{ projectId: string; status?: string }>,
) {
  doc({
    method: "POST",
    path: `/api/${versionPath}/:id/references/generate`,
    summary: `Generate a full-resolution ${subject} reference (GPT Image, low quality)`,
    tag: "references",
    body: GenerateRef,
  });
  app.post(`/${versionPath}/:id/references/generate`, async (c) => {
    const id = uuidParam(c, "id");
    const v = await access(c, id, "generate");
    if (v.status === "superseded") throw conflict("This version is superseded. Create or select a current version.");
    const input = await body(c, GenerateRef);
    const deps = c.get("deps");
    await assertBudget(c, v.projectId);
    await checkImageChoice(c, input.ai);
    const job = await deps.planner.enqueueReference(subject, id, input.kind as ReferenceKind, user(c).id, {
      extraInstruction: input.extraInstruction,
      outfitId: input.outfitId,
      ai: input.ai,
    });
    await deps.jobs.kick();
    return c.json({ job }, 202);
  });

  doc({
    method: "POST",
    path: `/api/${versionPath}/:id/references/upload`,
    summary: `Upload your own ${subject} reference (multipart: file, kind)`,
    tag: "references",
  });
  app.post(`/${versionPath}/:id/references/upload`, async (c) => {
    const id = uuidParam(c, "id");
    const v = await access(c, id, "write");
    if (v.status === "superseded") throw conflict("This version is superseded.");
    const up = await readImageUpload(c);
    const kind = String(up.form.get("kind") ?? "uploaded") as ReferenceKind;
    const deps = c.get("deps");
    const u = user(c);
    const asset = await deps.assets.store({
      projectId: v.projectId,
      ownerUserId: u.id,
      type: assetTypeFor[subject],
      data: up.data,
      mimeType: up.mime,
      width: up.width,
      height: up.height,
      metadata: { uploaded: true, originalName: up.originalName },
    });
    const [existingPrimary] = await deps.db
      .select({ id: referenceAssets.id })
      .from(referenceAssets)
      .where(and(eq(versionColumn[subject], id), eq(referenceAssets.isPrimary, true)));
    const [ref] = await deps.db
      .insert(referenceAssets)
      .values({
        projectId: v.projectId,
        subjectType: subject,
        characterVersionId: subject === "character" ? id : null,
        locationVersionId: subject === "location" ? id : null,
        propVersionId: subject === "prop" ? id : null,
        projectStyleId: subject === "style" ? id : null,
        kind: REFERENCE_KINDS.find((k) => k === kind) ?? "uploaded",
        assetId: asset.id,
        isPrimary: !existingPrimary,
        sourceFingerprint: await versionFingerprint(deps.db, subject, id),
      })
      .returning();
    await deps.assets.ensureThumbnail(asset);
    await recordAudit(deps.db, {
      userId: u.id,
      projectId: v.projectId,
      action: "reference.upload",
      targetType: "reference_asset",
      targetId: ref!.id,
      requestId: c.get("requestId"),
    });
    return c.json({ reference: ref, asset: { id: asset.id, width: asset.width, height: asset.height } }, 201);
  });
}

export const referenceRoutes = new Hono<AppEnv>();

async function refWithAccess(c: Context<AppEnv>, id: string) {
  const [ref] = await c.get("deps").db.select().from(referenceAssets).where(eq(referenceAssets.id, id));
  if (!ref) throw notFound("Reference");
  await projectAccess(c, ref.projectId, "write");
  return ref;
}

const RefStatus = z.object({ status: z.enum(["draft", "approved", "locked", "superseded"]) });
doc({
  method: "POST",
  path: "/api/references/:id/status",
  summary: "Approve / lock / unapprove a reference. Approval creates the small prompt derivative.",
  tag: "references",
  body: RefStatus,
});
referenceRoutes.post("/references/:id/status", async (c) => {
  const ref = await refWithAccess(c, uuidParam(c, "id"));
  const { status } = await body(c, RefStatus);
  if (!canTransition(ref.status, status)) throw conflict(`Cannot change a ${ref.status} reference to ${status}`);
  const deps = c.get("deps");
  const [row] = await deps.db.update(referenceAssets).set({ status }).where(eq(referenceAssets.id, ref.id)).returning();
  await deps.db.update(assets).set({ status }).where(eq(assets.id, ref.assetId));
  let derivative = null;
  if (status === "approved" || status === "locked") {
    const asset = await deps.assets.get(ref.assetId);
    const project = await projectAccess(c, ref.projectId, "write");
    if (asset) {
      const v = await deps.assets.ensurePromptReference(
        asset,
        deps.assets.referenceParams({
          maxWidth: project.settings.referenceMaxWidth,
          maxHeight: project.settings.referenceMaxHeight,
        }),
      );
      derivative = { id: v.id, width: v.width, height: v.height, byteSize: v.byteSize, params: v.params };
    }
  }
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: ref.projectId,
    action: `reference.${status}`,
    targetType: "reference_asset",
    targetId: ref.id,
    requestId: c.get("requestId"),
  });
  return c.json({ reference: row, derivative });
});

doc({
  method: "POST",
  path: "/api/references/:id/primary",
  summary: "Make this the primary reference for its version",
  tag: "references",
});
referenceRoutes.post("/references/:id/primary", async (c) => {
  const ref = await refWithAccess(c, uuidParam(c, "id"));
  const deps = c.get("deps");
  const col = ref.characterVersionId
    ? referenceAssets.characterVersionId
    : ref.locationVersionId
      ? referenceAssets.locationVersionId
      : ref.propVersionId
        ? referenceAssets.propVersionId
        : referenceAssets.projectStyleId;
  const vid = ref.characterVersionId ?? ref.locationVersionId ?? ref.propVersionId ?? ref.projectStyleId;
  if (!vid) throw badRequest("Reference has no subject");
  await deps.db.transaction(async (tx) => {
    await tx.update(referenceAssets).set({ isPrimary: false }).where(eq(col, vid));
    await tx.update(referenceAssets).set({ isPrimary: true }).where(eq(referenceAssets.id, ref.id));
  });
  return c.json({ ok: true });
});

doc({ method: "DELETE", path: "/api/references/:id", summary: "Move a reference image to trash", tag: "references" });
referenceRoutes.delete("/references/:id", async (c) => {
  const ref = await refWithAccess(c, uuidParam(c, "id"));
  if (ref.status === "locked") throw conflict("Locked references cannot be deleted");
  const deps = c.get("deps");
  await deps.db.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, ref.assetId));
  await deps.db
    .update(referenceAssets)
    .set({ status: "superseded", isPrimary: false })
    .where(eq(referenceAssets.id, ref.id));
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: ref.projectId,
    action: "reference.trash",
    targetType: "reference_asset",
    targetId: ref.id,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

export { entityAccess };
