# AI pipeline

| Stage | Job kind / queue | Template (live version) | Output |
| --- | --- | --- | --- |
| Story analysis | `story_analysis` / text-ai | `story-analysis` v2 | `StoryAnalysis` → review → apply creates characters/versions/aliases/outfits, locations, props, chapters |
| AI rewrite | `story_rewrite` / text-ai | `story-rewrite` v1 | a new `story_revisions` row |
| Chapter planning | `chapter_plan` / text-ai | `page-planning` v6, or `shot-planning` v3 for a film project and `strip-planning` v2 for a vertical strip | `ChapterPlan` → scenes, beats, pages (layout template), panels, panel specs, bubbles and SFX (placed at once with auto-placement on, else kept on the panel for Editor → Lettering → Letter from plan, placed in the panel's planned negative space), narration captions, chapter memory |
| Panel prompt prep | `page_prompts` / text-ai | `panel-prompts` v4 | per-panel prompt draft sections (`panels.prompt_draft`, status `prompt-ready`) |
| Narration text | `narration_text` / text-ai | `narration` v5 | narration lines → TTS segments |
| References | `character_reference` … `style_reference` / image-generation | `character-reference`, `location-reference`, `prop-reference` v5 (location and prop take a kind: panorama, sheet, multi-angle), `style-reference` v4 | full-resolution canonical asset + a draft `reference_assets` row |
| Panels | `panel_generation` / image-generation | `panel-generation` v8 | a new `panel_art` asset, activated on the panel |
| Masked edit | `panel_edit` / image-edit | `panel-edit` v4 | a new `panel_art` asset with `parent_asset_id` set |
| Cover | `cover` / image-generation | `cover` v4 | cover artwork (the title is composited by the app) |
| Panel QA | `panel_check` / text-ai | `panel-check` v1 | `panels.qa` verdict from a vision model (opt-in) |

Narration synthesis and exports are separate job families (`audio_jobs` on the `tts` queue, `export_jobs` on
`export`); see `docs/ARCHITECTURE.md` for the queue table and `docs/PROMPT_SYSTEM.md` for the templates.

**No server-level provider keys.** Every text and image run uses a key a user added. The only server-side AI paths are
`AI_MOCK_MODE` (in-process fakes, the zero-key demo) and local Kokoro TTS. A run without a credential is refused with
422 `credentials_required`; preflight and the bulk-estimate endpoint report whether the caller has a usable text and
image key. The content-filter fallback and the vision consistency check are opt-in and must name one of the user's own
credentials. A text run can opt out of providers entirely with `ai: {manual: true}`: the job compiles its prompt, parks
as `awaiting_input`, and finishes from an answer pasted back in — validated against the same schema, billed nothing.
See [WITHOUT_API_KEYS](WITHOUT_API_KEYS.md). Timeouts and concurrency for whichever provider a run picks come from `AI_TEXT_TIMEOUT_MS`,
`AI_TEXT_MAX_CONCURRENCY`, `AI_IMAGE_TIMEOUT_MS` and `AI_IMAGE_MAX_CONCURRENCY`. Image quality defaults to
`IMAGE_QUALITY=low` and the output size menu to `IMAGE_SIZES`.

**Bring your own key (BYOK) and per-run model choice.** Users add provider keys in Account → AI providers (DeepSeek,
OpenAI, Anthropic, Google, Meta, OpenRouter, ElevenLabs, or any public-HTTPS OpenAI-compatible endpoint). Keys are
verified by listing models, encrypted with AES-256-GCM, never returned (only `…last4`), redacted from logs, and usable
only by their owner — checked again in the worker (`docs/SECURITY.md` has the encryption and rotation detail). Every
text/image generation and narration synthesis accepts `ai: { credentialId, provider?, model? }`; the choice is
validated at request time (`apps/api/src/lib/ai.ts`) and stored on the job (`generation_jobs.parameters.ai`,
`audio_jobs.options.ai`), so a retry keeps it. `ProviderResolver` (`packages/services/src/providers.ts`) builds the
provider per job and caches instances per credential+model, so concurrency limiters and rate-limit cooldowns are
shared by every job using the same key. `credentialId: null` has no server key to fall back to and is refused outside
`AI_MOCK_MODE`.

**Which provider runs a job** is decided by the credential the run names: its `kind` selects the implementation and
its base URL defaults from the provider catalogue (`packages/domain/src/providers.ts`). Custom base URLs must resolve
to public addresses, which blocks internal services. In `AI_MOCK_MODE` keys are stored unverified and every run uses
the fakes. Unpriced models record tokens at $0 until an admin adds a rate snapshot.

| Capability | Implementations (`packages/ai-text`, `packages/ai-image`, `packages/audio`) |
| --- | --- |
| Text | DeepSeek native; Anthropic Messages (streamed); OpenAI-style streaming chat for OpenAI, OpenRouter, Meta, Google (`/v1beta/openai`) and custom endpoints |
| Images | OpenAI Images; Gemini `generateContent`; Meta `muse-image-1.0` (`/images/generations`, references and edits through `/images/edits` as data URLs, masks as an instructed extra image, flat $0.01/image via `image_unit_rate`); OpenRouter (chat completions with `modalities: ["image","text"]`) |
| Voice | Kokoro (local, the default); OpenAI `/audio/speech` (PCM); Gemini TTS (L16); ElevenLabs (`pcm_24000`) — all wrapped as 24 kHz mono WAV so they concatenate with Kokoro |

**Structured output.** Text runs always go extract → validate against the Zod schema → one `json-repair` call → fail
clearly. `packages/ai-text` recovers JSON from prose, fences, trailing commas and cut-off responses before giving up.

**Meta text.** `MetaMuseTextProvider` (`packages/ai-text/src/meta.ts`) calls the Meta Model API
(`/chat/completions`, OpenAI-compatible) with `stream: true` and `stream_options.include_usage`, because Meta may 504
long non-streaming requests; deltas are assembled into the same `TextResult`, so extract → validate → repair is
unchanged. Temperature is omitted unless a caller sets one (Muse Spark is tuned for 1.0). `*-contributor` models are
cheaper because Meta may train on prompts and completions.

**Gemini images.** `GeminiImageProvider` (`packages/ai-image/src/gemini.ts`) calls
`POST {credential base URL}/models/{model}:generateContent` with `responseModalities: ["IMAGE"]` and
`imageConfig {aspectRatio, imageSize}`; the prompt is followed by labelled inline reference images. Gemini has no mask
parameter, so a masked edit sends the full-resolution target and then the mask as an extra image with an instruction
("change only transparent areas"). Aspect ratios snap to the nearest of 1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9,
21:9; output is usually JPEG around 1K. Usage maps `promptTokensDetails`/`candidatesTokensDetails` by modality into
image and text tokens; costs use the seeded `google/*` rate snapshots, which price image output per token (~1120
tokens for a 1K image). Safety finish reasons (`IMAGE_SAFETY`, `PROHIBITED_CONTENT`, …) and `promptFeedback.blockReason`
become non-retryable `content_policy`; a response with no image is a retryable `invalid_response`.

## Experts

`/app/experts` holds chats with experts: a built-in expert (`BUILTIN_EXPERTS`, `packages/prompts/src/experts.ts`) or
one the user wrote (`experts` table). A chat keeps its own copy of the expert's system prompt (`expert_chats`), so
editing or deleting the expert never changes a chat already under way, and it can be adjusted per chat. Each reply
is built by `expert-chat` v2: a short common frame (reply in the user's language, write project material in
`project_data.language`, treat the project data as a summary and ask for the full text when a judgment needs it, and
follow the project's art style), the chat's system prompt, the project summary when the chat is about a project
(`projectSummary` in `apps/api/src/lib/experts.ts`: cast, places, props, world notes, art style and chapter
summaries), then the last 40 messages with the 4 most recent attached images. With *Generate image* the reply ends
with an `IMAGE PROMPT:` line; only that line (or the paragraph after a marker on its own line) is drawn, so notes or
overlay text written after it stay in the reply. It is drawn at the chosen aspect ratio with, as references, the
images attached to the question, then the approved references of project characters and places the prompt names,
then the project's style reference (at most 6), and with the project's art direction appended.

Replies run in the API process after the request returns (`runExpertReply`), since a reasoning model can take longer
than a proxy holds a request open; the page polls the chat for status. The text itself streams: providers that stream
(Anthropic, the OpenAI-style providers, and DeepSeek when a caller asks, via `TextRequest.onText`) pass the answer on
as it arrives; it is published on the chat's Redis channel at most every 100 ms and read by the page from
`GET /api/expert-chats/:id/stream` (server-sent events, at most 4 open per user), and saved every 2 s so a page that
opens mid-reply sees it too. A provider that does not stream shows the whole reply when it is done. A reply still pending after 20 minutes was cut off by a
restart and is shown as failed, to retry. With *Paste it yourself* the reply waits with the whole conversation ready
to copy, and the pasted answer (plus any image uploaded with it) completes it. Usage is recorded as `expert_chat` and
`expert_image`, against the chat's project, or against no project, which the user's own usage page includes.
Images attached to or drawn in a chat are `source_image` assets owned by the user, in the chat's project when it has
one; an image with no project is readable by its owner only.

## What each text step is given

Each step's instructions are fixed per template version; what varies is the project data sent with them, built in
`apps/worker/src/handlers/text.ts`. Since 0.7:

- **Chapter planning** (`projectPlanningData`): the chapter and its beats; world notes and art direction; each
  character's key, name, role, aliases, a short look, distinctive features, personality, mannerisms, outfit names and
  a `protagonist` flag; the cast's relationships from the latest applied story analysis; each location's summary,
  key features and lighting; each prop's summary; the previous chapter's closing state, character and location
  changes and revealed facts, and `earlierRevealedFacts` from every chapter before it.
- **Panel prompt prep** (`pagePrompts`): the scene (with its purpose, time, weather, continuity and state) and the page
  (purpose, pacing, emphasis, page-turn hook); per panel its spec with characters by **name** (never a database id),
  its location (summary, key features), its props and the dialogue spoken in it.
- **Narration** (`narrationText`): the chapter, the previous chapter's closing state and revealed facts, the world
  notes, and the chapter's cast (name, role, aliases, gender presentation, for names and pronouns); per panel its
  beat, emotion and dialogue.
- **Panel images** (`GenerationPlanner.panelContext`): continuity is the scene's notes and starting state, what
  earlier scenes of the chapter changed for good (`continuityDeltas`), the previous scene's end state when this scene
  sets none, and earlier panels' requirements, each kept only when it concerns someone in the panel (or no one).

Applying a story analysis writes its setting, rules, technology, magic, factions, uniforms, recurring scenery,
vehicles, genre, tone, themes, motifs and notes into empty world notes, and its summary into an empty project
description (which the cover is drawn from).

## Colour mode, format and audio timing

- **Colour mode wins over the preset**: `styleSection()` drops a preset's monochrome `colorPolicy` line for a
  full-colour project and drops `screenTones` entirely, so one prompt never carries both "Black and white with grey
  tones" and "Full color artwork" (measured: seinen presets rendered monochrome in colour projects).
- **`projectType` is direction, not a label**: each type adds a format line (manga ink values, manhwa polished
  digital, webtoon phone-legible, comic bold inking, storybook painterly).
- **Audio**: TTS segments are silence-trimmed when stored (`TTS_TRIM_SILENCE`, `TTS_TRIM_THRESHOLD_DB` −45 dBFS,
  `TTS_TRIM_KEEP_MS` 25 ms), so `pauseAfterMs` (350 ms) and the video breath (`VIDEO_BREATH_MS` = 150 ms in
  `packages/domain/src/video.ts`) are the only pauses at a cut. Untrimmed cached audio is not reused. Before this,
  every shot change carried ~1.2 s of silence (24.6% of a film).

## Film projects and video

`settings.format` is `comic` or `film`. A film project plans with `shot-planning` instead of `page-planning`: one
full-frame 16:9 shot per page, no bubbles, and page geometry forced to `FILM_PAGE` (1920×1080, no margin or gutter).
Both formats export video — `video_pages` (page cut) and `video_panels` (panel cut) — and
`GET /api/video-preview?cut=page|panel` returns the same shot list and narration the renderer uses, so
`apps/web/src/features/video/VideoPreview.tsx` previews the cut in the browser without encoding anything. The render
itself is deterministic ffmpeg work in the worker: see `docs/DEPLOYMENT.md` for the export list and
`docs/VIDEO_EXPORT_REFERENCE.md` for the frame-level rules.

## Prompt quality rules

Rules that came from production output, all versioned (old text versions stay registered for reproducibility) —
`story-analysis` v2, `page-planning` v6, `shot-planning` v3, `panel-prompts` v4, `narration` v5 and the image
templates:

- **Bibles are drawable**: concrete descriptors, apparent age as a range, one default outfit with colours and
  materials; `immutableTraits` are 3–6 physically visible markers only (never abilities, knowledge or plot facts —
  "cannot read" once reached every image prompt); neutral body wording.
- **Panels are one frozen moment**: one visible action per character, no action sequences or invisible inner states;
  exactly the visible characters with frame positions; lighting names source, direction and colour temperature; scenes
  open wide; no more than two identical shot types in a row; readable text (screens, signs, documents) is never the
  subject.
- **Narration flows**: never mentions panels, pages or images, varies openings, one tense and point of view, hook at
  the start and a turn at the end, TTS-friendly (no brackets or symbols).
- **Images**: full-bleed with no drawn margins, bands, borders or panel lines (all seen in generated art); no readable
  writing on screens or signs; correct anatomy and hands; reference sheets without labels or swatches and fully in
  frame; masked edits blend line weight, shading and lighting at the mask edge.

Checked live on DeepSeek (2026-09-16): analysis v2 and planning v5 validated without repair; immutable traits were all
visual, bibles lint-clean, no repeated shot types, no distress-lighting panels under a warm art direction.

## Content-policy hardening

Image moderators (Meta Muse most of all) block borderline prompts probabilistically, so a harmless scene can fail some
of the time. Five layers, all visible to the user:

- **Wording lint** (`packages/domain/src/content-lint.ts`): body-harm vocabulary (underweight, gaunt, hollow cheeks,
  sallow, scar, burn, bruise, wound…) in the character fields that actually reach image prompts (appearance,
  distinctive features, wardrobe, outfits, immutable traits — not personality). Returned as `contentWarnings` on
  character create/edit/detail and counted on cast cards, with neutral suggestions. Warnings only.
- **Stale references**: every reference stores `source_fingerprint`, a hash of its version's prompt-visible
  description when the image was made. When a draft description changes, its references report `stale: true` — the old
  image still shows the old look and is attached to every panel. Migrating panels onto a version with no fresh
  approved reference returns 409 `no_approved_reference` unless `force: true`.
- **Art direction binds planning**: since `page-planning` v4 and `panel-prompts` v2 (live: v6 and v4) the planner
  receives `artDirection` (preset, lighting, custom style) and must keep `lighting` and `emotion` inside it — no
  horror lighting or distressed moods in a warm comedy, and never lone figure + underlighting + distressed mood +
  high or tilted camera together.
- **Preflight** (`GET /api/projects/:id/preflight?chapterId=`, also returned with the bulk-generation estimate):
  panels carrying harm vocabulary, the distress combination, and stale or missing references — before anything is
  spent. It reports credential readiness alongside.
- **Provider policy + fallback**: Meta's image provider softens unambiguous harm words before sending (reported as
  `softened`, logged). When a *panel generation* is blocked with `content_policy`, the worker retries it **once** on
  the project's fallback provider (`settings.contentPolicyFallback`, Settings → Content filter fallback: opt-in, off
  by default, must name one of the user's own credentials, and never the provider/model that just refused) and sets
  `panels.review` so the panel shows "needs review" until dismissed. Other failures never switch providers.

Reference derivatives are sized per provider — see `docs/IMAGE_REFERENCES.md`.

## Budget cap, batch pause and queue recovery

- **Budget cap** (`settings.budgetUsd`, **$5** on a new project): the API refuses new AI work with 402
  `budget_exceeded` once recorded spend reaches the cap; the web client asks and retries with
  `x-allow-over-budget: 1`. Bulk estimates include the budget, and queued batch jobs re-check it when they start,
  pausing the batch instead of overspending.
- **Pause/resume batches**: `POST /api/generations/batches/:batchId/pause|resume`. Pausing removes not-yet-started
  jobs from Redis and marks them `paused` (reason in `failure_reason`); running jobs finish. A job failing with `auth`
  or `quota` pauses the rest of its batch automatically. Resume re-arms the jobs' outbox rows — same job ids, so
  BullMQ dedupes.
- **Queue recovery**: the worker re-publishes `queued` generation, audio and export jobs whose Redis entry has
  disappeared (15 s after startup, then every 5 minutes), so a Redis flush or restore never strands jobs.

## Narration pauses and style

Segments get `narrationPauseMs` (default 350 ms) after them; the last segment of each scene and of the chapter gets
`sceneBreakPauseMs` (700 ms). Pauses are applied at compose time, so `POST /api/chapters/:id/narration/pauses`
re-applies the settings without touching audio. `narrationStyle` is stored in project settings and used when a
narration request has no explicit style, so every chapter is written in the same voice.

## Narration languages

Narration lines carry `language`, so a chapter can hold one track per language over the same artwork. `narration` v3
added the target language to v2's coverage and length rules (word counts for Japanese, Chinese and Thai are estimated
at 2 characters per word) and v4 keeps them. Every narration endpoint, synthesis, timeline, readiness check and export
accepts `language`, defaulting to the project language.

## Consistency check (vision QA, opt-in)

`settings.consistencyCheck = { enabled, credentialId, model }`. After a panel generation or edit activates new
artwork, a `panel_check` job sends the 1024 px preview plus the expected cast (names and appearance) to a
vision-capable text model (`panel-check` v1, schema `PanelCheck`). The expected appearance uses the outfit the panel
resolves to (see `docs/IMAGE_REFERENCES.md`), not the bible's default wardrobe. The verdict is computed
deterministically — missing expected characters, unexpected people, headcount mismatch, readable text drawn in the
art — and stored on `panels.qa`; the page grid outlines mismatches and the Panel tab's badge names the first problem,
shows the model's notes on hover, and has a "check again" action (`POST /api/panels/:id/check`). The check's prompt is
saved on its job like every other text step's. DeepSeek
cannot read images, so this needs a BYOK vision model. Text providers accept `images` on chat messages (OpenAI-style
content parts, Anthropic image blocks).

## Describe a reference image

`POST /api/projects/:projectId/images/describe` (multipart: `file`, plus `aspects`, `custom`, `note`, `ai`,
`batch` as form values) uploads an image and queues an `image_describe` job; `POST /api/assets/:id/describe`
does the same for an image already in the project (a panel, a reference, an earlier upload). Both refuse before
storing anything, so a request rejected for want of a key leaves no orphan image behind.

The job attaches the 1024 px preview to the user message and asks `image-describe` v1 for the schema
`ImageDescription`. Ten aspects, each with its own prompt fragment rather than one broad instruction:

| aspect | returns | applies to |
|---|---|---|
| `style` | `StyleDefinition` | the project's art direction |
| `character` | `CharacterBible` | a new character |
| `location` | `LocationDescription` | a new location |
| `outfit`, `lighting`, `composition`, `mood`, `props`, `era`, `technique` | prose + bullet details | copied by hand |

The three that map onto an entity return **exactly** the shape that entity's existing endpoint already accepts, so
applying a result is a plain `POST` of the object — there is no translation step and no write path of its own.
Every field is optional: only the requested aspects are asked for, and a partial answer still parses. What the
model could not see goes in `uncertain` rather than being guessed.

The prompt forbids identifying real people or naming a work an image might come from; it describes only what is
visible. Uploads are stored as `source_image` assets, so a frame can also be attached as a reference to a later
generation. Needs a vision-capable key — DeepSeek cannot read images.

**The library is cross-project, the run is not.** `GET /api/image-descriptions` lists past descriptions with their
image, aspects, custom question and result, spanning every project the caller is a member of (`?scope=project`
narrows it). A run bills and is access-checked against the project it happened in, because that is where the
budget and the asset live — but reusing the answer elsewhere costs nothing, which is the point: a style read from
one reference is exactly what you want in another project. `DELETE /api/image-descriptions/:id` removes one along
with the image it was read from, unless a panel or reference has adopted that image meanwhile.

Applying a result targets the project you are in: the style aspect becomes a new art-direction version, and the
character and location aspects either create a new entity or add a version to an existing one. A version rather
than an edit, so it works whatever the current version's status is and the previous description stays in history —
and it is not made current, since approval is what promotes a version (see
[IMAGE_REFERENCES](IMAGE_REFERENCES.md#which-version-a-panel-draws-from)).

## Bring your own artwork

`POST /api/panels/:id/artwork/upload` (multipart: `file`) puts an image you already have into the slot generation
would have filled. PNG, JPEG or WebP, validated and re-encoded by the same upload path references use, so a
truncated or mislabelled file is refused with a 415 rather than becoming a broken panel.

Nothing downstream can tell the difference, and that is deliberate. An uploaded image is stored as a `panel_art`
asset whose `metadata.panelId` names the panel — which is the only thing that makes any asset a version of a
panel — and the panel's `activeArtworkAssetId` is pointed at it. Its `generationJobId` is simply null, which is
why the version list joins the job table on the left: an uploaded version appears in the history beside generated
ones, can be compared with them, superseded, trashed, or brought back with the ordinary
`POST /api/panels/:id/versions/:assetId/activate`. Lettering, page render, webtoon stitching, PDF and video
export all read the active artwork and never ask where it came from.

The upload activates immediately, since that is the point of uploading. A locked panel refuses it, exactly as it
refuses generation.

In the app it is the **Upload artwork** button in the panel editor's Versions tab, offered whether or not the
panel has any artwork yet — a panel with no versions is precisely the case where you have no key and a picture of
your own.

## Provider batches (half price, up to 24h)

Any image or text generation can be sent to a provider's batch API instead of running now, at half the
interactive price: `batch: true` on the request, or **Send as a provider batch** on bulk panel generation.
OpenAI and Google only; a key whose provider has no batch API falls back to generating normally. See
[COSTS](COSTS.md#provider-batches-half-price-up-to-24h) for the pricing and the provider table.

The lifecycle is two-phase, because no handler may wait hours inside a worker slot:

1. **Submit.** Jobs are written but not queued. One `image_batch_submit` / `text_batch_submit` job collects them,
   chunks them to the provider's binding limit (OpenAI: enqueued input tokens, `OPENAI_BATCH_MAX_ENQUEUED_TOKENS`
   with 20% headroom; Gemini: the 20 MB inline payload), submits, and parks each job at `submitted`.
2. **Poll and ingest.** A `batch-poll` scheduler (`BATCH_POLL_INTERVAL_SECONDS`) reads finished batches and feeds
   results through the ordinary path: images finalize/activate as usual, text jobs go back on their own queue with
   the answer attached so their handler replays it and applies it unchanged.

Text batching needs no per-handler work: the provider is swapped for one that records the request on the way out
and replays the batch's answer on the way back, so each handler's validation, appliers and usage accounting run as
in a synchronous run. A batched answer that fails schema validation is repaired with one live call.

Spend is recorded against a `:batch` model at half rate, so batch cost is visible separately and the budget cap
sees the real figure. Each chunk's idempotency key is derived from the job ids in it and echoed in the provider's
own metadata, so a crash between submitting and persisting finds the batch already paid for instead of buying a
second one.
