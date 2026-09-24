import type {
  CharacterBible,
  LocationDescription,
  PanelCharacterSpec,
  PanelSpec,
  PropDescription,
  StyleDefinition,
} from "@openmanga/schemas";

export type ImageTemplate<I> = {
  name: string;
  version: number;
  kind: "image";
  description: string;
  /** Static skeleton stored for reproducibility (the compiled prompt is stored per job). */
  body: string;
  compile(input: I): string;
};

export type StyleContext = {
  presetName: string | null;
  definition: StyleDefinition | null;
  customDescription: string;
  colorDirective: string;
  projectType: string;
  hasStyleReference?: number;
};

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();
const line = (label: string, v: string | undefined | null) => (clean(v) ? `${label}: ${clean(v)}` : "");
const section = (title: string, lines: (string | false | null | undefined)[]) => {
  const body = lines.filter((l): l is string => typeof l === "string" && l.trim() !== "").join("\n");
  return body ? `${title}:\n${body}` : "";
};
const join = (sections: string[]) => sections.filter(Boolean).join("\n\n");

/** projectType is otherwise only a label; these give it visible effect on the art. */
const FORMAT_DIRECTIVES: Record<string, string> = {
  manga:
    "Format: Japanese manga page art — expressive ink linework, screentone-friendly values, right-to-left staging.",
  manhwa: "Format: Korean manhwa — polished digital rendering, soft gradients, cinematic staging.",
  webtoon:
    "Format: vertical-scroll webtoon — simple readable compositions that stay legible on a phone, generous negative space.",
  comic: "Format: western comic — bold inking, saturated flats, dynamic angles.",
  illustrated_story: "Format: storybook illustration — painterly, softer edges, calm staging.",
};

const projectTypeLabel: Record<string, string> = {
  manga: "manga",
  manhwa: "manhwa",
  webtoon: "webtoon",
  comic: "comic",
  illustrated_story: "storybook illustration",
};

/** Preset colour/screentone wording that contradicts a colour project ("Black and white with grey tones"). */
const MONOCHROME_WORDING =
  /black\s*(and|&)\s*white|monochrome|grey\s*tones|gray\s*tones|screentone|halftone|no colou?r/i;

export function styleSection(s: StyleContext) {
  const d = s.definition;
  // The project's colour mode wins: a preset's monochrome colour/screentone lines are dropped for a colour project
  // (and colour lines for a monochrome one) instead of sitting three lines apart and letting the model choose.
  const colorful = /full colou?r/i.test(s.colorDirective);
  const colorPolicy = d && (colorful && MONOCHROME_WORDING.test(d.colorPolicy) ? "" : d.colorPolicy);
  // Screentones are a monochrome technique whatever the preset calls them, so a colour project drops the line.
  const screenTones = d && (colorful ? "" : d.screenTones);
  return section("PROJECT ART DIRECTION", [
    s.presetName ? `Style preset: ${s.presetName}. ${clean(d?.summary)}` : clean(d?.summary),
    d && line("Lines", d.lineTreatment),
    d && line("Color", colorPolicy),
    d && line("Shading", d.shading),
    d && line("Detail", d.detailLevel),
    d && line("Faces", d.faceRendering),
    d && line("Backgrounds", d.backgroundRendering),
    d && line("Motion effects", d.motionEffects),
    d && line("Contrast", d.contrast),
    d && line("Screentones", screenTones),
    d && line("Lighting style", d.lighting),
    // What the style avoids. Written by every built-in preset and by the style analyst, and previously dropped on
    // the floor: the definition said "no photoreal rendering" and nothing in the prompt ever said so.
    d?.exclusions?.length ? `Avoid: ${d.exclusions.map(clean).filter(Boolean).join("; ")}.` : "",
    FORMAT_DIRECTIVES[s.projectType] ?? "",
    clean(s.customDescription) && `Project-specific style: ${clean(s.customDescription)}`,
    s.colorDirective,
    s.hasStyleReference
      ? `Match the rendering style of reference image ${s.hasStyleReference} (style only, not its content).`
      : "",
  ]);
}

export function characterAppearance(name: string, b: CharacterBible, immutable: string[]) {
  return [
    line("Presentation", [b.genderPresentation, b.ageRange].filter(Boolean).join(", ")),
    line("Height/build", [b.height, b.build].filter(Boolean).join(", ")),
    line("Face", [b.faceShape, b.skinTone && `${b.skinTone} skin`].filter(Boolean).join(", ")),
    line("Eyes", [b.eyes, b.eyebrows && `brows: ${b.eyebrows}`].filter(Boolean).join("; ")),
    line("Nose/mouth", [b.nose, b.mouth].filter(Boolean).join("; ")),
    line("Hair", b.hair),
    line("Facial hair", b.facialHair),
    b.distinctiveFeatures.length ? line("Distinctive", b.distinctiveFeatures.join("; ")) : "",
    immutable.length ? `Never change for ${name}: ${immutable.join("; ")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

const STRICT_BASE = [
  "No text.",
  "No caption.",
  "No speech bubbles or dialogue.",
  "No lettering or sound-effect text.",
  "No watermark.",
  "No logo.",
  // Seen in production: phone screens and signs rendered as garbled writing.
  "Screens, signs, papers and packaging show no readable writing (blank, blurred or turned away).",
];
/** Seen in production: generated panels with drawn white bands and frame lines that show up in videos and pages. */
const FULL_BLEED =
  "Full-bleed artwork edge to edge: no white margins, bands, borders, frames, panel lines or letterboxing.";
const FINISH =
  "Finished, clean rendering: correct anatomy and hands, consistent perspective and scale, no duplicated or merged limbs.";

// ---------------------------------------------------------------- references

export type CharacterReferenceInput = {
  style: StyleContext;
  name: string;
  role: string;
  bible: CharacterBible;
  immutableTraits: string[];
  outfit?: { name: string; description: string } | null;
  kind: "portrait" | "full_body" | "multi_angle" | "expression_sheet" | "outfit";
  /** The approved identity reference is attached as image 1: this one only re-dresses that same figure. */
  fromBaseline?: boolean;
  extraInstruction?: string;
};

const refKindText: Record<CharacterReferenceInput["kind"], string> = {
  portrait:
    "a head-and-shoulders character portrait, front-facing three-quarter view, neutral expression, focused on face, hairstyle, eyes and facial features",
  full_body:
    "a full-body character reference, standing neutral pose, entire figure visible head to shoes, showing height, proportions, clothing and equipment",
  multi_angle:
    "a character turnaround sheet of the same person: front view, three-quarter view, profile view and back view, evenly spaced in a row, identical outfit and proportions",
  expression_sheet:
    "an expression sheet of the same person's head: neutral, happy, angry, sad, surprised, determined and fearful, arranged in a clean grid with identical hairstyle and features",
  outfit: "a full-body outfit reference of the character wearing the specified outfit, neutral pose",
};

export const characterReferenceV1: ImageTemplate<CharacterReferenceInput> = {
  name: "character-reference",
  version: 5,
  kind: "image",
  description: "Full-resolution canonical character reference.",
  body: "ROLE / GOAL, PROJECT ART DIRECTION, CHARACTER, CANONICAL APPEARANCE REQUIREMENTS, WARDROBE, PRESENTATION, STRICT EXCLUSIONS",
  compile(i) {
    const b = i.bible;
    return join([
      `Create ${refKindText[i.kind]} for a ${projectTypeLabel[i.style.projectType] ?? "comic"} production. This is the canonical design reference that all future panels must match.`,
      styleSection(i.style),
      section("CHARACTER", [
        `${i.name} (${i.role}).`,
        clean(b.summary),
        line("Personality shown through posture", b.visualMannerisms),
        line("Default expression", b.defaultExpression),
      ]),
      section("CANONICAL APPEARANCE REQUIREMENTS", [characterAppearance(i.name, b, i.immutableTraits)]),
      section("WARDROBE", [
        i.outfit ? `${i.outfit.name}: ${clean(i.outfit.description)}` : clean(b.wardrobe),
        b.accessories.length ? line("Accessories", b.accessories.join(", ")) : "",
        b.weapons.length ? line("Weapons", b.weapons.join(", ")) : "",
        b.props.length ? line("Carried props", b.props.join(", ")) : "",
      ]),
      section("PRESENTATION", [
        i.fromBaseline
          ? "Reference image 1 is this character's approved design. Reproduce that same person exactly — face, hair, build, skin and every immutable trait — and change only the clothing described under WARDROBE. Same framing and neutral presentation as the reference."
          : "",
        "Plain light neutral background filling the whole canvas.",
        "Even, soft studio lighting so colors, hair and facial features read clearly; no dramatic shadows across the face.",
        "Single character only, entirely inside the frame (no cropped head, hands or feet for full-body views).",
        "Match every appearance requirement literally; this image defines the character for all future panels.",
        FINISH,
        clean(i.extraInstruction),
      ]),
      section("STRICT EXCLUSIONS", [
        ...STRICT_BASE,
        "No name labels, color swatches, arrows, callouts or design-sheet annotations.",
        "No other characters.",
        "No scenery clutter.",
      ]),
    ]);
  },
};

export type LocationReferenceInput = {
  style: StyleContext;
  name: string;
  description: LocationDescription;
  /** One image either way: a single establishing view, a panorama across the space, or a sheet of its sides. */
  kind?: "location" | "location_panorama" | "location_sheet";
  extraInstruction?: string;
};

const locationKind = {
  location: {
    what: "a wide establishing environment reference",
    presentation: [
      "Eye-level wide shot showing the overall layout with every key feature clearly visible and recognizable.",
      FULL_BLEED,
    ],
  },
  location_panorama: {
    what: "a panoramic environment reference",
    presentation: [
      "One continuous panoramic view sweeping across the whole space from one side to the other, as if the camera turned in place at eye level, so every area (entrances, windows, furniture, each wall) appears once in a single seamless image.",
      "Wide-angle with at most gentle curvature; one unbroken picture, never split into panels.",
      FULL_BLEED,
    ],
  },
  location_sheet: {
    what: "a location sheet",
    presentation: [
      "One image divided into four equal panels in a 2x2 grid with thin clean gutters. Each panel shows the same space at eye level from a different side (facing the entrance, facing the opposite wall, and each side wall), so every area and key feature appears in at least one panel.",
      "Identical architecture, furniture, palette and lighting in every panel. No captions, labels or numbers.",
    ],
  },
} as const;

export const locationReferenceV1: ImageTemplate<LocationReferenceInput> = {
  name: "location-reference",
  version: 5,
  kind: "image",
  description: "Full-resolution canonical location/environment reference.",
  body: "ROLE / GOAL, PROJECT ART DIRECTION, LOCATION, LIGHTING, STRICT EXCLUSIONS",
  compile(i) {
    const d = i.description;
    const k = locationKind[i.kind ?? "location"];
    return join([
      `Create ${k.what} of "${i.name}" for a ${projectTypeLabel[i.style.projectType] ?? "comic"} production. It is the canonical design reference for this recurring location.`,
      styleSection(i.style),
      section("LOCATION", [
        clean(d.summary),
        line("Type", d.kind),
        line("Architecture", d.architecture),
        line("Layout", d.layout),
        line("Palette", d.palette),
        line("Atmosphere", d.atmosphere),
        d.keyFeatures.length ? line("Key features that must be visible", d.keyFeatures.join("; ")) : "",
        d.immutableTraits.length ? line("Never change", d.immutableTraits.join("; ")) : "",
      ]),
      section("LIGHTING", [clean(d.lighting) || "Clear readable lighting."]),
      section("PRESENTATION", ["Empty of people.", ...k.presentation, FINISH, clean(i.extraInstruction)]),
      section("STRICT EXCLUSIONS", [...STRICT_BASE, "No people or characters."]),
    ]);
  },
};

export type PropReferenceInput = {
  style: StyleContext;
  name: string;
  description: PropDescription;
  /** A single three-quarter view, or one image showing the object from several angles. */
  kind?: "prop" | "prop_multi_angle";
  extraInstruction?: string;
};

export const propReferenceV1: ImageTemplate<PropReferenceInput> = {
  name: "prop-reference",
  version: 5,
  kind: "image",
  description: "Full-resolution canonical prop reference.",
  body: "ROLE / GOAL, PROJECT ART DIRECTION, PROP, STRICT EXCLUSIONS",
  compile(i) {
    const d = i.description;
    return join([
      `Create ${i.kind === "prop_multi_angle" ? "an object turnaround sheet" : "a clean object design reference"} of "${i.name}" for a ${projectTypeLabel[i.style.projectType] ?? "comic"} production.`,
      styleSection(i.style),
      section("PROP", [
        clean(d.summary),
        line("Type", d.kind),
        line("Material", d.material),
        line("Size", d.size),
        line("Colors", d.colors),
        d.keyFeatures.length ? line("Key features", d.keyFeatures.join("; ")) : "",
        d.immutableTraits.length ? line("Never change", d.immutableTraits.join("; ")) : "",
      ]),
      section("PRESENTATION", [
        i.kind === "prop_multi_angle"
          ? "The same object shown four times on a plain light background, evenly spaced in a row: front, side, back and top views, each entirely visible, with identical size, materials and colors in every view."
          : "Object centered on a plain light background, three-quarter view, entirely inside the frame, true to its stated size, materials and colors.",
        FINISH,
        clean(i.extraInstruction),
      ]),
      section("STRICT EXCLUSIONS", [...STRICT_BASE, "No labels, measurements or annotations.", "No hands or people."]),
    ]);
  },
};

export type StyleReferenceInput = { style: StyleContext; subject: string };

export const styleReferenceV1: ImageTemplate<StyleReferenceInput> = {
  name: "style-reference",
  version: 4,
  kind: "image",
  description: "Style exploration image demonstrating the project's art direction.",
  body: "ROLE / GOAL, PROJECT ART DIRECTION, SUBJECT, STRICT EXCLUSIONS",
  compile(i) {
    return join([
      `Create a style reference illustration that clearly demonstrates the art direction below for a ${projectTypeLabel[i.style.projectType] ?? "comic"} production.`,
      styleSection(i.style),
      section("SUBJECT", [
        clean(i.subject) ||
          "A single character standing in a simple environment, showing line work, color and shading choices.",
      ]),
      section("PRESENTATION", [FULL_BLEED, FINISH]),
      section("STRICT EXCLUSIONS", STRICT_BASE),
    ]);
  },
};

// ---------------------------------------------------------------- panels

export type PanelCharacterContext = {
  name: string;
  versionNumber: number;
  bible: CharacterBible;
  immutableTraits: string[];
  outfit?: string;
  referenceImageIndex?: number;
  /** Approved reference of the outfit this panel calls for, when one matches. */
  outfitReference?: { name: string; imageIndex: number };
  panel: PanelCharacterSpec | null;
};

export type PanelPromptInput = {
  style: StyleContext;
  scene: { title: string; summary: string; time: string; weather: string } | null;
  panel: {
    storyBeat: string;
    shotType: string;
    cameraAngle: string | null;
    aspectRatio: number;
    spec: PanelSpec | null;
  };
  characters: PanelCharacterContext[];
  /** `referenceKind` says how the reference presents the subject: a sheet or panorama is used, never copied. */
  location: {
    name: string;
    description: LocationDescription;
    referenceImageIndex?: number;
    referenceKind?: string;
  } | null;
  props: { name: string; description: PropDescription; referenceImageIndex?: number; referenceKind?: string }[];
  previousPanelImageIndex?: number;
  continuity: string[];
  /** Panel has app lettering (bubbles/captions); ask for calm space for it. Defaults to true. */
  reserveTextSpace?: boolean;
  /** Film project: a full-frame cinematic 16:9 shot for a narrated video, never a comic panel. */
  film?: boolean;
  draft?: {
    intent?: string;
    action?: string;
    expression?: string;
    composition?: string;
    lighting?: string;
    continuity?: string[];
  } | null;
};

const shotText: Record<string, string> = {
  "extreme-wide": "Extreme wide shot",
  wide: "Wide shot",
  full: "Full shot (whole figures visible)",
  medium: "Medium shot (waist up)",
  "medium-close": "Medium close-up (chest up)",
  close: "Close-up (face fills most of the frame)",
  "extreme-close": "Extreme close-up (detail of eyes/hands/object)",
  insert: "Insert shot of a detail",
};

const angleText: Record<string, string> = {
  "eye-level": "Eye-level camera",
  low: "Low angle looking up",
  high: "High angle looking down",
  "birds-eye": "Bird's-eye view from directly above",
  "worms-eye": "Worm's-eye view from the ground",
  "over-shoulder": "Over-the-shoulder framing",
  dutch: "Dutch tilt",
  pov: "First-person point of view",
};

function orientation(ar: number) {
  if (ar > 1.3) return "landscape";
  if (ar < 0.77) return "portrait";
  return "square";
}

export const panelGenerationV1: ImageTemplate<PanelPromptInput> = {
  name: "panel-generation",
  version: 8,
  kind: "image",
  description: "Single comic panel artwork compiled from structured panel state.",
  body: "ROLE / GOAL, PROJECT ART DIRECTION, SCENE CONTEXT, PANEL INTENT, CHARACTERS, CANONICAL APPEARANCE REQUIREMENTS, WARDROBE, ACTION, EXPRESSION, CAMERA, COMPOSITION, LOCATION, LIGHTING, CONTINUITY, DIALOGUE NEGATIVE SPACE, STRICT EXCLUSIONS",
  compile(i) {
    const s = i.panel.spec;
    const d = i.draft ?? {};
    const chars = i.characters;
    const refNotes: string[] = [];
    for (const c of chars) {
      if (c.referenceImageIndex)
        refNotes.push(
          `${c.name} is the person shown in reference image ${c.referenceImageIndex}. Preserve their face, hairstyle, eye shape, skin tone and proportions exactly.`,
        );
      if (c.outfitReference)
        refNotes.push(
          `${c.name} wears the "${clean(c.outfitReference.name)}" outfit shown in reference image ${c.outfitReference.imageIndex}. Copy the clothing only, not the face.`,
        );
    }
    const li = i.location?.referenceImageIndex;
    if (li)
      refNotes.push(
        i.location?.referenceKind === "location_sheet"
          ? `Reference image ${li} is a sheet showing several sides of the location: use it for where everything in the space is and what it looks like, and draw only the one view this panel's camera sees, as a single continuous picture, never the sheet's divided layout.`
          : i.location?.referenceKind === "location_panorama"
            ? `Reference image ${li} is a panorama across the whole location: use it for where everything in the space is, and frame only the part this panel's camera sees, without panoramic curvature.`
            : `The location matches reference image ${li}.`,
      );
    for (const p of i.props)
      if (p.referenceImageIndex)
        refNotes.push(
          p.referenceKind === "prop_multi_angle"
            ? `${p.name} is shown from several angles in reference image ${p.referenceImageIndex}: draw it once, from whatever angle this panel needs.`
            : `${p.name} matches reference image ${p.referenceImageIndex}.`,
        );
    if (i.previousPanelImageIndex)
      refNotes.push(
        `Reference image ${i.previousPanelImageIndex} is the previous panel, for continuity of setting and lighting ONLY. Do not copy character identity from it; the character references above are the source of truth.`,
      );

    const nobody = chars.length === 0;
    const continuity = [
      ...new Set(
        [...(i.continuity ?? []), ...(s?.continuityRequirements ?? []), ...(d.continuity ?? [])]
          .map(clean)
          .filter(Boolean),
      ),
    ];
    const negative = s?.negativeSpace;

    return join([
      i.film
        ? `Create one cinematic ${i.panel.aspectRatio > 1.7 && i.panel.aspectRatio < 1.85 ? "16:9" : `${i.panel.aspectRatio.toFixed(2)}:1`} film frame in ${projectTypeLabel[i.style.projectType] ?? "comic"} illustration style for a narrated video. Full-bleed composition that reads on a widescreen, with a clear focal subject and some headroom around it for a slow camera move. Artwork only.`
        : `Create one clean ${projectTypeLabel[i.style.projectType] ?? "comic"} panel, ${orientation(i.panel.aspectRatio)} framing (aspect ratio about ${i.panel.aspectRatio.toFixed(2)}:1). Artwork only.`,
      styleSection(i.style),
      i.scene
        ? section("SCENE CONTEXT", [
            clean(i.scene.title),
            clean(i.scene.summary),
            line("Time", i.scene.time),
            line("Weather", i.scene.weather),
          ])
        : "",
      section("PANEL INTENT", [
        clean(d.intent) || clean(s?.beat) || clean(i.panel.storyBeat),
        s?.emotion ? `Mood: ${clean(s.emotion)}` : "",
      ]),
      refNotes.length ? section("REFERENCE IMAGES", refNotes) : "",
      section(
        "CHARACTERS",
        nobody
          ? ["No characters appear in this panel."]
          : chars
              .map((c) => `${c.name}${c.panel?.position ? ` — ${clean(c.panel.position)}` : ""}`)
              .concat([
                `Exactly ${chars.length} character${chars.length > 1 ? "s" : ""} visible. Do not add other people.`,
              ]),
      ),
      nobody
        ? ""
        : section(
            "CANONICAL APPEARANCE REQUIREMENTS",
            chars.map(
              (c) =>
                `${c.name} (design v${c.versionNumber}):\n${characterAppearance(c.name, c.bible, c.immutableTraits)}`,
            ),
          ),
      nobody
        ? ""
        : section(
            "WARDROBE",
            chars.map(
              (c) =>
                `${c.name}: ${clean(c.panel?.outfit) || clean(c.outfit) || clean(c.bible.wardrobe) || "established outfit"}`,
            ),
          ),
      section("ACTION", [
        clean(d.action) || clean(s?.action),
        ...chars.map((c) =>
          c.panel?.action || c.panel?.pose
            ? `${c.name}: ${[c.panel.pose, c.panel.action].map(clean).filter(Boolean).join(", ")}`
            : "",
        ),
      ]),
      section("EXPRESSION", [
        clean(d.expression),
        ...chars.map((c) => (c.panel?.expression ? `${c.name}: ${clean(c.panel.expression)}` : "")),
      ]),
      section("CAMERA", [
        shotText[i.panel.shotType] ?? i.panel.shotType,
        i.panel.cameraAngle ? (angleText[i.panel.cameraAngle] ?? i.panel.cameraAngle) : "",
      ]),
      section("COMPOSITION", [
        clean(d.composition) || clean(s?.composition),
        line("Foreground", s?.foreground),
        line("Midground", s?.midground),
        line("Background", s?.background),
      ]),
      i.location
        ? section("LOCATION", [
            `${i.location.name}: ${clean(i.location.description.summary)}`,
            i.location.description.keyFeatures.length
              ? line("Recognizable features", i.location.description.keyFeatures.join("; "))
              : "",
          ])
        : "",
      i.props.length
        ? section(
            "PROPS",
            i.props.map(
              (p) =>
                `${p.name}: ${clean(p.description.summary)}${p.description.immutableTraits.length ? ` (${p.description.immutableTraits.join("; ")})` : ""}`,
            ),
          )
        : "",
      section("LIGHTING", [clean(d.lighting) || clean(s?.lighting) || clean(i.location?.description.lighting)]),
      continuity.length ? section("CONTINUITY", continuity) : "",
      i.reserveTextSpace === false || i.film
        ? ""
        : section("DIALOGUE NEGATIVE SPACE", [
            negative
              ? `Leave clean, uncluttered negative space in the ${clean(negative.area)} for ${negative.purpose} to be added later.`
              : "Leave some calm negative space near the top of the frame.",
            "Leave visual space for dialogue but do not draw dialogue or speech bubbles.",
          ]),
      section("STRICT EXCLUSIONS", [
        ...STRICT_BASE,
        ...(nobody
          ? ["Do not add any people."]
          : [
              "Do not change character identity.",
              "Do not change hairstyle or hair color.",
              "Do not change eye color.",
              "Do not randomly change outfits.",
              "Do not add extra people.",
            ]),
        FULL_BLEED,
        "Show one frozen moment; only the characters listed, each matching their reference and appearance requirements.",
        FINISH,
      ]),
    ]);
  },
};

export type PanelEditInput = {
  instruction: string;
  operation?: string;
  characters: { name: string; referenceImageIndex?: number; immutableTraits: string[] }[];
  style: StyleContext;
};

export const panelEditV1: ImageTemplate<PanelEditInput> = {
  name: "panel-edit",
  version: 4,
  kind: "image",
  description: "Targeted masked edit of an existing panel.",
  body: "ROLE / GOAL, EDIT, IDENTITY, STRICT EXCLUSIONS",
  compile(i) {
    return join([
      "Edit image 1 (the current panel). Change ONLY the transparent masked region; keep everything outside the mask pixel-identical in content, style, lighting and composition.",
      section("EDIT", [i.operation ? `Operation: ${i.operation}` : "", clean(i.instruction)]),
      i.characters.length
        ? section(
            "IDENTITY",
            i.characters.map(
              (c) =>
                `${c.name}${c.referenceImageIndex ? ` matches reference image ${c.referenceImageIndex}` : ""}.${c.immutableTraits.length ? ` Never change: ${c.immutableTraits.join("; ")}.` : ""}`,
            ),
          )
        : "",
      section("STYLE", [
        `Keep the existing ${i.style.presetName ?? "art"} style. ${i.style.colorDirective}`,
        "Blend seamlessly at the mask edge: match line weight, shading, color, lighting direction and perspective of the surrounding art.",
        FINISH,
      ]),
      section("STRICT EXCLUSIONS", [...STRICT_BASE, "Do not alter unmasked areas."]),
    ]);
  },
};

export type CoverInput = {
  style: StyleContext;
  title: string;
  subtitle: string;
  summary: string;
  composition: string;
  characters: { name: string; appearance: string; referenceImageIndex?: number }[];
};

export const coverV1: ImageTemplate<CoverInput> = {
  name: "cover",
  version: 4,
  kind: "image",
  description: "Cover artwork without title text (title is composited by the app).",
  body: "ROLE / GOAL, PROJECT ART DIRECTION, STORY, CHARACTERS, COMPOSITION, STRICT EXCLUSIONS",
  compile(i) {
    return join([
      `Create portrait cover artwork for a ${projectTypeLabel[i.style.projectType] ?? "comic"} series. Artwork only — the title will be added later by our layout software.`,
      styleSection(i.style),
      section("STORY", [clean(i.summary)]),
      i.characters.length
        ? section(
            "CHARACTERS",
            i.characters.map(
              (c) =>
                `${c.name}${c.referenceImageIndex ? ` (the person in reference image ${c.referenceImageIndex})` : ""}: ${clean(c.appearance)}`,
            ),
          )
        : "",
      section("COMPOSITION", [
        clean(i.composition) || "Dramatic hero composition with the main character prominent.",
        "Keep the top 25% relatively calm for a title and the bottom 12% for a subtitle.",
      ]),
      section("PRESENTATION", [FULL_BLEED, FINISH]),
      section("STRICT EXCLUSIONS", [...STRICT_BASE, "No title text.", "Do not change character identity."]),
    ]);
  },
};

export const IMAGE_TEMPLATES = [
  characterReferenceV1,
  locationReferenceV1,
  propReferenceV1,
  styleReferenceV1,
  panelGenerationV1,
  panelEditV1,
  coverV1,
];
