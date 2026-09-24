# OpenManga — agent guide

Self-hosted AI manhwa/webtoon studio: story → analysis → cast/world → references → planning → panels → lettering → narration → export.

## Stack & package manager
- **Bun only** (never npm/pnpm/yarn). Bun workspace: `apps/*`, `packages/*`. TypeScript strict.
- API: Hono + Zod + Drizzle (PostgreSQL). Queue: BullMQ on Redis with a transactional outbox. Web: React + Vite (`base=/app/`) + TanStack Router/Query + Tailwind v4 + Zustand + react-konva.
- Kokoro TTS is the only Python service (`services/kokoro`).
- Everything runs in Docker; nginx is the only public entrypoint (`/app`, `/api`, `/cdn`, `/healthz`).

## Commands (run inside a container to keep the host clean: `./scripts/bunx.sh <cmd>`)
| Task | Command |
| --- | --- |
| Install | `bun install` |
| Unit tests | `bun test packages apps/api apps/worker apps/web` |
| Integration tests (needs compose postgres+redis) | `TEST_DATABASE_URL=... bun test tests/integration` |
| E2E (Playwright, Docker) | `./scripts/e2e.sh http://localhost:3480` |
| Deploy smoke test | `bun scripts/smoke.ts http://nginx` |
| Lint / format | `bunx biome check .` / `bunx biome check --write .` |
| Typecheck | `bunx tsc -p tsconfig.json --noEmit && bunx tsc -p apps/web/tsconfig.json --noEmit` |
| New migration | `cd packages/db && bunx drizzle-kit generate --name <name>` |
| Apply migrations | `bun db:migrate` (compose `migrate` service does this on start) |
| Seed demo | `bun db:seed [--owner <username>]`, or `--samples <url\|path>` for the published sample projects |
| Create admin | `bun admin:create` |
| Stack | `docker compose up -d --build` / `docker compose down` |

## Directory ownership
- `packages/config` env schema + `PublicUrlService` (never concatenate hostnames).
- `packages/db` Drizzle schema, migrations (`drizzle/`), browser-safe row types (`@openmanga/db/types`).
- `packages/schemas` Zod contracts for AI output, editor documents, interchange format.
- `packages/domain` pure logic (layouts, bubbles, text wrap, narration segmentation, cost, permissions, retry/limiter). `@openmanga/domain/browser` is web-safe.
- `packages/prompts` versioned prompt templates (text + image). Change prompt ⇒ bump version.
- `packages/ai-text` text providers (OpenAI-compatible, DeepSeek, Anthropic, Gemini, Meta) + fake. `packages/ai-image` image providers (OpenAI, Gemini, Meta) + fake. `packages/audio` Kokoro/fake TTS + WAV/ffmpeg.
- `packages/image-utils` Sharp: sniffing, sanitizing, derivatives, crop, masks. `packages/storage` `AssetStorage` + local impl.
- `packages/services` shared API/worker services: assets, usage, jobs+outbox, `GenerationPlanner` (reference selection & prompt compile), analysis/plan appliers.
- `apps/api` HTTP routes by domain (`src/routes/*`). `apps/worker` queue processors + compositor/exports. `apps/mock-ai` mock provider HTTP service. `apps/web` SPA.

## Invariants (do not break)
1. Only `packages/ai-image` knows image request formats and only `packages/ai-text` knows text ones; a run's provider comes from the credential it names, never from server config. There are no server-held provider keys: outside `AI_MOCK_MODE` a run without a usable credential is refused with 422 `credentials_required`. Image quality defaults to `low`.
2. Canonical references are full resolution and never modified. Requests send **small cached derivatives** (default fit inside 192×288). Edit targets and masks are sent **full resolution**.
3. Identity comes from approved canonical character references; previous panels are continuity-only and attached last.
4. Approved/locked versions are immutable; changes create new versions. Panels keep their character version until explicitly migrated.
5. Every regeneration/edit creates a new asset; nothing is overwritten. Cancelled output is never activated.
6. AI output is validated with Zod: extract → validate → one repair → fail clearly.
7. Dialogue, SFX and narration boxes are vector overlays; artwork prompts forbid text. Exports are deterministic compositions (no AI).
8. Long AI work always goes through the queue; jobs are created with their outbox row in one transaction.
9. Story content is untrusted data inside delimiters; never interpolate it as instructions.
10. Keys never leave the server; logs redact secrets. User BYOK keys are AES-GCM encrypted at rest, returned only as `…last4`, and usable only by their owner. Assets are served only after authorization (X-Accel-Redirect).
11. MCP tools (`apps/api/src/mcp`) call the REST route handlers in-process through a private router, never business logic of their own; every tool is registered in `mcp/tools/*` with its scopes, sensitivity and `classify`, and `docs/MCP_TOOLS.md` is regenerated from the registry (`bun scripts/mcp-docs.ts`).

## Where to look next
Deep docs live in `docs/`; the README has an index of them. Two are the usual starting points:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for how the pieces fit, and
[`docs/EXTENDING.md`](docs/EXTENDING.md) for step-by-step recipes (new provider, prompt, export kind, job type,
layout, migration, route). Human-facing process lives in [`CONTRIBUTING.md`](CONTRIBUTING.md).
