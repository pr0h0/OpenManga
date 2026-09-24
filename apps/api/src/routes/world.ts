import {
  and,
  asc,
  desc,
  eq,
  isNotNull,
  isNull,
  locations,
  locationVersions,
  or,
  projectStyles,
  projects,
  props,
  propVersions,
  referenceAssets,
  sql,
  stylePresets,
} from "@openmanga/db";
import { canTransition } from "@openmanga/domain";
import { LocationDescription, PropDescription, StyleDefinition } from "@openmanga/schemas";
import { recordAudit } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { listReferences, mountReferenceEndpoints } from "./references.ts";

export const worldRoutes = new Hono<AppEnv>();

/** Locations and props share the same versioned-entity lifecycle. */
function versionedEntity<K extends "location" | "prop">(kind: K) {
  const isLoc = kind === "location";
  const table = isLoc ? locations : props;
  const vTable = isLoc ? locationVersions : propVersions;
  const fk = isLoc ? locationVersions.locationId : propVersions.propId;
  const Desc = isLoc ? LocationDescription : PropDescription;
  const plural = isLoc ? "locations" : "props";
  const versionPath = isLoc ? "location-versions" : "prop-versions";
  const refCol = isLoc ? referenceAssets.locationVersionId : referenceAssets.propVersionId;

  const Create = z.object({
    name: z.string().trim().min(1).max(120),
    description: z.record(z.string(), z.unknown()).default({}),
  });
  doc({
    method: "GET",
    path: `/api/projects/:projectId/${plural}`,
    summary: `List ${plural} with reference status`,
    tag: "world",
  });
  worldRoutes.get(`/projects/:projectId/${plural}`, async (c) => {
    const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
    const { db } = c.get("deps");
    const trash = c.req.query("trash") === "1";
    const rows = await db
      .select({ e: table, v: vTable })
      .from(table)
      .leftJoin(vTable, eq(vTable.id, table.currentVersionId))
      .where(and(eq(table.projectId, p.id), trash ? isNotNull(table.deletedAt) : isNull(table.deletedAt)))
      .orderBy(asc(table.createdAt));
    const vids = rows.map((r) => r.v?.id).filter((x): x is string => Boolean(x));
    const refs = vids.length
      ? await db
          .select()
          .from(referenceAssets)
          .where(
            and(
              sql`${refCol} in (${sql.join(
                vids.map((v) => sql`${v}`),
                sql`, `,
              )})`,
              sql`${referenceAssets.status} <> 'superseded'`,
            ),
          )
          .orderBy(desc(referenceAssets.isPrimary))
      : [];
    const counts = await db.execute<{ vid: string; n: number }>(
      isLoc
        ? sql`select location_version_id::text as vid, count(*)::int as n from panels where project_id = ${p.id} and location_version_id is not null group by 1`
        : sql`select v.value as vid, count(*)::int as n from panels, jsonb_array_elements_text(prop_version_ids) v where project_id = ${p.id} group by 1`,
    );
    return c.json({
      [plural]: rows.map(({ e, v }) => {
        const mine = refs.filter((r) => (isLoc ? r.locationVersionId : r.propVersionId) === v?.id);
        const approved = mine.find((r) => r.status === "approved" || r.status === "locked");
        return {
          ...e,
          currentVersion: v,
          previewAssetId: (approved ?? mine[0])?.assetId ?? null,
          referenceStatus: approved ? approved.status : mine.length ? "draft" : "none",
          appearances: [...counts].find((x) => x.vid === v?.id)?.n ?? 0,
        };
      }),
    });
  });

  doc({
    method: "POST",
    path: `/api/projects/:projectId/${plural}`,
    summary: `Create ${kind}`,
    tag: "world",
    body: Create,
  });
  worldRoutes.post(`/projects/:projectId/${plural}`, async (c) => {
    const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
    const input = await body(c, Create);
    const { db } = c.get("deps");
    const created = await db.transaction(async (tx) => {
      const [e] = await tx.insert(table).values({ projectId: p.id, name: input.name }).returning();
      const [v] = await tx
        .insert(vTable)
        .values({
          [isLoc ? "locationId" : "propId"]: e!.id,
          versionNumber: 1,
          description: Desc.parse(input.description),
          createdByUserId: user(c).id,
        } as never)
        .returning();
      await tx.update(table).set({ currentVersionId: v!.id }).where(eq(table.id, e!.id));
      return { ...e!, currentVersionId: v!.id };
    });
    return c.json({ [kind]: created }, 201);
  });

  doc({
    method: "GET",
    path: `/api/${plural}/:id`,
    summary: `${kind} detail with versions and references`,
    tag: "world",
  });
  worldRoutes.get(`/${plural}/:id`, async (c) => {
    const id = uuidParam(c, "id");
    await entityAccess(c, kind, id, "read");
    const { db } = c.get("deps");
    const [e] = await db.select().from(table).where(eq(table.id, id));
    if (!e) throw notFound(kind);
    const versions = await db.select().from(vTable).where(eq(fk, id)).orderBy(desc(vTable.versionNumber));
    const references = await listReferences(
      c,
      kind,
      versions.map((v) => v.id),
    );
    return c.json({ [kind]: e, versions, references });
  });

  const Patch = z.object({
    name: z.string().trim().min(1).max(120).optional(),
    currentVersionId: z.string().uuid().optional(),
  });
  doc({
    method: "PATCH",
    path: `/api/${plural}/:id`,
    summary: `Rename ${kind} / select current version`,
    tag: "world",
    body: Patch,
  });
  worldRoutes.patch(`/${plural}/:id`, async (c) => {
    const id = uuidParam(c, "id");
    await entityAccess(c, kind, id, "write");
    const input = await body(c, Patch);
    const { db } = c.get("deps");
    if (input.currentVersionId) {
      const [v] = await db
        .select()
        .from(vTable)
        .where(and(eq(vTable.id, input.currentVersionId), eq(fk, id)));
      if (!v) throw notFound("Version");
    }
    const [row] = await db.update(table).set(input).where(eq(table.id, id)).returning();
    return c.json({ [kind]: row });
  });

  worldRoutes.delete(`/${plural}/:id`, async (c) => {
    const id = uuidParam(c, "id");
    const p = await entityAccess(c, kind, id, "write");
    await c.get("deps").db.update(table).set({ deletedAt: new Date() }).where(eq(table.id, id));
    await recordAudit(c.get("deps").db, {
      userId: user(c).id,
      projectId: p.id,
      action: `${kind}.trash`,
      targetId: id,
      requestId: c.get("requestId"),
    });
    return c.json({ ok: true });
  });
  worldRoutes.post(`/${plural}/:id/restore`, async (c) => {
    const id = uuidParam(c, "id");
    await entityAccess(c, kind, id, "write");
    await c.get("deps").db.update(table).set({ deletedAt: null }).where(eq(table.id, id));
    return c.json({ ok: true });
  });

  const PatchVersion = z.object({ description: Desc });
  doc({
    method: "PATCH",
    path: `/api/${versionPath}/:id`,
    summary: `Edit a draft ${kind} version`,
    tag: "world",
    body: PatchVersion,
  });
  worldRoutes.patch(`/${versionPath}/:id`, async (c) => {
    const id = uuidParam(c, "id");
    await entityAccess(c, `${kind}_version`, id, "write");
    const { db } = c.get("deps");
    const [v] = await db.select().from(vTable).where(eq(vTable.id, id));
    if (!v) throw notFound("Version");
    if (v.status !== "draft")
      throw conflict(`Version v${v.versionNumber} is ${v.status}. Create a new version to change it.`);
    const { description } = await body(c, PatchVersion);
    const [row] = await db
      .update(vTable)
      .set({ description } as never)
      .where(eq(vTable.id, id))
      .returning();
    return c.json({ version: row });
  });

  const Status = z.object({ status: z.enum(["draft", "approved", "locked", "superseded"]) });
  worldRoutes.post(`/${versionPath}/:id/status`, async (c) => {
    const id = uuidParam(c, "id");
    const p = await entityAccess(c, `${kind}_version`, id, "write");
    const { status } = await body(c, Status);
    const { db } = c.get("deps");
    const [v] = await db.select().from(vTable).where(eq(vTable.id, id));
    if (!v) throw notFound("Version");
    if (!canTransition(v.status, status)) throw conflict(`Cannot change a ${v.status} version to ${status}`);
    const [row] = await db.update(vTable).set({ status }).where(eq(vTable.id, id)).returning();
    if (status === "locked")
      await db
        .update(referenceAssets)
        .set({ status: "locked" })
        .where(and(eq(refCol, id), eq(referenceAssets.status, "approved")));
    await recordAudit(db, {
      userId: user(c).id,
      projectId: p.id,
      action: `${kind}_version.${status}`,
      targetId: id,
      requestId: c.get("requestId"),
    });
    return c.json({ version: row });
  });

  const NewVersion = z.object({
    description: Desc.optional(),
    fromVersionId: z.string().uuid().optional(),
    makeCurrent: z.boolean().default(true),
  });
  worldRoutes.post(`/${plural}/:id/versions`, async (c) => {
    const id = uuidParam(c, "id");
    await entityAccess(c, kind, id, "write");
    const input = await body(c, NewVersion);
    const { db } = c.get("deps");
    const [e] = await db.select().from(table).where(eq(table.id, id));
    if (!e) throw notFound(kind);
    const baseId = input.fromVersionId ?? e.currentVersionId;
    // Scoped to this entity: an id from another project would be copied into the new version verbatim.
    const [base] = baseId
      ? await db
          .select()
          .from(vTable)
          .where(and(eq(vTable.id, baseId), eq(fk, id)))
      : [];
    const v = await db.transaction(async (tx) => {
      const [max] = await tx
        .select({ n: sql<number>`coalesce(max(${vTable.versionNumber}),0)::int` })
        .from(vTable)
        .where(eq(fk, id));
      const [nv] = await tx
        .insert(vTable)
        .values({
          [isLoc ? "locationId" : "propId"]: id,
          versionNumber: (max?.n ?? 0) + 1,
          description: input.description ?? base?.description ?? Desc.parse({}),
          parentVersionId: base?.id ?? null,
          createdByUserId: user(c).id,
        } as never)
        .returning();
      if (input.makeCurrent) await tx.update(table).set({ currentVersionId: nv!.id }).where(eq(table.id, id));
      return nv!;
    });
    return c.json({ version: v }, 201);
  });

  mountReferenceEndpoints(worldRoutes, kind, versionPath, async (c: Context<AppEnv>, id, action) => {
    const p = await entityAccess(c, `${kind}_version`, id, action);
    const [v] = await c.get("deps").db.select({ status: vTable.status }).from(vTable).where(eq(vTable.id, id));
    return { projectId: p.id, status: v?.status };
  });
}

versionedEntity("location");
versionedEntity("prop");

// ---------------------------------------------------------------- styles

doc({ method: "GET", path: "/api/style-presets", summary: "Built-in and project style presets", tag: "styles" });
worldRoutes.get("/style-presets", async (c) => {
  const rows = await c
    .get("deps")
    .db.select()
    .from(stylePresets)
    .where(isNull(stylePresets.projectId))
    .orderBy(asc(stylePresets.name));
  return c.json({ presets: rows });
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/style",
  summary: "Project style history with references",
  tag: "styles",
});
worldRoutes.get("/projects/:projectId/style", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const versions = await db
    .select({ s: projectStyles, preset: stylePresets })
    .from(projectStyles)
    .leftJoin(stylePresets, eq(stylePresets.id, projectStyles.stylePresetId))
    .where(eq(projectStyles.projectId, p.id))
    .orderBy(desc(projectStyles.versionNumber));
  const references = await listReferences(
    c,
    "style",
    versions.map((v) => v.s.id),
  );
  return c.json({
    currentStyleId: p.currentStyleId,
    versions: versions.map((v) => ({ ...v.s, preset: v.preset })),
    references,
  });
});

export const SetStyle = z.object({
  stylePresetKey: z.string().max(64).nullable(),
  customDescription: z.string().max(4000).default(""),
  customDefinition: StyleDefinition.partial().optional(),
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/style",
  summary: "Set project style (creates a new style version)",
  tag: "styles",
  body: SetStyle,
});
worldRoutes.post("/projects/:projectId/style", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, SetStyle);
  const { db } = c.get("deps");
  const row = await db.transaction(async (tx) => {
    let presetId: string | null = null;
    if (input.customDefinition) {
      const [custom] = await tx
        .insert(stylePresets)
        .values({
          key: `project-${p.id}-${Date.now()}`,
          name: "Custom",
          projectId: p.id,
          definition: StyleDefinition.parse(input.customDefinition),
        })
        .returning();
      presetId = custom!.id;
    } else if (input.stylePresetKey) {
      const [preset] = await tx
        .select()
        .from(stylePresets)
        .where(
          and(
            eq(stylePresets.key, input.stylePresetKey),
            or(isNull(stylePresets.projectId), eq(stylePresets.projectId, p.id)),
          ),
        );
      if (!preset) throw notFound("Style preset");
      presetId = preset.id;
    }
    const [max] = await tx
      .select({ n: sql<number>`coalesce(max(${projectStyles.versionNumber}),0)::int` })
      .from(projectStyles)
      .where(eq(projectStyles.projectId, p.id));
    const [s] = await tx
      .insert(projectStyles)
      .values({
        projectId: p.id,
        versionNumber: (max?.n ?? 0) + 1,
        stylePresetId: presetId,
        customDescription: input.customDescription,
      })
      .returning();
    if (p.currentStyleId)
      await tx.update(projectStyles).set({ status: "superseded" }).where(eq(projectStyles.id, p.currentStyleId));
    await tx.update(projects).set({ currentStyleId: s!.id }).where(eq(projects.id, p.id));
    return s!;
  });
  return c.json({ style: row }, 201);
});

doc({
  method: "POST",
  path: "/api/project-styles/:id/make-current",
  summary: "Switch the project back to an earlier style version",
  tag: "styles",
});
worldRoutes.post("/project-styles/:id/make-current", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [target] = await db.select().from(projectStyles).where(eq(projectStyles.id, id));
  if (!target) throw notFound("Style version");
  const p = await projectAccess(c, target.projectId, "write");
  if (p.currentStyleId === target.id) return c.json({ style: target });
  // Setting a style always minted a new version, so comparing two looks meant retyping one from scratch. Older
  // versions were kept and shown all along; this just points the project back at one.
  const row = await db.transaction(async (tx) => {
    if (p.currentStyleId)
      await tx.update(projectStyles).set({ status: "superseded" }).where(eq(projectStyles.id, p.currentStyleId));
    const [restored] = await tx
      .update(projectStyles)
      .set({ status: "approved" })
      .where(eq(projectStyles.id, target.id))
      .returning();
    await tx.update(projects).set({ currentStyleId: target.id }).where(eq(projects.id, p.id));
    return restored!;
  });
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: "style.make_current",
    targetId: row.id,
    metadata: { versionNumber: row.versionNumber },
    requestId: c.get("requestId"),
  });
  return c.json({ style: row });
});

mountReferenceEndpoints(worldRoutes, "style", "project-styles", async (c, id, action) => {
  const [s] = await c.get("deps").db.select().from(projectStyles).where(eq(projectStyles.id, id));
  if (!s) throw notFound("Style");
  await projectAccess(c, s.projectId, action);
  return { projectId: s.projectId, status: s.status };
});
