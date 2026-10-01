import {
  and,
  assets,
  chapters,
  characterAliases,
  characterOutfits,
  characters,
  characterVersions,
  type Database,
  dialogueLines,
  eq,
  inArray,
  isNull,
  locations,
  locationVersions,
  narrationLines,
  narrationSegments,
  pages,
  panelSpecs,
  panels,
  projectMembers,
  projectStyles,
  projects,
  props,
  propVersions,
  referenceAssets,
  scenes,
  soundEffects,
  storyBeats,
  storyRevisions,
  type Tx,
} from "@openmanga/db";
import { extForMime } from "@openmanga/image-utils";
import type { AssetService } from "@openmanga/services";
import { newStorageKey } from "@openmanga/storage";

/** Deep copy of structured project state. Referenced canonical assets are physically copied (new opaque keys). */
export async function duplicateProject(db: Database, assetSvc: AssetService, projectId: string, userId: string) {
  const [src] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!src) throw new Error("Project not found");
  return db.transaction(async (tx) => {
    const ids = new Map<string, string>();
    const map = (id: string | null | undefined) => (id ? (ids.get(id) ?? null) : null);
    const mapArr = (arr: string[]) => arr.map((i) => ids.get(i)).filter((x): x is string => Boolean(x));

    const [p] = await tx
      .insert(projects)
      .values({
        ...src,
        id: undefined,
        title: `${src.title} (copy)`,
        ownerUserId: userId,
        status: "active",
        deletedAt: null,
        currentStyleId: null,
        coverAssetId: null,
        thumbnailAssetId: null,
        createdAt: undefined,
        updatedAt: undefined,
      })
      .returning();
    const np = p!.id;
    await tx.insert(projectMembers).values({ projectId: np, userId, role: "owner" });

    const copyAsset = async (assetId: string | null) => {
      if (!assetId) return null;
      if (ids.has(assetId)) return ids.get(assetId)!;
      const [a] = await tx.select().from(assets).where(eq(assets.id, assetId));
      if (!a || a.deletedAt) return null;
      const data = await assetSvc.storage.read(a.storageKey).catch(() => null);
      if (!data) return null;
      const storageKey = newStorageKey(a.type, extForMime(a.mimeType));
      await assetSvc.storage.put(storageKey, data);
      const [na] = await tx
        .insert(assets)
        .values({
          ...a,
          id: undefined,
          projectId: np,
          ownerUserId: userId,
          storageKey,
          parentAssetId: null,
          generationJobId: null,
          createdAt: undefined,
          metadata: { ...a.metadata, duplicatedFrom: a.id },
        })
        .returning();
      ids.set(assetId, na!.id);
      return na!.id;
    };

    for (const r of await tx.select().from(storyRevisions).where(eq(storyRevisions.projectId, projectId))) {
      await tx
        .insert(storyRevisions)
        .values({ ...r, id: undefined, projectId: np, createdAt: undefined, updatedAt: undefined });
    }

    const styles = await tx.select().from(projectStyles).where(eq(projectStyles.projectId, projectId));
    for (const s of styles) {
      const [ns] = await tx
        .insert(projectStyles)
        .values({ ...s, id: undefined, projectId: np, createdAt: undefined })
        .returning();
      ids.set(s.id, ns!.id);
    }

    const chars = await tx
      .select()
      .from(characters)
      .where(and(eq(characters.projectId, projectId), isNull(characters.deletedAt)));
    for (const ch of chars) {
      const [nc] = await tx
        .insert(characters)
        .values({
          ...ch,
          id: undefined,
          projectId: np,
          currentVersionId: null,
          createdAt: undefined,
          updatedAt: undefined,
        })
        .returning();
      ids.set(ch.id, nc!.id);
      for (const v of await tx.select().from(characterVersions).where(eq(characterVersions.characterId, ch.id))) {
        const [nv] = await tx
          .insert(characterVersions)
          .values({
            ...v,
            id: undefined,
            characterId: nc!.id,
            parentVersionId: null,
            createdAt: undefined,
            updatedAt: undefined,
          })
          .returning();
        ids.set(v.id, nv!.id);
      }
      await tx
        .update(characters)
        .set({ currentVersionId: map(ch.currentVersionId) })
        .where(eq(characters.id, nc!.id));
      const aliases = await tx.select().from(characterAliases).where(eq(characterAliases.characterId, ch.id));
      if (aliases.length)
        await tx.insert(characterAliases).values(aliases.map((a) => ({ characterId: nc!.id, alias: a.alias })));
      for (const o of await tx.select().from(characterOutfits).where(eq(characterOutfits.characterId, ch.id))) {
        const [no] = await tx
          .insert(characterOutfits)
          .values({
            ...o,
            id: undefined,
            characterId: nc!.id,
            characterVersionId: map(o.characterVersionId),
            createdAt: undefined,
          })
          .returning();
        ids.set(o.id, no!.id);
      }
    }

    for (const l of await tx
      .select()
      .from(locations)
      .where(and(eq(locations.projectId, projectId), isNull(locations.deletedAt)))) {
      const [nl] = await tx
        .insert(locations)
        .values({
          ...l,
          id: undefined,
          projectId: np,
          currentVersionId: null,
          createdAt: undefined,
          updatedAt: undefined,
        })
        .returning();
      for (const v of await tx.select().from(locationVersions).where(eq(locationVersions.locationId, l.id))) {
        const [nv] = await tx
          .insert(locationVersions)
          .values({
            ...v,
            id: undefined,
            locationId: nl!.id,
            parentVersionId: null,
            createdAt: undefined,
            updatedAt: undefined,
          })
          .returning();
        ids.set(v.id, nv!.id);
      }
      ids.set(l.id, nl!.id);
      await tx
        .update(locations)
        .set({ currentVersionId: map(l.currentVersionId) })
        .where(eq(locations.id, nl!.id));
    }

    for (const pr of await tx
      .select()
      .from(props)
      .where(and(eq(props.projectId, projectId), isNull(props.deletedAt)))) {
      const [npr] = await tx
        .insert(props)
        .values({
          ...pr,
          id: undefined,
          projectId: np,
          currentVersionId: null,
          createdAt: undefined,
          updatedAt: undefined,
        })
        .returning();
      for (const v of await tx.select().from(propVersions).where(eq(propVersions.propId, pr.id))) {
        const [nv] = await tx
          .insert(propVersions)
          .values({
            ...v,
            id: undefined,
            propId: npr!.id,
            parentVersionId: null,
            createdAt: undefined,
            updatedAt: undefined,
          })
          .returning();
        ids.set(v.id, nv!.id);
      }
      ids.set(pr.id, npr!.id);
      await tx
        .update(props)
        .set({ currentVersionId: map(pr.currentVersionId) })
        .where(eq(props.id, npr!.id));
    }

    for (const r of await tx.select().from(referenceAssets).where(eq(referenceAssets.projectId, projectId))) {
      const na = await copyAsset(r.assetId);
      if (!na) continue;
      await tx.insert(referenceAssets).values({
        ...r,
        id: undefined,
        projectId: np,
        assetId: na,
        characterVersionId: map(r.characterVersionId),
        locationVersionId: map(r.locationVersionId),
        propVersionId: map(r.propVersionId),
        projectStyleId: map(r.projectStyleId),
        outfitId: map(r.outfitId),
        createdAt: undefined,
      });
    }

    for (const ch of await tx.select().from(chapters).where(eq(chapters.projectId, projectId))) {
      const [nch] = await tx
        .insert(chapters)
        .values({
          ...ch,
          id: undefined,
          projectId: np,
          storyAnalysisId: null,
          createdAt: undefined,
          updatedAt: undefined,
        })
        .returning();
      ids.set(ch.id, nch!.id);
      for (const sc of await tx.select().from(scenes).where(eq(scenes.chapterId, ch.id))) {
        const [ns] = await tx
          .insert(scenes)
          .values({
            ...sc,
            id: undefined,
            projectId: np,
            chapterId: nch!.id,
            locationId: map(sc.locationId),
            characterIds: mapArr(sc.characterIds),
            createdAt: undefined,
            updatedAt: undefined,
          })
          .returning();
        ids.set(sc.id, ns!.id);
        const beats = await tx.select().from(storyBeats).where(eq(storyBeats.sceneId, sc.id));
        if (beats.length)
          await tx
            .insert(storyBeats)
            .values(beats.map((b) => ({ ...b, id: undefined, projectId: np, sceneId: ns!.id, createdAt: undefined })));
      }
      for (const pg of await tx.select().from(pages).where(eq(pages.chapterId, ch.id))) {
        const [npg] = await tx
          .insert(pages)
          .values({
            ...pg,
            id: undefined,
            projectId: np,
            chapterId: nch!.id,
            sceneId: map(pg.sceneId),
            createdAt: undefined,
            updatedAt: undefined,
          })
          .returning();
        ids.set(pg.id, npg!.id);
        for (const pn of await tx.select().from(panels).where(eq(panels.pageId, pg.id))) {
          const art = await copyAsset(pn.activeArtworkAssetId);
          const [npn] = await tx
            .insert(panels)
            .values({
              ...pn,
              id: undefined,
              projectId: np,
              pageId: npg!.id,
              sceneId: map(pn.sceneId),
              locationVersionId: map(pn.locationVersionId),
              characterVersionIds: mapArr(pn.characterVersionIds),
              propVersionIds: mapArr(pn.propVersionIds),
              activeArtworkAssetId: art,
              status: art
                ? "ready"
                : pn.status === "ready"
                  ? "planned"
                  : pn.status === "queued" || pn.status === "generating"
                    ? "planned"
                    : pn.status,
              createdAt: undefined,
              updatedAt: undefined,
            })
            .returning();
          ids.set(pn.id, npn!.id);
        }
        await copyPageChildren(tx, pg.id, npg!.id, np, ids);
      }
    }
    for (const nl of await tx.select().from(narrationLines).where(eq(narrationLines.projectId, projectId))) {
      const chapterId = ids.get(nl.chapterId);
      if (!chapterId) continue;
      const [nn] = await tx
        .insert(narrationLines)
        .values({
          ...nl,
          id: undefined,
          projectId: np,
          chapterId,
          pageId: map(nl.pageId),
          panelId: map(nl.panelId),
          video: nl.video && { ...nl.video, untilPanelId: map(nl.video.untilPanelId) },
          createdAt: undefined,
          updatedAt: undefined,
        })
        .returning();
      const segs = await tx.select().from(narrationSegments).where(eq(narrationSegments.narrationLineId, nl.id));
      if (segs.length)
        await tx.insert(narrationSegments).values(
          segs.map((s) => ({
            ...s,
            id: undefined,
            projectId: np,
            narrationLineId: nn!.id,
            activeAudioAssetId: null,
            createdAt: undefined,
            updatedAt: undefined,
          })),
        );
    }
    // panel specs reference character/location ids inside JSON
    const newPanelIds = [...ids.entries()].filter(([, v]) => v).map(([, v]) => v);
    const specsSrc = await tx
      .select()
      .from(panelSpecs)
      .where(inArray(panelSpecs.panelId, [...ids.keys()]));
    for (const s of specsSrc) {
      const panelId = ids.get(s.panelId);
      if (!panelId || !newPanelIds.includes(panelId)) continue;
      const spec = {
        ...s.spec,
        characters: s.spec.characters.map((c) => ({ ...c, characterId: ids.get(c.characterId) ?? c.characterId })),
        locationId: s.spec.locationId ? (ids.get(s.spec.locationId) ?? s.spec.locationId) : undefined,
        dialogueIds: mapArr(s.spec.dialogueIds),
        narrationIds: mapArr(s.spec.narrationIds),
        sfxIds: mapArr(s.spec.sfxIds),
        propIds: mapArr(s.spec.propIds),
      };
      await tx.insert(panelSpecs).values({ panelId, versionNumber: s.versionNumber, spec, source: s.source });
    }
    const style = map(src.currentStyleId);
    const cover = await copyAsset(src.coverAssetId);
    await tx.update(projects).set({ currentStyleId: style, coverAssetId: cover }).where(eq(projects.id, np));
    return p!;
  });
}

async function copyPageChildren(tx: Tx, pageId: string, newPageId: string, np: string, ids: Map<string, string>) {
  for (const d of await tx.select().from(dialogueLines).where(eq(dialogueLines.pageId, pageId))) {
    const [nd] = await tx
      .insert(dialogueLines)
      .values({
        ...d,
        id: undefined,
        projectId: np,
        pageId: newPageId,
        panelId: d.panelId ? (ids.get(d.panelId) ?? null) : null,
        characterId: d.characterId ? (ids.get(d.characterId) ?? null) : null,
        createdAt: undefined,
        updatedAt: undefined,
      })
      .returning();
    ids.set(d.id, nd!.id);
  }
  for (const s of await tx.select().from(soundEffects).where(eq(soundEffects.pageId, pageId))) {
    const [ns] = await tx
      .insert(soundEffects)
      .values({
        ...s,
        id: undefined,
        projectId: np,
        pageId: newPageId,
        panelId: s.panelId ? (ids.get(s.panelId) ?? null) : null,
        createdAt: undefined,
        updatedAt: undefined,
      })
      .returning();
    ids.set(s.id, ns!.id);
  }
}
