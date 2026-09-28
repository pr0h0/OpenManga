# Security policy

This file is about **reporting** a vulnerability. For how OpenManga is built — password storage, sessions, CSRF,
authorization, upload handling, asset access, secret redaction, prompt-injection isolation and audit logging — see
[docs/SECURITY.md](docs/SECURITY.md), which documents the security model and is not a reporting channel.

## Supported versions

Only the **latest release** receives security fixes. OpenManga is maintained by one person; backporting to older tags
is not something that can be promised, so it is not promised. Fixes land on `staging`, are released to `master`, and go out in the next tag. If you
are self-hosting, track the latest tag.

## Reporting a vulnerability

Please do not open a public issue for a security problem.

1. **Preferred:** open a private security advisory on GitHub — the "Report a vulnerability" button under the
   repository's Security tab. It keeps the report, the discussion and the fix in one place, and it is private until
   published.
2. **Alternative:** email **contact@pr0h0.me**. Use this if you cannot use GitHub advisories.

Useful things to include: the version or tag you are running, how you deployed it (Docker Compose or a development
setup), what an attacker can actually do, and the shortest reliable way to reproduce it. A proof of concept against
your own instance is welcome; do not test against anyone else's.

## What to expect

- An acknowledgement within **7 days**.
- **No SLA** on a fix. This is best-effort work by a single maintainer. You will be told what is being done and
  roughly when, and if something is not going to be fixed you will be told that too, with the reason.
- **No bug bounty.** There is no money in this project to pay one. Credit in the advisory and the changelog if you
  want it, and none if you would rather stay anonymous.
- Coordinated disclosure: please give the fix a chance to ship before publishing. If the report goes quiet from this
  end for more than 30 days, treat yourself as free to disclose.

## Scope

**In scope** — the application in this repository: the API, the worker, the web client, the shared packages, the
Kokoro service, and the Docker and nginx configuration published here. Things worth reporting include authentication
or session flaws, authorization bypass between projects or users, exposure of a stored provider key beyond its owner,
unauthorized asset access, an MCP connection (OAuth client or access token) acting beyond the scopes and projects it
was granted, a public reader link exposing more than the project or chapter it shares, path traversal in asset
storage, injection reachable from story or prompt content, and remote code execution.

**Out of scope:**

- The AI providers themselves, and their content filters, quotas and billing. OpenManga sends requests with the
  operator's own keys; a provider's behaviour is between the operator and the provider.
- Vulnerabilities in third-party dependencies or base images with no OpenManga-specific exploit path. Report those
  upstream; if OpenManga's use makes an upstream issue exploitable here, that part is in scope.
- Deployment choices the operator makes against the documented defaults — publishing Postgres, Redis, the worker or
  the Kokoro service to the internet, running without TLS, weakening the nginx Content-Security-Policy, or reusing a
  guessable `SESSION_SECRET`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).
- Anything that presupposes an already-compromised host, a compromised operator account, or physical access.
- `AI_MOCK_MODE` behaviour. It is refused in production unless explicitly overridden, and it is a development and demo
  path by design.
- Reports consisting only of scanner output, missing hardening headers with no impact, or best-practice advice with no
  attack attached.
