import {
  and,
  assets,
  assetVariants,
  desc,
  eq,
  isNotNull,
  isNull,
  panels,
  projects,
  referenceAssets,
  sql,
} from "@openmanga/db";
import { recordAudit } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { ApiError, conflict, notFound, query, requireUser, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

export const assetRoutes = new Hono<AppEnv>();

const ListQuery = z.object({
  type: z.string().optional(),
  trash: z.enum(["0", "1"]).default("0"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});
doc({
  method: "GET",
  path: "/api/projects/:projectId/assets",
  summary: "Asset library",
  tag: "assets",
  query: ListQuery,
});
assetRoutes.get("/projects/:projectId/assets", requireUser, async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, ListQuery);
  const { db } = c.get("deps");
  const rows = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.projectId, p.id),
        q.type ? eq(assets.type, q.type as "panel_art") : sql`${assets.type} not in ('prompt_reference','thumbnail')`,
        q.trash === "1" ? isNotNull(assets.deletedAt) : isNull(assets.deletedAt),
      ),
    )
    .orderBy(desc(assets.createdAt))
    .limit(q.limit);
  const [usage] = await db.execute<{
    bytes: number;
    variant_bytes: number;
  }>(sql`select coalesce(sum(byte_size),0)::float as bytes,
    (select coalesce(sum(v.byte_size),0)::float from asset_variants v join assets a on a.id = v.asset_id where a.project_id = ${p.id}) as variant_bytes
    from assets where project_id = ${p.id}`);
  return c.json({ assets: rows.map((a) => ({ ...a, storageKey: undefined })), storage: usage });
});

doc({ method: "GET", path: "/api/assets/:id", summary: "Asset metadata, variants and lineage", tag: "assets" });
assetRoutes.get("/assets/:id", requireUser, async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [a] = await db.select().from(assets).where(eq(assets.id, id));
  if (!a?.projectId) throw notFound("Asset");
  await projectAccess(c, a.projectId, "read");
  const variants = await db.select().from(assetVariants).where(eq(assetVariants.assetId, id));
  const lineage: { id: string; parentAssetId: string | null; generationJobId: string | null; createdAt: Date }[] = [];
  let cur: typeof a | undefined = a;
  for (let i = 0; cur?.parentAssetId && i < 50; i++) {
    const [parent] = await db.select().from(assets).where(eq(assets.id, cur.parentAssetId));
    if (!parent) break;
    lineage.push({
      id: parent.id,
      parentAssetId: parent.parentAssetId,
      generationJobId: parent.generationJobId,
      createdAt: parent.createdAt,
    });
    cur = parent;
  }
  const children = await db
    .select({ id: assets.id, createdAt: assets.createdAt })
    .from(assets)
    .where(eq(assets.parentAssetId, id));
  return c.json({
    asset: { ...a, storageKey: undefined },
    variants: variants.map((v) => ({ ...v, storageKey: undefined })),
    lineage,
    children,
  });
});

doc({ method: "POST", path: "/api/assets/:id/trash", summary: "Move asset to trash", tag: "assets" });
assetRoutes.post("/assets/:id/trash", requireUser, async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [a] = await db.select().from(assets).where(eq(assets.id, id));
  if (!a?.projectId) throw notFound("Asset");
  await projectAccess(c, a.projectId, "write");
  if (a.status === "locked") throw conflict("Locked assets cannot be trashed");
  const [active] = await db.select({ id: panels.id }).from(panels).where(eq(panels.activeArtworkAssetId, id)).limit(1);
  if (active) throw conflict("This artwork is active on a panel. Activate another version first.");
  await db.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, id));
  await recordAudit(db, {
    userId: user(c).id,
    projectId: a.projectId,
    action: "asset.trash",
    targetId: id,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

doc({ method: "POST", path: "/api/assets/:id/restore", summary: "Restore asset from trash", tag: "assets" });
assetRoutes.post("/assets/:id/restore", requireUser, async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [a] = await db.select().from(assets).where(eq(assets.id, id));
  if (!a?.projectId) throw notFound("Asset");
  await projectAccess(c, a.projectId, "write");
  await db.update(assets).set({ deletedAt: null }).where(eq(assets.id, id));
  return c.json({ ok: true });
});

doc({ method: "DELETE", path: "/api/assets/:id", summary: "Permanently delete a trashed asset", tag: "assets" });
assetRoutes.delete("/assets/:id", requireUser, async (c) => {
  const id = uuidParam(c, "id");
  const deps = c.get("deps");
  const [a] = await deps.db.select().from(assets).where(eq(assets.id, id));
  if (!a?.projectId) throw notFound("Asset");
  await projectAccess(c, a.projectId, "delete");
  if (!a.deletedAt) throw conflict("Move the asset to trash first");
  const [ref] = await deps.db
    .select({ id: referenceAssets.id })
    .from(referenceAssets)
    .where(and(eq(referenceAssets.assetId, id), eq(referenceAssets.status, "locked")))
    .limit(1);
  if (ref) throw conflict("Asset is a locked reference");
  await deps.db.update(panels).set({ activeArtworkAssetId: null }).where(eq(panels.activeArtworkAssetId, id));
  await deps.db.update(projects).set({ coverAssetId: null }).where(eq(projects.coverAssetId, id));
  await deps.assets.hardDelete(a);
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: a.projectId,
    action: "asset.delete",
    targetId: id,
    metadata: { sha256: a.sha256, type: a.type },
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- CDN

/**
 * /cdn/a/:id[?v=thumbnail|prompt_ref|preview][&download=name]
 * The API authorizes, then hands the file to nginx via X-Accel-Redirect (internal location).
 * Without nginx (dev/tests) the bytes are streamed directly.
 */
export const cdnRoutes = new Hono<AppEnv>();
const VARIANTS = new Set(["thumbnail", "prompt_ref", "preview", "web"]);

cdnRoutes.get("/a/:id", async (c) => {
  const id = uuidParam(c, "id");
  const deps = c.get("deps");
  const [a] = await deps.db.select().from(assets).where(eq(assets.id, id));
  if (!a) throw notFound("Asset");
  if (a.visibility !== "public") {
    const me = c.get("user");
    if (!me) throw new ApiError(401, "unauthenticated", "Please sign in");
    // An image with no project (one attached to or drawn in an expert chat) is its owner's alone.
    if (!a.projectId) {
      if (a.ownerUserId !== me.id) throw notFound("Asset");
    } else if (a.ownerUserId !== me.id) await projectAccess(c, a.projectId, "read");
  }
  const v = c.req.query("v");
  let storageKey = a.storageKey;
  let mime = a.mimeType;
  // The ETag has to identify the bytes actually served: a variant's own hash, not the canonical asset's, or a
  // cached derivative survives a change to the derivative parameters.
  let etagSource = a.sha256;
  if (v && VARIANTS.has(v)) {
    let variant = await deps.assets.variantFor(a.id, v as "thumbnail");
    if (!variant && (v === "thumbnail" || v === "preview" || v === "web"))
      variant = await deps.assets.ensureResized(a, v);
    if (variant) {
      storageKey = variant.storageKey;
      mime = variant.mimeType;
      etagSource = variant.sha256;
    }
  }
  const download = c.req.query("download");
  const headers: Record<string, string> = {
    "content-type": mime,
    "cache-control": a.visibility === "public" ? "public, max-age=31536000, immutable" : "private, max-age=3600",
    etag: `"${etagSource.slice(0, 32)}${v ? `-${v}` : ""}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
  };
  if (download)
    headers["content-disposition"] = `attachment; filename="${download.replace(/[^\w.\- ]/g, "_").slice(0, 120)}"`;
  if (c.req.header("if-none-match") === headers.etag) return c.body(null, 304, headers);
  if (c.req.header("x-accel-enabled") === "1") {
    return c.body(null, 200, {
      ...headers,
      "x-accel-redirect": `/_protected_assets/${deps.assets.storage.internalPath(storageKey)}`,
    });
  }
  const data = await deps.assets.storage.read(storageKey);
  return c.body(data.slice().buffer as ArrayBuffer, 200, { ...headers, "content-length": String(data.byteLength) });
});
