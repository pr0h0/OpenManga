# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Published container images track tagged releases.

## [Unreleased]

## [0.19.7] — 2026-10-24

Upgrading: pull the new images and restart; no migrations, no new settings. An email invitation is now answered
only through its emailed link; invite by username to have it appear in the app.

### Security

Fixes from a source security audit (all found and reproduced locally with dummy accounts; none known to be exploited).

- A page, panel, speech bubble or sound effect could be pointed at another project's scene, panel or character by id.
  The other project's scene notes then showed up in the caller's prompt preview, and the caller's continuity notes in
  theirs. These ids are now checked against the project, and the planner only reads the project's own scenes.
- A copy of a series episode stayed an episode of the original series, so a collaborator's copy could publish chapters
  on the owner's public series page and receive the series library after they were removed. Copies are now
  standalone, and series pages and syncs only include the series owner's projects.
- Removing or changing a series library image from inside an episode trashed (and after 30 days deleted) the library's
  own file. It now only affects the episode's link to it.
- A video linked by someone who has not connected its channel showed the counters read with the channel owner's
  token, beyond the 30-day limit. Each link now sees only its own connection's data, and each is read its own way.
- A pasted answer to an expert chat could still draw with a project's reference images after the person left the
  project or became a viewer. It now needs current access, like sending and retrying.
- Another member's expert extraction (their private chat question and reply) was readable by everyone in the project
  through the job list and job details. It is now theirs alone, like an in-app agent's thinking.
- Work someone queued kept running after they were removed from the project, or after the project was trashed.
  The worker now checks before running and cancels it, and removing a member cancels their pending jobs.
- An agent on a connection that asks for approval could change the storage policy, the automatic consistency fixes'
  budget or the content-policy fallback through `update_project` without asking. Every owner-only setting now waits
  for approval, as the budget did.
- A connection granted only `generations:run` could apply analyses, approve references and plan chapters through a
  production run. Starting, updating or continuing a run now needs the scopes of the steps it does.
- An approval asked for at one review step of a production run could pass a later one. It is now tied to the step.
- Anyone could make a public series page render and store a new copy for each `?language=` value they sent. Only
  editions the project has are rendered now.
- Importing a large JSON export could exhaust the API's memory, because it was parsed whole only to read the title.
  The title is now read from the start of the file, and the worker caps project.json at 64 MB.
- The palette tool refuses artwork over 12 megapixels, which could otherwise stall the API for seconds.
- One account could hold every shared text or image worker slot (a custom endpoint that never answers held one for
  hours). A user now cannot take the last free slot while someone else's job waits, and a provider timeout is not
  run again after the provider's own retries.
- A password change or reset now ends every earlier reset link.
- An email invitation is redeemed only with its emailed link, not claimed in the app by whoever registered that
  address. Invite by username for an in-app invitation.
- Checking whether a series address is taken is now throttled like the public page, so unlisted addresses cannot be
  probed through it.

## [0.19.6] — 2026-10-24

Upgrading: pull the new images and restart; no migrations, no new settings. The Kokoro image is rebuilt.

### Security

- MCP TypeScript SDK 2.3.0 (server; the client used in tests too): fixes for a request that could exhaust server memory
  within the default size limit and for bearer tokens issued for another service being accepted, among others.
- Kokoro narration service: transformers 5.20.2 and torch 2.11.0, past the published code-execution and path
  traversal advisories. The service only ever loads the fixed Kokoro-82M weights, so exposure was low. Voices sound
  the same: identical durations and loudness on the same text.

## [0.19.5] — 2026-10-23

Upgrading: pull the new images and restart; no migrations, no new settings.

### Fixed

- Hardening from a CodeQL scan: parsing an AI reply's code fence, splitting narration and chapter text into
  sentences, reading a provider's policy message, trimming an expert's image prompt, and the S3 prefix and IPv6
  checks now run in linear time, so a long crafted input can't stall the server. The translated-lettering preview
  link encodes its parameters.

## [0.19.4] — 2026-10-21

Upgrading: pull the new images and restart; the migrate service applies one migration (`0054_activity_stats`). No
new settings.

### Added

- Local usage stats: which screens you spend time on and which actions you use, kept on this server only and never
  sent anywhere. Screens are recorded by route template and actions by API route pattern, never ids or content. See,
  export (CSV or JSON) and delete your own under Account, or turn recording off there; administrators get totals
  across users (with how many people used each) under Admin → Activity, for feature reviews. One migration
  (`0054_activity_stats`).

## [0.19.3] — 2026-10-20

Upgrading: pull the new images and restart; no migrations, no new settings. Bug fixes from a full audit and QA pass.

### Fixed

- Provider batches: a result that could not be stored (a storage or database hiccup) failed its job and closed the
  batch, losing a paid image. The batch now stays open and the next poll finishes it from where it stopped: the
  stored image is reused, usage is billed once, and the panel art or reference is activated.
- A cancelled export is no longer rendered when its job is picked up, and a cancel during a render can no longer be
  overwritten by the render completing. A narration line deleted mid-synthesis reports the job as failed.
- Cancelling a draw that no worker had picked up (paused or queued) now puts its panel back to planned or ready,
  from every cancel path, unless another draw of that panel is still live. Retrying a comparison draw no longer marks
  the panel as queued.
- A pasted (manual) answer sent twice, for example by a double click, is refused with 409 instead of being taken as
  the answer to the next question.
- Job and image lists no longer skip or repeat items across pages when several were created in the same millisecond.
- Moving a chapter renumbers the project's chapters 1..n, and reordering panels numbers every panel on the page, so
  no two share an order (reading order and video shot order were a toss-up). Moves and splits on one page or project
  take turns, and so do adding and deleting a panel. A page move after an unknown page is a 404.
- Applying lettering defaults, fitting faces and clearing lettering skip locked pages (a single locked page is a 409).
- Bad input gets a 4xx, not a 500: an empty update, malformed form fields on vision uploads, and a malformed video
  chapter id.
- Web: the page editor no longer loops on a refused save, keeps a page's unsaved edits when you switch pages (and
  resends them once if that save fails), and is read-only for locked pages and viewers. Number fields clamp when you
  leave them instead of on every keystroke. An autosaved field saves a change made just before you leave. Opening
  Settings no longer saves the project, and viewers see it read-only. Delete on a narration caption explains how to
  remove it instead of failing. The image description and YouTube package spinners stop when a job is waiting for a
  pasted answer. Repurpose labels are capped at 60 characters. The series publish date saves when you leave the field
  (in order with Publish now and Unpublish), and the adoptable list refreshes after adopting.

## [0.19.2] — 2026-10-17

Upgrading: pull the new images and restart. One migration runs on start through the migrate service
(`0053_fk_and_lookup_indexes`, plain indexes, seconds on a large instance). No new settings. Faster video renders
and database lookups; output is unchanged.

### Changed

- Video renders are about 4x faster per shot: each Ken Burns shot decodes its still once instead of once per frame
  (the free still-motion clip model too). A 73-shot, 12-minute chapter went from about 26 s to 6 s per shot.
- Video renders do the soundtrack during the shot encodes: it is mixed and its loudness measured while the shots
  encode, then one final pass joins the shots and applies loudness, replacing three passes after the shots. The
  loudness measure no longer decodes the video.
- A finished video export records how long each render phase took (`result.timingsMs`).
- 18 database indexes on foreign keys and per-job lookups of the large tables. A page of generations with costs went
  from 595 ms to 7 ms, and deletes (trash and render-cache sweeps) no longer scan child tables.

## [0.19.1] — 2026-10-17

Upgrading: pull the new images and restart; no migrations, no new settings. A security patch from a full audit of the
codebase. Upgrading revokes no tokens: if you suspect a stolen session, change your password afterwards, which now
also ends its agent tokens.

### Security

- A project's thumbnail art, music bed and shot clips must be its own files: a settings update checked only the
  watermark, and a project import kept the exporting instance's asset ids, so a project could render another
  project's image or clip (or name its music in a provenance record) given that asset's id. Now checked when set and
  when read; an import drops those ids, and a project made from a template no longer carries the template project's
  thumbnail, logo or music.
- A password change or reset now ends every agent token of the account (personal access tokens and OAuth access and
  refresh tokens): a token made with a stolen session outlived the password. The password, sessions and tokens
  change in one transaction, so a failed revocation leaves the old password in place.
- MCP `asset_library`: an asset of one project can no longer carry an action into another (the approval named the
  asset's project, the action ran in `projectId`).
- An approved call of an in-app agent run reaches only the run's project; approving reloaded the connection with
  access to every project.
- One private-address check for custom AI endpoints and OAuth client metadata, in every IPv6 spelling: the client
  metadata fetch let a mapped loopback written in hex (`::ffff:7f00:1`) through. Local-use NAT64
  (`64:ff9b:1::/48`) counts as private.
- Dependencies: sharp 0.35.5 (librsvg CVE-2026-96889), @modelcontextprotocol/client 2.2.0 (tests),
  source-map-js 1.2.2 (build).

### Changed

- CodeRabbit reviews pull requests into `staging` too (`.coderabbit.yaml`).

## [0.19.0] — 2026-10-14

Upgrading: pull the new images and restart. One migration runs on start through the migrate service
(`0052_ai_video`). New optional setting: `VIDEO_WORKER_CONCURRENCY` (default 2); video clips need ffmpeg on the
worker. AI video: generated clips per shot (free still motion, fal.ai and providers' own APIs on your key), long shots
in continuing parts, ads from a brief, text on screen, a music bed, and image estimates by quality.

### Added

- AI video ([AI_VIDEO](docs/AI_VIDEO.md)): a shot can play a generated video clip instead of its still and camera move.
  Panel tab → *Video clip* makes one from the shot's artwork with a video model: *Still motion*, free on every server
  (ffmpeg, no key), or a fal.ai model on your own key (Seedance 1.0 Pro Fast, Grok Imagine 1.5 Lite, Hailuo 02, Wan
  2.5, PixVerse v6, Kling 2.5 Turbo Pro, Kling 3, Veo 3.1 Fast) or a provider's own API (below), priced per second
  before it runs; *Compare with* makes a second with another model to choose from. Chapter → *Animate shots* does every shot with a price check first.
  Videos and the preview play the clips (held on the last frame when the narration is longer). Clips are
  `panel_clip` assets made on a new `video-generation` queue (`VIDEO_WORKER_CONCURRENCY`, default 2); a restarted
  worker resumes polling the same provider request instead of paying again. Usage is billed per second
  (`video_second_rate` on rate snapshots, `video_seconds` on usage) under the project and server budget caps.
  Migration `0052_ai_video`.
- Ads: Story → *Ad from a brief* writes an ad's script (scenes with what is seen, the voiceover and text on screen)
  from product, audience, message, offer, call to action, notes, length and tone, saved as a new story revision.
  *Text on screen* per shot (headline, caption or a boxed call to action) is burned into videos; Settings → Video →
  *Music bed* loops an uploaded track under the film, lowered while the narrator speaks; a clip's own sound can be
  mixed under the narration. New project presets *AI video ad, 60 s* (realistic or cartoon) and *AI video story,
  3 min (anime)*, and a *Cartoon* style.
- Video providers' own APIs besides fal.ai: Google Veo 3.1 Fast and Lite (on a Gemini key), Kling 3.0, Runway Gen-4
  Turbo, MiniMax Hailuo 02 and 2.3, and Seedance 1.5 Pro on BytePlus ModelArk (new provider kinds `kling`, `runway`,
  `minimax`, `byteplus`; their keys are saved unchecked, as none has a free check). Not yet run with real keys.
- Long shots up to 60 s: made in parts (the model's longest clip, or a chosen part length), each starting from the last
  frame of the part before with a prompt for its own seconds (what happens, what the parts before showed, keep
  everything continuous), joined into one clip. Parts are billed and kept as they land, so a failure or a restart
  resumes at the part it stopped on.
- Provenance records list each panel's video clip (provider, model, job, prompt fingerprint, parts) and the music bed
  with its licence note.

### Fixed

- Shown costs of a clip (Panel tab → Video clip) and of a model comparison run are their own job's spend: the
  query matched every job's usage (a clip showed the whole server's spend; comparison runs showed $0). Budgets were
  never affected. A clip's own words for what moves now set its camera too (no default "slow move" next to "static
  camera"): clip prompt v2.
- Image estimates follow the project's image quality and provider (measured on real runs: gpt-image-2 about $0.015
  an image at low, $0.067 at medium, about four times that at high; Gemini about $0.035 at any quality): they assumed
  low-quality OpenAI images for everything, under-pricing medium about fourfold. The production cost planner prices
  images from runs of the chosen model at that quality only (it averaged every provider and quality together). The AI
  video presets start at low image quality, like the others.
- Markdown and plain-text export files (provenance records, captions) are stored with their own extension instead of
  `.bin`. MCP `video_clips` answers with each job's id, shot, status and model rather than whole job rows.
- MCP `video_clips` (models, list, generate or compare, use, delete, animate a chapter, with `dryRun` prices) and
  `write_ad_script`; `update_panel` `video` takes the clip, clip prompt, clip sound and text on screen, and merges
  instead of replacing (a change to the camera move no longer clears other shot settings).

## [0.18.0] — 2026-10-12

Upgrading: pull the new images and restart. Twelve migrations run on start through the migrate service
(`0040_panel_source_span` to `0051_panel_alt_text`). New optional settings: `WORKER_CAPABILITIES` (what a worker can
do beyond what it detects) and `REGISTER_LIMIT_PER_HOUR` (default 10). Source-to-panel tracing, story timeline,
location states, directing controls, coverage sheets, a reference board, image tools, comic effects, near-duplicate
checks, model comparison, translated lettering, a prompt lab, editing the video in words, native 9:16 projects, hook
variants, export targets, a public series reader, a richer asset library, per-project storage policies, workers by
capability, provenance records and accessibility.

### Added

- Accessibility: every panel has alt text — written by hand on the Panel tab (even when the panel is locked) or made
  from its story beat, dialogue and sound effects — which EPUBs, reader links and the series reader give each page
  image; EPUBs declare accessibility metadata. Health → *Accessibility* counts hand-written alt text, flags comic
  pages whose panel numbers differ from where the panels sit and lettering too faint (WCAG 4.5:1) or too small for
  the format, and links a full narration transcript. MCP `get_accessibility`; `update_panel` takes `altText`.
  Migration `0051_panel_alt_text`.
- Provenance records (Exports → *Include a provenance record*): an export can ship a record of what made it — the app
  version, story revision, each panel's job, provider, model, template version, prompt hash and prompt-lab rules (or
  the upload or tool), the references its cast, places and props draw on, narration voices, lettering fonts with
  their licences — as JSON and a readable page. Files in the asset library take a licence note (where the file comes
  from and on what terms), which the record carries. Also `GET /api/projects/:id/provenance` and MCP
  `get_provenance`. Migration `0050_asset_licence`.
- Workers by capability: each worker detects what it can do (ffmpeg, the narration voice) and is told the rest with
  `WORKER_CAPABILITIES` (`gpu`, `comfyui`, or `-ffmpeg` to keep a small machine off renders); it takes only the
  queues it can serve, so a job waits for a worker that can run it. Workers check in every 30 s, and Admin →
  Overview lists them with what they can do and take, and warns when work waits on a queue no running worker takes.
- Storage policies per project (project settings → *Storage*, owner only): how long each kind of expendable file is
  kept (cached video sections, exports, older panel versions, unused narration takes, trash, prompt reference
  copies) and a storage cap the project stays under, applied at each hourly maintenance pass or at once with *Apply
  now*; while a project is still over its cap, new AI work and exports wait. The server-wide policy (Admin →
  Storage) gains the same per-kind ages, e.g. exports kept longer than the render cache. MCP `project_storage`.
- Asset library (project → *Assets*): tags, collections and favourites; search by name, type or tag; filters by
  character, place or prop (their reference images and the panels they are drawn in), source (generated, uploaded,
  edited), model and date; *Unused* (old versions and images nothing uses) and *Duplicates* (the same file stored
  twice) views; *Find images like this* (no AI, the near-duplicate finder's features); bulk tag, collect,
  favourite, trash and restore; and per file, where it came from (job, model, template, upload or tool) and what uses
  it. Tags and collections follow a duplicated project. Migration `0049_asset_marks`; MCP `asset_library`.
- Public series reader (series → *Reader page*): an optional unlisted or public page at `/s/<address>` with the
  series' cover and description and, per episode, the chapters you publish — now or on a date (a scheduled chapter
  is listed as coming). Readers need no account: page by page or as one scroll, right to left where the series
  reads that way, in the original language or any its lettering was translated into, with an RSS feed of new
  chapters and a social preview (title, description, cover). Migration `0048_public_series`; nginx routes `/s/`.
  MCP `manage_series` and `manage_chapter` set the page and publish dates.
- Export targets (Exports → *Export for*): presets for YouTube, YouTube Shorts, TikTok, Instagram Reels, Instagram
  carousels, WEBTOON Canvas, Tapas, an Amazon KDP paperback and plain PDF. Picking one sets the export (kind, frame,
  resolution, strip width and image height, page size), lists what a check cannot measure (safe areas, naming,
  codecs) and checks the platform's limits first — a panel cut's length from the timing, a PDF's page count, the
  strip's images, a Short's length; the files are checked again once made and the result shows on the export.
  Carousels from Repurpose are checked against Instagram's. Webtoon exports can cut any image to the exact height
  limit (`webtoon.exactHeight`). MCP `export_targets`; `create_export` takes `target`.
- Hook variants (Exports → panel-cut video → *Hook variants*): alternative openings in front of the same film, each
  its own narration (about 15–30 s, voiced with the narrator voice) over 1–6 panels you pick, with an optional title
  and thumbnail headline for that version's upload (the thumbnail downloads with that headline). Pick one as the
  export's *Opening*: it plays first, then the intro card and the film, in the preview and the render; the file is
  named for the hook, and only the opening's shots are encoded — the film's sections are reused. Export option
  `video.hookId`; hooks live in `settings.video.hooks`.
- Native vertical projects (new project → *Narrated vertical video (9:16 shots)*, or a film project's *Shot frame*
  before it has pages): every shot is planned for a tall frame (`vertical-shot-planning`, `vertical-shot-outline`,
  `vertical-scene-shots` v1), drawn at 1080×1920 with a prompt composed for a phone held upright (`panel-generation`
  v15) and rendered vertical by default, so nothing is cropped out to make a Short. MCP `create_project` takes
  `filmFrame`.
- Edit the video in words (project → *Timing* → *Edit in words*): say what to change — “make chapter 4 faster”,
  “cut every silence over 900 ms”, “add a title card before chapter 8” — and a text job (`video-edit` v1, paste
  mode included) proposes timeline edits, each listed with what it would change now: pauses capped or scaled in a
  chapter or the whole video, each shot's own minimum hold, one shot's motion, fade or whether it plays, intro,
  outro and chapter title cards, scene-break fades. Tick, change or reject them; applying recomputes each against
  the project as it is then and writes them together. Nothing is drawn or voiced. MCP `edit_video` (applying waits
  for the user's approval).
- Chapter title cards (project settings → Video → *Chapter cards*): a card before a chapter's first shot, drawn over
  that chapter's first artwork, in the preview and every video render; chapter timestamps point at the card. They
  follow their chapters into a duplicate and stay out of channel profiles.
- Prompt lab (project → *Prompt lab*): rewrite the rules of a built-in prompt for one project — chapter planning
  (outline and pages, per format), panel prompts and narration — or add rules and exclusions to every panel image
  prompt. Preview the compiled prompt (or up to three panels' prompts) and the diff against the built-in, save
  versions, switch between them or back to the built-in. The template header, the rule that story content is data
  and the answer format are never part of what changes; every job records the version it used (migration
  `0047_prompt_overrides`). MCP `prompt_lab`.
- Translated lettering (chapter → *Translated lettering*): a chapter's speech bubbles and on-page captions in
  another language, translated by the text model (`lettering-translate` v1, paste mode included, fitted to each
  bubble's length) and edited by hand, for a translated edition of the same art. Page exports (PNG, JPG, PDF, CBZ,
  EPUB, webtoon) take a *Lettering language*, videos letter in their narration language, and page previews take
  `?language=`; a line whose original changed shows as out of date, and hand edits survive a new translation
  (migration `0046_lettering_translations`). MCP `translate_lettering`.
- Model comparison (page editor → Panel tab → *Compare models*): draw one panel with 2-4 image keys and models at
  once and see them side by side with the time each took, its estimated cost and its visual check (when the
  project's checks are on). The panel keeps its artwork until you pick one; the pick becomes its artwork and your
  image model, so the chapter's *Generate* draws with the winner. Runs stay in the panel's versions. MCP
  `compare_models`.
- Near-duplicate finder (Storyboard → *Near-duplicates*): a scan without AI (a `duplicate_scan` job) groups
  near-identical panels, the same figure staging in panels that are not neighbours, the same background reused in
  another scene, and near-identical cover or thumbnail art, with a score and links to each panel. Uses small image
  features computed once per image (a difference hash, an edge map of the middle, a colour histogram of the border;
  `asset_features`, migration `0045_asset_features`) rather than a model. MCP `find_duplicates`.
- Comic effects as layers (page editor → Panel tab → *Effects*): speed and focus lines, an impact flash, screentone,
  rain, snow, dust, a glow and a flashback tint, up to six per panel, each with its own centre, angle, density,
  strength, size and colour. Drawn by the app over the art, no AI and no cost, the same on the canvas and in every
  page, strip, video, carousel and quote render (`effectLayers` in packages/domain), clipped to the panel's shape; the
  art itself is unchanged. Migration `0044_panel_effects`; MCP `update_panel` takes `effects`.
- Image tools (page editor → Panel tab → *Image tools*), each making a new artwork version with the previous one kept:
  without AI and free, *Upscale 2x*, *Line art* and a palette taken from a board image (a colour transfer in CIELAB);
  as masked edits of the whole picture, *Repair faces & details*, *Relight*, *Remove background*, *Colourise* and a
  character's expression; and *Outpaint* to 9:16, 16:9, 1:1, 4:5 or 2:3, painting the scene outwards on a wider
  canvas so art is widened instead of cropped. A layout guide can be cleaned up (sketch to solid strokes) or turned to
  line art. `POST /api/panels/:id/tools`, `POST /api/panels/:id/guide/tools`; MCP `panel_image_tools`.
- Reference board (project → *Board*): images collected for mood and look, each with a note. Drop one onto a
  character, an outfit, a location (or one of its states), a prop or the project style as a draft reference to
  approve, use it as a panel's layout guide (page editor → Panel tab → *Layout guide* → *From board*), or have one
  aspect of it described (lighting, costume, mood, pose…). Migration `0043_board_items`. MCP
  `manage_reference_board`.
- Coverage sheet (page editor → Panel tab → *Coverage sheet*): one image of the panel's moment from nine camera
  setups (wide, full, medium, close-up, extreme close-up, over the shoulder, insert, low and high angle), drawn with
  the panel's references (`coverage-sheet` v1, a `coverage_sheet` job). Pick cells: one reframes the panel, several
  become new panels on a page right after it (one page per pick in film and strips); each takes its cell as a strict
  layout guide and its setup's shot type and angle, ready to draw at full size. MCP `coverage_sheet`.
- Directing controls (page editor → Panel tab → *Directing*): optional camera height, lens feel, depth of field, shot
  purpose (establish, reveal, reaction, insert, action, dialogue, transition) and focus subject, and for each figure
  the side shown (frontal, three-quarter, profile, back, over the shoulder, point of view), facing, eye-line, depth
  and what they hold. Saved with the panel spec (`direction`), so drawn art goes out of date when they change; the
  panel prompt states them (`panel-generation` v14). MCP `update_panel` takes them in `spec.direction`.
- Location states: a place's states over story time ("after the fire", "snowed in", "at night"), on the location's
  page (World → location → *States over story time*): what differs from the design, words matched against a scene's
  time and weather, and/or a chapter range; each can get its own reference image, drawn from the place's approved
  design. A scene shows the state it picks by hand (scene editor → *Location state*), else the one its time or weather
  matches, else the one its chapter falls in; its panels are drawn as the place is then (`panel-generation` v13,
  `location-reference` v6) with the state's reference in place of the design's. Migration `0042_location_states`.
  Copied when a project is duplicated. MCP `manage_location_states`; `manage_references` and `manage_scene` take
  `locationStateId`.
- Why is this stale: on the project overview, each out-of-date stage of the production card (story → plan → prompts
  → art → narration → audio → render) opens the chapters, pages and panels behind its count, each with what changed
  under it and what an update would redo: a story revision's new and removed paragraphs, the panels a chapter's text
  revision hit, the spec fields edited after a panel's artwork, the panels changed after a chapter's narration, why
  each chapter's audio is outdated (missing, text, voice or speed), and what changed after the newest video.
  `GET /api/projects/:projectId/staleness/why`; MCP `get_staleness` with `why: true`.
- `REGISTER_LIMIT_PER_HOUR` (default 10): sign-ups per hour from one client address, until now fixed at 10.
- Story source (chapter page → *Story source*): the chapter's text with the part each panel tells marked, its scene
  and narration on hover and a marker that opens the panel; the page editor's Panel tab shows the panel's text
  (*From the story*) and links back. Traced without AI when a chapter is planned (older chapters on first view), from
  the panels' beats and dialogue in reading order (migration `0040_panel_source_span`). When the story is revised
  under a panel, the chapter lists exactly the panels whose text changed, with what they were planned from; *Trace
  again* or keeping the plan re-traces them. `GET /api/chapters/:id/source`, MCP `get_chapter_source`.
- Story timeline (project → *Timeline*): the story's events in story-time order (a flashback where it happened), each
  with the story's own words for when, an optional story day giving the time since the previous event and, from a
  character's birth event, their age; the chapter and scene that tell it; and the bible's character states shown at
  the event they start from. A day that runs backwards is flagged. Add, edit, reorder and delete by hand, or
  *Extract from story* (a text job, paste mode included) and apply the reviewed events, merged in by day (migration
  `0041_timeline_events`). The bible's state list tab is now called *States*. MCP `get_timeline`,
  `manage_timeline`, `run_timeline_extraction`, `apply_timeline_extraction`.

### Fixed

- MCP: `update_project` explains video hook variants (`settings.video.hooks`), `update_panel` lists `altText`, and
  `create_export` explains `language` (lettering edition or narration track), `target` and `provenance`.
- A video with no narration (pages or shots not voiced yet) failed to render: its silent soundtrack measured
  -inf loudness and the normalising pass broke. Silence is now left as it is.

## [0.17.0] — 2026-10-09

Upgrading: pull the new images and restart. One migration runs on start through the migrate service
(`0039_page_edge`). No new settings. Panel shapes, page and panel edges, page borders and custom page layouts for the
page editor, plus editor fixes for dragging and resizing.

### Added

- Borders for a whole page (page editor → Page tab → *Borders*): this page's own edge, over the project's (migration
  `0039_page_edge`), and one border style set on every panel of the page at once.
- Custom page layouts: *Save as layout* on a page (page editor → Page tab) keeps its panels' frames, shapes and
  borders as one of your layouts, for any of your projects (`/api/layouts`). A project picks the ones it uses
  (settings → *Page layouts*): planning a chapter gives each new page one with its number of panels, in turn, instead
  of a built-in template, and *Apply layouts* re-lays a chapter's pages (or *Re-lay every page* the whole project's)
  the same way, keeping their art and text. A page can also switch to any saved layout from the Page tab, and delete one there (its ✕). Layouts are
  mirrored for right-to-left books. MCP `manage_layouts`; `manage_page set_layout` takes `custom:<id>`.
- Panel shapes: a panel can have a polygon outline instead of a rectangle. In the page editor, *Edit shape* on the
  Panel tab shows a handle on every point (drag it, double-click to remove it) and a dashed circle on every edge (click
  to add a point there), for slanted gutters, pointed tops and two panels sliding into each other. The art is cut to
  the outline and the border follows it in page renders, PDFs and the PSD and layered exports (a webtoon strip
  re-flows each panel to full width, so it shows the whole art); *Reset to rectangle* undoes it.
- Page and panel edges (project settings → *Page and panel edges*): wavy, torn paper, rough cut, brush stroke or
  burnt edges, with a depth, for every page's outline and as the default for panel borders; a panel can pick its own
  on its Panel tab (*Border*). The art is cut to the edge and the edge drawn along it, the same way every time.
  Page images and PDFs draw a page edge on paper white; videos cut the page out along it, so the blurred backdrop
  shows around it (`?cutout=1` on page images does the same for the video preview). Stored in `settings.edges` and
  on the panel's frame (no migration). Stored as optional `points` on the panel's frame (no migration).

### Fixed

- Page editor: dragging a panel, bubble or sound effect against the page edge no longer snaps it back on release:
  it stops at the edge while you drag. Resize anchors, panel shape points and the bubble tail handle are bigger and
  keep one size on screen at any zoom, with a wider grab area. *Move / zoom image* has a zoom slider and says why an
  image at 100% only moves along the side that overflows.

## [0.16.1] — 2026-10-08

Upgrading: pull the new images and restart. No migrations and no new settings. Security fixes for features added in
0.16.0; upgrade if you use the in-app agent, series or YouTube stats with more than one user.

### Security

- In-app agent: the thinking steps of a run (its plan, tool calls and what they returned) were readable by every
  member of the project through the job pages, though runs are private to whoever started them. They now are too;
  the project's job list still shows the steps' cost, without their content.
- Series: a library's images are visible to members of an episode only when that episode uses them as references,
  not every file of the library.
- Reader links with comments: a member's reply shows their display name to guests, never their username.
- YouTube stats:
  - Without an API key, reading a video's counters could fall back to any other user's connected channel token,
    which shows that user's private videos. Counters are now read only with the link's own connection, the
    caller's channel or the instance's API key.
  - Routes that call Google are limited to 60 calls per 10 minutes per user, so one person cannot spend the
    instance's daily quota. Live counters are cached even when a video came back missing.
  - A member removed from a project no longer feeds it their channel's analytics and reach, and reconnecting the
    channel does not attach it to projects they left.
  - Disconnecting keeps the channel when Google cannot be reached to revoke the grant, so it can be retried. A grant
    Google refused has its tokens deleted.

## [0.16.0] — 2026-10-08

Upgrading: pull the new images and restart. Four migrations run on start through the migrate service:
`0035_better_comments` (pins, video moments, assignees, guest comments on reader links), `0036_agent_runs` (the
in-app agent), `0037_series` (series, and the link columns on characters, places, props, styles and bible facts) and
`0038_youtube_stats` (YouTube channels, linked videos, reach rows and counter snapshots). Nothing existing is changed.
New optional settings: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and `YOUTUBE_API_KEY` for YouTube stats
(setup in docs/DEPLOYMENT.md); without them channels cannot be connected and everything else works as before. The
Kokoro image is rebuilt with pinned dependencies. Reload open tabs to get the new web app.

### Added

- In-app project agent (project → Agent): give it a goal and an optional budget; it writes a plan to approve or send
  back, then works one tool call at a time through the same MCP tools, scopes and approvals as a connected agent, as
  your In-app agent connection held to that project. Steps that spend or change wait for approval on the page or in
  Agent access; every call and its result is shown. It stops at 25 steps or its budget, and runs in paste mode too.
- Series and shared libraries (top bar → Series): episodes that share one library of cast, places, props, style and
  story bible, edited as a project of its own, and a channel profile. Episodes follow the library through a sync
  that adds new entries, versions changed ones and points at the same reference images (no copies); the dashboard
  shows each episode's progress, spend, exports, open comments and how far it is behind. Add an episode, adopt a
  project (its same-named cast becomes linked), split a long story into episodes at its chapter headings, and find
  every appearance of a library character across the series. MCP `list_series`, `get_series`, `manage_series`.
  See docs/SERIES.md.
- YouTube stats per project. Connect YouTube channels (each its own read-only OAuth connection, `youtube.readonly` and
  `yt-analytics.readonly`, with the instance's own Google OAuth client: `GOOGLE_OAUTH_CLIENT_ID`,
  `GOOGLE_OAUTH_CLIENT_SECRET`, optional `YOUTUBE_API_KEY`; setup in docs/DEPLOYMENT.md) and link a project's
  published film and Shorts from a channel's uploads or by pasting any YouTube link form, each naming the export or
  Short it came from. The new **YouTube stats** page shows totals across videos and channels, film against Shorts, the
  first-48-hours curve of each release, and per video a daily chart from the Analytics API (queried when opened,
  15-minute cache) with traffic source, country, device and Shorts-or-long-form splits, the live counter for the days
  Analytics has not reached, and thumbnail impressions and CTR from Reporting API reach reports (jobs created on
  connect, daily reports reduced to the rows of linked videos). An hourly worker pass snapshots public counters
  (hourly for a video's first 48 hours, then daily for channels not connected) and applies retention under YouTube's
  developer policies (unauthorized statistics kept 30 days; a channel's data deleted when it disconnects, its grant is
  revoked, or its authorization is not re-confirmed for 30 days; see docs/SECURITY.md). Channel tokens are encrypted
  and rotated with the provider keys. MCP: `get_youtube_stats` under the new `stats:read` scope. Under
  `AI_MOCK_MODE` a fake Google, consent screen included, runs it all locally. Migration `0038`.
- Better comments:
  - **Pins:** a thread can point at a spot on the panel's artwork (*Pin a spot*), shown as a numbered pin.
  - **Video moments:** a thread can point at a moment of the chapter's video (*Comment* in the video preview, panel
    cut), which opens the preview there.
  - **Assignment:** threads can be assigned to a member, who is notified; the Comments page can show only yours.
  - **Before and after:** a thread shows the panel's artwork when it was started next to the art it was resolved on
    (or shows now).
  - **Production run:** the run card counts the project's open comment threads.
  - **Guest comments:** a reader link can let readers comment on panels under a name, without an account; they see only
    the threads left through that link, and the owner is notified.
  - **MCP:** `post_comment` takes `anchor`, `timecodeMs` and `assignTo`, `list_comments` takes `assignedToMe`, and the
    new `assign_comment` reassigns a thread.
  - Migration `0035`.
- Layered exports for finishing in Photoshop or Clip Studio. `psd_pages` writes one layered PSD per page: a group per
  panel with its art, frame and (hidden) layout guide, then effects, captions and dialogue, each element its own layer
  named by its text, over the lettered page as the flattened image. `layered_package` zips the text-free page, the
  lettering as one SVG (vector text and shapes) and every layer as its own transparent PNG, with `manifest.json`
  giving each file's position, size, stacking order and text. Both are on the Exports page and MCP `create_export`.
- Visual checks: the panel check now also judges identity, outfit, props, location, expression, pose against a strict
  layout guide, framing, anatomy, style and palette drift, beside headcount and stray text, and measures faces hidden
  under bubbles or captions. Each is set in project settings to off, flag only, regenerate once, or regenerate up to a
  budget (at most 3 re-rolls in a row, while the project's automatic re-rolls cost less than the budget). All aspects
  are judged in the one vision call; the panel badge says when a panel is being redrawn, or why it was not.
  A panel check no longer leaves its panel showing "generating" after it ran; the hourly maintenance puts panels left
  that way back to ready.
- Production cost planner: the *Produce* and *Update production* dialogs price what the run would still do before it
  starts, chapter by chapter (plans, prompts, panels to draw, narration, local-voice audio) plus the analysis,
  references, thumbnail and YouTube text, with the chosen models and this server's own average usage per job. They
  show what runs now and what waits for a half-price batch, the disk the new files will take, the budget left, and a
  warning when the run would reach the cap. Chapters not planned yet are estimated and marked.
  `POST /api/projects/:projectId/production-runs/estimate`, MCP `estimate_production_run`.
- Storage policy (Admin → Storage): delete files the app can do without (cached video sections, export files, older
  AI-drawn panel versions, unused narration takes, trash, prompt reference copies) once they are older than a number
  of days, and then the oldest of them until everything stored is under a size limit, whichever limit is crossed
  first. Delete automatically at the hourly maintenance pass, or ask first: administrators then see a warning at the
  top of every page, which cannot be dismissed until they approve or change the policy. Art a panel shows, approved or
  locked art, references, covers, thumbnails, uploads and narration in use are never deleted. A dry run shows what
  would go.
- Print workflow (`docs/PRINT.md`). The PDF export takes a contents page (`pdf.toc`), blank pages so every chapter
  opens on a right-hand page (`pdf.rectoChapters`), and book metadata written into the PDF (`pdf.metadata`: title,
  author, subject, keywords, language). A new `print_cover` export renders the wraparound cover as one PDF with
  bleed: the cover art on the front with the title and author, the spine sized from the interior's page count and
  the paper (KDP's white, cream and colour thickness, or a custom one) with the title when the book has 79 pages or
  more, the description on the back above the barcode area, mirrored for right-to-left books, plus a preview with the
  trim, safe areas and barcode box drawn on. `GET /api/projects/:projectId/print/cover` checks it before rendering
  (missing art, art under 300 DPI, spine too thin for text, text that had to be shortened), and the drawn text is
  measured against the safe areas after rendering. A new `print_preflight` export measures the interior the PDF
  would print: each page's resolution and its panels' art resolution, total ink, colour shift through CMYK, lettering
  outside the safe area (with KDP's gutter), the fonts the lettering uses and whether the server has them, and the
  page count and its parity. The Exports page shows the cover check live and the preflight report with a soft proof
  of any page next to it (`GET /api/pages/:id/render.png?proof=cmyk|grey`).
- Subtitles in the video preview: the narration being spoken is drawn on the picture, timed like the render's
  subtitles (a shot's whole line while it has no voiced audio), and toggled with *Subtitles* or C. On by default and
  remembered per browser.
- Hook lines for repurposed Shorts: each Short, trailer and teaser of the repurposing plan has a *Hook line* the narrator
  says before its first shot, written with the titles and captions (*Write titles, captions and hooks*) and editable.
  It is voiced with the project's narrator voice and pronunciation dictionary, holds the first shot for its length, and
  starts the subtitles and captions. `video.hook` on `video_shorts` exports.

### Fixed

- Local voice (Kokoro): a fresh build installed transformers 5, which needs a newer PyTorch than the one the image
  pins, so the voice model never loaded and narration audio failed. transformers and huggingface_hub are now pinned.

## [0.15.0] — 2026-10-05

Upgrading: pull the new images and restart. One migration (`0034_comment_agent_source`) runs on start through the
migrate service: four columns on `panel_comments` recording comments and resolutions made through an agent connection.
Existing comments count as written by hand. No new settings. Reload open tabs to get the new web app.

### Added

- Comments from agents: MCP `resolve_comment` resolves or reopens a thread, so one agent can audit a project with
  `post_comment` and another (or you) can read the open threads with `list_comments`, fix them and resolve them.
  Every comment and resolution shows whether it was written by hand or through an agent connection ("MCP"); only the
  member whose connection it was also sees its name. Notifications say "via MCP". Migration `0034` adds the columns.
- Thumbnail variants: Exports → YouTube package shows every thumbnail headline composited on the same art side by
  side, each with *Use* and a full-size download, and the headlines are now editable there. The YouTube package
  export ships each one as its own image (`thumbnails/1-….png`) next to the title options in `titles.txt`, for
  YouTube's Test & compare. No images are generated for them.
- Shot variety check: runs of panels repeating the same shot size (four in a row) or framing (the same size and
  angle, three in a row) are flagged on the storyboard (*Repeated shot* filter, with the run on each card) and on the
  Health page, and returned by `GET /api/projects/:projectId/shot-variety` and MCP `get_project_checks
  check=shot_variety`. It reads the plan only: nothing is spent.
- Audio check (Narration QA → *Check audio*, or `audio: true` on the narration lint routes and `run_narration_lint`):
  measures the voiced narration with no model and nothing spent, and flags silent takes, clipping, a stall inside a
  line and lines much louder or quieter than their chapter, plus chapters out of step in loudness. A *Loudness* tab
  shows each chapter's integrated loudness, range and true peak (EBU R128). Audio findings offer *New take*, which
  synthesizes the lines again even where the same take is cached (`newTake` on chapter synthesis; the one-segment
  route's `force` now does the same).
- Captions on Shorts: a Shorts cut (Exports → Shorts, or a Short, trailer or teaser on the Repurpose page) can have its
  narration drawn into the picture, in three styles: a clean line at the bottom, a few large words in the centre, or
  two lines at the bottom. `video.captions` on `video_shorts` exports and on repurposing items; off by default, and
  long videos keep the `.srt` only. Not yet for Japanese, Korean, Chinese, Hindi or Thai narration: the render image
  has no font for those scripts.

### Fixed

- A link to one panel of a page (a comment notification, the open-comments list, a storyboard card) now opens the
  page editor on that panel; it opened on the page's first panel.
- Repurpose no longer crashes the tab on long projects: each item's panel pick list (one row and thumbnail per panel)
  is built only while it is open, and its thumbnails load as they scroll into view.

## [0.14.0] — 2026-10-04

Upgrading: pull the new images and restart. Six migrations (`0028`–`0033`) run on start through the migrate service;
`0033` records what each chapter's existing plan and narration were made from, so nothing shows as out of date after
the upgrade. No new settings. Reload open tabs to get the new web app.

Upgrading: six migrations: `0028_production_run_warnings` adds a nullable JSON column, `0029_story_bible` adds the
story bible's two tables, `0030_production_run_lease` two nullable columns to `production_runs`,
`0031_continuity_findings` the continuity findings, `0032_narration_findings` a table for narration QA findings, and
`0033_chapter_source_fingerprints` two columns to `chapters`, filled for chapters already planned or narrated so
nothing becomes out of date on upgrade.

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
- **Project health.** A **Health** page (and a card on the overview) says whether the project is ready to publish or
  how many blocking issues it has, and lists them with where each is fixed: panels without artwork, chapters without
  or with patchy narration, segments without audio, a missing or out-of-date video, panels that failed a visual
  check; then what is out of date, the YouTube text and thumbnail headline, unfinished and failed generation, open
  comments, spend against the budget and disk use. `GET /api/projects/:projectId/health`; MCP `get_project_health`.
- **Final-output gate for production runs.** Before a run reports success it now also checks that every chapter is
  narrated, that no panel's artwork failed a visual check and, when it renders, that the video exists and is not
  shorter than its narration beyond the render's drift tolerance. Anything found is listed in its unresolved items
  (`completed_with_warnings`) instead of passing silently.
- **Pronunciation dictionary.** Project settings → Pronunciation maps names and terms to how the narrator says them
  ("Qi" → "chee", "Seo Jinhyeok" → "suh jin-hyuk"), with match-case and whole-word options and a preview in the
  project's voice. It applies only to the text sent to the voice, for every TTS provider: narration, subtitles and
  lettering keep the written form. Changing it marks the audio of the affected segments stale, so the next synthesis
  re-voices only those. Saved in `settings.pronunciation` (also through `update_project` over MCP) and carried by
  project templates.
- **Story coverage check.** Story → *Check coverage* maps the applied story revision to the plan with a text job,
  part by part so long stories stay within context, and lists source paragraphs left out, told in more than one
  chapter, or given far more or less room (share of panels) than their weight, each linked to its span in the story
  (*Show in story* selects it) and to its chapter and scene, beside every chapter's share of the story, the panels
  and the narration. Says when the story or the plan changed since. Works in paste mode (one question per part);
  over MCP as `get_story_coverage` and `run_story_coverage`.
- **Narration QA.** Narration → Narration QA checks a chapter or the whole project. Deterministic checks run at once
  and spend nothing: repeated sentence openings, a flat rhythm, a name used too often, near-duplicate lines, narration that restates
  its panel's dialogue, chapters that open or end alike, and density (crowded shots, stretches of silent shots, and
  words per minute from the real audio). *Check with AI* adds a text job per chapter for meaning repeated in other
  words (also against earlier chapters, given as compact summaries), facts explained a third time and lines that only
  describe their frame. Findings are counted by type and can be reviewed, ignored (they stay ignored on later runs)
  or fixed; a Density tab shows words per shot and per minute, chapter by chapter and shot by shot.
- **Fix only what was flagged.** Select findings and *Fix selected*: a text job rewrites only their lines, the
  changes are shown as a diff to accept line by line, and applying them re-voices only the changed sentences and runs
  the checks again, reporting what is new and what was resolved (optionally the AI check too). Works in paste mode;
  over MCP as `run_narration_lint`, `get_narration_qa`, `update_narration_finding`, `propose_narration_fix` and
  `apply_narration_fix`, with spending behind approval.
- **Channel profiles.** A publication identity one level above templates (Profiles in the top bar): a default preset
  or template, target runtime, narrator voice and speed, pronunciation dictionary, image quality, reference and batch policy, logo watermark,
  scene fades and intro/outro cards, lettering (the cards' font), thumbnail headline side, YouTube title rules, a
  description template with `{hook}`, `{summary}`, `{title}` and `{author}`, default tags, and the shape and resolution
  video exports default to. Create one from scratch or with *Save as channel profile* in a project's settings; the
  new-project wizard's *Channel profile* copies it in, and the project records where it came from. *Re-apply profile*
  on the overview lists what would change before applying. A profile's logo belongs to the account and each project
  gets its own copy. MCP: `list_channel_profiles`, and `profileId` on `create_project`.

- **Browser tests for the recent features.** Four new Playwright specs next to the studio flow, each with its own
  users and one seeded project: `story.spec.ts` (story bible, story coverage, narration QA, timing, pronunciation),
  `video.spec.ts` (repurposing, the Shorts suggestion, shot settings, layout guide, video branding, the reader
  link's video preview), `production.spec.ts` (a production run to the final-output gate and Health, Update
  production with *Keep current*, stopping a run and its jobs) and `collab.spec.ts` (members in a second browser,
  comment mentions and the notification bell, channel profiles, expert output actions). `docs/TESTING.md` lists what
  each covers and how to run them on a host with an install, without compose.

### Changed

- **The YouTube package follows the channel's rules** (`youtube-package` v2): title rules and the description template
  go to the model as the owner's instructions, and the default tags lead every package.
- **Video exports default to the project's output setting** (Settings → Video: frame and resolution) when the request
  names no `video.aspect` or `video.height`; thumbnails default to the project's headline side.
- **`POST /api/projects` with a `preset` fills the type, format, colour mode, language and style from it** when the
  request leaves them out, as the wizard already did; a template's own lettering is no longer replaced on a vertical
  project.
- **Stopping a production run cancels its queued jobs.** Stop used to end only the orchestration while the jobs the
  run had queued kept running and spending. It now also cancels its generation jobs that have not started (queued,
  in a provider batch, paused or waiting for an answer), its queued narration audio and an unfinished export; jobs
  already running at a provider finish and nothing further happens with them. The Stop dialog shows how many jobs
  would be cancelled and offers *Stop the run only* (`{ "jobs": false }` on the API, `jobs: false` on the
  `cancel_production_run` MCP tool).

### Fixed

- The production run card did not show the chapters changed since they were planned after you pressed Continue
  at the analysis review, until the page was reloaded: it refreshed only when the run's status changed, and going
  from one review to the next keeps it "waiting". It now refreshes on every change to the run.
- *Extract from story* read only a chapter's stored source text or summary. Chapters built without an analysis
  have neither, so the model was sent empty chapters and every extraction came back with no facts, shown as a normal
  result. It now reads such a chapter's narration (cut to a share of a 120,000-character budget across chapters),
  and fails with "These chapters have no text to read yet" when there is nothing at all.
- **The YouTube text and thumbnail headline show when they may be out of date.** Renaming the project, changing its
  chapters or rendering the video again left them looking current. *What is out of date* now flags the YouTube text
  (title or chapters changed since it was written, or the video re-rendered after the package was exported) and the
  thumbnail headline (title changed since it was set). They are never regenerated on their own: Update production
  ends with "YouTube text may be out of date" / "thumbnail headline may be out of date", and the card offers
  **Regenerate** and **Keep current** (`POST /api/projects/:projectId/keep-current`; MCP `keep_publishing_text`).

- **Plans and narration go out of date when what they were made from changes.** A chapter whose text changed after it
  was planned counted as up to date (staleness only looked for chapters without pages), so Update production skipped
  it; the same for narration whose panels changed. Chapters now record a fingerprint of what their plan and narration
  were made from, and *What is out of date* counts the ones that differ. Update production never re-plans a chapter
  that has pages on its own: it stops at a review listing them, where each is kept (**Keep current**) or redone
  (**Re-plan** / **Write again**, saying how many pages, drawn panels or lines that replaces), and the Story page offers
  the same choice after a revised story is applied. Agents get `stalePlans` / `staleNarration` from `get_staleness`
  and the new `keep_stale_chapter` tool; `POST /api/chapters/:id/keep` is the route.

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

- **Repurposing.** A *Repurpose* page plans what one finished project is cut into, from its own panel art: several
  Shorts that never share a shot (each from its own part of the story), a 60–90 s trailer, a 15–30 s teaser, a
  10-panel Instagram carousel and quote images (a panel with a line of its narration or dialogue). Review and adjust
  every pick, length, frame and quote, preview the videos, then render each item or all of them as exports: the
  videos as Shorts cuts named after the item, the carousel as a ZIP of 1:1 or 4:5 images cropped with each panel's
  framing, a quote image as a PNG with the line in the lettering font. *Write titles and captions* is a text job
  (`social-copy` v1, paste mode works) that writes a social title and caption for each item, shipped as a caption
  file with its export. Agents use `suggest_repurpose`, `write_social_copy` and `create_export` (`carousel`,
  `quote_image`, `label`, `social`). Hook lines per Short are not included yet (on the roadmap). A Shorts cut can now
  be as short as 15 s.
- **Timing pass.** Once a chapter's narration is voiced, a *Timing* page times it with the real audio lengths (the
  same timeline as the preview and the render): shots past the longest-shot setting or under the shortest, one
  picture held too long, dead air, and the chapter's length against its target. Each fix shows the holds it changes
  and the new length before it is applied: spread a long line over the next shots of its scene, give a shot its own
  minimum hold (also in the panel's *Video shot* settings), or have a text job rewrite chosen lines to a word budget,
  read as a diff, with only the kept lines voiced again. Nothing generates new images. Agents use `get_timing`,
  `apply_timing_fix` and `retime_narration`.
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
