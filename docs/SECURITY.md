# Security

This is the summary table; the mechanisms are described in `docs/AUTH.md` (sessions, CSRF, throttling, the permission
gate), `docs/STORAGE.md` (uploads, keys, asset serving) and `docs/PROMPT_SYSTEM.md` (prompt injection).

| Requirement | Implementation |
| --- | --- |
| Password storage | Argon2id (`Bun.password`, 19 MiB / t=2), never reversible; timing-equalized unknown-user path |
| Sessions | opaque 256-bit token, HMAC-SHA256 at rest, HttpOnly, Secure (prod), SameSite=Lax, rotation, logout-all, expiry |
| CSRF | double-submit `om_csrf` cookie + `x-csrf-token` header on every unsafe method, timing-safe compare |
| Rate limiting | Redis fixed window per user/IP on `/api` (600/min), 30/min on auth routes; login lockout with exponential backoff; limiters fail open on Redis errors |
| Headers | nginx sets nosniff, Referrer-Policy, X-Frame-Options and Permissions-Policy globally, a strict CSP (`script-src 'self'`, `connect-src 'self'`) on `/app/`, and a `default-src 'none'` CSP on served assets; the API adds nosniff and `no-store` |
| Input validation | Zod on every body and query; UUID path params; enum and size bounds |
| Authorization | one project gate with a role matrix; 404 for non-members, 403 for a member lacking the action; child entities resolve their project first |
| Provider keys | bring-your-own only: no server-level provider keys exist, so a compromised server holds no shared credential (see below) |
| Uploads | magic-byte MIME detection (PNG/JPEG/WebP only), `UPLOAD_MAX_BYTES` checked on both the header and the parsed file, Sharp re-encode that strips EXIF/GPS, 64 MP input limit |
| Path traversal | server-generated opaque sharded keys, strict key regex (no `..`, `//`, trailing `/`), resolved-path root check, nginx `internal` location |
| Asset access | the API authorizes each `/cdn` request against project membership, then answers with `X-Accel-Redirect`; client-supplied `X-Accel-Enabled` is stripped at the edge |
| Secrets | server-side only, never sent to the browser; the logger redacts by key and by value (API keys, bearer tokens, cookies, passwords) |
| Errors | sanitized envelopes `{code, message, requestId}`; stack traces only in logs and `error_events` |
| Prompt injection | story content isolated in delimiters it cannot close, instructions only in system messages, Zod validation of every output |
| Budget | per-project cap (new projects start at $5) refuses new AI work with 402 until raised or explicitly overridden |
| Mock safety | `AI_MOCK_MODE` refused when `NODE_ENV=production` unless `AI_MOCK_ALLOW_IN_PRODUCTION=true`; the mock HTTP service is on the internal network only |
| Audit | `audit_events` for auth, project lifecycle, approvals, deletes, migrations, bulk generation, exports, credential rotation |
| AI agents (MCP) | `/mcp` takes Bearer tokens only (OAuth 2.1 with PKCE S256, or personal access tokens), never the session; tokens are opaque and stored as HMACs; per-connection scopes, project grants and approval mode on top of normal membership; sensitive calls can wait for the user's approval; Host/Origin checks against DNS rebinding. Details in `docs/MCP.md` |
| Network exposure | only nginx is published (loopback by default); Postgres, Redis, Kokoro, worker and mock-ai have no host ports |
| Dev mailbox | 404 unless enabled; admin-only when `NODE_ENV=production` (reset links must not be public) |

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
- **Custom endpoints.** A credential may carry its own base URL; it must resolve to a public address, which keeps a
  user-supplied endpoint from reaching internal services (tested in `packages/services/src/credentials.test.ts`).

## Operational notes

- Rotating `SESSION_SECRET` invalidates all sessions and reset tokens — and any saved provider key still encrypted
  under the key derived from it. Set `CREDENTIALS_ENCRYPTION_KEY` before you ever need to rotate the session secret.
- Keep `backups/` out of the repository and off public storage; it contains a copy of `.env`.
- Cloudflare may inject scripts (Web Analytics, for example); the strict CSP blocks them. Disable those features in
  the zone or extend the CSP deliberately.
- `assets.visibility` allows `public`, but nothing in the code creates a public asset, so in practice every `/cdn`
  request is authorized. If you add one, remember it is then served with no auth check and a one-year immutable
  cache.
