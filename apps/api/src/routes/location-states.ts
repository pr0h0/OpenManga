import { and, asc, chapters, type DbOrTx, eq, inArray, locationStates, scenes } from "@openmanga/db";
import { asPatch } from "@openmanga/schemas";
import { statesOf } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess, projectAccess } from "../lib/access.ts";
import { badRequest, body, notFound, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * States of a place over story time ("destroyed", "snowed in", "at night"). A scene picks one by hand, or by its time
 * and weather matching a state's keywords, or by its chapter falling in a state's range; panels there are drawn from
 * the state's description and its own reference image.
 */
export const locationStateRoutes = new Hono<AppEnv>();

const Uuid = z.string().uuid();
export const StateInput = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(""),
  keywords: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
  fromChapterId: Uuid.nullable().default(null),
  untilChapterId: Uuid.nullable().default(null),
});
export const StatePatch = asPatch(StateInput);

async function checkRange(db: DbOrTx, projectId: string, from?: string | null, until?: string | null) {
  const ids = [from, until].filter((x): x is string => Boolean(x));
  if (!ids.length) return;
  const rows = await db
    .select({ id: chapters.id, order: chapters.order })
    .from(chapters)
    .where(and(eq(chapters.projectId, projectId), inArray(chapters.id, ids)));
  if (rows.length !== new Set(ids).size) throw badRequest("A chapter is not in this project");
  const o = (id?: string | null) => rows.find((r) => r.id === id)?.order;
  if (from && until && o(from)! > o(until)!) throw badRequest("The range ends before it starts");
}

doc({
  method: "GET",
  path: "/api/locations/:id/states",
  summary:
    "A location's states over story time, each with its keywords (matched against a scene's time and weather) and chapter range, and the scenes that pick it by hand.",
  tag: "world",
});
locationStateRoutes.get("/locations/:id/states", async (c) => {
  const id = uuidParam(c, "id");
  await entityAccess(c, "location", id, "read");
  const { db } = c.get("deps");
  const states = await statesOf(db, id);
  const picked = states.length
    ? await db
        .select({ id: scenes.id, title: scenes.title, locationStateId: scenes.locationStateId })
        .from(scenes)
        .where(
          inArray(
            scenes.locationStateId,
            states.map((s) => s.state.id),
          ),
        )
        .orderBy(asc(scenes.order))
    : [];
  return c.json({
    states: states.map((s) => ({
      ...s.state,
      scenes: picked.filter((p) => p.locationStateId === s.state.id).map((p) => ({ id: p.id, title: p.title })),
    })),
  });
});

doc({
  method: "POST",
  path: "/api/locations/:id/states",
  summary:
    'Add a state of the place: a name, what differs from its design, keywords for scene time and weather ("night", "snow"), and/or a chapter range. A state with neither is only picked by hand on a scene.',
  tag: "world",
  body: StateInput,
});
locationStateRoutes.post("/locations/:id/states", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "location", id, "write");
  const input = await body(c, StateInput);
  const { db } = c.get("deps");
  await checkRange(db, p.id, input.fromChapterId, input.untilChapterId);
  if ((await statesOf(db, id)).length >= 30) throw badRequest("A location has at most 30 states");
  const [row] = await db
    .insert(locationStates)
    .values({ ...input, projectId: p.id, locationId: id })
    .returning();
  return c.json({ state: row }, 201);
});

async function stateFor(c: Parameters<typeof projectAccess>[0], id: string) {
  const [row] = await c.get("deps").db.select().from(locationStates).where(eq(locationStates.id, id));
  if (!row) throw notFound("Location state");
  return { row, project: await projectAccess(c, row.projectId, "write") };
}

doc({
  method: "PATCH",
  path: "/api/location-states/:id",
  summary: "Edit a location state",
  tag: "world",
  body: StatePatch,
});
locationStateRoutes.patch("/location-states/:id", async (c) => {
  const { row, project } = await stateFor(c, uuidParam(c, "id"));
  const input = await body(c, StatePatch);
  const { db } = c.get("deps");
  await checkRange(
    db,
    project.id,
    input.fromChapterId === undefined ? row.fromChapterId : input.fromChapterId,
    input.untilChapterId === undefined ? row.untilChapterId : input.untilChapterId,
  );
  const [next] = await db
    .update(locationStates)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(locationStates.id, row.id))
    .returning();
  return c.json({ state: next });
});

doc({
  method: "DELETE",
  path: "/api/location-states/:id",
  summary:
    "Delete a location state, with its reference images; scenes that picked it go back to picking by time, weather and chapter.",
  tag: "world",
});
locationStateRoutes.delete("/location-states/:id", async (c) => {
  const { row } = await stateFor(c, uuidParam(c, "id"));
  await c.get("deps").db.delete(locationStates).where(eq(locationStates.id, row.id));
  return c.json({ ok: true });
});
