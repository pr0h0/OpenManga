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
