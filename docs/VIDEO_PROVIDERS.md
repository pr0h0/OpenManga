# AI video providers: API facts behind the adapters (researched 2026-10-13)

Sources were public docs only. Nothing was signed up for, no paid calls, no credentials. Where the docs are ambiguous or a claim is an inference, it is marked **[ambiguous]** or **[inferred]**.

Tip for future refreshes. Every fal model has a machine-readable page at `https://fal.ai/models/<endpoint-id>/llms.txt` with pricing, the input schema and the output schema. There is an OpenAPI version at `https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=<endpoint-id>`. The public catalog is at `https://api.fal.ai/v1/models?category=image-to-video` (paginated with `cursor`; no key needed, but it is rate-limited). Fal's docs index is https://fal.ai/docs/llms.txt, and every docs page is also served as `.md`.

---

## 1. fal.ai (priority)

### 1.1 Auth
- Header: `Authorization: Key $FAL_KEY` (the scheme is `Key`, not `Bearer`). Source: https://fal.ai/docs/model-apis/model-endpoints/queue

### 1.2 Queue API (https://fal.ai/docs/documentation/model-apis/inference/queue , same content at https://fal.ai/docs/model-apis/model-endpoints/queue)

**Submit:** `POST https://queue.fal.run/<endpoint-id>` with the model input as the JSON body. Example response:
```json
{
  "request_id": "764cabcf-b745-4b3e-ae38-1200304cf45b",
  "response_url": "https://queue.fal.run/fal-ai/flux/schnell/requests/764cabcf.../response",
  "status_url":   "https://queue.fal.run/fal-ai/flux/schnell/requests/764cabcf.../status",
  "cancel_url":   "https://queue.fal.run/fal-ai/flux/schnell/requests/764cabcf.../cancel",
  "queue_position": 0
}
```

**Status:** `GET https://queue.fal.run/<id>/requests/{request_id}/status`. Add `?logs=1` to include runner logs.
- States are `IN_QUEUE`, `IN_PROGRESS` and `COMPLETED`. The OpenAPI `QueueStatus` enum has only these three.
- `IN_QUEUE` responses carry `queue_position`.
- `IN_PROGRESS` responses carry `logs: [{message, timestamp}]`.
- `COMPLETED` responses carry `logs` and `metrics.inference_time` (seconds).
- **Failures also end in `COMPLETED`.** A failed request carries `error` (a human-readable string) and `error_type` (machine-readable). Always check for `error` before fetching the result.
- There is also an SSE stream: `GET .../requests/{id}/status/stream?logs=1` (`text/event-stream`). It stays open until `COMPLETED`.

**Result:** `GET https://queue.fal.run/<id>/requests/{request_id}`. The `response_url` that submit returns ends in `/response`.

**Cancel:** `PUT https://queue.fal.run/<id>/requests/{request_id}/cancel`. Possible responses:
- `202 {"status":"CANCELLATION_REQUESTED"}`. If the request was already running, it may still complete.
- `400 {"status":"ALREADY_COMPLETED"}`
- `404 {"status":"NOT_FOUND"}`

**Path gotcha [ambiguous]:** for multi-segment ids such as `fal-ai/kling-video/v3/pro/image-to-video`, the docs disagree on which path the request URLs use.
- The official JS client (`@fal-ai/client@1.10.1`, `src/queue.js`) builds status, result and cancel URLs from only `owner/alias`, for example `https://queue.fal.run/fal-ai/kling-video/requests/{id}/status`.
- The per-model OpenAPI lists the full path, `/fal-ai/kling-video/v3/pro/image-to-video/requests/{request_id}/status`.
- **Recommendation:** store and use the `status_url`, `response_url` and `cancel_url` that submit returns, and don't rebuild them.
- Sources: https://cdn.jsdelivr.net/npm/@fal-ai/client@1.10.1/src/queue.js and https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=fal-ai/kling-video/v3/pro/image-to-video

**Useful headers** (from the queue doc):

| Header | Effect |
|---|---|
| `X-Fal-Request-Start-Timeout: <seconds>` | Server-side deadline before processing starts. When it passes, the server returns 504 with `X-Fal-Request-Timeout-Type: user` and does not retry. |
| `X-Fal-No-Retry: 1` | Disables automatic retries. By default, a 503, 504 or connection error is re-queued and retried up to 10 times. |
| `X-Fal-Queue-Priority: normal\|low` | Queue priority. |
| `X-Fal-Store-IO: 0` | Stops fal from storing the JSON payloads, which are otherwise kept for 30 days. |
| `X-Fal-Object-Lifecycle-Preference: {"expiration_duration_seconds": N}` | Sets how long output media lives. `null` means no expiry. |

- The queue has no size limit and requests are never dropped.

### 1.3 Webhooks (https://fal.ai/docs/model-apis/model-endpoints/webhooks)
- Pass the webhook as a query parameter: `POST https://queue.fal.run/<id>?fal_webhook=https://your.host/hook`.
- The POST body is `{request_id, gateway_request_id, status: "OK"|"ERROR", payload, error?, payload_error?}`.
  - On `ERROR`, `error` looks like `"Invalid status code: 422"` and `payload` holds the error `detail`.
  - If the result is not valid JSON, `payload` is `null` and `payload_error` explains why.
- Your endpoint must return 2xx.
  - The first delivery attempt times out after 15 s. Retries time out after 120 s.
  - Retries continue for up to 31 attempts, until the stored result expires. That is about 1 h after completion, or about 6 min for results of 10 KB or more.
  - A `3xx` response is a permanent failure.
  - URLs that resolve to private or loopback IPs are dropped.
- **Make the handler idempotent on `request_id`.**
- Signature check:
  - Headers: `X-Fal-Webhook-Request-Id`, `X-Fal-Webhook-User-Id`, `X-Fal-Webhook-Timestamp`, `X-Fal-Webhook-Signature` (hex).
  - Signed message: `request_id\nuser_id\ntimestamp\nhex(sha256(raw body))`, verified with ED25519.
  - Public keys: JWKS at `https://rest.fal.ai/.well-known/jwks.json`.
  - Allowed clock skew is ±300 s.
- Our app is self-hosted behind cloudflared, so polling is simpler and enough. Webhooks are optional.

### 1.4 Errors
**Model or validation errors** (https://fal.ai/docs/model-apis/errors):
- The body is `{"detail": [ {loc, msg, type, url, ctx?, input?, categories?} ]}`. Check the `X-Fal-Needs-Retry` header.
- `type` values:

| `type` | Status | Notes |
|---|---|---|
| `internal_server_error` | 500 | |
| `generation_timeout` | 504 | |
| `downstream_service_error` | 500 | |
| `downstream_service_unavailable` | 500 | Partner API down |
| `content_policy_violation` | 422 | Not retryable. `categories` may include `sexual`, `violence`, `model_moderated` and others. |
| `no_media_generated` | 422 | |
| `value_error`, `input_value_error`, `missing` | 422 | |
| `image_too_small`, `image_too_large` | 422 | `ctx` gives the min or max dimensions. |
| Pydantic types (`enum`, `string_type`, …) | 422 | Passed through as-is. |

- **Rely on `type`, never parse `msg`.**

**Request or infrastructure errors** (https://fal.ai/docs/documentation/model-apis/request-errors):
- The body is `{detail, error_type}`.
- `error_type` values:
  - `request_timeout` (504) and `startup_timeout` (504).
  - `runner_*` (5xx): transient, so retry.
  - `client_cancelled` (499).
  - `bad_request` (400).
  - `internal_error` (500).

**Concurrency** (https://fal.ai/docs/model-apis/rate-limits):
- New accounts can run **2 concurrent** `IN_PROGRESS` requests.
- Self-serve limits rise to **40** as you buy credits.
- With the queue, extra requests just wait in `IN_QUEUE` and are never rejected.
- On direct `fal.run`, you get `429` with type `concurrent_requests_limit` and the `X-Fal-needs-retry: 1` header.
- Fal may also apply per-endpoint limits on popular models.

**Billing on failure** (https://fal.ai/docs/model-apis/faq):
- 5xx errors are never charged.
- 422 errors may still be charged if a runner spent GPU time before the error was found.
- Cold starts are not charged.

### 1.5 Passing the input image (https://fal.ai/docs/documentation/model-apis/fal-cdn)
1. **Public URL:** any HTTPS URL that needs no cookies or auth headers. Presigned S3/GCS/R2 URLs also work. URLs that need an `Authorization` header do not.
2. **Data URI:** `data:image/png;base64,...`. "Some models" accept it, and fal says it is "not recommended for files larger than a few KB". Some model pages say so explicitly, for example Wan 2.5 and 2.6: "Must be publicly accessible or base64 data URI".
3. **fal CDN upload (recommended):** raw HTTP flow, taken from `@fal-ai/client` `src/storage.js`.
   - Call `POST https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3`.
     - Headers: `Authorization: Key …`.
     - Body: `{"content_type":"image/png","file_name":"x.png"}`.
     - The response is `{upload_url, file_url}`.
   - Call `PUT <upload_url>` with the raw bytes and `Content-Type`.
   - Use `file_url` (for example `https://v3b.fal.media/files/b/...`) as the model's `image_url`.
   - Files over 90 MB go through `initiate-multipart` in 10 MB parts. That is irrelevant for images.
   - You can send an optional `X-Fal-Object-Lifecycle` header with the upload to set expiry.
   - **[inferred]** This is an internal client endpoint, not a documented REST API. Pin to the client's behaviour, or use the `@fal-ai/client` package's `fal.storage.upload(blob)`.
- **Size limits are per model.** The upload level has no limit. Examples:
  - Seedance 2.0: JPEG, PNG or WebP, at most 30 MB.
  - Kling 3 turbo: jpg or png, at most 50 MB, at least 300 px per side, aspect ratio between 1:2.5 and 2.5:1.
  - Wan 2.7: at most 20 MB.
  - Wan 2.6: each dimension between 240 and 7680 px.
  - Veo 3.1 i2v: 720p or larger, 16:9 or 9:16. Other ratios are cropped.

### 1.6 Result shape and retention
- Video models return `{"video": File|VideoFile, ...}`, plus `seed` on Wan and Seedance, and `actual_prompt` on Wan.
- `File` has `url`, `content_type`, `file_name` and `file_size`. All but `url` are nullable.
- `VideoFile` (Wan 2.5 and later, Grok, Wan 3) adds `width`, `height`, `fps`, `duration` and `num_frames`. Source: the per-model OpenAPI, for example https://fal.ai/api/openapi/queue/openapi.json?endpoint_id=wan/v2.6/image-to-video
- Retention:
  - Output media lives on `v3.fal.media` / `v3b.fal.media`. It is public by default and is "available for at least 7 days by default" (https://fal.ai/docs/model-apis/faq).
  - You can configure retention with `X-Fal-Object-Lifecycle-Preference`. Expired files are permanently deleted (https://fal.ai/docs/model-apis/data-retention).
  - **Download to our own storage right away.**
  - The JSON payloads are kept for 30 days.

### 1.7 Cost reporting
- **The queue and result responses do not include cost.** The only metric they report is `metrics.inference_time`.
- To get actual cost, use the Platform API:
  - Call `GET https://api.fal.ai/v1/models/billing-events?request_id=<id>` (several ids can be comma-separated).
  - Each record includes `cost_subtotal`, `cost_discount`, `cost_total` and `cost_estimate_nano_usd`.
  - The key needs the `billing:usage:read`, `auth:keys:read` and `account:users:read` permissions (the `BILLING` or `FULL` preset). Tagged-source events are "delayed".
  - Source: https://fal.ai/docs/platform-apis/v1/models/billing-events.md
- For pre-flight estimates:
  - `GET https://api.fal.ai/v1/models/pricing?endpoint_id=…` returns `{unit_price, unit, currency}`.
  - `POST https://api.fal.ai/v1/models/pricing/estimate` takes `estimate_type: unit_price|historical_api_price`.
  - Sources: https://fal.ai/docs/platform-apis/v1/models/pricing.md and https://fal.ai/docs/platform-apis/v1/models/pricing/estimate.md
- **Practical approach:** compute cost ourselves from the documented formula at submit time (tables below), then optionally reconcile later with billing-events.

### 1.8 Model catalogue (ids, inputs, prices)
These tables were extracted from each model's `https://fal.ai/models/<id>/llms.txt`; the API page is `https://fal.ai/models/<id>/api`. All parameters are optional unless marked **req**. Durations given as strings in fal's schema are quoted.

#### Wan (Alibaba)

| Endpoint id | Key inputs | Durations | Res / AR | Price |
|---|---|---|---|---|
| `fal-ai/wan-25-preview/image-to-video` | **prompt** (≤1500 chars), **image_url** (URL or data URI), `audio_url` (BGM), `negative_prompt` (≤500), `enable_prompt_expansion`=true, `seed`, `enable_safety_checker` | `"5"`,`"10"` | `480p`,`720p`,`1080p`(default) / AR follows the image | $0.05/s 480p, $0.10/s 720p, $0.15/s 1080p |
| `fal-ai/wan-25-preview/text-to-video` | same, plus `aspect_ratio` `16:9`,`9:16`,`1:1` | `"5"`,`"10"` | same | same |
| `fal-ai/wan/v2.2-a14b/image-to-video` | **image_url**, **prompt**, `end_image_url` (FLF), `num_frames` 17–161 (default 81), `frames_per_second` 4–60 (default 16), `negative_prompt`, `seed`, `resolution`, `aspect_ratio` `auto`/`16:9`/`9:16`/`1:1`, `num_inference_steps` (27), `guidance_scale` (3.5), `guidance_scale_2`, `shift`, `acceleration` `none`/`regular`, `interpolator_model` `none`/`film`/`rife`, `num_interpolated_frames`, `video_quality`, `enable_prompt_expansion` | Set by frames (81 frames at 16 fps ≈ 5 s) | `480p`,`580p`,`720p` | $0.04/s 480p, $0.06/s 580p, $0.08/s 720p ("video seconds at 16 fps") |
| `fal-ai/wan/v2.2-a14b/text-to-video` | same without the images | same | same | same |
| `fal-ai/wan/v2.2-5b/image-to-video` | similar to A14B | frames | `580p`,`720p` | **$0.15 per video** (flat) |
| `wan/v2.6/image-to-video` | **prompt**, **image_url** (URL or data URI, 240–7680 px), `audio_url`, `negative_prompt`, `enable_prompt_expansion`, `multi_shots`, `seed` | `"5"`,`"10"`,`"15"` | `720p`,`1080p` | $0.10/s 720p, $0.15/s 1080p |
| `wan/v2.6/image-to-video/flash` | same, plus `generate_audio` (default true; silent is "half as much") | same | same | $0.05/s 720p, $0.075/s 1080p **[ambiguous: whether this rate includes audio]** |
| `fal-ai/wan/v2.7/image-to-video` | `prompt`, `image_url` (≤20 MB), `end_image_url`, `video_url` (continuation), `audio_url`, `negative_prompt`, `seed` | 2–15 (int) | `720p`,`1080p` | $0.10/s 720p, $0.15/s 1080p |
| `alibaba/wan-3.0/image-to-video` | **start_image_url**, `end_image_url`, `prompt`, `audio` (default **true**), `enable_prompt_expansion`, `enable_thinking`, `seed` | 2–30 (int, default 5; `null` = model chooses) | `480p`,`720p`,`1080p`(default); AR `adaptive`,`16:9`,`4:3`,`1:1`,`3:4`,`9:16` | $0.05/s 480p, $0.10/s 720p, $0.20/s 1080p |
| `alibaba/wan-3.0/text-to-video` | (not fetched; same family) | | | |

#### Kling (Kuaishou)
On fal, Kling has no `resolution` parameter. Comparing fal's prices with Kling's official table suggests that **standard means 720p and pro means 1080p** **[inferred]**.

| Endpoint id | Key inputs | Durations | AR | Price |
|---|---|---|---|---|
| `fal-ai/kling-video/v2.5-turbo/standard/image-to-video` | **prompt**, **image_url**, `negative_prompt` (default "blur, distort, and low quality"), `cfg_scale` 0–1 (0.5). No tail image. | `"5"`,`"10"` | from the image | $0.21 per 5 s, then $0.042/s |
| `fal-ai/kling-video/v2.5-turbo/pro/image-to-video` | same, plus `tail_image_url` (end frame) | `"5"`,`"10"` | from the image | $0.35 per 5 s, then $0.07/s |
| `fal-ai/kling-video/v2.5-turbo/pro/text-to-video` | **prompt**, `aspect_ratio`, `negative_prompt`, `cfg_scale` | `"5"`,`"10"` | `16:9`,`9:16`,`1:1` | $0.35 per 5 s |
| `fal-ai/kling-video/v2.6/pro/image-to-video` | **prompt**, **start_image_url**, `end_image_url`, `generate_audio` (default **true**), `voice_ids`, `negative_prompt` | `"5"`,`"10"` | from the image | $0.07/s no audio, $0.14/s audio, $0.168/s audio with voice |
| `fal-ai/kling-video/v3/standard/image-to-video` | `prompt` or `multi_prompt`, **start_image_url**, `end_image_url`, `generate_audio` (default **true**), `elements`, `shot_type`, `negative_prompt`, `cfg_scale` | `"3"`…`"15"` | from the image | $0.084/s no audio, $0.126/s audio |
| `fal-ai/kling-video/v3/pro/image-to-video` | same | `"3"`…`"15"` | from the image | $0.112/s no audio, $0.168/s audio, $0.196/s audio with voice |
| `fal-ai/kling-video/v3/pro/text-to-video` | same, plus `aspect_ratio` | `"3"`…`"15"` | `16:9`,`9:16`,`1:1` | same as v3 pro |
| `fal-ai/kling-video/v3/turbo/standard/image-to-video` | `prompt`/`multi_prompt`, **image_url** (jpg/png, ≤50 MB, ≥300 px, AR between 1:2.5 and 2.5:1) | `"3"`…`"15"` | from the image | $0.112/s |

Also listed on fal: `fal-ai/kling-video/o3/*` and `fal-ai/kling-video/v3/4k/*`.

**Note: `generate_audio` defaults to true on v2.6 and v3. Send `false` explicitly to get the cheaper silent rate.**

#### Google Veo 3.1 Fast via fal
**[ambiguous] Availability:** these llms.txt pages still load, but the ids return *no metadata* from fal's model catalog API, and they do not appear in the image-to-video or text-to-video category listings. Kling, Wan and the others do appear. Check https://fal.ai/models/fal-ai/veo3.1/fast/image-to-video before shipping. Google's own Omni Flash is listed on fal (see below).

| Endpoint id | Key inputs | Durations | Res / AR | Price |
|---|---|---|---|---|
| `fal-ai/veo3.1/fast/image-to-video` | **prompt**, **image_url** (≥720p, 16:9 or 9:16, else cropped), `aspect_ratio` `auto`/`16:9`/`9:16`, `negative_prompt`, `resolution`, `generate_audio` (default **true**), `seed`, `auto_fix`, `safety_tolerance` `"1"`–`"6"` (default `"4"`) | `"4s"`,`"6s"`,`"8s"` (default 8s) | `720p`(default),`1080p`,`4k` | $0.10/s no audio, $0.15/s audio (720p/1080p); $0.30 / $0.35 at 4k |
| `fal-ai/veo3.1/fast` (t2v) | same without the image; `aspect_ratio` `16:9`,`9:16` | same | same | same |
| `fal-ai/veo3.1/fast/first-last-frame-to-video` | **first_frame_url**, **last_frame_url**, the rest as above | same | same | same |

#### Seedance (ByteDance)
Most Seedance models are token-priced: tokens = (height × width × 24 fps × duration) / 1024. A 5 s clip is 48,600 tokens at 480p (864×480) and 108,000 tokens at 720p **[inferred dimensions; the result for 1080p matches fal's own $0.243 example]**.

| Endpoint id | Key inputs | Durations | Res / AR | Price |
|---|---|---|---|---|
| `fal-ai/bytedance/seedance/v1/pro/fast/image-to-video` | **prompt**, **image_url**, `aspect_ratio` (`21:9`,`16:9`,`4:3`,`1:1`,`3:4`,`9:16`,`auto`), `resolution`, `camera_fixed`, `seed` (-1 = random), `num_frames` 29–289. No end frame. | `"2"`…`"12"` | `480p`,`720p`,`1080p`(default) | $1.0 per 1M tokens (5 s 1080p ≈ $0.243) |
| `fal-ai/bytedance/seedance/v1/pro/image-to-video` | same, plus `end_image_url` | `"2"`…`"12"` | same | $2.5 per 1M tokens (5 s 1080p ≈ $0.62) |
| `fal-ai/bytedance/seedance/v1/lite/image-to-video` | **Deprecated.** Requests are re-routed to 1.0 Pro Fast, and `end_image_url` is ignored. | | | |
| `fal-ai/bytedance/seedance/v1.5/pro/image-to-video` | **prompt**, **image_url**, `end_image_url`, `aspect_ratio`, `resolution`, `camera_fixed`, `seed`, `generate_audio` (default **true**) | `"4"`…`"12"` | `480p`,`720p`(default),`1080p` | $2.4 per 1M tokens with audio, $1.2 without (5 s 720p with audio ≈ $0.26) |
| `bytedance/seedance-2.0/image-to-video` | **prompt**, **image_url** (JPEG/PNG/WebP ≤30 MB), `end_image_url`, `resolution`, `aspect_ratio` (`auto`,`21:9`,`16:9`,`4:3`,`1:1`,…), `generate_audio` (default **true**, **same price**), `bitrate_mode`, `codec` `auto`/`H264`/`H265`, `end_user_id` | `"auto"`,`"4"`…`"15"` | `480p`,`720p`(default),`1080p`,`4k` | $0.014 per 1k tokens (about $0.3034/s at 720p, $0.682/s at 1080p) |
| `bytedance/seedance-2.0/fast/image-to-video` | same; 480p and 720p only | same | | $0.0112 per 1k tokens (about $0.2419/s at 720p) |
| `bytedance/seedance-2.0/mini/image-to-video` | same; 480p and 720p only | same | | about $0.0721/s 480p, $0.1547/s 720p |
| `bytedance/seedance-2.0/text-to-video` | **prompt** plus the 2.0 options | same | | same as 2.0 |

Also listed on fal: `bytedance/seedance-2.5/*` and `bytedance/seedance-2.0/us/*`.

**Default `duration` is `"auto"` on 2.0. Always send it explicitly.**

#### MiniMax Hailuo
On fal, Hailuo models other than 02 Standard have no resolution parameter; the page title states the resolution.

| Endpoint id | Key inputs | Durations | Res | Price |
|---|---|---|---|---|
| `fal-ai/minimax/hailuo-02/standard/image-to-video` | **prompt**, **image_url**, `end_image_url`, `resolution` `512P`/`768P`, `prompt_optimizer` (default true) | `"6"`,`"10"` | 512P / 768P | $0.045/s at 768P ($0.27 per 6 s); about $0.017/s at 512P |
| `fal-ai/minimax/hailuo-02/pro/image-to-video` | **prompt**, **image_url**, `end_image_url`, `prompt_optimizer` | 6 s (no parameter) | 1080p | $0.08/s ($0.48 per 6 s) |
| `fal-ai/minimax/hailuo-02/standard/text-to-video` | **prompt**, `duration`, `prompt_optimizer` | `"6"`,`"10"` | 768P | $0.045/s |
| `fal-ai/minimax/hailuo-2.3/standard/image-to-video` | **prompt**, **image_url**, `prompt_optimizer`. No end frame. | `"6"`,`"10"` | 768p | $0.28 per 6 s, $0.56 per 10 s |
| `fal-ai/minimax/hailuo-2.3/pro/image-to-video` | **prompt**, **image_url**, `prompt_optimizer` | 6 s | 1080p | $0.49 per video |
| `fal-ai/minimax/hailuo-2.3-fast/standard/image-to-video` | **prompt**, **image_url**, `prompt_optimizer` | `"6"`,`"10"` | 768p | $0.19 per 6 s, $0.32 per 10 s |
| `fal-ai/minimax/hailuo-2.3/standard/text-to-video` | **prompt**, `duration`, `prompt_optimizer` | `"6"`,`"10"` | 768p | $0.28 per 6 s |
| `minimax/h3/image-to-video` (current MiniMax flagship) | **prompt**, `image_url`, `end_image_url` (either may be given alone), `duration`, `resolution`, `seed`, `target_audio_url`, `prompt_expansion_mode` | 5–15 (int) | `480P`,`768P` native; `2K`(default),`4K` upscaled | $0.05/s 480P, $0.06/s 768P, $0.13/s 2K, $0.16/s 4K |

MiniMax now lists Hailuo 2.3 and 02 as **legacy** and treats H3 as current (https://platform.minimax.io/docs/guides/pricing-paygo.md).

#### xAI Grok Imagine video

| Endpoint id | Key inputs | Durations | Res / AR | Price |
|---|---|---|---|---|
| `xai/grok-imagine-video/image-to-video` | **prompt**, **image_url**, `duration`, `resolution`, `aspect_ratio` (`auto`,`16:9`,`4:3`,`3:2`,`1:1`,`2:3`,`3:4`,`9:16`) | 1–15 (int, default 6) | `480p`,`720p`(default) | $0.05/s 480p, $0.07/s 720p, plus $0.002 per input image |
| `xai/grok-imagine-video/text-to-video` | **prompt**, `duration`, `resolution`, `aspect_ratio` | 1–15 | same | same, without the image fee |
| `xai/grok-imagine-video/v1.5/image-to-video` | **prompt**, **image_url**, `duration`, `resolution` | 1–15 | `480p`,`720p`,`1080p` | $0.08/s 480p, $0.14/s 720p, $0.25/s 1080p, plus $0.01 per image |
| `xai/grok-imagine-video/v1.5/lite/image-to-video` | same | 1–15 | same | **$0.02/s 480p, $0.03/s 720p**, $0.14/s 1080p, plus $0.01 per image (5 s 720p = $0.16) |

The fal schemas have no audio flag. **[ambiguous]** whether output includes audio.

#### Luma Ray

| Endpoint id | Key inputs | Durations | Res / AR | Price |
|---|---|---|---|---|
| `fal-ai/luma-dream-machine/ray-2/image-to-video` | **prompt**, `image_url`, `end_image_url`, `aspect_ratio` (`16:9`,`9:16`,`4:3`,`3:4`,`21:9`,`9:21`), `loop`, `resolution` | `"5s"`,`"9s"` | `540p`(default), `720p` (2× price), `1080p` (4×) | $0.50 per 5 s at 540p; 9 s costs 2× |
| `fal-ai/luma-dream-machine/ray-2-flash/image-to-video` | same | same | same | $0.20 per 5 s at 540p |
| `fal-ai/luma-dream-machine/ray-2` (t2v) | **prompt**, `aspect_ratio`, `loop`, `resolution`, `duration` | same | same | $0.50 per 5 s at 540p |
| `luma/agent/ray/v3.2/image-to-video` (current) | **prompt**, `image_url`, `end_image_url` or `keyframes` + `keyframe_indexes`, `aspect_ratio` (`3:4`,`4:3`,`1:1`,`9:16`,`16:9`,`21:9`), `resolution`, `loop`, `hdr` | `"5s"` (10 s needs keyframes) | `540p`,`720p`,`1080p` | $0.15 per 5 s at 540p, $0.30 at 720p, $1.20 at 1080p |

**[ambiguous]** The Ray 2 ids are also missing from fal's catalog listing (same caveat as Veo 3.1).

#### Pika

| Endpoint id | Key inputs | Durations | Res / AR | Price |
|---|---|---|---|---|
| `fal-ai/pika/v2.2/image-to-video` | **image_url**, **prompt**, `seed`, `negative_prompt`, `resolution`, `duration` | 5, 10 | `720p`,`1080p` | $0.20 per 5 s at 720p, $0.45 at 1080p |
| `fal-ai/pika/v2.2/text-to-video` | **prompt** plus `aspect_ratio` (`16:9`,`9:16`,`1:1`,`4:5`,`5:4`,`3:2`,`2:3`) | 5, 10 | same | same |
| `fal-ai/pika/v2.2/pikaframes` | **image_urls** (2–5 keyframes), `transitions` (≤25 s total), `prompt` | 5 s per transition by default | same | $0.04/s 720p, $0.06/s 1080p; 5 s minimum |

#### Other notable models on fal (not requested, but relevant)
- `fal-ai/pixverse/v6/image-to-video`
  - Has a **`style` enum: `anime`, `3d_animation`, `clay`, `comic`, `cyberpunk`**.
  - Other inputs: duration 1–15, resolution `360p`/`540p`/`720p`/`1080p`, `generate_audio_switch`.
  - Price: $0.045/s at 720p without audio, $0.060/s with audio; $0.025/s at 360p.
  - Source: https://fal.ai/models/fal-ai/pixverse/v6/image-to-video/llms.txt
- `google/gemini-omni-flash/v1.1/image-to-video`
  - Inputs: **image_url**, `end_image_url`, `aspect_ratio` `16:9`/`9:16`, `resolution` `360p`/`720p`/`1080p`/`4k`, duration 3–10 (default 8).
  - Price: $0.03/s 360p, $0.10/s 720p, $0.15/s 1080p.
  - Source: https://fal.ai/models/google/gemini-omni-flash/v1.1/image-to-video/llms.txt

---

## 2. Google Veo via the Gemini API (https://ai.google.dev/gemini-api/docs/veo, last updated 2026-10-08)

**Models:**

| Model id | Status |
|---|---|
| `veo-3.1-generate-preview` | Preview |
| `veo-3.1-fast-generate-preview` | Preview |
| `veo-3.1-lite-generate-preview` | Preview (since Mar 2026) |
| `veo-3.0-generate-001`, `veo-3.0-fast-generate-001` | Deprecated |

There is **no GA Veo 3.1 id**. Google's video overview now recommends **Gemini Omni Flash** (`gemini-omni-1.1-flash`, GA) as the default video model, with Veo kept for scene extension, last-frame control and legacy pipelines (https://ai.google.dev/gemini-api/docs/video).

**Submit:**
```
POST https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-fast-generate-preview:predictLongRunning
x-goog-api-key: $GEMINI_API_KEY
Content-Type: application/json
{
  "instances": [{
    "prompt": "...",
    "image":     {"inlineData": {"mimeType": "image/png", "data": "<base64>"}},
    "lastFrame": {"inlineData": {"mimeType": "image/png", "data": "<base64>"}}
  }],
  "parameters": { "aspectRatio": "16:9", "durationSeconds": "8", "resolution": "720p", "personGeneration": "allow_adult" }
}
```
- The response is `{ "name": "<operation name>" }`.
- **Note:** the Gemini API REST examples use `inlineData {mimeType, data}`. `bytesBase64Encoded` is the Vertex AI shape and does not appear in these docs.
- `lastFrame` must be used together with `image`.
- `referenceImages` takes up to 3 `{image, referenceType:"asset"}` (3.1 and 3.1 Fast only).
- `video` is for extension (3.1 and 3.1 Fast).

**Parameters** (from the "Veo API parameters and specifications" table):

| Parameter | Values |
|---|---|
| `aspectRatio` | `"16:9"` (default), `"9:16"` |
| `durationSeconds` | `"4"`, `"6"`, `"8"`. **Must be "8"** with 1080p, 4k, reference images or extension. |
| `resolution` | `"720p"` (default), `"1080p"` (8 s only), `"4k"` (8 s only; not on Lite). Extension is 720p only. |
| `personGeneration` | t2v and extension: `"allow_all"` only. i2v, interpolation and reference images: `"allow_adult"` only. In the EU, UK, CH and MENA, only `allow_adult` is allowed. |
| `seed` | Available; "slightly improves" determinism. |
| `numberOfVideos` | 1 (only one video per request). |
| `generateAudio` | **Not a parameter in the Gemini API.** The docs say audio is "Always on" for every Veo 3.x model. The fal wrapper does expose `generate_audio`. |
| `negativePrompt` | **[ambiguous]** Not listed in the current parameter table. Older docs had it. Don't rely on it. |

- Output is 24 fps.
- The text prompt is limited to 1,024 tokens.

**Polling and download:**
- Poll with `GET https://generativelanguage.googleapis.com/v1beta/{operation name}` and the `x-goog-api-key` header, until `done: true`.
- The video URI is at `response.generateVideoResponse.generatedSamples[0].video.uri`.
- Download with `curl -L -H "x-goog-api-key: …" <uri>`. **The API key is required and redirects must be followed.**

**Limits and policy:**
- Latency is 11 s minimum and up to 6 min at peak.
- **Generated videos are stored for 2 days, then deleted.**
- Every video carries a SynthID watermark.
- Safety filters and memorization checks run on every generation, and requests can be blocked because of audio issues.
- Videos blocked by safety filters or audio problems are not charged.

**Price** (https://ai.google.dev/gemini-api/docs/pricing, paid tier only; no free tier). Prices are per second of output, with audio included:

| Model | 720p | 1080p | 4k |
|---|---|---|---|
| Veo 3.1 Standard | $0.40 | $0.40 | $0.60 |
| **Veo 3.1 Fast** | **$0.10** | $0.12 | $0.30 |
| Veo 3.1 Lite | $0.05 | $0.08 | not supported |

So a 4 s Fast clip at 720p costs $0.40, and a 6 s clip costs $0.60. Fast through Gemini direct is the same price as fal's *silent* rate, and cheaper than fal's audio rate ($0.15/s).

**Gemini Omni Flash** (`gemini-omni-1.1-flash`, https://ai.google.dev/gemini-api/docs/omni). This is a different API, the Interactions API.
- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/interactions` with body `{"model":"gemini-omni-1.1-flash","input":..., "response_format":{"aspect_ratio":"16:9"|"9:16","resolution":"360p|720p|1080p|4k"}}`.
- The video comes back as base64 in `steps[].content[]{type:"video"}`. Use `delivery="uri"` for files over 4 MB. It can run synchronously (`background=false`).
- Supports first and last frame interpolation.
- Negative prompts are not supported.
- Price: about $0.10/s at 720p (output tokens at $17.50 per 1M, 5,792 tokens per second of video).

---

## 3. Official provider APIs (brief)

| Provider | Endpoint style | Async model | Image input | Durations | Price | Docs |
|---|---|---|---|---|---|---|
| **Kling official** | New design: `POST https://api-singapore.klingai.com/image-to-video/kling-3.0` with body `{contents:[{type:"prompt",text},{type:"first_frame",url},{type:"last_frame",url}], settings:{resolution:"720p"\|"1080p"\|"4k", duration:3–15, audio:"native"\|"off", multi_shot}, options:{callback_url, external_task_id, watermark_info}}`. Auth: `Authorization: Bearer <API Key>`. The legacy `model_name` endpoints instead use a JWT signed with HS256 from the AK/SK pair (`iss`=AK, 30 min `exp`, `nbf` −5 s). | Task. Poll `GET /tasks?external_task_ids=…`. Status: `submitted`, `processing`, `succeeded`, `failed`. `callback_url` supported. Results are cleared after 30 days. | URL or base64; jpg/png ≤50 MB, ≥300 px, AR between 1:2.5 and 2.5:1. First frame required, last frame optional. | 3.0: 3–15 s | Per second. 3.0 without audio: $0.084 (720p), $0.112 (1080p). 3.0 with audio: $0.126 / $0.168. 2.6 without audio: $0.042 / $0.07. 2.5 Turbo: $0.042 / $0.07. 3.0 Turbo: $0.112 / $0.14. | https://kling.ai/document-api/api/video/3-0-omni/image-to-video.md , https://kling.ai/document-api/api/get-started/authentication.md , https://kling.ai/document-api/pricing/base/video.md |
| **Runway** (gen4_turbo) | `POST https://api.dev.runwayml.com/v1/image_to_video` with headers `Authorization: Bearer <secret>` and **`X-Runway-Version: 2024-11-06`** (required). Body: `{model:"gen4_turbo", promptImage: uri or [{uri, position:"first"}], promptText?, ratio, duration, seed?}`. | `{id}`. Poll `GET /v1/tasks/{id}`. Status: `PENDING`, `THROTTLED`, `RUNNING`, `SUCCEEDED`, `FAILED`, `CANCELLED`. `DELETE /v1/tasks/{id}` cancels. Output URLs expire in 24–48 h. Moderation shows up as `FAILED` and **is still billed**. | HTTPS URL (≤16 MB), data URI (≤5 MB), or an ephemeral upload via `POST /v1/uploads`. First frame only; no last frame for gen4_turbo. | Integer 2–10 | gen4_turbo: 5 credits/s = **$0.05/s** (1 credit = $0.01). gen4.5: $0.12/s. Runway also resells veo3.1_fast, kling3, seedance2 and others. | https://docs.dev.runwayml.com/ai-context.md , https://docs.dev.runwayml.com/api.md , https://docs.dev.runwayml.com/guides/pricing.md , https://docs.dev.runwayml.com/assets/inputs.md |
| **Luma** | `POST https://api.lumalabs.ai/dream-machine/v1/generations` with `Authorization: Bearer`. Body: `{prompt, model:"ray-2"\|"ray-flash-2", aspect_ratio, resolution, duration:"5s", loop, keyframes:{frame0:{type:"image",url}, frame1:{…}}, callback_url}`. | `GET …/generations/{id}`. `state` is `dreaming`, `completed` or `failed`. The output is `assets.video`. Callbacks are retried 3 times. | Your own CDN URL only, no base64. Start and end frames supported. | 5 s / 9 s (Ray 2) | No official page lists Ray 2 rates **[ambiguous]**. Ray 3.2 (newer "agents" API): $0.15 per 5 s at 540p, $0.30 at 720p, $1.20 at 1080p. | https://docs.lumalabs.ai/docs/video-generation , https://docs.agents.lumalabs.ai/guides/pricing/index.md |
| **MiniMax** | `POST https://api.minimax.io/v1/video_generation` with `{model:"MiniMax-Hailuo-2.3"\|"…-2.3-Fast"\|"MiniMax-Hailuo-02", first_frame_image, prompt (≤2000 chars, supports [camera] commands), duration, resolution, prompt_optimizer, callback_url}`. The newer v2 endpoint serves MiniMax-H3 and H3-Max. | `{task_id}`. Poll `GET /v1/query/video_generation?task_id=`; status is `Preparing`, `Queueing`, `Processing`, `Success` or `Fail`, and success returns a `file_id`. Then `GET /v1/files/retrieve` returns a `download_url` **valid for 1 h**. The callback needs a challenge echo. | Public URL or data URL; JPG/PNG/WebP <20 MB, short edge >300 px, AR between 2:5 and 5:2. First and last frame are a separate endpoint (fl2v). | 6 or 10 s (10 s not at 1080P) | Legacy Hailuo: 2.3 is $0.28 per 6 s at 768P; 2.3-Fast is $0.19; 02 is $0.10 per 6 s at 512P. H3 is $0.08/s at 768P; H3-Max is $0.05/s at 480P. | https://platform.minimax.io/docs/api-reference/video-generation-i2v.md , https://platform.minimax.io/docs/guides/pricing-paygo.md |
| **ByteDance Seedance via BytePlus ModelArk** | `POST https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks` with `Authorization: Bearer <ARK key>`. Body: `{model:"seedance-1-5-pro-251215"\|"seedance-2-0-260128"\|"seedance-2-5-260628"…, content:[{type:"text",text},{type:"image_url",image_url:{url}, role:"first_frame"\|"last_frame"}], resolution, ratio, duration, seed, camera_fixed, watermark, generate_audio, return_last_frame, callback_url, execution_expires_after}`. | Task. Status: `queued`, `running`, `succeeded`, `failed`, `expired` (plus cancel). The task record is kept for 7 days. | URL or base64; images <30 MB. First and last frame supported on 2.5, 2.0, 1.5 pro and 1.0 pro. | 2.0: 4–15 s or −1 (auto). 2.5: 4–30 s. | Token-based. Official per-token rates could not be read (the page is rendered by JS) **[ambiguous]**. Use fal's token prices as a proxy. | https://docs.byteplus.com/en/docs/ModelArk/1520757 |
| **OpenAI Sora** | **Gone.** The Videos API and the `sora-2`, `sora-2-pro` and dated snapshot models were announced for removal on 2026-03-24 and **removed on 2026-09-24**. No replacement is listed. | — | — | — | — | https://developers.openai.com/api/docs/deprecations |

---

## 4. Comparison (cheapest way to get a 5 s clip)

Prices are list prices at the cheapest settings: audio off where it is optional, and only the image fee where one applies. Some models have no 5 s option; for those the table shows the nearest duration in brackets.

| Provider / model | 480p (or lowest) | 720p | Durations | Aspect ratios | First+last frame | Native audio | Best for (weak evidence, see note) |
|---|---|---|---|---|---|---|---|
| fal Wan 2.2 A14B | **$0.20** | $0.40 | ~1–10 s via frames | auto, 16:9, 9:16, 1:1 | yes (`end_image_url`) | no | cheap stylised / anime-friendly open model |
| fal Wan 2.2 5B | $0.15 flat (580p) | $0.15 | frames | auto, 16:9, 9:16, 1:1 | no | no | drafts |
| fal Wan 2.5 preview | $0.25 | $0.50 | 5, 10 | from image (t2v: 16:9, 9:16, 1:1) | no | `audio_url` input only; native audio not in schema [ambiguous] | general |
| fal Wan 3.0 | $0.25 | $0.50 | 2–30 | adaptive, 16:9, 4:3, 1:1, 3:4, 9:16 | yes | yes (default on) | general, long clips |
| fal Kling 2.5 Turbo std / pro | — | $0.21 (std) | 5, 10 | from image | pro only (`tail_image_url`) | no | realistic, strong motion |
| fal Kling 3.0 std | — | $0.42 | 3–15 | from image | yes | yes (+50%) | realistic, cinematic; good stylisation |
| fal Veo 3.1 Fast [availability ambiguous] | — | [4 s $0.40 / 6 s $0.60] | 4, 6, 8 | 16:9, 9:16 | yes (separate endpoint) | yes (on by default; $0.15/s) | realistic with dialogue and SFX |
| Gemini API Veo 3.1 Fast | — | [4 s $0.40 / 6 s $0.60] (audio included) | 4, 6, 8 | 16:9, 9:16 | yes (`lastFrame`) | always on | realistic |
| Gemini API Veo 3.1 Lite | — | [4 s $0.20 / 6 s $0.30] | 4, 6, 8 | 16:9, 9:16 | yes | always on | cheap realistic |
| fal Seedance 1.0 Pro Fast | **≈$0.05** | ≈$0.11 | 2–12 | 21:9, 16:9, 4:3, 1:1, 3:4, 9:16, auto | no | no | best value; realistic and anime |
| fal Seedance 1.5 Pro | ≈$0.06 (silent) | ≈$0.13 silent / $0.26 audio | 4–12 | same | yes | yes | general |
| fal Seedance 2.0 / Fast / Mini | ≈$0.68 / $0.54 / $0.36 | ≈$1.52 / $1.21 / $0.77 | 4–15, auto | auto, 21:9, 16:9, 4:3, 1:1, 3:4, 9:16 | yes | yes (same price) | top of blind i2v leaderboards (realistic) |
| fal Hailuo 02 Standard | [6 s $0.10 at 512P] | [6 s $0.27 at 768P] | 6, 10 | from image | yes | no | stylised and anime; good physics |
| fal Hailuo 2.3 Fast / Std | — | [6 s $0.19 / $0.28 at 768p] | 6, 10 | from image | no | no | stylised and anime |
| fal MiniMax H3 | $0.25 | $0.30 (768P) | 5–15 | from image | yes | `target_audio_url` input; native unclear | general |
| fal Grok Imagine v1.5 Lite | **$0.11** | $0.16 | 1–15 | from image | no | unclear | cheapest drafts |
| fal Grok Imagine (v1) | $0.25 | $0.35 | 1–15 | auto, 16:9, 4:3, 3:2, 1:1, 2:3, 3:4, 9:16 | no | unclear | general |
| fal Luma Ray 2 Flash / Ray 2 | $0.20 / $0.50 (540p) | $0.40 / $1.00 | 5, 9 | 16:9, 9:16, 4:3, 3:4, 21:9, 9:21 | yes | no | realistic, cinematic camera |
| fal Luma Ray 3.2 | $0.15 (540p) | $0.30 | 5 (10 with keyframes) | 3:4, 4:3, 1:1, 9:16, 16:9, 21:9 | yes | no | realistic, HDR |
| fal Pika 2.2 | — | $0.20 | 5, 10 | from image (t2v: 7 ratios) | via Pikaframes | no | cartoon, effects |
| fal PixVerse v6 | $0.13 (360p) / $0.18 (540p) | $0.23 | 1–15 | from image | no | optional | **anime / cartoon** (`style: anime`) |
| Runway gen4_turbo (direct) | — | $0.25 | 2–10 | 1280:720, 720:1280, 1104:832, 832:1104, 960:960, 1584:672 | no | no | realistic |
| Kling 2.5 Turbo (direct) | — | $0.21 | 5, 10 | from image | yes (v3: `last_frame`) | v2.6/v3 | realistic |

**Note on "best for".** No source did a head-to-head anime test.
- Seedance 2.0 leads Artificial Analysis blind i2v votes, and Kling 3.0 leads one video arena. Veo 3.1 is the most polished at audio. These rankings measure general, mostly realistic quality: https://techsy.io/en/blog/best-ai-video-models , https://atlascloud.ai/blog/guides/best-ai-video-generation-models-2026
- PixVerse is the only model a review singles out for anime and stylised work, and it is the only one with an explicit `anime` style parameter: https://atlascloud.ai/blog/guides/best-ai-video-generation-models-2026
- Kling is described as strong at stylisation: https://www.kapwing.com/resources/seedance-vs-veo-vs-kling-text-to-video-comparison-2026
- Treat this column as a starting point for an A/B test with our own manga panels, not as a fact.

## 5. Adapter recommendations
1. **Use fal as the primary provider:**
   - Submit to `queue.fal.run`, store the returned `status_url`, `response_url` and `cancel_url`, and poll the status with `?logs=1` on a backoff.
   - On `COMPLETED`, check `error`/`error_type`; otherwise GET the response and download `video.url` straight away (it is kept for at least 7 days).
   - Upload input images to the fal CDN, or pass our own public URL if one is reachable.
2. **Send every enum explicitly:** `duration`, `generate_audio: false`, and `resolution`. Defaults are often the expensive option: `1080p` on Wan 2.5, 2.6 and 3.0; audio on for Kling 2.6/3, Veo and Seedance; `duration: "auto"` on Seedance 2.0.
3. **Compute cost at submit time** from a per-model formula: per second × resolution × audio, per clip, or per token. Fal does not return cost inline; reconcile later through `/v1/models/billing-events?request_id=` if needed.
4. **Model each endpoint as a small record:** endpoint id, image field name, end-frame field name, duration enum and type, resolution enum, aspect ratio enum, and audio flag name. Field names differ across models:
   - start image: `image_url` vs `start_image_url`
   - end image: `end_image_url` vs `tail_image_url` vs `last_frame_url`
   - duration: `"5"` vs `"5s"` vs `5`
   - audio flag: `generate_audio` vs `audio` vs `generate_audio_switch`
5. **Gemini Veo direct** is worth adding as a second provider: it is cheaper than fal's audio rate and needs no fal account. Remember that the image is sent as `inlineData` base64, polling uses the operation name, the download needs the API key, and videos are deleted after 2 days.
