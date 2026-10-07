# AI pipeline

| Stage | Job kind / queue | Template (live version) | Output |
| --- | --- | --- | --- |
| Story analysis | `story_analysis` / text-ai | `story-analysis` v3 | `StoryAnalysis` → review → apply creates characters/versions/aliases/outfits, locations, props, chapters; on a project that already has them it is additive (existing chapters keep their pages, new ones are inserted, nothing is removed; `GET /api/story-analyses/:id/diff` shows the changes first) |
| AI rewrite | `story_rewrite` / text-ai | `story-rewrite` v1 | a new `story_revisions` row |
| Chapter planning | `chapter_plan` / text-ai | `chapter-outline` v3 then `scene-pages` v3 once per scene (`shot-outline`/`scene-shots` for a film project, `strip-outline`/`scene-strip` for a vertical strip); a batched run makes one call with `page-planning` v7, `shot-planning` v4 or `strip-planning` v3 | `ChapterPlan` → scenes, beats, pages (layout template), panels, panel specs, bubbles and SFX (placed at once with auto-placement on, else kept on the panel for Editor → Lettering → Letter from plan, placed in the panel's planned negative space), narration captions, chapter memory |
| Panel prompt prep | `page_prompts` / text-ai | `panel-prompts` v5 | per-panel prompt draft sections (`panels.prompt_draft`, status `prompt-ready`) |
| Narration text | `narration_text` / text-ai | `narration` v6 | narration lines → TTS segments |
| References | `character_reference` … `style_reference` / image-generation | `character-reference`, `location-reference`, `prop-reference` v5 (location and prop take a kind: panorama, sheet, multi-angle), `style-reference` v5 | full-resolution canonical asset + a draft `reference_assets` row |
| Panels | `panel_generation` / image-generation | `panel-generation` v12 | a new `panel_art` asset, activated on the panel |
| Masked edit | `panel_edit` / image-edit | `panel-edit` v4 | a new `panel_art` asset with `parent_asset_id` set |
| Cover | `cover` / image-generation | `cover` v4 | cover artwork (the title is composited by the app) |
| Video thumbnail | `thumbnail` / image-generation | `thumbnail` v1 | text-free 16:9 art saved as `settings.thumbnail`; the headline is composited by the app |
| Panel QA | `panel_check` / text-ai | `panel-check` v2 | `panels.qa` verdict and face boxes from a vision model (opt-in) |
| Narration timing | `narration_retime` / text-ai | `narration-retime` v1 | `NarrationRetime`: the chosen lines rewritten to a word budget each, kept on the job until the user applies them (`docs/VIDEO_EXPORT_REFERENCE.md`, timing pass) |
| Social copy | `social_copy` / text-ai | `social-copy` v1 | `SocialCopy`: a title and caption per repurposing item, written into `settings.repurpose.items` by id (only the items asked for) |
| Narration QA | `narration_lint` / text-ai | `narration-lint` v1 | `NarrationLintReport` stored as `narration_findings` (source `ai`) for the chapter |
| Audio check | `audio_check` / text-ai | — (no model) | Measured takes and chapter loudness, stored as `narration_findings` (source `audio`) |
| Narration fixes | `narration_fix` / text-ai | `narration-fix` v1 | `NarrationFix` checked against the flagged lines, returned as before/after proposals in the job result; applied only when the user confirms |
| Story coverage | `story_coverage` / text-ai | `story-coverage` v1 | one `StoryCoverageMap` per part of the source; the findings and shares are computed from them and kept in the job result |
| YouTube package | `youtube_package` / text-ai | `youtube-package` v2 | `YoutubePackage` (titles, description, tags, pinned comment, thumbnail headlines) saved to `settings.youtubePackage`, editable there |
| Story bible extraction | `bible_extract` / text-ai | `bible-extract` v1 | `BibleExtraction` (proposed facts and character states) in the job result; saved only when the user applies the reviewed list (see Story bible) |
| Continuity check | `continuity_check` / text-ai | `continuity-check` v1 | `ContinuityReport` → `continuity_findings` (the chapter's open findings replaced) and each fixed rule's verdict on the job result |
| Expert output actions | `expert_extract` / text-ai | `expert-concept`, `expert-premise`, `expert-outline`, `expert-youtube` v1 | `ProjectConcept`, `ProjectPremise`, `StoryOutline` or `YoutubePackage` in the job result, applied only when the user confirms (see Experts) |

Narration synthesis and exports are separate job families (`audio_jobs` on the `tts` queue, `export_jobs` on
`export`); see `docs/ARCHITECTURE.md` for the queue table and `docs/PROMPT_SYSTEM.md` for the templates.

A job keeps its row, compiled prompt and cost after its image is deleted: the generation history then shows the
output as deleted (`outputDeleted`) instead of the picture, and the job's page offers **Restore image** while the
image is still in the trash.

A panel generation attaches, in this order and at most eight: the approved character references (each followed by
the reference of the outfit worn), the location, the props, the project style, the panel's **layout guide** (a
sketch or pose the user uploaded or drew, role `layout_guide`, always given a slot), and last the previous panel of
the scene for continuity only. The prompt names each one; the guide is read for composition, framing and poses only
(`loose` or `strict`), never for style or identity, and masked edits leave it out. It is also the one reference
sent large: a lossless PNG fitting 1024 px instead of the 192×288 derivative, because a pose lives in thin strokes.
In strict mode a `POSE / LAYOUT` section right after the goal line says the sketch wins over the written composition
on pose, placement and framing. Details and the reasons for the order are in `docs/IMAGE_REFERENCES.md`.

The video thumbnail (`POST /api/projects/:projectId/thumbnail`, same body as the cover plus `side: left|right`) draws
16:9 art that keeps that side dark and clear. The title and subtitle stay text in `settings.thumbnail`, and
`GET /api/projects/:projectId/thumbnail.png` composites them at request time (1280 px wide by default), so rewording
the headline or moving it to the other side costs nothing. It never replaces the cover. The YouTube package's
thumbnail headlines are previewed side by side on the same art (Exports → YouTube package → *Thumbnail variants*,
each with *Use* and a full-size download), and the package export ships each one as its own image under
`thumbnails/`, next to every title option in `titles.txt`: title and thumbnail variants to compare or A/B test, at no
image cost.

The YouTube package (`POST /api/projects/:projectId/youtube-package`, `ai` and `batch` like any text step; Exports →
YouTube package in the app) writes the publishing text from the project's title, description, chapter summaries and
cast, and the current thumbnail headline. The result is saved to `settings.youtubePackage` and edited there; the job
keeps no copy. A project's `settings.youtubeRules` (Settings → Thumbnail & YouTube text, usually from its channel
profile) go along as `<channel_rules>`: `titleRules` the titles follow, a `descriptionTemplate` whose fixed text is
kept and whose `{hook}` and `{summary}` the model writes (`{title}` and `{author}` are filled in by the worker first),
and `tags`, which the worker puts first on every package as written. A video render that spans more than one chapter also writes `<name>.chapters.txt`, one
`m:ss Chapter N: title` line per chapter with the first pinned at `0:00`. The `youtube_package` export makes no AI
call: it zips the newest full video of the same scope (never a partial or page-selection render; with its `.srt` and
`.chapters.txt`), the composited
thumbnail when there is one, and the text files, with the chapter lines appended to the description. It fails if the
text has not been written or no video has been rendered.

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

### Output actions

A finished reply offers four actions (*Use as*: New project, Premise, Outline, YouTube text). Each queues an
`expert_extract` text job (`POST /api/expert-messages/:id/extract` with the action and the usual `ai` choice), so it
runs with a provider key or in paste mode like any text step, with validation and one repair. The reply and the
question it answered are copied onto the job when it is queued, so retrying the reply later does not change what an
extraction read. The four templates share one frame: work from the reply, keep its names and wording, take the option
it recommends (or the first), and write in the project's language. Their schemas are in `packages/schemas`
(`experts.ts`): `ProjectConcept` (title, logline, premise, project type, format, story idea), `ProjectPremise`
(logline and premise), `StoryOutline` (chapters with title and summary) and the existing `YoutubePackage`.

Nothing is applied by the job. The chat shows the result under the reply for review and editing, and
`POST /api/expert-extractions/:id/apply` (the reviewed `data`, `again`, and for a concept `attachChat`) applies it
with the same code as the ordinary routes: creating the project with the story idea as an `idea` revision (and,
optionally, moving the chat to it), replacing the description (logline, a blank line, the premise) or
`settings.youtubePackage`, or adding an `outline` story revision (one `Chapter N: title` paragraph per chapter).
Applying is recorded on the job (`result.applied`: when, how many times, and the project or revision it made), so
the chat shows "Applied" with a link after a reload. The job is claimed in one statement before anything changes,
so a double click or a retry cannot apply it twice; a second apply is refused with 409 `already_applied` unless
`again: true` (the chat's *Apply again*, behind a confirmation). A failed apply puts the record back as it was. Premise, outline and YouTube text need a chat about a project; the job runs
in that project (its budget, its Generation page). A concept from a chat about no project is the one job without a
project: `generation_jobs.project_id` is null, only its owner can read or answer it, its usage is recorded against no
project (only the server's monthly ceiling applies to it), and it is followed from the chat itself.

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
- **The story bible** (since `page-planning` v7, `panel-prompts` v5, `narration` v6, `panel-generation` v12): see
  [Story bible](#story-bible) below for what each step receives from it.

Applying a story analysis writes its setting, rules, technology, magic, factions, uniforms, recurring scenery,
vehicles, genre, tone, themes, motifs and notes into empty world notes, and its summary into an empty project
description (which the cover is drawn from).

## Story bible

The project's canon, on the **Bible** page (`/projects/:id/bible`; `GET /api/projects/:projectId/bible`, data model
in [DATA_MODEL](DATA_MODEL.md#story-bible-biblets)): **facts** (kind, subject, text, an optional inclusive chapter
range, `fixed` for a rule that must hold, `visual` for what can be seen) and a **character state timeline** (injury,
look, outfit, item, location, rank, knowledge or other, from a chapter and scene number on; a later look, outfit,
location or rank replaces the earlier one, the rest hold until their end chapter).

**What each step receives** (`bibleInEffect`, `packages/domain/src/bible.ts`, through `bibleFor` in
`packages/services/src/bible.ts`). Facts whose range covers the chapter and whose subject is the whole story (empty,
"world") or is someone or something the step is about; states in force there for the characters it is about; fixed
rules first; at most 40 facts and 40 states. An empty bible sends nothing.

| Step | Where it lands | About whom and what | At |
| --- | --- | --- | --- |
| Chapter planning | `project_data.bible` | characters and subjects the chapter's title, summary, text and beats mention | the chapter: states at its start plus changes during it, marked "from scene N" |
| Narration | `project_data.bible` | the chapter's cast on its panels, and what its text mentions | the chapter, as for planning |
| Panel prompt prep | `context.bible` | the page's characters, location and props, and what its beats mention | the page's scene |
| Panel images | `STORY CANON (must hold)` | the panel's characters, location and props | the panel's scene; visual facts and injury, look and item states only, at most 12 of each |

An outfit state that names one of the character's outfits also dresses them: outfit resolution
(`resolveOutfits`) uses it, reference image included, where no panel assignment or panel outfit text says
otherwise (source `bible`, before the default outfit). The image prompt leaves other outfit states out, since the
`WARDROBE` line already carries the worn outfit. `GET /api/projects/:projectId/bible?chapterId=` returns `inEffect`,
exactly what planning and narration of that chapter receive.

**Extract from story** (`POST /api/projects/:projectId/bible/extract`, `chapterId` for one chapter, `ai` and `batch`
as for any text step, paste mode included) queues a `bible_extract` job. `bible-extract` v1 reads the chapters'
text (headed `=== Chapter N: title ===`), the cast with aliases and outfits, places, props, world notes,
relationships, each chapter's memory (state changes and revealed facts) and the bible already there, and returns
`BibleExtraction`: facts with chapter numbers and states naming characters by name. Nothing is saved by the job.
The page shows the proposal to tick through; `POST /api/bible-extractions/:id/apply` saves the reviewed lists (or
the whole proposal), matching characters by name or alias (any case) and chapters by number, and skipping (and
listing) entries that match neither. It is claimed on the job in the same transaction, so a second apply is
refused with 409 `already_applied` unless `again: true`. **Discard** applies an empty list.

## Continuity check

`POST /api/projects/:projectId/continuity-checks` (`chapterId` for one chapter, else every chapter with panels or
narration; `ai` and `batch` as for any text step) answers with the chapter count and an estimate (about 2,500 tokens
plus some per panel, narration line and bible entry, priced at the chosen model's rate) until it is sent with
`confirm: true`; then it checks the budget against that estimate and queues one `continuity_check` job per chapter.
On the Bible page this is the *Continuity* and *Rule checks* tabs; MCP `run_continuity_check`.

`continuity-check` v1 receives, as data, the chapter's scenes (states and changes), its panels (ref `p<page>.<panel>`,
beat, cast with outfits and actions, continuity requirements, up to six lines of dialogue), its narration lines in the
project language (ref `n<number>`), at most 400 of each; the bible in effect at the chapter with refs (every fixed
rule in effect as `R<n>`, whoever it is about; facts `F<n>` and states `S<n>` about who and what the chapter
mentions); the previous chapter's summary, closing state, changes and revealed facts, earlier revealed facts, and the
next chapter's summary. It returns `ContinuityReport`: findings (severity, message, where, the quoted line, the ref it
contradicts and that entry's text) and a pass, warn or fail for every `R<n>` (one it leaves out counts as pass). It is
told to report only real contradictions with the data, not style or quality.

The handler resolves refs to the panel (and its page), the narration line, the scene or the chapter and to the
bible fact, replaces the chapter's open findings and skips any that matches (place and quote) one already ignored or
explained. The queue (`GET /api/projects/:projectId/continuity`, MCP `get_continuity_report`) links each finding to
where it is fixed; `PATCH /api/continuity-findings/:id` marks it `fixed`, `ignored` (with a reason) or `open` again,
and `POST /api/continuity-findings/:id/explain` saves a new bible fact (source `continuity`) and marks it `explained`.
The same report lists every fixed rule with its verdict per chapter from that chapter's latest finished check, and
the worst of them. Rules are checked against the text of the production only: no vision model looks at the artwork.

## Colour mode, format and audio timing

- **Colour mode wins over the preset**: `styleSection()` drops a preset's monochrome `colorPolicy` line for a
  full-colour project and drops `screenTones` entirely, so one prompt never carries both "Black and white with grey
  tones" and "Full color artwork" (measured: seinen presets rendered monochrome in colour projects).
- **`projectType` is direction, not a label**: each type adds a format line (manga ink values, manhwa polished
  digital, webtoon phone-legible, comic bold inking, storybook painterly).
- **Photoreal styles**: a style definition with `photoreal: true` (the built-in **Realistic** preset, or a style
  described from a photograph) replaces the format line with live-action cinematography, calls the images
  "live-action film" in every opening line, and asks for a "photorealistic live-action film still" instead of a
  panel. In a project that is not full colour it asks for black-and-white photography instead of the colour mode's
  ink and screentones.
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
`story-analysis` v3, `page-planning` v7, `shot-planning` v4, `panel-prompts` v5, `narration` v6 and the image
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
- **Art direction binds planning**: since `page-planning` v4 and `panel-prompts` v2 (live: v7 and v5) the planner
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
  `x-allow-over-budget: 1`. Bulk estimates include the budget, a confirmed bulk run is refused when its estimate
  would reach the cap, and queued batch jobs re-check it when they start, pausing the batch instead of overspending.
- **Server budget ceiling** (Admin → Usage, default `INSTANCE_BUDGET_USD_MONTHLY`): the whole server's spend this
  calendar month (UTC). Checked before the project cap at the same points (`assertBudget`, the worker's batch gate),
  refused with 402 `instance_budget_exceeded`, which no header overrides. Batches pause and production runs pause
  exactly as at the project cap.
- **Pause/resume batches**: `POST /api/generations/batches/:batchId/pause|resume`. Pausing removes not-yet-started
  jobs from Redis and marks them `paused` (reason in `failure_reason`); running jobs finish. A job failing with `auth`
  or `quota` pauses the rest of its batch automatically. Resume re-arms the jobs' outbox rows — same job ids, so
  BullMQ dedupes.
- **Production runs** never ask to go over: a run can only start when the project has a cap, and a
  `budget_exceeded` refusal pauses the run until the cap is raised (see [Production runs](#production-runs)).
- **Queue recovery**: the worker re-publishes `queued` generation, audio and export jobs whose Redis entry has
  disappeared (15 s after startup, then every 5 minutes), so a Redis flush or restore never strands jobs.

## Narration pauses and style

Segments get `narrationPauseMs` (default 350 ms) after them; the last segment of each scene and of the chapter gets
`sceneBreakPauseMs` (700 ms). Pauses are applied at compose time, so `POST /api/chapters/:id/narration/pauses`
re-applies the settings without touching audio. `narrationStyle` is stored in project settings and used when a
narration request has no explicit style, so every chapter is written in the same voice.

## Pronunciation dictionary

`settings.pronunciation` is a list of `{ term, spoken, caseSensitive (false), wholeWord (true) }` ("Qi" → "chee").
The TTS worker replaces each term with its spoken form (`spokenText` in `packages/domain`, one pass, earlier then
longer match first) in the text it sends to the voice, for every provider; narration, subtitles and lettering keep the
written text. A segment's `text_sha256` is the hash of that spoken text, so the audio cache is keyed on what is said.
Saving a different dictionary re-hashes the project's segments (`rehashNarrationSegments`): only those whose spoken
text changed read as stale, and *Synthesize missing* or a production run's audio step re-voices just those. Project
templates carry the dictionary like any other setting, so a new project made from one starts with it.

## Narration QA

`POST /api/chapters/:id/narration/lint` (or `/api/projects/:projectId/narration/lint` for every chapter with
narration) runs the deterministic checks in `packages/domain/src/narration-lint.ts` at once, over the chapter's lines,
its panels in reading order (the video's shots) with their dialogue, and its current audio:

- repeated sentence openings (the same first two words three times within five sentences), and a flat rhythm (six
  or more sentences in a row of nearly the same length);
- a cast name said more than three times within five sentences;
- near-duplicate lines (word-bigram similarity of 0.7 or more);
- a line that restates its panel's dialogue (a shared run of five words, or most of the dialogue's content words);
- a chapter whose first or last line opens or ends like another chapter's;
- density: a shot carrying more than twice the words-per-panel target, three or more shots in a row with no
  narration (a line spanning shots covers them), and words per minute of the voiced audio more than 25% off the
  target runtime's (150 by default).

`semantic: true` also queues one `narration_lint` job per chapter for what counting cannot find: meaning repeated in
other words (within the chapter and against earlier chapters), a fact explained a third time, and a line that only
describes its frame. The prompt names lines `L1…Ln` with each line's frame (from its panel spec: beat, action,
composition, mood) and dialogue; earlier chapters go in as their summary and the first sentence of each line, nearest
first, within a 30,000-character budget, so a long project stays within context.

Findings are stored in `narration_findings` per chapter, language and source (`rule` or `ai`) with a fingerprint of
their kind, lines and related chapters. A run replaces its source's findings and returns how they compare with the
last run (`found`, `introduced`, `remaining`, `resolved`): a finding found again keeps its status (an ignored one stays
ignored, a fixed one reopens), one no longer found is removed. `GET /api/projects/:projectId/narration/findings`
lists them with counts by status, kind and chapter; `PATCH /api/narration-findings/:id` ignores or reopens one;
`GET /api/projects/:projectId/narration/density` gives words, words per shot, silent shots and words per minute per
chapter, and shot by shot for one chapter.

**Fix only what was flagged.** `POST /api/chapters/:id/narration/fix` with finding ids queues a `narration_fix` job
that sees every line for context but may rewrite only the flagged ones; an answer naming any other line has that
entry dropped. The job result is a list of `{ lineId, before, after }`; nothing is written yet. `POST
/api/chapters/:id/narration/fix/apply` applies all or some of them (a line edited since is skipped), marks the findings
fixed, re-segments the lines (sentences that did not change keep their audio), queues synthesis for just the changed
segments of lines that were voiced, re-runs the deterministic checks on the chapter and returns the comparison, and
with `recheck: true` queues the AI check again on the model the fix used. Silent stretches and pace need lines added or
the voice changed and are not offered for a rewrite.

**Audio check.** `audio: true` on the same routes also queues one `audio_check` job (no model, nothing spent) over the
voiced audio of the chapter, or of every voiced chapter. Each current segment's WAV is measured in 10 ms windows
(`analyseWav`, `packages/audio`): speech level (RMS of the windows above -45 dBFS, so pauses don't lower it), peak,
clipping (runs of three or more samples at full scale) and the longest silence between the first and last sound. The
rules (`audioFindings`, `packages/domain/src/narration-lint.ts`) flag a silent take (speech below -50 dBFS), clipping
(high from 20 ms), a stall inside a line (a pause over 1.5 s) and a line more than 6 dB louder or quieter than its
chapter's median. Each chapter's narration is also written as one WAV with its pauses and measured by ffmpeg's EBU R128
meter (`ebur128=peak=true`): integrated loudness, loudness range and true peak, in the job result and in the findings
response as `audio` (newest measurement per chapter); a chapter more than 3 LU from the others' median is flagged
(`audio_loudness`), since normalising the whole film to -14 LUFS leaves it out of step. Findings are stored with
source `audio`. They are fixed by a new take, not a rewrite: `POST /api/chapters/:id/narration/synthesize` with
`lineIds`, `onlyMissing: false` and `newTake: true` synthesizes those lines again even where the same text, voice and
speed are cached (local Kokoro gives the same take every time, so edit the line or change its speed there; a cloud
voice usually gives a new one). Run the check again to see them resolved.

## Story coverage

`POST /api/projects/:projectId/story/coverage` queues a `story_coverage` job against the applied story revision (the
one the newest applied analysis read; `storyRevisionId` picks another). The worker (`handlers/story-coverage.ts`)
splits the revision into paragraphs with their character offsets (`splitParagraphs` in
`packages/domain/src/coverage.ts`: blank lines, else line breaks, and anything over 2,400 characters cut at sentence
ends) and groups them into parts of at most 12,000 characters. Each part is one `story-coverage` request: the
paragraphs as `[P12] …` in `<story_content>`, and the plan as every chapter's key (`C3`), title and summary plus,
for the chapters around that part, their scenes (`C3.S2`) with summary and panel beats, within a 24,000-character
budget. Where a part falls is found from each chapter's source excerpt in the text, or by proportion when the
excerpts cannot be found. The answer weighs every paragraph 1–5 and names the scenes or chapters that tell it; an
answer missing a paragraph is sent back for repair (or, pasted, rejected with the missing keys).

From the map, `coverageFindings` reports:

- **left out** — paragraphs of weight 3 or more that nothing tells, consecutive ones joined into one span;
- **told twice** — a paragraph told in two or more chapters;
- **more or less room than its weight** — a chapter (and, when it points the other way, one of its scenes) whose
  share of the panels is 2.5 times its share of the story or less than 1/2.5 of it, the story share being each
  paragraph's weight × length split across what tells it. Shares under 2% of both are not judged.

The result keeps every finding with its source spans (offsets in the revision) and chapter and scene ids, each
chapter's share of the story, the panels and the narration words, and the paragraph map.
`GET /api/projects/:projectId/story/coverage` returns the newest report with an excerpt of each span, whether the
applied story or the plan (chapters, scenes, pages, panels) changed since, and any check still running. Paste mode asks
one question per part.

## Narration languages

Narration lines carry `language`, so a chapter can hold one track per language over the same artwork. `narration` v3
added the target language to v2's coverage and length rules (word counts for Japanese, Chinese and Thai are estimated
at 2 characters per word) and v4 keeps them. Every narration endpoint, synthesis, timeline, readiness check and export
accepts `language`, defaulting to the project language.

## Consistency check (vision QA, opt-in)

`settings.consistencyCheck = { enabled, credentialId, model }`. After a panel generation or edit activates new
artwork, a `panel_check` job sends the 1024 px preview plus the expected cast (names and appearance) to a
vision-capable text model (`panel-check` v2, schema `PanelCheck`). The expected appearance uses the outfit the panel
resolves to (see `docs/IMAGE_REFERENCES.md`), not the bible's default wardrobe. The verdict is computed
deterministically — missing expected characters, unexpected people, headcount mismatch, readable text drawn in the
art — and stored on `panels.qa`; the page grid outlines mismatches and the Panel tab's badge names the first problem,
shows the model's notes on hover, and has a **Run check** button (**Check again** once checked;
`POST /api/panels/:id/check`). The check's prompt is saved on its job like every other text step's.

**Check all panels** (`POST /api/projects/:projectId/checks`, scope a page, a chapter or neither for the whole
project) queues the same check for every panel with artwork, at most 500 at a time. Without `confirm: true` it only
returns the count, what it skipped (no artwork, already being checked, already checked) and an estimated cost. By
default (`onlyUnchecked`) it skips panels whose current artwork already has a check with face boxes. It uses the
project's consistency-check key when one is set, else the caller's text choice, and can be sent as a provider
batch. The button is on the chapter page, the Storyboard page and the page editor's lettering tools. The
**Storyboard** page (`/projects/:id/storyboard`) shows every panel of a chapter, filtered to all, no artwork,
failed, needs review, check mismatch or not checked; arrow keys move, Enter opens the panel in the editor, and C
(check) and G (regenerate) ask before they spend.

The check also lists every clearly visible face as a box (fractions of the image) named with the expected character
or `unknown`. **Move bubbles off faces** in the page editor's lettering tools
(`POST /api/pages/:id/lettering/fit-faces`, for a page, chapter or project) uses those boxes to re-place bubbles and
captions off the faces and point each tail at its speaker's face, with no image call. Panels without a current check
(none yet, stale, or made for other artwork) are left as they are and counted. DeepSeek
cannot read images, so this needs a BYOK vision model. Text providers accept `images` on chat messages (OpenAI-style
content parts, Anthropic image blocks).

## Describe a reference image

`POST /api/projects/:projectId/images/describe` (multipart: `file`, plus `aspects`, `custom`, `note`, `ai`,
`batch` as form values) uploads an image and queues an `image_describe` job; `POST /api/assets/:id/describe`
does the same for an image already in the project (a panel, a reference, an earlier upload). Both refuse before
storing anything, so a request rejected for want of a key leaves no orphan image behind.

The job attaches the 1024 px preview to the user message and asks `image-describe` v2 for the schema
`ImageDescription`. Eleven aspects, each with its own prompt fragment rather than one broad instruction:

| aspect | returns | applies to |
|---|---|---|
| `style` | `StyleDefinition` | the project's art direction |
| `character` | `CharacterBible` | a new character |
| `location` | `LocationDescription` | a new location |
| `outfit`, `lighting`, `composition`, `mood`, `props`, `era`, `technique` | prose + bullet details | copied by hand |
| `pose` (v2) | one composition-ready sentence, per-figure notes, framing | a layout guide's pose text, after review (*Describe pose* on a layout guide) |

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

Bulk image generation (panels, or every character, location or prop reference) and the text steps (story
analysis and rewrite, chapter planning, panel prompts, narration text, consistency check, image description,
YouTube package, story bible extraction, continuity check) can be sent to a
provider's batch API instead of running now, at half the interactive price: `batch: true` on the request, or
**Send as a provider batch** in the bulk dialog. OpenAI and Google only; a batch request on any other provider is
refused with 400 (in `AI_MOCK_MODE` it simply runs normally). A consistency check queued after a batched panel is
batched too. See
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

**A full provider batch queue is waited out, not failed.** OpenAI caps the tokens an organisation may have
enqueued per model across all its unfinished batches (`token_limit_exceeded`, "Enqueued token limit reached"), and
Google has an equivalent enqueued-tokens quota. A refusal arrives either on the create call or, for OpenAI, as a
batch that is accepted and then fails validation without running. Either way nothing ran and nothing was billed,
so (`apps/worker/src/lib/batch-wait.ts`):

- Chunks already accepted stay submitted. The submitter stops at the first refused chunk, since the rest would be
  refused the same way.
- The refused jobs stay `queued`, with `parameters.queueWait = { since, nextAt, tries, reason }`. The `batch-poll`
  scheduler resubmits them when `nextAt` passes, after 5, 10 and 20 minutes and then every 30. It re-checks the
  project budget first, as the runner does.
- Each round adds `:w<tries>` to the chunk's idempotency key. A batch that was accepted and then refused still
  exists under its old key, and reusing that key would adopt the refusal instead of submitting again.
- After 24 hours of waiting the jobs fail with `batch_queue_full` and say why. By then every earlier batch has
  completed or expired, so something else is holding the queue.
- Most refusals are avoided up front: a key may have at most `BATCH_MAX_IN_FLIGHT_IMAGE` (4) image batches and
  `BATCH_MAX_IN_FLIGHT_TEXT` (16) text batches in flight per provider and model (queued or running at the provider;
  0 = no limit). The submitter checks the count before it builds any request, submits only as many chunks as fit, and
  holds the rest as `queueWait.held`. Held jobs show as waiting too, but the poller retries them on every pass,
  after ingesting, so a slot freed by a finished batch is filled in the same pass. They have no deadline, and they
  keep their idempotency round, because nothing was sent. The count is per user rather than per credential: one user
  with two keys for the same provider shares one limit.
- The batch banner and `GET /api/projects/:projectId/generations/batches` show the state `waiting` (or `submitted`
  while other chunks are at the provider) with `queueWaitUntil`: "waiting for room in the provider's batch queue,
  next try at HH:MM". Pause and cancel work as for any queued batch job. The maintenance sweep for stranded batch
  jobs only fails jobs whose submit job failed, so it leaves these alone.

## Target runtime

`settings.targetRuntime = { minutes, wordsPerMinute (150), minShotSeconds (4), maxShotSeconds (8) }`, set in
Project settings → Target runtime, aims the video at a length. `runtimeBudget` (`packages/domain/src/runtime.ts`)
splits `minutes × wordsPerMinute` narration words across chapters in proportion to each chapter's source text,
turns each share into shots at the middle of the allowed shot length, and into a page target (shots ÷ 3.5 for a
comic, one page per shot for film and vertical strips, capped at 60). With a target set:

- a chapter plan requested without `targetPages` is asked for that chapter's page target;
- narration text requested without `wordsPerPanel` uses `wordsPerPanelFor`, the words per panel that land the
  chapter on its word share, kept between what the shortest and longest shot hold (and within 5–80), instead of
  `settings.narrationWordsPerPanel`;
- the Exports page starts the video's minimum hold at `minShotSeconds`.
- story analysis (`story-analysis` v3) is told the length and asked for at least `chaptersForRuntime` chapters: as
  many as keep each chapter's share within 80% of what one plan holds (60 shots for film and strips, about 210
  panels for comics). A 3-hour film at 6–12 s shots asks for 25. `GET /api/projects/:projectId/runtime` reports that
  number as `neededChapters` and marks a chapter whose share needs more than one plan (`capped`); the settings page
  warns about both.

`GET /api/projects/:projectId/runtime` returns each chapter's budget (words, shots, pages) beside what is planned and
written so far, and the minutes the current narration adds up to at that pace.

## Production presets, templates and policies

A new project can start from a production preset (`packages/domain/src/presets.ts`, listed by
`GET /api/production-presets`) or from one of the user's saved templates: `preset` on `POST /api/projects` is a
preset key or `template:<id>`, and its settings are merged into the new project's (the wizard fills type, format,
style and colour mode from it). The presets are *YouTube recap* for 30 minutes, 1 hour, 2 hours and 3 hours (film,
low quality, a target runtime, main-only references, text now and images in batches, longer shots for the long
ones), *Manga chapters*, *Webtoon episodes* (medium quality,
all references, no batching) and *Economy draft*. **Save as template** (`POST /api/projects/:projectId/template`)
stores a project's type, format, colour mode, language, style and settings in the user's settings
(`projectTemplates`, at most 50; the thumbnail, YouTube text and page size are left out); story, cast and files are
never copied. Templates are listed and deleted (`DELETE /api/auth/templates/:id`) in Account.

**Channel profiles** sit one level above: a template is a kind of project, a profile is who publishes it. A profile
(Profiles in the top bar; `GET/POST /api/channel-profiles`, `PATCH`/`DELETE /api/channel-profiles/:id`) names a
`preset` (a preset key or `template:<id>`) and carries the settings in `PROFILE_SETTING_KEYS`
(`packages/schemas/src/editor.ts`): image quality, reference and batch policy, target runtime, narrator voice and
speed, the pronunciation dictionary (replaced as a whole; applying it re-hashes the narration segments it changes,
so only their audio goes stale), lettering (the font the video cards use), `video` (scene-break fades, logo watermark, intro and outro cards,
`output` aspect and resolution), `thumbnailStyle` (headline side) and `youtubeRules`. A key the profile leaves out
stays as the preset or project has it. `profileId` on `POST /api/projects` (the wizard's *Channel profile*, MCP
`create_project`) uses the profile's preset when `preset` is not given, then copies its settings on top and records
`settings.channelProfile` `{id, name, appliedAt}`. Nothing stays linked: **Re-apply profile** on the overview calls
`POST /api/projects/:projectId/apply-profile`, which lists the changes (`from` → `to`, `video` per part) and copies
them only with `confirm: true`; format, type and style are never changed. **Save as channel profile** in Project
settings (`POST /api/projects/:projectId/channel-profile`) makes one from a project. Profiles live in the owner's
`users.settings.channelProfiles` (at most 50), so another user's profile id is simply not found.

The logo: assets belong to a project, so a profile's logo is an account asset instead (`project_id` null, owned by
the user, `metadata.role = "profile_logo"`, uploaded with `POST /api/channel-profiles/logo`), served only to its
owner like an expert chat's images. Applying the profile copies it into the project as a new asset of the project, so
the video renderer's "a watermark is an image of this project" rule holds and either can be deleted on its own;
re-applying compares the logos by hash and copies nothing when it is unchanged. Saving a profile from a project
copies the project's logo out the same way, and deleting a profile (or replacing its logo) removes the account copy.

A video export with no `video.height` or `video.aspect` uses the project's `settings.video.output` (else 1080 and
16:9; Shorts stay 9:16), and a thumbnail with no `side` uses `settings.thumbnailStyle.side`.

Two settings, under Project settings → Production:

- `referencePolicy` — `all` (default) or `main`: bulk reference runs skip minor characters, and locations and props
  used in fewer than two panels. See [IMAGE_REFERENCES](IMAGE_REFERENCES.md).
- `batchPolicy` — how a production run spends: `interactive` (default, everything now), `images` (text now, bulk
  images as provider batches), `hybrid` (text steps as provider batches, images now) or `cheapest` (text and bulk
  images as provider batches; the thumbnail is drawn now). A step is batched only when its key's provider has a batch
  API (`BATCH_CAPABLE_PROVIDERS`: OpenAI, Google) and the text choice is not paste mode, so a DeepSeek text key runs
  now under any policy instead of being refused. It applies to production runs
  only; a run started by hand still chooses `batch` itself.

## Production runs

`POST /api/projects/:projectId/production-runs` (the **Production run** card on the project overview) runs the
whole pipeline as a list of steps, stored in `production_runs` (migration `0020`), each calling the same API route a
person would, as the user who started it (`apps/api/src/lib/production.ts`):

analyse → review → apply → references (characters, locations, props) → review → changed chapters → plan every
chapter → prepare panel prompts → generate missing artwork → changed narration → write narration → synthesize narration → video thumbnail → YouTube package text
→ review → render the video → YouTube package export.

**Cost plan.** `POST /api/projects/:projectId/production-runs/estimate` (same body as starting a run; MCP
`estimate_production_run`; shown in the *Produce* and *Update production* dialogs as the options and models change)
says what that run would still do and cost before it spends anything (`apps/api/src/lib/cost-plan.ts`). It follows the
run's own "only what is missing" rules: per chapter, a plan if it has no pages, prompts for pages with a panel still
to draw and no prepared prompt, panels without artwork (and, for an update, artwork whose spec was saved after it was
drawn: the same `staleArt` the art step redraws), narration if it has no lines, and narration audio (the run voices
with the local voice, so time and disk, no spend); for the project, the analysis until there are chapters, missing
references (counted by the bulk route's own `confirm: false` estimate), the thumbnail and the YouTube text. Each unit
is priced with the chosen models' rates (half for a batch, `batchModel`) and this server's average usage per job of
that kind over the last 90 days from `ai_usage`, or the built-in `DEFAULT_UNIT_USAGE` until there is any (`fromHistory`
lists the kinds priced from history). A chapter not planned yet is estimated (`estimated`), from the target runtime's
shots per chapter or the average size of chapters already planned on this server, and so is the cast before the
analysis. The plan totals what runs now and what waits in a half-price provider batch, the disk the new artwork
(measured from recent artwork and its derivatives) and narration (24 kHz WAV) will take, and the budget left, with a
warning when the total passes the cap (the run would pause there) or a model has no known price. A text model in
paste mode is free. Nothing is queued.

- **Reuse.** Every step does only what is missing: analysis is skipped once the project has chapters, references
  and artwork are drawn only where missing, only unplanned chapters are planned, narration is written only for
  chapters without lines, and the thumbnail and YouTube text are skipped when they exist.
- **Changed chapters.** Each chapter records a fingerprint of what its plan was made from (its text, as the planner
  reads it) and of what its narration was written from (its panels, beats and dialogue). A chapter with pages whose
  text changed since, or with narration whose panels changed since, is out of date (the plan and narration stages of
  *What is out of date* count it), but a run **never redoes it on its own**: re-planning replaces pages and artwork.
  The *changed chapters* review (before planning) and *changed narration* review (before writing narration) wait with
  the list, and for each chapter the person chooses **Keep current** (`POST /api/chapters/:id/keep`, which records
  the current fingerprint) or **Re-plan** / **Write again** (the ordinary chapter-plan or narration route with
  `replace: true`; the confirmation says how many pages, panels, drawn panels or lines it replaces). The run waits
  for those jobs before it carries on; undecided chapters keep what they have. Both reviews are skipped when nothing
  changed, whatever `reviewGates` says. The Story page lists the same chapters with the same choice after a revised
  story is applied.
- **Options.** `reviewGates` (default on) pauses the run as `waiting` after the analysis, after the references and
  before the render, until **Continue** (`POST /api/production-runs/:id/continue`). With gates off, the newest draft
  reference of each subject without an approved one is approved automatically. `preparePrompts` and `render` default
  on; `youtube` defaults on for film projects. `ai.text` and `ai.image` are the run's provider choices.
- **Budget.** A run spends without asking at each step, so it is refused unless the project has a budget cap, and a
  `budget_exceeded` refusal pauses it; raising the cap and continuing picks up at the same step.
- **Batching** follows `settings.batchPolicy`; a step waits for its batch like any other job. With paste mode as
  the text choice a text step waits for its answers the same way (see
  [WITHOUT_API_KEYS](WITHOUT_API_KEYS.md#production-runs)).
- **Failures.** A failed analysis, or a step whose jobs all failed, fails the run; elsewhere a partial failure is
  noted on the step and the run carries on. Continue retries the failed step, reusing whatever it already made. A
  failed render or YouTube package export is noted the same way (the package is skipped when the video did not
  render).
- **Audio is verified.** The synthesis step is done only when no narration job is queued or running *and* no
  segment lacks current audio (the audio stage's definition: no audio, or audio of other text, voice or speed).
  Segments it never queued (a refused or capped chapter request) are queued once more, through
  `POST /api/chapters/:id/narration/synthesize` with `segmentIds`; segments whose synthesis failed are not retried
  in a loop but noted on the step and listed in the run's warnings.
- **YouTube text and thumbnail headline.** *What is out of date* also flags (as `publishing`, not as stages) the
  YouTube text when the project title or the chapter list changed after it was written, or the whole-project video
  was rendered again after the YouTube package was exported (its chapter timestamps come from the video), and the
  thumbnail headline when the project title changed after it was set. What they were made from is recorded in
  `settings.publishingSources` by the writer, the thumbnail job and a headline edit. An update never regenerates them:
  it finishes with the note "YouTube text may be out of date" / "thumbnail headline may be out of date", and the run
  card offers **Regenerate** (the YouTube package route, or the headline set to the current title) and **Keep
  current** (`POST /api/projects/:projectId/keep-current`).
- **Completed with warnings (the final-output gate).** Before a run reports success it checks the output: every
  panel has artwork, every chapter with panels is narrated, every segment has current audio (the audio stage's
  definition), when the run renders the whole-project video exists and is not shorter than its narration (the voiced
  segments end to end) by more than the render's own drift tolerance (`videoDriftToleranceMs`), and nothing is known
  to be broken: failed jobs it queued that nobody retried, failed exports, panels flagged for review, panels whose
  artwork failed a visual check. Anything found finishes the run as `completed_with_warnings` instead of `completed`,
  with a `warnings` summary. The run card shows "Finished with N unresolved
  items", each linking to where it is fixed (Generation, the storyboard on its *No artwork* or *Needs review* filter,
  Narration, Exports), with **Retry failed** (the usual `POST /api/generations/:id/retry` for each listed job),
  **Review** and, when the video failed, **Render anyway**. A finished run cannot be continued.
- **Stop** (`POST /api/production-runs/:id/cancel`) ends the run and, by default, cancels what it queued that has
  not started, through the usual cancel paths: its generation jobs that are queued, waiting in a provider batch,
  paused at the budget or waiting for a pasted answer; narration audio still queued from the batches the audio step
  started (`audioBatchIds` on the step); and its export if it has not finished. Jobs already running at a provider
  finish, and the stopped run acts on nothing they return. `{ "jobs": false }` stops the run only. An active run's
  `pendingJobs` says how many jobs stopping it would cancel; the card's Stop dialog shows it.

**Project health** (`GET /api/projects/:projectId/health`, the **Health** page and the overview's Health card, MCP
`get_project_health`) puts it all in one report: a verdict (*ready to publish*, or *N blocking issues*) and items,
each with a severity and a link to where it is fixed. Blocking: export readiness (panels without artwork, chapters
without or with patchy narration, segments without audio, superseded versions), a missing or out-of-date
whole-project video, panels that failed a visual check. Worth knowing: every stale stage and changed chapter, the
YouTube text and thumbnail headline, jobs still running and failed ones not retried, runs of panels repeating the same
shot, open comment threads. It also shows spend against the budget and disk use.

**Shot variety** (`GET /api/projects/:projectId/shot-variety`, MCP `get_project_checks check=shot_variety`, the
storyboard's *Repeated shot* filter): `repeatedShots` (`packages/domain/src/shot-variety.ts`) walks a chapter's panels
in reading order and reports runs of one shot size four or more panels long, or of one size and angle (no angle reads
as eye level) three or more long, as *framing* runs. It reads the plan only, so it costs nothing and can run before
any art is drawn; change a flagged panel's shot type or camera angle in the page editor or with `PATCH
/api/panels/:id`. A chapter of new blank pages is all medium eye-level shots, so it shows up until it is planned.

The API process advances running runs every 10 seconds; one project has at most one active run. A pass holds a
lease on the run's row (`lease_owner`, `lease_until`), so two API processes never advance the same run at once, and an
expired lease (its holder died) is taken over.
