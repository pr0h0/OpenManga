import { ProjectConcept, ProjectPremise, StoryOutline, YoutubePackage } from "@openmanga/schemas";
import type { z } from "zod";
import { DATA_RULE, defineTextTemplate, schemaInstructions, templateHeader, untrusted } from "./text-templates.ts";

/**
 * Expert output actions: one structured extraction per action, from one expert reply. Each turns what the expert
 * wrote into a validated object the user reviews before anything is applied; none of them invents beyond the reply.
 */

export type ExpertExtractInput = {
  /** The expert's reply to extract from. */
  reply: string;
  /** What the user asked, for context: the reply answers it. */
  question: string;
  /** The project the chat is about, when there is one (its summary). */
  project: Record<string, unknown> | null;
};

const SHARED = [
  "You turn one reply from a story consultant into structured data for a comic and manhwa production app. The reply is in <expert_reply>; the question it answered is in <user_question>.",
  "Work from the reply. Keep its ideas, names and wording where they fit; fill a field from the reply's own material, and only where the reply says nothing write the least you need, consistent with it. When the reply offers several options, take the one it recommends, or else the first.",
  "Write in the language of the reply, or in project_data.language when project_data is given.",
];

function extractor<I extends ExpertExtractInput>(
  name: string,
  description: string,
  task: string,
  schemaName: string,
  schema: z.ZodType,
) {
  return defineTextTemplate<I>({
    name,
    version: 1,
    description,
    system: [templateHeader(name, 1), ...SHARED, task, DATA_RULE, schemaInstructions(schemaName, schema)].join("\n\n"),
    build(i) {
      return [
        { role: "system", content: this.system },
        {
          role: "user",
          content: [
            i.project ? untrusted("project_data", JSON.stringify(i.project)) : "",
            untrusted("user_question", i.question || "(none)"),
            untrusted("expert_reply", i.reply),
          ]
            .filter(Boolean)
            .join("\n\n"),
        },
      ];
    },
  });
}

export const expertConceptV1 = extractor(
  "expert-concept",
  "A new project's title, premise, type, format and story idea, from a concept in an expert's reply.",
  "TASK: the user is starting a NEW project from the concept in the reply. Give it a title, a one-sentence logline, a premise paragraph (setting, main characters, central conflict and stakes, no ending), the project type and format the reply suggests (manhwa and comic when it suggests none; film when it is meant as a narrated video), and storyIdea: the concept written out as a story idea with everything the reply gives about plot, characters and world.",
  "ProjectConcept",
  ProjectConcept,
);

export const expertPremiseV1 = extractor(
  "expert-premise",
  "A replacement logline and premise for the project, from an expert's reply.",
  "TASK: the reply proposes a premise or logline for the project in project_data. Return it as a one-sentence logline and a premise paragraph (setting, main characters, central conflict and stakes, no ending). It replaces the project's description.",
  "ProjectPremise",
  ProjectPremise,
);

export const expertOutlineV1 = extractor(
  "expert-outline",
  "A chapter-by-chapter outline, from an expert's reply.",
  "TASK: the reply contains an outline (arcs, acts, episodes or chapters). Return it as chapters in story order, each with a title and a summary of what happens in it. Split acts or arcs into chapters only where the reply does; keep every event the reply lists. It is saved as a new outline revision of the project's story.",
  "StoryOutline",
  StoryOutline,
);

export const expertYoutubeV1 = extractor(
  "expert-youtube",
  "YouTube publishing text (titles, description, tags, pinned comment, thumbnail headlines), from an expert's reply.",
  "TASK: the reply proposes publishing copy for the project's video. Return its title options (strongest first), the description (no timestamps, links or hashtags: the app adds chapter timestamps), tags (specific first), the pinned comment and thumbnail headlines (two to five words each). Leave a list empty when the reply has nothing for it, except titles and description, which you write from the reply when it gives none.",
  "YoutubePackage",
  YoutubePackage,
);

/** The actions offered on an expert's reply: what each extracts, and whether the chat must be about a project. */
export const EXPERT_ACTIONS = {
  concept: { template: expertConceptV1, schema: ProjectConcept, schemaName: "ProjectConcept", needsProject: false },
  premise: { template: expertPremiseV1, schema: ProjectPremise, schemaName: "ProjectPremise", needsProject: true },
  outline: { template: expertOutlineV1, schema: StoryOutline, schemaName: "StoryOutline", needsProject: true },
  youtube: { template: expertYoutubeV1, schema: YoutubePackage, schemaName: "YoutubePackage", needsProject: true },
} as const;
export type ExpertAction = keyof typeof EXPERT_ACTIONS;
export const EXPERT_ACTION_KINDS = Object.keys(EXPERT_ACTIONS) as [ExpertAction, ...ExpertAction[]];
