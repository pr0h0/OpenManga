import { z } from "zod";
import { StyleDefinition } from "./editor.ts";
import { CharacterBible, LocationDescription } from "./story.ts";

const optStr = z.string().trim().optional().default("");
const strList = z.array(z.string().trim()).optional().default([]);

/**
 * What a reference image can be asked about. Each aspect owns one prompt fragment and one field of the result,
 * and the ones that map onto an existing entity produce exactly that entity's shape — so "use this as the
 * project style" or "make a character from this" hands the object to the endpoint that already accepts it,
 * with no translation in between.
 */
export const IMAGE_ASPECTS = [
  {
    key: "style",
    label: "Art style",
    hint: "Line, colour, shading and rendering — what makes it look like this",
    /** Applies to: POST /projects/:id/style */
    applies: "style",
  },
  {
    key: "character",
    label: "Character",
    hint: "The main figure's appearance, as a character bible",
    applies: "character",
  },
  {
    key: "outfit",
    label: "Outfit",
    hint: "Clothing, layers, fabrics and accessories in their own right",
    applies: null,
  },
  {
    key: "location",
    label: "Location",
    hint: "The setting, architecture and layout behind the subject",
    applies: "location",
  },
  {
    key: "lighting",
    label: "Lighting & palette",
    hint: "Key light, shadow behaviour and the colours that carry the image",
    applies: null,
  },
  {
    key: "composition",
    label: "Composition",
    hint: "Shot type, camera angle, framing and where the eye goes",
    applies: null,
  },
  {
    key: "mood",
    label: "Mood & tone",
    hint: "The feeling the image carries, and what creates it",
    applies: null,
  },
  {
    key: "props",
    label: "Props & objects",
    hint: "Notable objects, weapons and set dressing",
    applies: null,
  },
  {
    key: "era",
    label: "Era & culture",
    hint: "Period, cultural setting and the visual cues that place it",
    applies: null,
  },
  {
    key: "technique",
    label: "Medium & technique",
    hint: "Ink, watercolour, 3D, cel shading, screen tones, grain",
    applies: null,
  },
] as const;

export type ImageAspectKey = (typeof IMAGE_ASPECTS)[number]["key"];
export const ImageAspect = z.enum(IMAGE_ASPECTS.map((a) => a.key) as [ImageAspectKey, ...ImageAspectKey[]]);

/** Free-standing aspects that have no entity to become; prose the user copies or pastes into a prompt. */
const Prose = z.object({ summary: optStr, details: strList });
export type Prose = z.infer<typeof Prose>;

/**
 * Every field optional: the model is asked only for the aspects that were ticked, and a partial answer must
 * still parse rather than failing the whole run.
 */
export const ImageDescription = z.object({
  /** One or two sentences describing the image as a whole, always returned. */
  overview: optStr,
  style: StyleDefinition.partial().optional(),
  character: CharacterBible.partial().optional(),
  outfit: Prose.optional(),
  location: LocationDescription.partial().optional(),
  lighting: Prose.optional(),
  composition: Prose.optional(),
  mood: Prose.optional(),
  props: Prose.optional(),
  era: Prose.optional(),
  technique: Prose.optional(),
  /** Answer to the caller's own instruction, when one was given. */
  custom: optStr,
  /** What the model could not tell from the image — better than a confident guess. */
  uncertain: strList,
});
export type ImageDescription = z.infer<typeof ImageDescription>;
