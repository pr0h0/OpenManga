# MCP: letting AI agents work on your projects

OpenManga serves a [Model Context Protocol](https://modelcontextprotocol.io) endpoint so ChatGPT and other
MCP-capable agents can read and build projects **as you**: create a project, write and analyse the story, plan
chapters, fix panels, write and synthesize narration, and export — including the whole pipeline in paste (manual)
mode, with no provider keys at all.

The agent never gets more than you allow. Every connection has its own scopes, project list, permission to create
projects and approval mode, and every call still goes through OpenManga's normal checks (project membership, budgets,
locked versions, validation). Sensitive actions can wait for your approval in the web app.

- [Endpoint and configuration](#endpoint-and-configuration)
- [Connecting ChatGPT (OAuth)](#connecting-chatgpt-oauth)
- [Other agents (personal access tokens)](#other-agents-personal-access-tokens)
- [Local and private instances](#local-and-private-instances)
- [Scopes, projects and approval modes](#scopes-projects-and-approval-modes)
- [Approvals](#approvals)
- [Tools](#tools)
- [Asynchronous jobs and manual (paste) mode](#asynchronous-jobs-and-manual-paste-mode)
- [Spending and budgets](#spending-and-budgets)
- [Results and errors](#results-and-errors)
- [Security notes](#security-notes)
- [Example sessions](#example-sessions)
- [Troubleshooting](#troubleshooting)

The generated, always-current list of every tool (schemas, scopes, sensitivity, wrapped routes) and every scope is
[MCP_TOOLS](MCP_TOOLS.md).

## Endpoint and configuration

| | |
| --- | --- |
| Endpoint | `https://<your host>/mcp` (Streamable HTTP, stateless) |
| Protocol | MCP 2026-07-28 (per-request envelope), plus the 2025-era handshake revisions (2025-11-25 and older) through the SDK's stateless fallback |
| SDK | Official TypeScript SDK v2 (`@modelcontextprotocol/server` 2.1.0) |
| Auth | `Authorization: Bearer <token>`: an OAuth access token (`om_mcp_at_…`) or a personal access token (`om_pat_…`) |
| OAuth discovery | `/.well-known/oauth-protected-resource/mcp` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414); the bare paths answer too |
| OAuth endpoints | `/oauth/authorize`, `/oauth/token`, `/oauth/register` (DCR), `/oauth/revoke` |

MCP runs inside the API process; there is no extra service. On a normal deployment nothing needs configuring: every
URL is derived from `API_PUBLIC_URL`'s origin. The bundled nginx already routes `/mcp`, `/oauth/` and
`/.well-known/oauth-*` to the API.

| Variable | Default | Meaning |
| --- | --- | --- |
| `MCP_ENABLED` | `true` | Turn the endpoint off entirely (404). |
| `MCP_PUBLIC_URL` | `<API origin>/mcp` | The canonical resource URL tokens are bound to. Set only if agents reach the server under another URL. |
| `MCP_AUTH_ISSUER` | `<API origin>` | The OAuth issuer (returned as `iss`). |
| `MCP_ALLOWED_HOSTS` | — | Extra `Host` names `/mcp` answers on (comma-separated). The public URLs' hosts and localhost are always allowed; anything else is refused (DNS-rebinding protection). |
| `MCP_TOKEN_SECRET` | derived | Key for token fingerprints. Empty: derived from `SESSION_SECRET` with its own label, so it is never the session key. Changing it signs every agent out. |
| `MCP_ACCESS_TOKEN_TTL_MINUTES` | `15` | OAuth access token lifetime. |
| `MCP_REFRESH_TOKEN_TTL_DAYS` | `30` | Refresh token lifetime (rotated on every use). |
| `MCP_AUTH_CODE_TTL_SECONDS` | `300` | Authorization code lifetime (single use). |
| `MCP_APPROVAL_TTL_MINUTES` | `1440` | How long a parked request waits for you before it expires. |
| `MCP_BULK_APPROVAL_THRESHOLD` | `25` | A change touching more panels than this counts as sensitive. |
| `MCP_RATE_LIMIT_PER_MINUTE` | `240` | Calls per minute per connection. |
| `MCP_CIMD_ALLOW_PRIVATE` | `false` | Development only: let an OAuth client-id document live on a private address. |

## Connecting ChatGPT (OAuth)

1. In ChatGPT, add a custom connector (Developer mode → Apps & Connectors → Create; the menu names change — look for
   "custom connector" or "MCP server") with the URL `https://<your host>/mcp` and OAuth authentication.
2. ChatGPT discovers the authorization server from the 401 challenge, identifies itself with its Client ID Metadata
   Document (`https://chatgpt.com/oauth/client.json` — dynamic registration is also supported), and opens OpenManga's
   authorize page in your browser.
3. If you are not signed in, OpenManga's normal sign-in appears first; you never type your password into ChatGPT.
4. The consent page shows who is asking, what it asks for, and lets you choose: which scopes to grant (a subset is
   fine), all projects or selected ones, whether it may create projects, and "Ask me first" or "Allow everything".
   It also says plainly that provider-backed generation spends your own provider credits.
5. Allow sends you back to ChatGPT with a one-time code; ChatGPT exchanges it (PKCE S256) for a 15-minute access token
   and a rotating refresh token.

Connecting the same client again updates the existing connection (and signs out its old tokens) instead of creating a
duplicate. Revoke it any time in **Agent access**.

The authorization request is frozen when it arrives: the consent page refers to it only by id, so client, redirect
URI, PKCE challenge, resource and state cannot be changed in the browser. Redirect URIs must match a registered one
exactly; wildcards are refused.

## Other agents (personal access tokens)

**Agent access → New access token** creates a connection with the same choices as consent (scopes, projects, create
permission, approval mode) plus an expiry. The token (`om_pat_…`, 256 random bits) is shown **once**; only an HMAC of
it is stored. Use it as `Authorization: Bearer om_pat_…` with any MCP client that speaks Streamable HTTP, for example:

```json
{
  "mcpServers": {
    "openmanga": {
      "type": "http",
      "url": "https://manga.example.com/mcp",
      "headers": { "Authorization": "Bearer om_pat_…" }
    }
  }
}
```

A PAT has no OAuth step-up: a missing scope is a structured `scope_missing` error, and you widen the connection in
Agent access.

## Local and private instances

For a public ChatGPT connection (and any distributed plugin) the instance needs a stable **public HTTPS** URL:
`/mcp`, `/oauth/*`, `/.well-known/oauth-*` and `/app/*` (the consent page and sign-in). A Cloudflare tunnel (the
`tunnel` compose profile) or any HTTPS reverse proxy works. If agents use a hostname other than
`API_PUBLIC_URL`'s, set `MCP_PUBLIC_URL` and `MCP_AUTH_ISSUER` to it (and `MCP_ALLOWED_HOSTS`).

A private instance can be connected through ChatGPT's **Secure MCP Tunnel**: MCP traffic and OAuth discovery travel
through the tunnel. The authorization pages are not tunneled, though — your browser opens `/oauth/authorize` and the
consent page at the issuer's URL, and ChatGPT's servers call `/oauth/token` there. Both must reach it, or sign-in
fails even though discovery worked. (Behaviour per OpenAI's current docs; not yet exercised against this server.)

Local agents (Claude Desktop, IDE agents, the MCP Inspector, scripts) can use a PAT against
`http://localhost:3480/mcp` directly; localhost is always an allowed host.

## Scopes, projects and approval modes

Scopes are `area:action`; the full table with the tools each one unlocks is in
[MCP_TOOLS → Scopes](MCP_TOOLS.md#scopes). The granted set is the intersection of what the client asked for, what
exists, and what you ticked. Narrowing a connection applies on its **next** call: tokens carry a scope snapshot, but
the connection's current settings always win.

**Projects.** A connection sees either *all* your projects (including future ones) or *selected* ones. This is on top
of normal membership, never instead of it: an agent can only touch projects you are a member of, and unlike an
admin in the browser it gets no admin bypass. Entity ids are resolved to their project first (a panel id from a
project the connection was not granted is refused with `project_not_granted`, and one from a project you cannot see
at all is `not_found`). A selected-projects connection that may create projects is granted each project it creates or
duplicates.

**Approval modes.**

| Class | Examples | ALLOW_ALL | REQUIRE_APPROVAL |
| --- | --- | --- | --- |
| read | list/get/search, schemas, prompt preview, job status, readiness, usage | runs | runs |
| write | new story revision, draft version edits, scene/panel edits, manual answers, manual-mode text jobs | runs | runs |
| sensitive-write | apply story analysis, duplicate, switch current version, approve/lock versions and references, migrate panels, activate artwork, re-plan a planned chapter, page document replacement, chapter/project-wide lettering changes over the bulk threshold, exports, budget changes | runs | **waits** |
| spend | provider-backed text, image generation, reference generation, vision checks, expert replies, cloud TTS, retries of those, bulk generation, resuming a batch | runs | **waits** |
| delete | trash, permanent delete, deleting chapters/pages/panels/lines/versions | runs | **waits** |

Each call is classified by what it actually does (for example `run_chapter_plan` with `ai.manual` on a chapter without
pages is a write; with a provider it is spend; with `replace` over existing pages it is a re-plan). ALLOW_ALL skips
approvals only: budgets, locks, lifecycles and validation still apply.

## Approvals

A parked call returns a normal (non-error) result:

```json
{
  "ok": true,
  "status": "pending_approval",
  "approval": {
    "approvalRequestId": "…",
    "action": "panel.generate",
    "projectId": "…",
    "summary": "Generate artwork for a panel (same_prompt) with openai; spends image-provider credits",
    "sensitivity": "spend",
    "estimatedCostUsd": null,
    "expiresAt": "2026-09-25T12:00:00.000Z",
    "pollAfterSeconds": 15,
    "approvalUrl": "https://manga.example.com/app/agents?tab=pending&request=…"
  },
  "requestId": "…"
}
```

In **Agent access → Waiting for you** you see the connection, project, action, plain-English summary, sensitivity,
estimated cost and the exact stored arguments, and choose **Approve**, **Deny** (with an optional reason shown to the
agent), **Approve & always allow in this project** or **Deny & always deny in this project**. Remembered decisions are
per connection + project + action key (e.g. `project.export`, `chapter.replan`, `generation.bulk`); **Remembered
decisions** lists them to flip or delete. None of this is reachable through MCP.

Approving runs the stored call **once** (a double click cannot run it twice), after re-checking that the user and
connection are still active, the scopes and project are still granted, and the target is unchanged: the target's
state (ids, status, `updatedAt`, or for bulk generation the estimate) was fingerprinted when the request was made, and
a difference makes the request `stale` instead of running an old decision against new state. Undecided requests
expire after `MCP_APPROVAL_TTL_MINUTES`; revoking a connection expires its pending requests.

While it runs the request is `approved`. If the process dies before the outcome is recorded, the request is not left
there and not run again: after a ten-minute lease it becomes `execution_unknown`, because the side effect may already
have happened. The agent is told to re-read the target before proposing the action again. (Fully durable exactly-once
execution would need the underlying mutations to take an idempotency identity themselves; that is not built.)

The agent polls with `get_approval_request` (its own requests only): `pending`, `approved` (running now), `executed`
(with the original tool's saved result), `denied`, `expired`, `stale`, `failed` or `execution_unknown`. Only one
request waits per identical call — retrying, even simultaneously, returns the same request — and an
`idempotencyKey` is carried through, so a retry after approval returns the executed result.

## Tools

Seventy-one task-shaped tools, grouped by area; the full catalogue with schemas is [MCP_TOOLS](MCP_TOOLS.md).
There is deliberately no generic "call any endpoint" tool.

What a connection is shown depends on it. A personal access token lists only the tools it can ever call (a
read-only token sees about a dozen); tools outside that list are not callable either. An OAuth connection sees every
tool, because its scopes can grow by step-up and a client only asks for a scope when it sees the tool that needs it.
`create_project` and `duplicate_project` are hidden from any connection not allowed to create projects.

| Area | Tools |
| --- | --- |
| System | `get_server_info`, `get_answer_schema`, `describe_api`, `get_approval_request` |
| Projects | `list_projects`, `get_project`, `create_project`, `update_project`, `set_project_status`, `delete_project`, `duplicate_project`, `search_project`, `get_project_checks`, `get_project_usage` |
| Story | `get_story`, `get_story_revision`, `save_story_revision`, `run_story_analysis`, `get_story_analysis`, `edit_story_analysis`, `apply_story_analysis`, `run_story_rewrite` |
| Cast, world, style | `list_library`, `get_library_item`, `create_library_item`, `update_library_item`, `manage_library_version`, `manage_character_details`, `migrate_character_panels`, `manage_references`, `project_style` |
| Chapters | `list_chapters`, `get_chapter`, `manage_chapter`, `run_chapter_plan`, `manage_scene`, `list_chapter_panels` |
| Pages and panels | `get_page`, `manage_page`, `manage_lettering`, `get_panel`, `update_panel`, `manage_panel_outfits`, `get_panel_prompt`, `prepare_page_prompts`, `generate_panel`, `manage_panel_artwork`, `run_panel_check`, `manage_panel` |
| Images | `get_image`: the picture itself (panel artwork, the lettered page, a reference, any project image) as MCP image content, at 384, 1024 or 2048 px |
| Jobs | `list_jobs`, `get_job`, `get_manual_prompt`, `submit_manual_answer`, `control_job`, `estimate_bulk_generation`, `run_bulk_generation`, `manage_batch`, `generate_cover` |
| Narration | `get_chapter_narration`, `get_narration_status`, `edit_narration`, `run_narration_generation`, `synthesize_narration` |
| Exports | `create_export`, `list_exports` |
| Experts | `list_experts`, `manage_expert_chat`, `send_expert_message`, `answer_expert_reply`, `retry_expert_reply` |

Not exposed (UI/REST only): multipart uploads (project import, own artwork, masks, own references, expert image
attachments), masked edits (they need an uploaded mask), accounts, admin, provider keys, and managing connections,
approvals and rules.

Payloads are bounded: lists page (default 25, max 100), chapter panels are listed as summaries, story text is read
in 50,000-character chunks, a chapter's source excerpt is cut unless asked for, prompts come only from
`get_manual_prompt` / `get_panel_prompt`, the OpenAPI description only for matching operations, and answer schemas
one at a time. A 2-hour project is worked chapter by chapter.

`idempotencyKey` (optional, on tools that create things or start jobs) is claimed atomically before anything
happens, so of several calls with one key — sequential or simultaneous — only one acts. For 24 hours the same key
with the same arguments returns that call's result (or its pending approval); with different arguments it is
`idempotency_conflict`; while the first call is still running it is `operation_in_progress` (retry shortly); if the
first call was interrupted before recording its outcome it is `execution_unknown` (re-read the target; use a new key
if still needed). A call that fails frees its key, so a corrected retry can reuse it.

## Asynchronous jobs and manual (paste) mode

Tools that start AI work return the job at once (`status: queued`); OpenManga's own job system does the work. Poll
with `get_job` every few seconds — not in a tight loop. `awaiting_input` means a manual job is waiting for an answer;
`completed`, `failed` and `cancelled` are final.

Manual mode is first-class. Pass `ai: { "manual": true }` to any text operation (story analysis and rewrite, chapter
planning, prompt preparation, narration writing, panel checks, expert replies). The job compiles exactly the prompt a
provider would get and parks. Then:

1. `get_manual_prompt` — the prompt, the answer format for **this** question (a commented interface), a valid
   example, how many answers were given, the last validation error, and the images the question is about as MCP
   image content (preview size, at most four).
2. Write one JSON object that fits, and `submit_manual_answer`.
3. `get_job`: `completed`, or `awaiting_input` again — either the next question (a chapter plan asks a
   `ChapterOutline`, then one `ScenePages` per scene) or the same one with `lastError` when the answer was rejected.
   Fix only what the error names. No provider is ever used to repair a pasted answer.

`get_answer_schema` returns any of the formats (`StoryAnalysis`, `StoryRewrite`, `ChapterOutline`, `ScenePages`,
`PanelPromptDraft`, `NarrationDraft`, `ImageDescription`, `PanelCheck`) from the running version's own schemas, so a
client should prefer: a schema the user supplied > the schema this server returns > one bundled in the client.

## Spending and budgets

Provider keys are never visible through MCP; `get_server_info` lists the user's saved keys by id and kind only, and an
`ai` argument names one (`credentialId`) or a provider kind (the user's first key of that kind). Without either, the
server's default applies, which on a normal install is `credentials_required`.

Bulk image generation is two tools: `estimate_bulk_generation` (count, skips, estimated USD, provider/model, budget,
preflight, credential readiness, and an `estimateToken`) and `run_bulk_generation`, which needs that token. The run
re-estimates first; if the count, price, provider or model changed it refuses with `estimate_changed` and the new
estimate. Under REQUIRE_APPROVAL the parked request carries the estimate, and approving re-estimates again (a change
makes it stale). `MAX_BULK_PANELS` (500) still applies.

Budgets are never bypassed silently: `402 budget_exceeded` comes back as an error. `allowOverBudget: true` on
`run_bulk_generation` is only for an explicit user choice; it has its own action key
(`generation.bulk_over_budget`), so remembering "allow bulk generation" does not also allow going over budget.

## Results and errors

Success: `{ ok: true, status: "completed", data, requestId, links? }` — `links` are deep links into the app (project,
chapter, page, panel, job, exports, approval). The same JSON is also sent as text for clients that do not read
structured content.

Errors are tool results with `isError: true` and `{ ok: false, error: { code, message, status, details?, requestId,
retryAfterSeconds? } }`, keeping OpenManga's own codes:

| Status | Codes | Meaning |
| --- | --- | --- |
| 400 | `bad_request` | Malformed request; `details` says what. |
| 401 | — | Not a tool error: `/mcp` answers HTTP 401 with `WWW-Authenticate: Bearer resource_metadata="…"` (and `error="invalid_token"` for a bad or expired token), so the client signs in again. |
| 402 | `budget_exceeded` | The project budget would be exceeded. |
| 403 | `scope_missing` | The connection lacks a scope. For OAuth connections the result carries `_meta["mcp/www_authenticate"]` with an `insufficient_scope` challenge naming the scopes to ask for. |
| 403 | `project_not_granted`, `forbidden`, `approval_denied_by_rule` | Project not granted to this connection; not allowed (e.g. creating projects); the user always denies this action here. |
| 404 | `not_found` | Missing, or in a project you cannot see (never distinguished). |
| 409 | `conflict`, `idempotency_conflict`, `estimate_changed`, `operation_in_progress`, `execution_unknown` | Locked/approved version, wrong lifecycle state, job not in the expected state, reused key, stale estimate, the same key still running, an interrupted call whose outcome is unknown. |
| 422 | `validation_error`, `credentials_required`, `provider_*` | Input validation (with details), no usable key, provider refusal. |
| 429 | `rate_limited` | With `retryAfterSeconds`. |
| 5xx | `internal_error`, `provider_*` | Sanitized; never a stack trace or raw provider response. |

## Security notes

- Tools call OpenManga's own route handlers in-process, on a private router never mounted publicly, as the
  connection's user with its project restriction applied in the shared access check. Accounts, admin, the dev mailbox
  and provider-key routes are refused on that router even if a tool asked.
- `/mcp` accepts only Bearer tokens (never the browser session) and so needs no CSRF; consent, approvals and
  connection management are ordinary session + CSRF endpoints under `/api/agents`.
- Tokens, codes and PATs are opaque, stored only as HMACs, and never logged or written to audit metadata. Access
  tokens are bound to client, connection, resource, scopes and expiry. A disabled user or a revoked connection stops
  working on the next call.
- Refresh tokens rotate; presenting a used one revokes the whole family and its access tokens and records
  `oauth.refresh_reuse`. Presenting a used authorization code revokes what it produced.
- Client ID Metadata Documents are fetched over HTTPS only, from public addresses only (every resolved address is
  checked), and the connection is pinned to the checked address — TLS still verifies the certificate against the
  hostname — so a rebinding DNS server cannot switch the address between the check and the fetch. No redirects, a
  64 KB cap, a 5 s timeout, re-fetched daily.
- Audit: every mutation is recorded as usual with `service_id` set and `metadata.via` = the connection name
  ("*connection* via *user*"). Security events: `oauth.authorize`, `oauth.reauthorize`, `oauth.refresh_reuse`,
  `oauth.code_reuse`, `mcp.pat_created`, `mcp.pat_revoked`, `mcp.connection_revoked`, `mcp.connection_updated`,
  `mcp.approval_requested/approved/denied/executed/stale`, `mcp.scope_denied`, `mcp.project_denied`,
  `mcp.rule_changed/deleted`, and `project.delete_permanent`.
- DNS rebinding: `/mcp` answers only allowed `Host` names and refuses browser `Origin`s other than the app and ChatGPT.

## Example sessions

Calls are shown as `tool(arguments) → result` with results trimmed.

### A. A new project from a story, in paste mode (no provider keys)

```text
get_server_info() → { connection: { approvalMode: "ALLOW_ALL", allowProjectCreate: true }, ai: { savedKeys: [] } }
create_project({ title: "The Lamp at Vell", format: "comic" }) → { project: { id: "p1" } }
save_story_revision({ projectId: "p1", content: "Ines repairs lighthouses…" }) → { revision: { id: "r1" } }
run_story_analysis({ revisionId: "r1", ai: { manual: true } }) → { analysis: { id: "a1" }, job: { id: "j1", status: "queued" } }
get_job({ jobId: "j1" }) → { job: { status: "awaiting_input", next: "Call get_manual_prompt, then submit_manual_answer." } }
get_manual_prompt({ jobId: "j1" }) → { format: { name: "StoryAnalysis", interface: "interface StoryAnalysis { … }" }, example: "{…}", awaitingAnswer: true }
submit_manual_answer({ jobId: "j1", answer: { title: "The Lamp at Vell", characters: [ … ], chapters: [ … ] } }) → { accepted: true }
get_job({ jobId: "j1" }) → { job: { status: "completed" } }
apply_story_analysis({ analysisId: "a1" }) → { created: { characters: 2, locations: 1, props: 1, chapters: 3 } }
list_chapters({ projectId: "p1" }) → { chapters: [ { id: "c1", title: "The Lamp", stats: { pages: 0 } }, … ] }
run_chapter_plan({ chapterId: "c1", ai: { manual: true } }) → { job: { id: "j2" } }
get_manual_prompt({ jobId: "j2" }) → { format: { name: "ChapterOutline" }, answered: 0 }
submit_manual_answer({ jobId: "j2", answer: { scenes: [ … 3 scenes … ] } })
get_manual_prompt({ jobId: "j2" }) → { format: { name: "ScenePages" }, answered: 1 }      // scene 1
submit_manual_answer({ jobId: "j2", answer: { pages: [ … ] } })
get_manual_prompt({ jobId: "j2" }) → { format: { name: "ScenePages" }, answered: 2 }      // scene 2
submit_manual_answer({ jobId: "j2", answer: { pages: [ … ] } })
…                                                                                         // scene 3
get_job({ jobId: "j2" }) → { job: { status: "completed" } }
list_chapter_panels({ chapterId: "c1", limit: 25 }) → { items: [ … ], total: 18, nextOffset: null }
prepare_page_prompts({ pageId: "pg1", ai: { manual: true } }) → { job: { id: "j3" } }   // optional; answer a PanelPromptDraft the same way
run_narration_generation({ chapterId: "c1", ai: { manual: true } }) → { job: { id: "j4" } }
get_manual_prompt({ jobId: "j4" }) → { format: { name: "NarrationDraft" } }
submit_manual_answer({ jobId: "j4", answer: { lines: [ … ] } })
synthesize_narration({ chapterId: "c1" }) → { … audio jobs … }                           // local voice: free
```

### B. Fixing panels under REQUIRE_APPROVAL

```text
list_chapter_panels({ chapterId: "c1" }) → { items: [ { id: "pn7", review: { reason: "headcount" } }, … ] }
get_panel({ panelId: "pn7" }) → { panel: { storyBeat: "Ines alone at the lamp", characterVersionIds: ["v-ines", "v-tomas"] }, specs: [ … ] }
update_panel({ panelId: "pn7", characterVersionIds: ["v-ines"], storyBeat: "Ines alone at the lamp, 3 a.m." })
  → { status: "completed" }                                                               // ordinary write: runs
generate_panel({ panelId: "pn7", ai: { credentialId: "k-openai" }, idempotencyKey: "fix-pn7-1" })
  → { status: "pending_approval", approval: { approvalRequestId: "ar1", sensitivity: "spend",
      summary: "Generate artwork for a panel (same_prompt) …; spends image-provider credits", approvalUrl: "…/app/agents?tab=pending&request=ar1" } }
   // the agent tells the user: "Regenerating panel 7 needs your approval: <approvalUrl>"
get_approval_request({ approvalRequestId: "ar1" }) → { status: "pending", pollAfterSeconds: 15 }
   // the user clicks Approve; the server re-checks the panel is unchanged and runs the stored call once
get_approval_request({ approvalRequestId: "ar1" }) → { status: "executed", result: { data: { job: { id: "j9", status: "queued" } } },
                                                       next: "The action ran. Continue from `result`; do not call the original tool again." }
get_job({ jobId: "j9" }) → { job: { status: "processing" } } … → { job: { status: "completed" } }
```

### C. Denied, and remembered

```text
set_project_status({ projectId: "p1", action: "trash" })
  → { status: "pending_approval", approval: { approvalRequestId: "ar2", action: "project.trash", sensitivity: "delete" } }
   // the user chooses "Deny & always deny in this project", reason "keep it"
get_approval_request({ approvalRequestId: "ar2" }) → { status: "denied", decisionReason: "keep it",
                                                       next: "The user denied this. Respect it and do not retry the same action." }
set_project_status({ projectId: "p1", action: "trash" })   // later, same connection, project and action
  → isError: { code: "approval_denied_by_rule", status: 403 }                             // at once; no new request is created
```

The user can flip the rule to "always allow" or delete it under **Agent access → Remembered decisions**. These three
flows are exercised by `tests/integration/mcp.test.ts`.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| 403 `Invalid Host header` (or `Missing Host header`) on `/mcp` | The request's `Host` is not the API's public host; add it to `MCP_ALLOWED_HOSTS` or set `MCP_PUBLIC_URL`. |
| ChatGPT says the server has no OAuth | `/.well-known/…` is not reaching the API (proxy config), or `MCP_ENABLED=false`. |
| Consent page says the request is no longer valid | Authorization requests live 10 minutes and can be answered once; start connecting again from the client. |
| `invalid_scope` on authorize/token | A requested scope does not exist, or a refresh asked for a scope outside the original grant (a refresh can only narrow it). |
| `invalid_target` on authorize/token | The client's `resource` is not the canonical `MCP_PUBLIC_URL` (check scheme, host, and no trailing path). |
| `invalid_grant` "Refresh token already used" | The refresh token was replayed (or two clients shared it); the grant was revoked for safety. Reconnect. |
| Every write says `scope_missing` | The connection was granted read scopes only; widen it in Agent access (OAuth clients can also re-consent). |
| `project_not_granted` | A selected-projects connection; add the project in Agent access → Edit. |
| Nothing happens after `pending_approval` | Someone has to decide in Agent access → Waiting for you; requests expire after `MCP_APPROVAL_TTL_MINUTES`. |
| `credentials_required` | No provider key named: use `ai: { manual: true }` for text, or add a key in Account → AI providers. |
