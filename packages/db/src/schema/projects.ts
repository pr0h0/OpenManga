import type {
  ChapterPlan,
  CharacterBible,
  LocationDescription,
  ProjectSettings,
  PropDescription,
  StoryAnalysis,
  StyleDefinition,
} from "@openmanga/schemas";
import { boolean, index, integer, jsonb, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import {
  approvalStatus,
  colorMode,
  createdAt,
  id,
  memberRole,
  projectStatus,
  projectType,
  readingDirection,
  ts,
  updatedAt,
} from "./common.ts";

export const projects = pgTable(
  "projects",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    projectType: projectType("project_type").notNull().default("manhwa"),
    language: text("language").notNull().default("en"),
    readingDirection: readingDirection("reading_direction").notNull().default("ltr"),
    colorMode: colorMode("color_mode").notNull().default("full_color"),
    status: projectStatus("status").notNull().default("active"),
    settings: jsonb("settings").$type<ProjectSettings>().notNull(),
    currentStyleId: uuid("current_style_id"),
    coverAssetId: uuid("cover_asset_id"),
    thumbnailAssetId: uuid("thumbnail_asset_id"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("projects_owner_idx").on(t.ownerUserId, t.updatedAt)],
);

export const projectMembers = pgTable(
  "project_members",
  {
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] }), index("project_members_user_idx").on(t.userId)],
);

/**
 * An owner's invitation to join a project as an editor or viewer. An invite to an account (`userId`) is answered in
 * the app; an invite by email also carries a one-time token, mailed as a link, stored only as its HMAC, that can
 * accept it or create the account for that address even while registration is closed. Pending means none of
 * accepted/declined/revoked is set and it has not expired.
 */
export const projectInvites = pgTable(
  "project_invites",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    role: memberRole("role").notNull(),
    /** The account invited: by username, or the account that already held the invited email. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    /** Lower-cased; set for an invite by email. */
    email: text("email"),
    tokenHash: text("token_hash"),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, { onDelete: "set null" }),
    expiresAt: ts("expires_at").notNull(),
    acceptedAt: ts("accepted_at"),
    declinedAt: ts("declined_at"),
    revokedAt: ts("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("project_invites_token_hash_uq").on(t.tokenHash),
    index("project_invites_project_idx").on(t.projectId),
    index("project_invites_user_idx").on(t.userId),
  ],
);

export const storyRevisions = pgTable(
  "story_revisions",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    source: text("source").$type<"initial" | "user_edit" | "ai_rewrite" | "import">().notNull(),
    inputKind: text("input_kind")
      .$type<"story" | "chapter" | "outline" | "screenplay" | "idea">()
      .notNull()
      .default("story"),
    title: text("title").notNull().default(""),
    content: text("content").notNull(),
    contentSha256: text("content_sha256").notNull(),
    lockedAt: ts("locked_at"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("story_revisions_project_rev_uq").on(t.projectId, t.revisionNumber)],
);

export const storyAnalyses = pgTable(
  "story_analyses",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    storyRevisionId: uuid("story_revision_id")
      .notNull()
      .references(() => storyRevisions.id),
    status: text("status").$type<"pending" | "completed" | "failed" | "applied">().notNull().default("pending"),
    result: jsonb("result").$type<StoryAnalysis>(),
    generationJobId: uuid("generation_job_id"),
    appliedAt: ts("applied_at"),
    createdAt: createdAt(),
  },
  (t) => [index("story_analyses_project_idx").on(t.projectId, t.createdAt)],
);

export const chapters = pgTable(
  "chapters",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    storyAnalysisId: uuid("story_analysis_id"),
    order: integer("order").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    sourceExcerpt: text("source_excerpt").notNull().default(""),
    openingState: text("opening_state").notNull().default(""),
    closingState: text("closing_state").notNull().default(""),
    characterStateChanges: jsonb("character_state_changes").$type<string[]>().notNull().default([]),
    locationStateChanges: jsonb("location_state_changes").$type<string[]>().notNull().default([]),
    revealedFacts: jsonb("revealed_facts").$type<string[]>().notNull().default([]),
    beats: jsonb("beats").$type<string[]>().notNull().default([]),
    lastPlan: jsonb("last_plan").$type<ChapterPlan>(),
    planStatus: approvalStatus("plan_status").notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("chapters_project_order_idx").on(t.projectId, t.order)],
);

export const locations = pgTable(
  "locations",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    analysisKey: text("analysis_key"),
    currentVersionId: uuid("current_version_id"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("locations_project_idx").on(t.projectId)],
);

export const locationVersions = pgTable(
  "location_versions",
  {
    id: id(),
    locationId: uuid("location_id")
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    description: jsonb("description").$type<LocationDescription>().notNull(),
    status: approvalStatus("status").notNull().default("draft"),
    parentVersionId: uuid("parent_version_id"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("location_versions_uq").on(t.locationId, t.versionNumber)],
);

export const scenes = pgTable(
  "scenes",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: uuid("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    order: integer("order").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
    time: text("time").notNull().default(""),
    weather: text("weather").notNull().default(""),
    characterIds: jsonb("character_ids").$type<string[]>().notNull().default([]),
    purpose: text("purpose").notNull().default(""),
    opening: text("opening").notNull().default(""),
    progression: text("progression").notNull().default(""),
    climax: text("climax").notNull().default(""),
    ending: text("ending").notNull().default(""),
    continuityNotes: jsonb("continuity_notes").$type<string[]>().notNull().default([]),
    initialState: jsonb("initial_state").$type<Record<string, string>>().notNull().default({}),
    finalState: jsonb("final_state").$type<Record<string, string>>().notNull().default({}),
    continuityDeltas: jsonb("continuity_deltas").$type<string[]>().notNull().default([]),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("scenes_chapter_order_idx").on(t.chapterId, t.order)],
);

export const storyBeats = pgTable(
  "story_beats",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sceneId: uuid("scene_id")
      .notNull()
      .references(() => scenes.id, { onDelete: "cascade" }),
    order: integer("order").notNull(),
    description: text("description").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("story_beats_scene_idx").on(t.sceneId, t.order)],
);

export const characters = pgTable(
  "characters",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role").$type<"protagonist" | "antagonist" | "supporting" | "minor">().notNull().default("supporting"),
    analysisKey: text("analysis_key"),
    currentVersionId: uuid("current_version_id"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("characters_project_idx").on(t.projectId)],
);

export const characterVersions = pgTable(
  "character_versions",
  {
    id: id(),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    description: jsonb("description").$type<CharacterBible>().notNull(),
    immutableTraits: jsonb("immutable_traits").$type<string[]>().notNull().default([]),
    status: approvalStatus("status").notNull().default("draft"),
    parentVersionId: uuid("parent_version_id"),
    changeNote: text("change_note").notNull().default(""),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("character_versions_uq").on(t.characterId, t.versionNumber)],
);

export const characterAliases = pgTable(
  "character_aliases",
  {
    id: id(),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    alias: text("alias").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("character_aliases_uq").on(t.characterId, t.alias)],
);

export const characterOutfits = pgTable("character_outfits", {
  id: id(),
  characterId: uuid("character_id")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  characterVersionId: uuid("character_version_id").references(() => characterVersions.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  isDefault: boolean("is_default").notNull().default(false),
  createdAt: createdAt(),
});

export const props = pgTable(
  "props",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    analysisKey: text("analysis_key"),
    currentVersionId: uuid("current_version_id"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("props_project_idx").on(t.projectId)],
);

export const propVersions = pgTable(
  "prop_versions",
  {
    id: id(),
    propId: uuid("prop_id")
      .notNull()
      .references(() => props.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    description: jsonb("description").$type<PropDescription>().notNull(),
    status: approvalStatus("status").notNull().default("draft"),
    parentVersionId: uuid("parent_version_id"),
    createdByUserId: uuid("created_by_user_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("prop_versions_uq").on(t.propId, t.versionNumber)],
);

export const stylePresets = pgTable("style_presets", {
  id: id(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  isBuiltin: boolean("is_builtin").notNull().default(false),
  definition: jsonb("definition").$type<StyleDefinition>().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const projectStyles = pgTable(
  "project_styles",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    stylePresetId: uuid("style_preset_id").references(() => stylePresets.id),
    customDescription: text("custom_description").notNull().default(""),
    status: approvalStatus("status").notNull().default("approved"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("project_styles_uq").on(t.projectId, t.versionNumber)],
);

/** An unlisted, read-only link to a project or one chapter: anyone with the token can read it, nobody can change it. */
export const shareLinks = pgTable(
  "share_links",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Null: the whole project. */
    chapterId: uuid("chapter_id").references(() => chapters.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("share_links_token_uq").on(t.token), index("share_links_project_idx").on(t.projectId)],
);

/** One step of a production run, in order; `jobIds`/`exportJobId` are what it is waiting on. */
export type ProductionStep = {
  key: string;
  status: "pending" | "running" | "review" | "done" | "skipped" | "failed";
  note?: string;
  jobIds?: string[];
  exportJobId?: string;
  /** Narration synthesis batches the step queued (`audio_jobs.batch_id`), so stopping the run can cancel them. */
  audioBatchIds?: string[];
  /** The audio step queued the segments it had missed once more (it does so only once). */
  requeued?: boolean;
  /** What a later step needs from this one, e.g. the analysis the apply step applies. */
  ref?: string;
  startedAt?: string;
  finishedAt?: string;
};

/**
 * What a run left unresolved when it reached the end (`completed_with_warnings`): failed jobs it queued that were
 * not retried, and the project's panels without artwork, narration segments without current audio, panels flagged
 * for review and the run's failed exports.
 */
export type ProductionWarnings = {
  /** At most 500 listed; `failedJobCount` is the full number. */
  failedJobs: { id: string; kind: string; step: string; reason: string | null }[];
  failedJobCount: number;
  panelsWithoutArt: number;
  segmentsWithoutAudio: number;
  panelsNeedingReview: number;
  failedExports: { id: string; kind: string; reason: string | null }[];
};

/**
 * A production run: the whole pipeline for a project, advanced step by step by the API, each step calling the same
 * routes a person would. Resumable: it only ever looks at what exists, so a restart picks up where it stood.
 */
export const productionRuns = pgTable(
  "production_runs",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: text("status")
      .$type<"running" | "waiting" | "paused" | "completed" | "completed_with_warnings" | "failed" | "cancelled">()
      .notNull()
      .default("running"),
    steps: jsonb("steps").$type<ProductionStep[]>().notNull().default([]),
    options: jsonb("options")
      .$type<{ reviewGates: boolean; preparePrompts: boolean; render: boolean; youtube: boolean }>()
      .notNull(),
    /** Why the run is paused or failed, in words for the person. */
    reason: text("reason"),
    /** Set when the run finished `completed_with_warnings`. */
    warnings: jsonb("warnings").$type<ProductionWarnings>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("production_runs_project_idx").on(t.projectId, t.createdAt),
    index("production_runs_status_idx").on(t.status),
  ],
);
