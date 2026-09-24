import { z } from "zod";
import { Bubble, Frame, ImageTransform, ProjectSettings, SfxStyle, StyleDefinition } from "./editor.ts";
import { PanelSpec } from "./planning.ts";
import { CharacterBible, LocationDescription, PropDescription } from "./story.ts";

/** Stable project interchange format. Assets are referenced by manifest id, never by DB row. */
const AssetRef = z.string().describe("manifest asset id (key of assets map)");

export const InterchangeAsset = z.object({
  path: z.string(),
  type: z.string(),
  mimeType: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  sha256: z.string(),
  /** Approval state of the asset row (draft/approved/locked/superseded); packages written before this default to draft. */
  status: z.string().default("draft"),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

const Version = <T extends z.ZodTypeAny>(desc: T) =>
  z.object({
    ref: z.string(),
    versionNumber: z.number().int(),
    status: z.string(),
    description: desc,
    immutableTraits: z.array(z.string()).default([]),
    references: z
      .array(
        z.object({
          kind: z.string(),
          asset: AssetRef,
          isPrimary: z.boolean(),
          status: z.string(),
          /** Outfit ref this reference was shot for; the planner's outfit match joins on it. Characters only. */
          outfit: z.string().nullable().default(null),
        }),
      )
      .default([]),
  });

export const ProjectInterchange = z.object({
  schemaVersion: z.literal(1),
  exportedAt: z.string(),
  project: z.object({
    title: z.string(),
    description: z.string(),
    projectType: z.string(),
    language: z.string(),
    readingDirection: z.string(),
    colorMode: z.string(),
    settings: ProjectSettings,
    cover: AssetRef.nullable().default(null),
  }),
  style: z
    .object({
      presetKey: z.string().nullable(),
      customDescription: z.string(),
      definition: StyleDefinition,
      references: z.array(AssetRef),
    })
    .nullable(),
  storyRevisions: z.array(
    z.object({
      revisionNumber: z.number(),
      source: z.string(),
      inputKind: z.string(),
      title: z.string(),
      content: z.string(),
      createdAt: z.string(),
      /** Set when the revision is locked; a locked revision must come back locked (immutability invariant). */
      lockedAt: z.string().nullable().default(null),
    }),
  ),
  characters: z.array(
    z.object({
      ref: z.string(),
      name: z.string(),
      role: z.string(),
      aliases: z.array(z.string()),
      outfits: z.array(
        z.object({
          // Optional so packages written before outfits had refs still import; their outfit references stay unlinked.
          ref: z.string().optional(),
          name: z.string(),
          description: z.string(),
          isDefault: z.boolean(),
          characterVersion: z.string().nullable().default(null),
        }),
      ),
      currentVersion: z.string().nullable(),
      versions: z.array(Version(CharacterBible)),
    }),
  ),
  locations: z.array(
    z.object({
      ref: z.string(),
      name: z.string(),
      currentVersion: z.string().nullable(),
      versions: z.array(Version(LocationDescription)),
    }),
  ),
  props: z.array(
    z.object({
      ref: z.string(),
      name: z.string(),
      currentVersion: z.string().nullable(),
      versions: z.array(Version(PropDescription)),
    }),
  ),
  chapters: z.array(
    z.object({
      ref: z.string(),
      order: z.number(),
      title: z.string(),
      summary: z.string(),
      memory: z.record(z.string(), z.unknown()),
      scenes: z.array(
        z.object({
          ref: z.string(),
          order: z.number(),
          title: z.string(),
          summary: z.string(),
          location: z.string().nullable(),
          details: z.record(z.string(), z.unknown()),
          beats: z.array(z.string()),
        }),
      ),
      pages: z.array(
        z.object({
          ref: z.string(),
          order: z.number(),
          scene: z.string().nullable(),
          layoutTemplate: z.string().nullable(),
          // Same bounds the API enforces on a page: an imported 500000x500000 page would OOM every later render.
          width: z.number().int().min(256).max(8000),
          height: z.number().int().min(256).max(20000),
          purpose: z.string(),
          status: z.string().default("draft"),
          /** Per-page override of the project's direction; it decides bubble order, so a null is not the same as "ltr". */
          readingDirection: z.string().nullable().default(null),
          panels: z.array(
            z.object({
              ref: z.string(),
              order: z.number(),
              frame: Frame,
              imageTransform: ImageTransform,
              shotType: z.string(),
              cameraAngle: z.string().nullable(),
              storyBeat: z.string(),
              location: z.string().nullable(),
              characters: z.array(z.string()),
              /** Prop version refs pinned on the panel; a live generation input, and what the spec's propIds mean. */
              props: z.array(z.string()).default([]),
              approvalStatus: z.string().default("draft"),
              spec: PanelSpec.nullable(),
              promptOverride: z.string().nullable(),
              artwork: AssetRef.nullable(),
              artworkHistory: z.array(AssetRef),
              dialogue: z.array(z.object({ speaker: z.string().nullable(), text: z.string(), bubble: Bubble })),
              sfx: z.array(z.object({ text: z.string(), style: SfxStyle })),
              /** Outfit changes set on this panel: from here on, or this panel only. */
              outfits: z
                .array(z.object({ character: z.string(), outfit: z.string(), scope: z.enum(["onward", "panel"]) }))
                .default([]),
            }),
          ),
        }),
      ),
      narration: z.array(
        z.object({
          language: z.string().optional(),
          text: z.string(),
          panel: z.string().nullable(),
          showOnPage: z.boolean(),
          box: Bubble.nullable(),
          segments: z.array(
            z.object({
              text: z.string(),
              voice: z.string().nullable(),
              speed: z.number().nullable(),
              /** Silence appended after the segment; it changes exported audio and video length. */
              pauseAfterMs: z.number().int().min(0).max(10_000).default(350),
              audio: AssetRef.nullable(),
            }),
          ),
        }),
      ),
    }),
  ),
  assets: z.record(z.string(), InterchangeAsset),
});
export type ProjectInterchange = z.infer<typeof ProjectInterchange>;
