import { z } from "zod";
import { ProjectFormat } from "./editor.ts";

/**
 * What an expert's reply is turned into before anything is applied: an extraction job returns one of these, the user
 * reviews (and can edit) it, and only then do the normal routes create or change anything.
 */

const str = z.string().trim();

/** The project types a project can be created with (the create route's own list). */
export const ConceptProjectType = z.enum(["manga", "manhwa", "webtoon", "comic", "illustrated_story"]);

/** A new project drawn from a concept in the reply. */
export const ProjectConcept = z.object({
  title: str.min(1).max(200),
  logline: str.min(1).max(300),
  premise: str.min(1).max(4000),
  projectType: ConceptProjectType.default("manhwa"),
  format: ProjectFormat.default("comic"),
  /** The concept written out as a story idea: the new project's first story revision. */
  storyIdea: str.min(1).max(20_000),
});
export type ProjectConcept = z.infer<typeof ProjectConcept>;

/** A replacement premise for the project: what its description says the story is. */
export const ProjectPremise = z.object({
  logline: str.min(1).max(300),
  premise: str.min(1).max(4000),
});
export type ProjectPremise = z.infer<typeof ProjectPremise>;

/** An outline in the reply, chapter by chapter: saved as a new story revision of kind "outline". */
export const StoryOutline = z.object({
  title: str.max(200).optional().default(""),
  chapters: z
    .array(z.object({ title: str.min(1).max(200), summary: str.min(1).max(4000) }))
    .min(1)
    .max(100),
});
export type StoryOutline = z.infer<typeof StoryOutline>;

/** The project description a concept or premise becomes: the logline, then the premise. */
export const premiseDescription = (p: { logline: string; premise: string }) =>
  `${p.logline.trim()}\n\n${p.premise.trim()}`.slice(0, 5000);

/** The story revision text an outline becomes. */
export const outlineText = (o: StoryOutline) =>
  o.chapters.map((c, i) => `Chapter ${i + 1}: ${c.title}\n${c.summary}`).join("\n\n");
