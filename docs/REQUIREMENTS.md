# Requirements

One Linux host with Docker. Every service runs in a container, so nothing else needs installing on the host — no Bun,
no Node, no Python, no ffmpeg, no Postgres client. All figures below were measured on a running instance or read out of
`docker-compose.yml`, the Dockerfiles under `deploy/docker/` and `packages/config/src/index.ts`.

## Architecture / platform

Published container images are **`linux/amd64` only**. On arm64 (Apple Silicon, Ampere, Raspberry Pi) there is no
prebuilt image: clone the repo and build locally with `docker compose up -d --build`. Every base image used
(`oven/bun`, `postgres`, `redis`, `nginx`, `python`) has arm64 variants, so a self-build works, but it is not tested in
CI and CPU-only torch for Kokoro is noticeably slower there.

Docker Engine with Compose v2 (`docker compose`, not `docker-compose`). Windows and macOS work only through Docker
Desktop; running the services directly on the host OS is not supported.

## Component versions

| Component | Version | Where it is pinned |
| --- | --- | --- |
| PostgreSQL | **17** (`postgres:17-alpine`) | `docker-compose.yml` |
| Redis | **7** (`redis:7-alpine`), AOF on, `maxmemory-policy noeviction` | `docker-compose.yml` |
| Bun | **1.4** (`oven/bun:1.4-debian`); CI pins `1.4.2` | `deploy/docker/*.Dockerfile`, `.github/workflows/ci.yml` |
| nginx | **1.27-alpine** | `deploy/docker/nginx.Dockerfile` |
| ffmpeg | Debian package in the app image | `deploy/docker/app.Dockerfile` |
| Python (Kokoro only) | **3.11-slim** with CPU-only `torch==2.5.1` | `services/kokoro/Dockerfile` |

Postgres and Redis are ordinary instances — an external managed Postgres 17 or Redis 7 works, point `DATABASE_URL` and
`REDIS_URL` at it and drop the compose services. Do not point the app at a Redis configured to evict keys: queue state
lives there. (Losing it is survivable — the worker re-publishes still-queued jobs from the database on startup and
every five minutes — but it is not a supported configuration.)

If you run the worker outside Docker, ffmpeg must be on `PATH`. The worker uses it for narration WAV assembly,
two-pass loudness normalisation and MP4 video export; there is no fallback path.

## CPU and memory

Measured resident memory of each container on a running instance under light load:

| Container | Memory |
| --- | --- |
| api | 77 MiB |
| worker | 83 MiB |
| postgres | 114 MiB |
| nginx | 11 MiB |
| redis | 12 MiB |
| kokoro (4 workers) | 3.8 GiB |

Those are idle-to-light figures. The worker grows under load: it decodes and resizes images with Sharp at up to
`IMAGE_WORKER_CONCURRENCY` (default 24) in flight, and a video export runs `VIDEO_ENCODE_CONCURRENCY` ffmpeg processes
(default 4), each roughly one core at `veryfast`.

Recommended sizing:

| Configuration | CPU | RAM |
| --- | --- | --- |
| `TTS_ENABLED=false` (cloud TTS or no narration audio) | 2 cores | 4 GB |
| `TTS_ENABLED=true` at default Kokoro settings | 8 cores | 8 GB |

Most of the wall-clock time in a generation run is spent waiting on the provider's HTTP response, not on local CPU.
The exceptions are video export and local TTS.

## Kokoro TTS (`TTS_ENABLED=true`)

Local TTS is opt-in twice: `TTS_ENABLED=true` (the default) and the `tts` compose profile
(`COMPOSE_PROFILES=...,tts`). It is the only Python service and the only component with a real memory footprint.

- The container runs **`KOKORO_WORKERS` uvicorn processes** (default 4). Each process loads **its own copy** of
  Kokoro-82M and its own torch runtime, which is why memory scales linearly with the worker count: measured 3.8 GiB
  total at 4 workers, roughly 0.95 GiB per process. `KOKORO_WORKERS=1` brings that down to about one model copy, at
  one segment synthesised at a time.
- Each process is limited to `KOKORO_THREADS` threads (`OMP_NUM_THREADS` / `MKL_NUM_THREADS`, default 2). Keep
  `KOKORO_WORKERS × KOKORO_THREADS` at or below the host's core count — the defaults assume 8 cores.
- Set `TTS_WORKER_CONCURRENCY` equal to `KOKORO_WORKERS`. Higher worker concurrency only queues requests at Kokoro.
- Measured serial throughput at the default settings: about 18 narration segments per minute.
- `KOKORO_DEVICE=cpu` is the default. GPU needs a compose override and a CUDA torch build (see `docs/DEPLOYMENT.md`).
- The model weights are **not** shipped in the image. On first start the container downloads them from HuggingFace
  into the `kokoro-cache` volume — measured 314 MB. Expect the health check to stay red for a few minutes
  (`start_period` is 120 s). For an air-gapped install, pre-seed the volume at `HF_HOME=/cache/huggingface`.

To skip it entirely, set `TTS_ENABLED=false` and leave `tts` out of `COMPOSE_PROFILES`. Narration audio can then come
from a BYOK cloud voice provider (OpenAI, Gemini or ElevenLabs) instead.

## Disk

Container images, pulled or built:

| Image | Size |
| --- | --- |
| app (api, worker, migrate, mock-ai) | 1.22 GB |
| kokoro | 2.12 GB |
| nginx (includes the built SPA) | 78 MB |
| `postgres:17-alpine` | 424 MB |
| `redis:7-alpine` | 58 MB |

Data volumes:

- **`assets-data`** is what grows. Measured: **about 2.7 GB of assets for 50 projects**. Panel artwork dominates it —
  each generated panel is kept at full resolution (the `IMAGE_SIZES` candidates are all around 2 MP) and is never
  overwritten, plus its derivatives: a 384 px
  thumbnail, a 1024 px preview, a 2048 px web copy and a small prompt-reference derivative (192×288 by default).
  Character, location, prop and style references are full resolution too, but there are only a handful per project.
  Every regeneration and every masked edit creates a *new* asset and keeps the old version, so a project that is
  iterated on heavily can hold several times the artwork it displays.
- **Exports** (PNG/JPG/PDF/webtoon/MP4/timeline) are written into the same volume and expire after 30 days. A video
  export of a whole project is the single largest artefact the app produces and can rival the project's artwork in
  size. Prompt derivatives are purged after 30 days unused, trashed assets after 30 days.
- **`postgres-data`** stays small: a database with about 100 chapters and 2,000 panels measured 64 MB. Story text,
  plans, prompts and bubble geometry are all rows; no image bytes are stored in Postgres.
- **`tmp-data`** holds per-job scratch directories, deleted after each job (stale entries older than 6 h are swept).
  Video export is the peak consumer — size it for a few GB of headroom.
- **`redis-data`** and **`kokoro-cache`**: queue state (small) and the downloaded model (314 MB).

### Importing a project

A project package runs about **4.3 MB per panel** (measured on the two published samples, whose entries are PNG and
WAV and so compress to a ratio of 1.0). A one-chapter project is therefore around 95 MB, and a 400-panel film about
1.7 GB.

Packages are streamed to disk entry by entry, so importing a large package costs the same memory as a small one:
measured at ~170 MB of worker memory for a 1.5 GB package (uploaded over HTTP, extracted, and restored). What the
limits bound is disk and time:

| Variable | Default | What it limits |
|---|---|---|
| `IMPORT_MAX_UPLOAD_MB` | 4096 | The whole package |
| `IMPORT_MAX_ENTRY_MB` | 512 | A single entry inside it |
| `IMPORT_MAX_COMPRESSION_RATIO` | 5 | Uncompressed-to-compressed expansion; this is the zip-bomb defence |

If you raise `IMPORT_MAX_UPLOAD_MB`, raise `client_max_body_size` on the `/api/projects/import` location in
`deploy/nginx/default.conf` to match — nginx rejects an oversized upload before the app can explain itself.
Allow roughly the package size again in free space on the `tmp-data` volume while an import runs.

A 40 GB disk is comfortable for a personal install: roughly 4 GB of images, 5–10 GB of assets for a few dozen
projects, and the rest as export and temp headroom. `docker compose down` keeps all volumes; never pass `-v` in
production. See `docs/STORAGE.md` for the retention table and `docs/DEPLOYMENT.md` for backups.

## Required environment variables

Exactly three variables have no default (`packages/config/src/index.ts`):

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `REDIS_URL` | Redis connection string |
| `SESSION_SECRET` | at least 32 characters; also derives the credential-encryption key when `CREDENTIALS_ENCRYPTION_KEY` is unset |

Under Docker Compose you do not set the first two by hand: `docker-compose.yml` composes `DATABASE_URL` and
`REDIS_URL` from the compose services, so the variables you must actually put in `.env` are **`POSTGRES_PASSWORD`** and
**`SESSION_SECRET`**. Everything else in `.env.example` has a working default.

**No provider API key is required to boot.** Keys are bring-your-own, added per user in the app and encrypted at rest,
so a fresh install starts with none. `AI_MOCK_MODE=true` plans and "generates" a full chapter with no keys at all.
Costs for real providers are in `docs/COSTS.md`.
