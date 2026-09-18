# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Published container images track tagged releases.

## [Unreleased]

### Added

- **Describe a reference image.** Upload a frame — from a video, a page, anything — and get back descriptions you
  can generate from: art style, character, outfit, location, lighting and palette, composition, mood, props, era
  and technique, each with its own prepared prompt, plus a free-text question of your own. The style, character
  and location results come back in exactly the shape those parts of a project already accept, so they apply in
  one click; everything else is there to copy. Available as its own **Describe** section in a project, and as a
  "from image" button inside the art-direction and character-bible editors, which fill the form you are in rather
  than creating anything. Uploaded images stay in the library as `source_image` assets, so a frame can also be
  attached as a reference to a later generation. Runs on any vision-capable key and batches at half price like
  every other text job.

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
