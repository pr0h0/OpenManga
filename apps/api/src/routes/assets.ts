import {
  and,
  asc,
  assetFeatures,
  assetMarks,
  assets,
  assetVariants,
  desc,
  eq,
  generationJobs,
  inArray,
  isNotNull,
  isNull,
  panels,
  projects,
  referenceAssets,
  sql,
} from "@openmanga/db";
import { correlation, hashDistance, histogramOverlap, imageFeatures } from "@openmanga/image-utils";
import { recordAudit } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { ApiError, badRequest, body, conflict, notFound, query, requireUser, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { seesSharedReference } from "../lib/series.ts";

export const assetRoutes = new Hono<AppEnv>();

const ListQuery = z.object({
  type: z.string().optional(),
  trash: z.enum(["0", "1"]).default("0"),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  /** Name (an upload's or export's file name), type or tag. */
  q: z.string().trim().max(200).optional(),
  tag: z.string().trim().max(60).optional(),
  collection: z.string().trim().max(60).optional(),
  favourite: z.enum(["1"]).optional(),
  /** Images of this character, place or prop: its reference images and the panels it is drawn in. */
  characterId: z.string().uuid().optional(),
  locationId: z.string().uuid().optional(),
  propId: z.string().uuid().optional(),
  /** generated (by a job), uploaded (from a file), derived (an edit or tool result of another asset). */
  source: z.enum(["generated", "uploaded", "derived"]).optional(),
  /** The image model that drew it. */
  model: z.string().max(120).optional(),
  from: z.string().date().optional(),
  to: z.string().date().optional(),
  /**
   * unused: images nothing uses (not a panel's artwork, a reference, on the board, the cover or the thumbnail).
   * duplicates: files stored more than once (the same bytes), together.
   */
  view: z.enum(["unused", "duplicates"]).optional(),
});
const IMAGE_KINDS = sql`('panel_art','character_reference','location_reference','prop_reference','style_reference','source_image','cover')`;
doc({
  method: "GET",
  path: "/api/projects/:projectId/assets",
  summary:
    "Asset library: the project's files with their tags, collections and favourite mark. Filters: type, a name/type/tag search (q), tag, collection, favourite, the images of a character, place or prop, source (generated, uploaded, derived), the model that drew it, a date range; views: unused images and duplicate files. Also the tags, collections and models in use, for filters.",
  tag: "assets",
  query: ListQuery,
});
assetRoutes.get("/projects/:projectId/assets", requireUser, async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, ListQuery);
  const { db } = c.get("deps");
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%` : null;
  const rows = await db
    .select({ a: assets, m: assetMarks, model: generationJobs.model, provider: generationJobs.provider })
    .from(assets)
    .leftJoin(assetMarks, eq(assetMarks.assetId, assets.id))
    .leftJoin(generationJobs, eq(generationJobs.id, assets.generationJobId))
    .where(
      and(
        eq(assets.projectId, p.id),
        q.type ? eq(assets.type, q.type as "panel_art") : sql`${assets.type} not in ('prompt_reference','thumbnail')`,
        q.trash === "1" ? isNotNull(assets.deletedAt) : isNull(assets.deletedAt),
        // Cached video sections are the renderer's working files, not something to browse.
        sql`not (${assets.metadata} ? 'renderSection')`,
        like
          ? sql`(${assets.metadata}->>'fileName' ilike ${like} or ${assets.metadata}->>'originalName' ilike ${like}
              or ${assets.type}::text ilike ${like} or ${assetMarks.tags}::text ilike ${like})`
          : undefined,
        q.tag ? sql`${assetMarks.tags} ? ${q.tag}` : undefined,
        q.collection ? sql`${assetMarks.collections} ? ${q.collection}` : undefined,
        q.favourite ? eq(assetMarks.favourite, true) : undefined,
        q.characterId
          ? sql`${assets.id} in (
              select ra.asset_id from reference_assets ra join character_versions cv on cv.id = ra.character_version_id
                where cv.character_id = ${q.characterId}
              union
              select pn.active_artwork_asset_id from panels pn join character_versions cv on pn.character_version_ids ? cv.id::text
                where cv.character_id = ${q.characterId} and pn.active_artwork_asset_id is not null)`
          : undefined,
        q.locationId
          ? sql`${assets.id} in (
              select ra.asset_id from reference_assets ra join location_versions lv on lv.id = ra.location_version_id
                where lv.location_id = ${q.locationId}
              union
              select pn.active_artwork_asset_id from panels pn join location_versions lv on lv.id = pn.location_version_id
                where lv.location_id = ${q.locationId} and pn.active_artwork_asset_id is not null)`
          : undefined,
        q.propId
          ? sql`${assets.id} in (
              select ra.asset_id from reference_assets ra join prop_versions pv on pv.id = ra.prop_version_id
                where pv.prop_id = ${q.propId}
              union
              select pn.active_artwork_asset_id from panels pn join prop_versions pv on pn.prop_version_ids ? pv.id::text
                where pv.prop_id = ${q.propId} and pn.active_artwork_asset_id is not null)`
          : undefined,
        // A redraw keeps its earlier version as parent and is still generated; an edit or a tool result is derived.
        q.source === "generated"
          ? sql`${generationJobs.kind} is not null and ${generationJobs.kind} <> 'panel_edit'`
          : undefined,
        q.source === "uploaded"
          ? sql`${assets.generationJobId} is null and ${assets.parentAssetId} is null and ${assets.metadata} ? 'originalName'`
          : undefined,
        q.source === "derived"
          ? sql`(${generationJobs.kind} = 'panel_edit' or (${assets.generationJobId} is null and ${assets.parentAssetId} is not null))`
          : undefined,
        q.model ? eq(generationJobs.model, q.model) : undefined,
        q.from ? sql`${assets.createdAt} >= ${q.from}::date` : undefined,
        q.to ? sql`${assets.createdAt} < ${q.to}::date + 1` : undefined,
        q.view === "unused"
          ? sql`${assets.type} in ${IMAGE_KINDS}
              and not exists (select 1 from panels pn where pn.active_artwork_asset_id = ${assets.id})
              and not exists (select 1 from reference_assets ra where ra.asset_id = ${assets.id})
              and not exists (select 1 from board_items b where b.asset_id = ${assets.id})
              and not exists (select 1 from projects pr where pr.cover_asset_id = ${assets.id}
                or pr.settings->'thumbnail'->>'assetId' = ${assets.id}::text)`
          : undefined,
        q.view === "duplicates"
          ? sql`${assets.sha256} in (select a2.sha256 from assets a2 where a2.project_id = ${p.id} and a2.deleted_at is null
              group by a2.sha256 having count(*) > 1)`
          : undefined,
      ),
    )
    .orderBy(...(q.view === "duplicates" ? [asc(assets.sha256), desc(assets.createdAt)] : [desc(assets.createdAt)]))
    .limit(q.limit);
  const [usage] = await db.execute<{
    bytes: number;
    variant_bytes: number;
  }>(sql`select coalesce(sum(byte_size),0)::float as bytes,
    (select coalesce(sum(v.byte_size),0)::float from asset_variants v join assets a on a.id = v.asset_id where a.project_id = ${p.id}) as variant_bytes
    from assets where project_id = ${p.id}`);
  const [facets] = await db.execute<{
    tags: string[] | null;
    collections: string[] | null;
    models: string[] | null;
  }>(sql`
    select
      (select array_agg(distinct t) from asset_marks m, jsonb_array_elements_text(m.tags) t where m.project_id = ${p.id}) as tags,
      (select array_agg(distinct t) from asset_marks m, jsonb_array_elements_text(m.collections) t where m.project_id = ${p.id}) as collections,
      (select array_agg(distinct g.model) from assets a join generation_jobs g on g.id = a.generation_job_id
        where a.project_id = ${p.id} and g.model is not null and a.type = 'panel_art') as models`);
  return c.json({
    assets: rows.map(({ a, m, model, provider }) => ({
      ...a,
      storageKey: undefined,
      tags: m?.tags ?? [],
      collections: m?.collections ?? [],
      favourite: m?.favourite ?? false,
      model: model ?? null,
      provider: provider ?? null,
    })),
    storage: usage,
    facets: {
      tags: (facets?.tags ?? []).sort(),
      collections: (facets?.collections ?? []).sort(),
      models: (facets?.models ?? []).sort(),
    },
  });
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
  // Where it came from, and what uses it now.
  const [job] = a.generationJobId
    ? await db
        .select({
          id: generationJobs.id,
          kind: generationJobs.kind,
          provider: generationJobs.provider,
          model: generationJobs.model,
          templateName: generationJobs.templateName,
          templateVersion: generationJobs.templateVersion,
          createdAt: generationJobs.createdAt,
        })
        .from(generationJobs)
        .where(eq(generationJobs.id, a.generationJobId))
    : [];
  const usedBy = await db.execute<{ kind: string; label: string; panel_id: string | null }>(sql`
    select 'panel' as kind, concat('Ch. ', ch."order", ', page ', pg."order", ', panel ', pn."order") as label, pn.id as panel_id
      from panels pn join pages pg on pg.id = pn.page_id join chapters ch on ch.id = pg.chapter_id
      where pn.active_artwork_asset_id = ${id}
    union all
    select 'reference', coalesce(c.name, l.name, pr.name, 'style'), null
      from reference_assets ra
      left join character_versions cv on cv.id = ra.character_version_id left join characters c on c.id = cv.character_id
      left join location_versions lv on lv.id = ra.location_version_id left join locations l on l.id = lv.location_id
      left join prop_versions pv on pv.id = ra.prop_version_id left join props pr on pr.id = pv.prop_id
      where ra.asset_id = ${id}
    union all
    select 'board', 'Reference board', null from board_items b where b.asset_id = ${id}
    union all
    select 'cover', 'Project cover', null from projects p where p.cover_asset_id = ${id}
    union all
    select 'thumbnail', 'Video thumbnail', null from projects p where p.settings->'thumbnail'->>'assetId' = ${id}::text`);
  const [marks] = await db.select().from(assetMarks).where(eq(assetMarks.assetId, id));
  return c.json({
    asset: { ...a, storageKey: undefined },
    variants: variants.map((v) => ({ ...v, storageKey: undefined })),
    lineage,
    children,
    source: {
      kind: job
        ? job.kind === "panel_edit"
          ? "derived"
          : "generated"
        : a.parentAssetId
          ? "derived"
          : a.metadata?.originalName
            ? "uploaded"
            : "made",
      job: job ?? null,
      uploadedName: (a.metadata?.originalName as string | undefined) ?? null,
      tool: (a.metadata?.tool as string | undefined) ?? null,
    },
    usedBy: [...usedBy].map((u) => ({ kind: u.kind, label: u.label, panelId: u.panel_id })),
    marks: { tags: marks?.tags ?? [], collections: marks?.collections ?? [], favourite: marks?.favourite ?? false },
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

/** Why an asset cannot go to the trash, or null when it can. */
async function whyNotTrash(db: AppEnv["Variables"]["deps"]["db"], a: typeof assets.$inferSelect) {
  if (a.status === "locked") return "Locked assets cannot be trashed";
  const [active] = await db
    .select({ id: panels.id })
    .from(panels)
    .where(eq(panels.activeArtworkAssetId, a.id))
    .limit(1);
  if (active) return "This artwork is active on a panel. Activate another version first.";
  if (await usedByOtherProjects(db, a)) return SHARED;
  return null;
}

doc({ method: "POST", path: "/api/assets/:id/trash", summary: "Move asset to trash", tag: "assets" });
assetRoutes.post("/assets/:id/trash", requireUser, async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [a] = await db.select().from(assets).where(eq(assets.id, id));
  if (!a?.projectId) throw notFound("Asset");
  await projectAccess(c, a.projectId, "write");
  const why = await whyNotTrash(db, a);
  if (why) throw conflict(why);
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

const Name = z.string().trim().min(1).max(60);
const Marks = z.object({
  tags: z.array(Name).max(50).optional(),
  collections: z.array(Name).max(50).optional(),
  favourite: z.boolean().optional(),
});
/** Writes an asset's marks, keeping what is not given. */
async function setMarks(
  db: AppEnv["Variables"]["deps"]["db"],
  a: { id: string; projectId: string },
  change: (m: { tags: string[]; collections: string[]; favourite: boolean }) => Partial<z.infer<typeof Marks>>,
) {
  const [cur] = await db.select().from(assetMarks).where(eq(assetMarks.assetId, a.id));
  const base = { tags: cur?.tags ?? [], collections: cur?.collections ?? [], favourite: cur?.favourite ?? false };
  const next = { ...base, ...change(base) };
  const uniq = (x: string[]) => [...new Set(x)];
  const values = { tags: uniq(next.tags), collections: uniq(next.collections), favourite: next.favourite };
  await db
    .insert(assetMarks)
    .values({ assetId: a.id, projectId: a.projectId, ...values })
    .onConflictDoUpdate({ target: assetMarks.assetId, set: { ...values, updatedAt: new Date() } });
  return values;
}

doc({
  method: "PUT",
  path: "/api/assets/:id/marks",
  summary: "Set an asset's tags, collections or favourite mark (each left out stays as it is).",
  tag: "assets",
  body: Marks,
});
assetRoutes.put("/assets/:id/marks", requireUser, async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [a] = await db.select().from(assets).where(eq(assets.id, id));
  if (!a?.projectId) throw notFound("Asset");
  await projectAccess(c, a.projectId, "write");
  const input = await body(c, Marks);
  const marks = await setMarks(db, { id, projectId: a.projectId }, () =>
    Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
  );
  return c.json({ marks });
});

const Bulk = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(["tag", "untag", "collect", "uncollect", "favourite", "unfavourite", "trash", "restore"]),
  /** tag / untag: the tag. collect / uncollect: the collection. */
  value: Name.optional(),
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/assets/bulk",
  summary:
    "One action on many assets of the project: tag or untag, add to or take out of a collection, favourite or not, trash or restore. Assets that cannot be trashed (active on a panel, locked, a series reference) are skipped with the reason.",
  tag: "assets",
  body: Bulk,
});
assetRoutes.post("/projects/:projectId/assets/bulk", requireUser, async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, Bulk);
  if (["tag", "untag", "collect", "uncollect"].includes(input.action) && !input.value)
    throw badRequest("Give the tag or collection as value");
  const { db } = c.get("deps");
  const rows = await db
    .select()
    .from(assets)
    .where(and(eq(assets.projectId, p.id), inArray(assets.id, input.ids)));
  const v = input.value ?? "";
  const skipped: { id: string; reason: string }[] = [];
  for (const a of rows) {
    if (input.action === "trash") {
      if (a.deletedAt) continue;
      const why = await whyNotTrash(db, a);
      if (why) skipped.push({ id: a.id, reason: why });
      else await db.update(assets).set({ deletedAt: new Date() }).where(eq(assets.id, a.id));
    } else if (input.action === "restore") await db.update(assets).set({ deletedAt: null }).where(eq(assets.id, a.id));
    else
      await setMarks(db, { id: a.id, projectId: p.id }, (m) =>
        input.action === "tag"
          ? { tags: [...m.tags, v] }
          : input.action === "untag"
            ? { tags: m.tags.filter((x) => x !== v) }
            : input.action === "collect"
              ? { collections: [...m.collections, v] }
              : input.action === "uncollect"
                ? { collections: m.collections.filter((x) => x !== v) }
                : { favourite: input.action === "favourite" },
      );
  }
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: "asset.bulk",
    targetType: "project",
    targetId: p.id,
    metadata: { action: input.action, value: input.value, assets: rows.length, skipped: skipped.length },
    requestId: c.get("requestId"),
  });
  return c.json({ done: rows.length - skipped.length, skipped });
});

/** Image features computed once per asset and kept (the near-duplicate finder's), or null for a non-image. */
async function featuresOf(deps: AppEnv["Variables"]["deps"], a: typeof assets.$inferSelect) {
  const [known] = await deps.db.select().from(assetFeatures).where(eq(assetFeatures.assetId, a.id));
  if (known) return known;
  if (!a.mimeType.startsWith("image/")) return null;
  try {
    const f = await imageFeatures(await deps.assets.read(a));
    await deps.db
      .insert(assetFeatures)
      .values({ assetId: a.id, ...f })
      .onConflictDoNothing();
    return f;
  } catch {
    return null;
  }
}

doc({
  method: "GET",
  path: "/api/assets/:id/similar",
  summary:
    "Images of the project that look like this one, most alike first, with a score from 0 to 1: the same small image features the near-duplicate finder compares (overall shape, the middle's edges, the border's colours). No AI.",
  tag: "assets",
});
assetRoutes.get("/assets/:id/similar", requireUser, async (c) => {
  const id = uuidParam(c, "id");
  const deps = c.get("deps");
  const [a] = await deps.db.select().from(assets).where(eq(assets.id, id));
  if (!a?.projectId) throw notFound("Asset");
  await projectAccess(c, a.projectId, "read");
  const mine = await featuresOf(deps, a);
  if (!mine) throw badRequest("Only images can be compared");
  // ponytail: the newest 600 images, features made on demand (at most 120 per request); a scan job if projects outgrow it
  const candidates = await deps.db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.projectId, a.projectId),
        isNull(assets.deletedAt),
        sql`${assets.type} in ${IMAGE_KINDS}`,
        sql`${assets.id} <> ${id}`,
      ),
    )
    .orderBy(desc(assets.createdAt))
    .limit(600);
  const known = new Map(
    (candidates.length
      ? await deps.db
          .select()
          .from(assetFeatures)
          .where(
            inArray(
              assetFeatures.assetId,
              candidates.map((x) => x.id),
            ),
          )
      : []
    ).map((f) => [f.assetId, f]),
  );
  let made = 0;
  const scored: { asset: typeof assets.$inferSelect; score: number }[] = [];
  for (const x of candidates) {
    let f: { dhash: string; center: number[]; border: number[] } | null = known.get(x.id) ?? null;
    if (!f && made < 120) {
      made++;
      f = await featuresOf(deps, x);
    }
    if (!f) continue;
    const shape = 1 - hashDistance(mine.dhash, f.dhash) / 64;
    const edges = Math.max(0, correlation(mine.center, f.center));
    const colours = histogramOverlap(mine.border, f.border);
    scored.push({ asset: x, score: Math.round((shape * 0.5 + edges * 0.3 + colours * 0.2) * 1000) / 1000 });
  }
  scored.sort((x, y) => y.score - x.score);
  return c.json({
    similar: scored.slice(0, 24).map((s) => ({ ...s.asset, storageKey: undefined, score: s.score })),
    unscored: candidates.length - scored.length,
  });
});
