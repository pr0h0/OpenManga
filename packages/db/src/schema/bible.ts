import type { BibleFactKind, CharacterStateKind } from "@openmanga/schemas";
import { boolean, index, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { createdAt, id, ts, updatedAt } from "./common.ts";
import { chapters, characterOutfits, characters, projects } from "./projects.ts";

/** Who wrote an entry: a person, the "Extract bible" job (after review), or an explained continuity finding. */
export type BibleSource = "user" | "extracted" | "continuity";

/**
 * A fact of the story bible. The chapter range is by chapter (inclusive at both ends; null = from the start / to the
 * end), resolved to the chapters' current order when used, so reordering chapters moves the range with them.
 * `fixed` marks a rule that must hold; `visual` says it can be seen, which is what lets it reach image prompts.
 */
export const bibleFacts = pgTable(
  "bible_facts",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    kind: text("kind").$type<BibleFactKind>().notNull(),
    /** Who or what it is about, by name ("Jin", "Jin and Hana", "the Guild"); empty for the whole story. */
    subject: text("subject").notNull().default(""),
    text: text("text").notNull(),
    fixed: boolean("fixed").notNull().default(false),
    visual: boolean("visual").notNull().default(false),
    fromChapterId: uuid("from_chapter_id").references(() => chapters.id, { onDelete: "set null" }),
    untilChapterId: uuid("until_chapter_id").references(() => chapters.id, { onDelete: "set null" }),
    source: text("source").$type<BibleSource>().notNull().default("user"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("bible_facts_project_idx").on(t.projectId)],
);

/**
 * One entry of a character's state timeline: holds from a chapter (and optionally a scene of it, by scene number) on.
 * A later entry of a single-valued kind (look, outfit, location, rank) replaces the earlier one; the others hold
 * until `untilChapterId` (inclusive) or the end. An outfit entry can name one of the character's outfits.
 */
export const characterStates = pgTable(
  "character_states",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    characterId: uuid("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    kind: text("kind").$type<CharacterStateKind>().notNull(),
    text: text("text").notNull(),
    /** Null: from the start of the story. */
    chapterId: uuid("chapter_id").references(() => chapters.id, { onDelete: "set null" }),
    /** Scene number within the chapter (1-based); null for the start of the chapter. */
    sceneNumber: integer("scene_number"),
    untilChapterId: uuid("until_chapter_id").references(() => chapters.id, { onDelete: "set null" }),
    outfitId: uuid("outfit_id").references(() => characterOutfits.id, { onDelete: "set null" }),
    source: text("source").$type<BibleSource>().notNull().default("user"),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("character_states_project_idx").on(t.projectId),
    index("character_states_character_idx").on(t.characterId),
  ],
);

export type FindingSeverity = "high" | "medium" | "low";
export type FindingStatus = "open" | "fixed" | "ignored" | "explained";
/** Where a contradiction is: the panel or narration line it names, else the scene or the whole chapter. */
export type FindingPlace = {
  /** The ref the check used ("p3.2", "n5", "scene 2", "chapter"), as a person can read it. */
  ref: string;
  panelId?: string | null;
  pageId?: string | null;
  narrationLineId?: string | null;
  sceneNumber?: number | null;
};

/**
 * A contradiction a continuity check found in a chapter, between its plan, scenes, narration or panels and the story
 * bible or a neighbouring chapter. A new check of the chapter replaces its open findings; fixed, ignored and explained
 * ones stay as a record, and one ignored or explained is not raised again.
 */
export const continuityFindings = pgTable(
  "continuity_findings",
  {
    id: id(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    chapterId: uuid("chapter_id")
      .notNull()
      .references(() => chapters.id, { onDelete: "cascade" }),
    /** The continuity_check job that found it. */
    jobId: uuid("job_id"),
    severity: text("severity").$type<FindingSeverity>().notNull(),
    message: text("message").notNull(),
    /** The offending line, beat or caption, quoted. */
    quote: text("quote").notNull().default(""),
    /** What it contradicts: the bible entry or the neighbouring chapter's text. */
    evidence: text("evidence").notNull().default(""),
    place: jsonb("place").$type<FindingPlace>().notNull(),
    /** The bible fact it breaks, when it is one. */
    factId: uuid("fact_id").references(() => bibleFacts.id, { onDelete: "set null" }),
    status: text("status").$type<FindingStatus>().notNull().default("open"),
    /** Why it was ignored, or what explained it. */
    resolution: text("resolution").notNull().default(""),
    resolvedByUserId: uuid("resolved_by_user_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("continuity_findings_project_idx").on(t.projectId, t.status),
    index("continuity_findings_chapter_idx").on(t.chapterId),
  ],
);
