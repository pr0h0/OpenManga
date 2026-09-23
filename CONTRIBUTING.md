# Contributing

Thanks for looking. OpenManga is a self-hosted studio, so the most useful contributions are usually the ones that make
it easier to run, or that fix something you hit on your own instance.

Before starting anything large, open an issue and describe what you want to change. A design that conflicts with one of
the invariants in [AGENTS.md](AGENTS.md) is better caught in a paragraph than in a branch.

## Before you start

- Read [AGENTS.md](AGENTS.md). It lists which package owns what, and the invariants that must not break — provider
  isolation, reference derivative sizes, immutable approved versions, text-free artwork prompts, queue-only AI work,
  story content as untrusted data, and keys never leaving the server.
- `docs/` has the deeper documentation: `ARCHITECTURE`, `DATA_MODEL`, `AI_PIPELINE`, `PROMPT_SYSTEM`,
  `IMAGE_REFERENCES`, `AUTH`, `STORAGE`, `SECURITY`, `TESTING`, `DEPLOYMENT`.
- This project uses **Bun**, not npm, pnpm or yarn. There is a single `bun.lock`.

## Development setup

You need Docker Engine with Compose v2. Bun on the host is optional — every command below can run in a container
instead, see "Running tools without installing Bun".

```bash
cp .env.example .env      # set POSTGRES_PASSWORD and SESSION_SECRET at minimum
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis kokoro
bun install
bun db:migrate            # with DATABASE_URL pointing at the dev Postgres
bun dev                   # api on :3000, worker, web on :5173 (proxies /api and /cdn)
```

The dev override exposes Postgres, Redis and Kokoro on loopback-only high ports; the exact ports and the connection
strings for them are in `docker-compose.dev.yml` and `.env.example`. Set `TTS_PROVIDER=fake` to skip Kokoro entirely,
and `AI_MOCK_MODE=true` to develop with no provider keys at all — `apps/mock-ai` stands in for the text and image
providers and costs nothing.

To create your first account when registration is disabled:

```bash
bun admin:create
```

Optional demo data: `bun db:seed`.

Full containerised stack, closer to production: `docker compose up -d --build`.

## Running tools without installing Bun

`./scripts/bunx.sh <command>` runs a command inside a disposable Bun container with the repo mounted, joined to the
compose network when it exists. Use it for anything you would otherwise run with `bun` or `bunx`:

```bash
./scripts/bunx.sh bun install
./scripts/bunx.sh bunx biome check .
```

## Checks

Run these before opening a pull request. CI runs the same set.

| Check | Command |
| --- | --- |
| Lint and format | `bunx biome check .` (`bunx biome check --write .` to fix) |
| Typecheck | `bunx tsc -p tsconfig.json --noEmit && bunx tsc -p apps/web/tsconfig.json --noEmit` |
| Unit tests | `bun test packages apps/api apps/worker apps/web` |
| Integration tests | `bun test tests/integration` |
| Web build | `cd apps/web && bun run build` |
| Dependency advisories | `bun audit` |

Both tsconfigs matter: the root one does not cover `apps/web`.

`bun audit` is not in CI, because a new advisory should not fail an unrelated pull request — run it before a
release, and treat anything reachable at runtime as a blocker. Dependabot keeps the GitHub Actions pins and the
Dockerfile base images current (`.github/dependabot.yml`); it has no Bun lockfile ecosystem, which is why the
JavaScript dependencies are checked this way.

Integration tests need the compose Postgres and Redis running. They create and drop their own throwaway database and
use Redis DB 5, so they will not touch your dev data:

```bash
TEST_DATABASE_URL=postgres://<user>:<password>@postgres:5432/<db> \
TEST_REDIS_URL=redis://redis:6379/5 \
  ./scripts/bunx.sh bun test tests/integration
```

No test spends money. Unit and integration tests use in-process fakes; end-to-end and smoke tests run against a stack
whose providers point at `mock-ai`. If you add a test that would call a real provider, it does not belong in these
suites. `docs/TESTING.md` explains the mock scenario system (`[[mock:429]]` and friends), the Playwright end-to-end
suite (`./scripts/e2e.sh <baseUrl>`) and the deployment smoke test.

## Changes that need extra care

Step-by-step recipes for the common extensions — a new AI provider, prompt, export kind, queued job type, layout
template, style preset, migration or API route — are in [`docs/EXTENDING.md`](docs/EXTENDING.md). The rules below
apply whichever one you are doing.

- **Database schema.** Edit the Drizzle schema in `packages/db`, then generate a migration —
  `cd packages/db && bunx drizzle-kit generate --name <name>` — and commit it. Do not hand-edit generated SQL, and do
  not edit a migration that has already been released.
- **Prompts.** `packages/prompts` templates are versioned. Changing a template means bumping its version, so that
  existing generations remain traceable to the prompt that produced them.
- **AI output schemas.** Model output is validated with Zod in `packages/schemas`. Keep the extract → validate → one
  repair → fail clearly path; do not add fallbacks that accept unvalidated output.
- **Provider formats.** Only `packages/ai-image` knows the image provider request formats and only `packages/ai-text`
  knows the text provider's. Keep provider specifics out of the API, worker and web.

## Commit and pull request conventions

Write commit subjects in the imperative and say what changed in the product, not which files moved. Keep unrelated
changes in separate commits.

Pull requests should describe what changed and why, note anything a self-hoster has to do when upgrading (a new
environment variable, a migration, a re-login), and confirm the checks above pass. The pull request template covers
this.

## Developer Certificate of Origin

OpenManga uses the [Developer Certificate of Origin](https://developercertificate.org/) (DCO). There is **no CLA** —
you keep the copyright in your contribution, and you licence it under Apache-2.0 along with the rest of the project.

Sign off every commit:

```bash
git commit -s -m "Your message"
```

That appends a line to the commit message:

```
Signed-off-by: Your Name <your.email@example.com>
```

By adding it you are certifying the statements in the DCO: that you wrote the contribution yourself, or that you have
the right to submit it under the project's licence, and that you understand the contribution and its sign-off are
public and kept indefinitely. The name and email must be real and must match your git configuration:

Automated dependency bumps (Dependabot) are exempt: a bot has no right-to-submit to certify.

```bash
git config user.name "Your Name"
git config user.email "your.email@example.com"
```

Forgot to sign off? `git commit --amend -s` fixes the last commit, and
`git rebase --signoff HEAD~<n>` fixes the last `<n>`. Both rewrite history, so force-push your branch afterwards.

## Reporting problems

Bug reports and feature requests go through the issue templates. Security vulnerabilities do **not** — see
[SECURITY.md](SECURITY.md).

## Code of conduct

Participation is covered by the [Code of Conduct](CODE_OF_CONDUCT.md).

## Branches

- **`master`** always works. It only moves when a tested `staging` is released into it, so what is on `master` is
  what has been confirmed running.
- **`staging`** is where work lands: experimental and in progress. Every change is its own branch cut from `staging`,
  one feature per branch, opened as a pull request **against `staging`** and squash-merged. CI runs on each pull
  request and again on every push to `staging`, because several changes that each pass alone can still break
  together.
- **Releasing** is a pull request from `staging` to `master`, opened once `staging` has been deployed and confirmed.
  Afterwards `staging` is recreated from the new `master`, so the two are identical. Squash-merging writes a new commit
  on `master` that `staging` never contains; merging `master` back instead would leave `staging` reporting itself
  commits ahead of `master` with the same files, a count that grows every release. Nothing lands on `staging` while a
  release pull request is open.

## Releasing

1. On a branch off `staging`, write the release commit: the `CHANGELOG.md` entry, the image tags pinned in
   `README.md`, and the `version` in the root `package.json` — which the app header's build label starts with, and
   which a unit test holds equal to the newest changelog entry. Merge it into `staging`.
2. Deploy `staging` and confirm it works.
3. Open a pull request from `staging` to `master`; squash-merge it once CI is green.
4. Tag that commit on `master` `vX.Y.Z`; the tag builds and publishes the images.
5. Recreate `staging` from `master` — a new branch at the same commit, not a merge. GitHub deletes `staging` when the
   release merges (its head branch), so this is also what brings it back.
