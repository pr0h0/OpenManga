import {
  and,
  asc,
  bibleFacts,
  characters,
  desc,
  eq,
  isNull,
  locations,
  projects,
  props,
  series,
  sql,
} from "@openmanga/db";
import { splitEpisodes } from "@openmanga/domain";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { CallError, callAs } from "../lib/production.ts";
import { episodeStaleness, syncEpisode } from "../lib/series.ts";

export const seriesRoutes = new Hono<AppEnv>();
type Ctx = Parameters<typeof uuidParam>[0];
type Project = typeof projects.$inferSelect;

/** One of the caller's own series: a series is its owner's (episodes are shared through their projects). */
async function ownSeries(c: Ctx, id: string) {
  const [s] = await c.get("deps").db.select().from(series).where(eq(series.id, id));
  if (!s || s.ownerUserId !== user(c).id) throw notFound("Series");
  return s;
}

/** Creates a project through the ordinary route (validation, preset, profile), as the caller. */
async function createProject(c: Ctx, input: Record<string, unknown>) {
  const call = await callAs(c.get("deps"), user(c));
  try {
    return (await call<{ project: Project }>("POST", "/api/projects", input)).project;
  } catch (e) {
    if (e instanceof CallError) throw conflict(e.message);
    throw e;
  }
}

const sync = (c: Ctx, s: typeof series.$inferSelect, episodeId: string) =>
  c.get("deps").db.transaction((tx) => syncEpisode(tx, s.libraryProjectId, episodeId, user(c).id));

const NewSeries = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(""),
  /** Applied to every episode made in the series (and to adopted ones when asked). */
  channelProfileId: z.string().uuid().nullable().default(null),
  projectType: z.string().max(40).optional(),
  language: z.string().trim().min(2).max(16).optional(),
  colorMode: z.string().max(40).optional(),
  readingDirection: z.string().max(10).optional(),
  format: z.string().max(20).optional(),
  stylePresetKey: z.string().max(64).optional(),
});
doc({
  method: "POST",
  path: "/api/series",
  summary:
    "Create a series: episodes that share one library of cast, places, props, style and story bible. The library is a project of its own (`libraryProjectId`), edited with the usual project pages; its type, language, colour, format and style are what new episodes start with.",
  tag: "series",
  body: NewSeries,
});
seriesRoutes.post("/series", async (c) => {
  const input = await body(c, NewSeries);
  const { channelProfileId, title, description, ...look } = input;
  const library = await createProject(c, {
    title: `${title} — library`,
    description: `The shared cast, places, props, style and story bible of the series ${title}.`,
    ...look,
    ...(channelProfileId ? { profileId: channelProfileId } : {}),
  });
  const { db } = c.get("deps");
  const [s] = await db
    .insert(series)
    .values({ ownerUserId: user(c).id, title, description, channelProfileId, libraryProjectId: library.id })
    .returning();
  await db.update(projects).set({ seriesId: s!.id, seriesRole: "library" }).where(eq(projects.id, library.id));
  return c.json({ series: s }, 201);
});

doc({ method: "GET", path: "/api/series", summary: "Your series, with their episode counts", tag: "series" });
seriesRoutes.get("/series", async (c) => {
  const rows = await c
    .get("deps")
    .db.select({
      series,
      episodes: sql<number>`(select count(*)::int from projects p where p.series_id = ${series.id} and p.series_role = 'episode' and p.deleted_at is null)`,
    })
    .from(series)
    .where(eq(series.ownerUserId, user(c).id))
    .orderBy(desc(series.updatedAt));
  return c.json({ series: rows.map((r) => ({ ...r.series, episodes: r.episodes })) });
});

async function episodesOf(c: Ctx, seriesId: string) {
  return c
    .get("deps")
    .db.select()
    .from(projects)
    .where(and(eq(projects.seriesId, seriesId), eq(projects.seriesRole, "episode"), isNull(projects.deletedAt)))
    .orderBy(asc(projects.episodeNumber));
}

doc({
  method: "GET",
  path: "/api/series/:id",
  summary:
    "The series dashboard: each episode's status, progress (chapters, panels drawn), spend, exports, open comments and how far it is behind the library (`behind`: library entities, style or facts not yet synced), with totals; and the library's counts.",
  tag: "series",
});
seriesRoutes.get("/series/:id", async (c) => {
  const s = await ownSeries(c, uuidParam(c, "id"));
  const { db } = c.get("deps");
  const eps = await episodesOf(c, s.id);
  const stats = eps.length
    ? await db.execute<{
        id: string;
        chapters: number;
        panels: number;
        drawn: number;
        spend: number;
        exports: number;
        comments: number;
      }>(sql`select p.id,
        (select count(*)::int from chapters ch where ch.project_id = p.id) as chapters,
        (select count(*)::int from panels pn where pn.project_id = p.id) as panels,
        (select count(*)::int from panels pn where pn.project_id = p.id and pn.active_artwork_asset_id is not null) as drawn,
        (select coalesce(sum(u.estimated_cost_usd), 0)::float from ai_usage u where u.project_id = p.id) as spend,
        (select count(*)::int from exports e where e.project_id = p.id) as exports,
        (select count(*)::int from panel_comments pc where pc.project_id = p.id and pc.thread_id is null
          and pc.resolved_at is null and pc.deleted_at is null) as comments
        from projects p where p.series_id = ${s.id} and p.series_role = 'episode' and p.deleted_at is null`)
    : [];
  const byId = new Map([...stats].map((r) => [r.id, r]));
  const episodes = [];
  for (const p of eps) {
    const r = byId.get(p.id);
    episodes.push({
      id: p.id,
      title: p.title,
      episodeNumber: p.episodeNumber,
      status: p.status,
      updatedAt: p.updatedAt,
      chapters: r?.chapters ?? 0,
      panels: r?.panels ?? 0,
      panelsDrawn: r?.drawn ?? 0,
      spendUsd: r?.spend ?? 0,
      exports: r?.exports ?? 0,
      openComments: r?.comments ?? 0,
      behind: await episodeStaleness(db, s.libraryProjectId, p.id),
    });
  }
  const count = async (t: typeof characters | typeof locations | typeof props) =>
    (
      await db
        .select({ n: sql<number>`count(*)::int` })
        .from(t)
        .where(and(eq(t.projectId, s.libraryProjectId), isNull(t.deletedAt)))
    )[0]?.n ?? 0;
  const [facts] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(bibleFacts)
    .where(eq(bibleFacts.projectId, s.libraryProjectId));
  return c.json({
    series: s,
    library: {
      projectId: s.libraryProjectId,
      characters: await count(characters),
      locations: await count(locations),
      props: await count(props),
      facts: facts?.n ?? 0,
    },
    episodes,
    totals: {
      episodes: episodes.length,
      panels: episodes.reduce((n, e) => n + e.panels, 0),
      panelsDrawn: episodes.reduce((n, e) => n + e.panelsDrawn, 0),
      spendUsd: episodes.reduce((n, e) => n + e.spendUsd, 0),
      exports: episodes.reduce((n, e) => n + e.exports, 0),
      openComments: episodes.reduce((n, e) => n + e.openComments, 0),
      behind: episodes.filter((e) => e.behind > 0).length,
    },
  });
});

const PatchSeries = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  channelProfileId: z.string().uuid().nullable().optional(),
});
doc({
  method: "PATCH",
  path: "/api/series/:id",
  summary: "Rename a series or change its channel profile",
  tag: "series",
  body: PatchSeries,
});
seriesRoutes.patch("/series/:id", async (c) => {
  const s = await ownSeries(c, uuidParam(c, "id"));
  const input = await body(c, PatchSeries);
  const [row] = await c.get("deps").db.update(series).set(input).where(eq(series.id, s.id)).returning();
  return c.json({ series: row });
});

doc({
  method: "DELETE",
  path: "/api/series/:id",
  summary: "Delete a series that has no episodes left (detach them first); its library project goes to the trash",
  tag: "series",
});
seriesRoutes.delete("/series/:id", async (c) => {
  const s = await ownSeries(c, uuidParam(c, "id"));
  if ((await episodesOf(c, s.id)).length) throw conflict("Detach the series' episodes first");
  const { db } = c.get("deps");
  await db
    .update(projects)
    .set({ deletedAt: new Date(), seriesId: null, seriesRole: null })
    .where(eq(projects.id, s.libraryProjectId));
  await db.delete(series).where(eq(series.id, s.id));
  return c.json({ ok: true });
});

const nextNumber = async (c: Ctx, seriesId: string) => ((await episodesOf(c, seriesId)).at(-1)?.episodeNumber ?? 0) + 1;

/** A new episode: a project shaped like the library (type, language, colour, format), with the series' profile. */
async function makeEpisode(c: Ctx, s: typeof series.$inferSelect, title: string, story?: unknown) {
  const [lib] = await c.get("deps").db.select().from(projects).where(eq(projects.id, s.libraryProjectId));
  const p = await createProject(c, {
    title,
    projectType: lib!.projectType,
    language: lib!.language,
    colorMode: lib!.colorMode,
    readingDirection: lib!.readingDirection,
    format: lib!.settings.format,
    ...(s.channelProfileId ? { profileId: s.channelProfileId } : {}),
    ...(story ? { story } : {}),
  });
  await c
    .get("deps")
    .db.update(projects)
    .set({ seriesId: s.id, seriesRole: "episode", episodeNumber: await nextNumber(c, s.id) })
    .where(eq(projects.id, p.id));
  const synced = await sync(c, s, p.id);
  return { project: { ...p, seriesId: s.id }, synced };
}

const NewEpisode = z.object({
  title: z.string().trim().min(1).max(200),
  story: z
    .object({
      content: z.string().min(1).max(500_000),
      inputKind: z.enum(["story", "chapter", "outline", "screenplay", "idea"]).default("story"),
    })
    .optional(),
});
doc({
  method: "POST",
  path: "/api/series/:id/episodes",
  summary:
    "Add a new episode: a project shaped like the library, with the series' channel profile, numbered after the last episode, and linked to every library character, location, prop, the style and the bible facts.",
  tag: "series",
  body: NewEpisode,
});
seriesRoutes.post("/series/:id/episodes", async (c) => {
  const s = await ownSeries(c, uuidParam(c, "id"));
  const input = await body(c, NewEpisode);
  return c.json(await makeEpisode(c, s, input.title, input.story), 201);
});

const Adopt = z.object({
  projectId: z.string().uuid(),
  /** Also re-apply the series' channel profile to it (its settings change; format, type and style do not). */
  applyProfile: z.boolean().default(false),
});
doc({
  method: "POST",
  path: "/api/series/:id/adopt",
  summary:
    "Adopt one of your projects as the next episode. Its characters, locations and props that share a name with the library's become linked (and take the library's version); its own others stay as they are.",
  tag: "series",
  body: Adopt,
});
seriesRoutes.post("/series/:id/adopt", async (c) => {
  const s = await ownSeries(c, uuidParam(c, "id"));
  const input = await body(c, Adopt);
  const { db } = c.get("deps");
  const [p] = await db.select().from(projects).where(eq(projects.id, input.projectId));
  if (!p || p.ownerUserId !== user(c).id || p.deletedAt) throw notFound("Project");
  if (p.seriesId) throw conflict("That project already belongs to a series");
  await db
    .update(projects)
    .set({ seriesId: s.id, seriesRole: "episode", episodeNumber: await nextNumber(c, s.id) })
    .where(eq(projects.id, p.id));
  if (input.applyProfile && s.channelProfileId) {
    const call = await callAs(c.get("deps"), user(c));
    await call("POST", `/api/projects/${p.id}/apply-profile`, { profileId: s.channelProfileId, confirm: true }).catch(
      () => null,
    );
  }
  return c.json({ synced: await sync(c, s, p.id) });
});

doc({
  method: "POST",
  path: "/api/series/:id/episodes/:projectId/detach",
  summary: "Take an episode out of the series. Its linked entities stay, as its own; they stop following the library.",
  tag: "series",
});
seriesRoutes.post("/series/:id/episodes/:projectId/detach", async (c) => {
  const s = await ownSeries(c, uuidParam(c, "id"));
  const pid = uuidParam(c, "projectId");
  const { db } = c.get("deps");
  const [p] = await db.select().from(projects).where(eq(projects.id, pid));
  if (!p || p.seriesId !== s.id || p.seriesRole !== "episode") throw notFound("Episode");
  await db.transaction(async (tx) => {
    await tx
      .update(projects)
      .set({ seriesId: null, seriesRole: null, episodeNumber: null })
      .where(eq(projects.id, pid));
    for (const t of [characters, locations, props])
      await tx.update(t).set({ sourceId: null, syncedVersionId: null }).where(eq(t.projectId, pid));
    await tx.update(bibleFacts).set({ sourceId: null }).where(eq(bibleFacts.projectId, pid));
  });
  return c.json({ ok: true });
});

const SyncInput = z.object({ projectId: z.string().uuid().optional() });
doc({
  method: "POST",
  path: "/api/series/:id/sync",
  summary:
    "Bring episodes in step with the library (all, or one `projectId`): new library entities are added, changed ones get a new version in each episode pointing at the same reference images, and the style and bible facts follow. Panels keep the versions they were drawn with until migrated.",
  tag: "series",
  body: SyncInput,
});
seriesRoutes.post("/series/:id/sync", async (c) => {
  const s = await ownSeries(c, uuidParam(c, "id"));
  const input = await body(c, SyncInput);
  const eps = (await episodesOf(c, s.id)).filter((p) => !input.projectId || p.id === input.projectId);
  if (input.projectId && !eps.length) throw notFound("Episode");
  const results = [];
  for (const p of eps) results.push({ projectId: p.id, ...(await sync(c, s, p.id)) });
  return c.json({ episodes: results });
});

const Split = z.object({
  story: z.string().min(1).max(2_000_000),
  /** Chapters per episode, when the story has chapter headings. */
  perEpisode: z.number().int().min(1).max(50).default(3),
  /** Characters per episode, when it has none. */
  charsPerEpisode: z.number().int().min(2000).max(500_000).default(20_000),
  confirm: z.boolean().default(false),
});
doc({
  method: "POST",
  path: "/api/series/:id/split",
  summary:
    "Split a long story into episodes at its chapter headings (`perEpisode` chapters each), or at paragraph breaks by size when it has none. Without confirm: the episodes it would make. With confirm: true, each becomes a new episode with its part as the story (at most 50).",
  tag: "series",
  body: Split,
});
seriesRoutes.post("/series/:id/split", async (c) => {
  const s = await ownSeries(c, uuidParam(c, "id"));
  const input = await body(c, Split);
  const parts = splitEpisodes(input.story, input);
  if (parts.length > 50) throw conflict(`That makes ${parts.length} episodes; at most 50 at a time`);
  if (parts.some((p) => p.text.length > 500_000)) throw conflict("An episode would be over 500,000 characters");
  const preview = parts.map((p) => ({ title: p.title, chapters: p.chapters, characters: p.text.length }));
  if (!input.confirm) return c.json({ episodes: preview });
  const made = [];
  for (const p of parts)
    made.push((await makeEpisode(c, s, p.title, { content: p.text, inputKind: "story" })).project.id);
  return c.json({ episodes: preview, projectIds: made }, 201);
});

const Appearances = z.object({ kind: z.enum(["character", "location", "prop"]), id: z.string().uuid() });
doc({
  method: "GET",
  path: "/api/series/:id/appearances",
  summary:
    "Every appearance of a library character, location or prop across the series: per episode, its linked entity and the panels showing it, by chapter.",
  tag: "series",
  query: Appearances,
});
seriesRoutes.get("/series/:id/appearances", async (c) => {
  const s = await ownSeries(c, uuidParam(c, "id"));
  const q = query(c, Appearances);
  const { db } = c.get("deps");
  const t = { character: characters, location: locations, prop: props }[q.kind];
  const [lib] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, q.id), eq(t.projectId, s.libraryProjectId)));
  if (!lib) throw notFound("Library entry");
  const versions = { character: "character_versions", location: "location_versions", prop: "prop_versions" }[q.kind];
  const fk = { character: "character_id", location: "location_id", prop: "prop_id" }[q.kind];
  const shows = {
    character: sql`pn.character_version_ids ? v.id::text`,
    location: sql`pn.location_version_id = v.id`,
    prop: sql`pn.prop_version_ids ? v.id::text`,
  }[q.kind];
  const rows = await db.execute<{
    project_id: string;
    entity_id: string;
    chapter_id: string;
    chapter_order: number;
    chapter_title: string;
    panels: number;
  }>(sql`
    select e.project_id, e.id as entity_id, ch.id as chapter_id, ch."order" as chapter_order, ch.title as chapter_title,
      count(distinct pn.id)::int as panels
    from ${t} e
    join projects p on p.id = e.project_id and p.series_id = ${s.id} and p.series_role = 'episode' and p.deleted_at is null
    join ${sql.raw(versions)} v on v.${sql.raw(fk)} = e.id
    join panels pn on pn.project_id = e.project_id and ${shows}
    join pages pg on pg.id = pn.page_id
    join chapters ch on ch.id = pg.chapter_id
    where e.source_id = ${lib.id} and e.deleted_at is null
    group by e.project_id, e.id, ch.id, ch."order", ch.title
    order by ch."order"`);
  const eps = await episodesOf(c, s.id);
  const linked = await db
    .select({ id: t.id, projectId: t.projectId })
    .from(t)
    .where(and(eq(t.sourceId, lib.id), isNull(t.deletedAt)));
  return c.json({
    entry: { id: lib.id, name: lib.name, kind: q.kind },
    episodes: eps
      .filter((p) => linked.some((l) => l.projectId === p.id))
      .map((p) => {
        const mine = [...rows].filter((r) => r.project_id === p.id);
        return {
          projectId: p.id,
          title: p.title,
          episodeNumber: p.episodeNumber,
          entityId: linked.find((l) => l.projectId === p.id)!.id,
          panels: mine.reduce((n, r) => n + r.panels, 0),
          chapters: mine.map((r) => ({
            id: r.chapter_id,
            order: r.chapter_order,
            title: r.chapter_title,
            panels: r.panels,
          })),
        };
      }),
  });
});
