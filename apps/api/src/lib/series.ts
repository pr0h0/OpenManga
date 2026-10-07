import {
  and,
  bibleFacts,
  characterAliases,
  characterOutfits,
  characters,
  characterVersions,
  type DbOrTx,
  eq,
  inArray,
  isNull,
  locations,
  locationVersions,
  projectMembers,
  projectStyles,
  projects,
  props,
  propVersions,
  referenceAssets,
  series,
  sql,
} from "@openmanga/db";

type Kind = "character" | "location" | "prop";
const TABLES = {
  character: { e: characters, v: characterVersions, fk: characterVersions.characterId, ref: "characterVersionId" },
  location: { e: locations, v: locationVersions, fk: locationVersions.locationId, ref: "locationVersionId" },
  prop: { e: props, v: propVersions, fk: propVersions.propId, ref: "propVersionId" },
} as const;
export type SyncCounts = { created: number; linked: number; updated: number; facts: number; style: boolean };

/**
 * Brings one episode in step with its series library: each library character, location and prop gets (or keeps) a
 * linked entity in the episode, matched by link and then by name, and a new version whenever the library has moved
 * on. Versions carry the library's description and its reference rows, pointing at the same images (no copies).
 * The style and the story bible facts follow the same way. Entities of the episode's own are left alone.
 */
export async function syncEpisode(tx: DbOrTx, libraryId: string, episodeId: string, userId: string) {
  const counts: SyncCounts = { created: 0, linked: 0, updated: 0, facts: 0, style: false };
  for (const kind of ["character", "location", "prop"] as const)
    await syncKind(tx, kind, libraryId, episodeId, userId, counts);
  counts.style = await syncStyle(tx, libraryId, episodeId);
  counts.facts = await syncFacts(tx, libraryId, episodeId);
  return counts;
}

async function syncKind(
  tx: DbOrTx,
  kind: Kind,
  libraryId: string,
  episodeId: string,
  userId: string,
  counts: SyncCounts,
) {
  const { e, v, fk, ref } = TABLES[kind];
  const lib = await tx
    .select()
    .from(e)
    .where(and(eq(e.projectId, libraryId), isNull(e.deletedAt)));
  const eps = await tx
    .select()
    .from(e)
    .where(and(eq(e.projectId, episodeId), isNull(e.deletedAt)));
  for (const l of lib) {
    if (!l.currentVersionId) continue;
    let ep =
      eps.find((x) => x.sourceId === l.id) ??
      eps.find((x) => !x.sourceId && x.name.toLowerCase() === l.name.toLowerCase());
    if (ep?.sourceId === l.id && ep.syncedVersionId === l.currentVersionId) continue;
    const [lv] = await tx.select().from(v).where(eq(v.id, l.currentVersionId));
    if (!lv) continue;
    if (!ep) {
      [ep] = (await tx
        .insert(e)
        .values({
          projectId: episodeId,
          name: l.name,
          analysisKey: l.analysisKey,
          ...(kind === "character" ? { role: (l as typeof characters.$inferSelect).role } : {}),
        } as never)
        .returning()) as (typeof eps)[number][];
      counts.created++;
    } else if (!ep.sourceId) counts.linked++;
    else counts.updated++;
    const target = ep!;
    const [{ n }] = (await tx
      .select({ n: sql<number>`coalesce(max(${v.versionNumber}), 0)::int` })
      .from(v)
      .where(eq(fk, target.id))) as [{ n: number }];
    const [nv] = (await tx
      .insert(v)
      .values({
        ...(kind === "character"
          ? {
              characterId: target.id,
              immutableTraits: (lv as typeof characterVersions.$inferSelect).immutableTraits,
              changeNote: "From the series library",
            }
          : kind === "location"
            ? { locationId: target.id }
            : { propId: target.id }),
        versionNumber: n + 1,
        description: lv.description,
        status: lv.status,
        parentVersionId: target.currentVersionId,
        createdByUserId: userId,
      } as never)
      .returning()) as { id: string }[];
    await tx
      .update(e)
      .set({ currentVersionId: nv!.id, sourceId: l.id, syncedVersionId: l.currentVersionId, name: l.name } as never)
      .where(eq(e.id, target.id));

    // Outfits by name, so an outfit reference lands on the episode's outfit of the same name.
    const outfitMap = new Map<string, string>();
    if (kind === "character") {
      const aliases = await tx.select().from(characterAliases).where(eq(characterAliases.characterId, l.id));
      if (aliases.length)
        await tx
          .insert(characterAliases)
          .values(aliases.map((a) => ({ characterId: target.id, alias: a.alias })))
          .onConflictDoNothing();
      const libOutfits = await tx.select().from(characterOutfits).where(eq(characterOutfits.characterId, l.id));
      const epOutfits = await tx.select().from(characterOutfits).where(eq(characterOutfits.characterId, target.id));
      for (const o of libOutfits) {
        const mine = epOutfits.find((x) => x.name.toLowerCase() === o.name.toLowerCase());
        if (mine) {
          await tx
            .update(characterOutfits)
            .set({ description: o.description, isDefault: o.isDefault })
            .where(eq(characterOutfits.id, mine.id));
          outfitMap.set(o.id, mine.id);
        } else {
          const [made] = await tx
            .insert(characterOutfits)
            .values({ characterId: target.id, name: o.name, description: o.description, isDefault: o.isDefault })
            .returning();
          outfitMap.set(o.id, made!.id);
        }
      }
    }
    const refs = await tx.select().from(referenceAssets).where(eq(referenceAssets[ref], lv.id));
    if (refs.length)
      await tx.insert(referenceAssets).values(
        refs.map((r) => ({
          projectId: episodeId,
          subjectType: r.subjectType,
          [ref]: nv!.id,
          outfitId: r.outfitId ? (outfitMap.get(r.outfitId) ?? null) : null,
          kind: r.kind,
          assetId: r.assetId,
          status: r.status,
          isPrimary: r.isPrimary,
          sourceFingerprint: r.sourceFingerprint,
        })),
      );
  }
}

async function syncStyle(tx: DbOrTx, libraryId: string, episodeId: string) {
  const [lib] = await tx.select({ s: projects.currentStyleId }).from(projects).where(eq(projects.id, libraryId));
  if (!lib?.s) return false;
  const [ep] = await tx.select({ s: projects.currentStyleId }).from(projects).where(eq(projects.id, episodeId));
  const [current] = ep?.s ? await tx.select().from(projectStyles).where(eq(projectStyles.id, ep.s)) : [];
  if (current?.sourceId === lib.s) return false;
  const [ls] = await tx.select().from(projectStyles).where(eq(projectStyles.id, lib.s));
  if (!ls) return false;
  const [{ n }] = (await tx
    .select({ n: sql<number>`coalesce(max(${projectStyles.versionNumber}), 0)::int` })
    .from(projectStyles)
    .where(eq(projectStyles.projectId, episodeId))) as [{ n: number }];
  const [made] = await tx
    .insert(projectStyles)
    .values({
      projectId: episodeId,
      versionNumber: n + 1,
      stylePresetId: ls.stylePresetId,
      customDescription: ls.customDescription,
      status: ls.status,
      sourceId: ls.id,
    })
    .returning();
  const refs = await tx.select().from(referenceAssets).where(eq(referenceAssets.projectStyleId, ls.id));
  if (refs.length)
    await tx.insert(referenceAssets).values(
      refs.map((r) => ({
        projectId: episodeId,
        subjectType: r.subjectType,
        projectStyleId: made!.id,
        kind: r.kind,
        assetId: r.assetId,
        status: r.status,
        isPrimary: r.isPrimary,
        sourceFingerprint: r.sourceFingerprint,
      })),
    );
  await tx.update(projects).set({ currentStyleId: made!.id }).where(eq(projects.id, episodeId));
  return true;
}

/** The library's facts, copied without their chapter bounds (those chapters are the library's, not the episode's). */
async function syncFacts(tx: DbOrTx, libraryId: string, episodeId: string) {
  const lib = await tx.select().from(bibleFacts).where(eq(bibleFacts.projectId, libraryId));
  const eps = await tx
    .select()
    .from(bibleFacts)
    .where(and(eq(bibleFacts.projectId, episodeId), sql`${bibleFacts.sourceId} is not null`));
  let changed = 0;
  for (const f of lib) {
    const body = { kind: f.kind, subject: f.subject, text: f.text, fixed: f.fixed, visual: f.visual };
    const mine = eps.find((x) => x.sourceId === f.id);
    if (!mine) {
      await tx.insert(bibleFacts).values({ projectId: episodeId, ...body, source: f.source, sourceId: f.id });
      changed++;
    } else if (Object.entries(body).some(([k, val]) => mine[k as keyof typeof body] !== val)) {
      await tx.update(bibleFacts).set(body).where(eq(bibleFacts.id, mine.id));
      changed++;
    }
  }
  const gone = eps.filter((x) => !lib.some((f) => f.id === x.sourceId)).map((x) => x.id);
  if (gone.length) await tx.delete(bibleFacts).where(inArray(bibleFacts.id, gone));
  return changed + gone.length;
}

/** How far an episode is behind its library: library entities with no up-to-date link, a newer style, changed facts. */
export async function episodeStaleness(tx: DbOrTx, libraryId: string, episodeId: string) {
  let behind = 0;
  for (const kind of ["character", "location", "prop"] as const) {
    const { e } = TABLES[kind];
    const [r] = await tx.execute<{ n: number }>(sql`
      select count(*)::int as n from ${e} l where l.project_id = ${libraryId} and l.deleted_at is null
        and l.current_version_id is not null
        and not exists (select 1 from ${e} x where x.project_id = ${episodeId} and x.source_id = l.id
          and x.synced_version_id = l.current_version_id and x.deleted_at is null)`);
    behind += r?.n ?? 0;
  }
  const [s] = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from projects l where l.id = ${libraryId} and l.current_style_id is not null
      and not exists (select 1 from projects e join project_styles ps on ps.id = e.current_style_id
        where e.id = ${episodeId} and ps.source_id = l.current_style_id)`);
  const [f] = await tx.execute<{ n: number }>(sql`
    select (select count(*)::int from bible_facts l where l.project_id = ${libraryId}
      and not exists (select 1 from bible_facts x where x.project_id = ${episodeId} and x.source_id = l.id
        and x.text = l.text and x.subject = l.subject and x.kind = l.kind and x.fixed = l.fixed and x.visual = l.visual))
      + (select count(*)::int from bible_facts x where x.project_id = ${episodeId} and x.source_id is not null
        and not exists (select 1 from bible_facts l where l.id = x.source_id)) as n`);
  return behind + (s?.n ?? 0) + (f?.n ?? 0);
}

/**
 * Whether a user may see a series library's files: they belong to any episode of it. A library's images are shown
 * inside its episodes (their references point at them), so episode collaborators need them without the library.
 */
export async function seesLibrary(tx: DbOrTx, userId: string, libraryProjectId: string) {
  const [r] = await tx
    .select({ id: projects.id })
    .from(series)
    .innerJoin(projects, eq(projects.seriesId, series.id))
    .innerJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, userId)))
    .where(and(eq(series.libraryProjectId, libraryProjectId), isNull(projects.deletedAt)))
    .limit(1);
  return Boolean(r);
}
