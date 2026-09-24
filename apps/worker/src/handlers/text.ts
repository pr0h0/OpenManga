import type { ChatMessage, TextAIProvider } from "@openmanga/ai-text";
import {
  and,
  asc,
  chapters,
  characterAliases,
  characterOutfits,
  characters,
  characterVersions,
  desc,
  eq,
  generationJobs,
  inArray,
  isNull,
  locations,
  locationVersions,
  narrationLines,
  narrationSegments,
  pages,
  panels,
  projectStyles,
  projects,
  props,
  scenes,
  sql,
  storyAnalyses,
  storyRevisions,
  stylePresets,
} from "@openmanga/db";
import { LAYOUT_TEMPLATES, languageName, segmentNarration } from "@openmanga/domain";
import {
  chapterOutlineV1,
  chapterPlanningV5,
  imageDescribeV1,
  jsonRepairV1,
  narrationV4,
  panelPromptsV3,
  scenePagesV1,
  sceneShotsV1,
  sceneStripV1,
  shotOutlineV1,
  shotPlanningV2,
  storyAnalysisV2,
  storyRewriteV1,
  stripOutlineV1,
  stripPlanningV1,
} from "@openmanga/prompts";
import {
  ChapterOutline,
  ChapterPlan,
  ImageDescription,
  narrationDraftFor,
  PanelPromptDraft,
  type ProjectFormat,
  ScenePages,
  StoryAnalysis,
  StoryRewrite,
} from "@openmanga/schemas";
import { applyChapterPlan, applyNarrationPauses } from "@openmanga/services";
import { sha256Hex } from "@openmanga/storage";
import type { z } from "zod";
import type { WorkerDeps } from "../context.ts";
import { formatPrompt, isManual, manualProvider, ParkedForManualInput } from "../lib/manual-provider.ts";
import {
  type GenerationJob,
  InputError,
  isCancelRequested,
  JobCancelledError,
  recordTextCalls,
} from "../lib/runner.ts";
import { batchAware, ParkedForBatch } from "../lib/text-batch-provider.ts";

const repairBuilder = (schemaName: string) => (a: { raw: string; error: string; schemaText: string }) =>
  jsonRepairV1.build({ schemaName, error: a.error, raw: a.raw, schemaText: a.schemaText });

async function structured<T>(
  deps: WorkerDeps,
  job: GenerationJob,
  messages: ChatMessage[],
  schema: z.ZodType<T>,
  schemaName: string,
  maxTokens = 32_000,
) {
  // In a batch run this wrapper either collects the request and parks the job, or replays the answer the batch
  // returned — either way the handler around it is unchanged. A manual run is the same shape with a person in
  // the provider's place, and resolves no credential because it has none to resolve.
  const provider = isManual(job)
    ? manualProvider(job)
    : batchAware((await deps.resolver.forJob("text", job)) as TextAIProvider, job, deps.batchCollector);
  const r = await provider.generateStructured({
    messages,
    schema,
    schemaName,
    maxTokens,
    buildRepairMessages: repairBuilder(schemaName),
  });
  await recordTextCalls(deps, job, r.calls);
  // Mark a batched answer's tokens as counted, so a retry of this handler replays the text without re-billing.
  if (job.parameters.batchAnswer && job.parameters.batchUsageRecorded !== true)
    await deps.db
      .update(generationJobs)
      .set({ parameters: sql`${generationJobs.parameters} || '{"batchUsageRecorded":true}'::jsonb` })
      .where(eq(generationJobs.id, job.id));
  const last = r.calls.at(-1);
  await deps.db
    .update(generationJobs)
    .set({
      providerRequestId: last?.requestId ?? null,
      provider: last?.provider ?? job.provider,
      model: last?.model ?? job.model,
      compiledPrompt: formatPrompt(messages),
    })
    .where(eq(generationJobs.id, job.id));
  return r;
}

export async function storyAnalysis(deps: WorkerDeps, job: GenerationJob) {
  const analysisId = String(job.input.analysisId);
  const [rev] = await deps.db
    .select()
    .from(storyRevisions)
    .where(eq(storyRevisions.id, String(job.input.storyRevisionId)));
  if (!rev) throw new InputError("Story revision no longer exists");
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
  const messages = storyAnalysisV2.build({
    story: rev.content,
    inputKind: rev.inputKind,
    language: project?.language ?? "en",
    projectType: project?.projectType ?? "manhwa",
  });
  try {
    const r = await structured(deps, job, messages, StoryAnalysis, "StoryAnalysis", 64_000);
    await deps.db
      .update(storyAnalyses)
      .set({ status: "completed", result: r.data })
      .where(eq(storyAnalyses.id, analysisId));
    await deps.events.publish(job.projectId, { type: "analysis.updated", analysisId, status: "completed" });
    return { analysisId, repaired: r.repaired, characters: r.data.characters.length, chapters: r.data.chapters.length };
  } catch (e) {
    // Being collected for a batch is not a failure: the run is parked and paid for, and marking the analysis
    // failed here would show the user a dead analysis for up to a day and invite them to pay for a second one.
    // Being parked for a pasted answer is the same: the analysis is waiting on a person, not broken.
    if (e instanceof ParkedForBatch || e instanceof ParkedForManualInput) throw e;
    await deps.db.update(storyAnalyses).set({ status: "failed" }).where(eq(storyAnalyses.id, analysisId));
    await deps.events.publish(job.projectId, { type: "analysis.updated", analysisId, status: "failed" });
    throw e;
  }
}

export async function storyRewrite(deps: WorkerDeps, job: GenerationJob) {
  const [rev] = await deps.db
    .select()
    .from(storyRevisions)
    .where(eq(storyRevisions.id, String(job.input.storyRevisionId)));
  if (!rev) throw new InputError("Story revision no longer exists");
  const r = await structured(
    deps,
    job,
    storyRewriteV1.build({ story: rev.content, instruction: String(job.input.instruction ?? "") }),
    StoryRewrite,
    "StoryRewrite",
    32_000,
  );
  const created = await deps.db.transaction(async (tx) => {
    const [max] = await tx
      .select({ n: sql<number>`coalesce(max(${storyRevisions.revisionNumber}),0)::int` })
      .from(storyRevisions)
      .where(eq(storyRevisions.projectId, job.projectId));
    const [row] = await tx
      .insert(storyRevisions)
      .values({
        projectId: job.projectId,
        revisionNumber: (max?.n ?? 0) + 1,
        source: "ai_rewrite",
        inputKind: rev.inputKind,
        title: rev.title,
        content: r.data.content,
        contentSha256: sha256Hex(r.data.content),
        createdByUserId: job.userId,
      })
      .returning();
    return row!;
  });
  return { storyRevisionId: created.id, revisionNumber: created.revisionNumber, notes: r.data.notes };
}

/** Structured project context for planning: keys the model can reference, never the entire story history. */
async function projectPlanningData(deps: WorkerDeps, projectId: string, chapterId: string) {
  const chars = await deps.db
    .select({ c: characters, v: characterVersions })
    .from(characters)
    .leftJoin(characterVersions, eq(characterVersions.id, characters.currentVersionId))
    .where(and(eq(characters.projectId, projectId), isNull(characters.deletedAt)));
  const aliases = chars.length
    ? await deps.db
        .select()
        .from(characterAliases)
        .where(
          inArray(
            characterAliases.characterId,
            chars.map((c) => c.c.id),
          ),
        )
    : [];
  const outfits = chars.length
    ? await deps.db
        .select()
        .from(characterOutfits)
        .where(
          inArray(
            characterOutfits.characterId,
            chars.map((c) => c.c.id),
          ),
        )
        .orderBy(asc(characterOutfits.createdAt))
    : [];
  const locs = await deps.db
    .select({ l: locations, v: locationVersions })
    .from(locations)
    .leftJoin(locationVersions, eq(locationVersions.id, locations.currentVersionId))
    .where(and(eq(locations.projectId, projectId), isNull(locations.deletedAt)));
  const prs = await deps.db
    .select()
    .from(props)
    .where(and(eq(props.projectId, projectId), isNull(props.deletedAt)));
  const [chapter] = await deps.db.select().from(chapters).where(eq(chapters.id, chapterId));
  const [prev] = chapter
    ? await deps.db
        .select()
        .from(chapters)
        .where(and(eq(chapters.projectId, projectId), sql`${chapters.order} < ${chapter.order}`))
        .orderBy(sql`${chapters.order} desc`)
        .limit(1)
    : [];
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  const artDirection = await projectArtDirection(deps, projectId);
  const keyOf = (analysisKey: string | null, name: string) =>
    analysisKey ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    chapter,
    data: {
      project: {
        title: project?.title,
        type: project?.projectType,
        readingDirection: project?.readingDirection,
        worldNotes: project?.settings.worldNotes,
      },
      artDirection,
      chapter: { title: chapter?.title, order: chapter?.order, summary: chapter?.summary, beats: chapter?.beats },
      previousChapterMemory: prev
        ? {
            title: prev.title,
            closingState: prev.closingState,
            characterStateChanges: prev.characterStateChanges,
            revealedFacts: prev.revealedFacts,
          }
        : null,
      characters: chars.map(({ c, v }) => ({
        key: keyOf(c.analysisKey, c.name),
        name: c.name,
        role: c.role,
        aliases: aliases.filter((a) => a.characterId === c.id).map((a) => a.alias),
        look: v ? [v.description.hair, v.description.eyes, v.description.wardrobe].filter(Boolean).join("; ") : "",
        // Naming one of these in a panel's outfit dresses the character in it, reference image included.
        outfits: outfits.filter((o) => o.characterId === c.id).map((o) => o.name),
      })),
      locations: locs.map(({ l, v }) => ({
        key: keyOf(l.analysisKey, l.name),
        name: l.name,
        summary: v?.description.summary ?? "",
      })),
      props: prs.map((p) => ({ key: keyOf(p.analysisKey, p.name), name: p.name })),
    },
  };
}

/** The project's style as binding direction for planners' lighting and emotion fields. */
async function projectArtDirection(deps: WorkerDeps, projectId: string) {
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  const [ps] = project?.currentStyleId
    ? await deps.db.select().from(projectStyles).where(eq(projectStyles.id, project.currentStyleId))
    : await deps.db
        .select()
        .from(projectStyles)
        .where(eq(projectStyles.projectId, projectId))
        .orderBy(desc(projectStyles.versionNumber))
        .limit(1);
  const [preset] = ps?.stylePresetId
    ? await deps.db.select().from(stylePresets).where(eq(stylePresets.id, ps.stylePresetId))
    : [];
  return {
    preset: preset?.name ?? null,
    summary: preset?.definition.summary ?? "",
    lighting: preset?.definition.lighting ?? "",
    customStyle: ps?.customDescription ?? "",
  };
}

/** Outline first, then one response per scene, assembled into the plan `applyChapterPlan` already takes. */
async function planByScene(
  deps: WorkerDeps,
  job: GenerationJob,
  i: { format: ProjectFormat; data: Record<string, unknown>; chapterText: string },
): Promise<ChapterPlan> {
  // Film shots and vertical strip panels are one frame per page, so only the full-page template applies.
  const oneFrame = i.format === "film" || i.format === "vertical";
  const layoutTemplates = LAYOUT_TEMPLATES.filter((t) => !oneFrame || t.key === "full-page").map((t) => ({
    key: t.key,
    name: t.name,
    panels: t.frames.length,
  }));
  const target = typeof job.input.targetPages === "number" ? job.input.targetPages : undefined;
  const base = { projectData: i.data, chapterText: i.chapterText, layoutTemplates };
  const outline = await structured(
    deps,
    job,
    (i.format === "film" ? shotOutlineV1 : i.format === "vertical" ? stripOutlineV1 : chapterOutlineV1).build({
      ...base,
      targetPages: target,
    }),
    ChapterOutline,
    "ChapterOutline",
    16_000,
  );
  const pagesTemplate = i.format === "film" ? sceneShotsV1 : i.format === "vertical" ? sceneStripV1 : scenePagesV1;
  const scenes: ChapterPlan["scenes"] = [];
  for (const [sceneIndex, scene] of outline.data.scenes.entries()) {
    if (await isCancelRequested(deps, job.id)) throw new JobCancelledError();
    const r = await structured(
      deps,
      job,
      pagesTemplate.build({
        ...base,
        outline: outline.data,
        sceneIndex,
        // Spread the requested page count over the scenes; without a target each scene picks its own length.
        targetPages: target ? Math.max(1, Math.round(target / outline.data.scenes.length)) : undefined,
      }),
      ScenePages,
      "ScenePages",
      32_000,
    );
    scenes.push({ ...scene, pages: r.data.pages });
    deps.logger.info("planned a scene", {
      jobId: job.id,
      scene: sceneIndex + 1,
      of: outline.data.scenes.length,
      pages: r.data.pages.length,
    });
  }
  return { ...outline.data, scenes };
}

export async function chapterPlan(deps: WorkerDeps, job: GenerationJob) {
  const chapterId = String(job.input.chapterId);
  const { chapter, data } = await projectPlanningData(deps, job.projectId, chapterId);
  if (!chapter) throw new InputError("Chapter no longer exists");
  const [proj] = await deps.db
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, job.projectId));
  const format: ProjectFormat = proj?.settings.format ?? "comic";
  const oneFrame = format === "film" || format === "vertical";
  const messages = (
    format === "film" ? shotPlanningV2 : format === "vertical" ? stripPlanningV1 : chapterPlanningV5
  ).build({
    projectData: data,
    chapterText: chapter.sourceExcerpt || chapter.summary,
    layoutTemplates: LAYOUT_TEMPLATES.filter((t) => !oneFrame || t.key === "full-page").map((t) => ({
      key: t.key,
      name: t.name,
      panels: t.frames.length,
    })),
    targetPages: typeof job.input.targetPages === "number" ? job.input.targetPages : undefined,
  });
  // A feature-length chapter does not fit in one response: production runs truncated at the 64k output cap on
  // every provider tried. Interactive runs plan the scenes first and then one scene's pages at a time, so each
  // call is bounded and a scene that comes back malformed is re-asked alone. Batched runs keep the single call:
  // the batch wrapper parks the job on its first provider call, so a loop would need one 24h round trip per
  // scene to finish a chapter.
  const plan = job.parameters.batchMode
    ? (await structured(deps, job, messages, ChapterPlan, "ChapterPlan", 64_000)).data
    : await planByScene(deps, job, { format, data, chapterText: chapter.sourceExcerpt || chapter.summary });
  const applied = await applyChapterPlan(deps.db, chapterId, plan, { replace: Boolean(job.input.replace) });
  await deps.events.publish(job.projectId, { type: "chapter.updated", chapterId });
  // Planning the same script twice can return very different densities, so report what this plan achieved
  // against its source: a caller re-planning a chapter can compare runs instead of eyeballing the result.
  const sourceWords = (chapter.sourceExcerpt || chapter.summary).trim().split(/\s+/).filter(Boolean).length;
  const target = typeof job.input.targetPages === "number" ? job.input.targetPages : null;
  const density = {
    sourceWords,
    panelsPerKWord: sourceWords ? Number(((applied.panels / sourceWords) * 1000).toFixed(2)) : null,
    /** Only when pages were asked for: a plan that lands far under the request is the thin-chapter case. */
    targetPages: target,
    targetMissed: target ? Math.abs(applied.pages - target) / target > 0.25 : false,
  };
  if (density.targetMissed)
    deps.logger.warn("chapter plan missed the requested page count", { chapterId, ...density, pages: applied.pages });
  return { chapterId, ...applied, scenes: plan.scenes.length, ...density };
}

export async function pagePrompts(deps: WorkerDeps, job: GenerationJob) {
  const pageId = String(job.input.pageId);
  const [page] = await deps.db.select().from(pages).where(eq(pages.id, pageId));
  if (!page) throw new InputError("Page no longer exists");
  const pns = await deps.db.select().from(panels).where(eq(panels.pageId, pageId)).orderBy(asc(panels.order));
  if (!pns.length) throw new InputError("Page has no panels");
  const specs = await deps.db.execute<{ panel_id: string; spec: Record<string, unknown> }>(
    sql`select distinct on (panel_id) panel_id, spec from panel_specs where panel_id in (${sql.join(
      pns.map((p) => sql`${p.id}`),
      sql`, `,
    )}) order by panel_id, version_number desc`,
  );
  const [scene] = page.sceneId ? await deps.db.select().from(scenes).where(eq(scenes.id, page.sceneId)) : [];
  const charIds = [...new Set(pns.flatMap((p) => p.characterVersionIds))];
  const chars = charIds.length
    ? await deps.db
        .select({ id: characterVersions.id, name: characters.name, id2: characters.id })
        .from(characterVersions)
        .innerJoin(characters, eq(characters.id, characterVersions.characterId))
        .where(inArray(characterVersions.id, charIds))
    : [];
  const context = {
    scene: scene
      ? {
          title: scene.title,
          summary: scene.summary,
          time: scene.time,
          weather: scene.weather,
          continuityNotes: scene.continuityNotes,
          state: scene.initialState,
        }
      : null,
    page: { purpose: page.purpose, pacing: page.pacing, visualEmphasis: page.visualEmphasis },
    artDirection: await projectArtDirection(deps, page.projectId),
  };
  const panelData = pns.map((p) => ({
    panelId: p.id,
    order: p.order,
    shotType: p.shotType,
    cameraAngle: p.cameraAngle,
    beat: p.storyBeat,
    characters: p.characterVersionIds.map((v) => chars.find((c) => c.id === v)?.name).filter(Boolean),
    spec: [...specs].find((s) => s.panel_id === p.id)?.spec ?? null,
  }));
  const r = await structured(
    deps,
    job,
    panelPromptsV3.build({ context, panels: panelData }),
    PanelPromptDraft,
    "PanelPromptDraft",
  );
  let updated = 0;
  for (const d of r.data.panels) {
    const pn = pns.find((p) => p.id === d.panelId);
    if (!pn) continue;
    await deps.db
      .update(panels)
      .set({
        promptDraft: {
          intent: d.intent,
          action: d.action,
          expression: d.expression,
          composition: d.composition,
          lighting: d.lighting,
          continuity: d.continuity,
          templateName: panelPromptsV3.name,
          templateVersion: panelPromptsV3.version,
          jobId: job.id,
        },
        status: pn.status === "planned" || pn.status === "failed" ? "prompt-ready" : pn.status,
      })
      .where(eq(panels.id, pn.id));
    await deps.events.publish(job.projectId, {
      type: "panel.updated",
      panelId: pn.id,
      pageId,
      status: pn.status === "planned" ? "prompt-ready" : pn.status,
    });
    updated++;
  }
  return { pageId, updated, repaired: r.repaired };
}

export async function narrationText(deps: WorkerDeps, job: GenerationJob) {
  const chapterId = String(job.input.chapterId);
  const [chapter] = await deps.db.select().from(chapters).where(eq(chapters.id, chapterId));
  if (!chapter) throw new InputError("Chapter no longer exists");
  const pns = await deps.db
    .select({ id: panels.id, beat: panels.storyBeat, pageOrder: pages.order, order: panels.order })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .where(eq(pages.chapterId, chapterId))
    .orderBy(asc(pages.order), asc(panels.order));
  const [project] = await deps.db
    .select({ settings: projects.settings, language: projects.language })
    .from(projects)
    .where(eq(projects.id, job.projectId));
  const wordsPerPanel = Number(job.input.wordsPerPanel ?? project?.settings.narrationWordsPerPanel ?? 21);
  const language = String(job.input.language || project?.language || "en");
  // ponytail: one request per chapter; chapters over 200 panels get narration for the first 200 only.
  const promptPanels = pns.slice(0, 200);
  const r = await structured(
    deps,
    job,
    narrationV4.build({
      language: `${languageName(language)} (${language})`,
      context: { chapter: { title: chapter.title, summary: chapter.summary } },
      chapterText: chapter.sourceExcerpt || chapter.summary,
      panels: promptPanels,
      style: String(job.input.style || project?.settings.narrationStyle || ""),
      wordsPerPanel,
    }),
    narrationDraftFor(promptPanels, wordsPerPanel, language),
    "NarrationDraft",
    64_000,
  );
  const validPanels = new Map(pns.map((p) => [p.id, p]));
  const maxChars = deps.config.NARRATION_SEGMENT_MAX_CHARS;
  const pageOfPanel = new Map(
    (
      await deps.db
        .select({ id: panels.id, pageId: panels.pageId })
        .from(panels)
        .where(eq(panels.projectId, job.projectId))
    ).map((p) => [p.id, p.pageId]),
  );
  const created = await deps.db.transaction(async (tx) => {
    if (job.input.replace)
      await tx
        .delete(narrationLines)
        .where(
          and(
            eq(narrationLines.chapterId, chapterId),
            eq(narrationLines.language, language),
            eq(narrationLines.showOnPage, false),
          ),
        );
    const [max] = await tx
      .select({ n: sql<number>`coalesce(max(${narrationLines.order}),0)::int` })
      .from(narrationLines)
      .where(and(eq(narrationLines.chapterId, chapterId), eq(narrationLines.language, language)));
    let order = max?.n ?? 0;
    let n = 0;
    for (const line of r.data.lines) {
      const panelId = line.panelId && validPanels.has(line.panelId) ? line.panelId : null;
      const [nl] = await tx
        .insert(narrationLines)
        .values({
          projectId: job.projectId,
          chapterId,
          panelId,
          pageId: panelId ? (pageOfPanel.get(panelId) ?? null) : null,
          order: ++order,
          language,
          text: line.text,
          showOnPage: false,
        })
        .returning();
      const segs = segmentNarration(line.text, maxChars);
      if (segs.length)
        await tx.insert(narrationSegments).values(
          segs.map((s, i) => ({
            projectId: job.projectId,
            narrationLineId: nl!.id,
            order: i,
            text: s.text,
            textSha256: sha256Hex(s.text),
            pauseAfterMs: s.pauseAfterMs,
          })),
        );
      n++;
    }
    await applyNarrationPauses(tx, chapterId, language, project?.settings ?? {});
    return n;
  });
  await deps.events.publish(job.projectId, { type: "narration.updated", chapterId });
  return { chapterId, language, lines: created, repaired: r.repaired };
}

/**
 * Describes an uploaded reference image as reusable descriptions. The result deliberately reuses the exact
 * shapes the style, character and location endpoints already accept, so "use this as the project style" is a
 * plain POST of the object rather than a translation step.
 */
export async function imageDescribe(deps: WorkerDeps, job: GenerationJob) {
  const assetId = String(job.input.assetId);
  const asset = await deps.assets.get(assetId);
  if (!asset) throw new InputError("The image no longer exists");
  if (asset.projectId !== job.projectId) throw new InputError("That image belongs to another project");
  // A preview is plenty to describe from and keeps the request (and its bill) small; canonical bytes are the
  // fallback for anything sharp cannot resize.
  const preview = await deps.assets.ensureResized(asset, "preview");
  const image = preview
    ? { mime: preview.mimeType, data: await deps.assets.readVariant(preview), assetId: asset.id }
    : { mime: asset.mimeType, data: await deps.assets.read(asset), assetId: asset.id };

  const aspects = Array.isArray(job.input.aspects) ? (job.input.aspects as string[]) : [];
  const messages: ChatMessage[] = [
    ...imageDescribeV1.build({
      aspects,
      custom: String(job.input.custom ?? ""),
      note: String(job.input.note ?? ""),
    }),
  ];
  messages[1] = { ...messages[1]!, images: [image] };
  const r = await structured(deps, job, messages, ImageDescription, "ImageDescription", 16_000);
  return { assetId, aspects, repaired: r.repaired, description: r.data };
}
