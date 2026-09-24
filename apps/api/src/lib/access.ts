import {
  and,
  chapters,
  characters,
  characterVersions,
  type DbOrTx,
  eq,
  locations,
  locationVersions,
  pages,
  panels,
  projectMembers,
  projects,
  props,
  propVersions,
  scenes,
} from "@openmanga/db";
import { canPerform, type ProjectAction } from "@openmanga/domain";
import type { Context } from "hono";
import type { AppEnv } from "../context.ts";
import { serviceMayAccess } from "../mcp/context.ts";
import { ApiError, forbidden, notFound, user } from "./http.ts";

export type ProjectRecord = typeof projects.$inferSelect;

/** Authorization gate for everything project-scoped. Non-members get 404 to avoid leaking existence. */
export async function projectAccess(
  c: Context<AppEnv>,
  projectId: string,
  action: ProjectAction,
): Promise<ProjectRecord> {
  const u = user(c);
  const db = c.get("deps").db;
  const [row] = await db
    .select({ project: projects, role: projectMembers.role })
    .from(projects)
    .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, u.id)))
    .where(eq(projects.id, projectId));
  if (!row) throw notFound("Project");
  const role = row.role ?? (row.project.ownerUserId === u.id ? "owner" : null);
  const service = c.get("service");
  if (service) {
    // An agent acts only in the user's own projects: an admin's bypass of membership is not extended to it.
    if (!role) throw notFound("Project");
    if (!serviceMayAccess(service, projectId))
      throw new ApiError(403, "project_not_granted", "This connection has not been granted access to this project");
  }
  if (!role && u.role !== "admin") throw notFound("Project");
  if (!canPerform(u, role, action)) throw role ? forbidden() : notFound("Project");
  if (row.project.deletedAt && action !== "read" && action !== "delete" && action !== "manage") throw forbidden();
  return row.project;
}

async function projectIdOf(db: DbOrTx, kind: string, id: string): Promise<string | null> {
  switch (kind) {
    case "chapter":
      return (await db.select({ p: chapters.projectId }).from(chapters).where(eq(chapters.id, id)))[0]?.p ?? null;
    case "scene":
      return (await db.select({ p: scenes.projectId }).from(scenes).where(eq(scenes.id, id)))[0]?.p ?? null;
    case "page":
      return (await db.select({ p: pages.projectId }).from(pages).where(eq(pages.id, id)))[0]?.p ?? null;
    case "panel":
      return (await db.select({ p: panels.projectId }).from(panels).where(eq(panels.id, id)))[0]?.p ?? null;
    case "character":
      return (await db.select({ p: characters.projectId }).from(characters).where(eq(characters.id, id)))[0]?.p ?? null;
    case "character_version":
      return (
        (
          await db
            .select({ p: characters.projectId })
            .from(characterVersions)
            .innerJoin(characters, eq(characters.id, characterVersions.characterId))
            .where(eq(characterVersions.id, id))
        )[0]?.p ?? null
      );
    case "location":
      return (await db.select({ p: locations.projectId }).from(locations).where(eq(locations.id, id)))[0]?.p ?? null;
    case "location_version":
      return (
        (
          await db
            .select({ p: locations.projectId })
            .from(locationVersions)
            .innerJoin(locations, eq(locations.id, locationVersions.locationId))
            .where(eq(locationVersions.id, id))
        )[0]?.p ?? null
      );
    case "prop":
      return (await db.select({ p: props.projectId }).from(props).where(eq(props.id, id)))[0]?.p ?? null;
    case "prop_version":
      return (
        (
          await db
            .select({ p: props.projectId })
            .from(propVersions)
            .innerJoin(props, eq(props.id, propVersions.propId))
            .where(eq(propVersions.id, id))
        )[0]?.p ?? null
      );
    default:
      return null;
  }
}

export async function entityAccess(
  c: Context<AppEnv>,
  kind:
    | "chapter"
    | "scene"
    | "page"
    | "panel"
    | "character"
    | "character_version"
    | "location"
    | "location_version"
    | "prop"
    | "prop_version",
  id: string,
  action: ProjectAction,
) {
  const pid = await projectIdOf(c.get("deps").db, kind, id);
  if (!pid) throw notFound();
  return projectAccess(c, pid, action);
}
