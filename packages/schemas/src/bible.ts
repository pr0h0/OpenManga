import { z } from "zod";

/**
 * The story bible: canon the generation steps must respect. Facts are statements about the story (with an optional
 * chapter range, and a fixed flag for rules that must never be broken); character states are what holds for one
 * character from a point in the story on (an injury, an outfit, what they carry or know).
 */

export const BIBLE_FACT_KINDS = [
  "character",
  "relationship",
  "power",
  "organisation",
  "place",
  "object",
  "term",
  "rule",
] as const;
export const BibleFactKind = z.enum(BIBLE_FACT_KINDS);
export type BibleFactKind = z.infer<typeof BibleFactKind>;

export const CHARACTER_STATE_KINDS = [
  "injury",
  "look",
  "outfit",
  "item",
  "location",
  "rank",
  "knowledge",
  "other",
] as const;
export const CharacterStateKind = z.enum(CHARACTER_STATE_KINDS);
export type CharacterStateKind = z.infer<typeof CharacterStateKind>;

const str = z.string().trim();
const chapterNumber = z.number().int().min(1).max(10_000);

/** A proposed fact: chapters by number, as the model reads them. */
export const ProposedFact = z.object({
  kind: BibleFactKind,
  subject: str.max(200).default(""),
  text: str.min(1).max(1000),
  fromChapter: chapterNumber.nullable().optional(),
  untilChapter: chapterNumber.nullable().optional(),
  fixed: z.boolean().default(false),
  visual: z.boolean().default(false),
});
/** A proposed character state: the character by name, chapters by number. */
export const ProposedState = z.object({
  character: str.min(1).max(200),
  kind: CharacterStateKind,
  text: str.min(1).max(1000),
  fromChapter: chapterNumber.nullable().optional(),
  fromScene: z.number().int().min(1).max(1000).nullable().optional(),
  untilChapter: chapterNumber.nullable().optional(),
  outfit: str.max(200).nullable().optional(),
});

/** What the "Extract bible from story" job proposes. Nothing is saved until the user reviews and applies it. */
export const BibleExtraction = z.object({
  facts: z.array(ProposedFact).max(300).default([]),
  states: z.array(ProposedState).max(300).default([]),
});
export type BibleExtraction = z.infer<typeof BibleExtraction>;

/**
 * What a continuity check of one chapter returns. Places and bible entries are named by the short refs its prompt
 * gives them ("p3.2" for page 3 panel 2, "n5" for narration line 5, "R1" a fixed rule, "F2" a fact, "S4" a state).
 */
export const ContinuityReport = z.object({
  findings: z
    .array(
      z.object({
        severity: z.enum(["high", "medium", "low"]),
        message: str.min(1).max(1000),
        where: str.max(40).default("chapter"),
        quote: str.max(1000).default(""),
        against: str.max(40).nullable().default(null),
        evidence: str.max(1000).default(""),
      }),
    )
    .max(200)
    .default([]),
  rules: z
    .array(
      z.object({
        rule: str.min(1).max(40),
        verdict: z.enum(["pass", "warn", "fail"]),
        note: str.max(1000).default(""),
      }),
    )
    .max(200)
    .default([]),
});
export type ContinuityReport = z.infer<typeof ContinuityReport>;

/**
 * The story timeline: events in story-time order (flashbacks sit where they happen, not where they are told).
 * `day` is a story-day number for elapsed time and ages (any origin, may be negative); `when` is how the story names
 * the moment ("Spring 1203", "the night of the storm"). A birth event gives a character's age at every dated event.
 */
export const TIMELINE_EVENT_KINDS = ["event", "birth"] as const;
export const TimelineEventKind = z.enum(TIMELINE_EVENT_KINDS);
export type TimelineEventKind = z.infer<typeof TimelineEventKind>;

/** A proposed event: characters by name, the chapter (and scene) by number, as the model reads them. */
export const ProposedEvent = z.object({
  kind: TimelineEventKind.catch("event"),
  title: str.min(1).max(200),
  description: str.max(1000).default(""),
  when: str.max(120).default(""),
  day: z.number().min(-10_000_000).max(10_000_000).nullable().optional(),
  chapter: chapterNumber.nullable().optional(),
  scene: z.number().int().min(1).max(1000).nullable().optional(),
  characters: z.array(str.min(1).max(200)).max(30).default([]),
});
export type ProposedEvent = z.infer<typeof ProposedEvent>;

/** What the "Extract timeline from story" job proposes, in story-time order. Nothing is saved until applied. */
export const TimelineExtraction = z.object({ events: z.array(ProposedEvent).max(300).default([]) });
export type TimelineExtraction = z.infer<typeof TimelineExtraction>;
