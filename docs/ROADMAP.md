# Roadmap

Only unfinished work: what is being considered, and what will not be built. Everything that has shipped is in
[CHANGELOG.md](../CHANGELOG.md). Nothing here carries a date or a promise; items move when someone builds them.

## Planned

- **Music and ambience.** Background music per scene mood, ducked under narration before loudness normalisation,
  and ambience beds tagged from the scene's time, weather and mood. From a library the user supplies, so nothing
  with unclear licensing ships in the repository.
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
