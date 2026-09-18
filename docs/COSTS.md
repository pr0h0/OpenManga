# Costs

Every figure here is a **measurement from real provider runs**, taken in **September 2026**, not an estimate. Provider
prices change and these numbers will drift — treat them as a shape, not a quote, and check the provider's pricing page
before planning a large run. The app itself costs nothing to run; all spend is on the provider keys you add.

Images are the cost. Text (story analysis, chapter planning, panel prompts, narration writing) is a rounding error
beside them.

## How much art a chapter needs

The planner decides how many panels a chapter gets from the story itself, so panel count is not something you set.

| Measurement | Value |
| --- | --- |
| Panels per chapter | **14–47** |
| Average across 88 measured chapters | **24** |

That spread is the reason cost is hard to predict from outside the app, and the reason every project carries a budget
cap (see below).

## Image cost

| Measurement | Value |
| --- | --- |
| 50-project run | **1,226 images for $14.31** — an average of $0.0117 per image across references, panels, edits and covers |
| Per panel, `gpt-image-2` quality `low` | **$0.0138–$0.0158** |
| Per image, Meta `muse-image-1.0` | **$0.01 flat**, no input-token billing |

At those rates an average 24-panel chapter is about **$0.24** on a flat 1¢/image provider and about **$0.33–$0.38** on
`gpt-image-2` at `low`. References, covers and any regenerations are on top; a regeneration costs the same as the
original generation, because nothing is ever overwritten.

### gpt-image-2 `low`: output tokens do not scale with pixels

`gpt-image-2` bills generated images as output tokens, and at quality `low` the token count is almost flat across the
common sizes. Measured:

| Size | Output tokens |
| --- | --- |
| 1024x1024 | **196** |
| 1536x1024 | 158 |
| 1024x1536 | 158 |
| 2048x1152 | 157 |
| 2560x1440 | 205 |

**So `1024x1024` is the worst value of the common sizes.** It costs 25% more tokens than `1536x1024` while delivering
a third fewer pixels. There is no reason to pick it for panel artwork. This is why the default `IMAGE_SIZES` list does
not contain `1024x1024`; it offers `2048x1152`, `1152x2048`, `1792x1024`, `1024x1792`, `1536x1024`, `1024x1536` and
`1408x1408` (the last costs about 30% more than the others).

### Reference images bill as input

Every image request carries reference images — character identity, outfit, location, style, and previous panels for
continuity. Token-billed providers charge them as **input tokens at `ceil(w/16) * ceil(h/16)`**, so reference size is
a direct cost lever:

| Reference size | Input tokens each |
| --- | --- |
| 192x288 (default derivative) | 216 |
| 768x1152 (flat-rate derivative) | 3,456 |

The app therefore sends **small cached derivatives** (`REFERENCE_MAX_WIDTH`/`HEIGHT`, default 192×288) to token-billed
providers, and **larger ones** (`FLAT_RATE_REFERENCE_MAX_WIDTH`/`HEIGHT`, default 768×1152) to flat-rate providers
like Meta Muse, where input size is free. Canonical references are always kept at full resolution; only what goes into
the request is shrunk. Edit targets and masks are sent full resolution regardless, which is why a masked edit costs
more than a generation on token-billed providers.

## Text cost

Measured per chapter:

| Stage | Input tokens | Output tokens |
| --- | --- | --- |
| Chapter plan | 4,576 | 15,577 |
| Narration writing | 2,050 | 3,324 |

Output is about **74% of tokens and over 90% of the cost**, because every model charges several times more for output
than input. Optimising prompt size barely moves the bill; choosing a cheaper model does.

Text rates per 1M tokens, as seeded in `provider_rate_snapshots`:

| Model | Input | Output |
| --- | --- | --- |
| `deepseek-flash` (off-peak) | $0.15 | $0.60 |
| `deepseek-flash` (peak) | $0.30 | $1.20 |
| `gpt-5.6-luna` | $0.20 | $1.20 |
| `gpt-5-mini` | $0.25 | $2.00 |

DeepSeek prices flash **by time of day**, so the same run costs twice as much at peak. The seeded rate snapshot uses
the peak numbers, which means the cost dashboard may over-report off-peak spend but never under-reports it. The seeded
snapshots are editable configuration rows, not authoritative prices — an admin can add a new snapshot when a provider
changes its pricing.

## A full story, end to end

A 2-hour narrated story works out at roughly **820–1,100 panels** (34–46 chapters, about 1.2M text tokens):

| | Cost |
| --- | --- |
| Text (all stages, across the model range above) | **$0.37–$1.13** |
| Images | **$11–$17** |

Images are 90–97% of the total. If a run is coming out expensive, the lever is panel count, image provider and image
size — never the prompts.

## Provider batches: half price, up to 24h

Image and text generation can be sent to a provider's batch API instead of running now, at **50% of the
interactive price**. A 400-panel project drops from roughly $6 to $3. The trade-off is latency: a batch targets
**24 hours**, against minutes on the synchronous path at 24 concurrent requests — in practice the batches
measured here returned in minutes, but nothing guarantees that.

Opt in per run: **Send as a provider batch** on bulk panel generation, or `batch: true` on a generation request.
Everything else is unchanged — the panels wait at the provider instead of generating now, and no worker slot is
held while they do.

| | batchable | why not |
|---|---|---|
| OpenAI | yes | |
| Google (Gemini) | yes | |
| DeepSeek | **no** | discounts by time of day instead — peak is 01:00–04:00 and 06:00–10:00 UTC, Mon–Fri, and off-peak is half price with no API change |
| Anthropic | not yet | has a batch API; no implementation here, so it is not offered rather than quietly running at full price |
| Meta, OpenRouter | **no** | no batch API |

A run on a key that cannot batch falls back to generating normally rather than failing.

**Batch spend is reported separately.** A batched call is recorded against a `:batch` model — `gpt-image-2:batch`
— seeded at half the interactive rate, so the cost dashboard and the budget cap both see the real figure and you
can compare the two prices directly.

What batching does *not* change: budgets still apply, cancellation still works (the result is simply not
activated), and a batch that expires or returns nothing for a request fails that job loudly rather than leaving
it waiting.

## Export size

A project package (`zip_package`, the format `Import project` accepts) runs about **4.3 MB per panel**: measured
125.4 MB for a 29-panel comic and 83.2 MB for a 13-panel film. Panel artwork dominates; the entries are PNG and
WAV, so the archive does not compress. Import limits and the memory implication are in
[REQUIREMENTS](REQUIREMENTS.md#importing-a-project).

## Keeping spend visible

Three controls, all in the app:

- **Cost dashboard** — spend per window (today / 7 d / 30 d / lifetime) with an **images vs text split**, a per-
  provider and per-model table including token counts, a per-operation breakdown (references, panels, edits, planning,
  narration…) with call counts and failures, and a 30-day daily chart by provider. Mock-provider cost is reported
  separately so it never mixes into real spend. (`apps/api/src/routes/usage.ts`,
  `apps/web/src/features/usage/UsageDashboard.tsx`)
- **Per-project budget cap** — `settings.budgetUsd`. Once recorded spend reaches the cap the API refuses new AI work
  with `402 budget_exceeded`; the web client asks the user and retries with `x-allow-over-budget: 1`. It is a
  confirmation, not a hard stop, so a cap can never dead-end you mid-chapter. Queued batch jobs re-check the budget
  when they start and pause the batch rather than overspend. (`apps/api/src/lib/ai.ts`)
- **Estimate before queueing** — the bulk-generation dialog first calls the endpoint without `confirm`, which returns
  the panel count and an estimated cost plus the project's budget state (spent, remaining, and whether this batch
  would cross the cap) and queues nothing. You confirm against a number.
  (`apps/api/src/routes/generations.ts`, `apps/web/src/features/pages/BulkGenerate.tsx`)

Usage is recorded from the provider's own reported token counts, not guessed, so the dashboard reflects what you will
actually be billed. Models without a rate snapshot record tokens at $0 cost until an admin adds one.
