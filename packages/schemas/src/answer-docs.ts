import type { z } from "zod";
import type { FieldDocs } from "./answer-format.ts";
import {
  ChapterOutline,
  NarrationDraftV2,
  PanelCheck,
  PanelPromptDraft,
  ScenePages,
  StoryRewrite,
} from "./planning.ts";
import { StoryAnalysis } from "./story.ts";
import { ImageDescription } from "./vision.ts";

/**
 * Every answer a person may be asked to paste, by the name its prompt uses. Narration is the plain shape its prompt
 * shows; the extra coverage and length checks the chapter adds are explained in the `lines` description.
 */
export const ANSWER_SCHEMAS = {
  StoryAnalysis,
  StoryRewrite,
  ChapterOutline,
  ScenePages,
  PanelPromptDraft,
  NarrationDraft: NarrationDraftV2,
  ImageDescription,
  PanelCheck,
} satisfies Record<string, z.ZodType>;

/** Prefixes every key of a shared group, so a sub-object that appears in several answers is explained once. */
const under = (prefix: string, group: FieldDocs): FieldDocs =>
  Object.fromEntries(Object.entries(group).map(([k, v]) => [k ? `${prefix}.${k}` : prefix, v]));

// The examples below all describe one small story, "The Lamp at Vell": Ines, a lighthouse engineer (key "ines");
// Tomas, the old keeper (key "tomas"); the lighthouse Vell Light (key "vell"); and Ines's weather notebook
// (key "notebook").

/** A character's visual bible: StoryAnalysis `characters[].bible` and ImageDescription `character`. */
const CHARACTER_BIBLE: FieldDocs = {
  genderPresentation: ["How the character presents, as it should be drawn.", "woman"],
  ageRange: ["Apparent age, best as a number range.", "early 30s"],
  height: ["Height, ideally relative to the rest of the cast.", "tall, a head above Tomas"],
  build: ["Body shape and frame.", "lean, long-limbed"],
  faceShape: ["The shape of the face.", "narrow oval with a pointed chin"],
  skinTone: ['Skin tone. The image prompt adds the word "skin" after it.', "light olive"],
  eyes: ["Eye shape and colour.", "hooded grey eyes"],
  eyebrows: ["Eyebrow shape and colour.", "straight dark brows"],
  nose: ["Nose shape.", "long straight nose"],
  mouth: ["Mouth and lips.", "thin lips, often pressed together"],
  hair: [
    "Exact hair colour, length and style.",
    "shoulder-length black hair tied back, a silver streak at the left temple",
  ],
  facialHair: ["Beard or moustache; leave empty when there is none.", ""],
  distinctiveFeatures: [
    "Visible marks that help tell the character apart, one per item.",
    ["small faded mark on the right cheekbone", "ink stains on the fingertips"],
  ],
  wardrobe: [
    'The default outfit with colours and materials. It becomes the character\'s "Default" outfit and is drawn ' +
      "whenever a panel names no other outfit.",
    "navy oilskin coat over a grey wool jumper, dark canvas trousers, black rubber boots",
  ],
  accessories: [
    "Things the character wears besides clothes, one per item.",
    ["round wire glasses", "brass pocket watch"],
  ],
  weapons: ["Weapons the character carries, one per item; empty when none.", []],
  props: ["Objects the character usually carries, one per item.", ["weather notebook", "pencil stub"]],
  personality: [
    "Personality in a few words. Kept apart from appearance so it never reaches the drawing as a look.",
    "precise, stubborn, quietly kind",
  ],
  visualMannerisms: [
    "How the personality shows in posture and gesture; the image prompt uses it for the character's reference sheet.",
    "taps her pencil against the notebook when thinking",
  ],
  defaultExpression: [
    "The expression the character wears when a panel does not say otherwise.",
    "focused, slight frown",
  ],
  immutableTraits: [
    "3-6 short, visible identity markers that must stay the same in every panel. The image prompt lists them as " +
      '"never change". Never put personality or plot facts here.',
    ["silver streak in black hair", "round wire glasses", "navy oilskin coat"],
  ],
  outfitVariants:
    "Other outfits the character wears in the story. Each one with a description becomes an extra outfit for the " +
    "character, next to the default wardrobe.",
  "outfitVariants[].name": ["A short name for the outfit.", "Storm gear"],
  "outfitVariants[].description": [
    "What the outfit looks like, with colours and materials. An outfit with no description is not created.",
    "yellow sou'wester hat and full-length yellow oilskins over the jumper",
  ],
  summary: [
    "A one- or two-sentence description of the whole look.",
    "A tall woman in her early 30s with tied-back black hair, a silver streak and wire glasses, " +
      "in a navy oilskin coat.",
  ],
};

/** A place's description: StoryAnalysis `locations[].description` and ImageDescription `location`. */
const LOCATION_DESCRIPTION: FieldDocs = {
  kind: ["What sort of place it is: a room, building, street, vehicle interior, landscape and so on.", "building"],
  architecture: ["Building style, construction and materials.", "whitewashed stone tower with an iron lantern room"],
  layout: [
    "How the space is arranged, so it can be drawn the same way from any angle.",
    "spiral stair up the tower; keeper's cottage attached at the base, facing the harbour",
  ],
  palette: ["The colours the place is built from.", "white stone, rust red ironwork, slate grey sea"],
  lighting: [
    "The place's typical light. A panel falls back on it when neither its prompt draft nor its spec names lighting.",
    "cold overcast daylight; warm lamp glow from the lantern room at night",
  ],
  atmosphere: ["The feeling the place gives.", "windswept and isolated, but cared for"],
  keyFeatures: [
    "3-6 features that make the place recognisable; panel images are asked to show them.",
    ["red iron lantern gallery", "brass lens behind the glass", "seaweed-covered rocks at the base"],
  ],
  immutableTraits: [
    "Things about the place that must never change between images, one per item.",
    ["tower is white with a red lantern room", "cottage door faces the harbour"],
  ],
  summary: [
    "A one- or two-sentence description of the place. Panel image prompts use it to describe the location.",
    "A whitewashed stone lighthouse with a red iron lantern room on a rocky point, a small cottage at its foot.",
  ],
};

/**
 * The free-text aspects of ImageDescription (outfit, lighting, composition, mood, props, era, technique): each one
 * is a short summary plus a list of details, returned as text for the person to reuse, not turned into anything.
 */
const prose = (what: string, summary: string, details: string[]): FieldDocs => ({
  summary: [`${what} in one or two sentences.`, summary],
  details: [`Specific points about the ${what.toLowerCase()}, one per item.`, details],
});

export const ANSWER_FIELD_DOCS: Record<keyof typeof ANSWER_SCHEMAS, FieldDocs> = {
  StoryAnalysis: {
    "": "The story bible read from the source text: cast, places, props, world and chapter breakdown.",
    title: ["The story's title.", "The Lamp at Vell"],
    summary: [
      "A short summary of the whole story. Shown for review with the analysis.",
      "A lighthouse engineer sent to shut down the old light at Vell finds its keeper will not leave, " +
        "and a storm forces them to keep the lamp burning together.",
    ],
    genre: ["The main genre. Shown for review with the analysis.", "drama"],
    subgenre: ["A narrower genre within it. Shown for review with the analysis.", "maritime slice of life"],
    tone: ["The story's overall tone. Shown for review with the analysis.", "quiet, bittersweet, hopeful"],
    themes: ["What the story is about underneath the plot, one per item.", ["duty", "letting go", "old and new ways"]],
    setting: [
      "Where the story takes place. Goes into the project's world notes (if it has none yet), which planning receives.",
      "a remote lighthouse on a rocky northern coast",
    ],
    period: ["When the story takes place; added next to the setting in the world notes.", "late 1950s"],
    pacing: ["How fast the story moves. Shown for review with the analysis.", "slow build to a storm-night climax"],
    visualMotifs: [
      "Images that recur through the story, one per item. Added to the project's world notes.",
      ["the turning beam", "rain on glass", "the open notebook"],
    ],
    protagonistKey: ["The key of the main character. Must equal one of `characters[].key`.", "ines"],
    characters:
      "Everyone who appears or acts in the story, once each. Each becomes a character in the project's cast, unless " +
      "one with the same key or name already exists.",
    "characters[].key": [
      "A short lowercase slug for this character. Other fields refer to the character by this key.",
      "ines",
    ],
    "characters[].name": ["The character's name as it appears in the cast list.", "Ines Varga"],
    "characters[].aliases": [
      "Other names, epithets or descriptions the text uses for the same person, so they are not counted twice.",
      ["the engineer", "Miss Varga"],
    ],
    "characters[].role": ["The character's part in the story.", "protagonist"],
    "characters[].bible":
      "What the character looks like and how they behave, precise enough to draw them the same in every panel. It " +
      "becomes the character's first design version.",
    ...under("characters[].bible", CHARACTER_BIBLE),
    relationships: "How characters relate to each other, one entry per pair and direction.",
    "relationships[].from": [
      "The key of the character the relationship is seen from. Must match a character key.",
      "ines",
    ],
    "relationships[].to": ["The key of the other character. Must match a character key.", "tomas"],
    "relationships[].kind": ["What the relationship is, in a word or two.", "reluctant respect"],
    "relationships[].notes": [
      "Anything more about the relationship.",
      "She was sent to retire him; by the end she wants his advice.",
    ],
    locations:
      "The places the story uses. Each becomes a location in the project, unless one with the same key or name " +
      "already exists.",
    "locations[].key": ["A short lowercase slug for the place. Other fields refer to it by this key.", "vell"],
    "locations[].name": ["The place's name as it appears in the project.", "Vell Light"],
    "locations[].description": "How the place looks. It becomes the location's first description version.",
    ...under("locations[].description", LOCATION_DESCRIPTION),
    props: "Important objects in the story.",
    "props[].key": ["A short lowercase slug for the object. Other fields refer to it by this key.", "notebook"],
    "props[].name": ["The object's name as it appears in the project.", "Ines's weather notebook"],
    "props[].recurring": [
      "Whether the object matters visually across several scenes. Only recurring props are added to the project.",
      true,
    ],
    "props[].description": "How the object looks. It becomes the prop's first description version.",
    "props[].description.kind": ["What sort of object it is.", "pocket notebook"],
    "props[].description.material": ["What it is made of.", "oilcloth cover, lined paper"],
    "props[].description.size": ["How big it is.", "palm-sized"],
    "props[].description.colors": ["Its colours.", "dark green cover, cream pages, red elastic band"],
    "props[].description.keyFeatures": [
      "Details that make the object recognisable, one per item.",
      ["red elastic band", "dog-eared corners"],
    ],
    "props[].description.immutableTraits": [
      "Things about the object that must never change between images. Panel prompts list them next to the prop.",
      ["dark green cover", "red elastic band"],
    ],
    "props[].description.summary": [
      "A one- or two-sentence description of the object. Panel image prompts use it to describe the prop.",
      "A palm-sized notebook with a dark green oilcloth cover held shut by a red elastic band.",
    ],
    world: "Facts about the story's world that hold everywhere in it.",
    "world.worldRules": [
      "Rules of the world, one per item. Added to the project's world notes.",
      ["the lamp must be lit from sunset to sunrise", "the supply boat comes once a fortnight"],
    ],
    "world.factions": "Groups, organisations or sides in the story. Added to the project's world notes.",
    "world.factions[].name": ["The group's name.", "Coastal Lights Board"],
    "world.factions[].description": [
      "Who they are and what they want.",
      "The authority replacing keepers with automatic lamps.",
    ],
    "world.uniforms": ["Uniforms worn in the story, one per item.", ["Lights Board navy coat with brass buttons"]],
    "world.technology": [
      "The level and kind of technology. Added to the project's world notes.",
      "paraffin lamps, clockwork lens drive, radio telephone",
    ],
    "world.magicSystem": [
      "How magic works, if there is any; added to the world notes. When there is none, leave it empty or say so.",
      "none; the lamp turning by itself is never explained",
    ],
    "world.recurringScenery": [
      "Backgrounds that come back often, one per item.",
      ["the harbour wall", "the spiral stair"],
    ],
    "world.vehicles": ["Vehicles in the story, one per item.", ["the fortnightly supply boat"]],
    "world.notes": [
      "Anything else about the world.",
      "The village of Vell is across the bay and never shown up close.",
    ],
    plotBeats: "The story's major events, in order. Shown for review with the analysis.",
    "plotBeats[].order": ["The beat's position in the story, counting from 1.", 1],
    "plotBeats[].summary": ["What happens in this beat.", "Ines arrives at Vell with orders to shut down the light."],
    "plotBeats[].characters": [
      "Keys of the characters in this beat. Each must match a character key.",
      ["ines", "tomas"],
    ],
    "plotBeats[].locationKey": ["The key of the place the beat happens in. Must match a location key.", "vell"],
    chapters:
      "The story split into chapters at natural breaks; at least one. Each becomes a chapter in the project, with " +
      "its part of the source text attached.",
    "chapters[].order": ["The chapter's position, counting from 1.", 1],
    "chapters[].title": [
      "The chapter's title. A chapter whose title already exists from an earlier analysis is skipped.",
      "The Last Keeper",
    ],
    "chapters[].summary": [
      "What happens in the chapter and what has changed by its end.",
      "Ines reaches Vell and meets Tomas, who refuses to leave; she agrees to stay until the storm passes.",
    ],
    "chapters[].sourceStart": [
      "The first ~12 words of the chapter, copied exactly from the source text. The app searches for them to cut " +
        "the source into chapters; if they cannot be found, the text is split evenly instead.",
      "The supply boat left Ines on the jetty at Vell just as the wind",
    ],
    "chapters[].beats": [
      "The chapter's main beats, in order, one per item.",
      ["Ines lands at Vell", "Tomas refuses to leave", "the storm comes in"],
    ],
  },

  StoryRewrite: {
    "": "A rewritten version of the story, following the editor's instruction.",
    content: [
      "The full rewritten story text. It is saved as a new revision of the story.",
      "The supply boat left Ines on the jetty at Vell just as the wind turned. " +
        "Up on the point, the lamp was already lit.",
    ],
    notes: [
      "A short note on what was changed. Returned with the result; not part of the story.",
      "Tightened the opening and moved the storm warning earlier.",
    ],
  },

  ChapterOutline: {
    "": "One chapter broken into scenes, without pages yet; each scene's pages are planned in a later step.",
    chapterSummary: [
      "What happens in the chapter. Replaces the chapter's summary when not empty.",
      "Ines reaches Vell and meets Tomas, who refuses to leave; she agrees to stay until the storm passes.",
    ],
    openingState: [
      "How things stand when the chapter opens.",
      "Ines is on her way to close the light; Tomas is alone at Vell.",
    ],
    closingState: [
      "How things stand when the chapter ends. The next chapter's planning receives it.",
      "Ines and Tomas are shut in the tower together as the storm starts.",
    ],
    characterStateChanges: [
      "How characters have changed by the end of the chapter, one per item. The next chapter's planning receives them.",
      ["Ines: coat soaked through", "Tomas: has read the closure order"],
    ],
    locationStateChanges: [
      "How places have changed by the end of the chapter, one per item.",
      ["Vell Light: storm shutters closed"],
    ],
    revealedFacts: [
      "Facts the reader learns in this chapter, one per item. The next chapter's planning receives them.",
      ["Tomas has kept the light for forty years"],
    ],
    scenes: "The chapter's scenes in story order; at least one. Each becomes a scene of the chapter.",
    "scenes[].title": [
      "A short title for the scene. The page-planning step names the scene it plans by this title.",
      "Arrival at Vell",
    ],
    "scenes[].summary": [
      "What happens in the scene.",
      "Ines climbs from the jetty to the lighthouse and meets Tomas at the door.",
    ],
    "scenes[].locationKey": [
      "The key of the place the scene happens in. Must match a location key from the prompt's project data.",
      "vell",
    ],
    "scenes[].time": ["Time of day.", "late afternoon"],
    "scenes[].weather": ["The weather in the scene.", "rising wind, low grey cloud"],
    "scenes[].characterKeys": [
      "Keys of the characters present. Each must match a character key from the prompt's project data.",
      ["ines", "tomas"],
    ],
    "scenes[].purpose": ["What the scene does for the story.", "set up the conflict between Ines and Tomas"],
    "scenes[].opening": ["How the scene opens.", "Ines alone on the jetty as the boat leaves"],
    "scenes[].progression": ["How the scene develops.", "she climbs to the tower; Tomas opens the door but blocks it"],
    "scenes[].climax": ["The scene's high point.", "Tomas tears up the closure order"],
    "scenes[].ending": ["How the scene ends.", "he steps aside to let her in out of the rain"],
    "scenes[].continuityNotes": [
      "Things that must stay consistent through the scene, one per item.",
      ["Ines carries her notebook in her coat pocket"],
    ],
    "scenes[].initialState": [
      "Continuity facts at the start of the scene, keyed by who or what they are about.",
      { ines: "dry, coat buttoned", tomas: "in shirtsleeves" },
    ],
    "scenes[].finalState": [
      "Continuity facts at the end of the scene, keyed by who or what they are about.",
      { ines: "soaked through", tomas: "holding the torn order" },
    ],
    "scenes[].continuityDeltas": [
      'What changed during the scene, one per item, written as "who: what changed".',
      ["Ines: coat soaked through"],
    ],
    "scenes[].beats": [
      "The scene's beats in order, one per item. Each is saved as a story beat of the scene.",
      ["the boat leaves", "Tomas blocks the door", "the order is torn up"],
    ],
  },

  ScenePages: {
    "": "The pages of one scene, each with its panels, panel specs and lettering.",
    pages: "The scene's pages in reading order; at least one.",
    "pages[].purpose": ["What the page does for the story.", "introduce Vell Light and Ines's arrival"],
    "pages[].pacing": ["How fast the page reads.", "slow, lingering"],
    "pages[].visualEmphasis": ["What the page should make the reader look at.", "the lighthouse against the sky"],
    "pages[].pageTurnHook": ["What pulls the reader on to the next page.", "a figure watching from the lantern room"],
    "pages[].layoutTemplate": [
      "One of the layout template keys the prompt lists, with the same number of panels as this page. If it does not " +
        'fit, a default layout for that panel count is used. Film and vertical projects always use "full-page".',
      "full-page",
    ],
    "pages[].panels": "The page's panels in reading order, 1 to 5.",
    "pages[].panels[].spec": "What the panel shows. It is saved as the panel's spec and drives its image prompt.",
    "pages[].panels[].spec.beat": [
      "The single moment the panel shows, as one visible action. Stored as the panel's story beat.",
      "Ines looks up at the lighthouse from the end of the jetty.",
    ],
    "pages[].panels[].spec.shotType": ["How much of the scene the frame takes in, from very wide to a detail.", "wide"],
    "pages[].panels[].spec.cameraAngle": ["Where the camera looks from.", "low"],
    "pages[].panels[].spec.characters":
      "Exactly the characters visible in the panel. Characters that cannot be matched to the cast are dropped.",
    "pages[].panels[].spec.characters[].characterId": [
      "The character's key (or id) from the prompt's project data.",
      "ines",
    ],
    "pages[].panels[].spec.characters[].expression": [
      "The character's facial expression.",
      "wary, squinting into the wind",
    ],
    "pages[].panels[].spec.characters[].pose": ["The character's pose.", "standing, one hand holding her hat"],
    "pages[].panels[].spec.characters[].action": ["What the character is doing.", "looking up at the tower"],
    "pages[].panels[].spec.characters[].outfit": [
      "The outfit, only if it changes. Naming one of the character's outfits (project data lists them under outfits) switches the character into it from this panel on, reference image included, until another is named; anything else describes this panel's wardrobe.",
      "Storm gear, hood up",
    ],
    "pages[].panels[].spec.characters[].position": [
      "Where the character is in the frame. Also used to point the speech bubble's tail at the speaker.",
      "left foreground",
    ],
    "pages[].panels[].spec.locationId": [
      "The key (or id) of the panel's location from the prompt's project data. " +
        "Leave it out to use the scene's location.",
      "vell",
    ],
    "pages[].panels[].spec.composition": [
      "The focal subject and where it sits in the frame.",
      "Ines small in the lower left, the tower filling the right two thirds",
    ],
    "pages[].panels[].spec.foreground": [
      "What is in the foreground; best drawn from the location's key features.",
      "wet planks of the jetty",
    ],
    "pages[].panels[].spec.midground": ["What is in the middle distance.", "seaweed-covered rocks at the base"],
    "pages[].panels[].spec.background": [
      "What is in the background.",
      "the white tower and red lantern room against low cloud",
    ],
    "pages[].panels[].spec.lighting": [
      "Light source, direction and colour temperature. Must stay inside the project's art direction.",
      "cold overcast daylight from the left",
    ],
    "pages[].panels[].spec.emotion": [
      "The feeling of the panel; the image prompt adds it as the mood. Must stay inside the project's art direction.",
      "quiet unease",
    ],
    "pages[].panels[].spec.action": [
      "The panel's main action. Used when the panel has no prompt draft action.",
      "Ines stops and looks up at the tower",
    ],
    "pages[].panels[].spec.continuityRequirements": [
      "Facts that must visibly carry over from earlier panels, one per item. Added to the image prompt.",
      ["notebook in her coat pocket"],
    ],
    "pages[].panels[].spec.negativeSpace":
      "Where to keep the image calm so lettering can be added later. Plan it for every panel with dialogue or " +
      "narration; leave it out for film projects.",
    "pages[].panels[].spec.negativeSpace.area": ["The part of the frame to keep clear.", "upper left sky"],
    "pages[].panels[].spec.negativeSpace.purpose": ["What will go in that space.", "dialogue"],
    "pages[].panels[].spec.propIds": [
      "Keys (or ids) of props from the prompt's project data that appear in the panel. Unknown keys are dropped.",
      ["notebook"],
    ],
    "pages[].panels[].spec.dialogueIds": [
      "Leave empty. The app fills it with the ids of the bubbles it creates from `dialogue`.",
      [],
    ],
    "pages[].panels[].spec.narrationIds": [
      "Leave empty. The app fills it with the ids of the captions it creates from `narration`.",
      [],
    ],
    "pages[].panels[].spec.sfxIds": [
      "Leave empty. The app fills it with the ids of the sound effects it creates from `sfx`.",
      [],
    ],
    "pages[].panels[].spec.height": [
      'Vertical strips only: how long the reader spends on the panel, which sets its height in the strip. "short" ' +
        'reads fast, "tall" and "very-tall" hold a moment. Ignored by other formats.',
      "tall",
    ],
    "pages[].panels[].spec.seam":
      "Vertical strips only: how this panel meets the one above it. The first panel of a chapter needs none. " +
      "Ignored by other formats.",
    "pages[].panels[].spec.seam.kind": [
      '"gap" shows background between panels (a beat change); "butt" joins them with no break (action continues); ' +
        '"bleed" overlaps with a hard edge; "dissolve" overlaps with a blend; "fade" fades both edges into a ' +
        "colour (a change of scene, place or time).",
      "fade",
    ],
    "pages[].panels[].spec.seam.size": [
      "Pixels at the strip's width: the gap, the overlap depth, or the fade band. Leave it out to size it from the panels it joins.",
      120,
    ],
    "pages[].panels[].spec.seam.color": [
      'The colour to fade through, as a hex code; only used by "fade". Defaults to the strip background.',
      "#0b0f1a",
    ],
    "pages[].panels[].dialogue":
      "Speech bubbles in the panel, in reading order; each at most about 20 words. Leave empty for film projects.",
    "pages[].panels[].dialogue[].speaker": [
      "The speaker's character key, or empty when the speaker is off-panel. The bubble's tail points at them.",
      "tomas",
    ],
    "pages[].panels[].dialogue[].text": ["The words in the bubble.", "You're the one they sent to put out my light."],
    "pages[].panels[].dialogue[].kind": ["The bubble style: spoken, thought, shouted or whispered.", "shout"],
    "pages[].panels[].dialogue[].preferredQuadrant": [
      "Where in the panel the bubble should go if there is room. Leave it out to let the app choose.",
      "top-right",
    ],
    "pages[].panels[].narration": [
      "Caption text for the panel, one caption per item. Optional.",
      ["The light at Vell had not gone dark in forty years."],
    ],
    "pages[].panels[].sfx": [
      "Sound effects drawn in the panel, one per item. Leave empty for film projects.",
      ["WHOOSH"],
    ],
  },

  PanelPromptDraft: {
    "": "Image-prompt sections written for each panel of a page, from the panel's planned data.",
    panels: "One entry per panel of the page.",
    "panels[].panelId": [
      "The id of the panel this entry is for, copied from the panels in the prompt. " +
        "Entries with an unknown id are ignored.",
      "3f2b8c1e-7a4d-4e0b-9c6a-1d5e8f2a7b90",
    ],
    "panels[].intent": [
      "The story moment in one sentence. Used as the panel's intent in the image prompt, in place of the beat.",
      "Ines arrives and sees the lighthouse she has come to shut down.",
    ],
    "panels[].action": [
      "One visible physical action per character, at its clearest instant. Used in place of the spec's action.",
      "Ines stands at the end of the jetty, head tipped back, one hand holding her hat on.",
    ],
    "panels[].expression": [
      "Face and body language that show the emotion.",
      "narrowed eyes, mouth set, shoulders hunched against the wind",
    ],
    "panels[].composition": [
      "The focal subject, where it sits in the frame, depth and what leads the eye. " +
        "Used in place of the spec's composition.",
      "Ines small in the lower left; the jetty leads the eye to the tower on the right",
    ],
    "panels[].lighting": [
      "The light source, its direction and colour temperature. Used in place of the spec's lighting.",
      "cold overcast daylight from the left, soft shadows",
    ],
    "panels[].continuity": [
      "Only facts that must visibly carry over, one per item. Added to the image prompt's continuity list.",
      ["coat buttoned and dry", "notebook in her coat pocket"],
    ],
  },

  NarrationDraft: {
    "": "Voice-over narration for a chapter, each line tied to the panel it is read over.",
    lines:
      "The narration lines in reading order. At least 90% of the chapter's panels must have a line with their " +
      "panelId, and the total word count must reach at least 70% of (number of panels x the words per panel the " +
      "prompt asks for); otherwise the answer is sent back for repair.",
    "lines[].text": [
      "The spoken line: 1-3 sentences, in the target language, with no labels or markup.",
      "The boat was already turning for home when Ines looked up and saw the light at Vell, burning in broad daylight.",
    ],
    "lines[].panelId": [
      "The id of the panel this line is read over. Must be one of the panel ids listed in the prompt.",
      "panel-1",
    ],
  },

  ImageDescription: {
    "": "A description of a reference image, covering only the aspects that were asked for.",
    overview: [
      "One or two sentences about the image as a whole. Always filled.",
      "A woman in a navy oilskin coat stands on a wet jetty, looking up at a white lighthouse under low cloud.",
    ],
    style:
      "How the image is drawn, not what it shows. It can be used as the project's art style; its fields then go into " +
      "the art direction of every image prompt.",
    "style.summary": [
      "The style in one or two sentences.",
      "Clean ink linework with flat muted colour and soft cel shading.",
    ],
    "style.lineTreatment": ["Line weight and quality.", "fine, even ink lines, heavier on outer contours"],
    "style.colorPolicy": ["How colour is used.", "full colour, muted blues and greys with red accents"],
    "style.shading": ["How shading is done.", "two-tone cel shading"],
    "style.detailLevel": ["How much detail there is.", "detailed backgrounds, simpler figures"],
    "style.faceRendering": ["How faces are drawn.", "realistic proportions, small eyes, minimal nose line"],
    "style.backgroundRendering": ["How backgrounds are drawn.", "painted skies, inked architecture"],
    "style.motionEffects": ["How movement is shown.", "none; still, posed frames"],
    "style.contrast": ["The contrast level.", "medium, soft"],
    "style.screenTones": ["Screen tones, if any. Dropped from prompts for colour projects.", "none"],
    "style.lighting": ["The lighting approach of the style.", "diffuse natural light, few hard shadows"],
    "style.exclusions": [
      'What the style clearly avoids, one per item. Image prompts list them under "Avoid".',
      ["photoreal rendering", "heavy speed lines"],
    ],
    character:
      "The most prominent figure, as a character bible. It can be used to create a character. Leave a field empty " +
      "rather than inventing what the image does not show.",
    ...under("character", CHARACTER_BIBLE),
    outfit: "The clothing in its own right, in enough detail to redraw it on another figure.",
    ...under(
      "outfit",
      prose("Outfit", "A long navy oilskin coat over a grey jumper, with dark trousers and black boots.", [
        "coat buttoned to the collar",
        "wool jumper with a ribbed neck",
        "boots wet to the ankle",
      ]),
    ),
    location: "The setting behind and around the subject. It can be used to create a location.",
    ...under("location", LOCATION_DESCRIPTION),
    lighting: "Key light, shadows, time of day and the palette the image is built from.",
    ...under(
      "lighting",
      prose("Lighting", "Flat overcast daylight from the left, cool and low in contrast.", [
        "no hard shadows",
        "dominant slate grey, accent red",
      ]),
    ),
    composition: "Shot type, camera angle, how the frame is divided and where the eye goes.",
    ...under(
      "composition",
      prose("Composition", "Low-angle wide shot; the figure small in the lower left, the tower filling the right.", [
        "jetty leads the eye to the tower",
        "horizon in the lower third",
      ]),
    ),
    mood: "The feeling the image carries and the choices that create it.",
    ...under(
      "mood",
      prose("Mood", "Lonely and uneasy, softened by the warm lamp.", [
        "small figure against a large tower",
        "cold palette with one warm light",
      ]),
    ),
    props: "Notable objects, weapons, furniture and set dressing.",
    ...under(
      "props",
      prose("Props", "A small green notebook sticks out of the coat pocket.", [
        "notebook with a red elastic band",
        "coil of rope on the jetty",
      ]),
    ),
    era: "The period and cultural setting the image suggests, and the cues that place it.",
    ...under(
      "era",
      prose("Era", "Mid-20th-century northern European coast.", [
        "oilskin workwear",
        "paraffin lamp in the lantern room",
      ]),
    ),
    technique: "The apparent medium and process.",
    ...under(
      "technique",
      prose("Technique", "Digital ink with flat colour and a light paper grain.", [
        "visible paper texture",
        "no halftone",
      ]),
    ),
    custom: ["The answer to the caller's own question, when the prompt includes one; otherwise empty.", ""],
    uncertain: [
      "What could not be told from the image, one per item. Better than a confident guess.",
      ["eye colour (face in shadow)"],
    ],
  },

  PanelCheck: {
    "": "A check of one generated panel image against the characters it was supposed to show.",
    peopleCount: [
      "How many distinct people or human-like figures are visible, including background and partial figures. A " +
        "count different from the expected cast marks the panel as a mismatch.",
      2,
    ],
    expectedCharactersPresent: [
      "Names of the expected characters (as listed in the prompt) that are clearly in the image.",
      ["Ines", "Tomas"],
    ],
    missingCharacters: [
      "Names of the expected characters that are not in the image. Any entry marks the panel as a mismatch.",
      [],
    ],
    unexpectedPeople: [
      "How many visible people are not one of the expected characters. More than zero marks the panel as a mismatch.",
      0,
    ],
    readableText: [
      "true only when the image contains legible letters or words (signs, speech bubbles, captions, screens). Saved " +
        "with the check.",
      false,
    ],
    notes: ["Anything else worth noting. Saved with the check.", "Tomas is partly hidden behind the door."],
  },
};
