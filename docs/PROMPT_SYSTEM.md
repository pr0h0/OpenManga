# Prompt system

All prompts live in `packages/prompts`. No prompt strings elsewhere — `packages/services/src/planner.ts` compiles them,
the API and worker only pass structured data in.

Two kinds, defined in two files:

| Kind | File | Shape |
| --- | --- | --- |
| Text | `packages/prompts/src/templates.ts` | `{ name, version, kind: "text", description, system, build(input): ChatMessage[] }` |
| Image | `packages/prompts/src/image-templates.ts` | `{ name, version, kind: "image", description, body, compile(input): string }` |

`defineTextTemplate()` and the shared helpers (`templateHeader`, `schemaInstructions`, `untrusted`, `DATA_RULE`) are in
`packages/prompts/src/text-templates.ts`. `packages/prompts/src/index.ts` exposes `allTemplateRecords()`, which flattens
both arrays into `{ name, version, kind, description, body, sha256 }` — the single list the database sync reads. Every
`system` string starts with `templateHeader(name, version)` (`[template:page-planning-v7]`), so a compiled prompt names
its own template.

## Registered templates

Templates are imported by constant, not looked up by name, so "live" means "the version the caller imports". Older text
versions stay in the array so old jobs remain reproducible.

| Template | Versions registered | Live version | Imported by |
| --- | --- | --- | --- |
| `story-analysis` | 1, 2, 3 | 3 | `apps/api/src/routes/stories.ts`, `apps/worker/src/handlers/text.ts` |
| `page-planning` | 1–7 | 7 | `apps/api/src/routes/chapters.ts`, `apps/worker/src/handlers/text.ts` (the single call a batched plan makes) |
| `shot-planning` | 1–4 | 4 | same two files, for `format: "film"` projects |
| `strip-planning` | 1–3 | 3 | same two files, for `format: "vertical"` projects |
| `chapter-outline`, `shot-outline`, `strip-outline` | 1–3 | 3 | `apps/worker/src/handlers/text.ts` (split planning, pass 1) |
| `scene-pages`, `scene-shots`, `scene-strip` | 1–3 | 3 | `apps/worker/src/handlers/text.ts` (split planning, pass 2) |
| `panel-prompts` | 1–5 | 5 | `apps/api/src/routes/pages.ts`, `apps/worker/src/handlers/text.ts` |
| `narration` | 1–6 | 6 | `apps/api/src/routes/audio.ts`, `apps/worker/src/handlers/text.ts` |
| `panel-check` | 2 | 2 | `apps/api/src/routes/pages.ts`, `apps/worker/src/handlers/qa.ts` (vision QA; v2 also asks for face boxes) |
| `story-rewrite` | 1 | 1 | `apps/api/src/routes/stories.ts`, `apps/worker/src/handlers/text.ts` |
| `narration-lint`, `narration-fix` | 1 | 1 | `apps/api/src/routes/narration-qa.ts`, `apps/worker/src/handlers/narration-qa.ts` (narration QA: semantic findings, and rewrites of only the flagged lines) |
| `youtube-package` | 1, 2 | 2 | `apps/api/src/routes/generations.ts`, `apps/worker/src/handlers/text.ts` (video publishing text: titles, description, tags, pinned comment, thumbnail headlines; v2 adds the channel's `<channel_rules>`: title rules, description template, tags) |
| `image-describe` | 1, 2 | 2 | `apps/api/src/routes/vision.ts`, `apps/worker/src/handlers/text.ts` (describe an uploaded image) |
| `expert-chat` | 1, 2 | 2 | `apps/api/src/lib/experts.ts` (expert chat replies) |
| `expert-concept`, `expert-premise`, `expert-outline`, `expert-youtube` | 1 | 1 | `apps/api/src/routes/experts.ts`, `apps/worker/src/handlers/expert-extract.ts` (expert output actions, defined in `packages/prompts/src/expert-actions.ts`) |
| `bible-extract` | 1 | 1 | `apps/api/src/routes/bible.ts`, `apps/worker/src/handlers/text.ts` (proposes story bible facts and character states, schema `BibleExtraction`) |
| `continuity-check` | 1 | 1 | `apps/api/src/routes/continuity.ts`, `apps/worker/src/handlers/continuity.ts` (contradictions in one chapter and a verdict per fixed rule, schema `ContinuityReport`) |
| `json-repair` | 1 | 1 | `apps/worker/src/handlers/text.ts` (the single repair attempt) |

Image templates keep one registered version each: `character-reference` v5, `location-reference` v5, `prop-reference`
v5, `style-reference` v5, `panel-generation` **v12**, `panel-edit` v4, `cover` v4, `thumbnail` v1 (16:9 video
thumbnail art, no text, one side kept clear for the headline). (The exported constants are still
named `characterReferenceV1`, `panelGenerationV1`, … — the constant name is not the version.) Location and prop
references take a `kind` (panorama, sheet, multi-angle; see `docs/IMAGE_REFERENCES.md`), and every reference job
records the version that drew it.

`shot-planning` and `strip-planning` are derived from `page-planning` by string replacement (`shot-planning` v1 from
`page-planning` v3, v2 from v5, v3 from v6, v4 from v7; `strip-planning` v1 from v5, v2 from v6, v3 from v7): same schema and rules, re-framed
as a film director's shot list (one shot per page, no dialogue or negative space) or a vertical strip (one full-width
panel per page, with height and seams). The outline and page passes of split planning are derived from each of those
in turn, so a change to `page-planning` reaches all nine.

What the 0.7 versions added (`page-planning` v6 and everything derived from it, `panel-prompts` v4, `narration` v5)
is only how to use data those steps now receive; nothing else in them changed:

- **Planning**: name one of a character's outfits (listed in project data) to switch into it from that panel on,
  with `outfitScope: "panel"` for a one-panel change; act the cast from its personality, mannerisms and
  relationships; treat `earlierRevealedFacts` as already known.
- **Panel prompts**: each panel names its characters, location, props and spoken lines; write every character's
  action and expression by name, in that location.
- **Narration**: use the chapter's cast for names and pronouns, do not re-introduce what the previous chapter
  established, and carry each panel's dialogue and emotion into its line.

The story bible versions (`page-planning` v7 and everything derived from it, `panel-prompts` v5, `narration` v6,
`panel-generation` v12) add only the rule for the bible data they now receive (`project_data.bible`,
`context.bible`, or the `STORY CANON` section):

- **Planning and narration**: `fixedRules` are hard rules that no scene, panel, line or caption may break; `facts`
  are canon not to contradict; `characterStates` say how each character stands, with changes part-way through the
  chapter marked "from scene N"; no one may know, have or use something before the bible gives it to them.
- **Panel prompts**: never break a rule or contradict a fact, and show each character's states where visible.
- **Panel images**: a `STORY CANON (must hold)` section after the appearance requirements lists the visual facts
  and the injuries, looks and carried items in force for who and what is in the panel.

What goes in is chosen by `bibleInEffect` (`packages/domain/src/bible.ts`): facts whose chapter range covers the
chapter and whose subject the step is about (named, or mentioned in its text) or is the whole story, fixed rules
first, at most 40 facts and 40 states (12 each for an image); the states in force there for the characters
present. An empty bible adds nothing, so a project without one compiles the same data as before.

## Versioning and the database

`bootstrapReferenceData()` (`packages/services/src/bootstrap.ts`) runs on boot — from the `migrate` container's
`apps/api/src/cli/bootstrap.ts`, the seeder, and the integration harness — and upserts `prompt_templates` (keyed by
name) plus `prompt_versions` (keyed by `template_id + version`, storing `body` and its SHA-256).

**Changing a template's text requires bumping its version.** If the body of an already-stored version changes, the
bootstrap logs `prompt template body changed without a version bump` and overwrites the stored body, so the warning is
the only trace — old generations then no longer reproduce.

Every job records `template_name`, `template_version`, the final `compiled_prompt`, provider, model, parameters and its
`generation_inputs` rows, so a generation can be reconstructed from the database alone.

## Untrusted story content

Instructions live only in system messages. Story text and structured project data are wrapped by `untrusted(tag,
content)`, which replaces any `<tag>` / `</tag>` occurrence inside the content with the lookalike characters `‹` `›`
before wrapping, so content cannot forge a closing delimiter:

```ts
export function untrusted(tag: string, content: string) {
  const safe = content.replace(new RegExp(`</?\\s*${tag}\\s*>`, "gi"), (m) => m.replace(/</g, "‹").replace(/>/g, "›"));
  return `<${tag}>\n${safe}\n</${tag}>`;
}
```

Tags in use: `story_content` (story and chapter text), `project_data` (structured state — panels, bibles, plans, the raw
string handed to `json-repair`), `editor_instruction` (the user's rewrite instruction), `scene_outline` (the outline
a split plan's page pass works from), and `caller_request` / `caller_note` (the custom question and note sent with an
image to describe). `DATA_RULE` is the companion
system-message line telling the model that anything inside those tags is end-user data and must never be followed as an
instruction. Output still has to satisfy the Zod schema whatever the story says — see `docs/AI_PIPELINE.md` for the
extract → validate → one repair → fail sequence.

## Panel prompt sections (`panel-generation` v12)

`compile()` emits these in order, dropping any section with no content:

1. Goal line — panel framing and aspect ratio, or, for a film project, "one cinematic 16:9 film frame … Artwork only."
   With a photoreal style it asks for a "photorealistic live-action film still" (or a photorealistic live-action film
   frame) instead of an illustrated panel.
   With a layout guide, `POSE / LAYOUT` follows at once (new in v10): strict says to copy each figure's pose,
   placement and the framing from the sketch and that it wins where the written composition or beat disagrees on
   those (identity and look still from the references); loose only says to start from it. A guide's typed pose
   (`guide.pose`, written by hand or by *Describe pose*) adds a `Pose, in words:` line there (v11), so it ranks with the
   sketch rather than with the composition below.
2. `PROJECT ART DIRECTION` — from `styleSection()`: preset summary, lines, colour, shading, detail, faces, backgrounds,
   motion effects, contrast, screentones, lighting style, an `Avoid:` line from the style's exclusions, the
   project-type format directive (a live-action cinematography line instead when the style is `photoreal`), custom
   style, the colour directive (black-and-white photography for a photoreal style in a project that is not full
   colour), and a "match reference image N (style only)" line when a style reference is attached.
3. `SCENE CONTEXT` — scene title, summary, time and weather.
4. `PANEL INTENT`
5. `REFERENCE IMAGES` — which image is which character (and outfit), location and prop, with how to read a location
   sheet or panorama and a multi-angle prop; the panel's layout guide, if any, for composition, framing and poses only
   (loosely or strictly, never its drawing style or text; new in v9); the previous panel is for continuity of setting
   and lighting only.
6. `CHARACTERS` — the exact count and who is visible where in the frame.
7. `CANONICAL APPEARANCE REQUIREMENTS` — per character version, including its immutable traits. Then
   `STORY CANON (must hold)` (v12) when the story bible has visible entries in effect for who and what is in the
   panel.
8. `WARDROBE`, then `ACTION`, `EXPRESSION`, `CAMERA`, `COMPOSITION`.
9. `LOCATION`, `PROPS`, `LIGHTING`, `CONTINUITY`.
10. `DIALOGUE NEGATIVE SPACE` — "leave visual space for dialogue but do not draw dialogue or speech bubbles"; skipped
    when the caller sets `reserveTextSpace: false` or the project is film.
11. `STRICT EXCLUSIONS` — no text, captions, bubbles, lettering, watermark or logo; do not change identity, hair, eye
    colour or outfit; no extra people; no panel borders or drawn margins.

`styleSection()` resolves the colour-mode conflict rather than emitting both sides of it — see the colour-mode note in
`docs/AI_PIPELINE.md`.

Descriptive sections prefer the text draft written by the `page_prompts` job (`panels.prompt_draft`) and fall back to
the structured `PanelSpec`, so a panel can always be generated without a text call first.

## Regeneration and user overrides

`POST /api/panels/:id/generate` takes an `operation` (`apps/api/src/routes/pages.ts`). `same_prompt` (the default)
recompiles from current state. `change_expression`, `change_pose`, `change_camera`, `change_background`,
`change_outfit`, `remove_object`, `add_object` and `reframe` take the compiled prompt and append

```
REVISION REQUEST (<operation with spaces>):
<instruction>
Keep everything else consistent with the requirements above.
```

as a per-run override (nothing is saved on the panel). `edited_prompt` uses the caller's text verbatim and stores it as
`panels.prompt_override`. Whenever a run carries an override the job is labelled `template_name =
panel-generation-user-edited`, with `template_version` still the live `panel-generation` version
(`packages/services/src/planner.ts`) — a marker on the
job, not a registered template.

## Hashes

`prompt_hash` (compiled prompt), `references_hash` (roles plus asset and variant ids) and `options_hash`
(provider/model/parameters) are stored per job for debugging and for grouping experiments. Matching hashes never cause
output to be reused automatically — every run produces a new asset.
