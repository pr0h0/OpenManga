# AI video

A shot can play a **generated video clip** instead of its still and slow camera move. Clips are made from the shot's
own artwork (image-to-video), so the characters, outfits and places stay the ones your references fixed; a few models
can also make a shot from its words alone. Videos (panel cut, Shorts) then play each clip where the shot is, held on
its last frame when the narration runs longer, and fall back to the still with its camera move for shots without one.

On top of that, for ads: a script written from a **brief**, **text on screen** per shot, a **music bed** under the
narration, and a clip's **own sound** mixed in when the model makes one.

## Models

Every server has **Still motion**: the shot's image with a camera move, made by ffmpeg on the worker. It is free,
needs no key and is what tests and demos use. Nothing moves inside the picture.

Paid models run on **fal.ai** with your own key (Account → AI providers → fal.ai). The list, with list prices that seed
the rate table (check fal's pricing before relying on them; [VIDEO_PROVIDERS](VIDEO_PROVIDERS.md) has the sources):

| Model | Price | Good for |
| --- | --- | --- |
| Seedance 1.0 Pro Fast | ~$0.01/s at 480p, ~$0.02/s at 720p | Cheapest real motion; realistic and anime |
| Grok Imagine 1.5 Lite | $0.02–0.03/s + $0.01 a clip | Very cheap drafts |
| Hailuo 02 Standard | $0.017/s (512P), $0.045/s (768P); 6 or 10 s | Stylised, anime; lands on an end frame |
| Wan 2.5 | $0.05–0.15/s | General; also text-to-video |
| PixVerse v6 | $0.036–0.06/s | Anime style switch, used for manga and cartoon looks |
| Kling 2.5 Turbo Pro | $0.07/s (1080p); 5 or 10 s | Realistic, strong motion; end frame |
| Kling 3 Standard | $0.084/s, $0.126/s with sound | Cinematic, stylisation, sound |
| Veo 3.1 Fast | $0.10/s, $0.15/s with sound | Polished realism with sound (check it is still on fal) |

A run asks for a length, resolution and shape; each model gets the closest it offers (a 4 s request on a model with 5
and 10 s makes 5 s), and the price shown before anything runs is for what will actually be made. Usage is recorded per
second of video against the rate snapshot `<model>@<resolution>[+audio]`, so the project budget cap and the server's
monthly cap apply to video like to everything else.

## In the app

- **Panel tab → Video clip**: pick a model (paid ones show their price, and stay greyed out until you add a fal key),
  the length and resolution, optionally "what moves" (blank writes it from the shot's beat and directing), then *Make
  clip*. *Compare with* makes a second clip with another model; both are kept and you choose which the shot plays. The
  shot's clips are listed with their model, length and cost: *Use* one, trash one, or go back to the still. A clip with
  sound can mix it under the narration. *Text on screen* sets a line drawn over the shot for its whole hold (headline,
  caption, or a boxed call to action) at the top, middle or bottom.
- **Chapter → Animate shots**: one model for every drawn shot of the chapter. *Check the price* shows how many shots,
  seconds and dollars; *Animate* queues them. Each clip becomes its shot's when it lands.
- **Story → Ad from a brief**: product, audience, the one thing to remember, offer, call to action, notes (brand rules,
  claims to avoid), length and tone. The text model writes the script as scenes (VISUAL, VOICEOVER, ON SCREEN), saved
  as a new revision of the story; analyse and plan it like any story.
- **Settings → Video → Music bed**: upload a track (MP3, WAV, OGG, FLAC, M4A), set its volume, and choose whether it
  is lowered while the narrator speaks.
- **New project**: *AI video ad, 60 s (realistic)*, *AI video ad, 60 s (cartoon)* and *AI video story, 3 min (anime)*
  start a 16:9 film project with the look and 4–6 s shots set. A film made 9:16 (Shorts) gets vertical clips.
- The **preview** plays the clips and shows the text on screen, as the render will.

## An ad, start to finish

1. New project → *AI video ad, 60 s (realistic)* (or cartoon).
2. Story → *Ad from a brief* → *Write the script*. Read it; edit it like any story.
3. *Analyze* → apply → plan the chapter. Approve the product's reference image so every shot shows the same product.
4. *Generate all missing panels* (the stills).
5. Chapter → *Animate shots*: check the price with Still motion (free) first, then with the paid model you want.
6. Put the script's ON SCREEN lines on their shots (Panel tab → Video clip → *Text on screen*); the last shot gets the
   call to action, boxed.
7. Narration → generate and voice it. Settings → Video → music bed, intro/outro cards and the logo watermark.
8. Preview, then Exports → *Panel-cut video* (or *Export for* a platform: YouTube, Shorts, TikTok, Reels).

## How the render uses a clip

A shot with a clip holds at least the clip's length (so the whole clip plays), at least its narration, and at least
its own minimum hold. The clip is scaled to fill the frame (cropped around the centre if its shape differs), converted
to the film's frame rate, held on its last frame if the shot is longer, cut if shorter, faded at scene breaks and
watermarked like every shot. Its sound, when the shot mixes it, starts at the shot and stops with it, at 60% under the
narration. The music bed loops under the whole film; with ducking a sidechain compressor presses it down while the
narration speaks. Text on screen and Shorts captions are burned in one pass over the joined film.

## For agents (MCP)

`video_clips` lists the models, a shot's clips, makes (or compares) clips, picks one, trashes one and animates a whole
chapter, always with `dryRun` to price first; `write_ad_script` writes the script from a brief. A shot's clip prompt,
clip sound and text on screen are `update_panel` `video` fields; the music bed is `update_project` `settings.video.music`
(the track itself is uploaded in the app). Paid runs are classed as spending and may wait for your approval; the free
model is not.

## How it runs

Each clip is a `panel_clip` generation job on the `video-generation` queue (`VIDEO_WORKER_CONCURRENCY`, default 2;
needs ffmpeg on the worker). A paid run uploads the shot's image (fitted inside 1920 px as JPEG) to fal, submits it,
stores fal's request handle on the job, and polls with backoff; a worker that restarts polls the same request instead
of paying for another, and cancelling asks fal to cancel too (a request already running may still be billed). The
result is downloaded at once (fal keeps it about a week), probed for its length and size, and stored as a
`panel_clip` asset with the shot's artwork as its parent. Nothing about fal's request format lives outside
`packages/ai-video`.
