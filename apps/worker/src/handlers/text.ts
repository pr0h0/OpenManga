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
  dialogueLines,
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
  propVersions,
  scenes,
  sql,
  storyAnalyses,
  storyRevisions,
  stylePresets,
  timelineEvents,
} from "@openmanga/db";
import {
  bibleIsEmpty,
  chaptersForRuntime,
  LAYOUT_TEMPLATES,
  languageName,
  type RuntimeTarget,
  runtimeBudget,
  segmentNarration,
  segmentTextSha,
  wordsPerPanelFor,
} from "@openmanga/domain";
import {
  adScriptV1,
  bibleExtractV1,
  imageDescribeV1,
  jsonRepairV1,
  letteringTranslateV1,
  narrationRetimeV1,
  narrationV6,
  overrideSystem,
  panelPromptsV5,
  planningTemplates,
  socialCopyV2,
  storyAnalysisV3,
  storyRewriteV1,
  timelineExtractV1,
  videoEditV1,
  youtubePackageV2,
} from "@openmanga/prompts";
import {
  AdBrief,
  AdScript,
  BibleExtraction,
  ChapterOutline,
  ChapterPlan,
  ImageDescription,
  LetteringTranslation,
  NarrationRetime,
  narrationDraftFor,
  PanelPromptDraft,
  type PanelSpec,
  type ProjectFormat,
  ScenePages,
  SocialCopy,
  StoryAnalysis,
  StoryRewrite,
  TimelineExtraction,
  type VideoEditOp,
  VideoEditPlan,
  YoutubePackage,
} from "@openmanga/schemas";
import {
  activeOverride,
  applyChapterPlan,
  applyNarrationPauses,
  bibleFor,
  cardOf,
  chapterLettering,
  loadBible,
  recordNarrationFingerprint,
  resolveVideoEdit,
  saveTranslations,
  youtubeSourceFingerprint,
} from "@openmanga/services";
import { sha256Hex } from "@openmanga/storage";
import type { z } from "zod";
import type { WorkerDeps } from "../context.ts";
import { formatPrompt, isManual, manualProvider, ParkedForManualInput } from "../lib/manual-provider.ts";
import {
  type GenerationJob,
  InputError,
  isCancelRequested,
  JobCancelledError,
  type ProjectJob,
  recordTextCalls,
} from "../lib/runner.ts";
import { batchAware, ParkedForBatch } from "../lib/text-batch-provider.ts";

const repairBuilder = (schemaName: string) => (a: { raw: string; error: string; schemaText: string }) =>
  jsonRepairV1.build({ schemaName, error: a.error, raw: a.raw, schemaText: a.schemaText });

export async function structured<T>(
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
  // The project's prompt-lab rules for this template, in place of the built-in ones (header, data rule and answer
  // format stay), recorded on the job.
  const header = /^\[template:([a-z-]+)-v\d+\]/.exec(messages[0]?.role === "system" ? messages[0].content : "")?.[1];
  const override = header && job.projectId ? await activeOverride(deps.db, job.projectId, header) : null;
  if (override) {
    messages = [
      { ...messages[0]!, content: overrideSystem(messages[0]!.content, override.rules) },
      ...messages.slice(1),
    ];
    await deps.db
      .update(generationJobs)
      .set({
        parameters: sql`${generationJobs.parameters} || jsonb_build_object('promptOverrides', coalesce(${generationJobs.parameters}->'promptOverrides', '{}'::jsonb) || jsonb_build_object(${header}::text, ${override.version}::int))`,
      })
      .where(eq(generationJobs.id, job.id));
  }
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

export async function storyAnalysis(deps: WorkerDeps, job: ProjectJob) {
  const analysisId = String(job.input.analysisId);
  const [rev] = await deps.db
    .select()
    .from(storyRevisions)
    .where(eq(storyRevisions.id, String(job.input.storyRevisionId)));
  if (!rev) throw new InputError("Story revision no longer exists");
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
  // A target runtime sets how many chapters the story is cut into, so each fits a single chapter plan.
  const target = project?.settings.targetRuntime;
  const chapters = target ? chaptersForRuntime(target, project!.settings.format) : null;
  const messages = storyAnalysisV3.build({
    story: rev.content,
    inputKind: rev.inputKind,
    language: project?.language ?? "en",
    projectType: project?.projectType ?? "manhwa",
    runtime: target && chapters ? { minutes: target.minutes, chapters } : null,
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

export async function storyRewrite(deps: WorkerDeps, job: ProjectJob) {
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

/** An ad's script from its brief, saved as a new story revision (a screenplay), ready for analysis and planning. */
export async function adScript(deps: WorkerDeps, job: ProjectJob) {
  const brief = AdBrief.parse(job.input.brief);
  const r = await structured(
    deps,
    job,
    adScriptV1.build({ brief, language: String(job.input.language ?? "en"), look: String(job.input.look ?? "") }),
    AdScript,
    "AdScript",
    16_000,
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
        inputKind: "screenplay",
        title: r.data.title,
        content: r.data.content,
        contentSha256: sha256Hex(r.data.content),
        createdByUserId: job.userId,
      })
      .returning();
    return row!;
  });
  return { storyRevisionId: created.id, revisionNumber: created.revisionNumber, notes: r.data.notes };
}

/** Publishing text for the project's video, saved on the project (and editable there) rather than on the job. */
export async function youtubePackage(deps: WorkerDeps, job: ProjectJob) {
  const [p] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
  if (!p) throw new InputError("Project no longer exists");
  const chs = await deps.db
    .select({ order: chapters.order, title: chapters.title, summary: chapters.summary })
    .from(chapters)
    .where(eq(chapters.projectId, p.id))
    .orderBy(asc(chapters.order));
  const cast = await deps.db
    .select({ name: characters.name, role: characters.role })
    .from(characters)
    .where(and(eq(characters.projectId, p.id), isNull(characters.deletedAt)));
  const rules = p.settings.youtubeRules ?? null;
  // The template's {title} and {author} are known here, so they are filled exactly rather than left to the model.
  const descriptionTemplate = (rules?.descriptionTemplate ?? "")
    .replaceAll("{title}", p.title)
    .replaceAll("{author}", p.settings.author ?? "");
  const r = await structured(
    deps,
    job,
    youtubePackageV2.build({
      project: { title: p.title, description: p.description, type: p.projectType, language: p.language },
      chapters: chs,
      cast,
      headline: p.settings.thumbnail?.title || p.title,
      rules: rules && { ...rules, descriptionTemplate },
    }),
    YoutubePackage,
    "YoutubePackage",
    8000,
  );
  // The channel's own tags are on every package, first and exactly as written; the model's follow, without repeats.
  const own = rules?.tags ?? [];
  const seen = new Set(own.map((t) => t.toLowerCase()));
  const pkg = { ...r.data, tags: [...own, ...r.data.tags.filter((t) => !seen.has(t.toLowerCase()))].slice(0, 30) };
  // Written from the title and chapters as they are now: staleness compares this when either changes.
  const sources = {
    ...p.settings.publishingSources,
    youtubeText: await youtubeSourceFingerprint(deps.db, p),
    youtubeTextAt: new Date().toISOString(),
  };
  await deps.db
    .update(projects)
    .set({
      settings: sql`${projects.settings} || jsonb_build_object('youtubePackage', ${JSON.stringify(pkg)}::jsonb,
        'publishingSources', ${JSON.stringify(sources)}::jsonb)`,
    })
    .where(eq(projects.id, p.id));
  return { titles: pkg.titles.length, tags: pkg.tags.length };
}

/**
 * The timing pass's trim or expand: the chosen lines rewritten to their word budgets. Nothing is changed here; the
 * proposal is the job's result, shown as a diff, and applying it (only the lines the user keeps) is a separate step.
 */
export async function narrationRetime(deps: WorkerDeps, job: ProjectJob) {
  const want = (job.input.lines ?? []) as { lineId: string; words: number }[];
  const [p] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
  const rows = want.length
    ? await deps.db
        .select({ id: narrationLines.id, text: narrationLines.text, language: narrationLines.language })
        .from(narrationLines)
        .where(
          and(
            eq(narrationLines.chapterId, String(job.input.chapterId)),
            inArray(
              narrationLines.id,
              want.map((w) => w.lineId),
            ),
          ),
        )
    : [];
  if (!rows.length || !p) throw new InputError("None of those narration lines exist any more");
  const count = (t: string) => t.split(/\s+/).filter(Boolean).length;
  const lines = rows.map((r) => ({
    lineId: r.id,
    text: r.text,
    words: count(r.text),
    budget: want.find((w) => w.lineId === r.id)!.words,
  }));
  const r = await structured(
    deps,
    job,
    narrationRetimeV1.build({
      language: languageName(rows[0]!.language),
      style: p.settings.narrationStyle ?? "",
      lines,
    }),
    NarrationRetime,
    "NarrationRetime",
    16_000,
  );
  // Only the lines that were asked for, each once: anything else the model returned is dropped.
  const proposals = lines.flatMap((l) => {
    const next = r.data.lines.find((x) => x.lineId === l.lineId)?.text.trim();
    return next && next !== l.text ? [{ ...l, after: next, afterWords: count(next) }] : [];
  });
  return { chapterId: String(job.input.chapterId), lines: proposals, repaired: r.repaired };
}

/**
 * Social titles and captions for the repurposing plan, written into its saved items. Only the items the job was asked
 * for change, and only their title and caption; an item removed from the plan since is skipped.
 */
export async function socialCopy(deps: WorkerDeps, job: ProjectJob) {
  const items = (job.input.items ?? []) as { id: string; kind: string; label: string; narration: string }[];
  const [p] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
  if (!p || !items.length) throw new InputError("Nothing to write social copy for");
  const r = await structured(
    deps,
    job,
    socialCopyV2.build({
      project: { title: p.title, description: p.description, language: languageName(p.language) },
      items,
    }),
    SocialCopy,
    "SocialCopy",
    8_000,
  );
  const asked = new Set(items.map((i) => i.id));
  const copy = new Map(r.data.items.filter((x) => asked.has(x.id)).map((x) => [x.id, x]));
  // ponytail: read-modify-write of one settings key; a plan saved between these two statements loses to this write.
  const [now] = await deps.db.select({ settings: projects.settings }).from(projects).where(eq(projects.id, p.id));
  const next = (now?.settings.repurpose?.items ?? []).map((it) => {
    const c = copy.get(it.id);
    // A video's hook is replaced like its title; a picture has none.
    const video = ["short", "trailer", "teaser"].includes(it.kind);
    return c ? { ...it, title: c.title, caption: c.caption, ...(video && c.hook ? { hook: c.hook } : {}) } : it;
  });
  await deps.db
    .update(projects)
    .set({
      settings: sql`${projects.settings} || jsonb_build_object('repurpose', ${JSON.stringify({ items: next })}::jsonb)`,
    })
    .where(eq(projects.id, p.id));
  return { items: copy.size, repaired: r.repaired };
}

/** With a target runtime, the words per panel that land this chapter on its share of it; otherwise null. */
async function runtimeWordsPerPanel(
  deps: WorkerDeps,
  projectId: string,
  settings: { targetRuntime?: RuntimeTarget | null; format: "comic" | "film" | "vertical" } | undefined,
  chapterId: string,
  panelCount: number,
) {
  const t = settings?.targetRuntime;
  if (!t) return null;
  const chs = await deps.db
    .select({ id: chapters.id, source: chapters.sourceExcerpt, summary: chapters.summary })
    .from(chapters)
    .where(eq(chapters.projectId, projectId));
  const budget = runtimeBudget(
    t,
    chs.map((c) => ({ id: c.id, sourceChars: (c.source || c.summary).length })),
    settings.format,
  ).chapters.find((c) => c.id === chapterId);
  return budget ? wordsPerPanelFor(t, budget.words, panelCount) : null;
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
    .select({ p: props, v: propVersions })
    .from(props)
    .leftJoin(propVersions, eq(propVersions.id, props.currentVersionId))
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
  // Facts revealed before the previous chapter: the planner must not reveal them again or contradict them.
  const earlier = chapter
    ? await deps.db
        .select({ revealedFacts: chapters.revealedFacts })
        .from(chapters)
        .where(and(eq(chapters.projectId, projectId), sql`${chapters.order} < ${chapter.order}`))
        .orderBy(chapters.order)
    : [];
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, projectId));
  const artDirection = await projectArtDirection(deps, projectId);
  const [analysis] = await deps.db
    .select({ result: storyAnalyses.result })
    .from(storyAnalyses)
    .where(and(eq(storyAnalyses.projectId, projectId), eq(storyAnalyses.status, "applied")))
    .orderBy(desc(storyAnalyses.appliedAt))
    .limit(1);
  const keyOf = (analysisKey: string | null, name: string) =>
    analysisKey ?? name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const castKeys = new Set(chars.map(({ c }) => keyOf(c.analysisKey, c.name)));
  // The bible in effect when the chapter opens (and what changes during it), about whoever and whatever it mentions.
  const bible = chapter
    ? bibleFor(
        await loadBible(deps.db, projectId),
        { chapter: chapter.order },
        { text: [chapter.title, chapter.summary, chapter.sourceExcerpt, ...chapter.beats].join("\n") },
      )
    : null;
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
            locationStateChanges: prev.locationStateChanges,
            revealedFacts: prev.revealedFacts,
          }
        : null,
      earlierRevealedFacts: earlier.slice(0, -1).flatMap((c) => c.revealedFacts),
      characters: chars.map(({ c, v }) => ({
        key: keyOf(c.analysisKey, c.name),
        name: c.name,
        role: c.role,
        aliases: aliases.filter((a) => a.characterId === c.id).map((a) => a.alias),
        look: v ? [v.description.hair, v.description.eyes, v.description.wardrobe].filter(Boolean).join("; ") : "",
        // What poses and expressions should carry: how this person moves and reacts.
        distinctiveFeatures: v?.description.distinctiveFeatures ?? [],
        personality: v?.description.personality ?? "",
        visualMannerisms: v?.description.visualMannerisms ?? "",
        protagonist: analysis?.result?.protagonistKey === keyOf(c.analysisKey, c.name) || undefined,
        // Naming one of these in a panel's outfit dresses the character in it, reference image included.
        outfits: outfits.filter((o) => o.characterId === c.id).map((o) => o.name),
      })),
      locations: locs.map(({ l, v }) => ({
        key: keyOf(l.analysisKey, l.name),
        name: l.name,
        summary: v?.description.summary ?? "",
        // The planner is told to build foreground, midground and background from these.
        keyFeatures: v?.description.keyFeatures ?? [],
        lighting: v?.description.lighting ?? "",
      })),
      props: prs.map(({ p, v }) => ({
        key: keyOf(p.analysisKey, p.name),
        name: p.name,
        summary: v?.description.summary ?? "",
      })),
      relationships: (analysis?.result?.relationships ?? []).filter((r) => castKeys.has(r.from) && castKeys.has(r.to)),
      bible: bible && !bibleIsEmpty(bible) ? bible : undefined,
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
  job: ProjectJob,
  i: {
    format: ProjectFormat;
    templates: ReturnType<typeof planningTemplates>;
    data: Record<string, unknown>;
    chapterText: string;
  },
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
    i.templates.outline.build({
      ...base,
      targetPages: target,
    }),
    ChapterOutline,
    "ChapterOutline",
    16_000,
  );
  const pagesTemplate = i.templates.pages;
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

export async function chapterPlan(deps: WorkerDeps, job: ProjectJob) {
  const chapterId = String(job.input.chapterId);
  const { chapter, data } = await projectPlanningData(deps, job.projectId, chapterId);
  if (!chapter) throw new InputError("Chapter no longer exists");
  const [proj] = await deps.db
    .select({ settings: projects.settings })
    .from(projects)
    .where(eq(projects.id, job.projectId));
  const format: ProjectFormat = proj?.settings.format ?? "comic";
  const oneFrame = format === "film" || format === "vertical";
  const templates = planningTemplates({ format, filmFrame: proj?.settings.filmFrame });
  const messages = templates.plan.build({
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
    : await planByScene(deps, job, { format, templates, data, chapterText: chapter.sourceExcerpt || chapter.summary });
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

export async function pagePrompts(deps: WorkerDeps, job: ProjectJob) {
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
  const [scene] = page.sceneId
    ? await deps.db
        .select()
        .from(scenes)
        .where(and(eq(scenes.id, page.sceneId), eq(scenes.projectId, page.projectId)))
    : [];
  const charIds = [...new Set(pns.flatMap((p) => p.characterVersionIds))];
  const chars = charIds.length
    ? await deps.db
        .select({ id: characterVersions.id, name: characters.name, id2: characters.id })
        .from(characterVersions)
        .innerJoin(characters, eq(characters.id, characterVersions.characterId))
        .where(inArray(characterVersions.id, charIds))
    : [];
  // After a plan is applied, a spec names its cast, location and props by database id. Give the model their names
  // (and what the location and props look like) instead, or it cannot tell whose pose is whose.
  const specChars = await deps.db
    .select({ id: characters.id, name: characters.name })
    .from(characters)
    .where(eq(characters.projectId, page.projectId));
  const locIds = [...new Set(pns.map((p) => p.locationVersionId).filter((x): x is string => Boolean(x)))];
  const locs = locIds.length
    ? await deps.db
        .select({ id: locationVersions.id, name: locations.name, description: locationVersions.description })
        .from(locationVersions)
        .innerJoin(locations, eq(locations.id, locationVersions.locationId))
        .where(inArray(locationVersions.id, locIds))
    : [];
  const propIds = [...new Set(pns.flatMap((p) => p.propVersionIds))];
  const prs = propIds.length
    ? await deps.db
        .select({ id: propVersions.id, name: props.name, description: propVersions.description })
        .from(propVersions)
        .innerJoin(props, eq(props.id, propVersions.propId))
        .where(inArray(propVersions.id, propIds))
    : [];
  const lines = await deps.db
    .select({ panelId: dialogueLines.panelId, text: dialogueLines.text, speaker: characters.name })
    .from(dialogueLines)
    .leftJoin(characters, eq(characters.id, dialogueLines.characterId))
    .where(eq(dialogueLines.pageId, pageId))
    .orderBy(asc(dialogueLines.order));
  const nameOf = (id: unknown) => specChars.find((c) => c.id === id)?.name ?? id;
  const [chapterRow] = await deps.db
    .select({ order: chapters.order })
    .from(chapters)
    .where(eq(chapters.id, page.chapterId));
  const bible = chapterRow
    ? bibleFor(
        await loadBible(deps.db, page.projectId),
        { chapter: chapterRow.order, scene: scene?.order ?? null },
        {
          names: [...chars.map((c) => c.name), ...locs.map((l) => l.name), ...prs.map((p) => p.name)],
          text: pns.map((p) => p.storyBeat).join("\n"),
        },
      )
    : null;
  const readable = (spec: Record<string, unknown> | null) => {
    if (!spec) return null;
    const { locationId, propIds: _p, dialogueIds: _d, narrationIds: _n, sfxIds: _s, ...rest } = spec;
    return {
      ...rest,
      characters: ((spec.characters as Record<string, unknown>[] | undefined) ?? []).map((c) => ({
        ...c,
        characterId: undefined,
        name: nameOf(c.characterId),
      })),
    };
  };
  const context = {
    scene: scene
      ? {
          title: scene.title,
          summary: scene.summary,
          purpose: scene.purpose,
          time: scene.time,
          weather: scene.weather,
          continuityNotes: scene.continuityNotes,
          state: scene.initialState,
        }
      : null,
    page: {
      purpose: page.purpose,
      pacing: page.pacing,
      visualEmphasis: page.visualEmphasis,
      pageTurnHook: page.pageTurnHook,
    },
    artDirection: await projectArtDirection(deps, page.projectId),
    bible: bible && !bibleIsEmpty(bible) ? bible : undefined,
  };
  const panelData = pns.map((p) => ({
    panelId: p.id,
    order: p.order,
    shotType: p.shotType,
    cameraAngle: p.cameraAngle,
    beat: p.storyBeat,
    characters: p.characterVersionIds.map((v) => chars.find((c) => c.id === v)?.name).filter(Boolean),
    location: (() => {
      const l = locs.find((x) => x.id === p.locationVersionId);
      return l ? { name: l.name, summary: l.description.summary, keyFeatures: l.description.keyFeatures } : null;
    })(),
    props: prs
      .filter((x) => p.propVersionIds.includes(x.id))
      .map((x) => ({ name: x.name, summary: x.description.summary })),
    // What is said here shapes the acting, even though the text itself is never drawn by the model.
    dialogue: lines.filter((l) => l.panelId === p.id).map((l) => ({ speaker: l.speaker, text: l.text })),
    spec: readable([...specs].find((s) => s.panel_id === p.id)?.spec ?? null),
  }));
  const r = await structured(
    deps,
    job,
    panelPromptsV5.build({ context, panels: panelData }),
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
          templateName: panelPromptsV5.name,
          templateVersion: panelPromptsV5.version,
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

export async function narrationText(deps: WorkerDeps, job: ProjectJob) {
  const chapterId = String(job.input.chapterId);
  const [chapter] = await deps.db.select().from(chapters).where(eq(chapters.id, chapterId));
  if (!chapter) throw new InputError("Chapter no longer exists");
  const rows = await deps.db
    .select({
      id: panels.id,
      beat: panels.storyBeat,
      pageOrder: pages.order,
      order: panels.order,
      cast: panels.characterVersionIds,
      spec: sql<PanelSpec | null>`(select spec from panel_specs s where s.panel_id = ${panels.id} order by s.version_number desc limit 1)`,
    })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .where(eq(pages.chapterId, chapterId))
    .orderBy(asc(pages.order), asc(panels.order));
  // Who is in the chapter, so the narration names people rightly and gets their pronouns right; what they say and
  // feel on each panel; and where the story stood before it, so it does not re-introduce what the listener knows.
  const versionIds = [...new Set(rows.flatMap((r) => r.cast))];
  const cast = versionIds.length
    ? await deps.db
        .select({ versionId: characterVersions.id, id: characters.id, c: characters, v: characterVersions })
        .from(characterVersions)
        .innerJoin(characters, eq(characters.id, characterVersions.characterId))
        .where(inArray(characterVersions.id, versionIds))
    : [];
  const castAliases = cast.length
    ? await deps.db
        .select()
        .from(characterAliases)
        .where(
          inArray(
            characterAliases.characterId,
            cast.map((c) => c.id),
          ),
        )
    : [];
  const spoken = rows.length
    ? await deps.db
        .select({ panelId: dialogueLines.panelId, text: dialogueLines.text, speaker: characters.name })
        .from(dialogueLines)
        .leftJoin(characters, eq(characters.id, dialogueLines.characterId))
        .where(
          inArray(
            dialogueLines.panelId,
            rows.map((r) => r.id),
          ),
        )
        .orderBy(asc(dialogueLines.order))
    : [];
  const [prev] = await deps.db
    .select()
    .from(chapters)
    .where(and(eq(chapters.projectId, chapter.projectId), sql`${chapters.order} < ${chapter.order}`))
    .orderBy(sql`${chapters.order} desc`)
    .limit(1);
  const pns = rows.map((r) => ({
    id: r.id,
    beat: r.beat,
    pageOrder: r.pageOrder,
    order: r.order,
    emotion: r.spec?.emotion || undefined,
    dialogue: spoken.filter((d) => d.panelId === r.id).map((d) => ({ speaker: d.speaker, text: d.text })),
  }));
  const [project] = await deps.db
    .select({ settings: projects.settings, language: projects.language })
    .from(projects)
    .where(eq(projects.id, job.projectId));
  const wordsPerPanel = Number(
    job.input.wordsPerPanel ??
      (await runtimeWordsPerPanel(deps, job.projectId, project?.settings, String(job.input.chapterId), pns.length)) ??
      project?.settings.narrationWordsPerPanel ??
      21,
  );
  const language = String(job.input.language || project?.language || "en");
  const bible = bibleFor(
    await loadBible(deps.db, job.projectId),
    { chapter: chapter.order },
    {
      names: cast.map((c) => c.c.name),
      text: [chapter.title, chapter.summary, chapter.sourceExcerpt].join("\n"),
    },
  );
  // ponytail: one request per chapter; chapters over 200 panels get narration for the first 200 only.
  const promptPanels = pns.slice(0, 200);
  const r = await structured(
    deps,
    job,
    narrationV6.build({
      language: `${languageName(language)} (${language})`,
      context: {
        chapter: { title: chapter.title, summary: chapter.summary },
        previousChapter: prev
          ? { title: prev.title, closingState: prev.closingState, revealedFacts: prev.revealedFacts }
          : null,
        worldNotes: project?.settings.worldNotes,
        bible: bibleIsEmpty(bible) ? undefined : bible,
        characters: [...new Map(cast.map((c) => [c.id, c])).values()].map(({ c, v }) => ({
          name: c.name,
          role: c.role,
          aliases: castAliases.filter((a) => a.characterId === c.id).map((a) => a.alias),
          genderPresentation: v.description.genderPresentation,
        })),
      },
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
            textSha256: segmentTextSha(s.text, project?.settings.pronunciation),
            pauseAfterMs: s.pauseAfterMs,
          })),
        );
      n++;
    }
    await applyNarrationPauses(tx, chapterId, language, project?.settings ?? {});
    // The pipeline tracks narration in the project's own language; another language's lines say nothing about it.
    if (language === project?.language) await recordNarrationFingerprint(tx, chapterId);
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
export async function imageDescribe(deps: WorkerDeps, job: ProjectJob) {
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

/**
 * Proposes story bible facts and character states from the chapters (one, or all). The proposal stays on the job:
 * nothing is saved until the user reviews it and applies what they keep.
 */
/** Characters of chapter text an extraction sends in all, shared between its chapters. */
const EXTRACTION_TEXT_BUDGET = 120_000;

/**
 * What each chapter says, for reading facts out of it: its source text or summary when the analysis stored one,
 * otherwise its narration in reading order. A project built without an analysis (chapters planned by hand or by an
 * agent) has only the narration, and an extraction that read nothing returned an empty bible as if that were the
 * answer. Long chapters are cut to an even share of the budget so a whole-project run fits the model's context.
 */
async function chapterTextsForExtraction(
  deps: WorkerDeps,
  chs: { id: string; sourceExcerpt: string | null; summary: string | null }[],
  language: string,
) {
  const share = Math.floor(EXTRACTION_TEXT_BUDGET / Math.max(1, chs.length));
  const out: string[] = [];
  for (const c of chs) {
    let text = (c.sourceExcerpt || c.summary || "").trim();
    if (!text) {
      const rows = await deps.db.execute<{ text: string }>(sql`
        select nl.text from narration_lines nl
        left join panels pn on pn.id = nl.panel_id
        left join pages pg on pg.id = pn.page_id
        where nl.chapter_id = ${c.id} and nl.language = ${language}
        order by pg."order" nulls last, pn."order" nulls last, nl."order"`);
      text = [...rows].map((r) => r.text).join("\n");
    }
    out.push(text.length > share ? `${text.slice(0, share)}\n[…]` : text);
  }
  return out;
}

export async function bibleExtract(deps: WorkerDeps, job: ProjectJob) {
  const chapterId = job.input.chapterId ? String(job.input.chapterId) : null;
  const chs = await deps.db
    .select()
    .from(chapters)
    .where(and(eq(chapters.projectId, job.projectId), chapterId ? eq(chapters.id, chapterId) : undefined))
    .orderBy(asc(chapters.order));
  if (!chs.length) throw new InputError(chapterId ? "Chapter no longer exists" : "The project has no chapters yet");
  const cast = await deps.db
    .select({ id: characters.id, name: characters.name, role: characters.role })
    .from(characters)
    .where(and(eq(characters.projectId, job.projectId), isNull(characters.deletedAt)));
  const ids = cast.map((c) => c.id);
  const aliases = ids.length
    ? await deps.db.select().from(characterAliases).where(inArray(characterAliases.characterId, ids))
    : [];
  const outfits = ids.length
    ? await deps.db.select().from(characterOutfits).where(inArray(characterOutfits.characterId, ids))
    : [];
  const placeNames = await deps.db
    .select({ name: locations.name })
    .from(locations)
    .where(and(eq(locations.projectId, job.projectId), isNull(locations.deletedAt)));
  const propNames = await deps.db
    .select({ name: props.name })
    .from(props)
    .where(and(eq(props.projectId, job.projectId), isNull(props.deletedAt)));
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
  const [analysis] = await deps.db
    .select({ result: storyAnalyses.result })
    .from(storyAnalyses)
    .where(and(eq(storyAnalyses.projectId, job.projectId), eq(storyAnalyses.status, "applied")))
    .orderBy(desc(storyAnalyses.appliedAt))
    .limit(1);
  const existing = await loadBible(deps.db, job.projectId);
  const texts = await chapterTextsForExtraction(deps, chs, project?.language ?? "en");
  // With nothing to read, any model answers "no facts", which looks like a result; say what is missing instead.
  if (!texts.some((t) => t.trim()))
    throw new InputError(
      "These chapters have no text to read yet: no source text or summary, and no narration. Analyse the story or write the narration first.",
    );
  const r = await structured(
    deps,
    job,
    bibleExtractV1.build({
      projectData: {
        worldNotes: project?.settings.worldNotes,
        characters: cast.map((c) => ({
          name: c.name,
          role: c.role,
          aliases: aliases.filter((a) => a.characterId === c.id).map((a) => a.alias),
          outfits: outfits.filter((o) => o.characterId === c.id).map((o) => o.name),
        })),
        locations: placeNames.map((l) => l.name),
        props: propNames.map((p) => p.name),
        relationships: analysis?.result?.relationships ?? [],
        chapterMemory: chs.map((c) => ({
          chapter: c.order,
          characterStateChanges: c.characterStateChanges,
          locationStateChanges: c.locationStateChanges,
          revealedFacts: c.revealedFacts,
        })),
        existingBible: {
          facts: existing.facts.map((f) => `${f.subject ? `${f.subject}: ` : ""}${f.text}`),
          states: existing.states.map((s) => `${s.character} (${s.kind}): ${s.text}`),
        },
      },
      chapters: chs.map((c, i) => ({ number: c.order, title: c.title, text: texts[i] ?? "" })),
    }),
    BibleExtraction,
    "BibleExtraction",
    32_000,
  );
  return { chapterId, facts: r.data.facts.length, states: r.data.states.length, repaired: r.repaired, data: r.data };
}

/** Proposes the story timeline from the chapters (one, or all); the person reviews and applies it. */
export async function timelineExtract(deps: WorkerDeps, job: ProjectJob) {
  const chapterId = job.input.chapterId ? String(job.input.chapterId) : null;
  const chs = await deps.db
    .select()
    .from(chapters)
    .where(and(eq(chapters.projectId, job.projectId), chapterId ? eq(chapters.id, chapterId) : undefined))
    .orderBy(asc(chapters.order));
  if (!chs.length) throw new InputError(chapterId ? "Chapter no longer exists" : "The project has no chapters yet");
  const cast = await deps.db
    .select({ id: characters.id, name: characters.name, role: characters.role })
    .from(characters)
    .where(and(eq(characters.projectId, job.projectId), isNull(characters.deletedAt)));
  const ids = cast.map((c) => c.id);
  const aliases = ids.length
    ? await deps.db.select().from(characterAliases).where(inArray(characterAliases.characterId, ids))
    : [];
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
  const existing = await deps.db
    .select()
    .from(timelineEvents)
    .where(eq(timelineEvents.projectId, job.projectId))
    .orderBy(asc(timelineEvents.order));
  const texts = await chapterTextsForExtraction(deps, chs, project?.language ?? "en");
  if (!texts.some((t) => t.trim()))
    throw new InputError(
      "These chapters have no text to read yet: no source text or summary, and no narration. Analyse the story or write the narration first.",
    );
  const r = await structured(
    deps,
    job,
    timelineExtractV1.build({
      projectData: {
        characters: cast.map((c) => ({
          name: c.name,
          role: c.role,
          aliases: aliases.filter((a) => a.characterId === c.id).map((a) => a.alias),
        })),
        existingTimeline: existing.map((e) => ({ title: e.title, when: e.when, day: e.day })),
      },
      chapters: chs.map((c, i) => ({ number: c.order, title: c.title, text: texts[i] ?? "" })),
    }),
    TimelineExtraction,
    "TimelineExtraction",
    32_000,
  );
  return { chapterId, events: r.data.events.length, repaired: r.repaired, data: r.data };
}

/** Translates a chapter's bubbles and captions into the job's language and saves them (hand edits are kept). */
export async function letteringTranslate(deps: WorkerDeps, job: ProjectJob) {
  const chapterId = String(job.input.chapterId);
  const language = String(job.input.language);
  const [project] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
  if (!project) throw new InputError("Project no longer exists");
  if (language === project.language) throw new InputError("That is the project's own language");
  const lines = await chapterLettering(deps.db, chapterId, project.language);
  if (!lines.length) throw new InputError("This chapter has no bubbles or captions to translate");
  const refs = lines.map((l, i) => ({ ...l, ref: `${l.sourceType === "dialogue" ? "d" : "c"}${i + 1}` }));
  const cast = await deps.db
    .select({ name: characters.name })
    .from(characters)
    .where(and(eq(characters.projectId, job.projectId), isNull(characters.deletedAt)));
  const r = await structured(
    deps,
    job,
    letteringTranslateV1.build({
      language: { code: language, name: languageName(language) },
      source: { code: project.language, name: languageName(project.language) },
      cast,
      lines: refs.map((l) => ({
        ref: l.ref,
        kind: l.kind,
        speaker: l.speaker,
        text: l.text,
        maxChars: Math.max(12, Math.round(l.text.length * 1.3) + 8),
      })),
    }),
    LetteringTranslation,
    "LetteringTranslation",
    16_000,
  );
  const byRef = new Map(refs.map((l) => [l.ref, l]));
  const saved = await saveTranslations(
    deps.db,
    job.projectId,
    language,
    r.data.lines.flatMap((x) => {
      const l = byRef.get(x.ref);
      return l
        ? [{ sourceType: l.sourceType, sourceId: l.sourceId, text: x.text, original: l.text, edited: false }]
        : [];
    }),
  );
  return { chapterId, language, lines: lines.length, saved, repaired: r.repaired };
}

/** Panels listed to the model one by one, by ref; a bigger project is edited by chapter only. */
const VIDEO_EDIT_PANEL_LIMIT = 400; // ponytail: cap the prompt; list only the chapters an instruction names if needed

/**
 * "Edit the video in words": the project's timeline in brief (chapters with their shots and pauses, the cards and
 * settings, the panels by ref when there are not too many), the instruction, and back a list of edits by id, each
 * with what it would change now. Nothing is applied here: the user ticks, changes or rejects them.
 */
export async function videoEdit(deps: WorkerDeps, job: ProjectJob) {
  const instruction = String(job.input.instruction ?? "");
  const [p] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
  if (!p) throw new InputError("The project is gone");
  const chs = await deps.db
    .select({ id: chapters.id, order: chapters.order, title: chapters.title })
    .from(chapters)
    .where(eq(chapters.projectId, p.id))
    .orderBy(asc(chapters.order));
  if (!chs.length) throw new InputError("This project has no chapters yet");
  const pns = await deps.db
    .select({
      id: panels.id,
      order: panels.order,
      pageOrder: pages.order,
      chapterId: pages.chapterId,
      beat: panels.storyBeat,
      video: panels.video,
    })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .where(eq(panels.projectId, p.id))
    .orderBy(asc(pages.order), asc(panels.order));
  const pauses = await deps.db
    .select({ chapterId: narrationLines.chapterId, ms: narrationSegments.pauseAfterMs })
    .from(narrationSegments)
    .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
    .where(eq(narrationSegments.projectId, p.id));
  const orderOf = new Map(chs.map((c) => [c.id, c.order]));
  const refOf = (x: (typeof pns)[number]) => `c${orderOf.get(x.chapterId)}-p${x.pageOrder}-n${x.order}`;
  const v = p.settings.video;
  const video = {
    chapters: chs.map((c) => {
      const ms = pauses.filter((x) => x.chapterId === c.id).map((x) => x.ms);
      return {
        chapter: c.order,
        title: c.title,
        shots: pns.filter((x) => x.chapterId === c.id).length,
        pauses: ms.length,
        longestPauseMs: ms.length ? Math.max(...ms) : 0,
        averagePauseMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : 0,
        shotsWithOwnHold: pns.filter((x) => x.chapterId === c.id && x.video?.holdMs != null).length,
      };
    }),
    intro: v?.intro ?? null,
    outro: v?.outro ?? null,
    chapterCards: (v?.chapterCards ?? []).flatMap((c) =>
      orderOf.has(c.chapterId) ? [{ chapter: orderOf.get(c.chapterId), title: c.title }] : [],
    ),
    sceneFades: v?.fadeAtSceneBreaks ?? false,
    panels:
      pns.length <= VIDEO_EDIT_PANEL_LIMIT
        ? pns.map((x) => ({
            ref: refOf(x),
            beat: x.beat.slice(0, 100),
            ...(x.video?.disabled ? { disabled: true } : {}),
            ...(x.video?.motion && x.video.motion !== "auto" ? { motion: x.video.motion } : {}),
            ...(x.video?.holdMs != null ? { holdMs: x.video.holdMs } : {}),
          }))
        : `Too many panels to list (${pns.length}); edit by chapter.`,
  };
  const r = await structured(
    deps,
    job,
    videoEditV1.build({ instruction, video }),
    VideoEditPlan,
    "VideoEditPlan",
    8_000,
  );
  const idOfChapter = new Map(chs.map((c) => [c.order, c.id]));
  const idOfRef = new Map(pns.map((x) => [refOf(x), x.id]));
  const edits: { op: VideoEditOp; label: string; effect: string; changes: number }[] = [];
  const dropped: string[] = [];
  for (const o of r.data.ops) {
    const chapterId = o.chapter == null ? null : (idOfChapter.get(o.chapter) ?? undefined);
    if (chapterId === undefined) {
      dropped.push(`${o.op}: there is no chapter ${o.chapter}`);
      continue;
    }
    let op: VideoEditOp | null = null;
    if (o.op === "pauses" && (o.maxPauseMs != null || o.pauseScale != null))
      op = { op: "pauses", chapterId, maxPauseMs: o.maxPauseMs, pauseScale: o.pauseScale };
    else if (o.op === "holds") op = { op: "holds", chapterId, holdMs: o.holdMs };
    else if (o.op === "shot") {
      const panelId = o.panel ? idOfRef.get(o.panel) : undefined;
      if (panelId)
        op = {
          op: "shot",
          panelId,
          ...(o.disabled != null ? { disabled: o.disabled } : {}),
          ...(o.motion ? { motion: o.motion } : {}),
          ...(o.fade ? { fade: o.fade } : {}),
        };
      else dropped.push(`shot: there is no panel ${o.panel ?? "(none given)"}`);
    } else if (o.op === "card" && o.card && (o.card !== "chapter" || chapterId))
      op = {
        op: "card",
        which: o.card,
        chapterId: o.card === "chapter" ? chapterId : null,
        card: cardOf(o.title, o.subtitle, o.seconds),
      };
    else if (o.op === "scene_fades" && o.on != null) op = { op: "scene_fades", on: o.on };
    if (!op) {
      if (o.op !== "shot") dropped.push(`${o.op}: incomplete`);
      continue;
    }
    try {
      const res = await resolveVideoEdit(deps.db, p, op);
      edits.push({ op, label: res.label, effect: res.effect, changes: res.changes });
    } catch (e) {
      dropped.push(`${o.op}: ${(e as Error).message}`);
    }
  }
  return { instruction, summary: r.data.summary, edits, dropped, repaired: r.repaired };
}
