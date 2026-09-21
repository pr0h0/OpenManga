import {
  and,
  assets,
  assetVariants,
  auditEvents,
  chapters,
  characterAliases,
  characters,
  desc,
  dialogueLines,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  locations,
  pages,
  panels,
  projectMembers,
  projectStyles,
  projects,
  props,
  sql,
  storyRevisions,
  stylePresets,
} from "@openmanga/db";
import { asPatch, FILM_PAGE, ProjectFormat, ProjectSettings } from "@openmanga/schemas";
import { recordAudit, UNPRICED_USAGE } from "@openmanga/services";
import { sha256Hex } from "@openmanga/storage";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { duplicateProject } from "../lib/duplicate.ts";
import { badRequest, body, conflict, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { usageSummary } from "./usage.ts";

export const projectRoutes = new Hono<AppEnv>();

const ProjectType = z.enum(["manga", "manhwa", "webtoon", "comic", "illustrated_story"]);
const ReadingDirection = z.enum(["ltr", "rtl", "vertical"]);
const ColorMode = z.enum(["full_color", "grayscale", "bw_manga"]);

const CreateProject = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().max(5000).default(""),
  projectType: ProjectType.default("manhwa"),
  language: z.string().trim().min(2).max(16).default("en"),
  readingDirection: ReadingDirection.optional(),
  colorMode: ColorMode.default("full_color"),
  stylePresetKey: z.string().max(64).optional(),
  customStyle: z.string().max(4000).default(""),
  /** "film": one full-frame 16:9 shot per page, planned as a shot list and exported as a Ken Burns video. */
  format: ProjectFormat.default("comic"),
  story: z
    .object({
      content: z.string().min(1).max(500_000),
      inputKind: z.enum(["story", "chapter", "outline", "screenplay", "idea"]).default("story"),
      title: z.string().max(200).default(""),
    })
    .optional(),
});

const UpdateProject = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  projectType: ProjectType.optional(),
  language: z.string().trim().min(2).max(16).optional(),
  readingDirection: ReadingDirection.optional(),
  colorMode: ColorMode.optional(),
  settings: asPatch(ProjectSettings).optional(),
});

const ListQuery = z.object({ status: z.enum(["active", "archived", "trash", "all"]).default("active") });

doc({
  method: "GET",
  path: "/api/projects",
  summary: "Dashboard: list projects with stats",
  tag: "projects",
  query: ListQuery,
});
projectRoutes.get("/", async (c) => {
  const u = user(c);
  const { db } = c.get("deps");
  const { status } = query(c, ListQuery);
  const memberOf = db
    .select({ id: projectMembers.projectId })
    .from(projectMembers)
    .where(eq(projectMembers.userId, u.id));
  const where = and(
    inArray(projects.id, memberOf),
    status === "trash"
      ? isNotNull(projects.deletedAt)
      : status === "all"
        ? undefined
        : and(isNull(projects.deletedAt), eq(projects.status, status)),
  );
  const rows = await db.select().from(projects).where(where).orderBy(desc(projects.updatedAt)).limit(200);
  const ids = rows.map((r) => r.id);
  if (!ids.length) return c.json({ projects: [] });
  const stats = await db.execute<{
    id: string;
    chapters: number;
    panels: number;
    generations: number;
    spend: string;
    thumb: string | null;
  }>(sql`
    select p.id,
      (select count(*)::int from chapters ch where ch.project_id = p.id) as chapters,
      (select count(*)::int from panels pn where pn.project_id = p.id) as panels,
      (select count(*)::int from generation_jobs g where g.project_id = p.id) as generations,
      (select coalesce(sum(u.estimated_cost_usd),0)::text from ai_usage u where u.project_id = p.id) as spend,
      coalesce(p.cover_asset_id, (select pn.active_artwork_asset_id from panels pn where pn.project_id = p.id and pn.active_artwork_asset_id is not null order by pn.updated_at desc limit 1),
        (select ra.asset_id from reference_assets ra where ra.project_id = p.id order by ra.created_at desc limit 1)) as thumb
    from projects p where p.id in ${sql`(${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    )})`}`);
  const byId = new Map([...stats].map((s) => [s.id, s]));
  return c.json({
    projects: rows.map((p) => {
      const s = byId.get(p.id);
      return {
        ...p,
        stats: {
          chapters: s?.chapters ?? 0,
          panels: s?.panels ?? 0,
          generations: s?.generations ?? 0,
          estimatedSpendUsd: Number(s?.spend ?? 0),
        },
        thumbnailAssetId: s?.thumb ?? null,
      };
    }),
  });
});

doc({
  method: "POST",
  path: "/api/projects",
  summary: "Create project (wizard step 1 + optional story)",
  tag: "projects",
  body: CreateProject,
});
projectRoutes.post("/", async (c) => {
  const u = user(c);
  const { db } = c.get("deps");
  const input = await body(c, CreateProject);
  const readingDirection =
    input.readingDirection ??
    (input.projectType === "manga" ? "rtl" : input.projectType === "webtoon" ? "vertical" : "ltr");
  const project = await db.transaction(async (tx) => {
    const settings = ProjectSettings.parse({
      // A cap new projects start with so a runaway batch asks first; owners can raise or clear it in settings.
      // Written here rather than as a ProjectSettings default, which would also cap projects that predate it.
      budgetUsd: 5,
      narrationVoice: c.get("deps").config.KOKORO_DEFAULT_VOICE,
      narrationSpeed: c.get("deps").config.KOKORO_DEFAULT_SPEED,
      imageQuality: c.get("deps").config.IMAGE_QUALITY === "auto" ? "low" : c.get("deps").config.IMAGE_QUALITY,
      format: input.format,
      ...(input.format === "film" ? FILM_PAGE : {}),
    });
    const [p] = await tx
      .insert(projects)
      .values({
        ownerUserId: u.id,
        title: input.title,
        description: input.description,
        projectType: input.projectType,
        language: input.language,
        readingDirection,
        colorMode: input.colorMode,
        settings,
      })
      .returning();
    await tx.insert(projectMembers).values({ projectId: p!.id, userId: u.id, role: "owner" });
    const presetKey =
      input.stylePresetKey ??
      (input.projectType === "webtoon" ? "modern-webtoon" : input.projectType === "manga" ? "shonen" : "manhwa");
    const [preset] = await tx.select().from(stylePresets).where(eq(stylePresets.key, presetKey));
    const [style] = await tx
      .insert(projectStyles)
      .values({
        projectId: p!.id,
        versionNumber: 1,
        stylePresetId: preset?.id ?? null,
        customDescription: input.customStyle,
      })
      .returning();
    await tx.update(projects).set({ currentStyleId: style!.id }).where(eq(projects.id, p!.id));
    if (input.story) {
      await tx.insert(storyRevisions).values({
        projectId: p!.id,
        revisionNumber: 1,
        source: "initial",
        inputKind: input.story.inputKind,
        title: input.story.title,
        content: input.story.content,
        contentSha256: sha256Hex(input.story.content),
        createdByUserId: u.id,
      });
    }
    return { ...p!, currentStyleId: style!.id };
  });
  await recordAudit(db, {
    userId: u.id,
    projectId: project.id,
    action: "project.create",
    requestId: c.get("requestId"),
  });
  return c.json({ project }, 201);
});

doc({ method: "GET", path: "/api/projects/:projectId", summary: "Project overview", tag: "projects" });
projectRoutes.get("/:projectId", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { db } = c.get("deps");
  const [counts] = await db.execute<Record<string, number>>(sql`select
    (select count(*)::int from chapters where project_id = ${p.id}) as chapters,
    (select count(*)::int from pages where project_id = ${p.id}) as pages,
    (select count(*)::int from panels where project_id = ${p.id}) as panels,
    (select count(*)::int from panels where project_id = ${p.id} and active_artwork_asset_id is not null) as "panelsWithArt",
    (select count(*)::int from characters where project_id = ${p.id} and deleted_at is null) as characters,
    (select count(*)::int from locations where project_id = ${p.id} and deleted_at is null) as locations,
    (select count(*)::int from props where project_id = ${p.id} and deleted_at is null) as props,
    (select count(*)::int from story_revisions where project_id = ${p.id}) as "storyRevisions",
    (select count(*)::int from generation_jobs where project_id = ${p.id}) as generations,
    (select count(*)::int from generation_jobs where project_id = ${p.id} and status in ('queued','submitted','processing')) as "activeJobs",
    (select count(*)::int from narration_segments where project_id = ${p.id}) as "narrationSegments",
    (select coalesce(sum(estimated_cost_usd),0)::float from ai_usage where project_id = ${p.id}) as "spendUsd",
    (select count(*)::int from ai_usage where project_id = ${p.id} and ${UNPRICED_USAGE}) as "unpricedCalls"`);
  const [membership] = await db
    .select()
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, p.id), eq(projectMembers.userId, user(c).id)));
  const [style] = p.currentStyleId
    ? await db
        .select({ s: projectStyles, preset: stylePresets })
        .from(projectStyles)
        .leftJoin(stylePresets, eq(stylePresets.id, projectStyles.stylePresetId))
        .where(eq(projectStyles.id, p.currentStyleId))
    : [];
  return c.json({
    project: p,
    counts,
    role: membership?.role ?? (user(c).role === "admin" ? "admin" : null),
    style: style ? { ...style.s, preset: style.preset } : null,
  });
});

doc({
  method: "PATCH",
  path: "/api/projects/:projectId",
  summary: "Update project fields and settings",
  tag: "projects",
  body: UpdateProject,
});
projectRoutes.patch("/:projectId", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, UpdateProject);
  const settings = input.settings ? ProjectSettings.parse({ ...p.settings, ...input.settings }) : p.settings;
  if (settings.format !== p.settings.format) {
    const [page] = await c
      .get("deps")
      .db.select({ id: pages.id })
      .from(pages)
      .where(eq(pages.projectId, p.id))
      .limit(1);
    if (page)
      throw conflict(
        "The project format can't change once pages exist: comic panels and 16:9 shots need different plans and artwork. Create a new project instead.",
      );
    if (settings.format === "film") Object.assign(settings, FILM_PAGE);
  }
  const [row] = await c
    .get("deps")
    .db.update(projects)
    .set({ ...input, settings })
    .where(eq(projects.id, p.id))
    .returning();
  return c.json({ project: row });
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/duplicate",
  summary: "Duplicate project (deep copy)",
  tag: "projects",
});
projectRoutes.post("/:projectId/duplicate", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const deps = c.get("deps");
  const copy = await duplicateProject(deps.db, deps.assets, p.id, user(c).id);
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: copy.id,
    action: "project.duplicate",
    metadata: { from: p.id },
    requestId: c.get("requestId"),
  });
  return c.json({ project: copy }, 201);
});

const StatusInput = z.object({ action: z.enum(["archive", "unarchive", "trash", "restore"]) });
doc({
  method: "POST",
  path: "/api/projects/:projectId/status",
  summary: "Archive / unarchive / move to trash / restore",
  tag: "projects",
  body: StatusInput,
});
projectRoutes.post("/:projectId/status", async (c) => {
  const { action } = await body(c, StatusInput);
  const p = await projectAccess(
    c,
    uuidParam(c, "projectId"),
    action === "trash" || action === "restore" ? "delete" : "manage",
  );
  const set =
    action === "archive"
      ? { status: "archived" as const }
      : action === "unarchive"
        ? { status: "active" as const }
        : action === "trash"
          ? { deletedAt: new Date() }
          : { deletedAt: null };
  const [row] = await c.get("deps").db.update(projects).set(set).where(eq(projects.id, p.id)).returning();
  await recordAudit(c.get("deps").db, {
    userId: user(c).id,
    projectId: p.id,
    action: `project.${action}`,
    requestId: c.get("requestId"),
  });
  return c.json({ project: row });
});

doc({
  method: "DELETE",
  path: "/api/projects/:projectId",
  summary: "Permanently delete a trashed project and its files",
  tag: "projects",
});
projectRoutes.delete("/:projectId", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "delete");
  if (!p.deletedAt) throw badRequest("Move the project to trash before deleting it permanently");
  const deps = c.get("deps");
  // Both levels, collected before the rows go: a derivative's key lives on asset_variants, which cascades away
  // with the asset, so deleting only assets.storage_key left every thumbnail and prompt reference on disk with
  // nothing left in the database to find it by. One project's worth measured 1.2 GB of unreachable files.
  const files = await deps.db.select({ key: assets.storageKey }).from(assets).where(eq(assets.projectId, p.id));
  const derivatives = await deps.db
    .select({ key: assetVariants.storageKey })
    .from(assetVariants)
    .innerJoin(assets, eq(assets.id, assetVariants.assetId))
    .where(eq(assets.projectId, p.id));
  await deps.db.delete(projects).where(eq(projects.id, p.id));
  for (const { key } of [...files, ...derivatives]) await deps.assets.storage.delete(key).catch(() => {});
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "project.delete_permanent",
    metadata: { title: p.title, files: files.length, derivatives: derivatives.length },
    requestId: c.get("requestId"),
  });
  return c.json({ ok: true });
});

const SearchQuery = z.object({ q: z.string().trim().min(1).max(100) });
doc({
  method: "GET",
  path: "/api/projects/:projectId/search",
  summary: "Project-local search",
  tag: "projects",
  query: SearchQuery,
});
projectRoutes.get("/:projectId/search", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { q } = query(c, SearchQuery);
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const { db } = c.get("deps");
  const [chars, aliasHits, locs, prps, chaps, pans, dlg] = await Promise.all([
    db
      .select({ id: characters.id, name: characters.name, role: characters.role })
      .from(characters)
      .where(and(eq(characters.projectId, p.id), isNull(characters.deletedAt), ilike(characters.name, like)))
      .limit(20),
    db
      .select({ id: characters.id, name: characters.name, alias: characterAliases.alias })
      .from(characterAliases)
      .innerJoin(characters, eq(characters.id, characterAliases.characterId))
      .where(and(eq(characters.projectId, p.id), ilike(characterAliases.alias, like)))
      .limit(20),
    db
      .select({ id: locations.id, name: locations.name })
      .from(locations)
      .where(and(eq(locations.projectId, p.id), isNull(locations.deletedAt), ilike(locations.name, like)))
      .limit(20),
    db
      .select({ id: props.id, name: props.name })
      .from(props)
      .where(and(eq(props.projectId, p.id), isNull(props.deletedAt), ilike(props.name, like)))
      .limit(20),
    db
      .select({ id: chapters.id, title: chapters.title, order: chapters.order })
      .from(chapters)
      .where(
        and(eq(chapters.projectId, p.id), sql`(${chapters.title} ilike ${like} or ${chapters.summary} ilike ${like})`),
      )
      .limit(20),
    db
      .select({
        id: panels.id,
        pageId: panels.pageId,
        storyBeat: panels.storyBeat,
        chapterId: pages.chapterId,
        pageOrder: pages.order,
        order: panels.order,
      })
      .from(panels)
      .innerJoin(pages, eq(pages.id, panels.pageId))
      .where(and(eq(panels.projectId, p.id), ilike(panels.storyBeat, like)))
      .limit(20),
    db
      .select({
        id: dialogueLines.id,
        text: dialogueLines.text,
        pageId: dialogueLines.pageId,
        panelId: dialogueLines.panelId,
        chapterId: pages.chapterId,
        pageOrder: pages.order,
      })
      .from(dialogueLines)
      .innerJoin(pages, eq(pages.id, dialogueLines.pageId))
      .where(and(eq(dialogueLines.projectId, p.id), ilike(dialogueLines.text, like)))
      .limit(20),
  ]);
  const charMap = new Map(chars.map((ch) => [ch.id, ch]));
  for (const a of aliasHits)
    if (!charMap.has(a.id)) charMap.set(a.id, { id: a.id, name: `${a.name} (alias: ${a.alias})`, role: "supporting" });
  return c.json({
    characters: [...charMap.values()],
    locations: locs,
    props: prps,
    chapters: chaps,
    panels: pans,
    dialogue: dlg,
  });
});

doc({ method: "GET", path: "/api/projects/:projectId/usage", summary: "Project cost/usage breakdown", tag: "usage" });
projectRoutes.get("/:projectId/usage", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  return c.json(await usageSummary(c.get("deps").db, p.id));
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/audit",
  summary: "Recent audit events for project",
  tag: "projects",
});
projectRoutes.get("/:projectId/audit", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const rows = await c
    .get("deps")
    .db.select()
    .from(auditEvents)
    .where(eq(auditEvents.projectId, p.id))
    .orderBy(desc(auditEvents.createdAt))
    .limit(100);
  return c.json({ events: rows });
});
