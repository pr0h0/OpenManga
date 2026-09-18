# AI pipeline

| Stage | Job kind / queue | Template (live version) | Output |
| --- | --- | --- | --- |
| Story analysis | `story_analysis` / text-ai | `story-analysis` v2 | `StoryAnalysis` → review → apply creates characters/versions/aliases/outfits, locations, props, chapters |
| AI rewrite | `story_rewrite` / text-ai | `story-rewrite` v1 | a new `story_revisions` row |
| Chapter planning | `chapter_plan` / text-ai | `page-planning` v5, or `shot-planning` v2 for a film project | `ChapterPlan` → scenes, beats, pages (layout template), panels, panel specs, bubbles (auto-placed), narration captions, SFX, chapter memory |
| Panel prompt prep | `page_prompts` / text-ai | `panel-prompts` v3 | per-panel prompt draft sections (`panels.prompt_draft`, status `prompt-ready`) |
| Narration text | `narration_text` / text-ai | `narration` v4 | narration lines → TTS segments |
| References | `character_reference` … `style_reference` / image-generation | `character-reference`, `location-reference`, `prop-reference`, `style-reference` v3 | full-resolution canonical asset + a draft `reference_assets` row |
| Panels | `panel_generation` / image-generation | `panel-generation` v6 | a new `panel_art` asset, activated on the panel |
| Masked edit | `panel_edit` / image-edit | `panel-edit` v3 | a new `panel_art` asset with `parent_asset_id` set |
| Cover | `cover` / image-generation | `cover` v3 | cover artwork (the title is composited by the app) |
| Panel QA | `panel_check` / text-ai | `panel-check` v1 | `panels.qa` verdict from a vision model (opt-in) |

Narration synthesis and exports are separate job families (`audio_jobs` on the `tts` queue, `export_jobs` on
`export`); see `docs/ARCHITECTURE.md` for the queue table and `docs/PROMPT_SYSTEM.md` for the templates.

**No server-level provider keys.** Every text and image run uses a key a user added. The only server-side AI paths are
`AI_MOCK_MODE` (in-process fakes, the zero-key demo) and local Kokoro TTS. A run without a credential is refused with
422 `credentials_required`; preflight and the bulk-estimate endpoint report whether the caller has a usable text and
image key. The content-filter fallback and the vision consistency check are opt-in and must name one of the user's own
credentials. Timeouts and concurrency for whichever provider a run picks come from `AI_TEXT_TIMEOUT_MS`,
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
`story-analysis` v2, `page-planning` v5, `shot-planning` v2, `panel-prompts` v3, `narration` v4 and the image
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
- **Art direction binds planning**: since `page-planning` v4 and `panel-prompts` v2 (live: v5 and v3) the planner
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
vision-capable text model (`panel-check` v1, schema `PanelCheck`). The verdict is computed deterministically — missing
expected characters, unexpected people, headcount mismatch — and stored on `panels.qa`; the page grid outlines
mismatches and the Panel tab shows the badge with a "check again" action (`POST /api/panels/:id/check`). DeepSeek
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
