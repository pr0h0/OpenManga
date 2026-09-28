# Roadmap

What is shipped, what is being considered, and what will not be built. Nothing here carries a date or a promise;
items move when someone builds them. The shipped list is a summary; release-by-release detail (agents over MCP,
experts, reader links, thumbnails and more) is in [CHANGELOG.md](../CHANGELOG.md).

## Shipped

- **Comic and film projects.** Comic projects lay out pages of panels; film projects (`settings.format = "film"`)
  use a 1920×1080 page with no margins, so every page is one full-frame 16:9 shot. The format is locked once pages
  exist (409) and comic projects are not converted — create a film project instead.
- **Story → cast → references → planning → panels → lettering → narration.** Chapter planning for film projects
  uses a shot-planning prompt (one shot per page, no dialogue or SFX) and the plan applier splits any multi-panel
  page into one page per shot.
- **Video exports.** Page cut (`video_pages`) and panel cut (`video_panels`): clean panel art cropped as on the
  page, Ken Burns push-in on wide shots and pull-out on close shots (3× supersampled `zoompan`), hard cuts, an
  `.srt` sidecar, and a lettered page crop as the fallback when a panel has no artwork. See
  `docs/VIDEO_EXPORT_REFERENCE.md`.
- **In-browser video preview.** "Preview video" on a chapter, "Play chapter" on the Pages / Shots list, "Preview
  page/shot video" in the page editor, "Preview move" on a panel, and "Preview in browser first" on Exports.
  `GET /api/video-preview` returns the same shot plan the render uses, and the player reproduces holds, framing,
  scroll and the Ken Burns curve from the same `@openmanga/domain` helpers.
- **Other exports:** PNG/JPG page images, PDF (including Amazon KDP trim sizes, full bleed), CBZ with
  `ComicInfo.xml`, fixed-layout EPUB, webtoon strips, narration audio, timeline, agent package, project JSON and zip
  packages, plus project import.
- **Streaming project import.** Packages stream to disk entry by entry instead of being held in worker memory, so
  import memory no longer depends on package size; `IMPORT_MAX_UPLOAD_MB` (4 GiB by default) bounds disk and time.
- **Multi-language narration** — one narration track per language over the same artwork.
- **Readiness gate and preflight** before anything is spent, a per-project budget cap, batch pause on quota or auth
  failures, and an opt-in vision consistency check on generated panels.
- **Provider batch APIs**, for image *and* text generation, at half price with results within 24h — see
  [AI_PIPELINE](AI_PIPELINE.md#provider-batches-half-price-up-to-24h). Two things this entry predicted turned out
  wrong when it was built: text batching came almost free rather than needing a second path (the provider is
  swapped, so every text handler batches unchanged), and panel *edits* are still excluded — not for size limits
  but because a full-resolution target and mask are a poor fit for a 24h wait.
- **Describe a reference image** into reusable style, character and location descriptions.

## Next

The largest gap is orchestration: every production step exists, but a person still drives each one by hand. These
items are ordered so each makes the next cheaper.

- **Production runs (one-click autopilot).** A resumable run over a whole project: analyse → apply → required
  references → plan every chapter → prepare prompts → generate missing artwork → write narration → synthesize →
  thumbnail → preview → final render. Each step reuses the existing job, skips work already done, stops at review
  gates and at the budget cap, and survives a restart. It brings the project-wide actions with it (plan all
  chapters, prepare all prompts, generate all missing art chunked past the 500-panel bulk cap, write and synthesize
  all narration) and a per-run batch policy: interactive, cheapest (provider batches, up to 24h) or hybrid.
- **Target runtime.** A project-level target (for example 30 or 60 minutes) with words per minute and minimum and
  maximum shot length, turned into per-chapter shot and narration budgets at analysis and planning time. Today only
  `narrationWordsPerPanel` and the export's minimum hold exist, so length is found out after rendering.
- **Production presets, templates and economy mode.** One bundle of settings chosen when a project is created:
  format, style, voice, image quality, shot length, runtime, batch policy and which references to make (skip them for
  minor characters and one-off locations, generate the rest in bulk, characters included). Ships with presets such
  as "YouTube recap, 30 min" and "1 hour", and "Save as template" copies a project's settings without its story,
  cast or assets.
- **Review at scale.** Check all panels: the vision consistency check for a page, chapter or project in one run,
  with a cost estimate, feeding the drift flags and *Move bubbles off faces*. A dense storyboard grid of every panel
  with filters (failed, needs review, no art, check mismatch) and keyboard shortcuts; spending keys ask first.
- **YouTube package.** Chapter timestamps from the render's own shot timings (free and exact), plus a publishing
  bundle: title options, description, tags, a pinned comment and thumbnail headline variants written by a text job
  and stored beforehand (exports make no AI calls), exported as one folder with the video, thumbnail and `.srt`.
- **Partial renders.** Render a range of pages or the first few minutes for a check before the full film.
- **Continuous scroll cut for video.** The same renderer as the page cut with travel set to the full page overflow
  instead of the capped rate. Small; the panel cut shipped without it.

## Later

- **Shots as first-class video units.** Per-shot settings for motion (static, pan, push-in, pull-out, with an
  override and variety across neighbouring shots instead of today's automatic push or pull by shot type), fade to
  black at scene breaks, disabling a shot without deleting it, and one narration line spanning several shots with
  start and end offsets (today a shot can carry several lines, but not the other way round). The renderer and the
  browser preview share the timing helpers, so both change together.
- **Music and ambience.** Background music per scene mood, ducked under narration before loudness normalisation,
  and ambience beds tagged from the scene's time, weather and mood. From a library the user supplies, so nothing
  with unclear licensing ships in the repository.
- **Vertical video for Shorts.** A 9:16 (and 1:1) video profile for the renderer and preview, and a Shorts cut: a
  30–60 s trailer built from key shots of a project. Framed from existing art rather than generated at 9:16, which
  providers return squeezed.
- **Incremental rendering.** Keep rendered sections between exports and re-render only what changed, driven by a
  dependency graph of what is stale (story → plan → prompts → art → narration → audio → render) with one "update
  production" action. Staleness already exists for narration audio, references and checks; loudness normalisation
  runs over the whole film, so audio is always re-mixed.
- **Dedicated render workers.** Video renders and imports on their own queue, so a long render never holds up other
  exports, and a `WORKER_QUEUES` setting so a separate worker container can take only renders.
- **Translated lettering.** Translate bubbles and captions per language and export each edition from the same art,
  as narration already is per language.
- **Pose and sketch guides.** Upload a rough sketch or pose for a panel and send it with the prompt as a layout
  reference, for fewer rerolls.
- **Project members.** An invite flow and panel comments. `project_members` and its owner / editor / viewer roles
  exist, but nothing adds a member yet.
- **Snapshots and undo** for risky project-wide actions such as re-planning a chapter or a bulk regeneration.
- **Motion clips for key shots.** Optional short image-to-video clips for a few dramatic shots, mixed with the Ken
  Burns shots. Costly per clip, so opt-in and budgeted.
- **Expert output actions.** Turn an expert's reply into something applied: a new project from a concept, a
  replacement premise, an outline, or the YouTube package fields, through a structured extraction step.
- **Video branding.** A logo watermark and optional intro and outro cards on video exports.
- **Agent (MCP) additions.** Tools to delete exports, narration audio and images, and not asking again for a scope a
  user has already declined.
- **End-to-end tests in CI.** The existing `scripts/e2e.sh` on a nightly or manual workflow against the full stack
  with mock AI.
- **Cached reader-link renders.** Reader pages render on every request; keep them as asset variants if a link ever
  draws real traffic.
- **Instance-wide budget ceiling.** The per-project cap exists; an instance-wide ceiling is the better control for
  a shared install, but with registration off by default multi-user is the rare case.
- **Streaming PDF and webtoon strips.** ZIP-based exports and video stream to disk. PDF and stitched webtoon strips
  are still built in memory, but both are scoped to one chapter, so size is bounded. ZIPs use no ZIP64 (4 GiB cap,
  with a clear error). Revisit when whole-project PDFs are requested or ZIP packages approach 4 GiB.
- **S3-compatible asset storage.** Assets live on local disk behind one `AssetStorage` interface with a local
  implementation. A remote backend would need presigned downloads (the current `X-Accel-Redirect` path is
  nginx-only) and multipart uploads, and would turn local reads in page composition and video rendering into
  network fetches.

## Deliberately not built

| Item | Why not | What would change it |
| --- | --- | --- |
| **Automatic image-provider failover** | Silently switching image models mid-chapter breaks visual consistency, which is the point of the product. Quota and auth failures already pause the batch so you can pick another key and resume. The narrow safe case did ship: a content-policy block retries once on a fallback provider you nominate and flags the panel for review (see `docs/AI_PIPELINE.md`). | A text-model failover chain is asked for, or image failover can be limited to the same model family. |
| **Teams and organisations** (seats, org billing, tenancy) | Per-project roles exist (`project_members`; the invite flow is under Later). Orgs and billing only matter for a hosted multi-tenant service; this is a self-hosted app. | A hosted offering is decided. Tenancy would need to land before that launch — retrofitting it later is costly. |
| **Crossfades between shots** | Hard cuts read correctly for narrated comic and film output, and crossfades would break the frame-exact hold arithmetic the duration check depends on. | Enough demand to justify reworking the timing model. |
| **Burned-in subtitles** | The `.srt` sidecar covers players and uploads without baking one language into the pixels. | — |
| **Converting comic projects to film** | A conversion means re-planning and regenerating every panel at a new aspect, i.e. a fresh project with extra steps. | — |
| **6-panel and larger grid layouts** | Pages are capped at 5 panels by product decision: legibility and fewer blank strips. | The cap changes. |
| **Managed hosting, SLAs, provider billing** | Out of scope for a self-hosted project. | — |
| **Telemetry or analytics** | There is none, and there will not be. Outbound requests go only to the AI providers you configure, the one-time model download for local TTS, and the client metadata document an MCP agent names when it connects by URL. | — |
