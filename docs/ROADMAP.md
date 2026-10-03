# Roadmap

Only unfinished work: what is being considered, and what will not be built. Everything that has shipped is in
[CHANGELOG.md](../CHANGELOG.md). Nothing here carries a date or a promise; items move when someone builds them.

## Planned

- **Music and ambience.** Background music per scene mood, ducked under narration before loudness normalisation,
  and ambience beds tagged from the scene's time, weather and mood. From a library the user supplies, so nothing
  with unclear licensing ships in the repository.
- **Translated lettering.** Translate bubbles and captions per language and export each edition from the same art,
  as narration already is per language.
- **Snapshots and undo** for risky project-wide actions such as re-planning a chapter or a bulk regeneration.
- **Motion clips for key shots.** Optional short image-to-video clips for a few dramatic shots, mixed with the Ken
  Burns shots. Costly per clip, so opt-in and budgeted.
- **Timing pass after narration is voiced.** Once the audio exists, its real lengths (not words-per-minute estimates)
  decide the pacing: flag shots that hold far past the longest-shot setting or flash by too fast, rebalance holds
  within a chapter, and suggest trimming or splitting narration to land on the target runtime, re-voicing only what
  the user picks.
- **Video shots as their own layer.** Panels stay the story and comic units; a video shot list on top of them (a
  shot drawn from a panel, a crop of one, or a title card, with its narration, length, move and transition). Today a
  shot is a panel with video settings, which is enough until one panel needs to become several shots.
- **Native vertical projects.** Plan and draw a project at 9:16 from the start for Shorts-first stories. Today 9:16 and
  1:1 reframe existing art, which is right for cutting Shorts from a long video but can crop out a second character
  or a prop.
- **Captions on Shorts.** Optional captions drawn into the picture for Shorts, Reels and TikTok cuts, from the
  narration text and timing the app already has (ASS styles: clean bottom, large centre, two-line), rendered by
  ffmpeg. Long videos keep the `.srt` sidecar only.
- **Publish to YouTube.** Connect a channel with OAuth and upload the YouTube package's video, title, description,
  tags, chapters, subtitles and thumbnail, private by default, with optional scheduling.
- **Channel profiles.** One step above project templates: a channel's default preset, narrator voice and speed,
  image and batch policy, thumbnail layout, branding, output size and upload settings, so a new project is an idea
  plus a profile.
- **Title and thumbnail variants.** Several titles and thumbnail headlines from the same art, to compare or A/B test;
  the headline is already composited apart from the art, so variants cost no images.
- **Several Shorts from one long video.** Pick a set of non-overlapping Shorts across a finished project in one go,
  building on the Shorts picker.
- **Sound effects library.** A tagged local library of SFX beside the music and ambience beds, placed from the
  panels' sound effects and scene tags.
- **Fork a chapter.** Keep a chapter's current production as one version and re-plan a copy, once snapshots exist.

## Deliberately not built

| Item | Why not | What would change it |
| --- | --- | --- |
| **Automatic image-provider failover** | Silently switching image models mid-chapter breaks visual consistency, which is the point of the product. Quota and auth failures already pause the batch so you can pick another key and resume. The narrow safe case did ship: a content-policy block retries once on a fallback provider you nominate and flags the panel for review (see `docs/AI_PIPELINE.md`). | A text-model failover chain is asked for, or image failover can be limited to the same model family. |
| **Teams and organisations** (seats, org billing, tenancy) | Per-project roles exist (`project_members`; the invite flow is under Later). Orgs and billing only matter for a hosted multi-tenant service; this is a self-hosted app. | A hosted offering is decided. Tenancy would need to land before that launch — retrofitting it later is costly. |
| **Crossfades between shots** | Hard cuts read correctly for narrated comic and film output, and crossfades would break the frame-exact hold arithmetic the duration check depends on. | Enough demand to justify reworking the timing model. |
| **Burned-in subtitles on long videos** | The `.srt` sidecar covers players and uploads without baking one language into the pixels. Short vertical cuts are the exception (see *Captions on Shorts* above). | — |
| **Converting comic projects to film** | A conversion means re-planning and regenerating every panel at a new aspect, i.e. a fresh project with extra steps. | — |
| **6-panel and larger grid layouts** | Pages are capped at 5 panels by product decision: legibility and fewer blank strips. | The cap changes. |
| **Managed hosting, SLAs, provider billing** | Out of scope for a self-hosted project. | — |
| **Telemetry or analytics** | There is none, and there will not be. Outbound requests go only to the AI providers you configure, the one-time model download for local TTS, and the client metadata document an MCP agent names when it connects by URL. | — |
