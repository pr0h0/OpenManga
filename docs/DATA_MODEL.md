# Data model

PostgreSQL via Drizzle. 48 tables in four schema files under `packages/db/src/schema` (`auth.ts`, `projects.ts`,
`media.ts`, `jobs.ts`, with shared column helpers and every `pgEnum` in `common.ts`). UUID primary keys, `timestamptz`
everywhere, migrations in `packages/db/drizzle` (`0000_init.sql` … `0007_retried_by_job.sql`). Browser-safe row types
are re-exported from `@openmanga/db/types`.

Enums (`common.ts`): `approval_status` (`draft|approved|locked|superseded`), `user_role` (`user|admin`), `user_status`
(`active|disabled`), `project_type` (`manga|manhwa|webtoon|comic|illustrated_story`), `reading_direction`
(`ltr|rtl|vertical`), `color_mode` (`full_color|grayscale|bw_manga`), `project_status` (`active|archived`),
`member_role` (`owner|editor|viewer`), `asset_type`, `asset_visibility` (`private|public`), `panel_status`
(`planned|prompt-ready|queued|generating|ready|failed`), `job_status`
(`queued|processing|completed|failed|cancel_requested|cancelled|paused`).

## Accounts (`auth.ts`)

- `users` — username and email (lower-cased, each uniquely indexed), display name, role, status.
- `auth_identities` — `(provider, provider_subject)` unique; only `local` rows are written today (`docs/AUTH.md`).
- `password_credentials` — Argon2id hash, one row per user. `sessions` — HMAC-SHA256 of an opaque token (unique),
  expiry, last use, IP, user agent, revoked.
- `password_reset_tokens` — hashed one-time tokens with expiry and `used_at`. `dev_emails` — mocked outbound mail.
- `provider_credentials` — a user's own provider API key: `kind`, `label`, optional `base_url`, `encrypted_key`
  (AES-256-GCM, see `docs/SECURITY.md`), `key_hint` (the last four characters — the only part ever returned),
  `last_used_at`.
- `audit_events` — actor, action, target, metadata, optional project.

## Projects & story (`projects.ts`)

- `projects` — owner, type, language, reading direction, colour mode, `status` (`active|archived`), soft delete via
  `deleted_at` (trash), current style, cover and thumbnail assets, and a `settings` JSON validated by
  `ProjectSettings` (`packages/schemas/src/editor.ts`). `project_members` carries the role.
- `settings` is where several important knobs live, not as columns:

  | Field | Meaning |
  | --- | --- |
  | `format` | `comic` or `film`. A film project is one full-frame 16:9 shot per page; creating one also applies `FILM_PAGE` (1920×1080, no margin or gutter). |
  | `budgetUsd` | Hard USD ceiling on AI spend. New projects are created with **$5**, written at creation rather than as a schema default so older projects stay uncapped. `null` = no cap. |
  | `pageWidth/Height`, `pageGutter`, `pageMargin`, `webtoon*` | Page and webtoon geometry used by the compositor. |
  | `imageQuality`, `referenceMaxWidth/Height` | Per-project overrides of the image quality and reference derivative box. |
  | `narrationVoice`, `narrationSpeed`, `narrationWordsPerPanel`, `narrationPauseMs` (350), `sceneBreakPauseMs` (700), `narrationStyle` | Narration defaults. |
  | `lettering`, `worldNotes`, `author` | Lettering defaults and project metadata. |
  | `contentPolicyFallback` | `{enabled, credentialId, provider, model}` — opt-in single retry of a content-policy block on another of the user's own keys. |
  | `consistencyCheck` | `{enabled, credentialId, model}` — opt-in vision QA of generated panels. |

- `story_revisions` — immutable once `locked_at` is set (analyses reference them); editing a locked revision forks a
  new one. Unique per `(project, revision_number)`.
- `story_analyses` — the validated `StoryAnalysis` JSON for one revision; `pending → completed → applied` (or
  `failed`).

## Structure (`projects.ts`, `media.ts`)

- `chapters` — order, title, summary, source excerpt, and **chapter memory**: opening/closing state, character and
  location state changes, revealed facts, beats, `last_plan` (the `ChapterPlan`) and `plan_status`.
- `scenes` (location, time, weather, characters, purpose/opening/progression/climax/ending, continuity notes,
  initial/final state, continuity deltas) and `story_beats` (ordered within a scene).
- `pages` — order, purpose, pacing, visual emphasis, page-turn hook, layout template key, pixel width/height, optional
  reading-direction override, approval status.
- `panels` — normalized `frame`, `image_transform` (focal point + scale, the crop shown on the page), `shot_type` and
  `camera_angle` (free text), `story_beat`, `location_version_id`, `character_version_ids`, `prop_version_ids`,
  `active_artwork_asset_id`, `status`, approval status, plus four prompt and QA fields:
  `prompt_override` (text, a user-edited prompt), `prompt_draft` (JSON, the sections written by the `page_prompts`
  job), `qa` (JSON, the latest consistency check of the active artwork) and `review` (JSON
  `{reason, message, at}`, set when the artwork needs a human look — for example because it came from the
  content-policy fallback provider). `planned_lettering` (JSON `{dialogue, sfx}`) holds the chapter plan's dialogue
  (speakers resolved to characters) and SFX when automatic lettering was off, until Editor → Lettering → *Letter from
  plan* places them and clears it. `seam` (JSON) is how a vertical strip panel meets the one before it.
- `experts` (a user's own experts), `expert_chats` (a chat, its own copy of the system prompt, an optional
  project) and `expert_messages` (role, text, status `done|pending|awaiting_input|failed`, attached and generated
  image asset ids, options such as `generateImage` and the reply's `imagePrompt`); see `docs/AI_PIPELINE.md`.
- `panel_specs` — versioned `PanelSpec` documents, unique per `(panel, version_number)`, authored by AI or user.
- `dialogue_lines` (vector `Bubble`), `sound_effects` (`SfxStyle`), `narration_lines` (per `language`, so one chapter
  can carry several narration tracks over the same artwork; optional on-page box) → `narration_segments` (TTS units:
  text, `text_sha256`, voice/speed overrides, `pause_after_ms`, active audio asset).

## Cast & world (`projects.ts`)

- `characters` → `character_versions` (bible JSON, `immutable_traits`, status, parent version, change note) +
  `character_aliases` + `character_outfits`. `outfit_assignments` (in `media.ts`) sets an outfit on a panel,
  `onward` (until the next change, in reading order) or for that `panel` only; see `docs/IMAGE_REFERENCES.md`.
- `locations` → `location_versions`, `props` → `prop_versions` — same versioning shape.
- `style_presets` (built-in and custom) and `project_styles` (the versioned project style).
- `reference_assets` — links one canonical asset to exactly one subject version (character, location, prop or style),
  with `kind` (`portrait`, `full_body`, `multi_angle`, `expression_sheet`, `outfit`, `location`, `prop`, `style`,
  `uploaded`), approval status, `is_primary`, and `source_fingerprint` — a hash of the subject version's
  prompt-visible description when the reference was made, which is how staleness is detected
  (`docs/AI_PIPELINE.md`).

## Assets (`media.ts`)

- `assets` — one abstraction for every file: owner, project, `type`, visibility, opaque `storage_key` (unique), MIME,
  dimensions and duration, byte size, **SHA-256**, approval status, `parent_asset_id` (edit lineage),
  `generation_job_id`, metadata, soft delete.
- `asset_variants` — disposable derivatives (`thumbnail`, `preview`, `prompt_ref`, `web`, `export`) with a unique
  deterministic `cache_key`, the params that produced them, and `last_used_at` for retention.
- `audio_assets` — cached TTS output keyed by `(project, text_sha256, voice, speed)` with language, provider/model
  version, sample rate and duration.

## Jobs, usage, exports (`jobs.ts`)

- `generation_jobs` — `kind` (`story_analysis`, `story_rewrite`, `chapter_plan`, `page_prompts`, `narration_text`,
  `character_reference`, `location_reference`, `prop_reference`, `style_reference`, `panel_generation`, `panel_edit`,
  `panel_check`, `cover`), queue, priority, status, batch, target type/id, attempts and `max_attempts`, failure
  code/reason, provider/model, provider request id, template name/version, compiled prompt, prompt/reference/options
  hashes, parameters (including the run's `ai` choice), input, result, timings, `cancel_requested_at`, and
  `retried_by_job_id` — set when a retry created a replacement, so a poller can tell a handled failure apart.
- `generation_inputs` — the exact asset and variant ids sent, with `role` (`target`, `mask`, `character_ref`,
  `location_ref`, `prop_ref`, `style_ref`, `previous_panel`), order, label, sent dimensions and derivative metadata.
  `generation_outputs` — produced assets with an `activated` flag.
- `prompt_templates` / `prompt_versions` — synced from code on boot, body plus SHA-256 (`docs/PROMPT_SYSTEM.md`).
- `audio_jobs` — one TTS request: segment target, options (including its `ai` choice), status, attempts, resulting
  audio asset and a `reused_cache` flag.
- `export_jobs` and `exports` — `kind` is one of `png_pages`, `jpg_pages`, `pdf`, `webtoon`, `zip_package`,
  `project_json`, `narration_audio`, `timeline`, `agent_package`, **`video_pages`**, **`video_panels`**, and
  `project_import` (an import reuses the export job machinery and reports `{projectId, warnings}` in `result`).
  `exports` holds the produced file asset, its name and `expires_at`.
- `ai_usage` — provider, model, operation, request id, token counts (text in/out, image in/out, cached), raw usage
  JSON, the rate snapshot used, estimated cost, latency, success, metadata.
- `provider_rate_snapshots` — editable per-model rates with effective dates: text in/out and cached input and image
  in/out in USD per 1M tokens, plus `image_unit_rate` in USD per generated image for providers that bill a flat price
  per image.
- `outbox` — transactional queue publication: queue, job name, job id (unique per queue), payload, priority, status
  `pending|published`, attempts, last error.
- `error_events` — captured server errors for the admin view.

## Agent access (`mcp.ts`)

What the MCP server (see [MCP](MCP.md)) stores. Tokens and codes are kept only as HMACs.

- `user_services` — a connected agent: its user, kind (`oauth` | `pat`), name, OAuth client id, scopes, project access
  (`all` | `selected`), `allow_project_create`, approval mode (`ALLOW_ALL` | `REQUIRE_APPROVAL`), last use, revocation.
- `user_service_projects` — the projects a `selected` connection may touch.
- `personal_access_tokens` — `om_pat_…` fingerprints, last four characters, expiry, last use, revocation.
- `oauth_clients` — dynamically registered clients (`oc_…`) and fetched Client ID Metadata Documents (the id is the
  document URL): name and exact redirect URIs.
- `oauth_authorization_requests` — an authorization request frozen on arrival (client, redirect, state, PKCE challenge,
  resource, scopes); consent refers to it by id and completes it once.
- `oauth_authorization_codes`, `oauth_access_tokens`, `oauth_refresh_tokens` — single-use codes; access and refresh
  tokens bound to client, connection, resource and scopes; refresh tokens grouped in families for rotation and reuse
  detection.
- `mcp_approval_requests` — a parked call: tool, action key, sensitivity, summary, stored arguments and their hash,
  idempotency key, target snapshot, estimate, status (`pending|approved|denied|expired|stale|executed|failed`), result or
  error.
- `mcp_approval_rules` — remembered decisions, unique per `(connection, project, action key)`.
- `mcp_idempotency` — results under a caller's idempotency key per `(connection, tool, key)`, with the arguments hash.
- `audit_events.service_id` — the connection an audited action came through (null for the browser).

## Indexes

Project by owner and update time; chapter, scene, page, panel and beat ordering; generation jobs by status, project,
target and batch; assets by project and type; unique `storage_key` and variant `cache_key`; usage by created-at and by
project; unique session token hash; unique `(provider, provider_subject)`; narration lines by
`(chapter, language, order)`; audio cache by `(project, text hash, voice, speed)`; outbox by `(status, created_at)`
and unique `(queue, job_id)`; every `*_versions` table unique on `(subject, version_number)`.

## Interchange format

`ProjectInterchange` (`packages/schemas/src/interchange.ts`, `schemaVersion: 1`) is the stable export and import
format: references and a manifest of assets by id, never raw database rows. It backs the `zip_package`,
`project_json` and `project_import` kinds.
