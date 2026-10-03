import type { BibleFactKind, CharacterStateKind } from "@openmanga/schemas";
import { boolean, index, integer, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { users } from "./auth.ts";
import { createdAt, id, updatedAt } from "./common.ts";
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
