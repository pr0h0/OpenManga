# Deployment

Target: one Linux VPS, Docker Compose, nginx as the only public entrypoint. The compose project is named `openmanga`,
so the networks are `openmanga_internal` and `openmanga_edge` and the locally built images are `openmanga-app:1`,
`openmanga-nginx:1` and `openmanga-kokoro:1`.

Tagged releases are also published to GHCR as `ghcr.io/pr0h0/openmanga-app`, `-nginx` and `-kokoro` (linux/amd64).
Building locally is the default and always works; to run a published image instead, pin its tag with a compose
override as shown in the README. Either way the `image:` names in `docker-compose.yml` stay as they are.

## First deploy

```bash
cp .env.example .env            # set POSTGRES_PASSWORD, SESSION_SECRET, the three public URLs, COOKIE_SECURE
docker compose up -d --build    # migrate runs first; api, worker and nginx wait for it
curl -fsS http://127.0.0.1:3480/readyz
```

`.env.example` marks exactly which variables are required; everything below that block has a working default. Only the
variables listed in the `x-app-env` block of `docker-compose.yml` are forwarded into the containers, so a setting the
config schema accepts but compose does not pass needs adding there before putting it in `.env`. Every setting in
the config schema is forwarded today except `API_PORT`, which is fixed inside the container. (`KOKORO_WORKERS` and
`KOKORO_THREADS` go to the kokoro service instead.) The
`migrate` service (`apps/api/src/cli/bootstrap.ts`) applies migrations, syncs prompt templates, style presets and
provider rate snapshots, re-encrypts stored provider keys onto the current key, and creates the initial admin if the
`INITIAL_ADMIN_*` variables are set.

**Registration is closed by default** (`REGISTRATION_ENABLED=false`). Create the first account either with the
`INITIAL_ADMIN_*` variables above or interactively:

```bash
docker compose run --rm migrate bun apps/api/src/cli/admin-create.ts   # or add --username … --email … --password …
```

Then open `http://127.0.0.1:3480/app/` (or your domain). nginx binds `NGINX_BIND:NGINX_PORT`, default
`127.0.0.1:3480`, so nothing is exposed beyond loopback until you put a tunnel or reverse proxy in front of it.

Profiles (set `COMPOSE_PROFILES` in `.env`):

| Profile | Service | Notes |
| --- | --- | --- |
| `tts` | `kokoro` | Local narration voices. The `kokoro-cache` volume holds the model; the first start downloads it once. |
| `mock` | `mock-ai` | HTTP mock of the OpenAI-compatible chat and images APIs, for zero-cost testing of the real provider code. |
| `tunnel` | `cloudflared` | Public hostname without opening a port (see below). |

## Routing

| Path | Target |
| --- | --- |
| `/` | 302 → `/app/` |
| `/app/*` | SPA (Vite build, `base=/app/`, fallback to `index.html`, immutable hashed assets, strict CSP) |
| `/api/*` | API, 120 s timeouts, `client_max_body_size 20m` |
| `/api/projects/import` | same, but `client_max_body_size 4096m` for ZIP imports (see Import limits) |
| `/api/projects/<id>/events`, `/api/expert-chats/<id>/stream` | SSE: buffering, caching and gzip off, 1 h read timeout |
| `/api/auth/login`, `/register`, `/password-reset/request` | same as `/api/*`, plus an nginx burst limit (see below) |
| `/api/public/*` | reader-link API (`/api/public/shares/<token>`), no sign-in; the SPA's reader is `/app/read/<token>` |
| `/mcp` | MCP endpoint for AI agents: unbuffered (replies can upgrade to SSE), 300 s read timeout, 8 MB body (`docs/MCP.md`) |
| `/oauth/*`, `/.well-known/oauth-*` | the MCP's OAuth authorization server and discovery documents, 64 KB body |
| `/cdn/*` | API authorization → `X-Accel-Redirect` → the internal `/_protected_assets/` location; with `STORAGE_DRIVER=s3`, a 302 to a short-lived signed bucket URL instead |
| `/healthz`, `/readyz` | API health and readiness (`/readyz` checks Postgres and Redis; Kokoro is reported as optional and never fails readiness) |

Security headers (CSP, nosniff, frame options, referrer policy, permissions policy, HSTS) are set by nginx;
`absolute_redirect off` keeps redirects scheme-correct behind a TLS proxy. nginx trusts `CF-Connecting-IP` for the
client address, which is what the API's rate limiters key on.

## Using real providers (BYOK)

There are no server-level provider keys and no provider switch to configure. Sign in and add a key per user in
Account → AI providers; it is verified by listing models and encrypted at rest. On the server side the only thing to
do is leave mock mode: set `AI_MOCK_MODE=false` (the default) and drop `mock` from `COMPOSE_PROFILES`, then
`docker compose up -d`.

Verify with the smoke test — it spends a few cents when you give it a real key:

```bash
docker run --rm --network openmanga_edge -v "$PWD":/repo -w /repo oven/bun:1.4-debian \
  env SMOKE_API_KEY=… SMOKE_PROVIDER=openai bun scripts/smoke.ts https://your-domain
```

Then check Cost → providers. `docs/TESTING.md` documents the other smoke-test options.

### Server budget ceiling

Each project has its own budget cap, which its owner can raise. On a shared install, hold the whole server to a
monthly figure as well: **Admin → Usage → Server budget** sets a ceiling in USD per calendar month (UTC) and shows
this month's spend against it. `INSTANCE_BUDGET_USD_MONTHLY` sets the default (empty for none). A value saved in
Admin overrides it, and **Use default** goes back to it. Once the ceiling is reached, new AI work is refused with
402 `instance_budget_exceeded`, queued batches pause, and production runs pause, until an admin raises it or the
month turns. Users cannot confirm past it. See [COSTS](COSTS.md#keeping-spend-visible).

## Future subdomains

Set `APP_PUBLIC_URL`, `API_PUBLIC_URL` and `CDN_PUBLIC_URL` to separate hosts and add nginx server blocks; every URL
the app emits comes from `PublicUrlService`, so nothing concatenates hostnames by hand. Cookie domain and CORS would
need to be added at that point.

## Public hostname behind a Cloudflare tunnel

```bash
cloudflared tunnel create openmanga
# Use an empty config so a host-wide ~/.cloudflared/config.yml cannot redirect the DNS route to another tunnel:
cloudflared --config /dev/null tunnel route dns <TUNNEL_ID> manga.example.com
cp deploy/cloudflared/config.example.yml deploy/cloudflared/config.yml   # set tunnel id + hostname
# .env: COMPOSE_PROFILES=...,tunnel
#       CLOUDFLARED_CREDENTIALS=~/.cloudflared/<TUNNEL_ID>.json
#       CLOUDFLARED_UID=$(id -u)
docker compose up -d cloudflared
```

The container runs on the `edge` network next to nginx and uses the HTTP/2 transport
(`CLOUDFLARED_PROTOCOL`, default `http2`), because QUIC/UDP is frequently blocked from Docker bridge networks. It does
not touch other tunnels on the host.

### Who is allowed to declare the client IP

Rate limiting and the login lockout key on the client address, so it matters where that address comes from. nginx
uses `real_ip` (`deploy/nginx/nginx.conf`): a `CF-Connecting-IP` header is honoured **only** when the request
arrives from a private address — the tunnel or a reverse proxy beside it — and is ignored when it arrives straight
off the internet. The app reads nothing but the `X-Real-IP` that nginx sets itself.

Two consequences worth knowing:

- **Do not publish nginx directly on a public interface** (`NGINX_BIND=0.0.0.0`) without a proxy in front. Docker's
  port forwarding can make an external client appear to come from the bridge network, which is inside the trusted
  range, and then a client-supplied header would be believed again. Keep the default loopback bind and put the
  tunnel (or your own TLS terminator) in front.
- Behind a proxy that does not send `CF-Connecting-IP`, every request looks like it comes from that proxy, so
  per-IP limits apply to all users together. The login lockout also counts per account, independent of address, so
  password guessing stays bounded either way, and nginx applies its own burst limit on the login, register and
  password-reset endpoints that does not depend on Redis being up.

### Import limits

`IMPORT_MAX_UPLOAD_MB` (default 4096) and `client_max_body_size` on the `/api/projects/import` location in
`deploy/nginx/default.conf` are **a pair** — nginx rejects the upload first, so a mismatch shows up as a 413 with
no explanation. Change both. `IMPORT_MAX_ENTRY_MB` and `IMPORT_MAX_COMPRESSION_RATIO` bound a single entry and the
zip-bomb ratio; packages are streamed to disk, so these bound disk and time rather than memory.

## Updates

```bash
git pull && GIT_SHA=$(git rev-parse --short HEAD) docker compose build && docker compose up -d   # migrations apply automatically
```

**Which build is running.** Every image stamps itself when it is built, and the app header shows the server's
build as `v0.10.0.20260928121530` — the release version, then the UTC build time to the second. The version alone
cannot tell deploys apart, since master is deployed many times under one number between releases; the build time
orders them and can be matched against `git log` to see which commits are live. Hover it for the commit and for the
web bundle's own stamp. The two images build one after the other, so their times always differ by a few seconds —
compare the **commit** instead: if the web bundle's commit is not the server's, the tab is running an older bundle
and needs a reload.
`GET /api/meta` returns the same as `build`.

`GIT_SHA` is optional — the build context has no `.git`, so the commit only appears if the build is told it. The
stamp re-runs whenever the code changes, so rebuilding an unchanged tree keeps its time rather than claiming to be
new. A checkout run outside Docker reports `v0.10.0-dev`.

The worker has `stop_grace_period: 6m` so an in-flight image request (up to `AI_IMAGE_TIMEOUT_MS`) finishes instead of
being killed after the user has already paid for it.

## Persistence

Named volumes: `postgres-data`, `redis-data` (AOF, `maxmemory-policy noeviction`), `assets-data`, `tmp-data`,
`kokoro-cache`. With `STORAGE_DRIVER=s3`, `assets-data` stays empty and the files live in the bucket; `tmp-data` is
still needed (imports, export and render work files). `docker compose down` keeps them — never use `-v` in production. Restart policy `unless-stopped`;
health checks on postgres, redis, api, nginx, kokoro and the worker.

## Backups

`scripts/backup.sh` writes a timestamped directory under `backups/`: a `pg_dump -Fc` custom dump, a tarball of the
asset volume, the compose and deploy configuration, a mode-600 copy of `.env`, and `SHA256SUMS`. Retention is
`KEEP=7` directories. Schedule it with cron and copy `backups/` off the server:

```
0 3 * * * cd /srv/openmanga && ./scripts/backup.sh >> backups/backup.log 2>&1
```

`scripts/restore.sh <dir> [--yes]` verifies the checksums, stops the app services, recreates the database, restores
the assets, flushes Redis and restarts. With `STORAGE_DRIVER=s3` neither script touches the bucket: back it up and
restore it with the bucket's own tools ([STORAGE.md](STORAGE.md#backups-with-s3)). The procedure was verified by backing up, deleting data and files, and
restoring. Redis being flushed is safe: the worker re-publishes still-queued jobs from the database within a minute of
starting.

## S3-compatible storage

Assets can live in a bucket instead of the `assets-data` volume: set `STORAGE_DRIVER=s3`, the `S3_*` settings and
`ASSET_CSP_ORIGIN` (the bucket origin browsers load from, which nginx adds to the app's CSP) in `.env`, then
`docker compose up -d`. `/cdn` then answers with a redirect to a URL signed for `S3_PRESIGN_EXPIRES_SECONDS` (900),
large files are uploaded in parts, and nothing else changes. The settings, the copy recipe for an existing install
and what backups cover are in [STORAGE.md](STORAGE.md#assetstorage). A MinIO next to the stack works: put it on the
`internal` network, set `S3_ENDPOINT=http://minio:9000`, `S3_FORCE_PATH_STYLE=true` and `S3_PUBLIC_ENDPOINT` to the
address browsers reach it at.

## Rotating the provider-key encryption key

Users' own provider keys are AES-256-GCM encrypted and each value records the id of the key that encrypted it
(`v2.<keyId>.…`), so several keys can be active at once (`docs/SECURITY.md`).

1. Generate a new key: `openssl rand -hex 32`.
2. In `.env`, put the new key in `CREDENTIALS_ENCRYPTION_KEY` and append the previous one to
   `CREDENTIALS_ENCRYPTION_OLD_KEYS` (comma-separated). If no dedicated key was set before, nothing needs to move: the
   key derived from `SESSION_SECRET` is always accepted for decryption.
3. `docker compose up -d` — api, worker and migrate all load both keys. The migrate container re-encrypts every saved
   key onto the new one at startup; the worker's hourly maintenance run and **Admin → Overview → Re-encrypt now** do
   the same. While this runs, reads work for rows on either key and writes always use the new key. Rows are swapped
   with compare-and-set, so a user saving or deleting a key at the same moment is never overwritten.
4. When Admin shows **Pending rotation: none**, remove the old key from `CREDENTIALS_ENCRYPTION_OLD_KEYS` and restart.

Losing every key that can decrypt a row makes that saved key unreadable and the user has to add it again. Back up
`.env` together with the database.

## Throughput

- **Kokoro TTS** runs `KOKORO_WORKERS` uvicorn processes (default 4), each with its own model, and
  `OMP_NUM_THREADS=KOKORO_THREADS` (default 2). Keep workers × threads ≤ CPU cores and `TTS_WORKER_CONCURRENCY` equal
  to `KOKORO_WORKERS` — more worker concurrency than Kokoro processes only queues at Kokoro. Changing these needs
  `docker compose up -d kokoro worker` (rebuild the kokoro image once for the new CMD).
- **Image and text work**: `IMAGE_WORKER_CONCURRENCY` (24) suits a provider allowing ~150 image requests per minute at
  ~15 s each; `IMAGE_EDIT_WORKER_CONCURRENCY` (6), `TEXT_WORKER_CONCURRENCY` (4) and `EXPORT_WORKER_CONCURRENCY` (1)
  are the rest. Per-provider request concurrency is capped separately by `AI_IMAGE_MAX_CONCURRENCY` and
  `AI_TEXT_MAX_CONCURRENCY`.
- **Video export** renders and encodes `VIDEO_ENCODE_CONCURRENCY` clips at once (default 4, roughly one core each at
  `veryfast`); narration audio is still assembled in page order. Video renders and project imports run on their own
  `render` queue (`RENDER_WORKER_CONCURRENCY`, default 1), so a long render never holds up a PDF or a ZIP on the
  `export` queue (`EXPORT_WORKER_CONCURRENCY`, default 1). Each render already uses `VIDEO_ENCODE_CONCURRENCY` cores,
  so raise `RENDER_WORKER_CONCURRENCY` only with cores to spare.
- **Polling jobs**: `GET /api/jobs/:id` returns `{ type, job }` for any generation, audio, export or import job the
  caller can read (exports include their files). `POST /api/projects/:id/exports` returns the export *job*, not a
  file.

### Dedicated render worker

One worker container consumes every queue by default. To give video renders their own container (more memory or
CPU, or a separate host with the same volumes and network), split the queues with `WORKER_QUEUES`:

1. Uncomment the `worker-render` service in `docker-compose.yml`. It runs the same image with `WORKER_QUEUES: render`.
2. In `.env`, set `WORKER_QUEUES` for the main worker to every other queue:
   `WORKER_QUEUES=text-ai,image-generation,image-edit,asset-processing,tts,export,maintenance,image-batch`.
   Leaving it empty also works, but then the main worker keeps taking renders too.
3. `docker compose up -d worker worker-render`.

Both containers need the `assets-data` and `tmp-data` volumes: imports read their upload from `tmp-data`. Every
worker runs the outbox publisher and the Redis reconcile loop, which are safe to run twice. An unknown name in
`WORKER_QUEUES` stops the worker at start, and the worker logs the queues it consumes. The Queues table in Admin shows the
`render` queue's counts next to the others.

**Upgrading from a release without the `render` queue.** Renders and imports queued before the upgrade stay on the
`export` queue and still run there: the `export` worker takes any export kind, and reconcile, cancel and the stalled
sweep look on both queues. They need a worker that consumes `export`, which the main worker does in both setups above.
Nothing needs to be moved by hand.

## GPU Kokoro (later)

Add a compose override with `deploy.resources.reservations.devices` for the kokoro service, install CUDA torch in
`services/kokoro`, and set `KOKORO_DEVICE=cuda` (it is `cpu` in `docker-compose.yml` today).

## Health and recovery

- Every long-running service has a health check. The worker writes `/tmp/worker-heartbeat` (inside its own container) every 30 s and is
  unhealthy after 2 minutes without it.
- The hourly `maintenance` job fails jobs that have not written to their row for `STALLED_JOB_TIMEOUT_MINUTES`
  (120) and that no worker still holds, fails batched panels whose submitter died, and prunes expired sessions,
  reset tokens, unused derivatives, expired exports, trashed assets, old temp files and published outbox rows
  (`docs/STORAGE.md`).
- **Production runs** are advanced by the API process, not the worker: it checks every `running` run every 10 s, so
  a run resumes by itself after an API restart. The guard against two passes on one run is in memory, so run a single
  `api` replica.

## Exports: readiness, video, import

All exports are deterministic compositions — no AI calls — and are queued: `POST /api/projects/:id/exports` returns
`202 { job }`, and the files appear on the job once it completes.

- **Readiness check first** (`GET /api/projects/:id/readiness`): panels without artwork, chapters without narration or
  under 90% panel coverage, segments without audio, and panels pinned to superseded versions are blocking issues —
  the export returns 409 `export_not_ready` until the caller confirms with `acknowledgeIssues: true` ("export
  anyway"); draft versions are informational. The same issues are written into agent packages. The endpoint also
  reports whether the caller has a usable provider key for further generation.
- **Kinds**: `png_pages`, `jpg_pages`, `pdf`, `cbz`, `epub`, `webtoon`, `zip_package`, `project_json`,
  `narration_audio`, `timeline`, `agent_package`, `video_pages`, `video_panels`, `youtube_package`. `pdf.pageSize`
  takes `source`, A4, A5, B5, letter, tankobon, or an Amazon KDP trim size (`kdp_5x8`, `kdp_5_5x8_5`, `kdp_6x9`,
  `kdp_7x10`, `kdp_8_5x11`), which prints full bleed with the trim box set. `cbz` carries a `ComicInfo.xml`; `epub` is
  fixed-layout with the cover.
  Narration audio and timeline need a chapter (or page ids). Every page-based kind (page images, PDF, CBZ, EPUB,
  webtoon) also takes the whole project (no `chapterId`), every chapter in order: they all stream to disk, so a long
  project costs no more memory than one chapter. Page images spanning chapters are named
  `<title>_project_ch02_p003.png`, since page numbers restart in every chapter. A whole-project webtoon without
  `split` is still one image, capped at 200 MP like any strip, so leave splitting on for a long project.
  `youtube_package` makes no video of its own: it zips the newest full finished video of the same scope (chapter or whole
  project) with its subtitles and chapter timestamps, the thumbnail and the publishing text written by
  `POST /api/projects/:id/youtube-package`, and fails until both exist (`docs/STORAGE.md` lists the files).
- **Memory**: every output is written to a file in the job's temp directory as it is built. A PDF, CBZ or EPUB holds
  one page at a time (the EPUB's manifest and spine are written last, from page sizes alone), a webtoon strip one
  chunk (`maxChunkHeight`), a ZIP one entry (a video goes in chunk by chunk), so memory does not grow with project
  length. ZIPs switch to ZIP64 records past 4 GiB or 65,535 entries; smaller archives stay plain ZIP. A package over
  4 GiB is written, but importing one back is limited by `IMPORT_MAX_UPLOAD_MB`.
- **Deleting**: `DELETE /api/exports/:id` or `DELETE /api/projects/:id/exports` removes finished exports and their
  files from disk at once (no trash); running exports are kept.
- **Video export (panel cut)** `video_panels`: one clip per panel in reading order, clean artwork cropped exactly as
  on the page (frame aspect plus image focus) fitted inside the 16:9 frame over a blurred copy, Ken Burns `zoom`
  (default 6%) — wide, full and medium shots push in, close, extreme-close and insert pull out — supersampled 3×
  before `zoompan`. Lines attached only to a page play over its first panel. Hard cuts, the same audio assembly,
  loudness normalisation and duration verification as the page cut, and an `.srt` of the narration segments next to
  the MP4 (both cuts), plus a `.chapters.txt` of YouTube chapter timestamps when the film spans more than one
  chapter.
- **Video export (page cut)** `video_pages`: an MP4 per chapter — or the whole project in chapter order when `chapterId`
  is omitted, or only the given `pageIds` (either cut) — per language, following `docs/VIDEO_EXPORT_REFERENCE.md`: pages
  at `video.pageWidthRatio` (0.6) of the frame width with capped scroll, minimum hold (`minHoldMs`, 2500 ms),
  frame-exact clips, two-pass loudness normalisation over the whole file and a duration check against the narration.
  `video.framing` `height` shows the whole page instead, and `scroll` travels the whole page top to bottom over its
  hold. `video.maxDurationMs` (either cut) makes a partial render for checking, ending on the whole shot that reaches
  that length. Defaults are 1080p at 30 fps. Requires ffmpeg, which is in the app image.
- **In-browser preview**: `GET /api/video-preview?cut=page|panel` with exactly one of `chapterId`, `pageId` or
  `panelId` returns the same shot list and narration audio the renderer uses, so the SPA can play the cut without
  encoding anything.
- **Project import** `POST /api/projects/import` accepts a `zip_package` export (or `project_json`, without files) up to
  `IMPORT_MAX_UPLOAD_MB` (4 GiB); nginx allows that size only on this route. The worker recreates the project for the
  importing user and records warnings on the job.
