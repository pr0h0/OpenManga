# Security

This is the summary table; the mechanisms are described in `docs/AUTH.md` (sessions, CSRF, throttling, the permission
gate), `docs/STORAGE.md` (uploads, keys, asset serving) and `docs/PROMPT_SYSTEM.md` (prompt injection).

| Requirement | Implementation |
| --- | --- |
| Password storage | Argon2id (`Bun.password`, 19 MiB / t=2), never reversible; timing-equalized unknown-user path |
| Sessions | opaque 256-bit token, HMAC-SHA256 at rest, HttpOnly, Secure (prod), SameSite=Lax, rotation, logout-all, expiry |
| CSRF | double-submit `om_csrf` cookie + `x-csrf-token` header on every unsafe method, timing-safe compare |
| Rate limiting | Redis fixed window per user/IP on `/api` (600/min), 30/min on auth routes, per connection on `/mcp` (240/min); login lockout with exponential backoff, per identifier+IP and per identifier; limiters fail open on Redis errors, with an nginx limit on the credential endpoints as a backstop; `CF-Connecting-IP` trusted only from private networks |
| Headers | nginx sets nosniff, Referrer-Policy, X-Frame-Options, Permissions-Policy and HSTS globally, a strict CSP (`script-src 'self'`, `connect-src 'self'`) on `/app/`, and a `default-src 'none'` CSP on served assets; the API adds nosniff, Referrer-Policy, X-Frame-Options and `no-store` unless a route sets its own cache policy |
| Input validation | Zod on every body and query; UUID path params; enum and size bounds |
| Authorization | one project gate with a role matrix; 404 for non-members, 403 for a member lacking the action; child entities resolve their project first |
| Provider keys | bring-your-own only: no server-level provider keys exist, so a compromised server holds no shared credential (see below) |
| Uploads | magic-byte MIME detection (PNG/JPEG/WebP only), `UPLOAD_MAX_BYTES` checked on both the header and the parsed file, Sharp re-encode that strips EXIF/GPS, 40 MP input limit |
| Path traversal | server-generated opaque sharded keys, strict key regex (no `..`, `//`, trailing `/`), resolved-path root check, nginx `internal` location |
| Asset access | the API authorizes each `/cdn` request (`read` on its project; expert-chat images, which have none, are owner-only), then answers with `X-Accel-Redirect` or, with S3 storage, a redirect to a signed URL valid for
`S3_PRESIGN_EXPIRES_SECONDS` (900 s by default); trashed assets are 404 outside the trash views (`?trash=1`); client-supplied `X-Accel-Enabled` is stripped at the edge |
| Reader links | `/api/public/shares/:token` needs no session: an unlisted 144-bit random token (stored as issued, so it can be shown again) opens one project or chapter read-only — its title, description, author, chapter titles, lettered page images and, for its video preview, the shot list plus the active artwork and narration audio of the panels and lines inside its scope (any other asset id answers 404), nothing else; only an owner (`manage`) creates or revokes one; a revoked link or a trashed project answers 404 at once, though a browser may keep a page image it already loaded for up to 5 minutes |
| Secrets | server-side only, never sent to the browser; the logger redacts by key and by value (API keys, bearer tokens, cookies, passwords); boot refuses a `SESSION_SECRET` or `POSTGRES_PASSWORD` still set to the `.env.example` placeholder |
| Errors | sanitized envelopes `{code, message, requestId}`; stack traces only in logs and `error_events` |
| Prompt injection | story content isolated in delimiters it cannot close, instructions only in system messages, Zod validation of every output |
| Budget | per-project cap (new projects start at $5) refuses new AI work with 402 until raised or explicitly overridden; a production run cannot start without a cap and pauses when it reaches it. An admin-set server ceiling per calendar month (402 `instance_budget_exceeded`) cannot be overridden by users |
| Production runs | a run spends unattended, so starting or cancelling one needs `generate`, and only the member who started it can continue it; it acts as the user who started it — every step is a normal route call through the same permission gate, budget and credential checks, re-evaluated per call (a disabled account pauses the run); no MCP connection is attached |
| Mock safety | `AI_MOCK_MODE` refused when `NODE_ENV=production` unless `AI_MOCK_ALLOW_IN_PRODUCTION=true`; the mock HTTP service is on the internal network only |
| Project members | owners invite editors and viewers (role matrix in `docs/AUTH.md`); an emailed invitation carries a 256-bit one-time token stored only as an HMAC, valid 7 days, claimed atomically, capped by `failureGuard`; it can create an account while registration is closed, but only for the invited address; inviting answers the same whether or not the address has an account; members spend only on their own keys and only the owner moves or overrides the budget cap; removing a member closes their event stream and drops their agents' grants to the project |
| Comments | panel comments are members' untrusted text: stored as written (≤ 4000 characters), rendered only as React text nodes (never markup), plain text in agent results, marked as data in the MCP tool description; any member including viewers may comment (`read`), only the author edits, the author or owner deletes; posting is limited to 60 a minute per user |
| Audit | `audit_events` for auth, project lifecycle, members and invitations, approvals, deletes (including export and narration-audio deletion), migrations, bulk generation and bulk panel checks, production-run starts, exports, reader links, credential rotation; an agent's actions carry its connection (`service_id`) |
| AI agents (MCP) | `/mcp` takes Bearer tokens only (OAuth 2.1 with PKCE S256, or personal access tokens), never the session; tokens are opaque and stored as HMACs; per-connection scopes, project grants and approval mode on top of normal membership; sensitive calls can wait for the user's approval; Host/Origin checks against DNS rebinding. Details in `docs/MCP.md` |
| YouTube channels | read-only scopes only; OAuth with PKCE S256 and a single-use `state` (10 minutes, in Redis) bound to the account that started it; tokens AES-GCM encrypted with the provider-key ring, never returned to a client; a channel's analytics and reach are read only for videos its owner linked; disconnecting revokes the grant at Google; retention follows YouTube's developer policies (see below) |
| Network exposure | only nginx is published (loopback by default); Postgres, Redis, Kokoro, worker and mock-ai have no host ports |
| Dev mailbox | 404 unless `DEV_MAILBOX_ENABLED=true`; admin-only in every environment (reset links must not be public) |

## User provider keys (BYOK)

Every text and image run uses a key its owner added, so the encryption of those keys is the main secret-handling path
in the system. `packages/services/src/credentials.ts` owns it.

- **Format.** `v2.<keyId>.<iv>.<tag>.<ciphertext>` — AES-256-GCM with a fresh 12-byte IV per encryption. `keyId` is
  `sha256(key).slice(0, 12)`, a non-secret label saying which key encrypted the row. A legacy `v1.<iv>.<tag>.<ct>`
  form (no key id) still decrypts by trying each configured key.
- **Key ring.** The primary key is `CREDENTIALS_ENCRYPTION_KEY` (32 bytes, hex or base64 — anything else fails at
  boot). When it is unset, the primary key is derived with
  `hkdfSync("sha256", SESSION_SECRET, "openmanga", "provider-credentials", 32)`. That derived key is always kept in the
  decryptable set, even once a dedicated key is configured, so rows written before one existed stay readable —
  and rotating `SESSION_SECRET` without a dedicated key makes them unreadable.
  `CREDENTIALS_ENCRYPTION_OLD_KEYS` (comma-separated) adds further decrypt-only keys.
- **Exposure.** Only `…last4` (`provider_credentials.key_hint`) is ever returned to a client. Keys are usable only by
  their owner — checked at the API and again in the worker. The worker never receives a key in a job payload; it
  resolves the credential itself from the id on the job.
- **Rotation.** `rotateCredentials()` re-encrypts rows not already on the primary key, in batches, with a
  compare-and-set update (`WHERE id = … AND encrypted_key = <value read>`) so a user saving or deleting a key at the
  same moment is never overwritten; failures are logged and skipped for the rest of the run. It is invoked at boot
  (`apps/api/src/cli/bootstrap.ts`), on every hourly worker maintenance cycle, and from
  `POST /api/admin/credentials/rotate`. `GET /api/admin/credentials/encryption` reports the rows per key id and how
  many are still pending. The operator procedure is in `docs/DEPLOYMENT.md`.
- **Custom endpoints.** A credential may carry its own base URL; it must be HTTPS without embedded credentials and
  resolve to a public address, checked when saved and again on every use, which keeps a user-supplied endpoint from
  reaching internal services (tested in `packages/services/src/credentials.test.ts`). `AI_ALLOW_PRIVATE_BASE_URLS`
  lifts this for development only (to reach `mock-ai`); leave it off on anything reachable from the internet.

## YouTube data

YouTube stats (`packages/services/src/youtube.ts`, setup in [DEPLOYMENT](DEPLOYMENT.md#youtube-stats)) store as
little as the feature needs, under the
[YouTube API Services Developer Policies](https://developers.google.com/youtube/terms/developer-policies), checked
before retention was built (October 2026). What they say, and what the app does:

| Policy (section III.E.4 and III.D.2) | What the app does |
| --- | --- |
| Authorization tokens may be stored as long as needed for the purpose the user consented to | refresh and access tokens are kept per channel, encrypted, and deleted on *Disconnect* |
| Authorized Data that is analytics, reporting or statistics may be stored as long as necessary, but the client must confirm **every 30 days** that it is still authorized | each successful token refresh (at least twice a day, when reports are checked) records `verified_at`; when it is over 30 days old the hourly pass deletes the channel's reach rows and authorized snapshots |
| Statistics retrieved as Non-Authorized Data (without the owner's credentials) must not be stored for **more than 30 days** | counters of videos on channels not connected by the linking user, read with the API key or another channel's token, are snapshots without a connection and are deleted after 30 days. This is the cap the roadmap anticipated: a video on someone else's channel keeps at most 30 days of stored history, so its first-48-hours curve disappears 30 days after it was recorded |
| Other Authorized Data at most 30 days unless refreshed; stored data kept consistent with YouTube; the most up-to-date data shown | nothing else is stored: daily Analytics history is fetched when a chart opens (15-minute cache), counters are read live (5-minute cache), and a video's title, thumbnail and channel name are refreshed with each snapshot |
| On revocation, revoke the token programmatically and delete the Authorized Data within 7 days (30 days when revoked from the Google account) | *Disconnect* calls Google's revoke endpoint, then deletes the channel's tokens, reach rows and authorized snapshots at once. A refresh Google refuses (`invalid_grant`, e.g. access removed in the Google account) marks the channel revoked and deletes the same data immediately |
| A user can ask for deletion, and deleting an account deletes the user's data | unlinking a video deletes the snapshots and reach rows no other link needs at the next hourly pass; deleting an account or a project cascades to its channels, links and their data |
| No new or derived metrics replacing API data | stored rows are the API's own values: reach rows keep the basic report's impressions and CTR per video and day as delivered, and the combined report only summed to impressions per traffic source (operating system and device summed away). Totals across a project's videos and the hourly curve are computed for display only, never stored |

What is stored, per table, is in [DATA_MODEL](DATA_MODEL.md#youtube-stats-youtubets).

## Operational notes

- Rotating `SESSION_SECRET` invalidates all sessions and reset tokens, every MCP token when `MCP_TOKEN_SECRET` is
  unset — and any saved provider key still encrypted under the key derived from it. Set
  `CREDENTIALS_ENCRYPTION_KEY` before you ever need to rotate the session secret.
- Keep `backups/` out of the repository and off public storage; it contains a copy of `.env`.
- Cloudflare may inject scripts (Web Analytics, for example); the strict CSP blocks them. Disable those features in
  the zone or extend the CSP deliberately.
- With `STORAGE_DRIVER=s3` the bucket stays private and every download is a presigned URL. Such a URL is a bearer
  credential for one object until it expires: whoever holds it (browser history, a proxy log, a forwarded link) can
  fetch that object without a session, and revoking access or a reader link does not cancel URLs already issued. Keep
  `S3_PRESIGN_EXPIRES_SECONDS` short (the default 900 s; the redirect itself is cached at most a minute less), and
  give the app's S3 key access to its own bucket (or prefix) only.
- `assets.visibility` allows `public`, but nothing in the code creates a public asset, so in practice every `/cdn`
  request is authorized. If you add one, remember it is then served with no auth check and a one-year immutable
  cache.
