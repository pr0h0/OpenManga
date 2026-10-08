# Roadmap

Only unfinished work: what is being considered, and what will not be built. Everything that has shipped is in
[CHANGELOG.md](../CHANGELOG.md). Nothing here carries a date or a promise; items move when someone builds them.

## Planned

Grouped by area, roughly most useful first within each.

### Production you can trust

- **Source-to-panel traceability.** Every chapter, scene, panel and narration line links back to the span of the story
  it came from, so a revised paragraph points at exactly what it affects.
- **Why is this stale.** A dependency view behind the staleness list: story revision → chapter plan → panel →
  artwork, so it is clear what changed and what an update would redo.
- **Snapshots and undo** for risky project-wide actions such as re-planning a chapter or a bulk regeneration.
- **Fork a chapter.** Keep a chapter's current production as one version and re-plan a copy, once snapshots exist.

### Canon and continuity

- **Story timeline.** Events in order with dates, ages and elapsed time, so the bible's per-character states can be
  placed by story time as well as by chapter and scene.
- **Location states.** Versions of a place by story time (normal, destroyed, snowed in, at night), picked by when the
  scene happens.
- **Rules checked in the artwork.** The continuity check tests fixed rules against what the plan, dialogue and
  narration say; checking them in the finished panels by vision ("system windows are blue") is still to do.

### Panels and images

- **Directing controls.** Optional structured fields per panel: camera height, shot size, lens feel, angle (frontal,
  three-quarter, profile, over-the-shoulder, point of view), where each figure stands and faces, eye-line, depth order,
  focus subject, shot purpose (establish, reveal, reaction, insert) and props held ("sword in right hand").
- **Coverage sheet.** For one story beat, draw a 3×3 sheet of angles (wide, medium, close, over-the-shoulder,
  insert, low, high) in one image and turn the picks into panels.
- **Reference board.** A moodboard of images that can be dropped onto a character, location, prop, outfit, style or
  panel guide, or described for one aspect only ("the lighting", "the costume silhouette").
- **Image tools.** Upscaling, face and detail repair, relighting, background removal, sketch cleanup for guides,
  line-art extraction, colourising black-and-white pages, palette transfer, expression edits, and outpainting so
  16:9 art can be widened to 9:16 instead of cropped.
- **Comic effects as layers.** Speed and focus lines, impact flashes, screentone, rain, snow, dust, glow and a
  flashback tint drawn deterministically over the art, instead of paying to regenerate a panel for them.
- **Near-duplicate finder.** Spot near-identical panels, repeated poses and backgrounds, and duplicate thumbnail
  candidates, with local image embeddings.
- **Model comparison.** Draw one panel with several models side by side, with checks, time and cost, then use the
  winner for the chapter or project.
- **Translated lettering.** Translate bubbles and captions per language and export each edition from the same art,
  as narration already is per language.

### Custom models and local generation

- **ComfyUI backend.** An optional image backend at a ComfyUI server you run: custom checkpoints, LoRAs, ControlNet and
  OpenPose, IP-Adapter, regional prompts and local GPUs. OpenManga keeps the story, assets, jobs, budgets and records;
  ComfyUI only runs the image graph, and node graphs stay out of the core data model.
- **Character and style LoRAs.** Train from approved references and panels (a dataset builder with cropping,
  captions and a quality report), or register LoRAs you already have; version them, combine a character with a style at
  set weights, and record which models and weights drew each image. Used where the backend supports it, plain
  references elsewhere.
- **Prompt lab.** Override a built-in template per project (panel prompts, narration instructions, planning rules,
  exclusions) as text, preview the compiled prompt and the diff, try it on a few panels, keep versions and revert.

### Video

- **Video shots as their own layer.** Panels stay the story and comic units; a video shot list on top of them (a
  shot drawn from a panel, a crop of one, or a title card, with its narration, length, move and transition). Today a
  shot is a panel with video settings, which is enough until one panel needs to become several shots.
- **Timeline editor.** Video and audio tracks (shots, titles and overlays; narration, music and ambience, effects)
  with waveforms, zoom, markers, shot lengths set by dragging, reorder, split and duplicate, pan and zoom keyframes,
  title tracks, alternative takes per shot, locked tracks, and rendering a selected range from the cached sections.
- **Edit the video in words.** "Make chapter 4 faster", "cut every silence over 900 ms", "add a title card before
  chapter 8": a proposed timeline diff to apply, change or reject, through the same approvals as agents.
- **Native vertical projects.** Plan and draw a project at 9:16 from the start for Shorts-first stories. Today 9:16 and
  1:1 reframe existing art, which is right for cutting Shorts from a long video but can crop out a second character
  or a prop.
- **Hook variants.** Several alternative openings (15–30 s of different narration and first shots, optionally a
  matching title and thumbnail) in front of the same film; incremental rendering makes each one cheap.
- **Motion clips for key shots.** Optional short image-to-video clips for a few dramatic shots, mixed with the Ken
  Burns shots. Costly per clip, so opt-in and budgeted.

### Sound and voices

- **Music and ambience.** Background music per scene mood, ducked under narration before loudness normalisation,
  and ambience beds tagged from the scene's time, weather and mood. From a library the user supplies, so nothing
  with unclear licensing ships in the repository.
- **Sound effects.** A tagged local library of effects (footsteps, impacts, doors, crowds, thunder) on its own track,
  with cues suggested from the panels' sound effects and actions, never inserted unasked.
- **Voice casting.** Voices per character for dialogue as well as the narrator, saved narrator profiles, and cloned or
  custom voices where a provider allows it.

### Publishing and repurposing

- **Publish to YouTube.** Upload the YouTube package's video, title, description,
  tags, chapters, subtitles and thumbnail as a resumable upload: private by default (never public unless chosen),
  optional scheduling, playlist, language and category, the altered-or-synthetic content declaration, processing
  status, retry without re-rendering, and the video id kept on the export. It adds the upload scope to the channel
  connections YouTube stats already make. (Unaudited API projects can only upload privately.)
- **Export targets.** Presets that check a platform's limits before export (YouTube, Shorts, TikTok, Reels, carousels,
  WEBTOON, Tapas, KDP, generic PDF): size, aspect, file size, strip height, page count, safe areas, naming, codecs.
- **Public series reader.** An optional public or unlisted series page: cover, description, chapters with publish and
  schedule dates, page and scroll modes, languages, an RSS feed and social previews.

### Import, agents and automation

- **More story formats.** Import `.docx`, `.epub`, `.pdf`, Markdown, Fountain screenplays, subtitle files and web
  articles, each landing as an ordinary story revision.
- **Custom workflows.** Advanced users arrange the production steps (with stops for approval, checks, capped retries)
  from the same actions a production run calls, never separate implementations.
- **Triggers and webhooks.** Schedules ("submit batches at 01:00"), incoming and outgoing webhooks, and triggers on a
  new story revision, a finished batch or run, a failed job, a spend threshold or all comments resolved.

### Collaboration and review

- **Review states.** A reviewer role between viewer and editor, Draft → Needs review → Approved → Locked on panels,
  pages and chapters, bulk approval, approval required before chosen production steps, and approval history.
- **Ownership transfer.** The new owner accepts and the current one confirms; provider keys never move, agent grants are
  re-checked, budget settings pass to the new owner, and the transfer is audited.

### Assets and infrastructure

- **Asset library.** Tags, collections, favourites, search by name, character, place or prop, filters by source,
  model and date, "find images like this", unused and duplicate views, bulk actions, and where each file came from.
- **Storage policies, further.** A server-wide policy by age and total size shipped (Admin → Storage). Still to do: a
  policy per project, per-kind ages (keep exports longer than the render cache), project storage caps and cold
  archives.
- **Workers by capability.** Workers declare what they can do (ffmpeg, Kokoro, ComfyUI, a GPU) and jobs go to one
  that can, so a single server can grow into an API host with separate GPU and render machines.
- **Provenance package.** Per output: the app version, story revision, prompt versions, models, references and jobs
  that made it, plus licence notes for uploaded music, images, fonts and models; Content Credentials (C2PA) later.
- **Accessibility.** Alt text for panels and pages, accessible EPUB metadata, a full narration transcript, reading
  order checks and lettering contrast and size warnings.

## Deliberately not built

| Item | Why not | What would change it |
| --- | --- | --- |
| **Automatic image-provider failover** | Silently switching image models mid-chapter breaks visual consistency, which is the point of the product. Quota and auth failures already pause the batch so you can pick another key and resume. The narrow safe case did ship: a content-policy block retries once on a fallback provider you nominate and flags the panel for review (see `docs/AI_PIPELINE.md`). | A text-model failover chain is asked for, or image failover can be limited to the same model family. |
| **Teams and organisations** (seats, org billing, tenancy) | Per-project roles and invitations exist (`project_members`). Orgs and billing only matter for a hosted multi-tenant service; this is a self-hosted app. | A hosted offering is decided. Tenancy would need to land before that launch — retrofitting it later is costly. |
| **Crossfades between shots** | Hard cuts read correctly for narrated comic and film output, and crossfades would break the frame-exact hold arithmetic the duration check depends on. | Enough demand to justify reworking the timing model. |
| **Burned-in subtitles on long videos** | The `.srt` sidecar covers players and uploads without baking one language into the pixels. Shorts are the exception: they can have captions drawn in. | — |
| **Converting comic projects to film** | A conversion means re-planning and regenerating every panel at a new aspect, i.e. a fresh project with extra steps. | — |
| **6-panel and larger grid layouts** | Pages are capped at 5 panels by product decision: legibility and fewer blank strips. | The cap changes. |
| **Managed hosting, SLAs, provider billing** | Out of scope for a self-hosted project. | — |
| **Telemetry or analytics** | There is none, and there will not be. Outbound requests go only to the AI providers you configure, the one-time model download for local TTS, and the client metadata document an MCP agent names when it connects by URL. YouTube stats add Google's APIs, only once an administrator sets up an OAuth client, and only for the channels you connect yourself and the videos you link: they read your own videos' numbers, and nothing about you or the app is sent anywhere. Publishing to YouTube (above) would use the same connection. | — |
