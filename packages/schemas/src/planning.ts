import { z } from "zod";
import { PanelSeam, StripPanelHeight } from "./editor.ts";

const str = z.string().trim();
const optStr = z.string().trim().optional().default("");
const strList = z.array(z.string().trim()).optional().default([]);

export const ShotType = z.enum([
  "extreme-wide",
  "wide",
  "full",
  "medium",
  "medium-close",
  "close",
  "extreme-close",
  "insert",
]);
export const CameraAngle = z.enum([
  "eye-level",
  "low",
  "high",
  "birds-eye",
  "worms-eye",
  "over-shoulder",
  "dutch",
  "pov",
]);
export type ShotType = z.infer<typeof ShotType>;
export type CameraAngle = z.infer<typeof CameraAngle>;

export const PanelCharacterSpec = z.object({
  characterId: str.describe("character id or analysis key"),
  expression: optStr,
  pose: optStr,
  action: optStr,
  outfit: optStr,
  outfitScope: z
    .enum(["onward", "panel"])
    .optional()
    .describe("onward (default): outfit holds until another is named; panel: this panel only"),
  position: optStr.describe("where in the frame, e.g. right third, foreground"),
});
export type PanelCharacterSpec = z.infer<typeof PanelCharacterSpec>;

export const NegativeSpace = z.object({
  area: str,
  purpose: z.enum(["dialogue", "narration", "sfx"]),
});

export const PanelSpec = z.object({
  beat: str,
  shotType: ShotType.catch("medium"),
  cameraAngle: CameraAngle.catch("eye-level"),
  characters: z.array(PanelCharacterSpec).default([]),
  locationId: z.string().optional(),
  composition: optStr,
  foreground: z.string().optional(),
  midground: z.string().optional(),
  background: z.string().optional(),
  lighting: z.string().optional(),
  emotion: z.string().optional(),
  action: z.string().optional(),
  continuityRequirements: strList,
  negativeSpace: NegativeSpace.optional(),
  propIds: strList,
  dialogueIds: strList,
  narrationIds: strList,
  sfxIds: strList,
  /**
   * Vertical strips only, both ignored by paged and film projects.
   *
   * `height` is pacing: how long the reader spends on this panel. `seam` is the transition into it, so a scene
   * change is authored on the panel that opens the new scene.
   */
  height: StripPanelHeight.optional(),
  seam: PanelSeam.optional(),
});
export type PanelSpec = z.infer<typeof PanelSpec>;

export const PlannedDialogue = z.object({
  speaker: optStr.describe("character key/id or empty for off-panel"),
  text: str,
  kind: z.enum(["normal", "thought", "shout", "whisper"]).catch("normal"),
  preferredQuadrant: z.enum(["top-left", "top-right", "bottom-left", "bottom-right", "top", "bottom"]).optional(),
});

/**
 * The dialogue and SFX a plan wrote for a panel, kept on the panel when they were not lettered at once (auto-placement
 * off), so the page can be lettered from the plan later instead of retyping it. Speakers are resolved to characters.
 */
export const PlannedLettering = z.object({
  dialogue: z.array(
    z.object({
      speakerId: z.string().nullable(),
      text: z.string(),
      kind: PlannedDialogue.shape.kind,
      preferredQuadrant: PlannedDialogue.shape.preferredQuadrant,
    }),
  ),
  sfx: z.array(z.string()),
});
export type PlannedLettering = z.infer<typeof PlannedLettering>;

export const PlannedPanel = z.object({
  spec: PanelSpec,
  dialogue: z.array(PlannedDialogue).optional().default([]),
  narration: strList,
  sfx: strList,
});
export type PlannedPanel = z.infer<typeof PlannedPanel>;

export const PlannedPage = z.object({
  purpose: optStr,
  pacing: optStr,
  visualEmphasis: optStr,
  pageTurnHook: optStr,
  layoutTemplate: optStr.describe("one of the provided layout template keys"),
  panels: z.array(PlannedPanel).min(1).max(5),
});
export type PlannedPage = z.infer<typeof PlannedPage>;

export const SceneState = z.record(z.string(), z.string()).describe("continuity facts keyed by subject");

export const PlannedScene = z.object({
  title: str,
  summary: optStr,
  locationKey: optStr,
  time: optStr,
  weather: optStr,
  characterKeys: strList,
  purpose: optStr,
  opening: optStr,
  progression: optStr,
  climax: optStr,
  ending: optStr,
  continuityNotes: strList,
  initialState: SceneState.optional().default({}),
  finalState: SceneState.optional().default({}),
  continuityDeltas: strList,
  beats: strList,
  pages: z.array(PlannedPage).min(1),
});
export type PlannedScene = z.infer<typeof PlannedScene>;

export const ChapterPlan = z.object({
  chapterSummary: optStr,
  openingState: optStr,
  closingState: optStr,
  characterStateChanges: strList,
  locationStateChanges: strList,
  revealedFacts: strList,
  scenes: z.array(PlannedScene).min(1),
});
export type ChapterPlan = z.infer<typeof ChapterPlan>;

/**
 * A chapter plan is one response per chapter, and a feature-length chapter does not fit: production runs hit
 * "output was truncated at the max token limit (64000)" on OpenAI and DeepSeek alike, and no model choice fixes
 * it. These two split the same plan into an outline and then one response per scene, each comfortably bounded.
 */
export const SceneOutline = PlannedScene.omit({ pages: true });
export type SceneOutline = z.infer<typeof SceneOutline>;

export const ChapterOutline = ChapterPlan.omit({ scenes: true }).extend({
  scenes: z.array(SceneOutline).min(1),
});
export type ChapterOutline = z.infer<typeof ChapterOutline>;

/** One scene's pages, planned against the outline so the rest of the chapter is still in view. */
export const ScenePages = z.object({ pages: z.array(PlannedPage).min(1) });
export type ScenePages = z.infer<typeof ScenePages>;

/** DeepSeek-written descriptive sections for panel image prompts. */
export const PanelPromptDraft = z.object({
  panels: z.array(
    z.object({
      panelId: str,
      intent: optStr,
      action: optStr,
      expression: optStr,
      composition: optStr,
      lighting: optStr,
      continuity: strList,
    }),
  ),
});
export type PanelPromptDraft = z.infer<typeof PanelPromptDraft>;

export const NarrationDraft = z.object({
  lines: z.array(
    z.object({
      text: str.min(1),
      panelId: z.string().optional(),
    }),
  ),
});
export type NarrationDraft = z.infer<typeof NarrationDraft>;

/** v2: every line is tied to the panel it plays over. */
export const NarrationDraftV2 = z.object({
  lines: z.array(z.object({ text: str.min(1), panelId: str.min(1) })),
});

export const NARRATION_MIN_PANEL_COVERAGE = 0.9;
/** A draft whose total length is below this share of the words-per-panel target is sent back for repair. */
export const NARRATION_MIN_LENGTH_RATIO = 0.7;
/**
 * Word count for length targets. Languages written without spaces (Japanese, Chinese, Thai) are estimated at two
 * characters per word, which keeps the words-per-panel target roughly equal in speaking time.
 */
export const countWords = (s: string, language = "en") =>
  /^(ja|zh|th|lo|km|my)\b/i.test(language)
    ? Math.round(s.replace(/\s+/g, "").length / 2)
    : s.split(/\s+/).filter(Boolean).length;

/**
 * NarrationDraftV2 plus coverage/length checks for a specific chapter. Failures produce readable issues that the
 * structured-output repair step receives, including the beats of uncovered panels so it can write their lines.
 */
export function narrationDraftFor(panels: { id: string; beat?: string }[], wordsPerPanel: number, language = "en") {
  return NarrationDraftV2.superRefine((d, ctx) => {
    if (!panels.length) return;
    const known = new Set(panels.map((p) => p.id));
    const covered = new Set(d.lines.map((l) => l.panelId).filter((id) => known.has(id)));
    if (covered.size / panels.length < NARRATION_MIN_PANEL_COVERAGE) {
      const missing = panels.filter((p) => !covered.has(p.id));
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: `only ${covered.size}/${panels.length} panels have narration; every panel needs at least one line with its panelId. Add lines for: ${missing
          .slice(0, 60)
          .map((p) => `${p.id}${p.beat ? ` (${p.beat.slice(0, 90)})` : ""}`)
          .join("; ")}`,
      });
    }
    const words = d.lines.reduce((n, l) => n + countWords(l.text, language), 0);
    const minWords = Math.round(panels.length * wordsPerPanel * NARRATION_MIN_LENGTH_RATIO);
    if (words < minWords)
      ctx.addIssue({
        code: "custom",
        path: ["lines"],
        message: `narration is too short: ${words} words for ${panels.length} panels; write about ${wordsPerPanel} words per panel (at least ${minWords} words in total), expanding existing lines rather than adding filler`,
      });
  });
}

export const StoryRewrite = z.object({ content: str.min(1), notes: optStr });

/** Vision check of a generated panel against the cast it was supposed to show. */
export const PanelCheck = z.object({
  peopleCount: z.number().int().min(0).max(100),
  expectedCharactersPresent: strList,
  missingCharacters: strList,
  unexpectedPeople: z.number().int().min(0).max(100).default(0),
  readableText: z.boolean().default(false),
  notes: optStr,
});
export type PanelCheck = z.infer<typeof PanelCheck>;
