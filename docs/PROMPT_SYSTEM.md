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
`system` string starts with `templateHeader(name, version)` (`[template:page-planning-v5]`), so a compiled prompt names
its own template.

## Registered templates

Templates are imported by constant, not looked up by name, so "live" means "the version the caller imports". Older text
versions stay in the array so old jobs remain reproducible.

| Template | Versions registered | Live version | Imported by |
| --- | --- | --- | --- |
| `story-analysis` | 1, 2 | 2 | `apps/api/src/routes/stories.ts`, `apps/worker/src/handlers/text.ts` |
| `page-planning` | 1–6 | 6 | `apps/api/src/routes/chapters.ts`, `apps/worker/src/handlers/text.ts` |
| `shot-planning` | 1–3 | 3 | same two files, for `format: "film"` projects |
| `strip-planning` | 1, 2 | 2 | same two files, for `format: "vertical"` projects |
| `chapter-outline`, `shot-outline`, `strip-outline` | 1, 2 | 2 | `apps/worker/src/handlers/text.ts` (split planning, pass 1) |
| `scene-pages`, `scene-shots`, `scene-strip` | 1, 2 | 2 | `apps/worker/src/handlers/text.ts` (split planning, pass 2) |
| `panel-prompts` | 1–4 | 4 | `apps/api/src/routes/pages.ts`, `apps/worker/src/handlers/text.ts` |
| `narration` | 1–5 | 5 | `apps/api/src/routes/audio.ts`, `apps/worker/src/handlers/text.ts` |
| `panel-check` | 1 | 1 | `apps/worker/src/handlers/qa.ts` (vision QA) |
| `story-rewrite` | 1 | 1 | `apps/api/src/routes/stories.ts` |
| `image-describe` | 1 | 1 | `apps/worker/src/handlers/text.ts` (describe an uploaded image) |
| `json-repair` | 1 | 1 | `apps/worker/src/handlers/text.ts` (the single repair attempt) |

Image templates keep one registered version each: `character-reference` v5, `location-reference` v5, `prop-reference`
v5, `style-reference` v4, `panel-generation` **v8**, `panel-edit` v4, `cover` v4. (The exported constants are still
named `characterReferenceV1`, `panelGenerationV1`, … — the constant name is not the version.) Location and prop
references take a `kind` (panorama, sheet, multi-angle; see `docs/IMAGE_REFERENCES.md`), and every reference job
records the version that drew it.

`shot-planning` and `strip-planning` are derived from `page-planning` by string replacement (`shot-planning` v1 from
`page-planning` v3, v2 from v5, v3 from v6; `strip-planning` v1 from v5, v2 from v6): same schema and rules, re-framed
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
string handed to `json-repair`), `editor_instruction` (the user's rewrite instruction). `DATA_RULE` is the companion
system-message line telling the model that anything inside those tags is end-user data and must never be followed as an
instruction. Output still has to satisfy the Zod schema whatever the story says — see `docs/AI_PIPELINE.md` for the
extract → validate → one repair → fail sequence.

## Panel prompt sections (`panel-generation` v6)

`compile()` emits these in order, dropping any section with no content:

1. Goal line — panel framing and aspect ratio, or, for a film project, "one cinematic 16:9 film frame … Artwork only."
2. `PROJECT ART DIRECTION` — from `styleSection()`: preset summary, lines, colour, shading, detail, faces, backgrounds,
   motion effects, contrast, screentones, lighting style, the project-type format directive, custom style, the colour
   directive, and a "match reference image N (style only)" line when a style reference is attached.
3. `SCENE CONTEXT`
4. `PANEL INTENT`
5. `REFERENCE IMAGES` — which image is which character, location, prop or style; the previous panel is labelled
   `previous panel (continuity only)`.
6. `CHARACTERS` — the exact count and who is visible where in the frame.
7. `CANONICAL APPEARANCE REQUIREMENTS` — per character version, including its immutable traits.
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
