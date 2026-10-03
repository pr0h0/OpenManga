# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Published container images track tagged releases.

## [Unreleased]

Upgrading: four migrations: `0028_production_run_warnings` adds a nullable JSON column, `0029_story_bible` adds the
story bible's two tables, `0030_production_run_lease` two nullable columns to `production_runs` and
`0031_continuity_findings` the continuity findings.

### Added

- **Story bible.** A Bible page in each project holds facts (character, relationship, power, organisation, place,
  object, term or rule; a subject; an optional chapter range; *fixed* for rules that must hold, *visual* for what
  can be seen) and a per-character state timeline (injury, look, outfit in force, item, location, rank, knowledge,
  from a chapter and scene on). **Extract from story** is a text job (`bible-extract` v1, paste mode works) that
  proposes facts and states from the chapters and their memory for review; nothing is saved until you apply what you
  keep. Chapter planning (`page-planning` v7 and its shot, strip and split-pass versions), panel prompts
  (`panel-prompts` v5) and narration (`narration` v6) now receive the entries in effect at that chapter or scene,
  about who and what they concern; panel images (`panel-generation` v12) get the visible ones in a `STORY CANON`
  section, and an outfit state that names an outfit dresses the character in it wherever no panel sets another. The
  bible is copied with a duplicated project and kept in project exports and imports. MCP: `get_story_bible`,
  `manage_story_bible`, `run_bible_extraction`, `apply_bible_extraction`.
- **Continuity check.** The Bible page's *Continuity* tab checks one chapter or all of them (a `continuity_check`
  text job per chapter, `continuity-check` v1, priced before it runs, budget-gated, batches and paste mode work):
  each chapter's scenes, panel specs, dialogue and narration are compared with the bible in effect there and with the
  chapters around it. Contradictions land in a queue with severity, the quoted line or beat, the entry it breaks and a
  link to the panel, narration or chapter: mark them fixed, ignore them with a reason (a later check does not raise
  them again) or explain them with a new bible fact. *Rule checks* lists every fixed rule as pass, warn or fail per
  chapter from the latest check. Checked by text only; the artwork is not looked at. MCP: `run_continuity_check`,
  `get_continuity_report`.

- **Pronunciation dictionary.** Project settings → Pronunciation maps names and terms to how the narrator says them
  ("Qi" → "chee", "Seo Jinhyeok" → "suh jin-hyuk"), with match-case and whole-word options and a preview in the
  project's voice. It applies only to the text sent to the voice, for every TTS provider: narration, subtitles and
  lettering keep the written form. Changing it marks the audio of the affected segments stale, so the next synthesis
  re-voices only those. Saved in `settings.pronunciation` (also through `update_project` over MCP) and carried by
  project templates.

### Changed

- **Stopping a production run cancels its queued jobs.** Stop used to end only the orchestration while the jobs the
  run had queued kept running and spending. It now also cancels its generation jobs that have not started (queued,
  in a provider batch, paused or waiting for an answer), its queued narration audio and an unfinished export; jobs
  already running at a provider finish and nothing further happens with them. The Stop dialog shows how many jobs
  would be cancelled and offers *Stop the run only* (`{ "jobs": false }` on the API, `jobs: false` on the
  `cancel_production_run` MCP tool).

### Fixed

- **Production runs are safe with several API processes.** A run was guarded against two passes at once by an
  in-memory set, so two `api` replicas (or a stale process) could advance the same run twice and queue its work
  twice. A pass now holds a lease on the run's row (`lease_owner`, `lease_until`), extended while it works and
  released when it returns; an expired lease is taken over, and a pass no longer overwrites a run stopped meanwhile.

- **A production run with failures no longer ends as plain completed.** A run that reached the end while some steps
  had noted failures ("3 of 400 failed") reported `completed`. It now finishes `completed_with_warnings` with a
  summary of what is unresolved: failed jobs nobody retried, panels without artwork, narration segments without
  current audio, panels needing review and failed exports. The run card shows "Finished with N unresolved items"
  with links and **Retry failed**, **Review** and **Render anyway**; `get_production_run` returns the `warnings`. A
  failed render no longer fails the whole run: it is listed with the rest.
- **A production run's audio step checks the audio.** It used to finish as soon as no narration job was queued or
  running, so a segment whose synthesis failed passed silently. It now also checks every segment has current audio
  (the same definition as the audio stage of *What is out of date*): segments it never queued are queued once more,
  and failed ones are noted on the step and listed in the run's warnings instead of being retried forever. The
  chapter synthesize route takes an optional `segmentIds`.

## [0.13.0] — 2026-10-03

Upgrading: pull the new images and restart. Seven migrations (`0021`–`0027`) run on start through the migrate service;
`0027` is data only and fills in the panel id on artwork drawn through provider batches, so it shows in Versions.
Reload open tabs to get the new web app. Also worth knowing:

- The default rate limits rise to 2000 requests a minute for a signed-in user and 750 per MCP connection; requests
  without a session get their own `RATE_LIMIT_ANON_PER_MINUTE` (300). Set them in `.env` to keep other values.
- The nginx image now renders its config from a template (only `ASSET_CSP_ORIGIN`, needed with `STORAGE_DRIVER=s3`),
  and the worker's health heartbeat moved to the container's own `/tmp`: use the new `docker-compose.yml`.
- New optional settings: `WORKER_QUEUES`, `RENDER_WORKER_CONCURRENCY`, `BATCH_MAX_IN_FLIGHT_IMAGE` /
  `BATCH_MAX_IN_FLIGHT_TEXT`, `INSTANCE_BUDGET_USD_MONTHLY`, and the `STORAGE_DRIVER` / `S3_*` storage settings
  (local disk stays the default). See `.env.example`.

Upgrading: run migrations (`0021_video_shots` adds two nullable JSON columns, `0022_instance_settings` a table for the server budget ceiling, `0023_expert_extract_jobs` lets a generation job have no project, `0024_project_invites` a table for invitations, `0025_panel_comments` tables for comments and notifications, `0026_panel_guide` a nullable JSON column for layout guides).

### Added

- **Type a pose for a layout guide.** *Pose, in words* under a panel's guide takes the pose as text (e.g. "standing
  centred, hands on hips"), no AI needed. `panel-generation` v11 puts it in the `POSE / LAYOUT` section beside the
  sketch, so it outranks the written composition like a strict sketch does. *Describe pose* now fills this text
  instead of the composition. Agents set it as `guide.pose` with `update_panel`.
- **Describe pose from a sketch.** *Describe pose* beside a panel's layout guide runs a vision job (the new `pose`
  aspect of `image-describe` v2, also on the Describe page) that puts the sketch's poses, placement and framing into
  one sentence. You review and edit it, then it is added to the guide's pose text or replaces it; nothing is
  written before you confirm. It is a normal queued text job: in Generation, priced, budget-gated, paste mode
  included. `POST /api/panels/:id/guide/describe`; agents use `run_panel_check` with `action: "describe_guide"`.
- **Pose and sketch guides.** A panel can carry a layout guide: upload a rough sketch, stick-figure pose or
  composition thumbnail in the panel inspector, or draw one there (pen in three widths, straight lines, eraser,
  undo/redo, posable stick figures, the panel's art faintly underneath for tracing; mouse, pen or touch). Generate
  and Regenerate attach it as a reference after the identity, location, prop and style references and before
  the previous panel, and the prompt (`panel-generation` v9) tells the model to take its composition, framing and
  poses only, loosely or strictly, never its drawing style or any text. Masked edits leave it out. Duplicating a
  panel or project keeps it, the interchange export and import carry it, and agents set or clear it with
  `update_panel` (`guide`, pointing at any image of the project). New routes: `POST /api/panels/:id/guide`, and
  `guide` on `PATCH /api/panels/:id`.
- **A revised story is re-analysed safely.** When the story was revised after its analysis, *Update production* (and
  a plain production run) analyses the new revision and then always stops for review, even with review gates off. The
  review, on the run card and the Story page, shows what would change: chapters added, renamed, no longer in the story
  or whose text changed, with their pages and artwork, and characters, places and props added or no longer mentioned.
  Applying keeps every existing chapter with its pages (matched by title, else by position), inserts new chapters in
  place and removes nothing; anything the story dropped can be ticked for removal, which a confirmation lists before
  it happens. The run then plans and produces the new chapters. Agents read the same changes with
  `get_story_analysis` `diff: true`.
- **Project members.** An owner invites people by username or email as editors or viewers (**Members** on the
  project overview); an invited account accepts or declines on the dashboard, and an emailed link (one-time, 7 days)
  accepts it or creates the account for that address, even with registration closed. Owners change roles, remove
  members and revoke invitations; members can leave. Projects shared with you show on the dashboard marked *Shared*.
  Membership changes are audited and update open project pages live; a removed member is sent back to the dashboard.
  Agent connections reach shared projects with the member's role.
- **Production runs for agents.** MCP tools to read what is out of date (`get_staleness`), start a production run
  or *Update production*, read a run, continue it past a review and stop it. Starting, updating and continuing spend
  the user's credits, so they wait for approval on "Ask me first" connections. `GET /api/production-runs/:id` reads
  one run.
- **Panel comments.** Every member of a project, viewers included, can start a comment thread on a panel, reply,
  edit or delete their own comments, resolve and reopen threads, and @mention a member. Comments are in the page
  editor's new **Comments** tab (and under the canvas on a phone), with open-thread badges on panels and pages, and a
  project's **Comments** page lists open (or resolved) threads per project or chapter. A bell in the header counts
  unread mentions and replies. Comments update live over the project's events. Agents get `list_comments` and
  `post_comment`.
- **Incremental rendering and Update production.** Every rendered shot and card is kept as a cached section, keyed by
  a hash of everything that decides its pixels and length; the next render copies unchanged sections in and encodes
  only what changed, then re-mixes and normalises the audio over the whole film as before. Sections go with the
  exports that used them, when they expire, or when a newer render of the same video no longer uses them, and they
  count toward the project's disk use (*Video render cache*). The production run card shows what is out of date from
  story to video, and **Update production** runs only those steps, redrawing artwork whose panel was edited after it
  was drawn.
- **Vertical and square video, and a Shorts cut.** Every video export (and the preview) takes a shape: 16:9, 9:16
  or 1:1. Vertical and square frames crop each panel's existing art around its focal point; nothing is generated at
  the new shape. A new *Shorts* export renders a trailer: it picks dramatic shots spread across a chapter or the
  whole project, lets you change the pick and preview it, and renders those shots with their own narration, vertical
  by default. Its length is a setting, 3 minutes by default (YouTube's Shorts limit) and up to 10: the pick fills up
  to it and the render stops before the shot that would pass it. Past 3 minutes the Exports page, `suggest_shorts` and
  the export response warn that YouTube will upload it as a regular video. Agents get the pick through
  `suggest_shorts`.
- **End-to-end tests in CI.** `.github/workflows/e2e.yml` builds the full stack with mock AI, waits for it to be
  healthy and runs the Playwright test: nightly against `staging`, by hand, and on pull requests that change the
  test or how it runs. A failed run uploads the HTML report, traces and every service's log. The test now clicks
  **Plan chapter**, the button's current name.
- **Streaming PDF and webtoon exports, and ZIP64.** PDFs are written to disk page by page and webtoon strips are
  stitched one chunk at a time from panel blocks kept on disk, so memory no longer grows with length. Both can now
  export the whole project (every chapter in order) as well as one chapter. ZIP exports switch to ZIP64 past 4 GiB or
  65,535 entries instead of failing with "Archive is larger than 4 GB".
- **Streaming CBZ and EPUB, and whole-project books and page images.** CBZ and EPUB exports add each page to the
  archive as it is composed instead of collecting every image first; the EPUB's manifest and spine are written from
  page sizes at the end. Page images, CBZ and EPUB can now cover the whole project too; page images spanning chapters
  are named with their chapter (`..._ch02_p003.png`), since page numbers restart in every chapter.
- **Server budget ceiling.** An admin can cap the whole server's AI spend per calendar month (UTC) in Admin → Usage,
  which also shows this month's spend against it. `INSTANCE_BUDGET_USD_MONTHLY` sets the default. Past the ceiling,
  new AI work is refused with `402 instance_budget_exceeded`, which users cannot confirm past, and queued batches and
  production runs pause the same way they do at a project's cap.
- **Expert output actions.** Under an expert's reply, *Use as* turns it into a new project (title, premise, type,
  format and story idea), the project's premise, an outline story revision, or the project's YouTube text. Each runs
  a structured extraction as a text job (provider key or paste mode, shown in Generation); you review and edit the
  result, and nothing changes until you apply it. Each extraction is applied once: the chat then shows *Applied* with
  a link to what it made, and a second apply is refused (409 `already_applied`) unless asked for on purpose (*Apply
  again*, or `again: true`). Agents get the same through `use_expert_reply`.
- **Agents can clean up.** Three MCP tools, each a delete-class action that waits for approval on an "Ask me first"
  connection: `delete_exports` (one export, or every finished export of a project), `delete_narration_audio` (a
  chapter's, one track of it, or the whole project's; the text stays) and `manage_assets` (list a project's assets or
  its trash, trash, restore, and permanently delete what is in trash).
- **Dedicated render workers.** Video renders and project imports run on their own `render` queue
  (`RENDER_WORKER_CONCURRENCY`, default 1), so a long render no longer holds up a PDF or a ZIP on the `export` queue.
  `WORKER_QUEUES` (comma-separated, default all) picks the queues a worker consumes, and `docker-compose.yml` carries a
  commented render-only worker service. Renders queued before the upgrade still finish on the `export` queue (see
  `docs/DEPLOYMENT.md`). The worker's health-check heartbeat moved from the shared `/data/tmp` volume to `/tmp`
  inside its own container, so one worker cannot keep another looking healthy.
- **Shots as video units.** Each panel's *Video shot* settings in the editor: its camera move (auto, static, pan
  left/right/up/down, push in, pull out), a fade through black into it or a hard cut, and leaving it out of videos
  (with its narration) without deleting the panel. Auto moves no longer repeat on neighbouring shots: a repeat becomes
  a pan towards the image focus. A project setting fades to black at scene breaks. A narration line can span several
  shots (they share one hold) with silence before and after it. The browser preview plays all of it from the same
  timing helpers as the render, and the settings are on the `update_panel` and `edit_narration` MCP tools.
- **S3-compatible asset storage.** `STORAGE_DRIVER=s3` keeps assets in any S3-compatible bucket (AWS S3, R2, MinIO,
  B2…) through Bun's built-in S3 client, configured with `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`,
  `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` and `S3_PREFIX`. `/cdn` and reader
  links redirect to a signed URL valid for `S3_PRESIGN_EXPIRES_SECONDS` (900) instead of nginx serving the file, and
  video renders and export packages over 64 MiB upload in parts streamed from disk. nginx adds `ASSET_CSP_ORIGIN` to
  the app's CSP. Local disk stays the default. `docs/STORAGE.md` has the copy recipe for moving an existing install;
  with `s3`, `scripts/backup.sh` and `restore.sh` cover the database and configuration and leave the bucket to its
  own backup tools.
- **Video branding.** Project settings → Video takes a logo watermark (upload an image, pick the corner, opacity and
  size) and optional intro and outro cards (title, subtitle and length, drawn over the project's own art in its
  narration lettering font). Every video export composites them, the preview shows them, and subtitles and chapter
  timestamps start after the intro. Reader-link previews show them too.

### Changed

- Only the project owner deletes panels. An editor turns a panel off (*leave out of videos*) instead; pages and
  scenes, which have no off switch, editors may still delete.
- **Provider batches go a few at a time.** A key now has at most 4 image batches and 16 text batches in flight per
  model (`BATCH_MAX_IN_FLIGHT_IMAGE`, `BATCH_MAX_IN_FLIGHT_TEXT`; 0 = no limit). The rest of a big run waits as
  "waiting for room in the provider's batch queue" and is submitted as earlier batches finish, instead of being sent
  and refused over the provider's enqueued limit.
- **S3 storage: temporary credentials, faster large uploads, CI coverage.** `S3_SESSION_TOKEN` passes an STS or
  assumed-role session token to the client and the multipart signer. Multipart uploads send four 16 MiB parts at
  once (at most 64 MiB of the file in memory). CI runs the integration suite a second time with `STORAGE_DRIVER=s3`
  against MinIO.
- `scripts/bunx.sh` joins a Docker network only when `OM_NETWORK` names one; it used to join `openmanga_internal`
  whenever that existed, putting every lint and typecheck on a running stack's internal network.
- **A declined scope is not asked for again.** When you untick a scope on an agent's consent screen, or deny a step-up,
  that connection remembers it: later calls needing it get `scope_missing` saying it was declined (with
  `details.declined`) and no new step-up challenge, so the agent stops sending you back to the same screen. Agent
  access lists the declined scopes; granting one there, or on a later consent screen, clears it.
- **Reader-link pages are rendered once.** A reader link's page PNG is stored after the first request and served from
  storage until the page changes (artwork, frames, bubbles, narration boxes or SFX); an edit draws it again and removes
  the old copy. Widths round up to 200 px steps. The stored renders count toward the project's disk use, and
  maintenance sweeps the renders of deleted pages.
- **Higher rate limits for real use, lower for guessing.** A signed-in user gets 2000 API requests a minute (was 600)
  and an MCP connection 750 (was 240); requests with no session get their own lower ceiling per address,
  `RATE_LIMIT_ANON_PER_MINUTE` (300). Registration is capped at 10 an hour and reset emails at 5 per 15 minutes per
  address.

### Fixed

- **Batched artwork is in Versions.** A panel drawn by a batched *Generate all missing* stored its artwork without
  the panel id, so the page editor's Versions tab listed only later regenerations, never the first draw. Batched
  artwork now records the panel, page and references like a direct run, and migration `0027_batch_art_panel_ids`
  fills them in for artwork already drawn.
- **Layout guides are sent at a size that keeps the pose.** The guide went out as the usual 192 px reference
  derivative, where a stick figure's hands on hips became an 806-byte smudge and the written composition won. It now
  has its own cached variant, a lossless PNG fitting 1024 px (single and batched generation alike); every other
  reference stays small.
- **A strict guide outranks the written pose.** `panel-generation` v10 puts a `POSE / LAYOUT` section right after the
  goal line; in strict mode it says the sketch wins over the written composition, action or story beat on pose,
  figure placement and framing, while identity, outfits and look still come from the references. Loose mode only
  starts from the sketch.
- **A full provider batch queue no longer fails the run.** OpenAI refuses batches past its enqueued-token limit per
  model (`token_limit_exceeded`), and a big run used to mark every panel in the refused batches failed. The
  refused work now stays queued and is resubmitted as earlier batches finish: after 5, 10 and 20 minutes, then every
  30, for up to 24 hours. The batch banner says "waiting for room in the provider's batch queue, next try at
  HH:MM". Google's equivalent quota is handled the same way.

### Security

- Wrong guesses are capped like failed logins: reader-link tokens (30 per 15 minutes per address), unknown MCP tokens
  (20), password-reset tokens (10 an hour) and the current password when changing it (5 per 15 minutes per user).
- Role checks tightened for shared projects: listing reader links needs `manage` (the token is the link); queueing or
  cancelling an export and duplicating a project need `write`; linking an expert chat to a project, and every message
  in one, need `generate`; the budget cap, the consistency-check key and the content-policy fallback are the owner's
  to change, and only the owner can confirm going over the cap. Nobody retries another member's keyed job, resumes
  their paused batch or continues their production run (each would spend that member's key). A project's files are
  served by project access alone, so whoever leaves a project stops seeing the files they made there.

## [0.12.0] — 2026-09-30

Upgrading: pull the new images and restart. No migrations. Reload open tabs to get the new web app.

### Added

- **Text now, images in batches** — a production run spend option (and the YouTube recap presets' default): planning,
  prompts and narration run straight away, while artwork and references wait for a half-price provider batch.
- **Video preview on reader links** — a reader link's Play button plays the open chapter as the in-browser video
  preview (artwork, camera moves and narration audio), with no account and nothing to render.
- **Numbered pages for generation jobs** — the Generation page and Admin → Jobs page through every job
  ("51–100 of 1,258", previous/next above and below the table) instead of stopping at the first 50 or 100;
  the list API takes `offset` and returns the filtered `total`.

### Fixed

- A production run under a batching policy asked every key for a batch, so with a DeepSeek (or Meta, OpenRouter)
  text key its text steps were refused. A step is now batched only when its key's provider has a batch API.
- A batched "Generate all" for characters (and a production run's character references under a batching policy)
  never reached the provider: the batch submitter skipped character references and left them queued for good.
- A batch of references (or of any other non-panel work) was labelled "Panels · 0 pages" on the Generation page; it
  now names what it draws ("Character ref batch"). A batch's progress no longer counts its submit job as one of the
  images, which read "1 / 21 completed" before anything was drawn.

## [0.11.0] — 2026-09-29

Upgrading: pull the new images and restart. One migration (`0020_production_runs`), applied by the migrate service
on start. Reload open tabs to get the new web app.

### Added

- **Production runs.** One button on the overview takes a project from its story to the rendered video: analysis,
  references, chapter plans, panel prompts, artwork, narration, audio, the thumbnail, the render and the YouTube
  package. Each step does what the matching button does, as the person who started the run, so budgets, access and
  readiness apply unchanged. It skips what already exists, can pause for your review after the analysis, after the
  references and before the render, stops at the project's budget cap (which a run requires), and continues, resumes
  or retries the failed step from where it stood.
- **Target runtime.** Set a video length in project settings (minutes, words per minute, shortest and longest shot).
  Each chapter gets its share by source length: chapter plans default to its page target, narration to the words
  per panel that fill it, and the Exports page to the shortest shot as the minimum hold. The settings page compares the
  budget with what is planned and narrated so far.
- **Production presets and templates.** New projects can start from a preset (YouTube recap 30 min, 1, 2 or 3 hours, manga
  chapters, webtoon episodes, economy draft) that sets format, style, image quality, runtime, which references to
  make and how runs spend. *Save as template* keeps a project's setup (never its story, cast or files) for your next
  projects; the Account page deletes templates. Two new settings: a reference policy (all, or main cast and recurring
  places only) and a batch policy for runs (everything now, text in batches, or everything in batches).
- **Generate all character references** from the Cast page, as for locations and props; the main-only policy skips
  minor characters and places or props used in fewer than two panels.
- **Check all panels.** The vision consistency check for a page, chapter or project in one run, priced first, from
  the chapter page, the page editor's lettering tools and the storyboard. Panels whose current artwork already has a
  check with faces are skipped.
- **Storyboard.** Every panel of a chapter in one grid, filtered to what needs attention (no artwork, failed, needs
  review, check mismatch, not checked), with keys to move, open, check and regenerate; spending keys ask first.
- **YouTube package.** A text job writes title options, a description, tags, a pinned comment and thumbnail
  headlines, edited on the Exports page (a headline can go straight onto the thumbnail). A video spanning several
  chapters also gets chapter timestamps. The *YouTube package* export zips the newest video of the same scope with
  its subtitles and timestamps, the thumbnail and the text.
- **Partial video renders.** Render only the first N minutes, or a range of pages of a chapter, for a check before
  the full film.
- **Continuous scroll cut.** A page framing that scrolls each page from its top to its bottom over its hold, in the
  render and the browser preview.

### Fixed

- The AI model picker, the dashboard's project menu and the project search results were cropped inside modals and
  cards; they now open on top of the page, above or below their button, and Escape closes only them.
- Video exports ignored a page selection and rendered the whole chapter.
- `OPENAI_BATCH_MAX_ENQUEUED_TOKENS`, `BATCH_POLL_INTERVAL_SECONDS` and `STALLED_JOB_TIMEOUT_MINUTES` were documented
  but never passed into the containers, so setting them in `.env` did nothing.

## [0.10.0] — 2026-09-28

Upgrading: pull the new images and restart. One migration (`0019_share_links`), applied by the migrate service on
start; no configuration changes. Reload open tabs to get the new web app.

### Added

- **Reader links.** Share a project or one chapter as an unlisted, read-only link from the overview's Share button;
  anyone with it can read the lettered pages without an account, page by page (tap or arrow keys, following the
  reading direction) or as one long scroll. Revoke a link to close it at once.
- **Video thumbnails.** Generate thumbnail draws text-free 16:9 art that keeps one side clear; the headline is
  composited by the app, so it can be reworded or moved to the other side for free and downloaded as a 1280×720 PNG.
  It never replaces the cover.
- **Print and e-reader exports.** PDF in Amazon KDP trim sizes (5×8 to 8.5×11) printed full bleed with the trim box
  set; CBZ comic archives with ComicInfo.xml (series, number, writer, language, right-to-left) for Komga, Kavita and
  comic readers; fixed-layout EPUB with the cover, reading in the book's direction.
- **Move bubbles off faces.** The consistency check now also reports where each face is. In the page editor's
  lettering tools, "Move bubbles off faces" re-places the bubbles and captions of a page, chapter or project off the
  faces and points each tail at its speaker. Panels without a current check are left as they are.
- **Play chapter** on the Pages / Shots list, and **previous / next chapter** links on the chapter page.
- **Generate all locations / props** lets you pick the kind of reference (wide view, panorama or sheet; single view
  or turnaround) and says how many already have each kind.

### Changed

- **Phones.** The header's links move into a menu button, and no page scrolls sideways any more: grid columns, selects,
  long ids and file names, and toolbars all fit a 390 px screen.
- The chapter page's actions are grouped: review actions first, each model picker next to the AI action it controls,
  delete last. The page editor's inspector tabs all fit.
- The panel consistency check is a visible **Run check** button (and **Check again** once checked) instead of a
  clickable status label.
- A trashed character, location or prop shows the images that went to the trash with it, dimmed, with a Restore
  button.

### Fixed

- The Realistic style in a black-and-white project asks for black-and-white photography instead of manga ink and
  screentones, and a non-film realistic panel is no longer called a "live-action film panel".
- MCP `get_image` no longer returns images that are in the trash.

## [0.9.9] — 2026-09-28

Upgrading: pull the new images and restart. No migrations and no configuration changes. Reload open tabs to get the
new web app.

### Changed

- **Deleted images leave the generation history.** A generation keeps its row, cost and prompt, but once its image is
  deleted the row shows it as deleted instead of the picture. The job's page offers **Restore image** while it is
  still in the trash.
- **Trashing a character, location or prop trashes its reference images too.** Restoring it brings back exactly those
  images, not ones deleted separately before. Items already in the trash before this release keep their images live.
- Trashed images are served only to the trash views (asset library, cast and world trash).

## [0.9.8] — 2026-09-28

Upgrading: pull the new images and restart. No migrations and no configuration changes. Reload open tabs to get the
new web app.

### Added

- **Realistic style.** A new built-in style preset for photorealistic, live-action looking images — film shots that
  look like stills from a movie, with real faces, materials and light. With it, image prompts ask for live-action
  photography instead of comic panels or illustration. Pick it for a new project or switch an existing one on the
  World page; use it with full colour. A style described from a photograph can turn on the same behaviour.

## [0.9.7] — 2026-09-27

Upgrading: pull the new images and restart. No migrations and no configuration changes. Reload open tabs to get the
new web app.

### Added

- **See how much disk a project takes.** The project overview shows the space its files use — artwork, references,
  narration, exports and derived copies — and how much of it is in the trash. Database rows are not counted.
- **Delete exports and narration audio, files included.** The Exports page can delete one finished export or all of
  them; running exports are kept. The Narration page can delete the audio of a chapter (in the selected language) or
  of the whole project; the lines stay, ready to synthesize again, and deletion is refused while synthesis is queued
  or running. The files leave the disk at once rather than going to the trash.

## [0.9.6] — 2026-09-27

Upgrading: pull the new images and restart. No migrations and no configuration changes. Reload open tabs to get the
new web app.

### Fixed

- **The video preview keeps its narration playing in a background tab.** Switching to another tab or app used to
  silence it after the current line while the preview kept running. Narration is now scheduled on the browser's
  audio clock, which keeps going in the background, and the picture catches up when you come back.
- In full screen the video preview's shot list and settings kept the theme's colours on a black background and were
  hard to read; full screen now uses the app's own background around the picture.
- The fifth line of the video preview's shot list is shown in full.

## [0.9.5] — 2026-09-27

Upgrading: pull the new images and restart. No migrations and no configuration changes. Reload open tabs to get the
new web app.

### Changed

- **The video preview is nearly full screen.** It opens at 95% of the window, and the picture takes all the room the
  controls leave. Play, previous/next, the progress bar and the time are always visible; the shot list (five rows,
  following the shot being played) and the render settings fold away and remember how you left them. A full-screen
  button (or the F key) fills the whole screen, and clicking the picture plays or pauses it.

## [0.9.4] — 2026-09-26

Upgrading: pull the new images and restart. No migrations and no configuration changes. Reload open tabs to get the
new web app.

### Fixed

- **An open project no longer floods the server while images generate.** Every generation update reloaded every list
  in the project (batches, characters, locations, chapters, usage), several times per image, until the server's rate
  limit started refusing the page's requests. Only what changed is reloaded now, and updates arriving together are
  combined into one reload at most every 2 seconds.
- The batch and job lists poll every 15 seconds while work runs (was 4–5), and narration progress every 10 (was 3).
  Live updates carry the changes; polling only covers a dropped connection.

## [0.9.3] — 2026-09-25

Upgrading: pull the new images and restart. No migrations and no configuration changes. Connected agents see the new
tool after refreshing or reconnecting their OpenManga connector.

### Added

- **Agents can look at images, not just their ids.** The new MCP tool `get_image` returns the picture itself: a panel's
  current artwork, a page as readers see it (speech bubbles, sound effects and captions included), a character,
  location, prop or style reference, or any image in a project, at 384, 1024 or 2048 px. It follows the same access
  rules as every other tool and generates nothing.

## [0.9.2] — 2026-09-25

Upgrading: pull the new images and restart. No migrations and no configuration changes.

### Fixed

- **Claude can connect over MCP.** Claude's client description lists a sign-in type OpenManga never uses (`jwt-bearer`)
  next to the standard ones, and was refused as unsupported ("This app is not registered with this OpenManga
  server"). A client now only has to support the standard code flow.
- An expert's reply, watched as it is written, now ends on the whole reply. The last part was dropped from the live
  view, which stopped on a partial answer until the page reloaded. The live view also starts listening before it says
  it is ready, so the beginning of a reply sent right away is not missed.

## [0.9.1] — 2026-09-25

Upgrading: pull the new images and restart. No migrations and no configuration changes.

### Fixed

- Narration audio no longer fails with an internal error when its line is rewritten while the audio is being made (for
  example, an agent writing narration chapter by chapter). The unneeded audio is discarded and the job reports
  "Segment was deleted".
- The narration page no longer floods the server while a chapter is being voiced. Every audio update used to reload
  the chapter's narration and panels, thousands of times a minute, until the rate limit refused requests and the page
  stopped updating. Updates are now combined into one reload every 1.5 seconds.

## [0.9.0] — 2026-09-24

Upgrading: pull the new images and restart. Two migrations run automatically: `0017_mcp` adds the agent-access tables
and a nullable `audit_events.service_id` column, and `0018_mcp_claims` adjusts one of those new tables, so existing
projects are untouched. The nginx image changed too (routes for `/mcp`, `/oauth/` and `/.well-known/oauth-*`), so pull
it along with the app image. Nothing needs configuring: the endpoint is `<your origin>/mcp`; the optional `MCP_*`
variables are in `.env.example` and [MCP](docs/MCP.md).

### Added

- **AI agents can work on your projects (MCP).** OpenManga serves a Model Context Protocol endpoint at `/mcp`, so
  ChatGPT and other MCP agents can create projects, write and analyse stories, plan chapters, fix panels, write and
  synthesize narration and export — as you, within the limits you set. 70 task-shaped tools cover the pipeline, and
  every call goes through the same checks as the app (project membership, budgets, locked versions, validation).
- **Connect ChatGPT with OAuth.** Add `https://<your host>/mcp` as a connector; you sign in to OpenManga as usual
  and choose on a consent page what it may do: which scopes, all projects or selected ones, whether it may create
  projects, and whether sensitive actions ask you first. Your provider keys are never shared with it.
- **Personal access tokens** for other agents, shown once, with the same choices and an optional expiry.
- **Approvals.** With "Ask me first", spending provider credits, deleting, applying an analysis, locking versions,
  exports and other sensitive actions wait under **Agents → Waiting for you**: approve or deny, once or always for
  that project. Remembered decisions can be flipped or removed. A request whose target changed meanwhile is not run.
- **Paste mode through the agent.** Manual jobs work end to end: the agent reads the exact prompt and answer format
  (with the images a question is about), answers, and the job continues — a chapter plan question by question.
- **Agent access page** listing connections (scopes, projects, last use; edit or revoke), approvals, history and
  remembered decisions. Everything an agent does is in the audit log as "*connection* via *you*".

### Fixed

- A panel consistency check started without an API key (paste mode) failed with a missing-credential error instead
  of waiting for a pasted answer.

### Changed

- CI: `docker/setup-buildx-action` 4.4.1 and `docker/build-push-action` 7.4.0.

## [0.8.0] — 2026-09-24

Upgrading: pull the new images and restart. One migration (`0016_experts`) runs automatically and only adds tables,
so existing projects are untouched. The nginx image changed too (a new unbuffered route for streamed replies), so
pull it along with the app image.

### Added

- **Experts: brainstorm and develop a series with specialists, outside any chapter.** Ten built-in experts, each a
  long, studio-written system prompt with openers: Topic Scout, Title Doctor, Thumbnail Designer, Story Developer,
  Character Designer, World Builder, Hook & Pacing Editor, Narration Scriptwriter, Beta Reader and Channel Strategist.
  You can also write your own, or start from a copy of a built-in one.
- **Chats are kept**, listed and searchable, and each keeps its own copy of the expert's prompt. That copy can be
  adjusted for one chat, and editing or deleting the expert never changes a chat already under way. A reply can be
  written again, copied, or retried after a failure.
- **Talk about a project.** A chat can be tied to one of your projects: its cast, places, props, world notes, art
  style and chapter summaries go with every reply. The expert writes in the project's language, and asks for the
  full text when a summary is not enough to judge.
- **Images in and out.** Attach images by button, drag and drop, or paste. Tick *Generate image* for a picture with
  the reply, at the shape you choose. In a project, it follows the art style and draws the characters and places the
  prompt names from their approved references. The Thumbnail Designer starts at 16:9 with the image on, and overlay
  text stays out of the picture.
- **Replies stream in** as they are written: Anthropic, the OpenAI-style providers, and DeepSeek. They render
  Markdown (headings, lists, tables, code) without ever letting a reply inject markup.
- **No API key needed:** a reply can wait for an answer pasted from any chat, with the image that chat made.
- Expert chat spend appears on your Usage page, including chats with no project.

### Changed

- Text providers can pass an answer on as it arrives. DeepSeek streams only when something listens, so the planning
  steps send exactly the request they did before.

## [0.7.0] — 2026-09-24

Upgrading: pull the new images and restart. Two migrations run automatically: `0014_outfit_assignments` adds a table
and `0015_planned_lettering` adds a nullable column, so existing projects are untouched. Outfits already worn by
naming them in a panel's outfit text keep working the same way. Chapters planned before this release have no kept
dialogue to letter; re-plan one to get it.

### Added

- **Outfits are switched on panels, the way a costume change happens in the story.** In the panel editor each
  character gets outfit chips with their reference images. A pick holds *from this panel on*, across pages and into
  later chapters, until the next change, or for *only this panel*. The editor says what is worn and where it was set
  ("since Ch.1 p.3 panel 2"), and the character page lists every change in reading order. A panel's outfit now reaches
  the prompt by its own description, not only its name, and sends that outfit's approved reference image. The default
  outfit is finally used.
- **Chapter plans switch outfits too.** The planner sees each character's outfits; naming one records a change from
  that panel on, or for one panel only with `outfitScope: "panel"`. Re-planning replaces the plan's changes instead
  of stacking them.
- **Locations can be drawn as a panorama or as a sheet of every side, and props from every angle.** Each is one image,
  picked from the kind dropdown the character page already had; a panel told it is looking at a sheet or panorama
  draws only the one view it needs.
- **Letter from plan.** With automatic lettering off, the plan's dialogue and SFX are now kept on each panel instead of
  thrown away; Editor → Lettering places them on request. Bubbles go where the plan said text fits.
- **The text steps see what they are asked to use.** The chapter planner gets each location's key features and
  lighting, prop summaries, the cast's distinctive features, personality and mannerisms, the protagonist,
  relationships from the story analysis, and every fact revealed in earlier chapters. Narration gets the chapter's
  cast (for names and pronouns), the world notes, the previous chapter, and each panel's emotion and dialogue.
- **What a scene changed carries into the scenes after it** ("left sleeve torn"), for the people it is about, and a
  scene that states no starting state starts where the previous one ended.
- **New prompt versions say how to use that data**: `page-planning` v6 (with `shot-planning` v3, `strip-planning` v2
  and the split-planning passes derived from them) on naming outfits, acting the cast and not repeating earlier
  revelations; `panel-prompts` v4 on writing each named character in the named location; `narration` v5 on names
  and pronouns from the cast. Nothing else in them changed, and earlier versions stay registered.
- **The story analysis keeps more of the world**: uniforms, recurring scenery, vehicles, genre, tone and themes go
  into the world notes, and its summary fills an empty project description, which the cover is drawn from.

### Fixed

- **Outfit references were drawn without the character.** The prompt told the model to reproduce the approved design
  from reference image 1, and no image was sent, so every outfit drifted into a different face.
- **Prompt preparation saw database ids instead of names**, so it could not tell whose pose was whose.
- **The panel check compared clothes with the default wardrobe**, so any outfit change read as a mismatch; it also
  ignored text drawn into the art and never showed its notes. It now checks the outfit worn, reports drawn text, names
  the problem on its badge, and saves its prompt on the job page.
- **Editing a wardrobe did not reach panels, and a new appearance version wore the old one's clothes.** The default
  outfit now follows the wardrobe of the version it was made from.
- **Reference jobs recorded template version 1** whatever template drew them; they now record the real one.
- **The prompt and pipeline docs had fallen several versions behind**; they now list the live versions, and say what
  each text step is given.

## [0.6.0] — 2026-09-23

Upgrading: pull the new images and restart. One migration (`0013_awaiting_input`) runs automatically and only adds a
job status, so existing projects are untouched. To have the header show which commit is running, build with
`GIT_SHA=$(git rev-parse --short HEAD) docker compose build`; without it the label still shows version and build time.

### Added

- **Run the whole pipeline without any API key.** A text step can be set to *Paste it yourself — no key needed*: the
  job compiles its prompt, waits, and finishes from an answer pasted back in — from any chat you already use. The
  answer goes through the same validation and appliers as a provider's reply, so it is not a second-class input, and
  nothing is billed. A step that asks several questions (a chapter plan: the outline, then each scene) waits once per
  question and keeps every earlier answer, so a rejected paste costs only itself; the rejection shows the exact
  validation error and the prompt that answer was for. Questions about an image list the image to attach, since a
  copied prompt is only text. A waiting job can be cancelled, and a retry starts fresh.
- **You are told when a job is waiting for you**, with a link straight to it, and the queue counts how many are.
- **Every answer is documented field by field.** A waiting job shows the answer's shape as a TypeScript interface —
  each field explained, typed exactly, marked optional or required, and given an example value — above a valid
  answer to that exact question. [ANSWER_FORMATS](docs/ANSWER_FORMATS.md) carries all eight answer types with a
  complete example of each, and [WITHOUT_API_KEYS](docs/WITHOUT_API_KEYS.md) walks the whole flow. Both are held to
  the real schemas by tests: an unexplained field, a stale one, or an example that fails validation breaks the build.
- **A panel can take artwork you already have.** *Upload artwork* in the panel editor's Versions tab fills the same
  slot generation does; the upload becomes a version like any other, and can be compared, superseded or reverted.
- **Draw every location or every prop in one run.** *Generate all* on the World page's Locations and Props tabs, with
  the same dialog as a chapter's generate-all-panels: count and price first, *only those without a reference*, and
  *send as a provider batch* at half price. A reference that comes back in a batch is identical to one drawn on the
  spot, and anything already being drawn is never queued twice.
- **The header says which build is running** — `v0.6.0.20260923155759`, the version and the UTC build time — with the
  commit on hover, for the server and for the page itself. `GET /api/meta` returns the same.

### Fixed

- **A job handed back to the queue after it had already run was silently dropped.** The queue deduplicates by job id,
  so re-queueing the same job was a no-op and it sat at *queued* forever. Nothing reached it before, because a
  batched job is written unqueued and a retry creates a new job; resuming a waiting job now uses a key per attempt.
- A test that asserted a batched job had not yet been picked up failed whenever the worker won the race to pick it up.
  It now asserts what it is about — the job left the batch carrying its answer.

### Changed

- **Work lands on `staging` and is released to `master`** once confirmed, so `master` is always code that has been
  seen running. CI now also runs on every push to `staging`. See *Branches* and *Releasing* in CONTRIBUTING.

## [0.5.0] — 2026-09-22

Upgrading: pull the new images and restart. One migration (`0012_panel_seam`) runs automatically and adds a
nullable column, so existing projects are untouched and nothing needs doing per project. Comic and film projects
behave exactly as before; the new format is only offered to projects created as one.

### Added

- **A vertical strip format, beside comic and film.** A strip is one scrolling column rather than a sequence of
  pages: no gutter, no margin, one panel per page, and each panel free to be short or tall as pacing demands.
  The webtoon export already treated the panel as its unit and threw page geometry away, so what a strip was
  missing was never a layout engine — it was any notion of what happens *between* two panels. Every seam in an
  exported strip used to be the same project-wide 40px gap, which is why a strip read as a column of separate
  pictures rather than continuous art.
- **Seams are authored per panel.** A panel records how it meets the one before it: `gap` (the old behaviour),
  `butt` for continuous action, `bleed` for a hard-edged overlap, `dissolve` for a blended one, and `fade`
  through a flat colour for a scene break. Set them by hand in the editor, or let chapter planning choose —
  planning also picks each panel's height, so pacing and transitions come out of the same pass that writes the
  dialogue. A strip is planned from **page** planning rather than shot planning, so speech, captions and sound
  effects carry over: only the geometry changes.
- **A seam takes its room from the panels it joins**, rather than one number for the whole chapter. A gap is 8%
  of the shorter panel it sits between, a fade band 10%, an overlap 15% — so spacing follows the pacing instead
  of holding a fixed rhythm down a chapter whose panels vary from short beats to full-screen drops. Setting a
  seam's size by hand still overrides the ratio. Panels with no seam at all keep the project gutter, which is
  what a comic or film webtoon export stacks with, so those exports are byte-for-byte unchanged.
- **A chapter can be read as one continuous column in the app** (`/read`), stacking the same page renders the
  editor produces — so lettering is already composed in — positioned by the same arithmetic the export uses.
  What you scroll is what gets stitched; the integration test asserts the exported image's real pixel height
  equals what the reader computes for the same panels.
- **Narration progress across a whole project.** The narration editor works one chapter at a time, so a
  synthesis run spanning a project was only ever visible a chapter at a time, with no way to tell whether the
  rest had finished, stalled or failed without opening each one.
- **An account can set the narration voice new projects start with**, instead of every project defaulting to the
  same built-in voice and having to be changed by hand.
- **A vertical strip letters itself.** A strip was planned with dialogue, captions and sound effects and then drew
  none of them, because auto-placement is what turns a planned line into a balloon on the page and it is off by
  default for every format. It is now on for new strips only: a comic page is composed around its balloons and a
  planner's guess lands badly on a multi-panel layout, while a strip panel is one full-width frame with only one
  place a balloon can go. Comic and film are unchanged, and a strip's owner can still turn it off in settings.

### Fixed

- **A project's derivative files are deleted with it.** Permanent deletion removed each asset's own file and
  nothing else, but a derivative's key lives on `asset_variants`, which cascades away with the asset — so every
  thumbnail and prompt reference stayed on disk with nothing left in the database to find it by: unreachable and
  uncountable. Found while deleting 81 archived and trashed projects on a live instance, where it had left
  1.2 GB behind.
- **A bulk run is priced against the batch setting you just chose.** Ticking "send as a provider batch" priced
  the *previous* state of the checkbox, because the re-price read the value from a stale closure — so the
  estimate was always one click behind. Two things that made it worse are fixed with it: the dialog no longer
  closes on every toggle, and a figure is shown only when it matches the current setting.
- **A generation job is claimed rather than merely announced, so it can never run twice.** The runner read a
  job's status, checked every guard against what it read, and then marked the row `processing` unconditionally —
  so two runners that both saw `queued` both passed the guards and both called the provider: two charges and two
  usage rows for one job. This is the shared runner, so it affected every kind of generation, not only the batch
  replay where it was noticed (a batch poller republishes a parked job while a worker may still hold it).
  Claiming is now a compare-and-swap on the status and attempt count that were read; the runner that loses the
  race returns without spending money or an attempt. The crash-recovery path got the matching guard from the
  other side: a job found mid-run with nothing to recover is only taken over once its previous runner cannot
  still be alive, rather than immediately.
- **A batch check says what it is actually doing.** Reported as "manual poll doesn't fetch results" — it did,
  and took 72 seconds to do it, because ingesting 100 panels means downloading and storing 100 images. For that
  whole minute the toast said only "checking the provider for results", so a working poll looked idle and a
  second press returned an empty result that read as confirmation. The toast now uses the counts the endpoint
  already returns, and a batch card distinguishes not-checked-yet from checked-and-not-ready from
  downloading-now.
- **Project covers are shown taller on the dashboard**, where portrait art was being cropped to a shape no page
  in the project actually has.

### Known limits

Bleed and dissolve overlap two panels that were generated independently, so a blend is only as convincing as the
two images are continuous; art that genuinely runs off the frame is a prompt problem rather than a compositing
one. The editor shows seams as fields rather than previewing them on the canvas.

## [0.4.0] — 2026-09-20

Upgrading: pull the new images and restart. No migration, and nothing to do per project. The first maintenance
sweep after starting will fail any panels that were left stranded behind a failed batch submitter (see below), so
they show as failed and can be retried instead of sitting in the queue forever.

### Added

- **Props can be attached to a panel from the editor.** The API has always accepted them and the prompt has
  always had a PROPS section, but nothing in the app ever sent them, so a prop reached a panel only when AI
  planning put it there and could never be added or removed by hand.
- **An earlier art style can be made current again.** Setting a style always minted a new version, and older
  versions were listed but could never be selected, so comparing two looks meant retyping one from scratch.
  Restoring stands the replaced version down rather than deleting it, so it is reversible both ways.
- **A batch can be checked for results now** instead of waiting for the scheduled sweep, which is five minutes
  apart by default. The button appears on a batch whenever panels are parked with a provider. One press covers
  every outstanding batch, and presses within ten seconds of each other collapse into a single pass rather than
  stacking provider calls.

### Changed

- **A chapter is planned scene by scene rather than in one response.** A feature-length chapter did not fit: runs
  truncated at the 64k output cap on OpenAI and DeepSeek alike, and no model choice fixed it, because the cap is
  the model's. Planning now makes one small call for the scene outline and then one call per scene, each given
  the whole outline so the pages still lead into the next scene. A scene that comes back malformed is re-asked on
  its own instead of losing the chapter, and progress is logged per scene. Batched plans keep the single call on
  purpose: a batch parks the job on its first provider call, so a loop would need one 24-hour round trip per
  scene.
- **A content-policy refusal that names its category is final.** These are retried three times because the
  filter is probabilistic and a second sample usually passes — but when the provider says
  `safety_violations=[self-harm]` it is a verdict on the prompt, and it repeats identically on every attempt. A
  named category now fails the panel on the first try; an unnamed refusal keeps its retry budget as before.

### Fixed

- **Panels stranded behind a failed batch submitter sat in the queue forever.** A batched panel stays queued on
  purpose — only the submit job hands it to a provider — so when a submit job failed for good, nothing was left
  to move its panels: 143 of them went quiet in one run, and the batch read as idle rather than broken. The
  stalled-job sweep could not see them because they are queued, not processing. Maintenance now fails them with
  a reason that says to retry.

## [0.3.0] — 2026-09-20

Upgrading: pull the new images and restart. No migration, and nothing to do per project. Panels generated after
this release can look slightly different from ones generated before it: a style's exclusions now reach the prompt
(see below), so every image template carries a new version number.

### Added

- **The art style is editable field by field.** Art direction shows an input for every line `styleSection()`
  renders — summary, lines, colour, shading, detail, faces, backgrounds, motion effects, contrast, screentones,
  lighting — plus an "Avoid" list, rather than a preset picker and one free-text box. Editing any field applies
  the result as a custom style through the definition the endpoint already accepted. A style taken from a
  described image now shows its fields too: it lives on a project-scoped preset that the preset list does not
  return, so only its one-sentence summary used to be visible while the other eleven fields silently shaped every
  prompt.
- **The panel editor says when prepared prompt text is in use.** Text written by "Prepare page prompts" outranks
  the panel's own fields in the compiled prompt — intent over the beat, plus action, expression, composition and
  lighting — and saving the spec silently discards it. Editing those fields under an active draft therefore looked
  like it did nothing. The tab now names which fields the draft supplies, notes that continuity merges rather than
  replaces, and offers to discard it.
- **Every page sets its own browser title**, so a tab says where it is: `Cast · Night Bus · OpenManga`. Film
  projects use the sidebar's wording (Shots, Shot editor), and the project name costs no extra request.
- **Exports name the chapter they cover.** Filenames lead with the chapter number —
  `Night_Bus_ch03_The_Rooftop_en_page-cut_1080p.mp4` — because chapter titles repeat across a series and a
  downloaded file has to identify itself long after the page that produced it is closed. The export history shows
  the chapter as well; it was stored all along and never displayed, so every video of a project looked alike.
  Existing exports keep their old names.
- A batch waiting on a provider's batch API reports **how many panels are parked** rather than nothing.
- Long narration lines in the video preview's shot list can be read in full by hovering them.

### Changed

- **A style's exclusions now reach the image prompt** as an `Avoid:` line. Every built-in preset fills the field
  in, and the style analyst is explicitly asked to fill it in, but no template ever read it — so "no photoreal
  rendering" was recorded and thrown away. All seven image templates bump a version because their output can
  change. References and panels are not marked stale by this: staleness is fingerprinted on descriptions, not on
  template versions.
- **Character references default to full body** instead of a portrait, in the picker and for API callers that omit
  the kind. Panels lean on height, proportions and clothing far more than on a face crop.
- The prompt inspector reports the model your own key resolves to. It showed the server's default, which is blank
  on every bring-your-own-key run — that is, on every real run.

### Fixed

- **The shots grid could rate-limit you on its own.** A film project is one shot per page, so a feature-length
  chapter renders 148 cards, and each card fetched its own page document: 148 requests per visit, a quarter of the
  per-minute budget, repeated on every revisit more than ten seconds later. Four visits in a minute was enough to
  start receiving 429s with nothing generating. The chapter payload now carries what the thumbnails draw, so the
  grid costs one request. Two related storms are gone with it: a chapter event refetched every cached page
  document at once, and the narration page refetched its document once per audio event while a chapter
  synthesised.
- **A bulk generate spanning panels with and without approved references failed to submit**, and took its panels
  with it. An OpenAI batch names a single endpoint, so requests carrying reference images cannot share a batch
  with requests that do not; the submitter enforced that but the caller never grouped by it. Because the failure
  is not retryable, the panels were left queued behind a dead submit job with nothing to move them — 143 of them
  in one case. Requests are now split by shape before being chunked.
- **A batch parked at a provider reported itself finished** — "1/139 finished" while the provider still held every
  panel — because the submitted state counted toward the total but toward no bucket. It also stopped the progress
  view refreshing, so the batch appeared to stall until the page was reloaded.
- **Every JSON repair against a reasoning model failed.** The repair call forced `temperature: 0`, which GPT-5 and
  Muse Spark reject outright with a 400, so a chapter plan that needed one repair burned all three attempts on the
  same rejection and failed. Providers now choose their own JSON default.

## [0.2.0] — 2026-09-18

Upgrading: pull the new images and restart — the `migrate` service applies this release's schema change (a
`source_image` asset type and a `submitted` job status) on start. Nothing else is required, and no existing
project needs migrating.

### Added

- **Outfit references are drawn from the approved design**: generating one requires an approved main reference and
  attaches it as the first image, so every outfit keeps the same face and build. Each outfit in the editor has its
  own generate button, marked once it has a reference.
- **Describe a reference image.** Upload a frame — from a video, a page, anything — and get back descriptions you
  can generate from: art style, character, outfit, location, lighting and palette, composition, mood, props, era
  and technique, each with its own prepared prompt, plus a free-text question of your own. The style, character
  and location results come back in exactly the shape those parts of a project already accept, so they apply in
  one click; everything else is there to copy. Available as its own **Describe** section in a project, and as a
  "from image" button inside the art-direction and character-bible editors, which fill the form you are in rather
  than creating anything. Uploaded images stay in the library as `source_image` assets, so a frame can also be
  attached as a reference to a later generation. Runs on any vision-capable key and batches at half price like
  every other text job. Past descriptions are kept with their image, inputs and result, listed across every project
  you are a member of — so a style read from one reference can be applied in another project without paying to
  read it again — and can be deleted individually along with the image they came from.
- **Text jobs batch too** — planning, story analysis, rewrites, page prompts, narration writing and the vision
  consistency check — on OpenAI and Google keys. A panel generated through a batch has its automatic consistency
  check batched as well, so a batched chapter does not quietly produce hundreds of interactive vision calls.
  Nothing about the handlers changed to make this work: the provider is swapped for one that collects the request
  on the way out and replays the batch's answer on the way back, so each handler's own validation and appliers
  run exactly as in a synchronous run. A batched answer that fails schema validation is repaired with one live
  call rather than waiting another day.
- Bulk panel generation can be sent to an image provider's **batch API**: half price, results within 24h (often
  sooner). Opt in per run — the panels wait at the provider instead of generating now, and nothing holds a worker
  slot meanwhile. OpenAI and Google keys only; DeepSeek discounts by time of day rather than through a batch
  endpoint, and Meta and OpenRouter have none. Batches are chunked to stay under the provider's binding limit
  (OpenAI's enqueued-token ceiling, configurable as `OPENAI_BATCH_MAX_ENQUEUED_TOKENS`; Gemini's payload size),
  estimated per request rather than by counting requests. Batch spend is recorded against a `:batch` model at
  half the interactive rate, so the cost dashboard separates it.

### Changed

- **Version promotion is tied to approval.** A new character/location version no longer becomes current on
  creation, and a draft cannot be made current at all — new panels pin the current version and take identity from
  approved references only, so a draft as current meant generating that character with no reference. Approving a
  version is what promotes it. A draft version can also be deleted now (never an approved one, never the last,
  never one panels were drawn against).

### Fixed

- Maintenance failed healthy long-running jobs after two hours of wall clock, whatever they were doing. A
  118-minute film export was marked "Worker stopped during export" while it was still rendering (it went on to
  finish successfully), and the phantom failed row left the single export slot occupied until the worker was
  restarted by hand. The sweep now judges liveness — the last write to the row, `STALLED_JOB_TIMEOUT_MINUTES`,
  never a job a worker still holds — and clears the queue entry of one it does fail.
- `PATCH /api/projects/:id` reset settings the caller never sent: a patch carrying one field turned a film
  project into a 1600x2400 comic. zod's `.partial()` keeps each field's `.default()`, so an omitted key parsed
  back as its default and overwrote the stored value. Same bug, same fix, in three more places — `PATCH
  /api/scenes/:id` (wiped summary, location, cast and continuity state), `PATCH /api/character-outfits/:id`
  (wiped the outfit description and demoted the default outfit) and a new SFX box's style.
- Image spend was reported as text spend: the cost split keyed on a per-image counter that is zero for rows
  written before it existed and for billed failures. It now counts billed image output tokens too.
- `GET /projects/:id/generations` capped at 50 rows with no way to page. It returns `nextCursor`, keyed on
  `(createdAt, id)` so a bulk enqueue's identical timestamps cannot hide a whole tie group.
- A chapter plan that declined to replace existing pages completed without saying so. The `job.updated` event
  now carries `applied`, and a plan reports the density it achieved (`sourceWords`, `panelsPerKWord`) plus
  `targetMissed` when it lands more than 25% off a requested page count.

## [0.1.1] — 2026-09-17

### Fixed

- A multipart import larger than the 64 MB ceiling returned a 502: the size was checked after
  `c.req.formData()` had already materialised the body. It is now checked against `content-length` first, so the
  caller gets the 413 that names the raw-body alternative.
- An archive that holds several projects (a repository of sample projects, zipped) restored one of them without
  saying so. The import now reports which project it restored and which it ignored.
- Every generation was refused with "this server has no shared API keys" until you opened the model picker and
  chose a key by hand, even with keys saved. A run now uses your first key that supports the capability unless you
  pick another, and the chip says which key that is.
- The model picker opened below its button, which put it off-screen when the chip sat in a dialog footer (the
  cover dialog, panel edit, story rewrite). It now opens upwards when there is no room below.
- A per-line narration re-synthesis ignored the chosen voice provider and fell back to local TTS — and failed
  outright with `TTS_ENABLED=false`, even with a cloud voice key. It now uses the same choice as the chapter.
- The manual panel consistency check sent no provider choice at all, so it was refused unless the project had a
  vision key configured in its settings. The project's key still wins when set, since a text-only model cannot
  read the panel.
- The new-project wizard analysed the story with no way to choose the model; it now has the same picker as the
  story page. Enabling the consistency check without picking a key now warns instead of silently skipping.

## [0.1.0] — 2026-09-17

First public release, so the list below is the whole state of the project rather than a set of changes; later
entries only cover what moved.

### Added

- Project wizard: details, format (comic pages or 16:9 film shots), style preset, story input, AI analysis, editable
  review and apply.
- Story editor with immutable revisions, AI rewrite into new revisions, and analyses per revision.
- Cast and world: character bibles with aliases, outfits and versions (draft → approved → locked → superseded),
  locations, props, style presets and custom style versions, with generated or uploaded references and explicit panel
  migration between character versions.
- Chapter planning into scenes, beats, pages with deterministic layout templates, and panel specs with auto-placed
  dialogue.
- Page editor on Konva: panel and bubble transforms, zoom and pan, undo/redo, template swap, add/duplicate/split/
  reorder, crop and focal point, mask painting for targeted edits, version compare/activate/revert, and a prompt and
  reference inspector that shows exactly what was sent.
- Generation queue with live progress over SSE, cost and latency reporting, retry and cancel, and bulk page, scene and
  chapter generation behind a cost confirmation.
- Bring-your-own-key provider credentials with rotation, per-project budgets, batch pause, and a readiness gate before
  exports.
- Narration: AI narration text, segment split and merge, voice selection and preview, local Kokoro synthesis, cache
  reuse, chapter playback and a timeline manifest. Multi-language narration.
- OpenAI TTS as a cloud voice alternative to local Kokoro, with the voice list filtered per model.
- Exports: PNG and JPG page sequences, PDF with page size, margin, bleed, DPI and RTL options, webtoon strips with
  chunking, a narration audio package with timeline, project JSON (`schemaVersion: 1`) and a full ZIP package.
- Video export: Ken Burns rendering with SRT subtitles, at panel-cut and page-cut granularity, for a page, a chapter
  or a whole project, plus in-browser preview of chapters, pages and panels.
- Film mode: projects whose pages are single full-bleed 16:9 shots, exported as video.
- Project import from exported JSON.
- Character consistency check across a chapter.
- Cost dashboard with today, 7-day, 30-day and lifetime views, operation breakdowns, reference-size experiments and
  regeneration and acceptance rates. Spend is also reported per provider with an image and text split.
- Preflight check before generation: harm vocabulary, distress lighting and stale references.
- Admin surfaces: users, jobs, queues, Kokoro status, storage, errors, rate snapshots and maintenance.
- Spend that could not be priced is now counted and shown. A call against a model with no rate snapshot records
  $0, so the budget cap could not see it; the budget card, bulk estimate and usage dashboard now say how many
  calls are unpriced, `ai_usage` stores the image and character counts behind each cost, and speech providers can
  be priced per character.
- `IMPORT_MAX_UPLOAD_MB`, `IMPORT_MAX_ENTRY_MB` and `IMPORT_MAX_COMPRESSION_RATIO` make the project-import ceiling
  an operator decision. Packages are now streamed to disk entry by entry rather than held in memory, so a 1.66 GB
  package imports with about 130 MB of worker memory, and the zip-bomb defence is a compression-ratio guard applied
  as chunks arrive instead of an absolute size cap. Raising the upload limit means raising `client_max_body_size`
  on the import route in nginx to match.
- `bun db:seed --samples <url|path>` imports published sample project packages (real artwork and narration)
  through the normal import path, verifying each against `--sha256`.
- `AI_MOCK_MODE` with a mock provider service, so the whole pipeline runs with no provider keys and no spend.

### Changed

- Prompt quality pass: character and location bibles describe what is drawable, panel prompts describe a single
  moment, narration reads as prose rather than captions, and full-bleed images are prompted as full-bleed.
- Video and ZIP exports stream through disk instead of being assembled in memory, so large chapters no longer depend
  on available RAM.
- Unparseable model JSON is recovered where possible instead of failing the job outright.
- Provider content-management filter responses are classified as `content_policy` rather than as generic errors.
- Kokoro synthesis and video rendering run with bounded concurrency.
- Narration pauses are configurable, and the TTS breath between shots dropped from 400 ms to 150 ms.
- The style preset `minimal-anime` keeps location features instead of flattening them away.
- Assets stay on local disk; there is no object-storage backend. Recorded as a deliberate decision rather than a gap.
- New projects start with a $5 spend cap instead of none. Existing projects are untouched, and the cap asks for
  confirmation rather than refusing outright.
- Model rate table corrected for DeepSeek, with rates added for the current OpenAI text models.

### Removed

- Server-held provider keys for Meta, Google, OpenAI and DeepSeek, and the "server default" option in the model
  picker. Provider access is bring-your-own-key only.

### Fixed

- Exporting a project and importing it back no longer loses panel prop pins, asset approval status, narration
  pauses, outfit links, page status and reading-direction overrides, or story revision locks, and imported rows
  keep their artwork version order.
- A job redelivered after a worker restart is finished from the output it already produced instead of calling the
  provider a second time.
- Two clicks on a single panel or narration segment no longer queue two paid jobs, and a batch whose over-budget
  confirmation was given no longer pauses itself on the first job.

- Colour projects no longer receive contradictory art direction. A style preset's monochrome colour policy and
  screentone lines were being sent a few lines away from the project's "full colour" directive, leaving the model to
  choose between them; the project's colour mode now wins and the conflicting preset lines are dropped.
- `content_policy`, `invalid_json` and `invalid_response` failures use their retry budget instead of failing
  immediately. Measured across a 50-project run, every failure of these kinds succeeded on a plain retry, so treating
  them as terminal was discarding work that would have completed.
- A second retry of the same generation record is refused, and retries are tracked through
  `generation_jobs.retried_by_job_id`.
- A chapter plan is refused while another plan for the same chapter is still running, which was producing doubled
  panels.
- `video_pages` export no longer produces a static, pillarboxed result for `format: "film"` projects. The page cut now
  fills the frame for 16:9 pages.
- Dead air in narrated video. TTS voices pad every segment with leading and trailing silence, which stacked with the
  composed pause at each cut and left roughly 1.2 s of silence at every shot change — measured at 24.6% of a narrated
  film. Segments are now silence-trimmed when stored, audio synthesized before trimming is not reused from cache, and
  the configured segment pause and video breath are the only pauses at a cut.
- The narration timeline total no longer counts the pause after the final segment.
- A project ZIP whose contents sit inside a single wrapper directory now imports. That is the shape GitHub's
  "Download ZIP" produces, so a project published as a browsable repository imports without repacking.
- A ZIP package export fails instead of writing a zero-byte entry when an asset cannot be read from storage,
  which used to produce a package that imported "successfully" with empty images.
- Signing in no longer crashes when the server holds no provider keys: the app shell and the admin overview read
  the server's own text and image providers, which are null under bring-your-own-key.
