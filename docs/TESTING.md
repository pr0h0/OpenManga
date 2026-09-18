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
`oven/bun:1.4-debian`, joins the `openmanga_internal` network when it exists, and caches installs in the
`openmanga-bun-cache` volume (`OM_ENV_FILE` and `OM_DOCKER_ARGS` are passed through).

## Unit

One `*.test.ts` next to the code it covers. What each package asserts:

| Package | Covered |
| --- | --- |
| `packages/config` | only three env vars are required, no provider keys; production boots with zero keys; mock mode refused in production; `PublicUrlService` same-domain and subdomain URLs |
| `packages/auth` | Argon2id hash/verify/reject, opaque token generation and hashing, registration input normalisation |
| `packages/logger` | secrets redacted by key and by value |
| `packages/storage` | put/read/exists/metadata/delete, `putFile` sha256, path-traversal rejection, key opacity, temp cleanup on failure |
| `packages/image-utils` | derivative sizing and aspect preservation, upscale disabled, deterministic cache key and byte-identical output, MIME sniffing, metadata stripping, crop selection, edit-mask transparency, size-menu selection |
| `packages/schemas` | story/plan/panel-spec/editor validation, graceful enum degradation, narration v2 coverage rules |
| `packages/domain` | layout geometry (≥10 templates, no overlaps, RTL mirroring, split/swap/reading order), bubble geometry and tails, text wrap and bubble placement avoiding faces, narration segmentation and timeline, cost estimation and rate selection by date, permissions and approval transitions, retry classification and the concurrency limiter, content lint and distress grammar, video holds and Ken Burns direction |
| `packages/prompts` | section order and determinism of compiled panel prompts, delimiter isolation (a story cannot close its own tag), unique name+version registry, art-direction binding per planner version, colour-mode and format directives |
| `packages/ai-text` | DeepSeek, Anthropic and Meta providers against fake HTTP: request shape, usage parsing, 429/5xx retry, 401 and policy non-retry, timeout, connection reset, streamed delta assembly; JSON extraction from prose/fences/cut-off responses and the repair call |
| `packages/ai-image` | OpenAI, Gemini, Meta and OpenRouter providers: generation, multipart edits with references, full-res target plus mask ordering, aspect-ratio mapping, safety blocks as non-retryable, invalid image classification, 429 retry-after |
| `packages/audio` | WAV parse/concat with silence, `trimSilenceWav`, Kokoro states, OpenAI/Gemini/ElevenLabs PCM wrapped to 24 kHz mono WAV, voice lists |
| `packages/services` | credential encryption and rotation (round trip, tamper rejection, `SESSION_SECRET`-derived key, dual-key window, legacy v1), custom-endpoint SSRF blocking, model listing, deterministic compositor (page/webtoon/cover), chapter slicing, no server provider fallback without a key |
| `apps/worker` | video scroll capping, Ken Burns direction, even dimensions, SRT cue formatting, focus-aware pan; `ZipWriter` output |
| `apps/web` | editor crop store panning and clamping |

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
./scripts/bunx.sh env TEST_DATABASE_URL=postgres://openmanga:<pw>@postgres:5432/openmanga bun test tests/integration
```

| Spec | Covers |
| --- | --- |
| `flow.test.ts` | auth (register, login by username and email, logout, reset via dev mailbox, CSRF and auth enforcement); the production flow — project + story, analysis → review → apply, reference generation → approval → small derivative, chapter planning, layout swap/duplicate/split/reorder, prompt inspector, panel generation using derivatives, regeneration with activate/revert, masked edit with full-res target and mask, zero-image-call lettering, bulk generation with estimate and progress, narration text → TTS → timeline, video preview shot plan, every export kind, readiness gate, narration languages and pauses, consistency check, BYOK credential encryption/ownership/per-run choice, budget cap with batch pause/resume and queue recovery, cross-user asset authorization, usage accounting, content-policy hardening (lint, stale references, migration guard, preflight), duplicate/search/archive/trash; failure modes (non-retryable provider error, unrepairable vs repairable JSON, content-policy retry budget and the replacement-job pointer) |
| `import.test.ts` | `zip_package` round trip into a new project owned by another user, a ZIP wrapped in one extra directory, `project_json` import with warnings, garbage documents rejected |
| `video.test.ts` | MP4 length matches narration, silent pages held for the minimum duration, film projects plan full-frame 16:9 pages and export Ken Burns video. Skipped unless `ffmpeg` and `ffprobe` are on `PATH` |

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
`referenceDefaults`), planning, panel generation, masked edit, lettering, narration with **real local Kokoro**, all
export kinds, CDN authorization (401 unauthenticated, 200 with a variant, 404 on the raw protected path) and usage
accounting.

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

`./scripts/e2e.sh <baseUrl>` builds `openmanga-e2e:1` from `deploy/docker/e2e.Dockerfile` and runs
`tests/e2e/studio.spec.ts` against a running stack (it joins `openmanga_edge` automatically for
`http://nginx`; `E2E_NETWORK`, `E2E_OUTPUT_DIR`, `E2E_MOUNT` and `E2E_EXTRA_ENV` override the details). One test walks
register → logout → login by username → wizard (analysis, review, apply) → reference generation and approval →
chapter planning → page editor generation and a lettering bubble → every screen renders → generation inspector →
page export completes, and asserts no page or console errors were collected (resource-load, EventSource and CSP noise
is ignored).

## CI

`.github/workflows/ci.yml` on pushes to `main` and pull requests, with `postgres:17-alpine` and `redis:7-alpine`
services: install (`--frozen-lockfile`), `bunx biome ci .`, typecheck both tsconfigs, unit tests, integration tests
(`--timeout 300000`, ffmpeg and DejaVu/Comic Neue fonts installed first), web build, then a build of the app and nginx
images. A second job checks every non-merge commit in a pull request carries a matching `Signed-off-by` line.
E2E and the smoke script are not run in CI.

`.github/workflows/release.yml` builds and pushes `openmanga-app`, `openmanga-nginx` and `openmanga-kokoro` to
`ghcr.io/pr0h0/` on a `v*` tag (linux/amd64 only; arm64 is a self-build — see `docs/REQUIREMENTS.md`).
