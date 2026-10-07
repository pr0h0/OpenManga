# Data model

PostgreSQL via Drizzle. 73 tables in eight schema files under `packages/db/src/schema` (`auth.ts`, `projects.ts`,
`bible.ts`, `media.ts`, `jobs.ts`, `comments.ts`, `experts.ts`, `mcp.ts`, with shared column helpers and every
`pgEnum` in `common.ts`). UUID
primary keys (a few MCP tables are keyed by a token hash or client id instead), `timestamptz` everywhere, migrations in
`packages/db/drizzle` (`0000_init.sql` … `0033_chapter_source_fingerprints.sql`). Browser-safe row types are re-exported from
`@openmanga/db/types`.

Enums (`common.ts`): `approval_status` (`draft|approved|locked|superseded`), `user_role` (`user|admin`), `user_status`
(`active|disabled`), `project_type` (`manga|manhwa|webtoon|comic|illustrated_story`), `reading_direction`
(`ltr|rtl|vertical`), `color_mode` (`full_color|grayscale|bw_manga`), `project_status` (`active|archived`),
`member_role` (`owner|editor|viewer`), `asset_type` (`character_reference`, `location_reference`,
`prop_reference`, `style_reference`, `panel_art`, `panel_mask`, `cover`, `thumbnail`, `prompt_reference`,
`source_image`, `export`, `audio`), `asset_visibility` (`private|public`), `panel_status`
(`planned|prompt-ready|queued|generating|ready|failed`), `job_status`
(`queued|submitted|awaiting_input|processing|completed|failed|cancel_requested|cancelled|paused`; `submitted` is
waiting in a provider's batch API, `awaiting_input` is a paste-mode job waiting for an answer — neither holds a worker
slot).

## Accounts (`auth.ts`)

- `users` — username and email (lower-cased, each uniquely indexed), display name, role, status, and `settings`
  (JSON `UserSettings`: per-account preferences that seed new projects, and `projectTemplates` — up to 50 saved
  project setups `{id, name, projectType, format, colorMode, language, readingDirection, stylePresetKey, customStyle,
  settings, createdAt}`, never a story, cast or files; and `channelProfiles` — up to 50 channel profiles `{id, name,
  description, preset, settings, createdAt, updatedAt}`, whose `settings` are the `PROFILE_SETTING_KEYS` subset of
  `ProjectSettings` and whose logo (`settings.video.watermark.assetId`) is an asset with no project, owned by the
  user). A project made from a profile records it in `projects.settings.channelProfile`; see
  [AI_PIPELINE](AI_PIPELINE.md#production-presets-templates-and-policies).
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
  `deleted_at` (trash), current style, cover and thumbnail (dashboard card) assets, and a `settings` JSON validated by
  `ProjectSettings` (`packages/schemas/src/editor.ts`). `project_members` carries the role (`owner|editor|viewer`;
  the owner also has a row).
- `project_invites` — an owner's invitation (migration `0024_project_invites`): project, role (`editor|viewer`), the
  invited `user_id` and/or lower-cased `email`, `token_hash` (HMAC of the emailed one-time link, unique; email
  invitations only), inviter, `expires_at` (7 days) and one of `accepted_at`, `declined_at`, `revoked_at`. Pending =
  none of those set and not expired (`docs/AUTH.md`).
- `settings` is where several important knobs live, not as columns:

  | Field | Meaning |
  | --- | --- |
  | `format` | `comic`, `film` or `vertical`. A film project is one full-frame 16:9 shot per page; creating one also applies `FILM_PAGE` (1920×1080, no margin or gutter). A vertical project is one scrolling strip and starts from `VERTICAL_PAGE` (800×1200, no margin or gutter). |
  | `budgetUsd` | Hard USD ceiling on AI spend. New projects are created with **$5**, written at creation rather than as a schema default so older projects stay uncapped. `null` = no cap. |
  | `pageWidth/Height`, `pageGutter`, `pageMargin`, `webtoon*` | Page and webtoon geometry used by the compositor. |
  | `imageQuality`, `referenceMaxWidth/Height` | Per-project overrides of the image quality and reference derivative box. |
  | `narrationVoice`, `narrationSpeed`, `narrationWordsPerPanel`, `narrationPauseMs` (350), `sceneBreakPauseMs` (700), `narrationStyle` | Narration defaults. |
  | `lettering`, `worldNotes`, `author` | Lettering defaults and project metadata. |
  | `thumbnail` | `{assetId, title, subtitle, side}` — the text-free 16:9 video thumbnail art; the headline is kept as text and composited when rendered. |
  | `contentPolicyFallback` | `{enabled, credentialId, provider, model}` — opt-in single retry of a content-policy block on another of the user's own keys. |
  | `consistencyCheck` | `{enabled, credentialId, model}` — opt-in vision QA of generated panels. |
  | `targetRuntime` | `{minutes, wordsPerMinute (150), minShotSeconds (4), maxShotSeconds (8)}` or null — a target video length. Split across chapters by source length (`runtimeBudget`, `packages/domain/src/runtime.ts`), it gives a chapter plan its default page target and narration its words per panel. |
  | `referencePolicy` | `all` (default) or `main` — `main` makes bulk reference runs skip minor characters and places or props used in fewer than two panels. |
  | `batchPolicy` | `interactive` (default), `images` (text now, images through provider batches), `hybrid` (text in batches, images now) or `cheapest` (both through provider batches) — how a production run spends; only keys whose provider has a batch API are batched. |
  | `youtubePackage` | `{titles, description, tags, pinnedComment, thumbnailHeadlines}` — the video's publishing text, written by a `youtube_package` job and then edited freely. |
  | `repurpose` | `{items: [{id, kind, label, panelIds, lengthSeconds?, aspect?, text, title, caption}]}` — the repurposing plan: Shorts, trailer, teaser (`short`/`trailer`/`teaser`, rendered as `video_shorts`), a `carousel` and `quote` images, each with its social title and caption (written by a `social_copy` job or by hand). Not carried by templates. |
  | `publishingSources` | `{youtubeText, youtubeTextAt, thumbnailTitle}` — written by the app: a fingerprint of the title and chapters the YouTube text was written from, and the project title the thumbnail headline was set for; staleness compares them (`docs/AI_PIPELINE.md`). |
  | `video` | `{fadeAtSceneBreaks, watermark, intro, outro}` — video export settings: fade to black where the scene changes (each shot can override it), a logo watermark `{assetId, corner, opacity, size}` (an image of the project) and intro/outro cards `{title, subtitle, durationMs}`. |

- `production_runs` — one run of the whole pipeline for a project (migration `0020_production_runs`): project, the
  `user_id` it acts as, `status` (`running|waiting|paused|completed|completed_with_warnings|failed|cancelled`;
  `waiting` is a review step, `paused` a budget cap or a disabled account), `steps` (JSON, in order: `key`, status
  `pending|running|review|done|skipped|failed`, a note, the generation `jobIds`, narration `audioBatchIds` or
  `exportJobId` it waits on, a `ref` a later step needs), `options` (`reviewGates`, `preparePrompts`, `render`,
  `youtube` and the run's `ai` choice), a `reason` for the person and `warnings` (JSON, migration
  `0028_production_run_warnings`; set when it finished `completed_with_warnings`: `failedJobs` (at most 500, with
  `failedJobCount`), `panelsWithoutArt`, `segmentsWithoutAudio`, `panelsNeedingReview`, `failedExports`,
  `chaptersWithoutNarration`, `failedChecks`, and `video`, what is wrong with the rendered video), and
  `lease_owner` / `lease_until` (migration `0030_production_run_lease`): the pass advancing it now, so two API
  processes never advance one run at once. Advanced by the API (`docs/ARCHITECTURE.md`).
- `share_links` — an unlisted, read-only reader link: project, optional chapter (null = the whole project), a
  random `token` (unique), creator, `revoked_at`. Served without a session under `/api/public/shares/:token`
  (`docs/SECURITY.md`).
- `panel_comments` — comment threads on panels (migration `0025_panel_comments`): project, panel (cascade, so
  re-planning a chapter's pages removes their comments with them), `thread_id` (null for a thread's first comment,
  else that comment's id), author, plain-text `body`, `mentions` (member ids resolved when written), `resolved_at` /
  `resolved_by_user_id` on the first comment, `edited_at`, and `deleted_at` for a first comment deleted while it has
  replies (its body is blanked; any other deleted comment is removed). `via_agent` and `via_service_id` (migration
  `0034_comment_agent_source`) say a comment was written through an agent connection and which one (`user_services`,
  set null if the connection is deleted, while `via_agent` stays true); `resolved_via_agent` and
  `resolved_via_service_id` do the same for resolving. Migration `0035_better_comments` adds, on a thread's first
  comment, `anchor` (`{x, y}`: a spot on the panel's artwork as fractions of its width and height), `timecode_ms` (a
  moment of the chapter's video preview), `assignee_user_id`, and `artwork_asset_id` / `resolved_artwork_asset_id` (the
  panel's active artwork when the thread was started and when it was resolved: before and after a fix; no foreign key,
  the art may be deleted later); and `guest_name` / `share_id` for a comment left through a reader link (no author).
- `share_links.allow_comments` (also `0035`) — whoever opens the link may comment under a name.
- `notifications` — one user's notice: user, project, `kind` (`mention|reply|assigned|guest`: mentioned, a reply in
  your thread, a thread assigned to you, a guest's comment through a reader link), comment, actor (none for a guest),
  `read_at`.
- `story_revisions` — immutable once `locked_at` is set (analyses reference them); editing a locked revision forks a
  new one. Unique per `(project, revision_number)`.
- `story_analyses` — the validated `StoryAnalysis` JSON for one revision; `pending → completed → applied` (or
  `failed`).

## Structure (`projects.ts`, `media.ts`)

- `chapters` — order, title, summary, source excerpt, and **chapter memory**: opening/closing state, character and
  location state changes, revealed facts, beats, `last_plan` (the `ChapterPlan`) and `plan_status`, and
  `plan_fingerprint` / `narration_fingerprint` (migration `0033_chapter_source_fingerprints`, backfilled for chapters
  already planned or narrated): md5 of what the plan and the narration were made from, which staleness compares with
  the current ones (`docs/ARCHITECTURE.md`).
- `scenes` (location, time, weather, characters, purpose/opening/progression/climax/ending, continuity notes,
  initial/final state, continuity deltas) and `story_beats` (ordered within a scene).
- `pages` — order, purpose, pacing, visual emphasis, page-turn hook, layout template key, pixel width/height, optional
  reading-direction override, approval status.
- `panels` — normalized `frame`, `image_transform` (focal point + scale, the crop shown on the page), `shot_type` and
  `camera_angle` (free text), `story_beat`, `location_version_id`, `character_version_ids`, `prop_version_ids`,
  `active_artwork_asset_id`, `status`, approval status, plus four prompt and QA fields:
  `prompt_override` (text, a user-edited prompt), `prompt_draft` (JSON, the sections written by the `page_prompts`
  job), `qa` (JSON, the latest consistency check of the active artwork: verdict, problems, the visual checks
  asked and failed, each aspect's verdict, cast and headcount, face boxes used to move bubbles off faces, and `autoFix`
  — the re-roll it queued or why not; marked `stale` when newer artwork replaced the checked one) and
  `review` (JSON `{reason, message, at}`, set when the artwork needs a human look — for example because it came from the
  content-policy fallback provider). `planned_lettering` (JSON `{dialogue, sfx}`) holds the chapter plan's dialogue
  (speakers resolved to characters) and SFX when automatic lettering was off, until Editor → Lettering → *Letter from
  plan* places them and clears it. `seam` (JSON) is how a vertical strip panel meets the one before it. `video`
  (JSON `ShotVideo`, migration `0021_video_shots`: `motion`, `fade`, `disabled`, `holdMs`; null = defaults) is the panel as a
  video shot (`docs/VIDEO_EXPORT_REFERENCE.md`). `guide` (JSON `{assetId, strength}`, migration `0026_panel_guide`) is
  the layout sketch sent with its generation (`docs/IMAGE_REFERENCES.md`).
- `experts` (a user's own experts), `expert_chats` (a chat, its own copy of the system prompt, an optional
  project) and `expert_messages` (role, text, status `done|pending|awaiting_input|failed`, attached and generated
  image asset ids, options such as `generateImage` and the reply's `imagePrompt`); see `docs/AI_PIPELINE.md`.
- `panel_specs` — versioned `PanelSpec` documents, unique per `(panel, version_number)`, authored by AI or user.
- `dialogue_lines` (vector `Bubble`), `sound_effects` (`SfxStyle`), `narration_lines` (per `language`, so one chapter
  can carry several narration tracks over the same artwork; optional on-page box; `video` JSON
  `{untilPanelId, startOffsetMs, endOffsetMs}` stretches the line over several video shots) → `narration_segments` (TTS units:
  text, `text_sha256` (of the spoken text: the text with the project's pronunciation dictionary applied), voice/speed
  overrides, `pause_after_ms`, active audio asset).
- `narration_findings` — narration QA findings per chapter track: `source` (`rule`, `ai` or `audio`), `kind`, `severity`,
  `line_ids`, `related_chapter_ids`, `message`, `status` (`open|ignored|fixed`) and a `fingerprint` unique per
  `(chapter, language, source)`, which is how a re-run keeps an ignored finding ignored.

## Cast & world (`projects.ts`)

- `characters`, `locations` and `props` carry `deleted_at` (trash). Trashing one also trashes its reference images
  with the same timestamp, so restoring it brings back exactly those images.
- `characters` → `character_versions` (bible JSON, `immutable_traits`, status, parent version, change note) +
  `character_aliases` + `character_outfits`. `outfit_assignments` (in `media.ts`) sets an outfit on a panel,
  `onward` (until the next change, in reading order) or for that `panel` only; see `docs/IMAGE_REFERENCES.md`.
- `locations` → `location_versions`, `props` → `prop_versions` — same versioning shape.
- `style_presets` (built-in and custom) and `project_styles` (the versioned project style).
- `reference_assets` — links one canonical asset to exactly one subject version (character, location, prop or style),
  with `kind` (`portrait`, `full_body`, `multi_angle`, `expression_sheet`, `outfit`, `location`,
  `location_panorama`, `location_sheet`, `prop`, `prop_multi_angle`, `style`, `uploaded`), an optional outfit,
  approval status, `is_primary`, and `source_fingerprint` — a hash of the subject version's
  prompt-visible description when the reference was made, which is how staleness is detected
  (`docs/AI_PIPELINE.md`).

## Story bible (`bible.ts`)

Migration `0029_story_bible`. Chapter references are by chapter id and read in the chapters' current order, so a
range moves with its chapters; deleting a chapter leaves the range open on that side. `source` is `user`,
`extracted` (saved from a reviewed `bible_extract` job) or `continuity`.

- `bible_facts` — project, `kind` (`character|relationship|power|organisation|place|object|term|rule`), `subject`
  (who or what by name; empty for the whole story), `text`, `fixed` (a rule that must hold), `visual` (can be seen,
  so it reaches image prompts), `from_chapter_id` and `until_chapter_id` (inclusive; null = open), `source`, author.
- `character_states` — one entry of a character's state timeline: project, character (cascade), `kind`
  (`injury|look|outfit|item|location|rank|knowledge|other`), `text`, `chapter_id` (null = from the start),
  `scene_number` (1-based within that chapter; null = its start), `until_chapter_id`, `outfit_id` (one of the
  character's outfits, for an outfit state), `source`, author. A later look, outfit, location or rank replaces the
  earlier one; the other kinds hold until `until_chapter_id`.
- `continuity_findings` — a contradiction a `continuity_check` job found (migration `0031_continuity_findings`):
  project, chapter (cascade), the job, `severity` (`high|medium|low`), `message`, `quote` (the offending line or
  beat), `evidence` (what it contradicts), `place` (JSON `{ref, panelId, pageId, narrationLineId, sceneNumber}`:
  where to fix it), `fact_id` (the bible fact it breaks), `status` (`open|fixed|ignored|explained`), `resolution`
  (why ignored, or the explaining fact's text), resolver and time. A new check of a chapter replaces its open
  findings and skips any it finds again that was ignored or explained (same place and quote). Each fixed rule's
  verdict is kept on the job's result (`rules: [{factId, verdict, note}]`).

## Assets (`media.ts`)

- `assets` — one abstraction for every file: owner, project, `type`, visibility, opaque `storage_key` (unique), MIME,
  dimensions and duration, byte size, **SHA-256**, approval status, `parent_asset_id` (edit lineage),
  `generation_job_id`, metadata, soft delete (`deleted_at`; a trashed asset is served only to trash views, see
  `docs/STORAGE.md`). Images in expert chats have no project and belong to their owner alone.
- `asset_variants` — disposable derivatives (`thumbnail`, `preview`, `prompt_ref`, `web`, `export`) with a unique
  deterministic `cache_key`, the params that produced them, and `last_used_at` for retention.
- `audio_assets` — cached TTS output keyed by `(project, text_sha256, voice, speed)` with language, provider/model
  version, sample rate and duration.

## Jobs, usage, exports (`jobs.ts`)

- `generation_jobs` — `kind` (`story_analysis`, `story_rewrite`, `chapter_plan`, `page_prompts`, `narration_text`,
  `character_reference`, `location_reference`, `prop_reference`, `style_reference`, `panel_generation`, `panel_edit`,
  `panel_check`, `cover`, `thumbnail`, `youtube_package`, `image_describe`, `narration_lint`, `narration_fix`, `audio_check`, `story_coverage`, `image_batch_submit`, `text_batch_submit`,
  `expert_extract`, `bible_extract`, `continuity_check`, `narration_retime`, `social_copy`), its project (null only for an `expert_extract` from a chat about no project, which only its
  owner can read), queue, priority, status, batch, target type/id, attempts and `max_attempts`, failure code/reason, provider/model,
  provider request id, template name/version, compiled prompt, prompt/reference/options hashes, parameters (including
  the run's `ai` choice), input, result, timings, `cancel_requested_at`, and `retried_by_job_id` — set when a retry
  created a replacement, so a poller can tell a handled failure apart.
- `generation_inputs` — the exact asset and variant ids sent, with `role` (`target`, `mask`, `character_ref`,
  `location_ref`, `prop_ref`, `style_ref`, `layout_guide`, `previous_panel`), order, label, sent dimensions and derivative metadata.
  `generation_outputs` — produced assets with an `activated` flag.
- `prompt_templates` / `prompt_versions` — synced from code on boot, body plus SHA-256 (`docs/PROMPT_SYSTEM.md`).
- `audio_jobs` — one TTS request: segment target, options (including its `ai` choice), status, attempts, resulting
  audio asset and a `reused_cache` flag.
- `export_jobs` and `exports` — `kind` is one of `png_pages`, `jpg_pages`, `pdf`, `cbz`, `epub`, `webtoon`,
  `zip_package`, `project_json`, `narration_audio`, `timeline`, `agent_package`, **`video_pages`**, **`video_panels`**, **`video_shorts`**,
  `youtube_package` (the newest finished video of the scope with its subtitles, chapter timestamps, thumbnail and
  publishing text, zipped), `carousel` and `quote_image` (repurposed stills, see `docs/VIDEO_EXPORT_REFERENCE.md`), `print_cover` and
  `print_preflight` (the cover's sizes and issues in `result.cover`, the preflight report in `result.preflight`; see
  `docs/PRINT.md`), `psd_pages` and `layered_package` (layered files for finishing, see `docs/DEPLOYMENT.md`),
  and `project_import` (an import reuses the export job machinery and reports
  `{projectId, warnings}` in `result`; a video render keeps its `series`, the `sectionKeys` of its cached sections and
  `sections: {reused, encoded}` there). Options (for example a PDF's `pageSize`, including the `kdp_*` trim sizes) are JSON on the
  job. `exports` holds the produced file asset, its name and `expires_at` (30 days after it was made). Deleting an
  export removes its job row and file at once.
- `ai_usage` — provider, model, operation, request id, token counts (text in/out, image in/out, cached), billable
  `images` and `characters`, raw usage JSON, the rate snapshot used, estimated cost, latency, success, metadata.
- `provider_rate_snapshots` — editable per-model rates with effective dates: text in/out and cached input and image
  in/out in USD per 1M tokens, plus `image_unit_rate` in USD per generated image for providers that bill a flat price
  per image and `character_rate` in USD per 1M characters for speech providers.
- `provider_batches` — one submission to a provider's async batch API covering many jobs of a bulk run: capability
  (`image|text`), provider, model, the provider's handle, a unique idempotency key, state
  (`pending|running|succeeded|partial|failed|expired|cancelled`), request/completed/failed counts, uploaded file ids to
  clean up, and submit/poll/ingest times.
- `outbox` — transactional queue publication: queue, job name, job id (unique per queue), payload, priority, status
  `pending|published`, attempts, last error.
- `error_events` — captured server errors for the admin view.
- `instance_settings` — server-wide settings an admin changes at runtime, one jsonb `value` per `key`, with who
  changed it and when. `budget` holds `{ monthlyUsd }`, the monthly AI spend ceiling (`null` for none). No row means
  the env default applies.

## Agent access (`mcp.ts`)

What the MCP server (see [MCP](MCP.md)) stores. Tokens and codes are kept only as HMACs.

- `user_services` — a connected agent: its user, kind (`oauth` | `pat`), name, OAuth client id, scopes, project access
  (`all` | `selected`), `allow_project_create`, approval mode (`ALLOW_ALL` | `REQUIRE_APPROVAL`), last use, revocation.
- `user_service_projects` — the projects a `selected` connection may touch.
- `personal_access_tokens` — `om_pat_…` HMACs, last four characters, expiry, last use, revocation.
- `oauth_clients` — dynamically registered clients (`oc_…`) and fetched Client ID Metadata Documents (the id is the
  document URL): name and exact redirect URIs.
- `oauth_authorization_requests` — an authorization request frozen on arrival (client, redirect, state, PKCE challenge,
  resource, scopes); consent refers to it by id and completes it once.
- `oauth_authorization_codes`, `oauth_access_tokens`, `oauth_refresh_tokens` — single-use codes; access and refresh
  tokens bound to client, connection, resource and scopes; refresh tokens grouped in families for rotation and reuse
  detection.
- `mcp_approval_requests` — a parked call: tool, action key, sensitivity, summary, stored arguments and their hash,
  idempotency key, target snapshot, estimate, status
  (`pending|approved|denied|expired|stale|executed|failed|execution_unknown`), result or error. At most one `pending`
  request per identical call; an `approved` request interrupted mid-run becomes `execution_unknown` and is never re-run.
- `mcp_approval_rules` — remembered decisions, unique per `(connection, project, action key)`.
- `mcp_idempotency` — a caller's idempotency key per `(connection, tool, key)`, claimed before the call runs: state
  (`running|pending_approval|completed`), the arguments hash, the result to replay.
- `audit_events.service_id` — the connection an audited action came through (null for the browser).

## Indexes

Project by owner and update time; chapter, scene, page, panel and beat ordering; generation jobs by status, project,
target and batch; assets by project and type; unique `storage_key` and variant `cache_key`; usage by created-at and by
project; unique session token hash; unique `(provider, provider_subject)`; narration lines by
`(chapter, language, order)`; audio cache by `(project, text hash, voice, speed)`; outbox by `(status, created_at)`
and unique `(queue, job_id)`; unique share-link token; production runs by `(project, created_at)` and by status;
unique provider-batch idempotency key; every `*_versions` table unique on `(subject, version_number)`.

## Interchange format

`ProjectInterchange` (`packages/schemas/src/interchange.ts`, `schemaVersion: 1`) is the stable export and import
format: references and a manifest of assets by id, never raw database rows. The story bible travels in `bible`
(facts and states with chapters, characters and outfits by ref); a package written before it imports with none. It backs the `zip_package`,
`project_json` and `project_import` kinds.
