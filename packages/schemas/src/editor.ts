import { z } from "zod";

const unit = z.number().min(0).max(1);

/**
 * A PATCH body for an object schema: every field optional, and — unlike `.partial()` — no `.default()` survives.
 * `.partial()` only wraps each field in `ZodOptional`, so a defaulted field a caller omitted still parses back as
 * its default; spreading that over a stored object resets every customised value to the schema's defaults. Use
 * this wherever a parsed patch is merged into stored data, so only the keys the caller actually sent are applied.
 */
export const asPatch = <T extends z.ZodObject<z.ZodRawShape>>(schema: T) =>
  z.object(
    Object.fromEntries(
      Object.entries(schema.shape).map(([k, v]) => {
        const field = (v instanceof z.ZodDefault ? v.def.innerType : v) as z.ZodTypeAny;
        return [k, field.optional()];
      }),
    ),
    // Types as `.partial()` does — every field optional, value types intact — while the runtime drops defaults.
  ) as unknown as ReturnType<T["partial"]>;

export const Frame = z.object({ x: unit, y: unit, width: z.number().gt(0).max(1), height: z.number().gt(0).max(1) });
export type Frame = z.infer<typeof Frame>;

/** Crop/scale of artwork inside a panel frame. focal = normalized point of the image that sits at frame center. */
export const ImageTransform = z.object({
  focalX: unit.default(0.5),
  focalY: unit.default(0.5),
  scale: z.number().min(1).max(8).default(1),
});
export type ImageTransform = z.infer<typeof ImageTransform>;

export const BubbleType = z.enum(["normal", "thought", "shout", "whisper", "narration", "system"]);
export type BubbleType = z.infer<typeof BubbleType>;

/** Vector speech bubble. Geometry is normalized to the page (0..1). */
export const Bubble = z.object({
  type: BubbleType.default("normal"),
  font: z.string().default("Comic Neue"),
  fontSize: z.number().min(4).max(200).default(28),
  lineHeight: z.number().min(0.8).max(3).default(1.2),
  align: z.enum(["left", "center", "right"]).default("center"),
  padding: z.number().min(0).max(200).default(18),
  background: z.string().default("#ffffff"),
  textColor: z.string().default("#111111"),
  borderColor: z.string().default("#111111"),
  borderWidth: z.number().min(0).max(20).default(3),
  tail: z.boolean().default(true),
  tailTarget: z.object({ x: unit, y: unit }).optional(),
  rotation: z.number().min(-180).max(180).default(0),
  x: unit,
  y: unit,
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
  zIndex: z.number().int().default(10),
});
export type Bubble = z.infer<typeof Bubble>;

export const SfxStyle = z.object({
  font: z.string().default("DejaVu Sans"),
  fontSize: z.number().min(8).max(400).default(72),
  fill: z.string().default("#ffdd00"),
  stroke: z.string().default("#111111"),
  strokeWidth: z.number().min(0).max(30).default(6),
  rotation: z.number().min(-180).max(180).default(-8),
  scale: z.number().min(0.1).max(10).default(1),
  opacity: z.number().min(0).max(1).default(1),
  x: unit,
  y: unit,
  zIndex: z.number().int().default(20),
});
export type SfxStyle = z.infer<typeof SfxStyle>;

/** Style fields of a text element that can have a per-type project default. */
export const LetteringStyle = z.object({
  font: z.string().min(1).max(64).optional(),
  fontSize: z.number().min(4).max(200).optional(),
  lineHeight: z.number().min(0.8).max(3).optional(),
  align: z.enum(["left", "center", "right"]).optional(),
  padding: z.number().min(0).max(200).optional(),
  background: z.string().max(32).optional(),
  textColor: z.string().max(32).optional(),
  borderColor: z.string().max(32).optional(),
  borderWidth: z.number().min(0).max(20).optional(),
});
export type LetteringStyle = z.infer<typeof LetteringStyle>;

export const SfxDefaults = z.object({
  font: z.string().min(1).max(64).optional(),
  fontSize: z.number().min(8).max(400).optional(),
  fill: z.string().max(32).optional(),
  stroke: z.string().max(32).optional(),
  strokeWidth: z.number().min(0).max(30).optional(),
  opacity: z.number().min(0).max(1).optional(),
});
export type SfxDefaults = z.infer<typeof SfxDefaults>;

/** Project lettering defaults. Missing fields fall back to the built-in defaults in @openmanga/domain. */
export const LetteringDefaults = z.object({
  /** Create speech bubbles, on-page narration captions and SFX when a chapter plan is applied. */
  autoPlace: z.boolean().optional(),
  autoFit: z.boolean().optional(),
  maxWidth: z.number().min(0.1).max(1).optional(),
  types: z
    .object({
      normal: LetteringStyle.optional(),
      thought: LetteringStyle.optional(),
      shout: LetteringStyle.optional(),
      whisper: LetteringStyle.optional(),
      narration: LetteringStyle.optional(),
      system: LetteringStyle.optional(),
    })
    .optional(),
  sfx: SfxDefaults.optional(),
});
export type LetteringDefaults = z.infer<typeof LetteringDefaults>;

/**
 * "comic": pages read one at a time. "film": every page is one full-frame 16:9 shot rendered as a narrated Ken
 * Burns video. "vertical": one continuous scrolling strip, where what happens *between* panels is authored — see
 * PanelSeam. A vertical project starts with no gutter and no margin, because spacing belongs to the seam rather
 * than being baked into every frame.
 */
export const ProjectFormat = z.enum(["comic", "film", "vertical"]);
export type ProjectFormat = z.infer<typeof ProjectFormat>;
export const FILM_PAGE = { pageWidth: 1920, pageHeight: 1080, pageMargin: 0, pageGutter: 0 } as const;
/**
 * 2:3 per panel, which is the aspect every image provider offers exactly, so a strip panel is generated at its
 * real shape instead of being stretched into it. Panel height is varied per page (pages carry their own height),
 * not by making this taller: a 1:4 page asked the model for 1:4 art, got 9:16 back and squeezed it 2x.
 */
export const VERTICAL_PAGE = { pageWidth: 800, pageHeight: 1200, pageMargin: 0, pageGutter: 0 } as const;

/**
 * How a panel meets the panel before it in a vertical strip. The leading edge belongs to the later panel, so a
 * scene change is authored on the panel that opens the new scene.
 *
 * Until this existed every seam in a strip was the same project-wide gap, which is what made an exported strip
 * read as a stack of separate pictures rather than one continuous scene.
 */
export const PanelSeam = z.object({
  /**
   * gap: background between the panels. butt: none, for continuous action. bleed: the panel overlaps the one
   * before it with a hard edge. dissolve: the same overlap, blended through a vertical gradient. fade: both
   * edges fade into a flat colour, for a scene or time break.
   */
  kind: z.enum(["gap", "butt", "bleed", "dissolve", "fade"]).default("gap"),
  /** Pixels at the strip's own width: the gap, the overlap depth, or the fade band. Absent = the project gap. */
  size: z.number().int().min(0).max(2000).optional(),
  /** fade only; defaults to the strip background. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});
export type PanelSeam = z.infer<typeof PanelSeam>;

/**
 * How tall a strip panel is, as pacing rather than pixels: a wide establishing beat reads fast, a very tall panel
 * holds the reader on one moment. The ratios are of the strip's width, and the two most common ones are shapes
 * every image provider offers exactly, so the art is generated at the shape it is shown at.
 */
export const StripPanelHeight = z.enum(["short", "normal", "tall", "very-tall"]);
export type StripPanelHeight = z.infer<typeof StripPanelHeight>;
export const STRIP_HEIGHT_RATIOS: Record<StripPanelHeight, number> = {
  short: 0.75,
  normal: 1.5,
  tall: 1.8,
  "very-tall": 3,
};
/** The authoring page height for a strip panel of this pacing, at a given strip width. */
export const stripPageHeight = (width: number, height: StripPanelHeight = "normal") =>
  Math.round(width * STRIP_HEIGHT_RATIOS[height]);

/**
 * Per-account preferences that seed a new project. Every field is optional: absent means "no preference", so the
 * server default still applies and a project created before the preference existed is untouched.
 */
export const UserSettings = z.object({
  /** Kokoro voice id used for new projects' narration. */
  narrationVoice: z.string().trim().max(64).optional(),
});
export type UserSettings = z.infer<typeof UserSettings>;

export const ProjectSettings = z.object({
  format: ProjectFormat.default("comic"),
  pageWidth: z.number().int().min(256).max(8000).default(1600),
  pageHeight: z.number().int().min(256).max(20000).default(2400),
  pageGutter: z.number().min(0).max(0.1).default(0.015),
  pageMargin: z.number().min(0).max(0.2).default(0.03),
  imageQuality: z.enum(["low", "medium", "high"]).default("low"),
  narrationVoice: z.string().default("af_heart"),
  narrationSpeed: z.number().min(0.5).max(2).default(1),
  /** Narration length target; ~21 words is about 6 seconds of Kokoro speech per panel. */
  narrationWordsPerPanel: z.number().int().min(5).max(80).default(21),
  referenceMaxWidth: z.number().int().min(16).max(2048).optional(),
  referenceMaxHeight: z.number().int().min(16).max(2048).optional(),
  webtoonGap: z.number().int().min(0).max(1000).default(40),
  webtoonChunkHeight: z.number().int().min(1000).max(40000).default(12000),
  webtoonWidth: z.number().int().min(320).max(2000).default(800),
  worldNotes: z.string().default(""),
  author: z.string().default(""),
  lettering: LetteringDefaults.optional(),
  /** Hard spending ceiling for AI generation in USD (estimated from recorded usage). Unset = no cap. */
  budgetUsd: z.number().min(0).max(1_000_000).nullable().optional(),
  /**
   * When a panel is blocked by an image provider's content filter, retry it ONCE on another of your own keys and
   * flag the panel for review. Not general failover: only content-policy blocks, and the switch is always visible.
   * Opt-in, and it must name one of your credentials — there are no shared server keys to fall back to.
   */
  contentPolicyFallback: z
    .object({
      enabled: z.boolean().default(false),
      credentialId: z.string().uuid().nullable().default(null),
      provider: z.string().max(40).nullable().default(null),
      model: z.string().max(200).default(""),
    })
    .optional(),
  /** Silence after each narration segment, and after the last segment of a scene or chapter. */
  narrationPauseMs: z.number().int().min(0).max(5000).default(350),
  sceneBreakPauseMs: z.number().int().min(0).max(10000).default(700),
  /** Style instruction for narration writing, kept so every chapter is written in the same voice. */
  narrationStyle: z.string().max(500).default(""),
  /** Opt-in vision check of generated panels (expected cast and headcount). Needs one of your vision-capable keys. */
  consistencyCheck: z
    .object({
      enabled: z.boolean().default(false),
      credentialId: z.string().uuid().nullable().default(null),
      model: z.string().max(200).default(""),
    })
    .optional(),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

export const StyleDefinition = z.object({
  summary: z.string().default(""),
  lineTreatment: z.string().default(""),
  colorPolicy: z.string().default(""),
  shading: z.string().default(""),
  detailLevel: z.string().default(""),
  faceRendering: z.string().default(""),
  backgroundRendering: z.string().default(""),
  motionEffects: z.string().default(""),
  contrast: z.string().default(""),
  screenTones: z.string().default(""),
  lighting: z.string().default(""),
  exclusions: z.array(z.string()).default([]),
});
export type StyleDefinition = z.infer<typeof StyleDefinition>;
