import { and, asc, chapters, characters, eq, isNull, projects } from "@openmanga/db";
import { EXPERT_ACTIONS, type ExpertAction } from "@openmanga/prompts";
import type { z } from "zod";
import type { WorkerDeps } from "../context.ts";
import { type GenerationJob, InputError } from "../lib/runner.ts";
import { structured } from "./text.ts";

/** What the extraction is told about the project the chat is about: enough to fit the result to it. */
async function projectContext(deps: WorkerDeps, projectId: string) {
  const [p] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) throw new InputError("The project no longer exists");
  const chs = await deps.db
    .select({ order: chapters.order, title: chapters.title, summary: chapters.summary })
    .from(chapters)
    .where(eq(chapters.projectId, p.id))
    .orderBy(asc(chapters.order))
    .limit(60);
  const cast = await deps.db
    .select({ name: characters.name, role: characters.role })
    .from(characters)
    .where(and(eq(characters.projectId, p.id), isNull(characters.deletedAt)))
    .limit(30);
  return {
    title: p.title,
    description: p.description.slice(0, 1500),
    type: p.projectType,
    format: p.settings.format,
    language: p.language,
    chapters: chs.map((c) => ({ ...c, summary: c.summary.slice(0, 300) })),
    cast,
  };
}

/**
 * Turns an expert's reply into the object one of its actions applies (a project concept, a premise, an outline or
 * YouTube text). The reply was copied onto the job when it was queued, so a later retry of the reply does not
 * change what this job extracts. Nothing is applied here: the result waits for the user to review it.
 */
export async function expertExtract(deps: WorkerDeps, job: GenerationJob) {
  const action = String(job.input.action) as ExpertAction;
  const spec = EXPERT_ACTIONS[action];
  if (!spec) throw new InputError(`Unknown expert action: ${action}`);
  if (spec.needsProject && !job.projectId) throw new InputError("This action needs a chat about a project");
  const messages = spec.template.build({
    reply: String(job.input.reply ?? ""),
    question: String(job.input.question ?? ""),
    project: job.projectId ? await projectContext(deps, job.projectId) : null,
  });
  const r = await structured(deps, job, messages, spec.schema as z.ZodType, spec.schemaName, 16_000);
  return { action, data: r.data as Record<string, unknown>, repaired: r.repaired };
}
