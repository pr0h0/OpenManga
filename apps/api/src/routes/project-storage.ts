import { eq, projects } from "@openmanga/db";
import { ProjectStorage } from "@openmanga/schemas";
import {
  applyStoragePlan,
  pendingSummary,
  planStorage,
  projectRetention,
  projectStorageUse,
  recordAudit,
  storageCandidates,
} from "@openmanga/services";
import { Hono } from "hono";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { body, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * A project's own storage policy and cap (its owner's): ages per kind of expendable file and a size the project
 * stays under. Maintenance applies it hourly; the owner can apply it now.
 */
export const projectStorageRoutes = new Hono<AppEnv>();

type Deps = AppEnv["Variables"]["deps"];

/** The policy, what the project stores, what it may delete by kind, and what the policy would delete now. */
async function view(deps: Deps, projectId: string, s: ProjectStorage | undefined) {
  const { candidates } = await storageCandidates(deps.db, projectId);
  const expendable: Record<string, { files: number; bytes: number }> = {};
  for (const c of candidates) {
    const k = expendable[c.kind] ?? { files: 0, bytes: 0 };
    k.files++;
    k.bytes += c.bytes;
    expendable[c.kind] = k;
  }
  const plan = await planStorage(deps.db, projectRetention(s), new Date(), projectId);
  return {
    policy: s ?? ProjectStorage.parse({}),
    use: await projectStorageUse(deps.db, projectId, s),
    expendable,
    preview: plan ? pendingSummary(plan) : null,
  };
}

doc({
  method: "GET",
  path: "/api/projects/:projectId/storage",
  summary:
    "The project's storage policy and cap, the bytes it stores (and whether that is over the cap), what may be deleted by kind (cached video sections, exports, older panel versions, unused narration takes, trash, prompt reference copies), and a dry run of what the policy would delete now.",
  tag: "projects",
});
projectStorageRoutes.get("/projects/:projectId/storage", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  return c.json(await view(c.get("deps"), p.id, p.settings.storage));
});

doc({
  method: "PUT",
  path: "/api/projects/:projectId/storage",
  summary:
    "Set the project's storage policy (owner only): expendable files older than maxAgeDays, or a kind's own age in kindAges, are deleted at each maintenance pass, then the oldest until the project is under capGb; while it is still over the cap, new AI work and exports are refused.",
  tag: "projects",
  body: ProjectStorage,
});
projectStorageRoutes.put("/projects/:projectId/storage", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "manage");
  const storage = await body(c, ProjectStorage);
  const deps = c.get("deps");
  await deps.db
    .update(projects)
    .set({ settings: { ...p.settings, storage } })
    .where(eq(projects.id, p.id));
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "project.storage_policy",
    targetType: "project",
    targetId: p.id,
    metadata: storage,
    requestId: c.get("requestId"),
  });
  return c.json(await view(deps, p.id, storage));
});

doc({
  method: "POST",
  path: "/api/projects/:projectId/storage/apply",
  summary: "Apply the project's storage policy now (owner only): deletes what the dry run lists, oldest first.",
  tag: "projects",
});
projectStorageRoutes.post("/projects/:projectId/storage/apply", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "manage");
  const deps = c.get("deps");
  const plan = await planStorage(deps.db, projectRetention(p.settings.storage), new Date(), p.id);
  const deleted = plan?.files ? await applyStoragePlan(deps.db, deps.assets, plan) : 0;
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "project.storage_apply",
    targetType: "project",
    targetId: p.id,
    metadata: { files: deleted, bytes: plan?.bytes ?? 0, byKind: plan?.byKind ?? {} },
    requestId: c.get("requestId"),
  });
  return c.json({ deleted, bytes: plan?.bytes ?? 0, ...(await view(deps, p.id, p.settings.storage)) });
});
