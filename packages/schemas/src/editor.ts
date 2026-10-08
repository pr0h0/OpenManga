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

/**
 * A panel's place on the page, in fractions of it. `points` (optional) gives the panel a polygon outline instead of
 * the box: each point in fractions of the box itself (0,0 its top-left, 1,1 its bottom-right), in drawing order. The
 * box always bounds the outline, so moving or resizing the box carries the shape with it. No points: a rectangle.
 */
export const FramePoint = z.object({ x: unit, y: unit });
export type FramePoint = z.infer<typeof FramePoint>;
/**
 * A decorative edge: how a page's outline or a panel's border is drawn. `straight` is the plain line; the others
 * eat into the shape by up to `size` (0–1) of their own depth, deterministically (the same panel always looks the
 * same): `wavy` a regular wave, `torn` a ripped paper edge, `rough` a hand-cut one, `brush` an ink stroke of
 * varying weight, `burnt` a scorched edge darkening inwards.
 */
export const EDGE_STYLES = ["straight", "wavy", "torn", "rough", "brush", "burnt"] as const;
export const EdgeStyle = z.object({
  style: z.enum(EDGE_STYLES).default("straight"),
  size: z.number().min(0).max(1).default(0.5),
});
export type EdgeStyle = z.infer<typeof EdgeStyle>;

export const Frame = z.object({
  x: unit,
  y: unit,
  width: z.number().gt(0).max(1),
  height: z.number().gt(0).max(1),
  points: z.array(FramePoint).min(3).max(24).optional(),
  /** This panel's border style, in place of the project's default for panels. */
  edge: EdgeStyle.optional(),
});
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
 * A strip letters itself by default. Auto-placement is off everywhere else because a comic page is composed
 * around its balloons and a planner guess lands badly on a multi-panel layout — but a strip panel is one
 * full-width frame, so there is only one place a balloon can go, and a webtoon read without its speech is not
 * the format. Owners can still turn it off in settings; this only chooses what a new strip starts with.
 */
export const VERTICAL_LETTERING = { autoPlace: true } as const;

/**
 * One piece of a repurposing plan, reviewed before it is rendered: a Short, the trailer or the teaser (picked panels,
 * a length and a frame), an Instagram carousel (picked panels as 1:1 or 4:5 images), or a quote image (one panel and a
 * line of its narration or dialogue). `title` and `caption` are its social copy, written by a text job or by hand.
 */
/** Captions drawn into a Shorts cut from its narration: off, a clean line at the bottom, large words in the centre, or two lines. */
export const ShortsCaptions = z.enum(["off", "bottom", "center", "two_line"]);
export type ShortsCaptions = z.infer<typeof ShortsCaptions>;

export const RepurposeItem = z.object({
  id: z.string().trim().min(1).max(40),
  kind: z.enum(["short", "trailer", "teaser", "carousel", "quote"]),
  label: z.string().max(80).default(""),
  panelIds: z.array(z.string().uuid()).max(100).default([]),
  /** Video kinds: the cut's length in seconds. */
  lengthSeconds: z.number().int().min(15).max(600).optional(),
  /** Video kinds: 16:9, 9:16 or 1:1; images: 1:1 or 4:5. */
  aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional(),
  /** Video kinds: captions drawn into the picture. */
  captions: ShortsCaptions.optional(),
  /** Quote images: the line on the image (its panel is `panelIds[0]`). */
  text: z.string().max(300).default(""),
  title: z.string().max(150).default(""),
  caption: z.string().max(2200).default(""),
  /** Video kinds: an opening line the narrator says before the first shot ("" for none). */
  hook: z.string().max(200).default(""),
});
export type RepurposeItem = z.infer<typeof RepurposeItem>;

/** A logo over every frame of a video: an uploaded image of the project, in a corner. */
export const VideoWatermark = z.object({
  assetId: z.string().uuid(),
  corner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"]).default("bottom-right"),
  opacity: z.number().min(0.05).max(1).default(0.8),
  /** Logo width as a share of the frame width. */
  size: z.number().min(0.03).max(0.4).default(0.12),
});
export type VideoWatermark = z.infer<typeof VideoWatermark>;

/** A title card before or after a video, composited from the project's art and lettering font. */
export const VideoCard = z.object({
  title: z.string().max(120).default(""),
  subtitle: z.string().max(200).default(""),
  durationMs: z.number().int().min(1000).max(15_000).default(3000),
});
export type VideoCard = z.infer<typeof VideoCard>;

/**
 * A panel's settings as a video shot (panel cut). "auto" motion is the push or pull chosen by shot type, varied so
 * neighbouring shots do not repeat the same move. `fade` overrides the project's fade to black at a scene break
 * for the cut into this shot: "on" fades here even inside a scene, "off" keeps a hard cut. A disabled shot is
 * left out of the video with its narration; the panel stays on the page.
 */
export const ShotMotion = z.enum([
  "auto",
  "static",
  "pan-left",
  "pan-right",
  "pan-up",
  "pan-down",
  "push-in",
  "pull-out",
]);
export type ShotMotion = z.infer<typeof ShotMotion>;
export const ShotVideo = z.object({
  motion: ShotMotion.default("auto"),
  fade: z.enum(["auto", "on", "off"]).default("auto"),
  disabled: z.boolean().default(false),
  /**
   * This shot's own minimum hold in ms, in place of the export's: a short beat held longer, or a padded one held less
   * (never below its narration). Null = the export's minimum. Set by the timing pass's rebalance or by hand.
   */
  holdMs: z.number().int().min(500).max(60_000).nullable().default(null),
});
export type ShotVideo = z.infer<typeof ShotVideo>;

/**
 * A rough sketch, stick-figure pose or composition thumbnail for one panel. It goes with the panel's generation
 * as a reference image for layout only: the prompt tells the model to take its composition, framing and poses and
 * to ignore its drawing style. `strict` follows it closely; `loose` lets the panel description win where they differ.
 */
export const PanelGuide = z.object({
  assetId: z.string().uuid(),
  strength: z.enum(["loose", "strict"]).default("loose"),
  /** The pose in words, typed or from Describe pose: sent with the sketch, so a model that skims the image still gets it. */
  pose: z.string().trim().max(800).default(""),
});
export type PanelGuide = z.infer<typeof PanelGuide>;

/**
 * A narration line's place in the video. `untilPanelId` stretches the line over every shot from its own to that
 * panel's (they share one hold, split evenly); the offsets add silence before and after the line.
 */
export const NarrationLineVideo = z.object({
  untilPanelId: z.string().uuid().nullable().default(null),
  startOffsetMs: z.number().int().min(0).max(10_000).default(0),
  endOffsetMs: z.number().int().min(0).max(10_000).default(0),
});
export type NarrationLineVideo = z.infer<typeof NarrationLineVideo>;

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
/**
 * How much room an authored seam takes, as a fraction of the shorter of the two panels it joins — so spacing
 * scales with the art rather than being one number for the whole chapter. A project-wide gutter made every seam
 * in a strip identical, which reads as a fixed rhythm no matter how the panels are paced.
 *
 * Only an explicitly authored seam uses these. A block with no seam keeps the project gutter, which is what a
 * comic or film webtoon export stacks with, so those are unaffected.
 */
export const STRIP_SEAM_RATIOS = {
  /** Background between two panels: a beat change. */
  gap: 0.08,
  /** The flat band a scene break fades through; painted three times this tall, across both faded edges. */
  fade: 0.1,
  /** How far a bleed or dissolve overlaps its neighbour. */
  overlap: 0.15,
} as const;

/** The authoring page height for a strip panel of this pacing, at a given strip width. */
export const stripPageHeight = (width: number, height: StripPanelHeight = "normal") =>
  Math.round(width * STRIP_HEIGHT_RATIOS[height]);

/** A project's setup saved for reuse: its type, format, style and settings, never its story, cast or files. */
export const ProjectTemplate = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  projectType: z.string().max(40),
  format: z.enum(["comic", "film", "vertical"]),
  colorMode: z.string().max(40),
  language: z.string().max(16),
  readingDirection: z.string().max(16).optional(),
  stylePresetKey: z.string().max(64).nullable().optional(),
  customStyle: z.string().max(4000).default(""),
  settings: z.record(z.string(), z.unknown()).default({}),
  createdAt: z.string(),
});
export type ProjectTemplate = z.infer<typeof ProjectTemplate>;

/**
 * How the narrator says a name or term ("Qi" → "chee"). Applied only to the text sent to speech synthesis; what is
 * shown (narration, subtitles, lettering) keeps the written form.
 */
export const PronunciationEntry = z.object({
  term: z.string().trim().min(1).max(100),
  spoken: z.string().trim().min(1).max(200),
  caseSensitive: z.boolean().default(false),
  /** Match only the whole word ("Qi" but not "Qing"). */
  wholeWord: z.boolean().default(true),
});
export type PronunciationEntry = z.infer<typeof PronunciationEntry>;

/** What the panel check can look at. Headcount and stray text are counted; covered faces is measured against the lettering. */
export const VISUAL_CHECKS = [
  "headcount",
  "identity",
  "outfit",
  "props",
  "location",
  "expression",
  "pose",
  "framing",
  "anatomy",
  "text",
  "style",
  "palette",
  "covered_faces",
] as const;
export const VisualCheck = z.enum(VISUAL_CHECKS);
export type VisualCheck = z.infer<typeof VisualCheck>;
export const VisualCheckMode = z.enum(["off", "flag", "regenerate_once", "regenerate_budget"]);
export type VisualCheckMode = z.infer<typeof VisualCheckMode>;
/** The checks a project has unless it says otherwise: what the check always reported, plus identity and outfit. */
export const VISUAL_CHECK_DEFAULTS: Record<VisualCheck, VisualCheckMode> = {
  headcount: "flag",
  identity: "flag",
  outfit: "flag",
  props: "off",
  location: "off",
  expression: "off",
  pose: "off",
  framing: "off",
  anatomy: "off",
  text: "flag",
  style: "off",
  palette: "off",
  covered_faces: "flag",
};

export const ProjectSettings = z.object({
  format: ProjectFormat.default("comic"),
  pageWidth: z.number().int().min(256).max(8000).default(1600),
  pageHeight: z.number().int().min(256).max(20000).default(2400),
  pageGutter: z.number().min(0).max(0.1).default(0.015),
  pageMargin: z.number().min(0).max(0.2).default(0.03),
  imageQuality: z.enum(["low", "medium", "high"]).default("low"),
  /** Which references bulk runs draw: everything, or only the main cast and places used in more than one panel. */
  referencePolicy: z.enum(["all", "main"]).default("all"),
  /**
   * How a production run spends: everything now; images through half-price provider batches (up to 24 h) with text
   * now; text in batches with images now; or everything in batches. Only keys whose provider has a batch API are
   * batched, so a DeepSeek text key runs now whatever this says.
   */
  batchPolicy: z.enum(["interactive", "images", "hybrid", "cheapest"]).default("interactive"),
  narrationVoice: z.string().default("af_heart"),
  narrationSpeed: z.number().min(0.5).max(2).default(1),
  /** Narration length target; ~21 words is about 6 seconds of Kokoro speech per panel. */
  narrationWordsPerPanel: z.number().int().min(5).max(80).default(21),
  /**
   * A target video length. When set, chapter plans default to a page count and narration to a words-per-panel that
   * land each chapter on its share of it (by source length), and the Exports page suggests minShotSeconds as the
   * minimum hold.
   */
  targetRuntime: z
    .object({
      minutes: z.number().min(1).max(600),
      wordsPerMinute: z.number().int().min(80).max(260).default(150),
      minShotSeconds: z.number().min(1).max(30).default(4),
      maxShotSeconds: z.number().min(2).max(60).default(8),
    })
    .nullable()
    .optional(),
  referenceMaxWidth: z.number().int().min(16).max(2048).optional(),
  referenceMaxHeight: z.number().int().min(16).max(2048).optional(),
  webtoonGap: z.number().int().min(0).max(1000).default(40),
  webtoonChunkHeight: z.number().int().min(1000).max(40000).default(12000),
  webtoonWidth: z.number().int().min(320).max(2000).default(800),
  worldNotes: z.string().default(""),
  author: z.string().default(""),
  /** Publishing text for the video (titles, description, tags…): written by a text job, then edited freely. */
  youtubePackage: z
    .object({
      titles: z.array(z.string().max(100)).max(8).default([]),
      description: z.string().max(4500).default(""),
      tags: z.array(z.string().max(60)).max(30).default([]),
      pinnedComment: z.string().max(2000).default(""),
      thumbnailHeadlines: z.array(z.string().max(60)).max(8).default([]),
    })
    .optional(),
  /**
   * What the YouTube text and the thumbnail headline were made from, so staleness can tell when that changed: the
   * project title and chapter list when the YouTube text was written (`youtubeText`, with `youtubeTextAt`), and the
   * project title when the headline was set (`thumbnailTitle`). Written by the app, not by settings forms.
   */
  publishingSources: z
    .object({
      youtubeText: z.string().optional(),
      youtubeTextAt: z.string().optional(),
      thumbnailTitle: z.string().optional(),
    })
    .optional(),
  /** The YouTube thumbnail: text-free 16:9 art, with the headline composited by the app whenever it is rendered. */
  thumbnail: z
    .object({
      assetId: z.string().uuid(),
      title: z.string().max(120).default(""),
      subtitle: z.string().max(120).default(""),
      side: z.enum(["left", "right"]).default("left"),
    })
    .optional(),
  /** How the next thumbnail is laid out: the side its headline sits on, which the art keeps clear. */
  thumbnailStyle: z.object({ side: z.enum(["left", "right"]).default("left") }).optional(),
  /**
   * The channel's rules for the YouTube package text job, sent to the model as the owner's own instructions: how
   * titles are written, a description template whose {placeholders} it fills, and tags every package carries.
   */
  youtubeRules: z
    .object({
      titleRules: z.string().max(1000).default(""),
      descriptionTemplate: z.string().max(4000).default(""),
      tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
    })
    .optional(),
  /** The channel profile these settings were copied from. A record only: the profile is not linked live. */
  channelProfile: z
    .object({ id: z.string().uuid(), name: z.string().max(80), appliedAt: z.string() })
    .nullable()
    .optional(),
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
  /** Pronunciation dictionary for every narration voice; a template or channel profile copies it like any setting. */
  pronunciation: z.array(PronunciationEntry).max(500).default([]),
  /**
   * Video exports, applied to every render and shown in the preview: fade to black where the scene changes (each
   * shot can override it), a logo watermark, and intro and outro cards.
   */
  video: z
    .object({
      fadeAtSceneBreaks: z.boolean().default(false),
      watermark: VideoWatermark.nullable().optional(),
      intro: VideoCard.nullable().optional(),
      outro: VideoCard.nullable().optional(),
      /** What a video export renders at when its request does not say: frame shape, and the short side in pixels. */
      output: z
        .object({
          aspect: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
          height: z.union([z.literal(720), z.literal(1080), z.literal(1440)]).default(1080),
        })
        .optional(),
    })
    .optional(),
  /**
   * Decorative edges: `page` for every page's outline (cut out over the blurred backdrop in videos, drawn on paper
   * elsewhere), `panels` the default border of every panel (a panel's own `frame.edge` wins).
   */
  edges: z.object({ page: EdgeStyle.optional(), panels: EdgeStyle.optional() }).optional(),
  /** The repurposing plan: Shorts, trailer, teaser, carousel and quote images, reviewed before rendering. */
  repurpose: z.object({ items: z.array(RepurposeItem).max(40).default([]) }).optional(),
  /**
   * Opt-in vision check of generated panels. Needs one of your vision-capable keys. `checks` sets each aspect to
   * off, flag only, regenerate once, or regenerate until it passes while the project's automatic re-rolls stay under
   * `autoFixBudgetUsd`; aspects left out take their default (VISUAL_CHECK_DEFAULTS).
   */
  consistencyCheck: z
    .object({
      enabled: z.boolean().default(false),
      credentialId: z.string().uuid().nullable().default(null),
      model: z.string().max(200).default(""),
      checks: z.partialRecord(VisualCheck, VisualCheckMode).default({}),
      autoFixBudgetUsd: z.number().min(0).max(10_000).default(2),
    })
    .optional(),
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/**
 * The project settings a channel profile carries: the channel's identity (voice, look, branding, publishing rules,
 * output), not one project's outputs. Applying a profile copies each key it sets; keys it leaves out stay as the
 * project has them, and `video` and `lettering` are merged one level deep.
 */
export const PROFILE_SETTING_KEYS = [
  "imageQuality",
  "referencePolicy",
  "batchPolicy",
  "targetRuntime",
  "narrationVoice",
  "narrationSpeed",
  "pronunciation",
  "lettering",
  "video",
  "thumbnailStyle",
  "youtubeRules",
] as const;
export type ProfileSettingKey = (typeof PROFILE_SETTING_KEYS)[number];
export const ChannelProfileSettings = asPatch(
  ProjectSettings.pick(
    Object.fromEntries(PROFILE_SETTING_KEYS.map((k) => [k, true])) as { [K in ProfileSettingKey]: true },
  ),
);
export type ChannelProfileSettings = z.infer<typeof ChannelProfileSettings>;

/**
 * A publication identity, one level above a template: what every project of one channel shares. `preset` is the
 * project setup a new project starts from (a production preset key or "template:<id>"). The logo in
 * `settings.video.watermark` is the profile's own: an image of its owner's that belongs to no project, copied into
 * each project the profile is applied to.
 */
export const ChannelProfile = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).default(""),
  preset: z.string().max(80).nullable().default(null),
  settings: ChannelProfileSettings.default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ChannelProfile = z.infer<typeof ChannelProfile>;

/**
 * Per-account preferences that seed a new project. Every field is optional: absent means "no preference", so the
 * server default still applies and a project created before the preference existed is untouched.
 */
export const UserSettings = z.object({
  /** Kokoro voice id used for new projects' narration. */
  narrationVoice: z.string().trim().max(64).optional(),
  projectTemplates: z.array(ProjectTemplate).max(50).optional(),
  channelProfiles: z.array(ChannelProfile).max(50).optional(),
});
export type UserSettings = z.infer<typeof UserSettings>;

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
  /** Live-action photography rather than drawn art: prompts drop their comic/illustration wording. */
  photoreal: z.boolean().optional(),
});
export type StyleDefinition = z.infer<typeof StyleDefinition>;
