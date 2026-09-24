import {
  audioJobs,
  chapters,
  characterOutfits,
  characters,
  eq,
  expertChats,
  exportJobs,
  generationJobs,
  narrationLines,
  narrationSegments,
  pages,
  panels,
  projectStyles,
  referenceAssets,
  scenes,
  storyAnalyses,
  storyRevisions,
} from "@openmanga/db";
import { z } from "zod";
import type { Classification, Sensitivity, ToolContext } from "../registry.ts";
import { toolError } from "../runtime.ts";

export const Uuid = z.string().uuid();

/**
 * The AI to run with. `manual: true` is paste mode: no provider, no spending; the job waits for an answer you
 * submit. Otherwise a saved key of the user's is used (by id, or the first saved key of `provider`); the key itself
 * is never visible here. Omitted: the server's default, which on a normal install means credentials_required.
 */
export const AiInput = z
  .object({
    manual: z
      .boolean()
      .optional()
      .describe("Paste mode: the job compiles its prompt and waits for your answer (get_manual_prompt). No spending."),
    credentialId: Uuid.optional().describe("One of the user's saved provider keys (ids from get_server_info)."),
    provider: z.string().max(40).optional().describe("Use the user's first saved key for this provider kind."),
    model: z.string().max(200).optional().describe("Model id; defaults to the provider's first model."),
  })
  .optional();
export type AiInput = z.infer<typeof AiInput>;

/** An image cannot be pasted: image tools take a provider only. */
export const ImageAiInput = z
  .object({
    credentialId: Uuid.optional().describe("One of the user's saved provider keys (ids from get_server_info)."),
    provider: z.string().max(40).optional().describe("Use the user's first saved key for this provider kind."),
    model: z.string().max(200).optional(),
  })
  .optional();

/** Turns the MCP choice into the REST body's `ai`, picking the user's key for a named provider. */
export async function restAi(ctx: ToolContext, ai: AiInput | z.infer<typeof ImageAiInput>) {
  if (!ai) return undefined;
  if ("manual" in ai && ai.manual) return { manual: true };
  let credentialId = ai.credentialId ?? null;
  if (!credentialId && ai.provider) {
    const { credentials } = await ctx.invoke<{ credentials: { id: string; kind: string }[] }>("GET", "/api/ai/options");
    credentialId = credentials.find((k) => k.kind === ai.provider)?.id ?? null;
    if (!credentialId)
      throw toolError(
        422,
        "credentials_required",
        `The user has no saved ${ai.provider} key. They can add one in OpenManga → Account → AI providers; or use ai: { manual: true } for text work.`,
      );
  }
  return { credentialId, model: ai.model ?? null };
}

/** Text work spends only when it runs against a provider. */
export const textSpend = (ai: AiInput, otherwise: Sensitivity): Sensitivity => (ai?.manual ? otherwise : "spend");
export const aiLabel = (ai: AiInput) =>
  ai?.manual
    ? "in manual (paste) mode, no provider spending"
    : `with ${ai?.provider ?? "the chosen provider key"}${ai?.model ? ` (${ai.model})` : ""}; spends the user's provider credits`;

/** A job without the heavy fields: the compiled prompt (ask get_manual_prompt) and replayed manual answers. */
export function jobView(job: Record<string, unknown> | null | undefined) {
  if (!job) return job;
  const {
    compiledPrompt: _p,
    parameters,
    input: _i,
    ...rest
  } = job as Record<string, unknown> & {
    parameters?: Record<string, unknown>;
  };
  const p = parameters ?? {};
  return {
    ...rest,
    manual: p.manual === true,
    manualAnswers: Array.isArray(p.manualAnswers) ? p.manualAnswers.length : undefined,
    next:
      rest.status === "awaiting_input"
        ? "Call get_manual_prompt, then submit_manual_answer."
        : rest.status === "queued" || rest.status === "processing" || rest.status === "submitted"
          ? "Still running; poll get_job again in a few seconds."
          : undefined,
  };
}

export const links = (ctx: ToolContext) => ({
  project: (id: string) => ctx.deps.urls.appUrl(`projects/${id}`),
  chapter: (projectId: string, id: string) => ctx.deps.urls.appUrl(`projects/${projectId}/chapters/${id}`),
  page: (projectId: string, id: string) => ctx.deps.urls.appUrl(`projects/${projectId}/pages/${id}`),
  panel: (projectId: string, pageId: string, panelId: string) =>
    ctx.deps.urls.appUrl(`projects/${projectId}/pages/${pageId}`, { panel: panelId }),
  jobs: (projectId: string) => ctx.deps.urls.appUrl(`projects/${projectId}/generation`),
  job: (projectId: string, id: string) => ctx.deps.urls.appUrl(`projects/${projectId}/generation/${id}`),
  exports: (projectId: string) => ctx.deps.urls.appUrl(`projects/${projectId}/exports`),
  narration: (projectId: string) => ctx.deps.urls.appUrl(`projects/${projectId}/narration`),
});

export const Paging = {
  limit: z.number().int().min(1).max(100).default(25).describe("Page size (max 100)."),
  offset: z.number().int().min(0).default(0).describe("Items to skip."),
};
export function page<T>(items: T[], limit: number, offset: number) {
  const slice = items.slice(offset, offset + limit);
  return {
    items: slice,
    total: items.length,
    offset,
    limit,
    nextOffset: offset + slice.length < items.length ? offset + slice.length : null,
  };
}

type Kind =
  | "chapter"
  | "scene"
  | "page"
  | "panel"
  | "story_revision"
  | "story_analysis"
  | "generation"
  | "job"
  | "reference"
  | "project_style"
  | "narration_line"
  | "narration_segment"
  | "outfit"
  | "character"
  | "expert_chat";

/**
 * The project an entity id belongs to, for approval rules and the target snapshot. Access itself is always checked
 * by the route the tool calls; this never grants anything.
 */
export async function projectOf(ctx: ToolContext, kind: Kind, id: string): Promise<string> {
  const db = ctx.deps.db;
  const one = async (q: Promise<{ p: string | null }[]>) => (await q)[0]?.p ?? null;
  const p =
    kind === "chapter"
      ? await one(db.select({ p: chapters.projectId }).from(chapters).where(eq(chapters.id, id)))
      : kind === "scene"
        ? await one(db.select({ p: scenes.projectId }).from(scenes).where(eq(scenes.id, id)))
        : kind === "page"
          ? await one(db.select({ p: pages.projectId }).from(pages).where(eq(pages.id, id)))
          : kind === "panel"
            ? await one(db.select({ p: panels.projectId }).from(panels).where(eq(panels.id, id)))
            : kind === "story_revision"
              ? await one(
                  db.select({ p: storyRevisions.projectId }).from(storyRevisions).where(eq(storyRevisions.id, id)),
                )
              : kind === "story_analysis"
                ? await one(
                    db.select({ p: storyAnalyses.projectId }).from(storyAnalyses).where(eq(storyAnalyses.id, id)),
                  )
                : kind === "generation"
                  ? await one(
                      db.select({ p: generationJobs.projectId }).from(generationJobs).where(eq(generationJobs.id, id)),
                    )
                  : kind === "job"
                    ? ((await one(
                        db
                          .select({ p: generationJobs.projectId })
                          .from(generationJobs)
                          .where(eq(generationJobs.id, id)),
                      )) ??
                      (await one(db.select({ p: audioJobs.projectId }).from(audioJobs).where(eq(audioJobs.id, id)))) ??
                      (await one(db.select({ p: exportJobs.projectId }).from(exportJobs).where(eq(exportJobs.id, id)))))
                    : kind === "reference"
                      ? await one(
                          db
                            .select({ p: referenceAssets.projectId })
                            .from(referenceAssets)
                            .where(eq(referenceAssets.id, id)),
                        )
                      : kind === "project_style"
                        ? await one(
                            db
                              .select({ p: projectStyles.projectId })
                              .from(projectStyles)
                              .where(eq(projectStyles.id, id)),
                          )
                        : kind === "narration_line"
                          ? await one(
                              db
                                .select({ p: narrationLines.projectId })
                                .from(narrationLines)
                                .where(eq(narrationLines.id, id)),
                            )
                          : kind === "narration_segment"
                            ? await one(
                                db
                                  .select({ p: narrationSegments.projectId })
                                  .from(narrationSegments)
                                  .where(eq(narrationSegments.id, id)),
                              )
                            : kind === "outfit"
                              ? await one(
                                  db
                                    .select({ p: characters.projectId })
                                    .from(characterOutfits)
                                    .innerJoin(characters, eq(characters.id, characterOutfits.characterId))
                                    .where(eq(characterOutfits.id, id)),
                                )
                              : kind === "character"
                                ? await one(
                                    db
                                      .select({ p: characters.projectId })
                                      .from(characters)
                                      .where(eq(characters.id, id)),
                                  )
                                : await one(
                                    db
                                      .select({ p: expertChats.projectId })
                                      .from(expertChats)
                                      .where(eq(expertChats.id, id)),
                                  );
  if (!p) throw toolError(404, "not_found", "Not found");
  return p;
}

/** A classification for a plain write in a project, and its sensitive counterpart. */
export const cls = (
  sensitivity: Sensitivity,
  actionKey: string,
  projectId: string | null,
  summary: string,
  extra: Partial<Classification> = {},
): Classification => ({ sensitivity, actionKey, projectId, summary, ...extra });

type Stampable = typeof pages | typeof panels | typeof chapters | typeof storyRevisions | typeof storyAnalyses;
/**
 * A target's freshness stamp for a parked request: its status and last update (or, for rows without one, the given
 * fields). Throws not_found when it is gone, which makes an approval stale.
 */
export async function stamp(
  ctx: ToolContext,
  table: Stampable | unknown,
  id: string,
  fields = ["status", "updatedAt"],
) {
  const t = table as typeof pages;
  const [row] = (await ctx.deps.db.select().from(t).where(eq(t.id, id))) as Record<string, unknown>[];
  if (!row) throw toolError(404, "not_found", "Not found");
  return Object.fromEntries(
    fields.map((f) => [f, row[f] instanceof Date ? (row[f] as Date).toISOString() : (row[f] ?? null)]),
  );
}

/** Adds a project a selected-access connection just created (or copied) to its grants. */
export async function grantProject(ctx: ToolContext, projectId: string) {
  if (ctx.actor.projectAccess !== "selected") return;
  const { userServiceProjects } = await import("@openmanga/db");
  await ctx.deps.db
    .insert(userServiceProjects)
    .values({ serviceId: ctx.actor.serviceId, projectId })
    .onConflictDoNothing();
  ctx.actor.projectIds.add(projectId);
}

export const requireCreate = (ctx: ToolContext) => {
  if (!ctx.actor.allowProjectCreate)
    throw toolError(
      403,
      "forbidden",
      "This connection is not allowed to create projects. The user can allow it in OpenManga → Agent access.",
    );
};
