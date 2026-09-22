import { pgEnum, timestamp, uuid } from "drizzle-orm/pg-core";

export const id = () => uuid("id").primaryKey().defaultRandom();
export const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
export const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());
export const ts = (name: string) => timestamp(name, { withTimezone: true });

export const approvalStatus = pgEnum("approval_status", ["draft", "approved", "locked", "superseded"]);
export const userRole = pgEnum("user_role", ["user", "admin"]);
export const userStatus = pgEnum("user_status", ["active", "disabled"]);
export const projectType = pgEnum("project_type", ["manga", "manhwa", "webtoon", "comic", "illustrated_story"]);
export const readingDirection = pgEnum("reading_direction", ["ltr", "rtl", "vertical"]);
export const colorMode = pgEnum("color_mode", ["full_color", "grayscale", "bw_manga"]);
export const projectStatus = pgEnum("project_status", ["active", "archived"]);
export const memberRole = pgEnum("member_role", ["owner", "editor", "viewer"]);

export const assetType = pgEnum("asset_type", [
  "character_reference",
  "location_reference",
  "prop_reference",
  "style_reference",
  "panel_art",
  "panel_mask",
  "cover",
  "thumbnail",
  "prompt_reference",
  /** An image the user uploaded to describe or reuse, not attached to any version. */
  "source_image",
  "export",
  "audio",
]);
export const assetVisibility = pgEnum("asset_visibility", ["private", "public"]);

export const panelStatus = pgEnum("panel_status", [
  "planned",
  "prompt-ready",
  "queued",
  "generating",
  "ready",
  "failed",
]);

export const jobStatus = pgEnum("job_status", [
  "queued",
  /** Handed to a provider's async batch API and waiting for it; no worker slot is held. */
  "submitted",
  /**
   * Parked for a person: the prompt is compiled and waiting for an answer to be pasted in. Reached only by a run
   * with no provider key, and left by posting the answer, which requeues the job to finish exactly as an API run
   * would. No worker slot is held and nothing expires it.
   */
  "awaiting_input",
  "processing",
  "completed",
  "failed",
  "cancel_requested",
  "cancelled",
  "paused",
]);
