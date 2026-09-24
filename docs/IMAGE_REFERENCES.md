# Image references

Identity in this system comes from approved canonical reference images. Every image request therefore attaches
references — and because token-billed providers charge for input pixels, what it attaches is a small cached derivative,
never the canonical file.

## Two forms of every reference

| | Canonical reference | Prompt-reference derivative |
| --- | --- | --- |
| Where | `assets` row (`*_reference`, `panel_art`, …) | `asset_variants` row (`variant = prompt_ref`) |
| Resolution | full provider output or the original upload | fits inside `REFERENCE_MAX_WIDTH × REFERENCE_MAX_HEIGHT` (192×288), aspect preserved, never upscaled |
| Role | source of truth, UI preview, export | request optimization only |
| Lifetime | kept | disposable: deleted after 30 days unused, recreated on demand |

The box is per provider: providers that bill input tokens get the small box, providers that bill a flat price per
image (Meta Muse) get `FLAT_RATE_REFERENCE_MAX_WIDTH × FLAT_RATE_REFERENCE_MAX_HEIGHT` (768×1152), because detail
costs nothing there (`referenceParams()` in `packages/services/src/assets.ts`). A project can override the box in
Settings → reference derivative size (`settings.referenceMaxWidth/Height`).

Derivatives are produced with Sharp and are byte-for-byte reproducible, so the cache key is the full recipe
(`referenceCacheKey`, `packages/image-utils/src/index.ts`):

```ts
sha256(`${canonicalSha256}:${maxWidth}x${maxHeight}:${fit}:${up}:${format}:${enc}`)
// defaults: sha256("<sha>:192x288:inside:noup:webp:q85")
```

`up` is `noup` unless `REFERENCE_ALLOW_UPSCALE`, `enc` is `q<REFERENCE_QUALITY>` (or `lossless` for PNG). Because the
key starts from the canonical asset's SHA-256, the same image never yields two derivatives and a changed image never
reuses an old one. They are created when a reference is **approved**, again whenever a job is planned, and by the
`asset-processing` queue on demand.

## Generation flow

```
character bible (text model) → image model → FULL RESOLUTION CANONICAL REFERENCE
    → UI preview / storage / export
    → Sharp → ~192×288 PROMPT DERIVATIVE → later image requests
```

References are never *generated* at 192×288 — the canonical file is whatever the provider returned and is never
modified.

### Outfit references are drawn from the approved design

An outfit reference re-dresses the character rather than inventing them again, so generating one requires an
**approved** (or locked) main reference on that version and attaches it as image 1; the prompt
(`character-reference` v4, `fromBaseline`) tells the model to reproduce that figure exactly and change only the
clothing. Without a baseline every outfit drifted into a different face and build, which is the thing references
exist to prevent. The per-outfit generate buttons in the Outfits editor are disabled until that main reference is
approved, and mark the outfits that already have one.

### Which outfit a panel draws

Outfits are switched on panels, the way a costume change happens in the story. In the panel editor, pick an outfit
for a character and choose **From this panel on** (it holds until the next change, across pages and chapters) or
**Only this panel**. The character page lists every change in reading order. For each character on a panel,
`resolveOutfits` (`packages/services/src/outfits.ts`) takes, strongest first:

1. an outfit set on this panel (only this panel, then from this panel on);
2. an outfit that the panel's own outfit text names (text containing the outfit's name, e.g. "rain coat, hood up"
   names "Rain Coat");
3. the last "from this panel on" change before it in reading order (chapter, page, panel);
4. the character's default outfit, when the panel's outfit text is empty.

A chapter plan switches outfits the same way the editor does. The planner sees each character's outfit names, and
when a panel's outfit text names one other than what the character is wearing at that point, applying the plan
records a "from this panel on" change there. Re-planning the chapter replaces those changes with the new plan's.

The outfit it resolves to gives the WARDROBE line its name and description, with the panel's outfit text as a detail
(unless that text names a different outfit), and sends its approved reference. Text that names no outfit and no
resolved outfit keeps the old behaviour: the text itself is the wardrobe.

### Location and prop reference kinds

Each is one image, in the kind picked on the location or prop page:

| Subject | Kind | What it draws |
| --- | --- | --- |
| Location | `location` (wide view) | One eye-level establishing shot of the space. The default. |
| Location | `location_panorama` | One continuous sweep across the whole space, as if the camera turned in place, so every wall and area appears once. |
| Location | `location_sheet` | One image split 2x2, each panel facing a different side of the space. |
| Prop | `prop` (single view) | One three-quarter view. The default, and the right one for an object only ever seen from one side. |
| Prop | `prop_multi_angle` | Front, side, back and top views of the object in a row. |

Panels send the primary (starred) approved reference, whatever its kind. When it is a panorama, a sheet or a
multi-angle turnaround, the panel prompt (`panel-generation` v8) says so: use it for where things are and what they
look like, and draw only the one view the panel needs, never the sheet's split layout or the panorama's curvature.

### Which version a panel draws from

A panel pins its own `characterVersionIds` and takes identity from `approvedReference(...)`, which accepts only
`approved` or `locked` references — **a draft's references are never used for identity**. New panels pin the
character's *current* version, so:

- a new version does **not** become current on creation (`makeCurrent` applies only to a character that has none
  yet, i.e. its first version);
- a draft cannot be made current at all — it would leave new panels generating with no reference;
- **approving** (or locking) a version is what promotes it to current.

## What is attached to a panel request

`GenerationPlanner.previewPanel/enqueuePanel` (`packages/services/src/planner.ts`) fills at most
`MAX_REFERENCES = 8` slots, in this order:

1. Approved canonical character references for the characters **present in the panel** — primary first, then by kind
   preference `portrait → full_body → multi_angle → uploaded → outfit → expression_sheet`.
2. The approved outfit reference of the outfit the character wears on that panel (see below), immediately after
   that character's identity reference (the prompt then says to copy the clothing only, not the face).
3. The approved location reference for the panel's location version.
4. Approved prop references for the panel's props.
5. The approved project style reference.
6. **Last**, the previous panel in the same scene, labelled `previous panel (continuity only)`.

Draft references are never used for identity. A character with no approved reference falls back to their canonical
text description, so a panel is always generatable.

The job records every input in `generation_inputs`: role, canonical asset id, variant id, the width and height
actually sent, the canonical dimensions, the max box, fit, format and byte size. The Prompt Inspector reads those rows
to show "sent as small derivative W×H" against "full resolution".

## Masked edits

`FULL RESOLUTION CURRENT PANEL (image 1) + FULL RESOLUTION MASK + SMALL AUXILIARY DERIVATIVES`.

The browser paints the mask at the artwork's natural size. `toEditMask()` (`packages/image-utils`) resizes it to
exactly the target dimensions and converts it to the OpenAI convention — fully transparent where editing is allowed,
opaque elsewhere — treating any pixel with alpha > 16 and `r+g+b > 96` as painted. The edit produces a new asset whose
`parent_asset_id` is the asset that was edited; nothing is overwritten.

Providers without a mask parameter (Gemini, Meta) are handled in `packages/ai-image` by sending the full-resolution
target and then the mask as an additional instructed image; see `docs/AI_PIPELINE.md`.

## Experiments

Change the box globally (`REFERENCE_MAX_*`) or per project. `GET /api/usage` returns `referenceExperiments`: completed
`panel_generation` jobs grouped by the `maxWidth×maxHeight` recorded on their inputs, with the average image-input
tokens, average cost and average latency per group, next to regeneration and approval rates. Application code never
assumes a token cost for a size — it records the provider's reported usage and lets the dashboard compare.

## Tests

`packages/image-utils/src/image-utils.test.ts`: 1600×800 → 160×80 and 800×1600 → 40×80 for a 160×80 box, 100×50 stays
100×50 with upscaling off, valid WebP output, deterministic cache keys and byte-identical output, the canonical buffer
untouched, edit-mask transparency, and nearest-size selection from the output menu. The integration flow asserts that
panel requests carry derivatives within the configured cap while edit targets and masks go full resolution.
