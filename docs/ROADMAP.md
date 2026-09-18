# Roadmap

What is shipped, what is being considered, and what will not be built. Nothing here carries a date or a promise;
items move when someone builds them.

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
- **In-browser video preview.** "Preview video" on a chapter, "Preview page/shot video" in the page editor,
  "Preview move" on a panel, and "Preview in browser first" on Exports. `GET /api/video-preview` returns the same
  shot plan the render uses, and the player reproduces holds, framing, scroll and the Ken Burns curve from the same
  `@openmanga/domain` helpers.
- **Other exports:** PNG/JPG page images, PDF, webtoon strips, narration audio, timeline, agent package, project
  JSON and zip packages, plus project import.
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

- **Continuous scroll cut for video.** The same renderer as the page cut with travel set to the full page overflow
  instead of the capped rate. Small, deferred with the panel cut.

## Later

- **Instance-wide budget ceiling.** The per-project cap exists; an instance-wide ceiling is the better control for
  a shared install, but with registration off by default multi-user is the rare case.
- **Streaming project import.** Import holds the upload in worker memory (1 GiB cap). Fine for current exports;
  very large projects would need a streaming unzip. Revisit when imports near the cap become common.
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
| **Teams and organisations** (seats, org billing, tenancy) | Per-project sharing with roles already exists (`project_members`). Orgs and billing only matter for a hosted multi-tenant service; this is a self-hosted app. | A hosted offering is decided. Tenancy would need to land before that launch — retrofitting it later is costly. |
| **Crossfades between shots** | Hard cuts read correctly for narrated comic and film output, and crossfades would break the frame-exact hold arithmetic the duration check depends on. | Enough demand to justify reworking the timing model. |
| **Burned-in subtitles** | The `.srt` sidecar covers players and uploads without baking one language into the pixels. | — |
| **Converting comic projects to film** | A conversion means re-planning and regenerating every panel at a new aspect, i.e. a fresh project with extra steps. | — |
| **6-panel and larger grid layouts** | Pages are capped at 5 panels by product decision: legibility and fewer blank strips. | The cap changes. |
| **Managed hosting, SLAs, provider billing** | Out of scope for a self-hosted project. | — |
| **Telemetry or analytics** | There is none, and there will not be. Outbound requests go only to the AI providers you configure, plus the one-time model download for local TTS. | — |
