# Running without any API keys

The whole pipeline can be driven by hand. Every text step will compile its prompt, park, and wait for you to
paste an answer from whatever chat you already use; every panel takes an image you upload; narration is
synthesised locally. Nothing in this mode contacts a provider, and nothing is billed.

| Step | With a key | Without one |
| --- | --- | --- |
| Story analysis, planning, panel prompts, narration text, QA, describe | the provider answers | **you paste the answer** |
| Panel artwork, references, covers | the provider draws | **you upload the image** |
| Narration audio | a TTS key, or local Kokoro | local Kokoro, unchanged |

## The idea

A pasted answer is not a second-class input. It goes through the same funnel a provider's reply does:
`runStructured` extracts the JSON, validates it against the same Zod schema, and the same appliers write the same
rows. The only thing swapped out is *where the text came from* — the provider is replaced, not the handler. This
is the same mechanism [provider batches](AI_PIPELINE.md#provider-batches-half-price-up-to-24h) use to park a job
for up to 24 hours and replay its answer later.

Consequences worth knowing up front:

- An answer that does not fit the schema is **rejected with the exact validation error**, and the job waits for
  another one. Nothing partial is ever applied.
- No JSON-repair call is made — repair exists to ask the model again, and here there is no model to ask. You get
  the error instead, which is the thing you need in order to fix the answer.
- Nothing is billed, because nothing was sent. Usage rows are written with zero tokens and zero cost.

## In the app

1. Open the model picker (the chip next to any generate button) and choose **Paste it yourself — no key needed**
   as the text provider. It is remembered per browser, so you only choose it once.
2. Run the operation as normal — Analyse story, Plan chapter, Prepare page prompts, and so on.
3. The job appears in the generation queue as **awaiting input**. Open it.
4. Copy the **Compiled prompt** — it is exactly what a provider would have been sent, including the schema the
   answer has to satisfy — and paste it into any chat.
5. Paste the reply into **Waiting for your answer**, or upload it as a `.json`/`.txt` file, and submit.

If the answer does not validate, the job returns to *awaiting input* with the reason shown above the box. Fix it
and paste again; there is no limit on attempts and no cost to a rejected one.

## Over the API

```bash
# 1. Start any text operation with manual: true — no credential is named, and none is needed.
curl -sX POST "$API/api/story-revisions/$REVISION_ID/analyze" \
  -H 'content-type: application/json' -b cookies -H "x-csrf-token: $CSRF" \
  -d '{"ai": {"manual": true}}'
# => 202 {"job": {"id": "…"}}

# 2. Once it is parked, fetch the prompt (status becomes awaiting_input within a second or two).
curl -s "$API/api/generations/$JOB_ID/manual" -b cookies
# => {"status":"awaiting_input","awaitingAnswer":true,"prompt":"### system\n…","lastError":null}

# 3. Send the answer back — as JSON, or as a file.
curl -sX POST "$API/api/generations/$JOB_ID/manual" \
  -H 'content-type: application/json' -b cookies -H "x-csrf-token: $CSRF" \
  -d "$(jq -Rs '{text: .}' < answer.json)"
curl -sX POST "$API/api/generations/$JOB_ID/manual" -b cookies -H "x-csrf-token: $CSRF" -F file=@answer.json
# => 202 {"accepted": true}
```

The job then runs itself to completion and everything downstream — review, apply, events — behaves as it always
does. Poll `GET /api/generations/:id` for `completed`, or `awaiting_input` again with `failureReason` set if the
answer was rejected.

`GET /api/generations/:id/manual` answers `409` for a job that names a provider: there is no prompt to answer by
hand, because that job will get its own.

## What the answer has to look like

Whatever the prompt asked for. The prompt always ends with the schema, so the reliable instruction to a chat is
simply *"answer with JSON matching this schema"* — which is what the prompt already says. Fences and surrounding
prose are tolerated: the extractor recovers JSON from code fences, trailing commas and cut-off responses before
giving up.

A `StoryAnalysis` answer, abbreviated to one character, one location and one chapter (the real thing carries as
many as the story needs):

```json
{
  "title": "The Lamp at Vell",
  "summary": "Ines repairs lighthouses nobody visits, and one of them has started turning itself.",
  "genre": "drama",
  "subgenre": "urban",
  "tone": "moody, tense",
  "themes": ["identity", "courage"],
  "setting": "A cold coastline of failing lighthouses",
  "period": "contemporary",
  "pacing": "measured build to a tense ending",
  "visualMotifs": ["light and shadow"],
  "protagonistKey": "ines",
  "characters": [
    {
      "key": "ines",
      "name": "Ines",
      "aliases": ["the engineer"],
      "role": "protagonist",
      "bible": {
        "genderPresentation": "female",
        "ageRange": "late thirties",
        "height": "average height",
        "build": "wiry",
        "faceShape": "oval",
        "skinTone": "light olive",
        "eyes": "dark brown narrow eyes",
        "eyebrows": "straight, defined",
        "nose": "straight",
        "mouth": "thin lips",
        "hair": "black shoulder-length messy hair",
        "facialHair": "",
        "distinctiveFeatures": ["burn scar across the right palm"],
        "wardrobe": "navy work overalls, sleeves rolled",
        "accessories": [],
        "weapons": [],
        "props": [],
        "personality": "reserved, determined",
        "visualMannerisms": "keeps hands in pockets",
        "defaultExpression": "calm",
        "immutableTraits": ["black hair", "dark brown eyes"],
        "outfitVariants": [],
        "summary": "Ines, a lighthouse engineer."
      }
    }
  ],
  "relationships": [],
  "locations": [
    {
      "key": "vell",
      "name": "Vell Light",
      "description": {
        "kind": "lighthouse",
        "architecture": "squat stone tower on a shale headland",
        "layout": "spiral stair to a single lamp room",
        "palette": "muted blues and greys",
        "lighting": "soft overcast daylight",
        "atmosphere": "quiet",
        "keyFeatures": ["salt-pitted railing", "brass lamp housing"],
        "immutableTraits": ["shale headland"],
        "summary": "The lighthouse at Vell, kept by one man and visited by nobody."
      }
    }
  ],
  "props": [],
  "chapters": [
    {
      "order": 1,
      "title": "The Lamp Turns",
      "summary": "Ines stays awake to see whether the lamp really turns by itself.",
      "beats": ["Ines arrives at Vell", "The keeper explains", "At three the lamp turns"]
    }
  ]
}
```

Every other operation works the same way with its own schema: `ChapterPlan`, `ScenePages`, `PanelPromptDraft`,
`NarrationDraft`, `StoryRewrite`, `ImageDescription`. You never have to write one from memory — the prompt you
copied contains it.

## Artwork

`POST /api/panels/:id/artwork/upload` (multipart `file`), or **Upload artwork** in the panel editor's Versions
tab. It fills the same slot generation would, appears in the ordinary version history, and can be superseded or
reverted like any generated version. See
[AI pipeline → Bring your own artwork](AI_PIPELINE.md#bring-your-own-artwork).

## Limits

- **Text only.** An image cannot be pasted back as text; upload it to the panel instead.
- **One operation at a time.** Each job carries one prompt and takes one answer. A chapter planned scene by scene
  parks once per scene, so a long chapter is a sequence of pastes rather than a single one.
- **The prompt is what it is.** Editing the prompt before pasting it into a chat is fine, but the answer is still
  validated against the schema the job expects.
