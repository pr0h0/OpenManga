# Storage

Every binary the system produces or accepts — references, panel art, masks, thumbnails, audio, exports — is one
`assets` row plus one opaque file. Derived renditions are `asset_variants` rows that can be deleted and recreated.
`docs/DATA_MODEL.md` has the columns; this document covers the file layer.

## AssetStorage

`packages/storage/src/index.ts` defines the interface and two implementations, chosen by `STORAGE_DRIVER`
(`createAssetStorage`): `local` (the default) and `s3`.

```ts
put(key, data): Promise<StoredObjectMetadata>
putFile(key, srcPath)      // store a file from disk without buffering it in memory (exports, video)
read(key): Promise<Uint8Array>
stream(key): ReadableStream<Uint8Array>  // for files too large to hold in memory (videos)
exists(key) / delete(key) / getMetadata(key)
internalPath?(key): string // local: relative path handed to nginx for X-Accel-Redirect
presign?(key, opts): string // s3: short-lived signed download URL carrying the content type and file name
```

Everything that reads or writes asset bytes goes through this interface: uploads, generation output, derivatives,
page composition, video rendering (artwork and audio are read into memory and written to the job's temp directory
for ffmpeg, as on local disk), exports, imports, duplication and deletion. Nothing reads `ASSET_ROOT` directly
except nginx (local only) and the admin page's free-space figure (local only; `unavailable` with s3).

**Local** (`LocalAssetStorage`) is rooted at `ASSET_ROOT` (`/data/assets`, the `assets-data` Docker volume). Writes
go to a `.tmp-<random>` sibling and are then renamed, so a reader never sees a half-written file. `delete` ignores a
missing file.

**S3** (`S3AssetStorage`, `packages/storage/src/s3.ts`) uses Bun's built-in S3 client against any S3-compatible
server (AWS S3, Cloudflare R2, MinIO, Backblaze B2, …). The object key is `S3_PREFIX` + the storage key, so a local
file `ASSET_ROOT/<key>` and its object `<prefix><key>` correspond one to one and no database row changes between
drivers. A single PUT is atomic, so readers never see half an object either. `putFile` sends files up to 64 MiB in
one request and larger ones (video renders, export ZIPs) as a multipart upload of 16 MiB parts read from disk, four
in flight at once, so at most 64 MiB of the file is in memory (an 800 MB upload to MinIO peaked at 41 MB RSS). Bun's
own streaming writer buffers the whole file in memory before sending it (the same file peaked at 1.6 GB), so those
parts are sent with SigV4 URLs signed in `s3.ts`; a failed part aborts the whole upload. `delete` of a missing object succeeds.

| Setting | Meaning |
| --- | --- |
| `STORAGE_DRIVER` | `local` (default) or `s3` |
| `S3_ENDPOINT` | the service URL without the bucket; empty for AWS |
| `S3_PUBLIC_ENDPOINT` | the URL browsers reach the service at, when the server uses another name (e.g. `http://minio:9000` inside Docker). Signing is local, so it may be a host the server cannot reach. Default: `S3_ENDPOINT` |
| `S3_BUCKET`, `S3_REGION` (`us-east-1`), `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | the bucket and credentials; startup refuses `s3` without bucket and keys |
| `S3_SESSION_TOKEN` | only with temporary credentials (STS, an assumed role); used by Bun's client and the multipart signer. The credentials are read once at startup, so restart with fresh ones before they expire |
| `S3_FORCE_PATH_STYLE` | `true`: `https://endpoint/bucket/key` (MinIO and most self-hosted servers); `false` (default): `https://bucket.endpoint/key` |
| `S3_PREFIX` | prepended to every object key, to share a bucket |
| `S3_PRESIGN_EXPIRES_SECONDS` | lifetime of signed download URLs, 60 to 604800 (default 900) |
| `ASSET_CSP_ORIGIN` (nginx) | the bucket origin browsers load from, added to the app's `img-src` and `media-src`. The API logs it at startup (`asset downloads redirect to the bucket`) |

The bucket stays private: no public-read policy and no CORS rule are needed. The app loads assets in `<img>`,
`<audio>` and `<video>` elements and links, which follow the redirect; its one `fetch()` read (the video preview's
narration audio, decoded with Web Audio) adds `?proxy=1`, which streams the object through the API instead of
redirecting, so it stays same-origin.

Keys are server-generated, opaque and sharded: `newStorageKey(prefix, ext)` returns
`<type>/<aa>/<bb>/<32 hex>.<ext>` from 16 random bytes. Every key is validated against
`/^[a-z0-9][a-z0-9/_.-]*$/` with no `..`, no `//` and no trailing slash, and the resolved path must stay under the
root. An uploaded filename is never used in a path — it is kept only as metadata.

Export archives are written to a file in the job's temp directory by the worker's `ZipWriter`
(`apps/worker/src/lib/zip.ts`, ZIP64 past 4 GiB or 65,535 entries) and stored with `putFile`; PDFs likewise, page by
page, by `PdfWriter` (`apps/worker/src/lib/pdf.ts`). `ZipWriter.addStream` adds an entry chunk by chunk from a
stream, which is how a finished MP4 goes into a `youtube_package` zip without being read into memory. That package
holds `video/` (the newest completed full `video_pages` or `video_panels` export of the same scope, never a partial or
page-selection render: the MP4, its `.srt` and,
when the film spans more than one chapter, its `.chapters.txt` of YouTube timestamps), `thumbnail.png` (the project's
thumbnail with its headline composited, when there is one), `description.txt` (with the chapter timestamps appended),
`titles.txt`, `tags.txt`, and `pinned-comment.txt` and `thumbnail-headlines.txt` when those are set.

## Serving (`/cdn`)

`GET /cdn/a/:assetId[?v=thumbnail|preview|web|prompt_ref][&download=name][&trash=1]`
(`apps/api/src/routes/assets.ts`)

1. nginx proxies the request to the API with `X-Accel-Enabled: 1`, and strips that header from client requests
   arriving anywhere else.
2. The API loads the asset by its opaque id. A trashed asset (`deleted_at` set) is 404 unless the request carries
   `trash=1`, which only the trash views send, so a deleted image does not live on wherever its id is still held.
   Unless the asset is `public` (nothing creates one — see `docs/SECURITY.md`) it requires a session (401); then
   the asset's owner is served, an asset with no project (an expert chat image) is 404 to anyone else, and for
   everyone else `projectAccess(…, "read")` decides, answering 404 for a non-member.
3. It resolves the requested variant. A missing `thumbnail`, `preview` or `web` is generated on the spot with Sharp
   (WebP, fitting inside 384 / 1024 / 2048 px, quality 80 / 85 / 85) and cached as a variant keyed by
   `sha256(sourceSha:variant:maxSize:webp:qN)` (`thumb` for the thumbnail). `prompt_ref` is not generated here — see
   `docs/IMAGE_REFERENCES.md`.
4. It replies with `content-type`, an `etag` derived from the served file's own hash (the variant's, when one is
   served) plus the variant name, `cache-control`
   (`private, max-age=3600`), `x-content-type-options: nosniff`, a `default-src 'none'` CSP, and
   `X-Accel-Redirect: /_protected_assets/<key>` with an empty body. A matching `if-none-match` gets a 304.
   `download=<name>` is sanitized to `[\w.\- ]`, truncated to 120 characters, and set as a
   `content-disposition: attachment`.
5. nginx serves the file from the read-only volume through an `internal` location. Direct requests to
   `/_protected_assets/` return 404.

Without nginx (tests, `bun dev`) the header is absent and the API streams the bytes itself, so the same route works
either way.

With `STORAGE_DRIVER=s3`, steps 1–3 are the same; then, unless `if-none-match` already matches (304), the API answers
**302** to a URL presigned for `S3_PRESIGN_EXPIRES_SECONDS` that also sets the response's `content-type` and, for
`download=`, its `content-disposition`. The redirect carries `cache-control` with the route's scope and a `max-age` of
the route's own value but never more than the URL's lifetime minus a minute (`private, max-age=840` for `/cdn` with
the default 900 s), so a browser never replays an expired URL. The bucket then serves the bytes, honouring range
requests for audio and video, and its own ETag and conditional requests. Variants work the same way: a missing
`thumbnail`/`preview`/`web` is generated from the original in the bucket, stored back, and redirected to.

Reader links do not use `/cdn`: `GET /api/public/shares/:token/pages/:pageId.png` serves the lettered page
(`?width=` 200–1600, default 1200, rounded up to a 200 px bucket). The first request renders it and stores the PNG
as a project asset of type `thumbnail` with `metadata.pageRender = { pageId, fingerprint, width }`
(`cachedPageRender` in `packages/services/src/compose.ts`); later requests serve that file the same way `/cdn` does,
with `cache-control: public, max-age=300` and an ETag. The fingerprint is a hash of everything the page is drawn
from — the page, panel frames, transforms and seams, each active artwork's hash, dialogue, narration boxes and SFX —
plus a compositor version, so any edit is a cache miss. Writing a new render deletes the page's renders with an older
fingerprint (and any copy at the same width); the same content at other widths stays. The library list hides these
assets and disk usage counts them as `derived`. The reader's video preview fetches panel artwork
(`?v=web`) and narration audio through `GET /api/public/shares/:token/assets/:assetId`, which serves the stored asset
the same way `/cdn` does (a redirect to a signed URL with S3), but only when it is a panel's active artwork or a
segment's active audio inside the link's scope.

## Moving to S3

Keys are identical on both drivers, so moving is a copy plus a configuration change:

1. Create a private bucket (and, for a separate key, credentials allowed to `GetObject`, `PutObject`, `DeleteObject`,
   `AbortMultipartUpload` and `ListBucket` on it).
2. Copy the volume while the app is still running on local storage. With `rclone` on the host (a remote named `s3`
   configured for the bucket's service):

   ```bash
   docker run --rm -v openmanga_assets-data:/data:ro -v ~/.config/rclone:/config/rclone:ro rclone/rclone \
     copy /data s3:<bucket>/<prefix> --exclude '*.tmp-*' --transfers 16 --checksum
   ```

   or with the AWS CLI (add `--endpoint-url https://…` for anything but AWS):

   ```bash
   docker run --rm -v openmanga_assets-data:/data:ro -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY \
     amazon/aws-cli s3 sync /data s3://<bucket>/<prefix> --exclude '*.tmp-*'
   ```

   `/data/<key>` becomes `<prefix><key>`; leave `<prefix>` out when `S3_PREFIX` is empty.
3. Stop the app (`docker compose stop api worker`), run the same copy again to pick up what changed meanwhile, then
   set `STORAGE_DRIVER=s3`, the `S3_*` settings and `ASSET_CSP_ORIGIN` in `.env` and `docker compose up -d`.
4. Open a few projects and an export download to check; the API's startup log names the origin downloads go to. Keep
   the volume until you are satisfied, then remove it. Going back is the same copy in the other direction.

### Backups with S3

`scripts/backup.sh` reads `STORAGE_DRIVER` from `.env`. With `s3` it dumps the database and saves the configuration
as before but does not archive assets (`manifest.json` records `"storage": "s3"`): the bucket is backed up with the
bucket's own tools — object versioning, replication to a second bucket, or a scheduled `rclone sync` to other
storage. Take the database dump and the bucket copy close together; a row whose object is missing serves a 404, and an
object with no row is only wasted space. `scripts/restore.sh` restores the database and configuration from such a
backup and says that the bucket is restored separately. Restoring an older local backup (with `assets.tar.gz`) into an
`s3` install restores the database only and points here: extract the archive and copy it into the bucket as in step 2.

## Uploads

PNG, JPEG and WebP only, decided by magic bytes (`sniffImageMime`), never by the declared content type; anything else
is 415. Size is checked against both `content-length` and the parsed file against `UPLOAD_MAX_BYTES` (15 MiB by
default) and answers 413. The bytes are then re-encoded with Sharp — `rotate()` bakes in EXIF orientation and the
re-encode drops all other metadata including GPS — with a 40 MP input limit as a pixel-bomb guard
(`apps/api/src/lib/uploads.ts`, `packages/image-utils/src/index.ts`).

## Derivatives and retention

The hourly `maintenance` queue job (`apps/worker/src/handlers/maintenance.ts`, scheduled by
`upsertJobScheduler("hourly-cleanup", { every: 3600_000 })`, also triggerable via `POST /api/admin/maintenance`) is
the only thing that deletes on a timer:

| Data | Policy |
| --- | --- |
| Canonical references, active panel art, panel version history | kept |
| Thumbnail / preview / web variants | generated on demand, cached, kept |
| `prompt_ref` variants | deleted after 30 days without use, recreated on demand |
| Reader-link page renders | replaced when the page changes; a deleted page's renders are removed by the next cycle |
| Export files | `exports.expires_at` is 30 days after the export; the file is deleted once it passes and the job row is kept as history |
| Cached video sections | kept while a video export that used them still has its files; deleted with the export, when it expires, or when a newer render of the same series no longer uses them |
| Trashed assets | hard-deleted 30 days after `deleted_at`, never when `locked` or when a panel still points at them |
| Temp files under `TEMP_ROOT` | per-job directories removed after use; anything older than 6 hours swept |
| Sessions | deleted when expired, or 7 days after being revoked |
| Password reset tokens | deleted once used, or 1 day after expiry |
| Jobs stuck in `processing` | failed (`stalled`) once the row has had no write for `STALLED_JOB_TIMEOUT_MINUTES` (120) and the queue no longer reports it active, so the UI and retries unblock; generation, audio and export jobs alike |
| Batched panels whose batch submitter failed for good | failed (`batch_submit_failed`) so they can be retried |
| Published outbox rows | deleted after 7 days |

The same cycle re-encrypts provider credentials onto the current key (`docs/SECURITY.md`).

## Deletion

Projects and important assets go to trash first (`deleted_at`); permanent deletion requires that trashing step and
then removes both rows and files, derivatives included. `assets.hardDelete` removes an asset's variants with it. Panel
artwork versions cannot be trashed while they are a panel's active artwork, and `DELETE /api/assets/:id` refuses a
locked reference. Trashing a character, location or prop trashes its reference images with the same timestamp;
restoring it restores exactly those.

Two kinds of file skip the trash and leave the disk at once:

- **Exports**: `DELETE /api/exports/:id`, or `DELETE /api/projects/:projectId/exports` for every finished export
  (running exports and import records are kept). A queued or running export must be cancelled first.
- **Narration audio**: `DELETE /api/chapters/:id/narration/audio` (`?language=` for one track) or
  `DELETE /api/projects/:projectId/narration/audio` removes every take; the narration text stays. Refused while
  synthesis in that scope is queued or running.

## Disk usage

`GET /api/projects/:projectId` returns `disk`: the byte size of every stored file of the project, by category
(`artwork`, `references`, `narration`, `exports`, `renderCache` — cached video sections, `derived` — variants and other
assets), with the part in the trash.
Database rows are not counted.
