import { and, assets, type DbOrTx, eq, isNull, projects, sql, users } from "@openmanga/db";
import { PRODUCTION_PRESETS } from "@openmanga/domain";
import {
  type ChannelProfile,
  ChannelProfileSettings,
  PROFILE_SETTING_KEYS,
  ProjectSettings,
  UserSettings,
} from "@openmanga/schemas";
import { recordAudit, rehashNarrationSegments } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { badRequest, body, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { readImageUpload } from "../lib/uploads.ts";

/**
 * Channel profiles: a publication identity one level above project templates. They live on their owner's account
 * (users.settings, like templates), so a profile is only ever found among the caller's own: another user's id is
 * simply not found. Applying one copies its settings into a project; nothing stays linked.
 */
export const channelProfileRoutes = new Hono<AppEnv>();

type Deps = AppEnv["Variables"]["deps"];
type Asset = typeof assets.$inferSelect;
const LOGO_ROLE = "profile_logo";

/** One of the caller's own profiles. */
export function ownProfile(c: Context<AppEnv>, id: string): ChannelProfile {
  const p = user(c).settings.channelProfiles?.find((x) => x.id === id);
  if (!p) throw notFound("Channel profile");
  return p;
}

async function saveProfiles(c: Context<AppEnv>, profiles: ChannelProfile[]) {
  const u = user(c);
  const settings = UserSettings.parse({ ...u.settings, channelProfiles: profiles });
  await c.get("deps").db.update(users).set({ settings }).where(eq(users.id, u.id));
}

/** A profile's logo: an image of the caller's that belongs to no project, uploaded for (or copied into) a profile. */
async function profileLogo(db: DbOrTx, userId: string, assetId: string) {
  const [a] = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.id, assetId),
        isNull(assets.projectId),
        eq(assets.ownerUserId, userId),
        isNull(assets.deletedAt),
        sql`${assets.metadata}->>'role' = ${LOGO_ROLE}`,
      ),
    );
  return a ?? null;
}

/** A new asset with the same bytes: assets are owned by one project (or, for a profile logo, by no project). */
async function copyAsset(deps: Deps, db: DbOrTx, a: Asset, to: { projectId: string | null; userId: string }) {
  return deps.assets.store(
    {
      projectId: to.projectId,
      ownerUserId: to.userId,
      type: "source_image",
      data: await deps.assets.read(a),
      mimeType: a.mimeType,
      width: a.width,
      height: a.height,
      metadata: { role: to.projectId ? "video_logo" : LOGO_ROLE, copiedFrom: a.id },
    },
    db,
  );
}

/** A preset key the caller can start from: a production preset, or "template:<id>" of one of their templates. */
function checkPreset(c: Context<AppEnv>, preset: string | null | undefined) {
  if (!preset) return;
  const ok = preset.startsWith("template:")
    ? user(c).settings.projectTemplates?.some((t) => t.id === preset.slice(9))
    : PRODUCTION_PRESETS.some((p) => p.key === preset);
  if (!ok) throw badRequest("Unknown preset or template");
}

/** Profile settings as given, with the logo checked: a watermark must be one of the caller's profile logos. */
async function checkSettings(c: Context<AppEnv>, settings: ChannelProfile["settings"]) {
  const logo = settings.video?.watermark?.assetId;
  if (logo && !(await profileLogo(c.get("deps").db, user(c).id, logo)))
    throw badRequest("The watermark must be a profile logo (upload one with POST /api/channel-profiles/logo)");
  return settings;
}

/**
 * Removes a logo no profile uses any more. Only ever a project-less logo of the caller's: a project's own copy is the
 * project's.
 */
async function dropLogoIfUnused(c: Context<AppEnv>, assetId: string | undefined, profiles: ChannelProfile[]) {
  if (!assetId || profiles.some((p) => p.settings.video?.watermark?.assetId === assetId)) return;
  const deps = c.get("deps");
  const a = await profileLogo(deps.db, user(c).id, assetId);
  if (a) await deps.assets.hardDelete(a);
}

type Change = { key: string; from: unknown; to: unknown };
const same = (a: unknown, b: unknown) => Bun.deepEquals(a ?? null, b ?? null);
/** How a watermark reads in a diff: its placement, and whether the logo is the one the project already has. */
const describeMark = (w: unknown, logo: string) => (w ? { ...(w as object), assetId: undefined, logo } : null);

/**
 * Applies a profile's settings to a project, or with `dryRun` only says what would change: one entry per setting
 * (per part of `video`), the logo compared by its bytes, so re-applying an unchanged profile changes nothing and
 * copies no file. Records the profile on the project either way it is applied.
 */
export async function applyProfile(
  deps: Deps,
  db: DbOrTx,
  project: { id: string; settings: ProjectSettings },
  profile: ChannelProfile,
  o: { userId: string; dryRun: boolean },
) {
  const cur = project.settings as Record<string, unknown>;
  const want = profile.settings as Record<string, unknown>;
  const next: Record<string, unknown> = { ...cur };
  const changes: Change[] = [];
  for (const key of PROFILE_SETTING_KEYS) {
    if (want[key] === undefined) continue;
    if (key !== "video") {
      const value = key === "lettering" ? { ...(cur.lettering as object), ...(want.lettering as object) } : want[key];
      if (!same(cur[key], value)) changes.push({ key, from: cur[key] ?? null, to: value });
      next[key] = value;
      continue;
    }
    const curV = (cur.video ?? {}) as Record<string, unknown>;
    const v: Record<string, unknown> = { ...curV };
    for (const [k, value] of Object.entries(want.video as Record<string, unknown>)) {
      if (value === undefined) continue;
      if (k !== "watermark" || !value) {
        if (!same(curV[k], value)) changes.push({ key: `video.${k}`, from: curV[k] ?? null, to: value });
        v[k] = value;
        continue;
      }
      const mark = value as { assetId: string };
      const logo = await profileLogo(db, o.userId, mark.assetId);
      if (!logo) throw badRequest(`The logo of profile "${profile.name}" is missing: upload it again`);
      const had = curV.watermark as { assetId: string } | null | undefined;
      const [old] = had
        ? await db
            .select({ sha256: assets.sha256 })
            .from(assets)
            .where(and(eq(assets.id, had.assetId), eq(assets.projectId, project.id), isNull(assets.deletedAt)))
        : [];
      const sameLogo = old?.sha256 === logo.sha256;
      const placed = { ...mark, assetId: had?.assetId ?? "" };
      if (!sameLogo || !same({ ...had }, placed))
        changes.push({
          key: "video.watermark",
          from: describeMark(had, "current"),
          to: describeMark(mark, sameLogo ? "current" : "profile logo"),
        });
      v.watermark = sameLogo
        ? placed
        : {
            ...mark,
            assetId: o.dryRun ? mark.assetId : (await copyAsset(deps, db, logo, { projectId: project.id, ...o })).id,
          };
    }
    next.video = v;
  }
  next.channelProfile = { id: profile.id, name: profile.name, appliedAt: new Date().toISOString() };
  const settings = ProjectSettings.parse(next);
  if (o.dryRun) return { changes, settings };
  // As a settings edit does: a new dictionary makes the audio of the segments it changes stale, and only those.
  if (changes.some((x) => x.key === "pronunciation"))
    await rehashNarrationSegments(db, project.id, settings.pronunciation);
  await db.update(projects).set({ settings }).where(eq(projects.id, project.id));
  return { changes, settings };
}

doc({
  method: "GET",
  path: "/api/channel-profiles",
  summary: "Your channel profiles: the publication identities new projects can start from",
  tag: "projects",
});
channelProfileRoutes.get("/channel-profiles", (c) => c.json({ profiles: user(c).settings.channelProfiles ?? [] }));

const ProfileInput = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  /** The project setup new projects start from: a production preset key or "template:<id>". */
  preset: z.string().max(80).nullable().default(null),
  settings: ChannelProfileSettings.default({}),
});
doc({
  method: "POST",
  path: "/api/channel-profiles",
  summary:
    "Create a channel profile: default preset, settings (voice, quality, runtime, branding, thumbnail style, YouTube rules, video output). A logo comes from POST /api/channel-profiles/logo.",
  tag: "projects",
  body: ProfileInput,
});
channelProfileRoutes.post("/channel-profiles", async (c) => {
  const input = await body(c, ProfileInput);
  checkPreset(c, input.preset);
  const now = new Date().toISOString();
  const profile = {
    ...input,
    settings: await checkSettings(c, input.settings),
    id: crypto.randomUUID(),
    createdAt: now,
    updatedAt: now,
  };
  const list = user(c).settings.channelProfiles ?? [];
  if (list.length >= 50) throw badRequest("You have 50 channel profiles; delete one first");
  await saveProfiles(c, [...list, profile]);
  return c.json({ profile }, 201);
});

const ProfilePatch = ProfileInput.partial();
doc({
  method: "PATCH",
  path: "/api/channel-profiles/:id",
  summary:
    "Change a channel profile. `settings` replaces the profile's settings as a whole. Projects made from it keep their copies.",
  tag: "projects",
  body: ProfilePatch,
});
channelProfileRoutes.patch("/channel-profiles/:id", async (c) => {
  const old = ownProfile(c, uuidParam(c, "id"));
  const input = await body(c, ProfilePatch);
  checkPreset(c, input.preset);
  const profile: ChannelProfile = {
    ...old,
    ...input,
    settings: input.settings ? await checkSettings(c, input.settings) : old.settings,
    updatedAt: new Date().toISOString(),
  };
  const list = (user(c).settings.channelProfiles ?? []).map((p) => (p.id === old.id ? profile : p));
  await saveProfiles(c, list);
  await dropLogoIfUnused(c, old.settings.video?.watermark?.assetId, list);
  return c.json({ profile });
});

doc({
  method: "DELETE",
  path: "/api/channel-profiles/:id",
  summary:
    "Delete a channel profile and its logo. Projects made from it keep their settings and their copy of the logo.",
  tag: "projects",
});
channelProfileRoutes.delete("/channel-profiles/:id", async (c) => {
  const old = ownProfile(c, uuidParam(c, "id"));
  const list = (user(c).settings.channelProfiles ?? []).filter((p) => p.id !== old.id);
  await saveProfiles(c, list);
  await dropLogoIfUnused(c, old.settings.video?.watermark?.assetId, list);
  return c.json({ ok: true });
});

doc({
  method: "POST",
  path: "/api/channel-profiles/logo",
  summary:
    "Upload a logo for a channel profile (multipart: file). It belongs to your account, not a project; set it as settings.video.watermark.assetId of a profile. Each project the profile is applied to gets its own copy.",
  tag: "projects",
});
channelProfileRoutes.post("/channel-profiles/logo", async (c) => {
  const up = await readImageUpload(c);
  // ponytail: a logo uploaded but never saved to a profile stays until the account goes; add a sweep if it matters.
  const asset = await c.get("deps").assets.store({
    projectId: null,
    ownerUserId: user(c).id,
    type: "source_image",
    data: up.data,
    mimeType: up.mime,
    width: up.width,
    height: up.height,
    metadata: { role: LOGO_ROLE, originalName: up.originalName },
  });
  return c.json({ asset: { id: asset.id, width: asset.width, height: asset.height } }, 201);
});

const SaveProfile = z.object({ name: z.string().trim().min(1).max(80) });
doc({
  method: "POST",
  path: "/api/projects/:projectId/channel-profile",
  summary:
    "Save this project's channel settings (voice, quality, runtime, branding and logo, thumbnail style, YouTube rules, video output) as a new channel profile of yours.",
  tag: "projects",
  body: SaveProfile,
});
channelProfileRoutes.post("/projects/:projectId/channel-profile", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const { name } = await body(c, SaveProfile);
  const deps = c.get("deps");
  const list = user(c).settings.channelProfiles ?? [];
  if (list.length >= 50) throw badRequest("You have 50 channel profiles; delete one first");
  const picked = Object.fromEntries(PROFILE_SETTING_KEYS.map((k) => [k, p.settings[k]]));
  const settings = ChannelProfileSettings.parse(picked);
  // The project's logo is the project's: the profile gets its own copy, so either can be deleted on its own.
  const mark = settings.video?.watermark;
  if (mark) {
    const [logo] = await deps.db
      .select()
      .from(assets)
      .where(and(eq(assets.id, mark.assetId), eq(assets.projectId, p.id), isNull(assets.deletedAt)));
    if (logo) mark.assetId = (await copyAsset(deps, deps.db, logo, { projectId: null, userId: user(c).id })).id;
    else settings.video!.watermark = null;
  }
  const now = new Date().toISOString();
  const profile: ChannelProfile = {
    id: crypto.randomUUID(),
    name,
    description: "",
    preset: null,
    settings,
    createdAt: now,
    updatedAt: now,
  };
  await saveProfiles(c, [...list, profile]);
  return c.json({ profile }, 201);
});

const ApplyInput = z.object({
  profileId: z.string().uuid(),
  /** false (the default): only list what would change. true: apply it. */
  confirm: z.boolean().default(false),
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/apply-profile",
  summary:
    "Re-apply one of your channel profiles to this project: without confirm, the settings that would change (from → to); with confirm: true, copies them in. Format, type and style are not changed.",
  tag: "projects",
  body: ApplyInput,
});
channelProfileRoutes.post("/projects/:projectId/apply-profile", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const { profileId, confirm } = await body(c, ApplyInput);
  const profile = ownProfile(c, profileId);
  const deps = c.get("deps");
  const r = await deps.db.transaction((tx) =>
    applyProfile(deps, tx, p, profile, { userId: user(c).id, dryRun: !confirm }),
  );
  if (confirm)
    await recordAudit(deps.db, {
      userId: user(c).id,
      projectId: p.id,
      action: "project.apply_profile",
      metadata: { profileId, changes: r.changes.map((x) => x.key) },
      requestId: c.get("requestId"),
    });
  return c.json({ profile: { id: profile.id, name: profile.name }, changes: r.changes, applied: confirm });
});
