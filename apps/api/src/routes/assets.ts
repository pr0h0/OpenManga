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
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { ApiError, conflict, notFound, query, requireUser, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { seesSharedReference } from "../lib/series.ts";

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
        // Cached video sections are the renderer's working files, not something to browse.
        sql`not (${assets.metadata} ? 'renderSection')`,
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

/** Whether series episodes (other projects) use this asset as a reference image. */
async function usedByOtherProjects(db: AppEnv["Variables"]["deps"]["db"], a: { id: string; projectId: string | null }) {
  const [shared] = await db
    .select({ id: referenceAssets.id })
    .from(referenceAssets)
    .where(and(eq(referenceAssets.assetId, a.id), sql`${referenceAssets.projectId} <> ${a.projectId}`))
    .limit(1);
  return Boolean(shared);
}
const SHARED = "Episodes of a series use this image as a reference, so it stays";

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
  if (await usedByOtherProjects(db, a)) throw conflict(SHARED);
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
  if (await usedByOtherProjects(deps.db, a)) throw conflict(SHARED);
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
 * /cdn/a/:id[?v=thumbnail|prompt_ref|preview][&download=name][&trash=1]
 * The API authorizes, then hands the file to nginx via X-Accel-Redirect (internal location), or redirects to a signed
 * bucket URL with S3 storage. Without nginx (dev/tests) local bytes are streamed directly.
 */
export const cdnRoutes = new Hono<AppEnv>();
const VARIANTS = new Set(["thumbnail", "prompt_ref", "preview", "web"]);

cdnRoutes.get("/a/:id", async (c) => {
  const id = uuidParam(c, "id");
  const deps = c.get("deps");
  const [a] = await deps.db.select().from(assets).where(eq(assets.id, id));
  if (!a) throw notFound("Asset");
  // Trashed images are shown only where the trash is being looked at (?trash=1), so a deleted image does not
  // live on in the generation history or anywhere else that still holds its id.
  if (a.deletedAt && c.req.query("trash") !== "1") throw notFound("Asset");
  if (a.visibility !== "public") {
    const me = c.get("user");
    if (!me) throw new ApiError(401, "unauthenticated", "Please sign in");
    // An image with no project (one attached to or drawn in an expert chat) is its owner's alone. A project's file
    // is the project's, whoever made it: someone who has left the project no longer sees it.
    if (!a.projectId) {
      if (a.ownerUserId !== me.id) throw notFound("Asset");
    } else {
      // A series library's reference image is shown in its episodes: anyone in a project that uses it may see it.
      await projectAccess(c, a.projectId, "read").catch(async (e) => {
        if (!(await seesSharedReference(deps.db, me.id, a.id))) throw e;
      });
    }
  }
  return sendAsset(c, a);
});

/**
 * Send an asset the caller may see (the access check is the caller's): `?v=` picks a display variant, `?download=`
 * names the file. From a bucket (STORAGE_DRIVER=s3) the answer is a redirect to a signed URL; from local disk behind
 * nginx the bytes go out through X-Accel-Redirect; otherwise they are streamed from here.
 */
export async function sendAsset(
  c: Context<AppEnv>,
  a: typeof assets.$inferSelect,
  opts: { cacheControl?: string; variants?: boolean } = {},
) {
  const deps = c.get("deps");
  const v = opts.variants === false ? undefined : c.req.query("v");
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
    "cache-control":
      opts.cacheControl ??
      (a.visibility === "public" ? "public, max-age=31536000, immutable" : "private, max-age=3600"),
    etag: `"${etagSource.slice(0, 32)}${v ? `-${v}` : ""}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'",
  };
  if (download)
    headers["content-disposition"] = `attachment; filename="${download.replace(/[^\w.\- ]/g, "_").slice(0, 120)}"`;
  if (c.req.header("if-none-match") === headers.etag) return c.body(null, 304, headers);
  const storage = deps.assets.storage;
  if (storage.presign) {
    // `?proxy=1` is for the app's own fetch() reads (the video preview's audio): through the API they stay
    // same-origin, so the bucket needs no CORS rule.
    if (c.req.query("proxy") === "1") return c.body(storage.stream(storageKey), 200, headers);
    // A bucket: the browser fetches the bytes from a short-lived signed URL that carries the type and file name.
    // The redirect itself may be cached, but never past the URL's own expiry.
    const expiresIn = deps.config.S3_PRESIGN_EXPIRES_SECONDS;
    const maxAge = Math.min(Number(/max-age=(\d+)/.exec(headers["cache-control"]!)?.[1] ?? 0), expiresIn - 60);
    const url = storage.presign(storageKey, {
      expiresIn,
      contentType: mime,
      contentDisposition: headers["content-disposition"],
    });
    const scope = headers["cache-control"]!.startsWith("public") ? "public" : "private";
    return c.body(null, 302, { location: url, "cache-control": `${scope}, max-age=${Math.max(0, maxAge)}` });
  }
  if (c.req.header("x-accel-enabled") === "1" && storage.internalPath) {
    return c.body(null, 200, {
      ...headers,
      "x-accel-redirect": `/_protected_assets/${storage.internalPath(storageKey)}`,
    });
  }
  const data = await deps.assets.storage.read(storageKey);
  return c.body(data.slice().buffer as ArrayBuffer, 200, { ...headers, "content-length": String(data.byteLength) });
}
