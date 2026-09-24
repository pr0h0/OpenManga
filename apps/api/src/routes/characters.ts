import {
  and,
  asc,
  characterAliases,
  characterOutfits,
  characters,
  characterVersions,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  panels,
  referenceAssets,
  sql,
} from "@openmanga/db";
import { canTransition, lintCharacter } from "@openmanga/domain";
import { asPatch, CharacterBible, CharacterRole } from "@openmanga/schemas";
import { isStale, outfitTimeline, recordAudit, versionFingerprints } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { ApiError, body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { listReferences, mountReferenceEndpoints } from "./references.ts";

export const characterRoutes = new Hono<AppEnv>();

/**
 * Harm vocabulary in the fields that reach image prompts (bible, immutable traits, this version's outfits).
 * Warnings only: moderators block these probabilistically, so the user decides.
 */
function versionLint(
  v: { id: string; description: CharacterBible; immutableTraits: string[] },
  outfits: { characterVersionId: string | null; name: string; description: string }[],
) {
  return lintCharacter(
    v.description,
    v.immutableTraits,
    outfits.filter((o) => !o.characterVersionId || o.characterVersionId === v.id),
  );
}

export const CreateCharacter = z.object({
  name: z.string().trim().min(1).max(120),
  role: CharacterRole.default("supporting"),
  description: CharacterBible.partial().default({}),
  aliases: z.array(z.string().trim().min(1).max(120)).max(50).default([]),
});

doc({ method: "GET", path: "/api/projects/:projectId/characters", summary: "Cast cards", tag: "characters" });
characterRoutes.get("/projects/:projectId/characters", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const deleted = c.req.query("trash") === "1";
  const rows = await db
    .select({ c: characters, v: characterVersions })
    .from(characters)
    .leftJoin(characterVersions, eq(characterVersions.id, characters.currentVersionId))
    .where(
      and(eq(characters.projectId, p.id), deleted ? isNotNull(characters.deletedAt) : isNull(characters.deletedAt)),
    )
    .orderBy(asc(characters.createdAt));
  const ids = rows.map((r) => r.c.id);
  const versionIds = rows.map((r) => r.v?.id).filter((x): x is string => Boolean(x));
  const refs = versionIds.length
    ? await db
        .select()
        .from(referenceAssets)
        .where(
          and(inArray(referenceAssets.characterVersionId, versionIds), sql`${referenceAssets.status} <> 'superseded'`),
        )
        .orderBy(desc(referenceAssets.isPrimary), desc(referenceAssets.createdAt))
    : [];
  const appearances = ids.length
    ? await db.execute<{ character_id: string; n: number }>(sql`
        select cv.character_id, count(distinct p.id)::int as n from panels p
        join character_versions cv on p.character_version_ids @> to_jsonb(cv.id::text)
        where p.project_id = ${p.id} group by cv.character_id`)
    : [];
  const aliases = ids.length
    ? await db.select().from(characterAliases).where(inArray(characterAliases.characterId, ids))
    : [];
  const outfits = ids.length
    ? await db.select().from(characterOutfits).where(inArray(characterOutfits.characterId, ids))
    : [];
  const fingerprints = await versionFingerprints(db, "character", versionIds);
  const versionCounts = ids.length
    ? await db
        .select({ id: characterVersions.characterId, n: sql<number>`count(*)::int` })
        .from(characterVersions)
        .where(inArray(characterVersions.characterId, ids))
        .groupBy(characterVersions.characterId)
    : [];
  return c.json({
    characters: rows.map(({ c: ch, v }) => {
      const mine = refs.filter((r) => r.characterVersionId === v?.id);
      const approved = mine.find((r) => r.status === "approved" || r.status === "locked");
      return {
        ...ch,
        currentVersion: v,
        versionCount: versionCounts.find((x) => x.id === ch.id)?.n ?? 0,
        portraitAssetId: (approved ?? mine[0])?.assetId ?? null,
        referenceStatus: approved ? approved.status : mine.length ? "draft" : "none",
        referenceCount: mine.length,
        staleReferences: mine.filter((r) => isStale(r, fingerprints.get(String(v?.id)))).length,
        contentWarnings: v ? versionLint(v, outfits).length : 0,
        appearances: [...appearances].find((a) => a.character_id === ch.id)?.n ?? 0,
        aliases: aliases.filter((a) => a.characterId === ch.id).map((a) => ({ id: a.id, alias: a.alias })),
      };
    }),
  });
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/characters",
  summary: "Manually add a character",
  tag: "characters",
  body: CreateCharacter,
});
characterRoutes.post("/projects/:projectId/characters", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, CreateCharacter);
  const { db } = c.get("deps");
  const bible = CharacterBible.parse(input.description);
  const created = await db.transaction(async (tx) => {
    const [ch] = await tx
      .insert(characters)
      .values({ projectId: p.id, name: input.name, role: input.role })
      .returning();
    const [v] = await tx
      .insert(characterVersions)
      .values({
        characterId: ch!.id,
        versionNumber: 1,
        description: bible,
        immutableTraits: bible.immutableTraits,
        createdByUserId: user(c).id,
        changeNote: "Created manually",
      })
      .returning();
    await tx.update(characters).set({ currentVersionId: v!.id }).where(eq(characters.id, ch!.id));
    if (input.aliases.length)
      await tx
        .insert(characterAliases)
        .values([...new Set(input.aliases)].map((alias) => ({ characterId: ch!.id, alias })))
        .onConflictDoNothing();
    if (bible.wardrobe)
      await tx.insert(characterOutfits).values({
        characterId: ch!.id,
        characterVersionId: v!.id,
        name: "Default",
        description: bible.wardrobe,
        isDefault: true,
      });
    return { ...ch!, currentVersionId: v!.id };
  });
  return c.json({ character: created, contentWarnings: lintCharacter(bible, bible.immutableTraits) }, 201);
});

doc({
  method: "GET",
  path: "/api/characters/:id",
  summary: "Character detail: versions, aliases, outfits, references",
  tag: "characters",
});
characterRoutes.get("/characters/:id", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "character", id, "read");
  const { db } = c.get("deps");
  const [ch] = await db.select().from(characters).where(eq(characters.id, id));
  if (!ch) throw notFound("Character");
  const versions = await db
    .select()
    .from(characterVersions)
    .where(eq(characterVersions.characterId, id))
    .orderBy(desc(characterVersions.versionNumber));
  const aliases = await db
    .select()
    .from(characterAliases)
    .where(eq(characterAliases.characterId, id))
    .orderBy(asc(characterAliases.alias));
  const outfits = await db
    .select()
    .from(characterOutfits)
    .where(eq(characterOutfits.characterId, id))
    .orderBy(asc(characterOutfits.createdAt));
  const references = await listReferences(
    c,
    "character",
    versions.map((v) => v.id),
  );
  const usage = versions.length
    ? await db.execute<{ version_id: string; n: number }>(
        sql`select cv.id as version_id, count(p.id)::int as n from character_versions cv left join panels p on p.character_version_ids @> to_jsonb(cv.id::text) where cv.character_id = ${id} group by cv.id`,
      )
    : [];
  return c.json({
    character: ch,
    versions: versions.map((v) => ({
      ...v,
      panelCount: [...usage].find((u) => u.version_id === v.id)?.n ?? 0,
      contentWarnings: versionLint(v, outfits),
    })),
    aliases,
    outfits,
    references,
  });
});

export const PatchCharacter = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: CharacterRole.optional(),
  currentVersionId: z.string().uuid().optional(),
});
doc({
  method: "PATCH",
  path: "/api/characters/:id",
  summary: "Rename / change role / select current version",
  tag: "characters",
  body: PatchCharacter,
});
characterRoutes.patch("/characters/:id", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "character", id, "write");
  const input = await body(c, PatchCharacter);
  const { db } = c.get("deps");
  if (input.currentVersionId) {
    const [v] = await db
      .select()
      .from(characterVersions)
      .where(and(eq(characterVersions.id, input.currentVersionId), eq(characterVersions.characterId, id)));
    if (!v) throw notFound("Version");
    // New panels pin the current version and take their identity reference from it, and a draft's references are
    // never used for identity — so a draft as current would generate that character with no reference at all.
    if (v.status === "draft")
      throw conflict("A draft cannot be the current version. Approve it first, which makes it current.");
  }
  const [row] = await db.update(characters).set(input).where(eq(characters.id, id)).returning();
  return c.json({ character: row });
});

doc({ method: "DELETE", path: "/api/characters/:id", summary: "Move character to trash", tag: "characters" });
characterRoutes.delete("/characters/:id", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "character", id, "write");
  await c.get("deps").db.update(characters).set({ deletedAt: new Date() }).where(eq(characters.id, id));
  await recordAudit(c.get("deps").db, {
    userId: user(c).id,
    projectId: p.id,
    action: "character.trash",
    targetType: "character",
    targetId: id,
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

doc({
  method: "DELETE",
  path: "/api/character-versions/:id",
  summary: "Delete a draft version. Refused for approved/locked versions, the only version, or one panels still use",
  tag: "characters",
});
characterRoutes.delete("/character-versions/:id", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "character_version", id, "write");
  const { db } = c.get("deps");
  const [v] = await db.select().from(characterVersions).where(eq(characterVersions.id, id));
  if (!v) throw notFound("Version");
  // Only a draft: an approved or locked version is part of the record that panels were drawn against.
  if (v.status !== "draft") throw conflict(`Only a draft version can be deleted; this one is ${v.status}`);
  const siblings = await db
    .select({ id: characterVersions.id, n: characterVersions.versionNumber })
    .from(characterVersions)
    .where(eq(characterVersions.characterId, v.characterId))
    .orderBy(desc(characterVersions.versionNumber));
  if (siblings.length < 2) throw conflict("A character keeps at least one version");
  const [used] = await db
    .select({ id: panels.id })
    .from(panels)
    .where(sql`${panels.characterVersionIds} @> ${JSON.stringify([id])}::jsonb`)
    .limit(1);
  if (used) throw conflict("Panels were drawn against this version; migrate them first");
  const [ch] = await db.select().from(characters).where(eq(characters.id, v.characterId));
  await db.transaction(async (tx) => {
    // Hand "current" to the newest surviving version rather than leaving the character pointing at nothing.
    if (ch?.currentVersionId === id) {
      const next = siblings.find((s) => s.id !== id)!;
      await tx.update(characters).set({ currentVersionId: next.id }).where(eq(characters.id, v.characterId));
    }
    // Anything descended from it keeps its history readable by re-parenting onto this version's parent.
    await tx
      .update(characterVersions)
      .set({ parentVersionId: v.parentVersionId })
      .where(eq(characterVersions.parentVersionId, id));
    await tx.delete(characterVersions).where(eq(characterVersions.id, id));
  });
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: "character_version.delete",
    targetType: "character_version",
    targetId: id,
    metadata: { versionNumber: v.versionNumber },
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

doc({
  method: "POST",
  path: "/api/characters/:id/restore",
  summary: "Restore character from trash",
  tag: "characters",
});
characterRoutes.post("/characters/:id/restore", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "character", id, "write");
  await c.get("deps").db.update(characters).set({ deletedAt: null }).where(eq(characters.id, id));
  return c.json({ ok: true });
});

export const PatchVersion = z.object({
  description: CharacterBible.optional(),
  immutableTraits: z.array(z.string().trim().min(1).max(200)).max(40).optional(),
  changeNote: z.string().max(500).optional(),
});
doc({
  method: "PATCH",
  path: "/api/character-versions/:id",
  summary: "Edit a DRAFT version (approved/locked versions are immutable)",
  tag: "characters",
  body: PatchVersion,
});
characterRoutes.patch("/character-versions/:id", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "character_version", id, "write");
  const { db } = c.get("deps");
  const [v] = await db.select().from(characterVersions).where(eq(characterVersions.id, id));
  if (!v) throw notFound("Version");
  if (v.status !== "draft")
    throw conflict(`Version v${v.versionNumber} is ${v.status}. Create a new appearance version to change it.`);
  const input = await body(c, PatchVersion);
  const [row] = await db
    .update(characterVersions)
    .set({
      description: input.description ?? v.description,
      immutableTraits: input.immutableTraits ?? input.description?.immutableTraits ?? v.immutableTraits,
      changeNote: input.changeNote ?? v.changeNote,
    })
    .where(eq(characterVersions.id, id))
    .returning();
  // A default outfit made from this version's wardrobe follows an edit of that wardrobe, unless it was rewritten.
  const oldWardrobe = CharacterBible.parse(v.description).wardrobe;
  const newWardrobe = input.description?.wardrobe;
  if (newWardrobe !== undefined && newWardrobe !== oldWardrobe)
    await db
      .update(characterOutfits)
      .set({ description: newWardrobe })
      .where(
        and(
          eq(characterOutfits.characterId, v.characterId),
          eq(characterOutfits.characterVersionId, v.id),
          eq(characterOutfits.isDefault, true),
          eq(characterOutfits.description, oldWardrobe),
        ),
      );
  const outfitRows = await db.select().from(characterOutfits).where(eq(characterOutfits.characterId, v.characterId));
  return c.json({ version: row, contentWarnings: row ? versionLint(row, outfitRows) : [] });
});

const VersionStatus = z.object({ status: z.enum(["draft", "approved", "locked", "superseded"]) });
doc({
  method: "POST",
  path: "/api/character-versions/:id/status",
  summary: "Approve / lock / supersede a character version",
  tag: "characters",
  body: VersionStatus,
});
characterRoutes.post("/character-versions/:id/status", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "character_version", id, "write");
  const { status } = await body(c, VersionStatus);
  const { db } = c.get("deps");
  const [v] = await db.select().from(characterVersions).where(eq(characterVersions.id, id));
  if (!v) throw notFound("Version");
  if (!canTransition(v.status, status)) throw conflict(`Cannot change a ${v.status} version to ${status}`);
  if (status === "draft") {
    const [used] = await db
      .select({ id: panels.id })
      .from(panels)
      .where(
        sql`${panels.characterVersionIds} @> ${JSON.stringify([id])}::jsonb and ${panels.activeArtworkAssetId} is not null`,
      )
      .limit(1);
    if (used)
      throw conflict("This version already has generated panels. Create a new version instead of reopening it.");
  }
  const [row] = await db.update(characterVersions).set({ status }).where(eq(characterVersions.id, id)).returning();
  // Approval is the promotion: a version becomes the one new panels pin only once it is fit to draw from.
  if (status === "approved" || status === "locked")
    await db.update(characters).set({ currentVersionId: id }).where(eq(characters.id, v.characterId));
  if (status === "locked")
    await db
      .update(referenceAssets)
      .set({ status: "locked" })
      .where(and(eq(referenceAssets.characterVersionId, id), eq(referenceAssets.status, "approved")));
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: `character_version.${status}`,
    targetType: "character_version",
    targetId: id,
    requestId: c.get("requestId"),
  });
  return c.json({ version: row });
});

export const NewVersion = z.object({
  fromVersionId: z.string().uuid().optional(),
  description: CharacterBible.optional(),
  immutableTraits: z.array(z.string()).optional(),
  changeNote: z.string().max(500).default(""),
  makeCurrent: z.boolean().default(true),
});
doc({
  method: "POST",
  path: "/api/characters/:id/versions",
  summary: "Create a new appearance version (v1 -> v2). Old panels keep their version.",
  tag: "characters",
  body: NewVersion,
});
characterRoutes.post("/characters/:id/versions", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "character", id, "write");
  const input = await body(c, NewVersion);
  const { db } = c.get("deps");
  const [ch] = await db.select().from(characters).where(eq(characters.id, id));
  if (!ch) throw notFound("Character");
  const baseId = input.fromVersionId ?? ch.currentVersionId;
  const [base] = baseId
    ? await db
        .select()
        .from(characterVersions)
        .where(and(eq(characterVersions.id, baseId), eq(characterVersions.characterId, id)))
    : [];
  const created = await db.transaction(async (tx) => {
    const [max] = await tx
      .select({ n: sql<number>`coalesce(max(${characterVersions.versionNumber}),0)::int` })
      .from(characterVersions)
      .where(eq(characterVersions.characterId, id));
    const description = input.description ?? base?.description ?? CharacterBible.parse({});
    const [v] = await tx
      .insert(characterVersions)
      .values({
        characterId: id,
        versionNumber: (max?.n ?? 0) + 1,
        description,
        immutableTraits: input.immutableTraits ?? base?.immutableTraits ?? description.immutableTraits,
        parentVersionId: base?.id ?? null,
        changeNote: input.changeNote,
        createdByUserId: user(c).id,
      })
      .returning();
    // Deliberately not automatic: a new version starts as a draft, and a draft must not become current (see
    // the PATCH guard). Approving it is what promotes it. `makeCurrent` is honoured only for a character that
    // has no current version at all, which is the first version of a new character.
    if (input.makeCurrent && !ch.currentVersionId)
      await tx.update(characters).set({ currentVersionId: v!.id }).where(eq(characters.id, id));
    return v!;
  });
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: "character_version.create",
    targetType: "character_version",
    targetId: created.id,
    metadata: { from: base?.id },
    requestId: c.get("requestId"),
  });
  return c.json(
    { version: created, contentWarnings: lintCharacter(created.description, created.immutableTraits) },
    201,
  );
});

export const Migrate = z.object({
  fromVersionId: z.string().uuid(),
  toVersionId: z.string().uuid(),
  panelIds: z.array(z.string().uuid()).optional(),
  /** Migrate even though the target version has no approved reference (panels lose identity pinning). */
  force: z.boolean().default(false),
});
doc({
  method: "POST",
  path: "/api/characters/:id/migrate-panels",
  summary: "Explicitly migrate panels from one character version to another",
  tag: "characters",
  body: Migrate,
});
characterRoutes.post("/characters/:id/migrate-panels", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "character", id, "write");
  const input = await body(c, Migrate);
  const { db } = c.get("deps");
  const versions = await db
    .select()
    .from(characterVersions)
    .where(
      and(
        eq(characterVersions.characterId, id),
        inArray(characterVersions.id, [input.fromVersionId, input.toVersionId]),
      ),
    );
  if (versions.length !== 2) throw notFound("Version");
  if (!input.force) {
    const refs = await db
      .select()
      .from(referenceAssets)
      .where(
        and(
          eq(referenceAssets.characterVersionId, input.toVersionId),
          inArray(referenceAssets.status, ["approved", "locked"]),
        ),
      );
    const fingerprint = (await versionFingerprints(db, "character", [input.toVersionId])).get(input.toVersionId);
    const usable = refs.filter((r) => !isStale(r, fingerprint));
    if (!usable.length)
      throw new ApiError(
        409,
        "no_approved_reference",
        refs.length
          ? "The target version's approved references were made from an older description. Regenerate a reference on it first, or migrate anyway."
          : "The target version has no approved reference, so migrated panels would lose identity pinning. Generate and approve a reference on it first, or migrate anyway.",
      );
  }
  const rows = await db
    .select()
    .from(panels)
    .where(
      and(
        eq(panels.projectId, p.id),
        sql`${panels.characterVersionIds} @> ${JSON.stringify([input.fromVersionId])}::jsonb`,
      ),
    );
  let migrated = 0;
  for (const panel of rows) {
    if (input.panelIds && !input.panelIds.includes(panel.id)) continue;
    await db
      .update(panels)
      .set({
        characterVersionIds: panel.characterVersionIds.map((v) => (v === input.fromVersionId ? input.toVersionId : v)),
      })
      .where(eq(panels.id, panel.id));
    migrated++;
  }
  await recordAudit(db, {
    userId: user(c).id,
    projectId: p.id,
    action: "character.migrate_panels",
    targetType: "character",
    targetId: id,
    metadata: { ...input, migrated },
    requestId: c.get("requestId"),
  });
  return c.json({ migrated });
});

const AliasInput = z.object({ alias: z.string().trim().min(1).max(120) });
doc({ method: "POST", path: "/api/characters/:id/aliases", summary: "Add alias", tag: "characters", body: AliasInput });
characterRoutes.post("/characters/:id/aliases", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "character", id, "write");
  const { alias } = await body(c, AliasInput);
  const [row] = await c
    .get("deps")
    .db.insert(characterAliases)
    .values({ characterId: id, alias })
    .onConflictDoNothing()
    .returning();
  return c.json({ alias: row ?? null }, 201);
});
doc({ method: "DELETE", path: "/api/character-aliases/:id", summary: "Remove alias", tag: "characters" });
characterRoutes.delete("/character-aliases/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [a] = await db.select().from(characterAliases).where(eq(characterAliases.id, id));
  if (!a) throw notFound("Alias");
  await entityAccess(c, "character", a.characterId, "write");
  await db.delete(characterAliases).where(eq(characterAliases.id, id));
  return c.json({ ok: true });
});

export const OutfitInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  isDefault: z.boolean().default(false),
  characterVersionId: z.string().uuid().nullable().optional(),
});
doc({
  method: "POST",
  path: "/api/characters/:id/outfits",
  summary: "Add outfit variant",
  tag: "characters",
  body: OutfitInput,
});
characterRoutes.post("/characters/:id/outfits", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "character", id, "write");
  const input = await body(c, OutfitInput);
  const { db } = c.get("deps");
  const row = await db.transaction(async (tx) => {
    if (input.isDefault)
      await tx.update(characterOutfits).set({ isDefault: false }).where(eq(characterOutfits.characterId, id));
    const [o] = await tx
      .insert(characterOutfits)
      .values({ characterId: id, ...input, characterVersionId: input.characterVersionId ?? null })
      .returning();
    return o;
  });
  return c.json({ outfit: row }, 201);
});
doc({
  method: "PATCH",
  path: "/api/character-outfits/:id",
  summary: "Edit outfit",
  tag: "characters",
  body: asPatch(OutfitInput),
});
characterRoutes.patch("/character-outfits/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [o] = await db.select().from(characterOutfits).where(eq(characterOutfits.id, id));
  if (!o) throw notFound("Outfit");
  await entityAccess(c, "character", o.characterId, "write");
  const input = await body(c, asPatch(OutfitInput));
  if (input.isDefault)
    await db.update(characterOutfits).set({ isDefault: false }).where(eq(characterOutfits.characterId, o.characterId));
  const [row] = await db.update(characterOutfits).set(input).where(eq(characterOutfits.id, id)).returning();
  return c.json({ outfit: row });
});
doc({ method: "DELETE", path: "/api/character-outfits/:id", summary: "Delete outfit", tag: "characters" });
characterRoutes.delete("/character-outfits/:id", async (c) => {
  const id = uuidParam(c, "id");
  const { db } = c.get("deps");
  const [o] = await db.select().from(characterOutfits).where(eq(characterOutfits.id, id));
  if (!o) throw notFound("Outfit");
  await entityAccess(c, "character", o.characterId, "write");
  await db.delete(characterOutfits).where(eq(characterOutfits.id, id));
  return c.json({ ok: true });
});

doc({
  method: "GET",
  path: "/api/characters/:id/outfit-timeline",
  summary: "Every outfit change of this character, in reading order",
  tag: "characters",
});
characterRoutes.get("/characters/:id/outfit-timeline", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "character", id, "read");
  return c.json({ timeline: await outfitTimeline(c.get("deps").db, [id]) });
});

mountReferenceEndpoints(characterRoutes, "character", "character-versions", async (c, id, action) => {
  const p = await entityAccess(c, "character_version", id, action);
  const [v] = await c
    .get("deps")
    .db.select({ status: characterVersions.status })
    .from(characterVersions)
    .where(eq(characterVersions.id, id));
  return { projectId: p.id, status: v?.status };
});
