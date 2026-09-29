# Extending OpenManga

Recipes for the eight things contributors usually want to add. Each one traces an existing example, so you can open
the file next to the checklist and copy the shape that is already there.

Read [AGENTS.md](../AGENTS.md) first — the invariants listed there are what these recipes are designed to keep. Line
numbers are anchors, not promises; grep the symbol name if a file has moved on.

Two conventions worth knowing before you start:

- **Kind/name unions are plain TypeScript, and most of the lists that consume them are not exhaustive.** A `switch`
  without a `default` is checked by the compiler; a `Record<string, …>` lookup with `?? []` is not. Each recipe says
  which of its steps the compiler will catch for you and which fail silently at runtime.
- **`kind` columns are `text`, not Postgres enums.** Adding a new generation kind or export kind needs no migration.

---

## 1. Add a text, image or TTS provider

There are no server-held provider keys. A provider is reachable only through a credential a user saved, so "adding a
provider" means teaching the catalog about it, writing the wire adapter, and wiring the credential resolver to build it.

| Concern | Owner | Notes |
| --- | --- | --- |
| Which providers exist, their base URL, suggested models, capabilities | `packages/domain/src/providers.ts` | Browser-safe; drives the API enum *and* the web picker |
| Text wire format | `packages/ai-text` | `TextAIProvider` |
| Image wire format | `packages/ai-image` | `ImageAIProvider` |
| Voice wire format | `packages/audio` | `TTSProvider` |
| Key validation + verification | `packages/services/src/credentials.ts` | `CredentialService` |
| Build the provider for a run | `packages/services/src/providers.ts` | `ProviderResolver` |
| Pricing | `packages/domain/src/cost.ts` + `provider_rate_snapshots` | Seeded, then editable by an admin |

Invariant 1 is the hard line: **only `packages/ai-text`, `packages/ai-image` and `packages/audio` may contain request
or response shapes.** If the API, worker or web needs to know a provider's endpoint path, header name or JSON keys, the
adapter is in the wrong place.

### Checklist

1. **`packages/domain/src/providers.ts` — add the `ProviderKind` and a `PROVIDER_CATALOG` entry.**

   ```ts
   export type ProviderKind =
     | "deepseek"
     | "openai"
     …
     | "openai_compatible";
   ```

   The entry carries `label`, `baseUrl` (the default a credential inherits when the user gives none), `keyUrl`, and the
   three suggested model lists. `providerSupports(kind, cap)` derives capability from *whether the matching model list
   is non-empty* — so a text-only provider must leave `imageModels` and `ttsModels` as `[]`, and an image-only provider
   with a populated `textModels` list will be offered for text runs and then fail. `openai_compatible` is the one
   exception: it claims every capability because the call itself is the only way to find out.

   This one edit is also the entire API and web surface:
   - `apps/api/src/routes/ai.ts:13` builds its Zod enum from the catalog
     (`const KINDS = PROVIDER_CATALOG.map((p) => p.kind)`), so `POST /api/ai/credentials` accepts the new kind
     immediately.
   - `apps/web/src/features/ai/AiPicker.tsx` renders the "add a key" `<select>` from `PROVIDER_CATALOG` and the model
     datalist from `providerCatalog(cred.kind)`. **Nothing to add in the web app.**

2. **Write the adapter in the owning package.** Implement the interface and nothing else:

   | Capability | Interface | Declared in |
   | --- | --- | --- |
   | Text | `TextAIProvider` — `generateText`, `generateStructured` | `packages/ai-text/src/index.ts:54` |
   | Image | `ImageAIProvider` — `sizeFor`, `generate`, `edit` | `packages/ai-image/src/index.ts:68` |
   | Voice | `TTSProvider` — `health`, `voices`, `synthesize` | `packages/audio/src/index.ts` |

   Follow the nearest existing shape rather than starting from scratch:
   - **OpenAI-compatible chat** — reuse `OpenAIChatTextProvider` (`packages/ai-text/src/meta.ts`) by passing a kind and
     label; no new class needed. `google`, `openrouter`, `openai` and `openai_compatible` all do this.
   - **A genuinely different text protocol** — `AnthropicTextProvider` (`packages/ai-text/src/anthropic.ts`) is the
     model: it hoists system messages into a top-level `system` field and assembles streamed deltas into the same
     `TextResult`.
   - **An OpenAI-shaped image API** — extend `JsonImageProvider` in `packages/ai-image/src/compat.ts`, which already
     supplies the retrying, concurrency-limited POST. `MetaImageProvider` and `OpenRouterImageProvider` do.
   - **A non-OpenAI image API** — `GeminiImageProvider` (`packages/ai-image/src/gemini.ts`) is standalone.
   - **Cloud voice** — extend `CloudTTS` in `packages/audio/src/cloud.ts` and implement `request()`; return raw PCM and
     let `pcmToWav` wrap it. Every voice provider must hand back **24 kHz mono WAV** so segments concatenate with
     Kokoro output — that is what `SynthesizeResult.wav` means.

   Three things every adapter must get right:
   - **Errors become `ProviderError`** (`packages/domain/src/provider.ts`) with one of the `ProviderErrorCode` values.
     The code decides whether the queue retries: `RETRYABLE` covers `timeout`, `rate_limited`, `server_error`,
     `network`, `invalid_response`, `offline`, `model_loading`. Use `classifyHttpStatus` and `classifyFetchError`
     rather than inventing a mapping, and map a safety refusal to `content_policy` (non-retryable at the provider
     level; see §4 for what the runner then does with it).
   - **Report usage honestly.** `TextCallRecord` and `ImageUsage` feed `UsageService.record`. Split cached input
     tokens out of the total — `estimateCostUsd` treats `cachedInputTokens` as a subset of `textInputTokens`.
   - **Wrap calls in `ConcurrencyLimiter` and `withRetry`** from `@openmanga/domain/browser`, the way every existing
     adapter does. The limiter instance is shared per key+model by the resolver's cache, which is how one user's
     rate-limit cooldown is honoured across their concurrent jobs.

3. **`packages/services/src/providers.ts` — add a `case` to `byokText`, `byokImage` or `byokTts`.** These (and the
   batch twins below) are the only places that construct a provider. The base URL resolution order is fixed:

   ```ts
   const base = cred.baseUrl ?? providerCatalog(kind)?.baseUrl ?? "";
   ```

   The `default:` arm already throws a non-retryable `invalid_request` ("… does not generate images"), so a kind you
   forget here fails clearly instead of silently.

   **Provider batch APIs (optional).** Half-price batch runs go through `byokTextBatch` / `byokImageBatch` in the same
   file, which build a `TextBatchProvider` (`packages/ai-text/src/batch.ts`) or `ImageBatchProvider`
   (`packages/ai-image/src/batch.ts`); only `openai` and `google` have one today. Their `default:` returns `null`
   ("no batch API"). Which providers the API lets a run batch at all is `BATCH_CAPABLE_PROVIDERS` in
   `packages/domain/src/cost.ts` (a batch request for any other provider is refused with 400); add the kind there too.

4. **`packages/services/src/credentials.ts` — teach `fetchModels` how to list models.** `CredentialService.create`
   verifies a key by listing models *before* storing it, so a provider whose listing branch is missing will fall into
   the final `else` (`GET {base}/models` with `authorization: Bearer …`) and reject valid keys with
   "model list failed". The existing branches are `elevenlabs` (`xi-api-key`), `anthropic`
   (`?limit=1000` + `anthropic-version`), `google` (`x-goog-api-key`, `models` array with
   `supportedGenerationMethods`), and the OpenAI-shaped default. `listModels` then merges the result with the catalog's
   suggestions and splits them by capability using the `isImage`/`isTts` id heuristics — add your model naming to those
   regexes if ids like `…-image-…` do not appear in them.

   **If your provider takes a user-supplied base URL**, it must go through `assertPublicHttpsUrl`. That helper enforces
   HTTPS, no embedded credentials, and resolves the host to reject private, loopback, link-local, CGNAT and
   unique-local addresses. It exists because these URLs are fetched from inside the compose network; skipping it turns
   a credential form into an SSRF hole against Postgres and Redis. Today only `openai_compatible` accepts a base URL
   (`create()` sets `baseUrl` to `null` for every other kind).

5. **`packages/domain/src/cost.ts` — add a `DEFAULT_RATE_SNAPSHOTS` entry per model you price.** Token rates are **USD
   per 1M tokens**; `imageUnitRate` is **USD per generated image**. `BATCH_RATE_SNAPSHOTS` in the same file derives
   half-price batch rates from these entries for `BATCH_CAPABLE_PROVIDERS`; both are seeded.

   **What happens with no rate snapshot:** nothing breaks and nothing is charged. `UsageService.record` calls
   `rateFor(provider, model)`, `selectRate` returns `null`, and `estimateCostUsd` returns `0` — the `ai_usage` row is
   written with real token counts, `rate_snapshot_id: null` and `estimated_cost_usd: 0.00000000`. So the run works, the
   dashboard under-reports, and the project budget cap never trips for that model. Seeding a rate is therefore about
   accounting, not function.

   Seeding is one-way and per (provider, model): `bootstrapReferenceData` **skips** any pair that already exists, so
   editing a seeded number in code does not update a deployed database. Correct a price by adding a *new* snapshot with
   a later `effectiveFrom` — through `POST /api/admin/rates` (`apps/api/src/routes/admin.ts`) or a new seed entry on a
   fresh install. `selectRate` picks the latest snapshot effective at the call's timestamp, so history stays intact.

6. **Flat-per-image providers need two extra edits.** A token-billed image provider bills input pixels; a flat-rate one
   charges per image and input size is free. The difference shows up in cost *and* in what we send:

   | | Token-billed (OpenAI, Gemini) | Flat-per-image (Meta) |
   | --- | --- | --- |
   | Rate fields | `imageInputRate` / `imageOutputRate` | `imageUnitRate`, token rates `0` |
   | Usage field | `imageInputTokens` / `imageOutputTokens` | `images` |
   | Reference derivative box | `REFERENCE_MAX_WIDTH` × `REFERENCE_MAX_HEIGHT` (192×288) | `FLAT_RATE_REFERENCE_MAX_WIDTH` × `…HEIGHT` (768×1152) |

   Add the provider string to `FLAT_RATE_IMAGE_PROVIDERS` in `packages/services/src/assets.ts:34`, which
   `AssetService.referenceParams` consults to pick the box. Invariant 2 still holds either way: the canonical reference
   is never modified, requests carry small cached derivatives, and **edit targets and masks are always sent at full
   resolution** regardless of the provider's billing model.

7. **Mocks.** There are two levels and they behave differently:
   - **In-process fakes** (`AI_MOCK_MODE=true`, and every unit/integration test): `FakeTextAIProvider`,
     `FakeImageAIProvider`, `FakeTTSProvider`. `ProviderResolver.resolve` short-circuits to these *before* it builds
     anything real, so a new provider needs no fake — mock mode still stores the key unverified and runs the fakes.
   - **`apps/mock-ai`**: an HTTP service speaking the OpenAI/DeepSeek wire format, for exercising real adapter code.
     It serves `/chat/completions`, `/v1/chat/completions`, `/v1/images/generations` and `/v1/images/edits`, plus
     `/__mock/scenario` and `/__mock/reset`. Extend it only if your adapter's shape differs enough to be worth testing
     over HTTP.

   Failure scenarios are shared: put `[[mock:429]]` (or `500`, `timeout`, `auth`, `quota`, `policy`, `invalid-json`,
   `schema-invalid`, `repairable`, `bad-image`, `slow`, …) in any prompt or story. `scenarioFromText` in
   `packages/testing` parses it; both the fakes and `mock-ai` honour it. See `docs/TESTING.md`.

8. **Tests.** Adapter tests mount a `fetch` stub and assert the request body, the usage mapping and the error codes —
   `packages/ai-text/src/ai-text.test.ts` (DeepSeek, Meta, Anthropic), `packages/ai-image/src/ai-image.test.ts`,
   `packages/audio/src/audio.test.ts`. At minimum cover: the request shape, one retryable status, one non-retryable
   status, and the usage numbers.

---

## 2. Add or change a prompt

All prompt text lives in `packages/prompts`. No prompt strings anywhere else — `docs/PROMPT_SYSTEM.md` describes the
compiled sections; this section is only about editing the registry.

### Checklist

1. **Pick the file.** Text templates: `packages/prompts/src/templates.ts` (helpers in `text-templates.ts`; the expert
   chat templates are in `experts.ts`). Image templates: `packages/prompts/src/image-templates.ts`.

2. **Define the template.** Text templates go through `defineTextTemplate`, must start their system message with
   `templateHeader(name, version)`, must end with `schemaInstructions(SchemaName, Schema)`, must include `DATA_RULE`,
   and must wrap every piece of user content in `untrusted(tag, content)`:

   ```ts
   export const storyAnalysisV2 = defineTextTemplate<Parameters<typeof storyAnalysisV1.build>[0]>({
     name: "story-analysis",
     version: 2,
     description: "…",
     system: [templateHeader("story-analysis", 2), …, DATA_RULE, schemaInstructions("StoryAnalysis", StoryAnalysis)]
       .join("\n\n"),
     build(i) { … },
   });
   ```

   Invariant 9 is enforced by `untrusted()`, which neutralises attempts to close the delimiter tag. Interpolating story
   text into the system message instead is a prompt-injection hole, and `DATA_RULE` is the only thing telling the model
   which tags are data.

   Image templates are plain objects of type `ImageTemplate<I>` with a `compile(input): string`.

3. **Bump the version — do not edit a released body.** Every job row stores `template_name`, `template_version` and
   the final `compiled_prompt`, so old generations stay traceable. `bootstrapReferenceData` inserts a `prompt_versions`
   row per (template, version) and, if it finds the same version with a different `sha256`, **logs
   `"prompt template body changed without a version bump"` and overwrites the stored body** — which is exactly the
   traceability loss the version exists to prevent.

   The two template families bump differently, which is easy to get wrong:

   | | Text | Image |
   | --- | --- | --- |
   | How to bump | Add a **new export** (`chapterPlanningV7`) and append it to `TEXT_TEMPLATES`, leaving the old exports registered | Increment `version` **in place** on the existing export and edit its body |
   | Old versions in code | Kept and still registered (`narration` has v1–v5 live) | Not kept — only the current body exists |

   So `characterReferenceV1` is at `version: 5` and `panelGenerationV1` at `version: 8`: the `V1` in those export names
   is historical and means nothing. Old image `prompt_versions` rows survive in the database, but the previous body is
   not recoverable from the repo.

4. **Point the caller at the new version.** The registry holds every version; the *live* one is whichever the caller
   imports. Nothing selects it automatically. Update both sides or the job will record the wrong template:
   - `apps/worker/src/handlers/text.ts` builds the messages (`storyAnalysisV3.build(…)`, the one-call plan
     `shotPlanningV3` / `stripPlanningV2` / `chapterPlanningV6` by format, the scene-by-scene passes
     `chapterOutlineV2` + `scenePagesV2` and their strip/shot twins, `panelPromptsV4`, `narrationV5`).
   - The API route that *creates* the job stamps `templateName` / `templateVersion` on the row —
     `apps/api/src/routes/stories.ts`, `chapters.ts`, `pages.ts`, `audio.ts` (narration text), `vision.ts`,
     `generations.ts` (the YouTube package text).
     Forgetting this makes the row claim a version that never ran.

5. **Mock providers need no change for a version bump.** `mockTextCompletion` in `packages/testing/src/mock-text.ts`
   reads the template name out of the header, strips the `-vN` suffix, and routes by name:

   ```ts
   // Route by template name so version bumps don't need mock changes (versions with a different contract below).
   const name = tpl.replace(/-v\d+$/, "");
   ```

   Add a `byName` entry only when introducing a new template *name*, and a dedicated `case` only when a new version
   changes the output contract (which is why `narration-v1` is routed separately from v2+).

6. **Validate the output with Zod.** The contract belongs in `packages/schemas` (`story.ts`, `planning.ts`,
   `editor.ts`, `interchange.ts`, `vision.ts`), exported as both a schema and an inferred type:

   ```ts
   export const ChapterPlan = z.object({ … });
   export type ChapterPlan = z.infer<typeof ChapterPlan>;
   ```

   `schemaInstructions` serialises the same schema into the prompt via `z.toJSONSchema`, so the model is told exactly
   what is validated. The pipeline is `runStructured` in `packages/ai-text/src/index.ts`: **extract → validate → one
   repair → fail clearly**. `extractJson` tolerates prose, code fences, trailing commas and a truncated response;
   validation failure triggers exactly one repair call built by `jsonRepairV1`; a second failure throws
   `StructuredOutputError` carrying the call records so the tokens are still billed. Invariant 6 means: do not add a
   second repair, and do not add a fallback that accepts unvalidated output. Handlers get this by calling the shared
   `structured()` helper in `apps/worker/src/handlers/text.ts`, which also stores the compiled prompt on the job.

   **If the answer can be pasted by hand (manual mode)**, register the schema in `ANSWER_SCHEMAS` and give every field
   a line in `ANSWER_FIELD_DOCS` (`packages/schemas/src/answer-docs.ts`), plus `ANSWER_ASKED_BY` in
   `answer-reference.ts`. That is what a parked job's answer format (in the app and MCP `get_manual_prompt`),
   MCP `get_answer_schema` and
   [ANSWER_FORMATS](ANSWER_FORMATS.md) show. Regenerate that doc with `bun scripts/answer-formats.ts`;
   `answer-docs.test.ts` fails while a field is undocumented or the committed doc is stale.

7. **Tests.** `packages/prompts/src/prompts.test.ts` asserts that `name@version` pairs are unique across
   `allTemplateRecords()`, that story content stays inside its delimiters, and that old versions remain registered
   (`narration` v1–v5). A new template name or version should get the same treatment.

---

## 3. Add an export kind

Exports are deterministic compositions — no AI (invariant 7). Six places name a kind; the compiler checks two of them.

### Checklist

1. **`packages/db/src/schema/jobs.ts` — add the value to `ExportKind`.** No migration: `export_jobs.kind` and
   `exports.kind` are `text` columns with `.$type<ExportKind>()`. The type is re-exported from `@openmanga/db/types`
   for the web app.

2. **`apps/worker/src/handlers/export.ts` — add a `case` to the `switch (job.kind)` inside `buildExport`.** This is the
   compiler-enforced step: `buildExport` returns `Promise<OutFile[]>` and the switch has **no `default:`**, so a new
   `ExportKind` without a case makes the end of the function reachable and `tsc --noEmit` fails. The pairing works both
   ways, which is why steps 1 and 2 cannot drift.

   Return `OutFile[]`:

   ```ts
   type OutFile = { name: string; mime: string; width?: number; height?: number; durationMs?: number } & (
     | { data: Uint8Array }
     | { path: string }
   );
   ```

   `{ data }` is in-memory bytes; `{ path }` is a file already on disk. **Large outputs stream to disk** — multi-file
   exports build through `ZipWriter` (`apps/worker/src/lib/zip.ts`, stored uncompressed, only the current entry in
   memory) and return `{ path: await zip.close() }`; video exports return the rendered file's path. An entry too large
   for memory goes in with `zip.addStream(name, stream)` from `deps.assets.storage.stream(key)`, as `youtube_package`
   does with the video it repackages. Single small
   outputs (a PDF, a timeline JSON, an `.srt`) return `{ data }`. `AssetService.store` accepts the same
   `{ data } | { filePath }` split, so either one is stored without a round trip through memory.

   Everything runs inside `withTempDir(deps.config.TEMP_ROOT, …)` and receives `dir`. A `{ path }` pointing outside
   `dir`, or a file created after the callback returns, produces an asset row pointing at a deleted file.

   Call `progress(p)` as you go. That helper is not only the progress bar: it writes `export_jobs.progress`, publishes
   an `export.updated` event, and throws `ExportCancelled` if the row came back as `cancel_requested`. **A kind that
   never calls `progress()` cannot be cancelled mid-run.**

3. **`packages/services/src/readiness.ts` — add the kind to `EXPORT_AREAS`.** An "area" is a content domain the kind
   depends on; there are exactly two, `art` and `narration`, declared on `ReadinessIssue.area`.

   ```ts
   export const EXPORT_AREAS: Record<Exclude<ExportKind, "project_import">, ("art" | "narration")[]> = {
     png_pages: ["art"],
     …
     video_panels: ["art", "narration"],
   };
   ```

   The key type is every `ExportKind`, so the compiler asks for the entry. Choose the areas carefully: they decide
   which readiness issues block the export (`issuesForExport`), and a kind given too few ships blank panels or silent
   narration while reporting success. Use `[]` deliberately (as `project_json` does) when a kind genuinely depends on
   nothing.

4. **`apps/api/src/routes/exports.ts` — add the value to the `kind` enum in `ExportOptions`.** This Zod schema is both
   the runtime validator and the OpenAPI body (`openApiSpec` runs `z.toJSONSchema` over it), so there is no separate
   docs edit. Nothing in the type system links `z.enum([…])` to `ExportKind`; forget it and every POST for the new kind
   is rejected 400.

   Two more things in this file:
   - Per-kind option buckets (`pdf`, `webtoon`, `audio`, `video`) live on the same schema. The worker re-declares them
     as a local `Opts` type and casts the job's `options` to it — the cast is unchecked, so an option added to the Zod
     schema but not to `Opts` is silently `undefined` in the worker.
   - There is a **hardcoded chapter-required list** in the POST handler
     (`["png_pages", "jpg_pages", "pdf", "cbz", "epub", "webtoon", "narration_audio", "timeline"]`). A
     chapter-scoped kind missing from it is accepted with no `chapterId` (or `pageIds`), then fails in the worker with
     `UnrecoverableError("No pages to export")` — a 202 followed by a failed job instead of a 400.
   - MCP's `create_export` (`apps/api/src/mcp/tools/exports.ts`) takes this same schema, so agents can request the
     new kind at once; add it to the kinds its `description` lists, then regenerate [MCP_TOOLS](MCP_TOOLS.md) with
     `bun scripts/mcp-docs.ts` (`catalogue.test.ts` fails while the committed file is stale).

   The route returns `202 { job }`, never a file. Downloads go through the CDN asset route
   (`apps/api/src/routes/assets.ts`, `cdnRoutes.get("/a/:id")`), which authorizes, then hands off to nginx with
   `X-Accel-Redirect` (invariant 10). Nothing to add there.

5. **`apps/web/src/features/exports/ExportsPage.tsx` — add an entry to `KINDS` (line 23).**

   ```ts
   const KINDS = [
     { value: "png_pages", label: "PNG page sequence", chapter: true },
     …
   ] as const;
   ```

   `chapter: true` shows the chapter picker. `needsChapter` does `KINDS.find(…)!.chapter` — a non-null assertion, so a
   kind that reaches this page from elsewhere without a `KINDS` entry is a runtime crash, and the job list falls back
   to the raw snake_case value.

   The same file keeps `AREAS`, a **client-side duplicate of `EXPORT_AREAS`** (it exists because
   `packages/services` is server-only) used for the readiness preview, plus a `USES_LANGUAGE` set and `isVideo()`.
   Forgetting `AREAS` makes the sidebar promise "nothing missing" immediately before the POST returns
   409 `export_not_ready`.

   No web type change: `ExportListItem` in `apps/web/src/api/types.ts` is derived from the DB row types.

6. **Optional but recommended:** add the kind to the integration loop in `tests/integration/flow.test.ts` (which
   asserts output magic bytes) and to `scripts/smoke.ts`. Neither fails if you skip it, so a new kind is untested
   until you do.

---

## 4. Add a queued job type

Long AI work always goes through the queue, and a job row is always written with its outbox row in the same
transaction (invariant 8). Three job families exist: **generation jobs** (`generation_jobs`, 17 kinds, one shared
runner), **audio jobs** (`audio_jobs`), and **export jobs** (`export_jobs`, §3).

### The outbox rule

`JobService` (`packages/services/src/jobs.ts`) never touches Redis. It takes a transaction from the caller and writes
the job row, its inputs and the outbox row together:

```ts
await addToOutbox(tx, {
  queue,
  jobName: j.kind,
  jobId: job!.id,
  payload: { jobId: job!.id, kind: j.kind },
  priority: j.priority,
});
```

`addToOutbox` is `onConflictDoNothing()` against `uniqueIndex("outbox_job_uq").on(queue, jobId)`, which is what makes
enqueueing idempotent. `OutboxDispatcher` (worker loop every second, plus an API "kick" after commit) publishes
pending rows with `FOR UPDATE SKIP LOCKED` and `jobId = <job row id>`, so BullMQ dedupes too. Never call
`queue.enqueue` from a route: a crash between commit and enqueue would strand the job, and a crash the other way would
run a job whose row does not exist.

The producer side is always the same three lines:

```ts
await deps.db.transaction(async (tx) => { …; await deps.jobs.createGenerationJob(tx, { … }); });
await deps.jobs.kick();
return c.json({ job }, 202);
```

### Checklist — a new generation kind (the common case)

1. **`packages/db/src/schema/jobs.ts` — add the value to `GenerationKind`.** No migration needed (`kind` is `text`).

2. **`packages/services/src/jobs.ts` — add the kind to `QUEUE_FOR_KIND`.** It is
   `Record<GenerationKind, QueueName>`, so the compiler catches a missing entry.

   ```ts
   export const QUEUE_FOR_KIND: Record<GenerationKind, QueueName> = {
     story_analysis: "text-ai",
     …
     panel_edit: "image-edit",
     …
     image_batch_submit: "image-batch",
     text_batch_submit: "image-batch",
   };
   ```

   The chosen queue is also stored on the row (`generation_jobs.queue`); cancel, pause and queue reconciliation all
   read it from there.

3. **Write the handler** in `apps/worker/src/handlers/*.ts` with the signature
   `(deps: WorkerDeps, job: GenerationJob) => Promise<Record<string, unknown>>`. The returned object is stored in
   `generation_jobs.result`. Inside a handler:
   - Resolve the provider with `deps.resolver.forJob("text" | "image", job)` — it reads the run's stored
     `parameters.ai` choice, so retries use the same key and model (invariant 1).
   - For text, call the shared `structured()` helper in `handlers/text.ts` rather than the provider directly; it
     records usage, stamps the provider request id and stores the compiled prompt.
   - Poll `isCancelRequested(deps, job.id)` between expensive steps and `throw new JobCancelledError()`. Cancelled
     output is never activated (invariant 5).
   - Throw `InputError` for "the thing this job referenced is gone" — it classifies as `invalid_input` and does not
     retry.
   - Publish a domain event with `deps.events.publish(projectId, …)` for anything the SPA shows.

4. **`apps/worker/src/processors.ts` — register the handler in `GENERATION_HANDLERS`.** Also
   `Record<GenerationKind, …>`, so this is compiler-checked. A text kind that should be able to run in a provider
   batch also goes in `TEXT_HANDLERS` (`apps/worker/src/handlers/text-handlers.ts`): the batch submitter harvests each
   job's request by running the handler from that map.

   ```ts
   export function generationProcessor(deps: WorkerDeps) {
     return (job: Job) =>
       runGenerationJob(deps, job, (g) => {
         const handler = GENERATION_HANDLERS[g.kind];
         if (!handler) throw new Error(`No handler for ${g.kind}`);
         return handler(deps, g);
       });
   }
   ```

5. **Add the producer** — a route that creates the job in a transaction and kicks the dispatcher, as above. Pick a
   priority from `PRIORITY` in `packages/domain/src/permissions.ts`
   (`interactive: 1, single: 2, page: 5, chapter: 8, maintenance: 10`).

6. **Nothing else.** `apps/worker/src/main.ts` needs no change (the four generation queues — `text-ai`,
   `image-generation`, `image-edit`, `image-batch` — share one processor), and
   no new SSE event type is needed — status transitions ride the existing `job.updated` event, published by
   `publishJob` in the runner.

### Retry classification

`runGenerationJob` (`apps/worker/src/lib/runner.ts`) owns attempts, cancellation, failure messages and events.
`userFacingError` maps the thrown error to a `(code, message)` pair: a `ProviderError` contributes its own code and
`userMessage`, `JobCancelledError` → `cancelled`, `InputError` → `invalid_input`, anything else → `internal` with a
generic message (the real one is logged and persisted to `error_events`, never returned).

Then:

```ts
const RETRY_ANYWAY: string[] = ["content_policy", "invalid_json", "invalid_response"];
const categories = code === "content_policy" ? policyCategories(…) : [];
const retryable =
  (e instanceof ProviderError && e.retryable) || (RETRY_ANYWAY.includes(code) && categories.length === 0);
const attemptsLeft = bullJob.attemptsMade + 1 < (bullJob.opts.attempts ?? 1);
```

So the provider-level `retryable` flag (from `RETRYABLE` in `packages/domain/src/provider.ts`) is widened at the job
boundary: content-policy refusals and unrepairable JSON get their attempt budget, because image moderators are
nondeterministic and the repair path often just needs another sample. The exception is a refusal that names its
safety categories: that verdict repeats on every attempt, so it fails at once. Retrying puts the row back to `queued`
with `"… Retrying…"` in `failureReason` and rethrows so BullMQ re-queues with exponential backoff (3 attempts, 5 s
base, ±50% jitter, set in `BullJobQueue.enqueue`). Exhausted or non-retryable failures set `status: "failed"` with
`failureCode`/`failureReason`, reset the panel, **auto-pause the rest of the batch on `auth` or `quota`**, and throw
`UnrecoverableError` so BullMQ stops.

If you add a `ProviderErrorCode`, add its entry to `USER_MESSAGES` in `packages/domain/src/provider.ts` — it is a
`Record<ProviderErrorCode, string>`, so the compiler will ask.

### Progress and SSE events

Generation handlers do not report fractional progress; the runner publishes status transitions. Export jobs are the
progress model — `progress(p)` writes the column, publishes `export.updated` with the fraction, and doubles as the
cancellation checkpoint (§3).

Events are declared as the `AppEvent` union in `packages/queue/src/index.ts`: `job.updated`, `panel.updated`,
`reference.updated`, `analysis.updated`, `chapter.updated`, `audio.updated`, `export.updated`, `narration.updated`,
`production.updated`.
`EventBus.publish` writes to `om:events:project:<id>` on Redis pub/sub; the API streams it at
`GET /api/projects/:projectId/events` (`apps/api/src/routes/system.ts`, with `x-accel-buffering: no` and a ~14 s
ping). **A new event type needs a matching `case` in `invalidateFor` in `apps/web/src/api/hooks.ts`**, or the SPA
receives it and invalidates nothing.

### Adding a whole queue (rarer, more work)

Add the name to `QUEUES` in `packages/queue/src/index.ts`, add a processor in `apps/worker/src/processors.ts`, add a
`createWorker(...)` call in `apps/worker/src/main.ts` with a concurrency setting in `packages/config`, add a
`createExportJob`-style creator that calls `addToOutbox`, and extend `JobService.reconcileQueue` — it only walks the
three known job tables, so a fourth would not be recovered after a Redis flush.

### A production run step

Production runs (`apps/api/src/lib/production.ts`) are not a queue: the API process advances each running run every
10 s (`tickProductionRuns`, started in `apps/api/src/server.ts`) and after each start or continue. A step does its work
by calling the same REST routes a person would, in-process and as the run's user, through a private router built from
`mountApiRoutes` — so access checks, preflight and the budget cap all apply, and a new step never creates jobs
itself. (The render steps pass `acknowledgeIssues: true`, so readiness issues do not stop them.)

1. **Add the key to `STEPS`** in the order it should run, and a label to `STEP_LABELS` (a `Record` over `STEPS`, so
   the compiler asks for it). If an option turns it on or off, filter it in `initialSteps`, and add the option to
   `RunOptions`, to `StartRun` in `apps/api/src/routes/production.ts`, to the `options` column type on
   `productionRuns` (`packages/db/src/schema/projects.ts`) and to the checkboxes in
   `apps/web/src/features/project/ProductionRun.tsx`.
2. **Add its starter to `START`.** This is a `Record<string, …>` looked up with `!`, so a missing entry is not a
   compiler error: the step fails at runtime. The starter calls routes with `x.call(method, path, body)` — `text(x)`
   carries the run's text AI choice and the batch flag from the project's `batchPolicy`; image steps pass `image(x)`
   plus `batch: imageBatch(x.project)` — and returns `{ status, jobIds | exportJobId, note }`: `running` to wait,
   `done` or `skipped` to move on. Skip what already exists — a second run on a finished
   project must not spend again (the integration test asserts this).
3. **Completion is generic.** `check` waits for every job in `jobIds` (or the `exportJobId`) to reach a final state;
   a step that queues other work (as `audio` does) needs its own branch there. Only `analyze` fails the run on a
   partial failure; elsewhere failures become a note unless every job failed.
4. **A review step** is a key starting with `review_` that returns `{ status: "review", note }`; it is dropped
   unless `reviewGates` is on, and the run waits there until `POST /api/production-runs/:id/continue`.

A route refusing with `budget_exceeded` (or 402) pauses the run instead of failing it. Runs are advanced under an
in-process guard, which assumes a single API process.

---

## 5. Add a layout template, a style preset or a production preset

All are single-file additions. They differ in one important way: **layout templates and production presets live only
in code**, while **style presets are seeded into the database** and read back from it.

### A layout template

1. **`packages/domain/src/layout.ts` — append to `LAYOUT_TEMPLATES`** (13 today). Frames are normalized 0..1 on the
   unit square, in reading order for LTR; gutters and margins are applied later by `applyGutters`.

   ```ts
   {
     key: "four-grid",
     name: "4 grid",
     description: "Classic 2x2 grid",
     frames: [f(0, 0, 0.5, 0.5), f(0.5, 0, 0.5, 0.5), f(0, 0.5, 0.5, 0.5), f(0.5, 0.5, 0.5, 0.5)],
   },
   ```

   Constraints, all asserted in `packages/domain/src/domain.test.ts`: at most `MAX_PANELS_PER_PAGE` (5) frames,
   in-bounds, non-overlapping after gutters. Set `vertical: true` for a scroll strip (`webtoon-vertical`).

2. **Nothing else, unless you want it to be a default.** `GET /api/meta` serves `LAYOUT_TEMPLATES` straight from
   memory, both web pickers iterate it and render from `t.frames`, and the planning prompt's candidate list is derived
   in `apps/worker/src/handlers/text.ts`. Edit `defaultTemplateForCount` only to change which template a given panel
   count gets by default.

3. **Know how a bad key behaves.** `PlannedPage.layoutTemplate` in `packages/schemas/src/planning.ts` is a free string,
   deliberately — the model can return anything. `applyChapterPlan` (`packages/services/src/apply.ts`) is tolerant:

   ```ts
   const tpl = layoutByKey(pg.layoutTemplate);
   const template = tpl && tpl.frames.length === n ? tpl : defaultTemplateForCount(n);
   ```

   The strict checks are on the API side (`apps/api/src/routes/pages.ts` rejects an unknown key with `badRequest`) and
   in `templateFrames`, which throws. So a plan naming a nonexistent template silently gets the default for its panel
   count; a *user* naming one gets a 400.

### A style preset

1. **`packages/domain/src/styles.ts` — append to `BUILTIN_STYLE_PRESETS`** (11 today). The `definition` is a
   `StyleDefinition` (`packages/schemas/src/editor.ts`); every field is a defaulted string except
   `exclusions: string[]` and the optional `photoreal: boolean`, and the shared `common` array at the top of the file
   holds the standard text/lettering exclusions that satisfy invariant 7. `photoreal: true` (as `realistic` sets)
   swaps the comic format line for live-action photography in image prompts and turns a black-and-white project's
   colour directive into black-and-white photography.

   ```ts
   {
     key: "seinen",
     name: "Seinen Manga",
     definition: {
       summary: "Mature, grounded seinen manga illustration.",
       lineTreatment: "Fine detailed pen lines, realistic anatomy.",
       colorPolicy: "Black and white with grey tones.",
       …
       screenTones: "Gradient and texture tones.",
       lighting: "Naturalistic, low-key lighting.",
       exclusions: common,
     },
   },
   ```

   Adding a *field* to `StyleDefinition` also means editing `styleSection` to emit it.

2. **Re-run the bootstrap** (`bun packages/db/src/migrate.ts` then the bootstrap CLI, or just restart the compose
   `migrate` service). Presets **upsert** on `key`:

   ```ts
   .insert(stylePresets)
   .values({ key: p.key, name: p.name, isBuiltin: true, definition: p.definition })
   .onConflictDoUpdate({ target: stylePresets.key, set: { name: p.name, definition: p.definition } });
   ```

   So unlike rate snapshots, editing a preset in code *does* update the deployed row on next boot.

3. **Nothing in the web app.** The pickers read `GET /api/style-presets`, which returns the builtins from the
   database. Only add a hardcoded key if the preset should become a per-project-type *default*, in
   `apps/api/src/routes/projects.ts`.

### The colour-mode rule

A preset carries its own colour wording; a project carries a `colorMode` (`full_color | grayscale | bw_manga`, a
Postgres enum on `projects`). **The project's colour mode wins.** `styleSection` in
`packages/prompts/src/image-templates.ts`:

```ts
const colorful = /full colou?r/i.test(s.colorDirective);
const colorPolicy = d && (colorful && MONOCHROME_WORDING.test(d.colorPolicy) ? "" : d.colorPolicy);
// Screentones are a monochrome technique whatever the preset calls them, so a colour project drops the line.
const screenTones = d && (colorful ? "" : d.screenTones);
```

`MONOCHROME_WORDING` matches "black and white", "monochrome", "grey/gray tones", "screentone", "halftone", "no
colour". For a colour project the matching `colorPolicy` line is dropped and `screenTones` is dropped unconditionally,
so one prompt never carries both "Black and white with grey tones" and "Full color artwork" three lines apart.
`colorDirective` comes from `COLOR_MODE_DIRECTIVES[p.colorMode]` (`packages/domain/src/styles.ts`, set in
`packages/services/src/planner.ts`) and is appended after the style lines, followed only by the style-reference line.

**If your preset's monochrome wording uses vocabulary the regex does not match, it will leak into colour projects.**
Either reuse the existing phrasing or extend `MONOCHROME_WORDING` — and add a case to the colour-mode tests in
`packages/prompts/src/prompts.test.ts`.

---

### A production preset

A production preset is the one choice at project creation that sets format, style, image quality, target runtime,
reference policy and batch policy.

1. **`packages/domain/src/presets.ts` — append to `PRODUCTION_PRESETS`** (typed `ProductionPreset`, five today).
   `projectType`, `format`, `stylePresetKey` (a `BUILTIN_STYLE_PRESETS` key) and `colorMode` fill the new-project
   wizard's own fields; the API applies only `settings`. `POST /api/projects` with `preset: "<key>"` merges `settings`
   over the server defaults (the format's page size still wins) and validates the result with `ProjectSettings`; an
   unknown key is 400. A setting the type does not have yet goes in both `ProductionPreset.settings` and
   `ProjectSettings` (`packages/schemas/src/editor.ts`).
2. **Nothing else.** No bootstrap: `GET /api/production-presets` returns the list straight from code, together with
   the caller's saved project templates (`preset: "template:<id>"`), and the wizard reads it. The module is exported
   from `@openmanga/domain/browser` as well.

## 6. Add a database migration

1. **Edit the Drizzle schema** in `packages/db/src/schema/` — `common.ts` (enums and shared helpers), `auth.ts`,
   `projects.ts`, `media.ts`, `jobs.ts`, `experts.ts`, `mcp.ts`, all re-exported from `index.ts`.

2. **Generate the SQL:**

   ```bash
   cd packages/db && bunx drizzle-kit generate --name <name>
   ```

   (or `bun db:generate` from the root, without a name). This writes `packages/db/drizzle/NNNN_<name>.sql` plus a
   snapshot and a `drizzle/meta/_journal.json` entry.

3. **Commit the generated SQL, snapshot and journal.** Migrations are committed artifacts, not something reproduced at
   deploy time. Do not hand-edit generated SQL, and **never edit a migration that has been released** — add a new one.
   If you need something drizzle-kit cannot express, write the statement into the generated file before it ships and
   check that the snapshot still matches.

4. **Apply it.** Locally `bun db:migrate` (which is `bun packages/db/src/migrate.ts`; it applies SQL and does nothing
   else). In compose, the `migrate` service runs `bun apps/api/src/cli/bootstrap.ts`, which retries the database
   connection, applies migrations, then calls `bootstrapReferenceData` (prompt templates, style presets, rate
   snapshots, optional initial admin), rotates credential encryption and creates the asset root. `api`, `worker` and
   `mock-ai` all wait on `migrate: condition: service_completed_successfully`.

5. **Check the browser-safe row types.** `@openmanga/db/types` (`packages/db/src/types.ts`) is the only DB entry point
   the web app may import — it is types-only, with `Date` mapped to `string` because rows arrive as JSON:

   ```ts
   type Ser<T> = { [K in keyof T]: T[K] extends Date ? string : T[K] extends Date | null ? string | null : T[K] };
   export type PageRow = Ser<typeof s.pages.$inferSelect>;
   ```

   A new table that the SPA renders needs a `…Row` alias here; a new column on an existing table needs nothing
   (`$inferSelect` picks it up). `apps/web/src/api/types.ts` re-exports the whole module. Importing
   `@openmanga/db` itself from the web app pulls in the Postgres driver and breaks the build.

6. **Remember what does *not* need a migration.** `generation_jobs.kind` and `export_jobs.kind` are `text` columns
   typed in TypeScript only, so new job and export kinds are code-only changes.

7. **Test it.** `tests/integration/*` create and drop their own throwaway database and run the real migrations on it,
   so a broken migration fails there. Run them (see "Before you open a PR").

---

## 7. Add an API route

### Checklist

1. **Pick or create a router module** under `apps/api/src/routes/`, one per domain, each
   `new Hono<AppEnv>()` and exported. `AppEnv` (`apps/api/src/context.ts`) carries the request's `deps`, `requestId`,
   `log`, `user`, `sessionId` and `service` (the MCP connection's project restriction, when an agent is acting).

2. **Mount it in `mountApiRoutes` (`apps/api/src/app.ts`).** Five routers get a prefix (`/auth`, `/dev`, `/admin`,
   `/projects`, `/usage`); the rest are mounted at `/` and own several top-level paths themselves, so
   `chapterRoutes.get("/projects/:projectId/chapters", …)` serves `/api/projects/:projectId/chapters`.
   `mountApiRoutes` is used three times: by the public `/api` sub-app, by the private router MCP tools call
   (`apps/api/src/mcp/runtime.ts`) and by the production-run runner (`apps/api/src/lib/production.ts`), so an agent
   or a run executes exactly the browser's handler. A router agents must never reach
   is mounted outside it, as `/api/agents` and `/api/public` are. The whole `/api` sub-app already has `loadSession`,
   `csrf`, rate limiting, and `requireUser` for everything except `/auth/*`, `/meta`, `/docs*` and `/public/*`. Add
   per-route `requireUser` only when mounting outside `/api` (as `/cdn` does).

3. **Declare the Zod schema as a module const**, above the route, and register the endpoint with `doc()`:

   ```ts
   const ChapterInput = z.object({
     title: z.string().trim().min(1).max(200),
     summary: z.string().max(10_000).default(""),
   });
   doc({ method: "POST", path: "/api/projects/:projectId/chapters", summary: "Create chapter manually",
     tag: "chapters", body: ChapterInput });
   chapterRoutes.post("/projects/:projectId/chapters", async (c) => {
   ```

   `doc()` (`apps/api/src/lib/openapi.ts`) is a plain module-level registry with no effect on routing or validation —
   forgetting it only means the endpoint is missing from `/api/docs`. Pass the *same* Zod schema you validate with;
   `openApiSpec` runs `z.toJSONSchema` over it, so the published contract cannot drift from the validator. `path` is
   the full path including `/api`, with `:param` syntax. `auth: false` marks a genuinely public endpoint.

4. **Order the handler body: access → parse → work → respond.**

   ```ts
   const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
   const input = await body(c, ChapterInput);
   const { db } = c.get("deps");
   …
   return c.json({ chapter: row }, 201);
   ```

   From `apps/api/src/lib/http.ts`: `body(c, schema)` (400 `bad_request` on unparseable JSON, then `schema.parse`),
   `query(c, schema)`, and `uuidParam(c, name)` — which throws `notFound()` rather than a 400 on a malformed UUID, so
   a scan cannot distinguish "bad id" from "not yours". A `ZodError` is rendered centrally as
   **422 `validation_error`** with a `details` array. Multipart uploads go through `readImageUpload`
   (`apps/api/src/lib/uploads.ts`), which returns 413/415 rather than letting a large body through.

   **Large uploads take a raw body, not multipart.** `c.req.formData()` materialises the whole request before
   anything can be written to disk, so `POST /api/projects/import` caps multipart at 64 MB
   (`MAX_MULTIPART_BYTES`, checked against `content-length` before parsing) and otherwise treats the body as the
   file itself: any non-multipart content type, filename from `?name=` or `x-file-name`, piped to disk chunk by
   chunk against `IMPORT_MAX_UPLOAD_MB`. A new endpoint that accepts something big should copy that shape rather
   than reach for multipart — and `Bun.serve`'s `maxRequestBodySize` (`apps/api/src/server.ts`) has to cover the
   largest body you intend to accept, or the connection is closed mid-upload and the caller sees a 502.

5. **Authorize with the shared helpers, never ad hoc.** `projectAccess(c, projectId, action)`
   (`apps/api/src/lib/access.ts`) returns the project row or throws; `entityAccess(c, kind, id, action)` resolves any
   child entity (chapter, scene, page, panel, character, version, location, prop…) to its project first. Actions are
   `read | write | generate | delete | manage`, checked by `canPerform` in `packages/domain/src/permissions.ts`.

   Two behaviours to preserve: **non-members get 404, not 403**, so project existence does not leak; and soft-deleted
   projects are read-only. An admin-only router uses `adminRoutes.use("*", requireAdmin)`.

   AI routes additionally call `assertBudget(c, projectId)` (402 `budget_exceeded`, bypassable with
   `x-allow-over-budget: 1`) and resolve the run's provider choice through `apps/api/src/lib/ai.ts`, which raises
   422 `credentials_required` when the caller named no usable key.

6. **CSRF is already handled for the whole `/api` sub-app** by the `csrf` middleware in
   `apps/api/src/lib/middleware.ts`: a double-submit token in the readable `om_csrf` cookie, echoed in the
   `x-csrf-token` header on every method other than GET/HEAD/OPTIONS, compared in constant time. Nothing inside `/api`
   is exempt — including login and register. Only routes outside `/api` skip it: the root health endpoints,
   `/cdn/*`, and the Bearer-authenticated `/mcp` and `/oauth/*`. If you write a new
   client, it must read the cookie and send the header; `TestClient` seeds it with a `GET /api/auth/me`.

7. **Throw, do not format errors.** `ApiError(status, code, message, details?)` with the shorthands `notFound()`,
   `forbidden()`, `conflict()`, `badRequest()`. `handleError` (wired as `app.onError`) renders every case as
   `{ error: { code, message, details?, requestId } }`, maps `ZodError` → 422, `AuthError`, `PlanningError` and
   `ProviderError` (→ `provider_<code>`, 422 for rejections and 503 otherwise), and turns anything unrecognised into a
   logged, persisted 500 `internal_error` with a generic message. Never catch an error just to reshape it, and never
   put a provider or stack detail in a response.

8. **Audit the mutations that matter:**
   `recordAudit(deps.db, { userId, projectId, action, targetType, targetId, requestId: c.get("requestId") })`.

9. **Test it.** Route tests live in `tests/integration/` (`apps/api` has only a few unit tests, such as
   `src/lib/uploads.test.ts`) and drive the real app in-process. `startHarness()` (`tests/integration/harness.ts`)
   creates a throwaway database, runs migrations, builds real deps with `AI_MOCK_MODE=true` and `TTS_PROVIDER=fake`, starts real BullMQ workers on Redis DB 5, and
   calls `createApp(deps)` — no port is bound. `TestClient` is a cookie-jar client whose methods take an expected
   status:

   ```ts
   await alice.post("/api/auth/register", { username: "alice", … }, 201);
   await alice.post("/api/auth/login", { identifier: "alice", password: "wrong password" }, 401);
   ```

   Wait for queued work with `waitFor(fn, { timeoutMs, label })`.

---

## 8. Add an MCP tool

MCP tools are thin: a tool validates its arguments, classifies the call and invokes an existing REST route in-process,
so access checks, budgets, lifecycles and audit are the route's own. Add the route first (§7), then the tool.
[MCP](MCP.md) describes the behaviour below from the agent's side.

### Checklist

1. **Define it with `defineMcpTool`** in the area file under `apps/api/src/mcp/tools/` (`projects.ts`, `panels.ts`,
   `generations.ts`, …) and add it to that file's exported array. `MCP_TOOLS` in `tools/index.ts` concatenates the
   arrays; a new area file needs its array added there. The fields (`McpTool` in `apps/api/src/mcp/registry.ts`):
   - `name` (snake_case), `title`, and a model-facing `description`: what it does, side effects, whether it spends,
     whether it is asynchronous, what to call next.
   - `input` (a Zod object; reuse the route's schema where it fits, as `create_export` does) and `output`.
   - `scopes` from `MCP_SCOPES` (`apps/api/src/mcp/scopes.ts`); `scopesFor` when different actions need different
     scopes.
   - `sensitivity`: the worst class any call can have (`read`, `write`, `sensitive-write`, `spend`, `delete`).
   - `idempotent`, `routes` (the REST routes it wraps) and `actionKeys` (the stable keys approvals are remembered by).

2. **Classify every call that is not a plain read.** `defineMcpTool` throws for a non-read tool without `classify`.
   Return `cls(sensitivity, actionKey, projectId, summary, { target })` from `tools/common.ts`: resolve the project
   from the target with `projectOf` (never trust one from the caller), give the call its own class (`textSpend(ai, …)`
   makes manual-mode text a write), and put a `stamp(…)` of the target in `target` when an approval should go stale
   if the target changes before the user decides.

3. **Write the handler with `ctx.invoke(method, path, { body, query })`.** It calls the route as the connection's
   user and turns a route error into the tool error with the route's own code. Return `{ data, links? }`; add
   `content` only for image blocks (see `get_image`). Tools that create things or start jobs take
   `idempotencyKey: IdempotencyKey`. Paths under `/api/auth`, `/api/admin`, `/api/dev` and `/api/ai/credentials` are
   refused on the private router whatever a tool asks.

4. **Regenerate the catalogue:** `bun scripts/mcp-docs.ts` rewrites [MCP_TOOLS](MCP_TOOLS.md).
   `apps/api/src/mcp/catalogue.test.ts` fails while the committed file is stale, and also checks that names are unique
   snake_case, that a spend tool's description says it spends, and that every scope is used by some tool. A new scope
   goes in `MCP_SCOPES`, with the description users see on the consent page.

5. **Test it** in `tests/integration/mcp.test.ts`, which drives `/mcp` with real tokens, including approvals and
   idempotency.

---

## Before you open a PR

Run the same checks CI does. Every one of them works inside a container via `./scripts/bunx.sh <command>` if you do not
have Bun on the host.

| Check | Command |
| --- | --- |
| Lint and format | `bunx biome check .` (`bunx biome check --write .` to fix) |
| Typecheck | `bunx tsc -p tsconfig.json --noEmit && bunx tsc -p apps/web/tsconfig.json --noEmit` |
| Unit tests | `bun test packages apps/api apps/worker apps/web` |
| Integration tests | `bun test tests/integration` |
| Web build | `cd apps/web && bun run build` |

Both tsconfigs matter — the root one does not cover `apps/web`.

Integration tests need the compose Postgres and Redis running. They create and drop their own throwaway database and
use Redis DB 5, so your dev data is safe:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres redis
TEST_DATABASE_URL=postgres://<user>:<password>@postgres:5432/<db> \
TEST_REDIS_URL=redis://redis:6379/5 \
  ./scripts/bunx.sh bun test tests/integration
```

No test may spend money. Unit and integration tests use the in-process fakes; end-to-end (`./scripts/e2e.sh <baseUrl>`)
and the smoke test (`bun scripts/smoke.ts <baseUrl>`) run against a stack whose providers are mocked. A test that would
call a real provider does not belong in these suites — see `docs/TESTING.md`.

Finally, **sign off every commit**. OpenManga uses the
[Developer Certificate of Origin](https://developercertificate.org/); there is no CLA.

```bash
git commit -s -m "Your message"
```

That appends `Signed-off-by: Your Name <your.email@example.com>`, which must match your real `git config user.name` and
`user.email`. Forgot? `git commit --amend -s` fixes the last commit and `git rebase --signoff HEAD~<n>` the last `<n>`
— both rewrite history, so force-push afterwards. [CONTRIBUTING.md](../CONTRIBUTING.md) has the full details.
