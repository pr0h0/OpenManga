# Video export — how the exporter works

Three export kinds render a narrated MP4 from a project: `video_pages` (page cut, one shot per page),
`video_panels` (panel cut, one shot per panel, Ken Burns move) and `video_shorts` (a 30–60 s trailer of picked panels,
vertical by default; see Shorts cut). All are deterministic ffmpeg compositions with no
AI anywhere in them, consistent with the invariant that exports are deterministic compositions. `ffmpeg` is already
a dependency of `packages/audio` (`ffmpegConvert`) for audio transcode and loudness normalisation, and `ffprobe` is
used for the final duration check.

Code:

| Part | Where |
| --- | --- |
| Renderers, ffmpeg invocation, film assembly | `apps/worker/src/lib/video.ts` |
| Pure geometry and timing maths (shared with the browser preview) | `packages/domain/src/video.ts` |
| Shot list and narration lookup | `packages/services/src/video-plan.ts` |
| Export options and defaults | `apps/api/src/routes/exports.ts`, `apps/worker/src/handlers/export.ts` |
| YouTube package export (`youtube_package`) | `apps/worker/src/handlers/export.ts` |

The browser preview (`GET /api/video-preview`, `apps/web/src/features/video/VideoPreview.tsx`) calls the same shot
planner and the same `@openmanga/domain` helpers (through its `browser` entry), so what it plays is the plan the render
executes. Any timing or framing rule that belongs to both therefore lives in `packages/domain/src/video.ts`, not in
the worker.

The preview covers one chapter, page or panel (the export can also take the whole project or a page selection). It
plays on the Web Audio clock: every narration segment is scheduled on the browser's audio clock ahead of time and the
picture reads the same clock, so narration keeps playing in a background tab (where animation frames stop) and the
picture catches up on return. It opens at 95% of the window with an optional full-screen mode.

## Output target and options

Defaults from the export request schema; every value is overridable per export.

| Option | Default | Notes |
| --- | --- | --- |
| `height` | `1080` | `720`, `1080` or `1440`: the frame's short side (`frameSizeFor`), the long side derived and forced even |
| `aspect` | `"16:9"` | `"9:16"` (vertical) or `"1:1"` (square); `video_shorts` defaults to `"9:16"`. See frame profiles |
| `fps` | `30` | 12–60 |
| `minHoldMs` | `2500` | Floor on every shot. The Exports page pre-fills it with the project's target runtime `minShotSeconds` when one is set; the API default is unchanged |
| `breathMs` | `150` | Silence after a shot's narration before the cut (`VIDEO_BREATH_MS`) |
| `framing` | `"width"` | Page cut: `width` = page at `pageWidthRatio` with a capped scroll; `height` = whole page; `scroll` = the `width` box travelling the whole page over its hold |
| `pageWidthRatio` | `0.6`, or `1` vertical/square | Page cut, `framing: "width"` or `"scroll"` |
| `pageHeightRatio` | `0.96` | Page cut, `framing: "height"` |
| `maxScrollPxPerSec` | `60` | Scroll-rate cap for the page cut |
| `zoom` | `0.06` | Panel cut: camera travel over the hold (6% zoom, or the slack a pan crosses) |
| `concurrency` | `VIDEO_ENCODE_CONCURRENCY` (4) | Clips rendered and encoded at once |
| `maxDurationMs` | unset | Partial render: stop after the shot that reaches this length (10 s to 24 h); see below |

Outside the `video` bucket, the request's `pageIds` (up to 500) narrows the film to those pages; see the shot list.

## Frame profiles

`aspect` picks the frame: 1080 gives 1920×1080 landscape, 1080×1920 vertical (Shorts, Reels, TikTok) or 1080×1080
square. Nothing is generated at the new shape — image providers return 9:16 squeezed — so every profile is framed from
the existing art:

- **Panel cut.** Landscape keeps the whole panel as before (fitted over a blurred copy when its shape differs).
  Vertical and square frames (`cropsToFrame`) instead crop each panel's artwork to the frame's own shape around the
  panel's focal point (`computeCrop` with the panel's image transform, the same helper as the page crop), so the shot
  fills the frame, and the move is anchored on the focus inside that crop (`focusInCrop`). A panel without artwork
  keeps its fitted lettered crop.
- **Page cut.** The page fills the frame's width (`pageWidthRatio` 1) and scrolls as before.
- **Cards and watermark** are drawn at the frame's size (`?aspect=` on the card route).

The preview has the same Shape setting and plays the same crops (`fill` on each panel of the shot list).

## Shorts cut

`video_shorts` renders picked panels as a trailer: `panelIds` (1–100, panels of the project) played in story order
whatever order they are given in, each shot with its own narration (a line attached only to a page plays over that
page's first panel when that panel is picked; spans are ignored), at most `SHORTS_MAX_MS` (60 s): the film ends before
the shot that would pass it. It has no intro or outro card (the watermark stays) and its readiness check is empty,
since the picker only offers panels with artwork. Files are named `…_shorts_9x16_1080p.mp4`.

`GET /api/projects/:projectId/shorts?chapterId=&minHoldMs=&targetSeconds=` (MCP `suggest_shorts`) lists every panel of
the chapter or project as a candidate with its hold (its own narration through `timeGroup`, at least `minHoldMs`), its
narration text, a drama score and the automatic pick. `pickShorts` (`packages/domain/src/video.ts`) scores a shot by
its type (extreme close-ups, close-ups and inserts first) plus its line (`lineDrama`: exclamations, questions, short
punchy lines, words of sudden action), splits the story into as many stretches as shots fit the target (45 s) and takes
the best of each, so the trailer spans the whole story rather than its opening; then drops the weakest until it fits
60 s and adds the strongest left over until it reaches 30 s. On the Exports page (*Shorts*) the pick is a checklist with
the running length; change it, preview it (`/api/video-preview?panelIds=…&aspect=9:16`, which applies the same 60 s
limit) and render it.

Encoding: H.264 `-preset veryfast -crf 20` per clip (`-tune stillimage` for the page cut, which is a still image
under a crop; not for the panel cut, where `zoompan` moves every frame), AAC 192 kbit/s 48 kHz stereo on the mux,
`-movflags +faststart` on both the mux and the normalised output. Faststart matters as soon as files get large: a
multi-gigabyte upload otherwise cannot start playing until fully buffered.

Each export writes the MP4 and an `.srt` sidecar of the narration segments with the same base name, plus a
`.chapters.txt` when the film spans more than one chapter (see chapter timestamps).

## Shot list

`planVideoShots` builds the shots from the database — chapters → pages → panels in reading order — for a scope of
one panel, one page, a selection of pages (`pageIds`, played in reading order whatever order they are given in), one
chapter, or the whole project (all nulls, chapters in order, one film). An export with `pageIds` uses the selection in
place of its `chapterId`; the pages must belong to the project. The Exports page sends a from–to page range within the
chosen chapter this way.

- **Page cut:** one shot per page. Narration lines attached to a page, or to any panel on it, play over that page.
- **Panel cut:** one shot per panel in reading order. A line attached to a panel plays over that panel; a line
  attached only to a page plays over that page's first panel.

Lines that fall outside the scope are counted and reported as `unplacedLines` on the export, so narration silently
left out of a film is visible rather than lost. A page, page-selection or panel scope does not count them: leaving
the rest out is the point.

## Shot settings

Each panel carries its settings as a video shot in `panels.video` (`ShotVideo`; editor → Panel → *Video shot*,
`PATCH /api/panels/:id` `{ video }`, MCP `update_panel`):

| Field | Values | Effect |
| --- | --- | --- |
| `motion` | `auto` (default), `static`, `pan-left`, `pan-right`, `pan-up`, `pan-down`, `push-in`, `pull-out` | Panel cut camera move (below) |
| `fade` | `auto` (default), `on`, `off` | The cut *into* this shot: follow the project's scene-break fade, always fade through black, or always a hard cut |
| `disabled` | `false` (default) | Leave the shot and its narration out of every video; the panel stays on the page |

A disabled panel is left out of the panel cut, and its narration out of both cuts; a page whose panels are all
disabled leaves the page cut too. Disabled panels are reported as `disabledPanels`, not as unplaced lines. Scoping
a preview to a disabled panel still plays it, so its move can be checked.

**Fades.** `settings.video.fadeAtSceneBreaks` fades to black where the scene changes (a panel's scene, else its
page's). A fade is half a second out of the last shot and half a second into the next (`VIDEO_FADE_MS`), never more
than a third of either clip, rendered as ffmpeg `fade` filters counted in frames inside each clip. Clip lengths do not
change, so the hold arithmetic and the duration check are unaffected. In the page cut a page's override is its first
panel's. `fadeCuts` and `fadeOpacity` in `@openmanga/domain` are the shared rule and ramp.

**Spanning narration.** A narration line's `video` (`NarrationLineVideo`, `PATCH /api/narration-lines/:id`
`{ video }`, MCP `edit_narration`) holds `untilPanelId`, `startOffsetMs` and `endOffsetMs`. `untilPanelId` (a panel
in the same chapter) joins the line's shot to every following shot up to that panel's, so the run shares one hold
(see timing). The offsets are silence before and after the line, and apply to any line, spanning or not. When the
end panel is disabled the span ends on the last shot before it.

## Timing: frame-exact holds

`holdFor(narrationMs, hasNarration, minHoldMs, fps, breathMs)` is the timing rule for one shot:

```
frames = ceil(max(minHoldMs, narrationMs + (hasNarration ? breathMs : 0)) * fps / 1000)
holdMs = frames * 1000 / fps
```

`timeGroup` applies it to a *hold group*: one shot, or the run of shots a spanning line joins (`shotGroups`). A
group's lines play one after another — each line's start offset, its segments with their pauses between them, its end
offset, then its last pause before the next line — and the group holds that plus the breath, at least `minHoldMs` per
shot, in whole frames split evenly over its shots (earlier shots take the odd frames). A single shot without offsets
times exactly as `holdFor`. The render and the preview both call `timeGroup`.

Holds are whole frames, so a clip and its audio are exactly the same length. That is why there is no `-shortest`
anywhere in the pipeline and no per-clip drift to accumulate: the concat is muxed with
`-t (totalFrames / fps)` and the audio track was built to that same length.

**Minimum hold ~2.5 s.** A small share of panels carry a deliberate short beat that speaks in well under 1.5 s.
Left alone those are flash-frames. The floor pads them with silence instead of forcing the writing to be longer.

**Breath 150 ms.** Segments are silence-trimmed when stored (`TTS_TRIM_SILENCE`), so the breath and the segment's
own `pauseAfterMs` are the only pauses at a cut. A larger breath on top of untrimmed voice padding made every shot
change an audible ~1.2 s hole, which is where the 150 ms comes from.

## Audio assembly

Pass 1 walks the hold groups in order and writes narration to a single `narration.wav` on disk — never the whole
film in memory. Per group:

1. Read each segment's active audio asset. Anything that is not 24 kHz mono 16-bit PCM is converted with
   `ffmpegConvert` first.
2. Time the group with `timeGroup`, which gives every segment its start on the group's clock.
3. Write each segment at its sample position on the film clock, with silence up to it, then silence up to the end of
   the group. Positions are absolute, so rounding never accumulates.
4. Record subtitle cues at the same positions, and per-shot report fields (`holdMs`, `segments`, `missingAudio`; the
   group's first shot also `narrationMs`, and `spanShots` and `fade` where they apply).

The WAV header is rewritten with the final sizes once the last group is written. A shot with no narration at all is
simply `minHoldMs` of silence in that track — there is no separate silent input and no `anullsrc`, so a film that
mixes narrated and un-narrated pages still concats as one uniform stream.

## Page cut framing

`pageShotBox` decides the foreground size:

- A page already in the frame's aspect (within 0.02) fills the frame. This is the film-project case: at 3/5 width a
  16:9 shot would sit pillarboxed on a blurred wash with no overflow to scroll, i.e. a completely static video.
- `framing: "width"` → `frameW * pageWidthRatio` wide, height from the page aspect.
- `framing: "height"` → `frameH * pageHeightRatio` tall, width from the page aspect.
- `framing: "scroll"` → sized exactly like `width`.

The page is rendered lettered (`renderPageImage`) at 1.25× the displayed width — clamped to 0.25–3× the page's own
size — and resized to that box. When the box is taller than the frame it is cropped to frame height and the crop
window travels down over the hold; when it fits, it is simply centred.

**Cap the scroll rate (default 60 px/s).** Traversing the whole page over whatever hold it happens to have gives a
short page an unwatchable pan — a 1080-high frame over a 3/5-width page of standard proportions leaves several
hundred pixels of overflow, which a 1.1 s hold would cross at hundreds of px/s. `scrollPlan` clamps travel to
`maxPxPerSec * holdSec`, and when the hold cannot cover the overflow at that rate it **centres** the visible
window rather than starting at the top, so a quick page shows its middle instead of only its head. The realised
rate is reported per page as `scrollPxPerSec`.

**The continuous scroll cut** is `framing: "scroll"`: the same renderer, but `scrollPlan(…, "scroll")` returns
`y0 = 0` and travel = the whole overflow, ignoring the cap, so every page is read from its top to its bottom over its
hold however short that is. The preview passes the framing to the same `scrollPlan`, so it plays the same move.

## Panel cut framing

`panelShotBox` takes the panel's on-page aspect (frame size × page size):

- Within 0.02 of the frame aspect → fills the frame, no backdrop. Film projects take this path.
- Otherwise → the largest even box of that aspect inside a 3% margin, centred over a blurred backdrop of its own
  art. Comic panel art arrives in many shapes, none of them 16:9, so the backdrop is doing real work.

The source is the **clean artwork**, cropped exactly as it appears on the page (`computeCrop` from the panel's
frame aspect and image transform) — no bubbles. A panel with no active artwork falls back to the lettered crop of
the rendered page (reported as `source: "lettered-page-crop"`), which keeps the real art with its bubbles rather
than leaving a hole.

The move is the shot's `motion`. `auto` comes from the panel's own `shotType`: `close`, `extreme-close` and `insert`
pull **out**; everything else pushes **in** (`kenBurnsPullsOut`) — unless the shot before made the same move, in which
case it pans towards the image focus instead (sideways, else up or down; `resolveMotions`), so a run of wide shots
does not read as one long zoom. An explicit motion is kept as set.

`motionPath` gives a move's start and end: the zoom, and where the visible window sits in the slack the zoom leaves
(0 = left/top, 1 = right/bottom). Pushes and pulls stay anchored on the image focus (`focusInCrop`) rather than the
geometric centre, so the move ends on what the panel is about; pans hold `1 + zoom` and travel the whole slack on
their axis, keeping the focus on the other; `static` is a still frame. The render turns it into a `zoompan` over the
clip's frames (`zoompanFor`), for example a push in:

```
zoompan=z='(1.0000+0.0600*on/<frames>)':x='(iw-iw/zoom)*<focus.x>':y='(ih-ih/zoom)*<focus.y>':d=1:s=<w>x<h>:fps=<fps>
```

**Supersample 3× before `zoompan`.** Zooming a source at display size quantises the crop and visibly shakes.
Rendering the foreground at 3× the box and letting `zoompan` output at box size removes it entirely.
The preview reads the same `motionPath` through `motionAt`.

## Backdrop

**Blur at 1/10 scale, not full resolution.** Blurring a full-size frame costs tens of seconds per clip, which
across a few dozen clips is most of the render time. `backdrop()` (`@openmanga/services`) resizes to `frameW/10 × frameH/10` with
`fit: "cover"`, blurs, darkens (`brightness: 0.55`) and scales back up with a cubic kernel — visually identical for
a wash this heavy and roughly an order of magnitude faster. It is Sharp, not an ffmpeg `boxblur`, because the
foreground and backdrop PNGs are prepared before ffmpeg is invoked at all.

## Branding

Project settings under `settings.video` (Project settings → Video, or `update_project`) apply to every video export
and show in the preview:

| Setting | Shape | Effect |
| --- | --- | --- |
| `watermark` | `{assetId, corner, opacity (0.8), size (0.12)}` or null | A logo over every frame, cards included |
| `intro`, `outro` | `{title, subtitle, durationMs (3000)}` or null | A title card before or after the film |

**Watermark.** The logo is an image of the project: upload one with `POST /api/projects/:projectId/video-logo`
(stored as a `source_image` asset with `metadata.role = "video_logo"`, so it counts toward the project's disk use),
then set its id; the settings route refuses an id that is not an image of the same project. `watermarkBox` places it:
`size` of the frame width at the logo's own aspect, even dimensions, in the chosen corner with a margin of 3% of the
frame's short side. The worker scales the logo to that box once per render and every clip overlays it last, after
any scene-break fade, so the logo stays up through a fade:

```
[base][N:v]format=rgba,colorchannelmixer=aa=<opacity>[wm];[base][wm]overlay=<x>:<y>,format=yuv420p[v]
```

A logo whose asset was deleted is left out rather than failing the render. Duplicating a project copies the logo;
the interchange package carries it as `project.videoLogo`.

**Cards.** `renderProjectVideoCard` (in `@openmanga/services`) draws a card at frame size: the project's art as a
dark wash (`backdrop` at 40% brightness; the YouTube thumbnail art, else the cover, else the first panel's artwork,
else plain dark grey) behind the title and subtitle, centred, in the project's narration lettering font. The preview
loads the same PNG from `GET /api/projects/:projectId/video-card/:which.png` (and a reader link from
`/api/public/shares/:token/video-card/:which.png`). A card is `cardFrames(durationMs, fps)` whole frames of a still
image with silence on the audio track, encoded as its own clip, so it adds nothing to the timing rules: everything
after the intro — subtitles, chapter timestamps (the first stays pinned to `0:00`), the duration check — simply
starts that much later. A partial render (`maxDurationMs`) ends without the outro.

## Assembly and loudness

Pass 2 encodes the clips in parallel (`ConcurrencyLimiter`, `VIDEO_ENCODE_CONCURRENCY`) — shots are independent
until the concat. The first error is held until every running encode has finished, so nothing writes into a temp
directory that is already being removed.

Then: concat with the video stream copied, the assembled narration muxed as AAC, and **one** two-pass loudness
normalisation over the finished file with the video copied again:

```
ffmpeg -i raw.mp4 -af loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json -f null -     # measure
ffmpeg -i raw.mp4 -c:v copy -af loudnorm=I=-14:TP=-1.5:LRA=11:measured_I=…:measured_TP=…:measured_LRA=…\
       :measured_thresh=…:offset=…:linear=true -c:a aac -b:a 192k -movflags +faststart out.mp4   # apply
```

Kokoro output lands well under broadcast level, so normalisation is not optional. Do **not** normalise per segment
or per clip and concatenate: single-pass `loudnorm` derives its gain from the content in front of it, so every join
gets an audible level step. Normalising once over the whole film keeps the joins inaudible. The measured loudness
JSON is kept in the export report.

## Verify against the source audio, never the build log

The last step probes the rendered file and compares it to the narration track that was built for it:

```
audioMs  = assembled narration bytes / (sample rate * 2)
videoMs  = ffprobe -show_entries format=duration
tolerance = 80 + 10 * clipCount   ms
```

Beyond tolerance the export **fails** with both numbers in the message. Because holds are frame-exact, the only
expected difference is encoder rounding (AAC priming, last-frame duration) — a few ms per clip. Anything larger is
a real mapping defect, and this check is what catches it: a build log that says "wrote N clips" proves only that
the loop ran, and a page-audio mapping bug reports as success there. `driftMs` and `driftPerClipMs` are recorded on
every export alongside `clips`, `subtitleCues` and the per-shot reports.

## Subtitles

Cues are accumulated during pass 1 from the same segment durations that drive the holds, so they cannot drift from
the audio. `toSrt` emits standard `HH:MM:SS,mmm` timing and the file ships next to the MP4 as
`application/x-subrip`. Subtitles are never burned in.

## Partial renders

`maxDurationMs` renders only the start of a film, for checking pacing or framing before committing to a long render.
Pass 1 stops appending once the running clock has reached the limit, after the shot that crossed it: a partial render
always ends on a whole shot, so it runs at least `maxDurationMs` and at most one shot longer. The remaining shots are
dropped before any clip is encoded, and the audio track, subtitles, chapter marks and the duration check all cover
only what was kept. The Exports page offers it as "only the first … minutes", alongside the page range.

## Chapter timestamps

Pass 1 records where each shot starts on the film clock; the renderers turn that into the start of each chapter's
first shot. When a film spans two or more chapters, the export adds `<name>.chapters.txt` in YouTube's description
format (`youtubeChapters` in `packages/domain/src/video.ts`): one `m:ss` (or `h:mm:ss` from an hour on) line per
chapter, titled `Chapter <order>: <title>`, with the first pinned to `0:00` because YouTube only reads a list that
starts there. A single-chapter film gets no file.

## YouTube package

`youtube_package` is a separate export kind that renders nothing: it zips what already exists, so it makes no AI
calls either.

- **Publishing text** comes from `settings.youtubePackage` (titles, description, tags, pinned comment, thumbnail
  headlines). A text job writes it (`POST /api/projects/:projectId/youtube-package`, kind `youtube_package`, prompt
  `youtubePackageV1`, answer schema `YoutubePackage`, paste mode and provider batches supported), and it stays
  editable in project settings. The export fails with an unrecoverable error until it has at least one title.
- **The video** is the newest *completed* `video_pages` or `video_panels` export of the same scope: the same chapter,
  or a whole-project render when no chapter is given. Partial renders (`maxDurationMs`) and page selections
  (`pageIds`) are passed over: the package always takes the full film. Without one the export fails and says so.

The ZIP (built with `ZipWriter`) holds `video/` with that export's files — the MP4 streamed in chunk by chunk
(`ZipWriter.addStream` over `AssetStorage.stream`), so a multi-gigabyte film never sits in memory — plus its `.srt`
and `.chapters.txt`; `thumbnail.png` rendered from the project's saved thumbnail, when there is one;
`description.txt` (the description with the chapter timestamps appended); `titles.txt`; `tags.txt`
(comma-separated); and `pinned-comment.txt` and `thumbnail-headlines.txt` when those are not empty. Like the video
kinds it needs the `art` and `narration` readiness areas.

## Sizing expectations

Useful for judging a render before starting one: hold time is narration-bound, so runtime is roughly the sum of the
narration plus `breathMs` per shot, with `minHoldMs` as the floor on short shots. Kokoro at speed 1.0 measures
around 210 words per minute, so ~20 words of narration is a ~6 s shot. Encoding is roughly one core per concurrent
clip at `veryfast`, and a 1080p panel-cut film of a few hundred shots lands in the hundreds of megabytes. A YouTube
package stores the video uncompressed inside the ZIP, so it is a second copy of that film on disk.
