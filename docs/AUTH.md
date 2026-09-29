# Authentication & authorization

Password auth with server-side sessions, a double-submit CSRF token and one project permission gate. AI agents use
Bearer tokens on `/mcp` instead (see *Agents* below and `docs/MCP.md`). The pieces live
in `packages/auth` (hashing, tokens, the `AuthService`), `apps/api/src/lib/middleware.ts` (cookies, CSRF, rate limits),
`apps/api/src/lib/access.ts` (the gate) and `packages/domain/src/permissions.ts` (the role matrix).

## Accounts

- Register with username + email + password at `POST /api/auth/register`, gated by `REGISTRATION_ENABLED`, which
  **defaults to false**. When it is off, registration returns 403 `registration_disabled`, admins create accounts with
  `POST /api/admin/users` (which ignores the flag), and existing users can still log in. `GET /api/auth/config` tells
  the SPA whether to show the sign-up form.
- Login identifier is username **or** email, case-insensitive; both are stored lower-cased and uniquely indexed.
- Passwords: Argon2id via `Bun.password` (`memoryCost: 19456` ≈ 19 MiB, `timeCost: 2`), minimum 10 characters, maximum
  256. An unknown identifier still runs `dummyVerify()` against a cached hash of a fixed string so a missing account
  and a wrong password take the same time.
- First admin: `INITIAL_ADMIN_USERNAME` / `INITIAL_ADMIN_EMAIL` / `INITIAL_ADMIN_PASSWORD` picked up idempotently by
  `bootstrapReferenceData()` in the `migrate` container, or `bun admin:create`
  (`apps/api/src/cli/admin-create.ts`). No default credentials exist in code.

## Sessions

- Opaque 256-bit token (`randomBytes(32).toString("base64url")`) in the `om_session` cookie: `HttpOnly`,
  `SameSite=Lax`, `Path=/`, `Secure` when `COOKIE_SECURE` (which defaults to `NODE_ENV === "production"`), expiring
  with the session row (`SESSION_TTL_DAYS`, default 30).
- Only `HMAC-SHA256(token, SESSION_SECRET)` is stored (`sessions.token_hash`, unique). Validation rejects tokens over
  128 characters, requires the row to be unrevoked and unexpired and the user to be `active`, and writes `last_used_at`
  only when it is more than 5 minutes stale, so a busy session is not a write per request.
- Rotation: login revokes the old row and issues a new one; changing the password and completing a reset revoke **all**
  of the user's sessions (a password change then issues a fresh one for the caller). `POST /api/auth/logout`,
  `POST /api/auth/logout-all`, list at `GET /api/auth/sessions`. Disabling a user or changing their role revokes
  their sessions.

## CSRF

Double-submit token: the `om_csrf` cookie is readable by JavaScript (minted on any request that arrives without one)
and must be echoed in the `x-csrf-token` header on every method outside `GET`/`HEAD`/`OPTIONS`, including login and
register — the SPA seeds the cookie with its opening `GET /api/auth/me`. Comparison is timing-safe; a mismatch is 403
`csrf_failed`. Combined with `SameSite=Lax`. The middleware covers the whole `/api` router; `/cdn` is a read-only
sub-app and only loads the session. `/mcp` and `/oauth/*` sit outside `/api` and use neither cookies nor CSRF.

## Throttling

| Limiter | Key | Window | Limit |
| --- | --- | --- | --- |
| All of `/api` | user id, else client IP | 60 s | `RATE_LIMIT_PER_MINUTE` (default 600) |
| `register`, `login`, both password-reset routes | client IP | 60 s | 30 |
| `POST /api/auth/password` | user id | 60 s | 10 |
| OAuth client registration | client IP | 1 h | 20 |
| OAuth `authorize`, `token`, `revoke` (each) | client IP | 60 s | 60 |
| `/mcp` | connection | 60 s | `MCP_RATE_LIMIT_PER_MINUTE` (default 240) |

All are fixed-window Redis counters that answer 429 `rate_limited` with `retry-after` when exceeded (the `rateLimit`
middleware also sets `x-ratelimit-limit` and `x-ratelimit-remaining`), and **fail open** if Redis errors so a Redis
blip cannot lock everyone out. As a backstop that does not need Redis, nginx limits `login`, `register` and
`password-reset/request` to 30 requests a minute per client address (burst 20).

Login attempts are counted twice: per `identifier + IP` against `LOGIN_MAX_ATTEMPTS` (default 10), and per identifier
alone against five times that, which is what a distributed attempt runs into. Past either limit the response is 429
`login_throttled` with an estimated wait; each failure sets the key's TTL to `60 * 2^(count - max + 1)` seconds (at
least 60, capped at one hour). A successful login deletes both counters.

The client IP comes from nginx as `X-Real-IP`. nginx takes it from `CF-Connecting-IP` only when the request arrives
from a private or loopback network (cloudflared or another proxy beside it) and otherwise uses the socket address, so
the limiters key on the real client behind a Cloudflare tunnel and a forged header from the internet is ignored.

## Password reset (mock email)

`POST /api/auth/password-reset/request` → opaque token, stored only as its HMAC, valid 1 hour →
`MailProvider.send`. The only implementation in the repo is `DevMailProvider` (`packages/mail`), which writes the
message to `dev_emails` and logs a masked recipient; there is no SMTP provider yet. The dev mailbox UI is at
`/app/dev/mailbox` (`GET /api/dev/mailbox`).

Responses never reveal whether an account exists. `POST /api/auth/password-reset/confirm` claims the token atomically
(`WHERE token_hash = … AND used_at IS NULL AND expires_at > now()`) and revokes every session for that user. The
mailbox is 404 unless `DEV_MAILBOX_ENABLED=true` (default false, in every environment), and even then it is
admin-only, since every message in it carries a reset link.

## Authorization

`projectAccess(c, projectId, action)` is the single gate; `entityAccess(c, kind, id, action)` resolves a child resource
(chapter, scene, page, panel, character, character version, location, location version, prop, prop version) to its
project first and then delegates.

| Role | read | write | generate | delete | manage |
| --- | --- | --- | --- | --- | --- |
| `owner` | yes | yes | yes | yes | yes |
| `editor` | yes | yes | yes | — | — |
| `viewer` | yes | — | — | — | — |
| `admin` (no membership) | yes | — | — | — | yes |

A disabled user is refused everything. The effective role is the `project_members` row, falling back to `owner` when
the caller owns the project. Someone with no role at all gets **404** so project existence does not leak; a member
whose role lacks the action gets **403**. A trashed project (`deleted_at` set) allows only `read`, `delete` and
`manage`. Admins get `read` and `manage` on any project — note that "admin" does not imply `write`, `generate` or
`delete` on a project they are not a member of. That admin reach is not extended to AI agents: a call made through an
MCP connection needs a real role in the project, and the connection must also have been granted that project (403
`project_not_granted` otherwise).

Bulk panel checks (`POST /api/projects/:projectId/checks`) need `generate` on the project, plus `read` on the page or
chapter they are scoped to. A production run needs `generate` to start (`POST /api/projects/:projectId/production-runs`,
which also refuses a project with no budget cap), continue or cancel, and `read` to list. The run then acts as the user
who started it: the API calls the ordinary routes in-process with that user on the context, so each step goes through
`projectAccess` with that user's current role; if the account is disabled the run pauses. No MCP connection is attached,
so connection scopes and project grants play no part.

Project templates are the caller's own: `POST /api/projects/:projectId/template` needs only `read` on the project
and saves its setup into the caller's `users.settings.projectTemplates` (at most 50); `DELETE /api/auth/templates/:id`
removes one, and `GET /api/production-presets` returns the built-in presets with the caller's templates.

Creating or revoking a reader link (`share_links`) needs `manage`; listing them needs `read`. The link itself is
opened with no session at all — see `docs/SECURITY.md`.

Assets are authorized before nginx is asked to serve the file — the asset's owner, or `read` on its project — and a
trashed asset is not served outside the trash views; see `docs/STORAGE.md`.

## Identities and OAuth

`auth_identities (provider, provider_subject)` is unique and links an external identity to an internal user, so one
user can hold several and the internal id is never a provider id. Today the only rows written are
`provider: "local", provider_subject: <user id>` at account creation — **signing in with an external OAuth provider is
not implemented**; the table is the schema half of that future work.

OAuth does exist in the other direction: OpenManga is an OAuth 2.1 authorization server for its own MCP endpoint.

## Agents (MCP)

`/mcp` accepts only `Authorization: Bearer` tokens — an OAuth access token (authorization code with PKCE S256,
public clients only, rotating refresh tokens) or a personal access token (`om_pat_…`, shown once, optional expiry).
Both resolve to a connection (`user_services`) that acts as its user, limited by its scopes, project grants and
approval mode. Tokens are opaque and stored only as `HMAC-SHA256` under `MCP_TOKEN_SECRET`, or a key derived from
`SESSION_SECRET` when that is unset. The consent page and the connection list are ordinary session routes
(`/api/agents/*`) that the MCP tools themselves cannot reach. `docs/MCP.md` has the details.

Provider API keys are a separate thing entirely: users bring their own, and they are encrypted per user. See
`docs/AI_PIPELINE.md` for how a run picks one and `docs/SECURITY.md` for the encryption and rotation story.
