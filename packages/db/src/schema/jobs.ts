import { boolean, index, integer, jsonb, numeric, pgTable, real, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { createdAt, id, jobStatus, ts, updatedAt } from "./common.ts";
import { assets, narrationSegments } from "./media.ts";
import { chapters, projects } from "./projects.ts";

export type GenerationKind =
  | "story_analysis"
  | "story_rewrite"
  | "chapter_plan"
  | "page_prompts"
  | "narration_text"
  | "character_reference"
  | "location_reference"
  | "prop_reference"
  | "style_reference"
  | "panel_generation"
  | "panel_edit"
  | "panel_check"
  | "cover"
  /** Collects a bulk run's panels into one provider batch submission; owns no panel of its own. */
  | "image_batch_submit"
  /** The same for text jobs: harvests each job's request and submits them together. */
  | "text_batch_submit";

export const generationJobs = pgTable(
  "generation_jobs",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    kind: text("kind").$type<GenerationKind>().notNull(),
    queue: text("queue").notNull(),
    priority: integer("priority").notNull().default(5),
    status: jobStatus("status").notNull().default("queued"),
    batchId: uuid("batch_id"),
    targetType: text("target_type"),
    targetId: uuid("target_id"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    failureCode: text("failure_code"),
    failureReason: text("failure_reason"),
    provider: text("provider"),
    model: text("model"),
    providerRequestId: text("provider_request_id"),
    /** Set when POST /generations/:id/retry created a replacement, so pollers can tell a handled failure apart. */
    retriedByJobId: uuid("retried_by_job_id"),
    templateName: text("template_name"),
    templateVersion: integer("template_version"),
    compiledPrompt: text("compiled_prompt"),
    promptHash: text("prompt_hash"),
    referencesHash: text("references_hash"),
    optionsHash: text("options_hash"),
    parameters: jsonb("parameters").$type<Record<string, unknown>>().notNull().default({}),
    input: jsonb("input").$type<Record<string, unknown>>().notNull().default({}),
    result: jsonb("result").$type<Record<string, unknown>>(),
    latencyMs: integer("latency_ms"),
    cancelRequestedAt: ts("cancel_requested_at"),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("generation_jobs_status_idx").on(t.status, t.createdAt),
    index("generation_jobs_project_idx").on(t.projectId, t.createdAt),
    index("generation_jobs_target_idx").on(t.targetId),
    index("generation_jobs_batch_idx").on(t.batchId),
  ],
);

export const generationInputs = pgTable(
  "generation_inputs",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    role: text("role")
      .$type<"target" | "mask" | "character_ref" | "location_ref" | "prop_ref" | "style_ref" | "previous_panel">()
      .notNull(),
    order: integer("order").notNull(),
    assetId: uuid("asset_id").references(() => assets.id, { onDelete: "set null" }),
    variantId: uuid("variant_id"),
    subjectVersionId: uuid("subject_version_id"),
    label: text("label").notNull().default(""),
    width: integer("width"),
    height: integer("height"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("generation_inputs_job_idx").on(t.jobId)],
);

export const generationOutputs = pgTable(
  "generation_outputs",
  {
    id: id(),
    jobId: uuid("job_id")
      .notNull()
      .references(() => generationJobs.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    outputIndex: integer("output_index").notNull().default(0),
    activated: boolean("activated").notNull().default(false),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("generation_outputs_job_idx").on(t.jobId)],
);

export const promptTemplates = pgTable("prompt_templates", {
  id: id(),
  name: text("name").notNull().unique(),
  kind: text("kind").$type<"text" | "image">().notNull(),
  description: text("description").notNull().default(""),
  createdAt: createdAt(),
});

export const promptVersions = pgTable(
  "prompt_versions",
  {
    id: id(),
    templateId: uuid("template_id")
      .notNull()
      .references(() => promptTemplates.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("prompt_versions_uq").on(t.templateId, t.version)],
);

export const audioJobs = pgTable(
  "audio_jobs",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    segmentId: uuid("segment_id")
      .notNull()
      .references(() => narrationSegments.id, { onDelete: "cascade" }),
    batchId: uuid("batch_id"),
    status: jobStatus("status").notNull().default("queued"),
    voice: text("voice").notNull(),
    speed: real("speed").notNull(),
    /** { ai: { credentialId, model } } when a BYOK voice provider was chosen; empty = server default (Kokoro). */
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    failureCode: text("failure_code"),
    failureReason: text("failure_reason"),
    audioAssetId: uuid("audio_asset_id"),
    reusedCache: boolean("reused_cache").notNull().default(false),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("audio_jobs_project_idx").on(t.projectId, t.createdAt), index("audio_jobs_status_idx").on(t.status)],
);

export type ExportKind =
  | "png_pages"
  | "jpg_pages"
  | "pdf"
  | "webtoon"
  | "zip_package"
  | "project_json"
  | "narration_audio"
  | "timeline"
  | "agent_package"
  | "video_pages"
  | "video_panels"
  | "project_import";

export const exportJobs = pgTable(
  "export_jobs",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    chapterId: uuid("chapter_id").references(() => chapters.id, { onDelete: "set null" }),
    kind: text("kind").$type<ExportKind>().notNull(),
    options: jsonb("options").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatus("status").notNull().default("queued"),
    progress: real("progress").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    failureReason: text("failure_reason"),
    /** Structured outcome, e.g. { projectId, warnings } for project_import. */
    result: jsonb("result").$type<Record<string, unknown>>(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("export_jobs_project_idx").on(t.projectId, t.createdAt)],
);

export const exportsTable = pgTable(
  "exports",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    exportJobId: uuid("export_job_id")
      .notNull()
      .references(() => exportJobs.id, { onDelete: "cascade" }),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    kind: text("kind").$type<ExportKind>().notNull(),
    fileName: text("file_name").notNull(),
    expiresAt: ts("expires_at"),
    createdAt: createdAt(),
  },
  (t) => [index("exports_project_idx").on(t.projectId, t.createdAt)],
);

export const providerRateSnapshots = pgTable(
  "provider_rate_snapshots",
  {
    id: id(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    effectiveFrom: ts("effective_from").notNull(),
    /** USD per 1M tokens */
    textInputRate: numeric("text_input_rate", { precision: 12, scale: 6 }).notNull().default("0"),
    cachedInputRate: numeric("cached_input_rate", { precision: 12, scale: 6 }).notNull().default("0"),
    textOutputRate: numeric("text_output_rate", { precision: 12, scale: 6 }).notNull().default("0"),
    imageInputRate: numeric("image_input_rate", { precision: 12, scale: 6 }).notNull().default("0"),
    imageOutputRate: numeric("image_output_rate", { precision: 12, scale: 6 }).notNull().default("0"),
    /** USD per generated image, for providers that bill a flat price per image. */
    imageUnitRate: numeric("image_unit_rate", { precision: 12, scale: 6 }).notNull().default("0"),
    /** USD per 1M characters, for speech providers that bill by input text length. */
    characterRate: numeric("character_rate", { precision: 12, scale: 6 }).notNull().default("0"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("provider_rate_snapshots_lookup_idx").on(t.provider, t.model, t.effectiveFrom)],
);

export const aiUsage = pgTable(
  "ai_usage",
  {
    id: id(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    operation: text("operation").notNull(),
    requestId: text("request_id"),
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
    generationJobId: uuid("generation_job_id"),
    userId: uuid("user_id"),
    textInputTokens: integer("text_input_tokens").notNull().default(0),
    textOutputTokens: integer("text_output_tokens").notNull().default(0),
    imageInputTokens: integer("image_input_tokens").notNull().default(0),
    imageOutputTokens: integer("image_output_tokens").notNull().default(0),
    cachedInputTokens: integer("cached_input_tokens").notNull().default(0),
    /** Billable quantities the cost was computed from, so spend can be re-checked against a corrected rate. */
    images: integer("images").notNull().default(0),
    characters: integer("characters").notNull().default(0),
    rawUsage: jsonb("raw_usage").$type<Record<string, unknown>>().notNull().default({}),
    rateSnapshotId: uuid("rate_snapshot_id"),
    rateSnapshot: jsonb("rate_snapshot").$type<Record<string, unknown>>(),
    estimatedCostUsd: numeric("estimated_cost_usd", { precision: 14, scale: 8 }).notNull().default("0"),
    latencyMs: integer("latency_ms").notNull().default(0),
    success: boolean("success").notNull().default(true),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("ai_usage_created_idx").on(t.createdAt), index("ai_usage_project_idx").on(t.projectId, t.createdAt)],
);

export const outbox = pgTable(
  "outbox",
  {
    id: id(),
    queue: text("queue").notNull(),
    jobName: text("job_name").notNull(),
    jobId: text("job_id").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    priority: integer("priority").notNull().default(5),
    status: text("status").$type<"pending" | "published">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    publishedAt: ts("published_at"),
    createdAt: createdAt(),
  },
  (t) => [index("outbox_pending_idx").on(t.status, t.createdAt), uniqueIndex("outbox_job_uq").on(t.queue, t.jobId)],
);

export const errorEvents = pgTable(
  "error_events",
  {
    id: id(),
    source: text("source").notNull(),
    code: text("code"),
    message: text("message").notNull(),
    requestId: text("request_id"),
    jobId: text("job_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("error_events_created_idx").on(t.createdAt)],
);

/**
 * One submission to a provider's async batch API, covering many generation jobs. A row is written before the
 * jobs are parked so a worker that dies mid-submit can find the batch it already paid for (by `idempotencyKey`,
 * which is echoed in the provider's own metadata) instead of submitting it again.
 */
export const providerBatches = pgTable(
  "provider_batches",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** The user-initiated bulk run this submission belongs to (generation_jobs.batch_id). */
    batchId: uuid("batch_id"),
    capability: text("capability").$type<"image" | "text">().notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    /** The provider's handle: an OpenAI batch id, or a Gemini `batches/...` name. */
    handle: text("handle").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    state: text("state")
      .$type<"pending" | "running" | "succeeded" | "partial" | "failed" | "expired" | "cancelled">()
      .notNull()
      .default("pending"),
    requestCount: integer("request_count").notNull().default(0),
    completedCount: integer("completed_count").notNull().default(0),
    failedCount: integer("failed_count").notNull().default(0),
    /** Files uploaded for this batch that we own and delete once it is ingested (OpenAI references). */
    ownedFileIds: jsonb("owned_file_ids").$type<string[]>().notNull().default([]),
    failureReason: text("failure_reason"),
    submittedAt: ts("submitted_at"),
    polledAt: ts("polled_at"),
    ingestedAt: ts("ingested_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("provider_batches_idempotency_idx").on(t.idempotencyKey),
    index("provider_batches_state_idx").on(t.state, t.polledAt),
    index("provider_batches_project_idx").on(t.projectId, t.createdAt),
  ],
);
