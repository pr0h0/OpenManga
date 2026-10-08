# Testing

No test spends money. Unit and integration tests use in-process fakes (`AI_MOCK_MODE=true`, `TTS_PROVIDER=fake`); E2E
and the deployment smoke test either run with the server in mock mode or point a BYOK credential at the `mock-ai`
service, which speaks the real provider wire formats.

| Layer | Command | Needs |
| --- | --- | --- |
| Unit | `bun test packages apps/api apps/worker apps/web` (`bun run test`) | nothing |
| Integration | `bun test tests/integration` (`bun run test:integration`) | Postgres + Redis; ffmpeg for the video specs |
| E2E | `./scripts/e2e.sh http://localhost:3480` | a running stack |
| Deployment smoke | `bun scripts/smoke.ts http://nginx` | a running stack |

Run them inside a container to keep the host clean: `./scripts/bunx.sh <cmd>` mounts the repo into
`oven/bun:1.4-debian` and caches installs in the `openmanga-bun-cache` volume (`OM_ENV_FILE` and `OM_DOCKER_ARGS`
are passed through). It joins a Docker network only when you name one in `OM_NETWORK`, e.g.
`OM_NETWORK=openmanga_internal` to reach the compose stack's `postgres` and `redis`; never point tests at a
production stack's network.

## Unit

One `*.test.ts` next to the code it covers. What each package asserts:

| Package | Covered |
| --- | --- |
| `packages/config` | only three env vars are required, no provider keys; production boots with zero keys; mock mode refused in production; `PublicUrlService` same-domain and subdomain URLs |
| `packages/auth` | Argon2id hash/verify/reject, opaque token generation and hashing, registration input normalisation |
| `packages/logger` | secrets redacted by key and by value |
| `packages/storage` | put/read/exists/metadata/delete, `putFile` sha256, path-traversal rejection, key opacity, temp cleanup on failure; S3: SigV4 multipart signing matches Bun's own presign (with and without a session token), path vs virtual-hosted addressing, public endpoint and response overrides; with `TEST_S3_ENDPOINT` (e.g. a MinIO with an `openmanga-test` bucket) a real round trip and a 70 MB multipart upload |
| `packages/image-utils` | derivative sizing and aspect preservation, upscale disabled, deterministic cache key and byte-identical output, MIME sniffing, metadata stripping, crop selection, edit-mask transparency, size-menu selection |
| `packages/schemas` | story/plan/panel-spec/editor validation, graceful enum degradation, narration v2 coverage rules, partial patches, every paste-mode answer schema documented with a valid example and `docs/ANSWER_FORMATS.md` up to date |
| `packages/domain` | layout geometry (≥10 templates, no overlaps, RTL mirroring, split/swap/reading order), bubble geometry and tails, text wrap and bubble placement avoiding faces, narration segmentation and timeline, cost estimation and rate selection by date, permissions and approval transitions, retry classification and the concurrency limiter, content lint and distress grammar, video holds and Ken Burns direction, the continuous scroll framing (whole-page travel, sized like `width`), YouTube chapter timestamps (`0:00` first, hours only when needed, none for a single chapter), target-runtime budgets per chapter and words per panel within the shot bounds, webtoon strip seams (butt, gap, bleed, dissolve, fade), faces mapped through the panel crop and tails ending at the face, the build label; YouTube link parsing (every URL form, ignored parameters, look-alike hosts refused), the snapshot schedule and the 30-day retention rule, the first-48-hours curve (interpolated, never extrapolated) and reach-report CSV reduction |
| `packages/prompts` | section order and determinism of compiled panel prompts, delimiter isolation (a story cannot close its own tag), unique name+version registry, art-direction binding per planner version, colour-mode and format directives, the built-in experts' prompts |
| `packages/ai-text` | DeepSeek, Anthropic and Meta providers against fake HTTP: request shape, usage parsing, 429/5xx retry, 401 and policy non-retry, timeout, connection reset, streamed delta assembly; JSON extraction from prose/fences/cut-off responses and the repair call; batch chunking, OpenAI and Gemini batch submit/poll, refusals as content-policy failures |
| `packages/ai-image` | OpenAI, Gemini, Meta and OpenRouter providers: generation, multipart edits with references, full-res target plus mask ordering, aspect-ratio mapping, safety blocks as non-retryable, invalid image classification, 429 retry-after; batch chunking under the OpenAI enqueued-token ceiling and reference uploads |
| `packages/audio` | WAV parse/concat with silence, `trimSilenceWav`, Kokoro states, OpenAI/Gemini/ElevenLabs PCM wrapped to 24 kHz mono WAV, voice lists |
| `packages/services` | credential encryption and rotation (round trip, tamper rejection, `SESSION_SECRET`-derived key, dual-key window, legacy v1), custom-endpoint SSRF blocking, model listing, deterministic compositor (page/webtoon/cover), chapter slicing, no server provider fallback without a key; the Google client for YouTube stats against fake HTTP (consent URL, revoked grant / quota / API-not-enabled errors, API key vs bearer, report downloads only from Google's host) |
| `apps/worker` | video scroll capping, Ken Burns direction, even dimensions, SRT cue formatting, focus-aware pan; `ZipWriter` output, a streamed `addStream` entry landing whole, ZIP64 records (forced on small data, and an entry past a sparse 4 GiB offset) read back by fflate and, where installed, `unzip -t` and Python's `zipfile`, and `extractZip` zip-bomb refusal; `PdfWriter` pages, boxes and title read back by pdf-lib, and its memory staying flat over 40 large pages; CBZ `ComicInfo.xml` and fixed-layout EPUB; a streamed EPUB's structure (`mimetype` first, stored, no extra field; container, every manifest item present and every file listed, spine order and page images) and CBZ page order, `unzip -t` where installed, and `writeBook` memory staying flat over 100 large pages |
| `apps/api` | MCP tool catalogue well-formed and `docs/MCP_TOOLS.md` up to date; uploaded non-images and undecodable PNGs rejected |
| `apps/web` | editor crop store panning and clamping, update coalescing, page titles, AI key picker defaults, API client body encoding |

Optional real Kokoro (skipped unless the URL is set):
`KOKORO_SMOKE_URL=http://kokoro:8000 bun test packages/audio`.

## Integration (`tests/integration`)

`tests/integration/harness.ts` boots the real Hono app and real BullMQ workers for every queue, with an
`OutboxDispatcher` polling every 200 ms. Per run it creates a throwaway database (`mf_test_<timestamp>`) from
`TEST_DATABASE_URL`, runs the real Drizzle migrations plus `bootstrapReferenceData()`, flushes `TEST_REDIS_URL`
(default `redis://redis:6379/5`), and points `ASSET_ROOT`/`TEMP_ROOT` at fresh temp directories; teardown drops the
database and removes both directories. Config is fixed to `AI_MOCK_MODE=true`, `TTS_PROVIDER=fake`,
`REGISTRATION_ENABLED=true` (the shipped default is off) and a very high rate limit. Requests go through
`app.request()` in-process via a cookie- and CSRF-jar client, so nothing listens on a port.

```bash
OM_NETWORK=openmanga_internal ./scripts/bunx.sh env TEST_DATABASE_URL=postgres://openmanga:<pw>@postgres:5432/openmanga bun test tests/integration
```

The suite runs against a bucket instead when the environment sets `STORAGE_DRIVER=s3` and the `S3_*` settings (for
MinIO: `S3_ENDPOINT=http://<minio>:9000`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`,
`S3_FORCE_PATH_STYLE=true`); each run uses its database name as `S3_PREFIX`. The test client follows `/cdn`'s redirect
to the signed URL as a browser does, and `flow.test.ts` checks the redirect itself (expiry, content type, cache
lifetime). CI runs the whole suite this way too, in the `integration-s3` job of `.github/workflows/ci.yml`, in
parallel with the local-storage run and after the storage unit tests, against a MinIO container (`pgsty/minio`, a
community build: MinIO itself no longer publishes images).

| Spec | Covers |
| --- | --- |
| `flow.test.ts` | auth (register, login by username and email, logout, reset via dev mailbox, CSRF and auth enforcement); the production flow — project + story, analysis → review → apply, reference generation → approval → small derivative, chapter planning, layout swap/duplicate/split/reorder, prompt inspector, panel generation using derivatives, regeneration with activate/revert, masked edit with full-res target and mask, zero-image-call lettering, bulk generation with estimate and progress, narration text → TTS → timeline, video preview shot plan, exports (page PNG, PDF with a KDP trim size, whole-project PDF, webtoon, page images (chapter-prefixed names), CBZ and EPUB; CBZ, EPUB, webtoon, narration, project JSON, zip and agent packages), readiness gate, narration languages and pauses, consistency check, BYOK credential encryption/ownership/per-run choice, budget cap with batch pause/resume and queue recovery, cross-user asset authorization, usage accounting, check all panels (priced first, one check per panel with art, already-checked panels skipped), the YouTube package text (written, editable) and its export failing without a rendered video, target runtime budgets and a chapter plan taking its page target from them, production presets and project templates seeding new projects, bulk character references under the "main only" reference policy, content-policy hardening (lint, stale references, migration guard, preflight), chapter delete, disk usage, deleting exports and narration audio, deleted images and trashed cast, bulk location references, video thumbnails, reader links (pages and their cached renders, video preview and its scoped media), moving bubbles off faces, duplicate/search/archive/trash; failure modes (non-retryable provider error, unrepairable vs repairable JSON, content-policy retry budget and the replacement-job pointer) |
| `import.test.ts` | `zip_package` round trip into a new project owned by another user, a ZIP wrapped in one extra directory, `project_json` import with warnings, uploads over `IMPORT_MAX_UPLOAD_MB` refused, an archive with two projects, multipart uploads, garbage documents rejected |
| `video.test.ts` | MP4 length matches narration, silent pages held for the minimum duration, a partial render (`maxDurationMs`) in the continuous scroll framing, a whole-project film with chapter timestamps bundled into a `youtube_package` ZIP, a page selection (`pageIds`) rendering shorter than its chapter, film projects plan full-frame 16:9 pages and export Ken Burns video. Skipped unless `ffmpeg` and `ffprobe` are on `PATH` |
| `production.test.ts` | production runs: refused without a budget cap and while another run is active, pausing at each review gate, then running a story through to planned, drawn, narrated and voiced chapters with a thumbnail; a second run skips or finishes every step without spending again. The test advances the run itself (`advanceRun`) instead of waiting for the API's timer |
| `cost-plan.test.ts` | the run cost plan: the analysis and estimated references before anything exists, text free in paste mode, nothing queued by pricing; unplanned chapters estimated from the target runtime with local-voice audio, and a warning past the cap; nothing left after a run, priced from this server's history, and an edited panel counted only by an update; outsiders refused |
| `visual-checks.test.ts` | per-aspect visual checks: only aspects turned on (and judgeable) are asked; flag only, off, regenerate once (one re-roll then flagged), regenerate to a budget (stops at a spent budget and at 3 re-rolls); faces under a bubble flagged and never redrawn |
| `agent.test.ts` | in-app agent: plan first (approve, send back with feedback), a call waiting for approval then continuing, a denied call, an unknown tool and another project's id as errors, the budget and the 25-step limit, cancel, runs private to their starter |
| `series.test.ts` | series: hidden library project, a new episode linked to the whole library sharing its images, library images visible to episode members only, behind and sync, production keeping the linked cast and appearances, adopt by name, split, MCP tools and their project-access rule, detach, delete guard, purge handing shared images over |
| `storage-policy.test.ts` | the storage policy: admins only, expendable files only (art a panel shows, approved art and uploads kept), an approve policy waits through maintenance and deletes on approval (files and disk), the size limit taking the oldest, an over-limit warning nothing can free, audit entries, and turning it off clearing the warning |
| `shot-variety.test.ts` | the shot variety check: a run of four medium eye-level panels found per chapter and reported in health with a link to the storyboard filter, and gone once one panel becomes a close shot |
| `mcp.test.ts` | MCP discovery and auth, tool listing, paste-mode pipeline over MCP, `get_image`, idempotency keys, scopes and project restrictions, approvals, token revocation, OAuth 2.1 (registration, PKCE, refresh rotation, CIMD), expert output actions |
| `batch.test.ts`, `bulk-references.test.ts` | provider batches for panels, text and references: park, poll, ingest at the batch rate, partial failures, no double submit |
| `manual-text.test.ts` | paste mode: prompts, schema rejection, per-scene chapter plans, image questions, the whole text pipeline with no key |
| `experts.test.ts` | built-in and custom experts, project chats, images, paste-mode replies, streaming, output actions (a concept from a chat about no project, premise, outline and YouTube text in a project, a pasted extraction held to its schema) |
| `pronunciation.test.ts` | the pronunciation dictionary changes only the text sent to the voice, re-voices only the segments it affects, and clearing it reuses the cached take |
| `narration-qa.test.ts` | narration QA: rule findings stored and an ignored one kept ignored, the AI check, a fix of only the flagged lines shown before applying, re-voicing only the changed segments, the re-check comparison, density from real audio, the audio check (a loudness report, a silent take found, a new take skipping the cached one), and the paste-mode lint and fix |
| `story-coverage.test.ts` | story coverage: refused before an applied analysis, paragraphs left out and told twice with their source spans and chapters, chapter shares, and the paste-mode questions held to every paragraph of their part |
| `recovery.test.ts`, `tts-race.test.ts` | job redelivery, the stalled-job sweep, a dead batch submitter, permanent project deletion, a segment deleted while voiced |
| `continuity.test.ts`, `outfits.test.ts`, `letter-from-plan.test.ts`, `upload-art.test.ts`, `vertical.test.ts`, `vision.test.ts` | scene continuity, outfits over a chapter, lettering from the plan, uploaded artwork, vertical strips, image descriptions and character versions |
| `layers.test.ts` | layered exports: PSDs read back with an independent reader (groups, names, hidden guide, bounds, pixels), and the separated-layers ZIP (each file matches its manifest placement, SVG lettering, text-free page) |
| `panel-shapes.test.ts` | panel shapes: polygon outlines saved through the page document and read back, the page rendered with them, fewer than three points refused |
| `youtube.test.ts` | YouTube stats under the fake Google: connecting through the fake consent screen (tokens encrypted, reach reporting jobs created, a reconnect replacing tokens), a consent state single-use and bound to its account, a denied consent, uploads paged and owner-only; linking from uploads and pasted links across channels (kind detection, the Short or export it came from, duplicates and bad links refused); project totals, film against Shorts, per channel and the first-48-hours curve; the reach backfill keeping only linked videos' rows; history from Analytics with splits and reach for a connected video and from snapshots otherwise; other users seeing nothing and a pasted link to someone else's channel getting no analytics; the snapshot schedule (hourly for 48 hours, then daily only when not connected); retention (unauthorized after 30 days, unlinked, unverified for 30 days); a grant revoked at Google; the MCP tool under `stats:read`; disconnecting; channel tokens through key rotation |
| `print.test.ts` | the print workflow: a PDF interior with a contents page, blank versos and book metadata; the preflight report over the same pages and the CMYK soft proof; the cover check and the rendered wraparound cover |

## Mock scenarios

`apps/mock-ai/src/server.ts` serves `POST /chat/completions` and `/v1/chat/completions` (OpenAI-compatible chat, used
for every text provider), `POST /v1/images/generations`, `POST /v1/images/edits`, `GET /health`, plus
`POST /__mock/scenario` and `POST /__mock/reset`. Point a credential of kind `openai_compatible` at
`http://mock-ai:4010/v1` to exercise the real provider code with no key.

Two ways to trigger a failure — a queued scenario wins over a marker in the text:

```bash
curl -X POST http://mock-ai:4010/__mock/scenario \
  -d '{"target":"image","scenario":"429","times":2}'   # target: text | image | any (default any), times default 1
```

…or put `[[mock:<scenario>]]` in a story or prompt. Scenarios (`packages/testing/src/mock-media.ts`):
`429 500 502 503 timeout reset auth quota policy invalid-json fenced-json schema-invalid repairable bad-image slow`.
`policy` affects image requests only; `repairable` returns a bad document and then echoes the good one to the
`json-repair` call; `slow` and `timeout` only delay.

## Deployment smoke (`scripts/smoke.ts`)

Runs through nginx (or the public domain) against a deployed stack: routing and SPA fallback, `/healthz`, `/readyz`,
auth, project + story, analysis, SSE, reference generation and derivative size (checked against `/api/meta`
`referenceDefaults`), planning, panel generation, masked edit, lettering, narration with **real local Kokoro**,
exports (page PNG, webtoon, PDF, narration audio, zip package), CDN authorization (401 unauthenticated, 200 with a
variant, 404 on the raw protected path) and usage accounting.

```bash
docker run --rm --network openmanga_edge -v "$PWD":/repo -w /repo oven/bun:1.4-debian bun scripts/smoke.ts http://nginx
```

Because there are no server provider keys, the AI steps need a source: either the server runs with `AI_MOCK_MODE=true`,
or you pass `SMOKE_API_KEY` (with `SMOKE_PROVIDER`, default `openai`, and optionally `SMOKE_PROVIDER_BASE_URL`) and the
script saves it as a credential first. Without either, the AI steps are skipped rather than failed and the routing,
auth, SSE and usage steps still run. `SMOKE_USER`/`SMOKE_PASSWORD` log into an existing account instead of registering.
`SMOKE_MOCK_AI_URL` adds the failure block (429 and 503 retried to completion, auth fast-fail, malformed/fenced/
repairable JSON, content-policy non-retry, bad image, job cancellation, unknown Kokoro voice). Exit code is non-zero on
any failure.

## E2E (Playwright)

`./scripts/e2e.sh <baseUrl> [playwright args]` builds `openmanga-e2e:1` from `deploy/docker/e2e.Dockerfile` and runs
every spec in `tests/e2e` against a running stack (it joins `openmanga_edge` automatically for `http://nginx`;
`E2E_NETWORK`, `E2E_OUTPUT_DIR`, `E2E_MOUNT` and `E2E_EXTRA_ENV` override the details). Extra arguments go to
Playwright: `./scripts/e2e.sh http://nginx story.spec.ts -g "story bible"` runs one test. `E2E_HTML_REPORT=<dir>`
(passed through `E2E_EXTRA_ENV`) also writes Playwright's HTML report. Every test fails on page or console errors
(resource-load, EventSource and CSP noise is ignored).

| Spec | Covers |
| --- | --- |
| `studio.spec.ts` | register → logout → login by username → wizard (analysis, review, apply) → reference generation and approval → chapter planning → page editor generation and a lettering bubble → every screen renders → generation inspector → page export completes → print preflight report with its soft proof → layered PSD export |
| `storage.spec.ts` | as the e2e administrator: an approve-mode storage policy with a size limit below what is stored puts an undismissable warning on every page; *Review* opens Admin → Storage; turning the policy off clears it |
| `story.spec.ts` | story bible (a fixed rule and a character state added, filters, *Extract from story* with one proposed entry applied, a continuity check finding a contradiction, the rule checks listing each rule's verdict); story coverage run from the Story page; narration QA (rule checks, the AI check, *Fix selected* shown as a diff and applied, the Density tab); the Timing page's shots and lengths with a hold fix applied; a pronunciation entry marking the affected narration audio outdated |
| `video.spec.ts` | Repurpose (suggested plan, a carousel pick adjusted, titles and captions written, the carousel ZIP rendered and complete on Exports); the 9:16 Shorts suggestion; a shot's camera move and *leave out*; a layout guide drawn, saved and its pose typed; a video intro card; a reader link's chapter played as a video preview |
| `production.spec.ts` | *Produce* with review gates and the render off, finishing completed or completed with warnings (with the unresolved list), the Health verdict; *Update production* after a revised story pausing at the analysis review, then at the changed chapters, where *Keep current* clears it; *Stop* with "cancel its queued jobs" cancelling the run's waiting job |
| `youtube.spec.ts` | under mock mode: a channel connected through the fake Google consent screen, a video linked from its uploads and another pasted, the totals and first-48-hours curve, a connected video's Analytics chart with a metric switch and its traffic sources, a video unlinked |
| `collab.spec.ts` | a member invited by username who accepts in a second browser context and sees the project marked Shared; a panel comment mentioning them that reaches their notification bell; a channel profile (voice, pronunciation, intro card) picked by the new-project wizard, shown as "From profile", and *Re-apply profile* showing the changed voice; an expert reply turned into a new project; a comment posted and resolved through an agent connection, marked "MCP · <connection>" for its owner and only "MCP" for another member, next to a reply marked "by hand"; a pinned thread on generated artwork assigned to the member, who is notified; a guest comment through a reader link that allows comments, reaching the owner's bell |

`tests/e2e/helpers.ts` holds the shared pieces: `watchErrors`, an `api(page)` client that calls the REST API with the
page's session and CSRF cookie, `signUp`, and the seeds. Each spec file signs up its own user(s) in `beforeAll` and
shares one project across its tests: `seedProducedProject` runs a production run through the API (analysed, drawn,
narrated and voiced; about a minute, as the API advances runs on a 10 s timer) and `seedPlannedProject` analyses and
plans a chapter (seconds). Setup goes through the API; what a test is about goes through the UI. A failing test
restarts the worker, which seeds again for the rest of its file. Registration is limited to 10 per hour per address,
and a clean run signs up seven users: repeated local runs against one stack need that counter cleared (a fresh stack,
or `redis-cli --scan --pattern 'om:rl:register:*' | xargs redis-cli del` in its Redis). The whole suite takes about
five minutes once the stack is up.

The stack it runs against needs mock AI and plain-HTTP cookies: `AI_MOCK_MODE=true`, `AI_MOCK_ALLOW_IN_PRODUCTION=true`
(compose runs `NODE_ENV=production`), `TTS_PROVIDER=fake`, `REGISTRATION_ENABLED=true` and `COOKIE_SECURE=false`.
`docker-compose.yml` pins its network names (`openmanga_internal`, `openmanga_edge`), so do not start a second copy
next to a running install: its `postgres`, `redis` and `worker` would share the install's networks and DNS names,
and its worker could take the install's queued jobs.

### E2E locally without compose

On a host that runs an install, start a throwaway stack with plain `docker run` on a private network instead, with
each container's compose service name as its network alias so the app finds `postgres`, `redis` and `nginx`:

```bash
ID=$(date +%s); NET=om-e2e-$ID
docker build -t openmanga-app:e2e-$ID -f deploy/docker/app.Dockerfile .
docker build -t openmanga-nginx:e2e-$ID -f deploy/docker/nginx.Dockerfile .
docker network create $NET
ENV="-e NODE_ENV=production -e DATABASE_URL=postgres://openmanga:pw@postgres:5432/openmanga -e REDIS_URL=redis://redis:6379
 -e SESSION_SECRET=e2e-session-secret-for-a-throwaway-stack-0123 -e COOKIE_SECURE=false -e AI_MOCK_MODE=true
 -e AI_MOCK_ALLOW_IN_PRODUCTION=true -e TTS_PROVIDER=fake -e REGISTRATION_ENABLED=true -e ASSET_ROOT=/data/assets
 -e TEMP_ROOT=/data/tmp -e APP_PUBLIC_URL=http://nginx/app -e API_PUBLIC_URL=http://nginx/api -e CDN_PUBLIC_URL=http://nginx/cdn"
VOLS="-v om-e2e-$ID-assets:/data/assets -v om-e2e-$ID-tmp:/data/tmp"
docker run -d --name om-e2e-$ID-postgres --network $NET --network-alias postgres \
  -e POSTGRES_USER=openmanga -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=openmanga postgres:17-alpine
docker run -d --name om-e2e-$ID-redis --network $NET --network-alias redis redis:7-alpine
until docker exec om-e2e-$ID-postgres pg_isready -U openmanga -d openmanga; do sleep 1; done
docker run --rm --network $NET $ENV $VOLS openmanga-app:e2e-$ID bun apps/api/src/cli/bootstrap.ts
docker run -d --name om-e2e-$ID-api --network $NET --network-alias api $ENV $VOLS openmanga-app:e2e-$ID bun apps/api/src/server.ts
docker run -d --name om-e2e-$ID-worker --network $NET --network-alias worker $ENV $VOLS openmanga-app:e2e-$ID bun apps/worker/src/main.ts
docker run -d --name om-e2e-$ID-nginx --network $NET --network-alias nginx -e ASSET_CSP_ORIGIN= \
  -v om-e2e-$ID-assets:/data/assets:ro openmanga-nginx:e2e-$ID
until docker exec om-e2e-$ID-nginx wget -qO- http://127.0.0.1/readyz >/dev/null; do sleep 2; done

E2E_NETWORK=$NET ./scripts/e2e.sh http://nginx

docker rm -f om-e2e-$ID-postgres om-e2e-$ID-redis om-e2e-$ID-api om-e2e-$ID-worker om-e2e-$ID-nginx
docker volume rm om-e2e-$ID-assets om-e2e-$ID-tmp; docker network rm $NET
docker rmi openmanga-app:e2e-$ID openmanga-nginx:e2e-$ID
```

The spec files import `@playwright/test` from the repo's `node_modules`, which the Playwright container mounts: run
`bun install` first.

### E2E in CI

`.github/workflows/e2e.yml` runs nightly (03:17 UTC, against `staging`), on pull requests that touch the test or how
it runs (`tests/e2e/`, `scripts/e2e.sh`, the e2e Dockerfile, the workflow), and on demand: **Actions → E2E → Run
workflow**, or `gh workflow run e2e.yml --ref <branch>`. GitHub offers the manual run and the nightly schedule only
once the workflow is on the default branch (`master`). It builds the images, starts the stack with the settings
above (`docker compose up -d --build --wait`), runs `./scripts/e2e.sh http://nginx`, and always tears the stack
down. When it fails it uploads `playwright-<run id>`, which holds the HTML
report, the trace and screenshots (`npx playwright show-trace trace.zip`), and `compose.log` with every service's
log. A run takes about seven minutes, a little over one building and starting the stack and about five of tests, so
other pull requests skip it.

## CI

`.github/workflows/ci.yml` on pushes to `main`, `master` and `staging` and on pull requests, with `postgres:17-alpine`
and `redis:7-alpine` services: install (`--frozen-lockfile`), `bunx biome ci .`, typecheck both tsconfigs, unit tests,
integration tests (`--timeout 300000`, ffmpeg and DejaVu/Comic Neue fonts installed first), web build, then a build of
the app and nginx images. A second job checks every non-merge commit in a pull request carries a matching
`Signed-off-by` line (bot commits are exempt, and so are GitHub's own squash commits in a `staging` → `master` release
pull request). The smoke script is not run in CI; E2E runs in its own workflow (above).

`.github/workflows/release.yml` builds and pushes `openmanga-app`, `openmanga-nginx` and `openmanga-kokoro` to
`ghcr.io/pr0h0/` on a `v*` tag, or by hand for an existing tag (linux/amd64 only; arm64 is a self-build — see
`docs/REQUIREMENTS.md`).
