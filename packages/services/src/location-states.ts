import {
  and,
  assets,
  chapters,
  type DbOrTx,
  desc,
  eq,
  inArray,
  isNull,
  locationStates,
  referenceAssets,
  scenes,
  sql,
} from "@openmanga/db";
import { pickLocationState } from "@openmanga/domain";

/** A place's states with their chapter range resolved to the chapters' current order. */
export async function statesOf(db: DbOrTx, locationId: string) {
  const order = (col: "from_chapter_id" | "until_chapter_id") =>
    sql<number | null>`(select c."order" from chapters c where c.id = ${sql.raw(`"location_states"."${col}"`)})`;
  return db
    .select({
      state: locationStates,
      from: order("from_chapter_id"),
      until: order("until_chapter_id"),
    })
    .from(locationStates)
    .where(eq(locationStates.locationId, locationId))
    .orderBy(locationStates.createdAt);
}

/** The state of `locationId` a scene shows (see `pickLocationState`), or null for the place as designed. */
export async function sceneLocationState(db: DbOrTx, locationId: string, sceneId: string | null) {
  const states = await statesOf(db, locationId);
  if (!states.length) return null;
  const [scene] = sceneId
    ? await db
        .select({
          time: scenes.time,
          weather: scenes.weather,
          locationStateId: scenes.locationStateId,
          chapter: chapters.order,
        })
        .from(scenes)
        .innerJoin(chapters, eq(chapters.id, scenes.chapterId))
        .where(eq(scenes.id, sceneId))
    : [];
  const id = pickLocationState(
    states.map((s) => ({ id: s.state.id, keywords: s.state.keywords, from: s.from, until: s.until })),
    {
      chapter: scene?.chapter ?? null,
      time: scene?.time ?? "",
      weather: scene?.weather ?? "",
      explicit: scene?.locationStateId ?? null,
    },
  );
  return states.find((s) => s.state.id === id)?.state ?? null;
}

/** The approved reference of a place's state: of this version of the place first, else of any. */
export async function stateReference(db: DbOrTx, stateId: string, locationVersionId: string) {
  const rows = await db
    .select({ ref: referenceAssets, asset: assets })
    .from(referenceAssets)
    .innerJoin(assets, eq(assets.id, referenceAssets.assetId))
    .where(
      and(
        eq(referenceAssets.locationStateId, stateId),
        inArray(referenceAssets.status, ["approved", "locked"]),
        isNull(assets.deletedAt),
      ),
    )
    .orderBy(desc(referenceAssets.isPrimary), desc(referenceAssets.createdAt));
  const pick = rows.find((r) => r.ref.locationVersionId === locationVersionId) ?? rows[0];
  return pick ? { ...pick.asset, referenceKind: pick.ref.kind } : null;
}
