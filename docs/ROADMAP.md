# Roadmap

Only unfinished work: what is being considered, and what will not be built. Everything that has shipped is in
[CHANGELOG.md](../CHANGELOG.md). Nothing here carries a date or a promise; items move when someone builds them.

## Planned

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
- **End-to-end tests in CI.** The existing `scripts/e2e.sh` on a nightly or manual workflow against the full stack
  with mock AI.
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
