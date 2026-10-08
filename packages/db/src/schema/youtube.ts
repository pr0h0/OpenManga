import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { createdAt, id, ts, updatedAt } from "./common.ts";
import { exportsTable } from "./jobs.ts";
import { projects } from "./projects.ts";

/** A Reporting API job the app created for a channel, and the newest report it has downloaded from it. */
export type YoutubeReportingJob = { jobId: string; fetchedThrough: string | null };
export type YoutubeReporting = {
  basic?: YoutubeReportingJob;
  combined?: YoutubeReportingJob;
  /** When the reports were last looked for. */
  checkedAt?: string;
};

/**
 * A connected YouTube channel: one OAuth connection (read-only scopes) of one user. Tokens are AES-GCM encrypted
 * like provider keys and never leave the server. `verifiedAt` is the last time Google confirmed the authorization
 * (a token refresh or call that succeeded): stored data of a channel is deleted when that is over 30 days old.
 */
export const youtubeChannels = pgTable(
  "youtube_channels",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    channelId: text("channel_id").notNull(),
    title: text("title").notNull(),
    thumbnailUrl: text("thumbnail_url"),
    uploadsPlaylistId: text("uploads_playlist_id"),
    encryptedRefreshToken: text("encrypted_refresh_token").notNull(),
    encryptedAccessToken: text("encrypted_access_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
    reporting: jsonb("reporting").$type<YoutubeReporting>().notNull().default({}),
    /** The last Reporting API problem (not enabled on the Cloud project, …), shown on the channel. */
    reportingError: text("reporting_error"),
    /** "revoked": Google refused the refresh token; the user reconnects or removes the channel. */
    status: text("status").$type<"active" | "revoked">().notNull().default("active"),
    verifiedAt: ts("verified_at").notNull().defaultNow(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("youtube_channels_user_channel_uq").on(t.userId, t.channelId)],
);

/**
 * A published video linked to a project: a film or a Short, on any channel. `connectionId` is set when the video is
 * on a channel the linking user connected; then its history comes from the Analytics API.
 */
export const youtubeLinks = pgTable(
  "youtube_links",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    channelId: text("channel_id"),
    channelTitle: text("channel_title"),
    connectionId: uuid("connection_id").references(() => youtubeChannels.id, { onDelete: "set null" }),
    kind: text("kind").$type<"film" | "short">().notNull().default("film"),
    title: text("title").notNull().default(""),
    thumbnailUrl: text("thumbnail_url"),
    publishedAt: ts("published_at"),
    durationSeconds: integer("duration_seconds"),
    /** The export file it was rendered from, if any. */
    exportId: uuid("export_id").references(() => exportsTable.id, { onDelete: "set null" }),
    /** The Short of the repurposing plan it came from (settings.repurpose item id), if any. */
    shortId: text("short_id"),
    label: text("label").notNull().default(""),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("youtube_links_project_video_uq").on(t.projectId, t.videoId),
    index("youtube_links_video_idx").on(t.videoId),
  ],
);

/**
 * A video's public counters at one moment, shared by every project that links it. `connectionId` is set when the
 * counters were read with the token of the channel that owns the video (Authorized Data, deleted with the
 * connection); without it they are Non-Authorized Data, deleted after 30 days.
 */
export const youtubeSnapshots = pgTable(
  "youtube_snapshots",
  {
    id: id(),
    videoId: text("video_id").notNull(),
    takenAt: ts("taken_at").notNull().defaultNow(),
    views: bigint("views", { mode: "number" }).notNull(),
    likes: bigint("likes", { mode: "number" }),
    comments: bigint("comments", { mode: "number" }),
    connectionId: uuid("connection_id").references(() => youtubeChannels.id, { onDelete: "cascade" }),
    authorized: boolean("authorized").notNull().default(false),
  },
  (t) => [
    index("youtube_snapshots_video_idx").on(t.videoId, t.takenAt),
    index("youtube_snapshots_taken_idx").on(t.takenAt),
  ],
);

/**
 * Thumbnail impressions from the Reporting API's reach reports, the only source of them: per video and day overall
 * with CTR (`source` "", channel_reach_basic_a1), and per traffic source (channel_reach_combined_a1).
 */
export const youtubeReach = pgTable(
  "youtube_reach",
  {
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => youtubeChannels.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    day: date("day", { mode: "string" }).notNull(),
    source: text("source").notNull().default(""),
    impressions: bigint("impressions", { mode: "number" }).notNull(),
    ctr: real("ctr"),
  },
  (t) => [
    primaryKey({ columns: [t.connectionId, t.videoId, t.day, t.source] }),
    index("youtube_reach_video_idx").on(t.videoId, t.day),
  ],
);
