# Video export — how the exporter works

Two export kinds render a narrated MP4 from a project: `video_pages` (page cut, one shot per page) and
`video_panels` (panel cut, one shot per panel, Ken Burns move). Both are deterministic ffmpeg compositions with no
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

The browser preview (`GET /api/video-preview`, `apps/web/src/features/video/VideoPreview.tsx`) calls the same shot
planner and the same `@openmanga/domain` helpers (through its `browser` entry), so what it plays is the plan the render
executes. Any timing or framing rule that belongs to both therefore lives in `packages/domain/src/video.ts`, not in
the worker.

The preview covers one chapter, page or panel (the export can also take the whole project). It plays on the Web
Audio clock: every narration segment is scheduled on the browser's audio clock ahead of time and the picture reads
the same clock, so narration keeps playing in a background tab (where animation frames stop) and the picture catches
up on return. It opens at 95% of the window with an optional full-screen mode.

## Output target and options

Defaults from the export request schema; every value is overridable per export.

| Option | Default | Notes |
| --- | --- | --- |
| `height` | `1080` | `720`, `1080` or `1440`; width is derived 16:9 and forced even (`frameSizeFor`) |
| `fps` | `30` | 12–60 |
| `minHoldMs` | `2500` | Floor on every shot |
| `breathMs` | `150` | Silence after a shot's narration before the cut (`VIDEO_BREATH_MS`) |
| `framing` | `"width"` | Page cut: `width` = page at `pageWidthRatio` with a capped scroll; `height` = whole page |
| `pageWidthRatio` | `0.6` | Page cut, `framing: "width"` |
| `pageHeightRatio` | `0.96` | Page cut, `framing: "height"` |
| `maxScrollPxPerSec` | `60` | Scroll-rate cap for the page cut |
| `zoom` | `0.06` | Panel cut: Ken Burns travel over the hold (6%) |
| `concurrency` | `VIDEO_ENCODE_CONCURRENCY` (4) | Clips rendered and encoded at once |

Encoding: H.264 `-preset veryfast -crf 20` per clip (`-tune stillimage` for the page cut, which is a still image
under a crop; not for the panel cut, where `zoompan` moves every frame), AAC 192 kbit/s 48 kHz stereo on the mux,
`-movflags +faststart` on both the mux and the normalised output. Faststart matters as soon as files get large: a
multi-gigabyte upload otherwise cannot start playing until fully buffered.

Each export writes two files: the MP4 and an `.srt` sidecar of the narration segments with the same base name.

## Shot list

`planVideoShots` builds the shots from the database — chapters → pages → panels in reading order — for a scope of
one panel, one page, one chapter, or the whole project (all nulls, chapters in order, one film).

- **Page cut:** one shot per page. Narration lines attached to a page, or to any panel on it, play over that page.
- **Panel cut:** one shot per panel in reading order. A line attached to a panel plays over that panel; a line
  attached only to a page plays over that page's first panel.

Lines that fall outside the scope are counted and reported as `unplacedLines` on the export, so narration silently
left out of a film is visible rather than lost.

## Timing: frame-exact holds

`holdFor(narrationMs, hasNarration, minHoldMs, fps, breathMs)` is the whole timing rule:

```
frames = ceil(max(minHoldMs, narrationMs + (hasNarration ? breathMs : 0)) * fps / 1000)
holdMs = frames * 1000 / fps
```

Holds are whole frames, so a clip and its audio are exactly the same length. That is why there is no `-shortest`
anywhere in the pipeline and no per-clip drift to accumulate: the concat is muxed with
`-t (totalFrames / fps)` and the audio track was built to that same length.

**Minimum hold ~2.5 s.** A small share of panels carry a deliberate short beat that speaks in well under 1.5 s.
Left alone those are flash-frames. The floor pads them with silence instead of forcing the writing to be longer.

**Breath 150 ms.** Segments are silence-trimmed when stored (`TTS_TRIM_SILENCE`), so the breath and the segment's
own `pauseAfterMs` are the only pauses at a cut. A larger breath on top of untrimmed voice padding made every shot
change an audible ~1.2 s hole, which is where the 150 ms comes from.

## Audio assembly

Pass 1 walks the shots in order and appends narration to a single `narration.wav` on disk — never the whole film in
memory. Per shot:

1. Read each segment's active audio asset. Anything that is not 24 kHz mono 16-bit PCM is converted with
   `ffmpegConvert` first; `concatWav` refuses mixed formats.
2. Concatenate the segments with their `pauseAfterMs` gaps between them (not after the last one).
3. Append the result, then append `holdMs - narrationMs` of silence so the track matches the frame-exact hold.
4. Record subtitle cues on the running clock, and per-shot report fields (`narrationMs`, `holdMs`, `segments`,
   `missingAudio`).

The WAV header is rewritten with the final sizes once the last shot is appended. A shot with no narration at all is
simply `minHoldMs` of silence in that track — there is no separate silent input and no `anullsrc`, so a film that
mixes narrated and un-narrated pages still concats as one uniform stream.

## Page cut framing

`pageShotBox` decides the foreground size:

- A page already in the frame's aspect (within 0.02) fills the frame. This is the film-project case: at 3/5 width a
  16:9 shot would sit pillarboxed on a blurred wash with no overflow to scroll, i.e. a completely static video.
- `framing: "width"` → `frameW * pageWidthRatio` wide, height from the page aspect.
- `framing: "height"` → `frameH * pageHeightRatio` tall, width from the page aspect.

The page is rendered lettered (`renderPageImage`) at 1.25× the displayed width — clamped to 0.25–3× the page's own
size — and resized to that box. When the box is taller than the frame it is cropped to frame height and the crop
window travels down over the hold; when it fits, it is simply centred.

**Cap the scroll rate (default 60 px/s).** Traversing the whole page over whatever hold it happens to have gives a
short page an unwatchable pan — a 1080-high frame over a 3/5-width page of standard proportions leaves several
hundred pixels of overflow, which a 1.1 s hold would cross at hundreds of px/s. `scrollPlan` clamps travel to
`maxPxPerSec * holdSec`, and when the hold cannot cover the overflow at that rate it **centres** the visible
window rather than starting at the top, so a quick page shows its middle instead of only its head. The realised
rate is reported per page as `scrollPxPerSec`.

A continuous scroll cut (travel = full overflow, ignoring the cap) is the same renderer with a different
`scrollPlan`; it is not built — see `docs/ROADMAP.md`.

## Panel cut framing

`panelShotBox` takes the panel's on-page aspect (frame size × page size):

- Within 0.02 of the frame aspect → fills the frame, no backdrop. Film projects take this path.
- Otherwise → the largest even box of that aspect inside a 3% margin, centred over a blurred backdrop of its own
  art. Comic panel art arrives in many shapes, none of them 16:9, so the backdrop is doing real work.

The source is the **clean artwork**, cropped exactly as it appears on the page (`computeCrop` from the panel's
frame aspect and image transform) — no bubbles. A panel with no active artwork falls back to the lettered crop of
the rendered page (reported as `source: "lettered-page-crop"`), which keeps the real art with its bubbles rather
than leaving a hole.

Direction comes from the panel's own `shotType`: `close`, `extreme-close` and `insert` pull **out**; everything else
pushes **in** (`kenBurnsPullsOut`). The move is a `zoompan` over the clip's frames, anchored on the image focus
(`focusInCrop`) rather than the geometric centre, so the move ends on what the panel is about:

```
zoompan=z='1+0.06*on/<frames>':x='(iw-iw/zoom)*<focus.x>':y='(ih-ih/zoom)*<focus.y>':d=1:s=<w>x<h>:fps=<fps>
```

**Supersample 3× before `zoompan`.** Zooming a source at display size quantises the crop and visibly shakes.
Rendering the foreground at 3× the box and letting `zoompan` output at box size removes it entirely.
`kenBurnsZoomAt` in `@openmanga/domain` is the same curve, used by the preview.

## Backdrop

**Blur at 1/10 scale, not full resolution.** Blurring a full-size frame costs tens of seconds per clip, which
across a few dozen clips is most of the render time. `backdrop()` resizes to `frameW/10 × frameH/10` with
`fit: "cover"`, blurs, darkens (`brightness: 0.55`) and scales back up with a cubic kernel — visually identical for
a wash this heavy and roughly an order of magnitude faster. It is Sharp, not an ffmpeg `boxblur`, because the
foreground and backdrop PNGs are prepared before ffmpeg is invoked at all.

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

## Sizing expectations

Useful for judging a render before starting one: hold time is narration-bound, so runtime is roughly the sum of the
narration plus `breathMs` per shot, with `minHoldMs` as the floor on short shots. Kokoro at speed 1.0 measures
around 210 words per minute, so ~20 words of narration is a ~6 s shot. Encoding is roughly one core per concurrent
clip at `veryfast`, and a 1080p panel-cut film of a few hundred shots lands in the hundreds of megabytes.
