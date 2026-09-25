<p align="center">
  <img src="docs/images/logo.svg" alt="" width="96" height="96">
</p>

<h1 align="center">OpenManga</h1>

<p align="center"><strong>Self-hosted studio that turns a story into a consistent AI-illustrated comic, webtoon or
narrated video.</strong></p>

<p align="center">
  <a href="https://github.com/pr0h0/OpenManga/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/pr0h0/OpenManga/ci.yml?branch=master&label=CI"></a>
  <a href="https://github.com/pr0h0/OpenManga/tags"><img alt="Latest tag" src="https://img.shields.io/github/v/tag/pr0h0/OpenManga?sort=semver&label=release"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/pr0h0/OpenManga"></a>
  <a href="https://github.com/pr0h0?tab=packages&repo_name=OpenManga"><img alt="Container images on GHCR" src="https://img.shields.io/badge/images-ghcr.io-2496ed"></a>
  <a href="#running-without-any-api-keys"><img alt="Runs with no API keys" src="https://img.shields.io/badge/demo-no%20API%20keys-brightgreen"></a>
</p>

<p align="center">
  <a href="#features">Features</a> &nbsp;·&nbsp;
  <a href="#screenshots">Screenshots</a> &nbsp;·&nbsp;
  <a href="#docker-deployment">Deploy</a> &nbsp;·&nbsp;
  <a href="#ai-providers-bring-your-own-key">Providers</a> &nbsp;·&nbsp;
  <a href="#running-without-any-api-keys">No-key demo</a> &nbsp;·&nbsp;
  <a href="docs/EXTENDING.md">Extending</a> &nbsp;·&nbsp;
  <a href="docs/COSTS.md">Costs</a> &nbsp;·&nbsp;
  <a href="CONTRIBUTING.md">Contributing</a>
</p>

<p align="center">
  <a href="docs/images/chapter-pages.webp"><img alt="Pages of a planned chapter, every panel generated against the same canonical references" src="docs/images/chapter-pages.webp" width="900"></a>
</p>

A self-hosted production tool for consistent AI-generated manhwa, manga, webtoons and illustrated recaps. It is not "story → giant prompt → comic.png": the story becomes structured state (cast, world, chapters, scenes, pages, panel specs), canonical references pin identity, panels are generated cheaply and versioned, and lettering, layout, narration and exports are deterministic.

- **Your own provider keys** (BYOK) own text reasoning (analysis, planning, prompt prep, narration) and raster
  generation — pick a provider and model per run; see [AI providers](#ai-providers-bring-your-own-key).
- **Kokoro-82M (local)** owns speech synthesis ($0 external API), or use a cloud voice provider.
- The application owns everything else.
- **No telemetry, no analytics, no phone-home.** Outbound requests go only to the AI providers you configure,
  plus a one-time model download from HuggingFace for local TTS on first boot.

## Features
- **Project wizard**: details, format (comic pages, 16:9 video shots, or a vertical scrolling strip), style preset, story input (story/chapter/outline/screenplay/idea), AI analysis, editable review, apply.
- **Three formats**: comic pages; **film** — one 16:9 shot per page, rendered as a narrated Ken Burns video; and **vertical strip** — one scrolling column where each panel's height is its pacing and the seam between panels (gap, butt, bleed, dissolve, fade) is authored, read in the app exactly as it exports.
- **No API key required**: every text step can be answered by pasting a reply from any chat, validated exactly as a provider's answer is, and any panel can take artwork you upload — see [Running without any API keys](#running-without-any-api-keys).
- **Story**: autosaved editor, immutable revision history, AI rewrite into new revisions, analyses per revision.
- **Cast**: character bibles with aliases, outfits and versions (draft → approved → locked → superseded); reference generation (portrait, full body, turnaround, expression sheet, outfit) or upload; approval creates the small prompt derivative; explicit panel migration between versions.
- **Outfits that change with the story**: switch a character's outfit on a panel, from that panel on (carried across pages and chapters) or for that panel only, picked from chips with each outfit's reference image; the character page lists every change, and chapter plans switch outfits too.
- **World**: locations and props with versions and references (a location as a wide view, a panorama or a sheet of every side; a prop as a single view or from every angle) — draw every missing one in a single run, optionally as a half-price provider batch — style presets + custom style versions + style references, world notes.
- **Chapters**: AI planning into scenes (continuity state carried scene to scene), beats, pages (deterministic layout templates) and panel specs with dialogue — placed automatically, or kept on each panel until *Letter from plan* places it where the plan left room; chapter/scene memory editors.
- **Page editor** (Konva): drag/resize/rotate panels, bubbles, SFX and narration boxes; zoom/pan; undo/redo; keyboard shortcuts; template swap, add/duplicate/split/reorder; crop and focal point; prompt inspector; generate/regenerate with operations; version compare/activate/revert; mask painting for targeted edits.
- **Generation**: live queue (SSE), cost/latency, retry/cancel, bulk page/scene/chapter with cost confirmation and progress, prompt & reference inspector showing exactly what was sent.
- **Narration**: AI-written narration, segment split/merge, voices and preview, local synthesis, cache reuse, chapter playback, timeline manifest.
- **Exports**: PNG/JPG page sequences, PDF (page size, margin, bleed, DPI, RTL), webtoon strips with chunking, narration audio package (MP3/OGG/WAV + timeline), project JSON (`schemaVersion: 1`), full ZIP package.
- **Experts**: chats with brainstorming specialists outside any chapter — topic scout, title doctor, thumbnail designer, story developer, character and world designers, hook editor, narration scriptwriter, beta reader, channel strategist — or experts you write yourself. Pick the model, attach images (upload, drop or paste), talk about a project, and tick *Generate image* for a picture with the reply. Chats are kept, and work without an API key by pasting answers from any chat.
- **AI agents (MCP)**: connect ChatGPT (OAuth) or any MCP agent (personal access token) to build projects as you — story, analysis, chapter plans, panels, narration, exports — including the whole pipeline in paste mode with no API key. Each connection has its own scopes, projects and approval mode; spending, deleting and other sensitive actions can wait for your approval in the app. See [MCP](docs/MCP.md).
- **Describe an image**: upload a reference — a frame from a video, a page you like — and extract its art style, character, outfit, location, lighting, composition, mood, props, era or technique, plus your own free-text question. Style, character and location results apply straight into the project; the upload stays in the library as a reference for later generation.
- **Provider batches**: send image or text generation to OpenAI's or Google's batch API for **half price**, results within 24h, opt-in per run.
- **Cost dashboard**: today/7d/30d/lifetime, provider and operation breakdowns, reference-size experiments, regeneration/acceptance rates. **Admin**: users, jobs, queues, Kokoro status, storage, errors, rate snapshots, maintenance.

## Screenshots

From a live instance, with real projects. Click any image for full size.

### From story to pages

| | |
|---|---|
| [![Projects](docs/images/projects.webp)](docs/images/projects.webp) | [![Project overview](docs/images/project-overview.webp)](docs/images/project-overview.webp) |
| **Projects** — every story with its cover, format, chapters and spend. | **Overview** — pipeline state, spend against the project budget, readiness before export. |
| [![Chapters](docs/images/chapters.webp)](docs/images/chapters.webp) | [![Page editor](docs/images/page-editor.webp)](docs/images/page-editor.webp) |
| **Chapters** — planned into scenes, pages and panels, with narration coverage per chapter. | **Page editor** — panels, speech bubbles and captions on the canvas; the panel's spec, cast and seam beside it. |

### The same characters and places, every panel

| | |
|---|---|
| [![Cast](docs/images/cast.webp)](docs/images/cast.webp) | [![Character bible](docs/images/character-bible.webp)](docs/images/character-bible.webp) |
| **Cast** — characters, approved reference versions and how many panels use each. | **Character bible** — the appearance version that is the identity source of truth; approved versions are read-only. |
| [![World](docs/images/world.webp)](docs/images/world.webp) | [![Assets](docs/images/assets.webp)](docs/images/assets.webp) |
| **World** — recurring locations and props with their own references; *Generate all* draws every missing one at once. | **Assets** — every canonical file and its derivatives, here filtered to approved character references. |

### Comic, film or vertical strip

| | |
|---|---|
| [![Film shots](docs/images/film-shots.webp)](docs/images/film-shots.webp) | [![Vertical strip reader](docs/images/vertical-reader.webp)](docs/images/vertical-reader.webp) |
| **Film** — a chapter as 16:9 shots, one per page, rendered as a narrated video. | **Vertical strip** — the chapter as one scrolling column, seams and lettering included, exactly as it exports. |
| [![Video preview](docs/images/video-preview.webp)](docs/images/video-preview.webp) | [![Exports](docs/images/exports.webp)](docs/images/exports.webp) |
| **Video preview** — the cut with its camera moves and narration timing, in the browser, before committing to a render. | **Exports** — narrated videos, PDFs, webtoon strips and packages, chapter by chapter. |

### Narration, queue and cost

| | |
|---|---|
| [![Narration](docs/images/narration.webp)](docs/images/narration.webp) | [![Generation queue](docs/images/generation.webp)](docs/images/generation.webp) |
| **Narration** — text first, then local Kokoro speech per segment, with progress across every chapter. | **Generation** — the live queue: every job, its cost and latency, and exactly what was sent. |
| [![Project cost](docs/images/cost.webp)](docs/images/cost.webp) | |
| **Cost** — spend per provider and per operation, images against text, with local TTS at $0. | |

## Architecture
Bun monorepo (`apps/web`, `apps/api`, `apps/worker`, `apps/mock-ai`, `packages/*`, `services/kokoro`) running in
Docker Compose behind nginx on one domain: `/app` SPA, `/api` API, `/cdn` authorized assets, `/healthz`.

| Document | What it covers |
|---|---|
| [ARCHITECTURE](docs/ARCHITECTURE.md) | Processes, request and job flow, which package owns what |
| [DATA_MODEL](docs/DATA_MODEL.md) | Tables and how story state, versions and assets relate |
| [AI_PIPELINE](docs/AI_PIPELINE.md) | Analysis → planning → panels → narration, and provider resolution per run |
| [WITHOUT_API_KEYS](docs/WITHOUT_API_KEYS.md) | Driving the whole pipeline by hand: paste text answers, upload artwork, no provider keys |
| [ANSWER_FORMATS](docs/ANSWER_FORMATS.md) | Every answer a pasted run can ask for: each field explained, typed and exemplified |
| [MCP](docs/MCP.md) · [MCP_TOOLS](docs/MCP_TOOLS.md) | Letting ChatGPT and other AI agents work on projects: OAuth, access tokens, scopes, approvals; the generated tool catalogue |
| [PROMPT_SYSTEM](docs/PROMPT_SYSTEM.md) | Versioned templates, validation, repair |
| [IMAGE_REFERENCES](docs/IMAGE_REFERENCES.md) | Canonical references, derivatives, what is sent with each request |
| [VIDEO_EXPORT_REFERENCE](docs/VIDEO_EXPORT_REFERENCE.md) | How the page cut and panel cut are rendered |
| [AUTH](docs/AUTH.md) · [SECURITY](docs/SECURITY.md) | Sessions, CSRF, authorization; the security model and key handling |
| [STORAGE](docs/STORAGE.md) | Asset layout on disk and authorized serving |
| [REQUIREMENTS](docs/REQUIREMENTS.md) · [DEPLOYMENT](docs/DEPLOYMENT.md) | What to run it on, and how to deploy and back it up |
| [COSTS](docs/COSTS.md) | Measured provider spend and the in-app controls |
| [TESTING](docs/TESTING.md) | Unit, integration, browser and smoke suites |
| [EXTENDING](docs/EXTENDING.md) | Adding a provider, prompt, export kind, job type, layout, migration or route |
| [ROADMAP](docs/ROADMAP.md) | What is next, and what will not be built |

## Requirements
- Docker Engine with Compose v2 (everything else runs in containers)
- ~8 GB RAM with local TTS enabled (Kokoro loads one model copy per worker process), ~4 GB without
- Disk grows with output: ~2.7 GB of assets for 50 projects, and exports share the same volume
- Optional on the host for development: Bun ≥ 1.3

Full detail, including arm64 and air-gapped notes: [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md).

## Docker deployment
```bash
cp .env.example .env         # set POSTGRES_PASSWORD, SESSION_SECRET (openssl rand -hex 32), public URLs, INITIAL_ADMIN_*
docker compose up -d --build
docker compose ps            # migrate exits 0; api/nginx healthy
open http://127.0.0.1:3480/app/
bun db:seed                  # optional demo project, mock art, no API calls
                             # (in the api container: docker compose exec api bun db:seed --owner <user>)
```
Sign-up is closed by default (`REGISTRATION_ENABLED=false`): create the first account with `INITIAL_ADMIN_*` in
`.env` or `docker compose exec api bun admin:create`, and open registration only if you want anyone with the URL
to be able to sign up. New projects start with a $5 spend cap that asks for confirmation before it is exceeded;
change or clear it in project settings.

Prebuilt images are published to GHCR on tagged releases only, linux/amd64 (`main` is never published):
`ghcr.io/pr0h0/openmanga-app`, `ghcr.io/pr0h0/openmanga-nginx`, `ghcr.io/pr0h0/openmanga-kokoro`. To run them
instead of building locally, pin a tag in a compose override:

```yaml
# docker-compose.override.yml — compose merges this automatically
services:
  migrate: { image: "ghcr.io/pr0h0/openmanga-app:0.9.2", build: !reset null }
  api: { image: "ghcr.io/pr0h0/openmanga-app:0.9.2" }
  worker: { image: "ghcr.io/pr0h0/openmanga-app:0.9.2" }
  mock-ai: { image: "ghcr.io/pr0h0/openmanga-app:0.9.2" }
  nginx: { image: "ghcr.io/pr0h0/openmanga-nginx:0.9.2", build: !reset null }
  kokoro: { image: "ghcr.io/pr0h0/openmanga-kokoro:0.9.2", build: !reset null }
```
Then `docker compose pull && docker compose up -d`. Use a version that exists as a release tag, and pin it rather
than `latest` so an upgrade is something you choose (each release also carries its minor tag, here `0.6`). `!reset`
needs Compose v2.24 or newer; on older versions drop the `build:` keys and run `docker compose up -d --no-build`.

## Local development
```bash
cp .env.example .env
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis kokoro
bun install
DATABASE_URL=postgres://openmanga:<pw>@localhost:55432/openmanga REDIS_URL=redis://localhost:56379 ASSET_ROOT=./data/assets TEMP_ROOT=./data/tmp \
  KOKORO_URL=http://localhost:58000 AI_MOCK_MODE=true NODE_ENV=development bun db:migrate
bun dev                      # api :3000, worker, web :5173 (proxies /api and /cdn)
```
(The dev override exposes Postgres on 55432, Redis on 56379 and Kokoro on 58000, all loopback-only; use `TTS_PROVIDER=fake` to skip Kokoro.) To avoid installing Bun on the host, prefix commands with `./scripts/bunx.sh`.

Full container development: `docker compose up --build`.

## Environment configuration
All configuration is validated at startup by `packages/config` (Zod). Only three variables are required:
`DATABASE_URL`, `REDIS_URL`, `SESSION_SECRET` — everything else has a default. **There are no server-level
provider keys**: AI keys belong to users (see below). Other useful variables: `IMAGE_QUALITY` (`low`),
`IMAGE_SIZES` (~2 MP menu), `REFERENCE_MAX_WIDTH/HEIGHT` (192/288), `AI_TEXT_*`/`AI_IMAGE_*` timeouts and
concurrency, `ASSET_ROOT`, `TTS_ENABLED`, `KOKORO_URL`, `APP/API/CDN_PUBLIC_URL`, `REGISTRATION_ENABLED`,
`DEV_MAILBOX_ENABLED`, worker concurrency. See [.env.example](.env.example).

## Database migration
```bash
bun db:generate   # after schema changes (drizzle-kit, commits SQL to packages/db/drizzle)
bun db:migrate    # apply (the compose migrate service runs this automatically)
bun db:seed       # demo project, no API calls
bun admin:create  # interactive admin creation
```

## Running without any API keys

**Run the real pipeline by hand.** Pick *Paste it yourself — no key needed* as the text provider and every step —
analysis, chapter planning, panel prompts, narration — stops at a prompt you copy into any chat you already use.
Paste the reply back and it is checked against exactly the schema a provider's answer is, field by field, before
anything is applied. Artwork works the same way: any panel takes an image you upload. Narration speech is local.
The full walk-through is [WITHOUT_API_KEYS](docs/WITHOUT_API_KEYS.md); every answer's shape is in
[ANSWER_FORMATS](docs/ANSWER_FORMATS.md).

<p align="center">
  <a href="docs/images/paste-answer.webp"><img alt="A job waiting for a pasted answer, with the answer's format explained field by field" src="docs/images/paste-answer.webp" width="760"></a>
</p>

Or just look around first — two ways to see the whole thing before spending anything. **Importing a sample project
is the better one**: it is real generated artwork and narration, not placeholders.

### Import a sample project — real artwork, no key, no spend
`bun db:seed` builds a demo from placeholder art, with no AI calls and no spend. To load a project with real
artwork, import any `zip_package` export — your own, or the
[sample projects](https://github.com/pr0h0/openmanga-samples) (one story as comic pages and as a narrated 16:9
film, browsable unpacked, importable from the release assets):

- In the app: **Projects → Import project**, and upload the ZIP. A GitHub *Download ZIP* works as-is, wrapper
  directory and all, so a project published as a browsable repository imports without repacking. An archive holding
  several projects restores one of them per import and says which it ignored.
- Over HTTP, as a **raw body** — multipart is capped at 64 MB because it has to be buffered whole, while a raw
  body streams to disk. `-T` streams from the file; `--data-binary` would read it all into curl's memory:
  ```bash
  curl -X POST -T project.zip "https://your-instance/api/projects/import?name=project.zip" \
    -H "content-type: application/zip" -H "x-csrf-token: $CSRF" -b cookies.txt
  ```
  The filename comes from `?name=` (or an `x-file-name` header); anything non-multipart is treated as the file
  itself. `IMPORT_MAX_UPLOAD_MB` is the ceiling, and `client_max_body_size` on that nginx route has to match it.
- Or on the server, from a URL or a path:
  ```bash
  docker compose exec api bun db:seed --owner <user> \
    --samples https://github.com/pr0h0/openmanga-samples/releases/latest/download/openmanga-sample-film.zip \
    --sha256 5820a8c2fd34fddfeebf6cd350e6b9a0e2bb16a1810dc7a84d42092e2e08ba9f
  ```
  Repeat `--samples` (and `--sha256`) per project; a local path works too. The SHA-256 is always printed, and
  compared only when you pass `--sha256`. Each package is handed to the same import path the UI uses, so the worker
  must be running.

Importing is also the way to move a project between installs: **Exports → ZIP package** produces exactly this
shape.

### Mock mode — walk the pipeline yourself, with fake output
`AI_MOCK_MODE=true` uses in-process fake providers: story analysis, planning, narration and placeholder images all
work, so you can drive the whole pipeline and the exports for free. Use this when you want to *operate* the app
rather than look at finished work — the samples above are the better way to judge what it produces. It is refused
in production unless `AI_MOCK_ALLOW_IN_PRODUCTION=true`. To exercise the real provider code paths instead, enable
the `mock` compose profile and add an `openai_compatible` credential pointing at `http://mock-ai:4010/v1`.
See [docs/TESTING.md](docs/TESTING.md).

## Kokoro setup
Enabled by the `tts` compose profile. The first start downloads `hexgrad/Kokoro-82M` into the `kokoro-cache` volume (not re-downloaded on restart). `/readyz` reports Kokoro separately; the app stays available while it loads or if TTS is disabled (`TTS_ENABLED=false`). Voices: American/British English plus es, fr, it, pt-br, hi.

## AI providers (bring your own key)
Add keys in **Account → AI providers**. They are encrypted at rest (AES-256-GCM), shown only as `…last4`, usable
only by their owner, and never leave the server. Every generation screen has a provider/model picker, so different
runs can use different providers, and the choice is stored on the job so retries keep it.

### Suggested setups

**Cheapest — Meta Muse**
- Text (analysis, planning, prompts, narration): `muse-spark-1.3-contributor`
- Images (references, panels, covers): `muse-image-1.0` — flat **$0.01 per image**, no input-token billing, so
  references can be sent large (the app does this automatically for flat-rate providers)
- Trade-off: Muse's content filter is the strictest of the supported providers and blocks prompts that others
  accept. The `-contributor` text tier is cheaper because Meta may train on prompts and completions.

**Cheap and reliable — DeepSeek or GPT-5.6 Luna, plus OpenAI images**
- Text: `deepseek-flash` **or** `gpt-5.6-luna` — measured on the same chapter plan: DeepSeek $0.0229 / 90 s,
  Luna $0.0096 / 64 s. Luna is cheaper because it writes ~2.4x fewer output tokens, not because its rate is lower
  (Luna $0.20/$1.20 per 1M vs DeepSeek $0.15/$0.60 off-peak, $0.30/$1.20 peak). DeepSeek returned the richer plan —
  it split the chapter into scenes, planned bubble space on nearly every panel and wrote denser continuity — so
  prefer it for comics; Luna's leaner plans suit film projects, which have no bubbles or dialogue.
- Images: `gpt-image-2` at quality `low` (the default `IMAGE_QUALITY`) — measured **$0.0138–0.0158 per panel**
- Trade-off: costs slightly more per image than Muse, and reference images bill as input tokens, but far fewer
  content-filter refusals.

Text is a small part of the bill either way: a 2-hour narrated story (~1,100 panels, ~46 chapters, ~1.2M text
tokens) costs about **$0.50–1.13** in text against **$11–17** in images.

Measured figures and the controls that keep spend visible: [docs/COSTS.md](docs/COSTS.md). On a 50-project run,
1,226 images for **$14.31**, 14–47 panels per chapter (the planner decides how many).
The in-app cost dashboard reports spend per provider with an images/text split, and each project can set a budget
cap that asks for confirmation before going over.

### All supported providers

| Provider | Text | Images | Narration (TTS) | Notes |
|---|---|---|---|---|
| Meta Muse | `muse-spark-1.3-contributor`, `muse-spark-1.3` | `muse-image-1.0` | — | cheapest; strictest content filter |
| OpenAI | `gpt-5.6-luna`, `gpt-5`, `gpt-5-mini` | `gpt-image-2`, `gpt-image-1-mini` | `gpt-4o-mini-tts`, `tts-1-hd`, `tts-1` | legacy `tts-1*` offer fewer voices |
| DeepSeek | `deepseek-flash`, `deepseek-v4-pro` | — | — | cheap text, JSON mode |
| Google Gemini | `gemini-3.6-flash` | `gemini-3.1-flash-lite-image`, `gemini-2.5-flash-image`, `gemini-3.1-flash-image` | `gemini-2.5-flash-preview-tts`, `gemini-2.5-pro-preview-tts` | per-minute rate limits bite at high concurrency |
| Anthropic | `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` | — | — | good for the vision consistency check |
| OpenRouter | `deepseek/deepseek-chat` | `google/gemini-2.5-flash-image` | — | one key, many models |
| ElevenLabs | — | — | `eleven_multilingual_v2`, `eleven_flash_v2_5`, `eleven_turbo_v2_5` | premium narration voices |
| OpenAI-compatible (custom URL) | any | any | any | must be a public HTTPS endpoint |
| Kokoro (local) | — | — | bundled `Kokoro-82M` | no key, no cost, runs in Docker |

Narration defaults to local Kokoro; pick a cloud voice provider per run if you prefer. Model lists are the
suggestions in the picker — any model id the provider accepts can be typed in.

## Backup
```bash
./scripts/backup.sh            # backups/<timestamp>/{postgres.dump,assets.tar.gz,config,SHA256SUMS}; KEEP=7
```

## Restore
```bash
./scripts/restore.sh backups/<timestamp>        # asks for confirmation; --yes to skip
```

## Common troubleshooting
| Symptom | Fix |
| --- | --- |
| `migrate` exits 1 | `docker compose logs migrate`; usually `DATABASE_URL`/password mismatch with an existing `postgres-data` volume |
| API refuses to start: "AI_MOCK_MODE=true is refused in production" | set `AI_MOCK_MODE=false` or use the `mock` HTTP profile instead |
| Narration says "model is loading" | first Kokoro start is downloading the model; watch `docker compose logs -f kokoro` |
| Login works but session is lost | `COOKIE_SECURE=true` requires HTTPS; use `COOKIE_SECURE=false` for plain-HTTP local access |
| `csrf_failed` from scripts | fetch `/api/auth/me` first and send the `om_csrf` cookie value as `x-csrf-token` |
| Images 404 via `/cdn` | asset trashed or no project access; check `docker compose logs api nginx` |
| Jobs stay queued | `docker compose logs worker`; check Redis health and `outbox` pending count in Admin → Overview |
| Cloudflare 1033 / 530 | tunnel not connected: `docker compose logs cloudflared`; QUIC blocked → keep `CLOUDFLARED_PROTOCOL=http2` |
| Provider failures | Generation → job inspector shows the sanitized reason and provider request id; auth/policy errors are not retried |

## Licence and contributing
Apache-2.0 ([LICENSE](LICENSE), attributions in [NOTICE](NOTICE)). The name and logo are not covered by the code
licence — see [TRADEMARK.md](TRADEMARK.md). Contributions need a `Signed-off-by` line (DCO, no CLA):
[CONTRIBUTING.md](CONTRIBUTING.md), [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Vulnerabilities:
[SECURITY.md](SECURITY.md). Release notes: [CHANGELOG.md](CHANGELOG.md).
