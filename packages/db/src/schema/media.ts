import type {
  Bubble,
  Frame,
  ImageTransform,
  PanelSeam,
  PanelSpec,
  PlannedLettering,
  SfxStyle,
} from "@openmanga/schemas";
import { bigint, boolean, index, integer, jsonb, pgTable, real, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import {
  approvalStatus,
  assetType,
  assetVisibility,
  createdAt,
  id,
  panelStatus,
  readingDirection,
  ts,
  updatedAt,
} from "./common.ts";
import {
  chapters,
  characterOutfits,
  characters,
  characterVersions,
  locationVersions,
  projectStyles,
  projects,
  propVersions,
  scenes,
} from "./projects.ts";

export const assets = pgTable(
  "assets",
  {
    id: id(),
    ownerUserId: uuid("owner_user_id").references(() => users.id, { onDelete: "set null" }),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    type: assetType("type").notNull(),
    visibility: assetVisibility("visibility").notNull().default("private"),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width"),
    height: integer("height"),
    durationMs: integer("duration_ms"),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    status: approvalStatus("status").notNull().default("draft"),
    parentAssetId: uuid("parent_asset_id"),
    generationJobId: uuid("generation_job_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("assets_project_type_idx").on(t.projectId, t.type),
    uniqueIndex("assets_storage_key_uq").on(t.storageKey),
  ],
);

export const assetVariants = pgTable(
  "asset_variants",
  {
    id: id(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    variant: text("variant").$type<"thumbnail" | "preview" | "prompt_ref" | "web" | "export">().notNull(),
    cacheKey: text("cache_key").notNull(),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    sha256: text("sha256").notNull(),
    params: jsonb("params").$type<Record<string, unknown>>().notNull().default({}),
    lastUsedAt: ts("last_used_at").notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("asset_variants_cache_key_uq").on(t.cacheKey),
    index("asset_variants_asset_idx").on(t.assetId, t.variant),
  ],
);

export const REFERENCE_KINDS = [
  "portrait",
  "full_body",
  "multi_angle",
  "expression_sheet",
  "outfit",
  "location",
  /** One continuous wide view sweeping across the whole space. */
  "location_panorama",
  /** One image split into panels, each showing a different side of the space. */
  "location_sheet",
  "prop",
  /** One image showing the object from several angles. */
  "prop_multi_angle",
  "style",
  "uploaded",
] as const;
export type ReferenceKind = (typeof REFERENCE_KINDS)[number];

export const referenceAssets = pgTable(
  "reference_assets",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    subjectType: text("subject_type").$type<"character" | "location" | "prop" | "style">().notNull(),
    characterVersionId: uuid("character_version_id").references(() => characterVersions.id, { onDelete: "cascade" }),
    outfitId: uuid("outfit_id").references(() => characterOutfits.id, { onDelete: "set null" }),
    locationVersionId: uuid("location_version_id").references(() => locationVersions.id, { onDelete: "cascade" }),
    propVersionId: uuid("prop_version_id").references(() => propVersions.id, { onDelete: "cascade" }),
    projectStyleId: uuid("project_style_id").references(() => projectStyles.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ReferenceKind>().notNull(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    status: approvalStatus("status").notNull().default("draft"),
    isPrimary: boolean("is_primary").notNull().default(false),
    /** Fingerprint of the subject version's prompt-visible description when this reference was made (null = unknown). */
    sourceFingerprint: text("source_fingerprint"),
    createdAt: createdAt(),
  },
  (t) => [
    index("reference_assets_char_idx").on(t.characterVersionId),
    index("reference_assets_loc_idx").on(t.locationVersionId),
    index("reference_assets_prop_idx").on(t.propVersionId),
    index("reference_assets_style_idx").on(t.projectStyleId),
  ],
);

export const pages = pgTable(
  "pages",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: uuid("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    sceneId: uuid("scene_id").references(() => scenes.id, { onDelete: "set null" }),
    order: integer("order").notNull(),
    purpose: text("purpose").notNull().default(""),
    pacing: text("pacing").notNull().default(""),
    visualEmphasis: text("visual_emphasis").notNull().default(""),
    pageTurnHook: text("page_turn_hook").notNull().default(""),
    layoutTemplate: text("layout_template"),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    readingDirection: readingDirection("reading_direction"),
    status: approvalStatus("status").notNull().default("draft"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("pages_chapter_order_idx").on(t.chapterId, t.order)],
);

export const panels = pgTable(
  "panels",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    sceneId: uuid("scene_id").references(() => scenes.id, { onDelete: "set null" }),
    order: integer("order").notNull(),
    frame: jsonb("frame").$type<Frame>().notNull(),
    imageTransform: jsonb("image_transform")
      .$type<ImageTransform>()
      .notNull()
      .default({ focalX: 0.5, focalY: 0.5, scale: 1 }),
    shotType: text("shot_type").notNull().default("medium"),
    cameraAngle: text("camera_angle"),
    storyBeat: text("story_beat").notNull().default(""),
    locationVersionId: uuid("location_version_id").references(() => locationVersions.id, { onDelete: "set null" }),
    characterVersionIds: jsonb("character_version_ids").$type<string[]>().notNull().default([]),
    propVersionIds: jsonb("prop_version_ids").$type<string[]>().notNull().default([]),
    activeArtworkAssetId: uuid("active_artwork_asset_id"),
    status: panelStatus("status").notNull().default("planned"),
    approvalStatus: approvalStatus("approval_status").notNull().default("draft"),
    /** Latest automatic consistency check of the active artwork (cast/headcount), null when not checked. */
    qa: jsonb("qa").$type<Record<string, unknown>>(),
    /** Set when the active artwork needs a human look, e.g. generated on a fallback provider after a content-policy block. */
    review: jsonb("review").$type<{ reason: string; message: string; at: string } & Record<string, unknown>>(),
    promptOverride: text("prompt_override"),
    promptDraft: jsonb("prompt_draft").$type<Record<string, unknown>>(),
    /** Vertical strips only: how this panel meets the one before it. Null = the project's plain gap. */
    seam: jsonb("seam").$type<PanelSeam>(),
    /** The plan's dialogue and SFX for this panel, until they are lettered onto the page. */
    plannedLettering: jsonb("planned_lettering").$type<PlannedLettering>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("panels_page_order_idx").on(t.pageId, t.order), index("panels_project_idx").on(t.projectId)],
);

export const panelSpecs = pgTable(
  "panel_specs",
  {
    id: id(),
    panelId: uuid("panel_id")
      .notNull()
      .references(() => panels.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    spec: jsonb("spec").$type<PanelSpec>().notNull(),
    source: text("source").$type<"ai" | "user">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("panel_specs_uq").on(t.panelId, t.versionNumber)],
);

/**
 * Which outfit a character wears, set on a panel. "onward" holds from that panel to the next change in reading order,
 * across pages and chapters; "panel" dresses that one panel only and leaves the running outfit alone.
 */
export const outfitAssignments = pgTable(
  "outfit_assignments",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    outfitId: uuid("outfit_id")
      .notNull()
      .references(() => characterOutfits.id, { onDelete: "cascade" }),
    panelId: uuid("panel_id")
      .notNull()
      .references(() => panels.id, { onDelete: "cascade" }),
    scope: text("scope").$type<"onward" | "panel">().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("outfit_assignments_uq").on(t.characterId, t.panelId, t.scope),
    index("outfit_assignments_project_idx").on(t.projectId),
  ],
);

export const dialogueLines = pgTable(
  "dialogue_lines",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    panelId: uuid("panel_id").references(() => panels.id, { onDelete: "set null" }),
    characterId: uuid("character_id").references(() => characters.id, { onDelete: "set null" }),
    order: integer("order").notNull().default(0),
    text: text("text").notNull(),
    bubble: jsonb("bubble").$type<Bubble>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("dialogue_lines_page_idx").on(t.pageId), index("dialogue_lines_panel_idx").on(t.panelId)],
);

export const soundEffects = pgTable(
  "sound_effects",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    pageId: uuid("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    panelId: uuid("panel_id").references(() => panels.id, { onDelete: "set null" }),
    text: text("text").notNull(),
    style: jsonb("style").$type<SfxStyle>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("sound_effects_page_idx").on(t.pageId)],
);

export const narrationLines = pgTable(
  "narration_lines",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: uuid("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "set null" }),
    panelId: uuid("panel_id").references(() => panels.id, { onDelete: "set null" }),
    order: integer("order").notNull(),
    /** Narration track language (BCP-47-ish, e.g. "en", "es"); one chapter can hold several tracks. */
    language: text("language").notNull().default("en"),
    text: text("text").notNull(),
    showOnPage: boolean("show_on_page").notNull().default(false),
    box: jsonb("box").$type<Bubble>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("narration_lines_chapter_idx").on(t.chapterId, t.language, t.order)],
);

export const narrationSegments = pgTable(
  "narration_segments",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    narrationLineId: uuid("narration_line_id")
      .notNull()
      .references(() => narrationLines.id, { onDelete: "cascade" }),
    order: integer("order").notNull(),
    text: text("text").notNull(),
    textSha256: text("text_sha256").notNull(),
    voice: text("voice"),
    speed: real("speed"),
    pauseAfterMs: integer("pause_after_ms").notNull().default(350),
    activeAudioAssetId: uuid("active_audio_asset_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("narration_segments_line_idx").on(t.narrationLineId, t.order)],
);

export const audioAssets = pgTable(
  "audio_assets",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    segmentId: uuid("segment_id").references(() => narrationSegments.id, { onDelete: "set null" }),
    textSha256: text("text_sha256").notNull(),
    voice: text("voice").notNull(),
    speed: real("speed").notNull(),
    language: text("language").notNull(),
    provider: text("provider").notNull(),
    modelVersion: text("model_version"),
    sampleRate: integer("sample_rate").notNull(),
    durationMs: integer("duration_ms").notNull(),
    format: text("format").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("audio_assets_cache_idx").on(t.projectId, t.textSha256, t.voice, t.speed)],
);
