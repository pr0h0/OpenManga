import {
  and,
  chapters,
  characterAliases,
  characterOutfits,
  characters,
  characterVersions,
  type Database,
  dialogueLines,
  eq,
  inArray,
  isNull,
  locations,
  locationVersions,
  narrationLines,
  narrationSegments,
  outfitAssignments,
  pages,
  panelSpecs,
  panels,
  projects,
  props,
  propVersions,
  scenes,
  soundEffects,
  sql,
  storyAnalyses,
  storyBeats,
  storyRevisions,
  type Tx,
} from "@openmanga/db";
import {
  clampFrame,
  customLayoutFrames,
  customLayoutKey,
  defaultTailTarget,
  defaultTemplateForCount,
  draftBubble,
  faceAvoidZone,
  layoutByKey,
  pickLayout,
  placeBubble,
  quadrantFromArea,
  type ResolvedLettering,
  resolveLettering,
  segmentNarration,
  segmentTextSha,
  templateFrames,
} from "@openmanga/domain";
import {
  Bubble,
  type ChapterPlan,
  type Frame,
  PanelSpec,
  type PlannedLettering,
  SfxStyle,
  type StoryAnalysis,
  stripPageHeight,
} from "@openmanga/schemas";
import { outfitNamedIn, outfitTimeline } from "./outfits.ts";
import { recordNarrationFingerprint, recordPlanFingerprint } from "./staleness.ts";

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

/** Locate each chapter's source text using the `sourceStart` hints; falls back to even split. */
export function sliceChapters(story: string, starts: string[]): string[] {
  if (starts.length <= 1) return [story];
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  const hay = story;
  const positions = starts.map((st, i) => {
    if (i === 0) return 0;
    const words = norm(st).split(" ").slice(0, 8).join(" ");
    if (!words) return -1;
    const re = new RegExp(
      words
        .split(" ")
        .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("\\s+"),
      "i",
    );
    return hay.search(re);
  });
  const ok = positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1]!));
  if (!ok) {
    const size = Math.ceil(story.length / starts.length);
    return starts.map((_, i) => story.slice(i * size, (i + 1) * size));
  }
  return positions.map((p, i) => story.slice(p, positions[i + 1] ?? story.length).trim());
}

type ExistingChapter = { id: string; title: string; order: number; storyAnalysisId: string | null };

const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * How an analysis's chapters line up with a project's existing ones, so applying it again never loses work. A
 * chapter with the same title is kept (and updated); one at the same position whose title the new analysis no longer
 * has, and that an analysis made, is renamed; the rest are added. Existing chapters left over are `unmatched`: they
 * stay unless their removal is confirmed separately. `order` is the final sequence: the analysis's chapters in its
 * order, each unmatched chapter right after the chapter it used to follow.
 */
export function mergeChapters(existing: ExistingChapter[], next: { title: string }[]) {
  const old = [...existing].sort((a, b) => a.order - b.order);
  const taken = new Set<string>();
  const match: (ExistingChapter | null)[] = next.map((ch) => {
    const e = old.find((x) => !taken.has(x.id) && sameTitle(x.title, ch.title));
    if (e) taken.add(e.id);
    return e ?? null;
  });
  const titles = next.map((c) => c.title);
  next.forEach((_, i) => {
    if (match[i]) return;
    const e = old[i];
    if (e && !taken.has(e.id) && e.storyAnalysisId && !titles.some((t) => sameTitle(t, e.title))) {
      taken.add(e.id);
      match[i] = e;
    }
  });
  const chapters = next.map((ch, i) => {
    const e = match[i];
    return {
      index: i,
      title: ch.title,
      existingId: e?.id ?? null,
      kind: !e ? ("added" as const) : sameTitle(e.title, ch.title) ? ("kept" as const) : ("renamed" as const),
      fromTitle: e?.title,
    };
  });
  const unmatched = old.filter((e) => !taken.has(e.id));
  // The final sequence: the analysis order, each leftover chapter after the nearest earlier chapter it followed.
  const order: ({ existingId: string } | { index: number })[] = chapters.map((c) =>
    c.existingId ? { existingId: c.existingId } : { index: c.index },
  );
  const leftover = new Set(unmatched.map((u) => u.id));
  const at = (id: string) => order.findIndex((o) => "existingId" in o && o.existingId === id);
  for (const u of unmatched) {
    const anchor = old
      .slice(0, old.indexOf(u))
      .reverse()
      .find((b) => at(b.id) >= 0);
    // After the anchor and after leftovers already placed there, so leftovers keep their own order.
    let i = anchor ? at(anchor.id) + 1 : 0;
    while (
      i < order.length &&
      "existingId" in order[i]! &&
      leftover.has((order[i] as { existingId: string }).existingId)
    )
      i++;
    order.splice(i, 0, { existingId: u.id });
  }
  return { chapters, unmatched, order };
}

/**
 * What applying an analysis would change in its project, for the review before it is applied. Chapters line up as
 * `mergeChapters` lines them up: kept (with `textChanged` when the story under them changed), renamed, added, and
 * removed — chapters an analysis made that the new one no longer has, with their pages and drawn panels, which apply
 * keeps unless their removal is confirmed. Characters, locations and props are added (new to the project) or removed
 * (made by an analysis and absent from this one; apply keeps them too).
 */
export async function analysisDiff(db: Database, analysisId: string, edited?: StoryAnalysis) {
  const [analysis] = await db.select().from(storyAnalyses).where(eq(storyAnalyses.id, analysisId));
  if (!analysis) throw new Error("Analysis not found");
  const result = edited ?? analysis.result;
  if (!result) throw new Error("Analysis has no result");
  const projectId = analysis.projectId;
  const [rev] = await db.select().from(storyRevisions).where(eq(storyRevisions.id, analysis.storyRevisionId));
  const existing = await db
    .select({
      id: chapters.id,
      title: chapters.title,
      order: chapters.order,
      storyAnalysisId: chapters.storyAnalysisId,
      sourceExcerpt: chapters.sourceExcerpt,
      pages: sql<number>`(select count(*)::int from pages p where p.chapter_id = "chapters"."id")`,
      drawn: sql<number>`(select count(*)::int from panels pn join pages p on p.id = pn.page_id
        where p.chapter_id = "chapters"."id" and pn.active_artwork_asset_id is not null)`,
    })
    .from(chapters)
    .where(eq(chapters.projectId, projectId));
  const merge = mergeChapters(existing, result.chapters);
  const texts = sliceChapters(
    rev?.content ?? "",
    result.chapters.map((c) => c.sourceStart),
  );
  const byId = new Map(existing.map((e) => [e.id, e]));
  const work = (id: string) => ({ pages: byId.get(id)!.pages, drawnPanels: byId.get(id)!.drawn });
  type Named = { id: string; name: string; analysisKey: string | null; deletedAt: Date | null };
  // Added: what apply would create. Removed: what an analysis made and this one no longer mentions at all.
  const named = (all: Named[], mentioned: { key: string; name: string }[], created = mentioned) => {
    const rows = all.filter((r) => !r.deletedAt);
    const is = (r: Named, n: { key: string; name: string }) =>
      r.analysisKey === n.key || r.name.toLowerCase() === n.name.toLowerCase();
    return {
      added: created.filter((n) => !rows.some((r) => is(r, n))).map((n) => n.name),
      removed: rows
        .filter((r) => r.analysisKey && !mentioned.some((n) => is(r, n)))
        .map((r) => ({ id: r.id, name: r.name })),
    };
  };
  return {
    hasExisting: existing.length > 0,
    chapters: {
      kept: merge.chapters
        .filter((c) => c.kind === "kept")
        .map((c) => ({
          id: c.existingId!,
          title: c.title,
          textChanged: (byId.get(c.existingId!)!.sourceExcerpt ?? "").trim() !== (texts[c.index] ?? "").trim(),
          ...work(c.existingId!),
        })),
      renamed: merge.chapters
        .filter((c) => c.kind === "renamed")
        .map((c) => ({ id: c.existingId!, from: c.fromTitle!, to: c.title, ...work(c.existingId!) })),
      added: merge.chapters.filter((c) => c.kind === "added").map((c) => ({ title: c.title, position: c.index + 1 })),
      removed: merge.unmatched
        .filter((u) => u.storyAnalysisId)
        .map((u) => ({ id: u.id, title: u.title, ...work(u.id) })),
    },
    characters: named(await db.select().from(characters).where(eq(characters.projectId, projectId)), result.characters),
    locations: named(await db.select().from(locations).where(eq(locations.projectId, projectId)), result.locations),
    // Only recurring props are created, but any mention keeps an existing one.
    props: named(
      await db.select().from(props).where(eq(props.projectId, projectId)),
      result.props,
      result.props.filter((p) => p.recurring),
    ),
  };
}

/**
 * Creates the cast, world and chapters of an analysis in its project. Applying to a project that already has them
 * (a revised story's analysis, or the same one again) is additive: characters, locations and props are matched by
 * key or name and never changed; chapters line up as `mergeChapters` says — kept and renamed chapters keep their pages
 * and get the new summary, beats and source text, new chapters are inserted at their place, and chapters the
 * analysis no longer has stay where they were. Nothing is removed here: `analysisDiff` lists what the new analysis
 * drops, and removing it is a separate, confirmed step.
 */
export async function applyStoryAnalysis(
  db: Database,
  analysisId: string,
  userId: string | null,
  edited?: StoryAnalysis,
) {
  return db.transaction(async (tx) => {
    const [analysis] = await tx.select().from(storyAnalyses).where(eq(storyAnalyses.id, analysisId));
    if (!analysis) throw new Error("Analysis not found");
    const result = edited ?? analysis.result;
    if (!result) throw new Error("Analysis has no result");
    const [rev] = await tx.select().from(storyRevisions).where(eq(storyRevisions.id, analysis.storyRevisionId));
    const projectId = analysis.projectId;
    const created = { characters: 0, locations: 0, props: 0, chapters: 0, renamed: 0 };

    const existingChars = await tx
      .select()
      .from(characters)
      .where(and(eq(characters.projectId, projectId), isNull(characters.deletedAt)));
    for (const c of result.characters) {
      const match = existingChars.find((e) => e.analysisKey === c.key || e.name.toLowerCase() === c.name.toLowerCase());
      const charId = match?.id ?? (await createCharacter(tx, projectId, userId, c)).id;
      if (!match) created.characters++;
      const aliases = [
        ...new Set(c.aliases.map((a) => a.trim()).filter((a) => a && a.toLowerCase() !== c.name.toLowerCase())),
      ];
      if (aliases.length)
        await tx
          .insert(characterAliases)
          .values(aliases.map((alias) => ({ characterId: charId, alias })))
          .onConflictDoNothing();
    }

    const existingLocs = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.projectId, projectId), isNull(locations.deletedAt)));
    for (const l of result.locations) {
      if (existingLocs.some((e) => e.analysisKey === l.key || e.name.toLowerCase() === l.name.toLowerCase())) continue;
      const [loc] = await tx.insert(locations).values({ projectId, name: l.name, analysisKey: l.key }).returning();
      const [v] = await tx
        .insert(locationVersions)
        .values({ locationId: loc!.id, versionNumber: 1, description: l.description, createdByUserId: userId })
        .returning();
      await tx.update(locations).set({ currentVersionId: v!.id }).where(eq(locations.id, loc!.id));
      created.locations++;
    }

    const existingProps = await tx
      .select()
      .from(props)
      .where(and(eq(props.projectId, projectId), isNull(props.deletedAt)));
    for (const p of result.props.filter((p) => p.recurring)) {
      if (existingProps.some((e) => e.analysisKey === p.key || e.name.toLowerCase() === p.name.toLowerCase())) continue;
      const [pr] = await tx.insert(props).values({ projectId, name: p.name, analysisKey: p.key }).returning();
      const [v] = await tx
        .insert(propVersions)
        .values({ propId: pr!.id, versionNumber: 1, description: p.description, createdByUserId: userId })
        .returning();
      await tx.update(props).set({ currentVersionId: v!.id }).where(eq(props.id, pr!.id));
      created.props++;
    }

    const existingChapters = await tx.select().from(chapters).where(eq(chapters.projectId, projectId));
    const texts = sliceChapters(
      rev?.content ?? "",
      result.chapters.map((c) => c.sourceStart),
    );
    const merge = mergeChapters(existingChapters, result.chapters);
    const ids = new Map<number, string>();
    for (const m of merge.chapters) {
      const ch = result.chapters[m.index]!;
      const fields = {
        storyAnalysisId: analysis.id,
        title: ch.title,
        summary: ch.summary,
        sourceExcerpt: texts[m.index] ?? "",
        beats: ch.beats,
      };
      if (m.existingId) {
        await tx.update(chapters).set(fields).where(eq(chapters.id, m.existingId));
        ids.set(m.index, m.existingId);
        if (m.kind === "renamed") created.renamed++;
        continue;
      }
      const [row] = await tx
        .insert(chapters)
        .values({ projectId, order: 0, ...fields })
        .returning({ id: chapters.id });
      ids.set(m.index, row!.id);
      created.chapters++;
    }
    // Number every chapter in its final place: the analysis's order, with the chapters it no longer has where they were.
    for (const [n, o] of merge.order.entries())
      await tx
        .update(chapters)
        .set({ order: n + 1 })
        .where(eq(chapters.id, "existingId" in o ? o.existingId : ids.get(o.index)!));

    const [project] = await tx.select().from(projects).where(eq(projects.id, projectId));
    // The cover is drawn from the project's description; an empty one takes the story's summary.
    if (project && !project.description.trim() && result.summary)
      await tx.update(projects).set({ description: result.summary }).where(eq(projects.id, projectId));
    if (project && !project.settings.worldNotes) {
      const w = result.world;
      const notes = [
        result.setting && `Setting: ${result.setting} (${result.period})`,
        w.worldRules.length && `World rules: ${w.worldRules.join("; ")}`,
        w.technology && `Technology: ${w.technology}`,
        w.magicSystem && `Magic: ${w.magicSystem}`,
        w.factions.length && `Factions: ${w.factions.map((f) => `${f.name} — ${f.description}`).join("; ")}`,
        result.visualMotifs.length && `Visual motifs: ${result.visualMotifs.join(", ")}`,
        // The rest of the world the analysis read out of the story: planners and narration see these notes.
        w.uniforms.length && `Uniforms: ${w.uniforms.join("; ")}`,
        w.recurringScenery.length && `Recurring scenery: ${w.recurringScenery.join("; ")}`,
        w.vehicles.length && `Vehicles: ${w.vehicles.join("; ")}`,
        (result.genre || result.tone) &&
          `Genre and tone: ${[result.genre, result.subgenre, result.tone].filter(Boolean).join(", ")}`,
        result.themes.length && `Themes: ${result.themes.join(", ")}`,
        w.notes && `Notes: ${w.notes}`,
      ]
        .filter(Boolean)
        .join("\n");
      await tx
        .update(projects)
        .set({ settings: { ...project.settings, worldNotes: notes } })
        .where(eq(projects.id, projectId));
    }
    await tx
      .update(storyAnalyses)
      .set({ status: "applied", appliedAt: new Date(), result })
      .where(eq(storyAnalyses.id, analysisId));
    return created;
  });
}

async function createCharacter(
  tx: Tx,
  projectId: string,
  userId: string | null,
  c: StoryAnalysis["characters"][number],
) {
  const [ch] = await tx
    .insert(characters)
    .values({ projectId, name: c.name, role: c.role, analysisKey: c.key })
    .returning();
  const [v] = await tx
    .insert(characterVersions)
    .values({
      characterId: ch!.id,
      versionNumber: 1,
      description: c.bible,
      immutableTraits: c.bible.immutableTraits,
      createdByUserId: userId,
      changeNote: "Extracted by story analysis",
    })
    .returning();
  await tx.update(characters).set({ currentVersionId: v!.id }).where(eq(characters.id, ch!.id));
  const outfits = [
    { name: "Default", description: c.bible.wardrobe, isDefault: true },
    ...c.bible.outfitVariants.map((o) => ({ ...o, isDefault: false })),
  ].filter((o) => o.description);
  if (outfits.length)
    await tx
      .insert(characterOutfits)
      .values(outfits.map((o) => ({ characterId: ch!.id, characterVersionId: v!.id, ...o })));
  return ch!;
}

const bubbleKind = (k: string) => (["normal", "thought", "shout", "whisper"].includes(k) ? (k as "normal") : "normal");

type Rect = { x: number; y: number; width: number; height: number };

/**
 * Letters one panel from its plan: each line of dialogue becomes a bubble placed where the plan asked (its preferred
 * quadrant, else the panel's planned negative space), clear of faces and of everything already in `placed`, which it
 * extends; each SFX is set in the lower right. Used when a plan is applied with auto-placement on, and later by
 * "letter from plan" on a page whose plan was kept.
 */
export async function letterPanel(
  tx: Tx,
  a: {
    projectId: string;
    page: { id: string; width: number; height: number };
    panel: { id: string; frame: Frame; shotType: string };
    lettering: ResolvedLettering;
    readingDirection: "ltr" | "rtl" | "vertical";
    planned: PlannedLettering;
    /** Where each character stands in the frame, by character id: the bubble's tail points there. */
    positions: Map<string, string | undefined>;
    negativeSpace?: string;
    placed: Rect[];
    firstOrder?: number;
  },
): Promise<{ dialogueIds: string[]; sfxIds: string[] }> {
  const { page, panel, lettering } = a;
  const avoid = [...faceAvoidZone(panel.frame, panel.shotType), ...a.placed];
  const planSpace = quadrantFromArea(a.negativeSpace);
  const dialogueIds: string[] = [];
  for (const d of a.planned.dialogue) {
    const draft = draftBubble(d.text, bubbleKind(d.kind), lettering, page.width, page.height, panel.frame.width);
    const rect = placeBubble({
      panel: panel.frame,
      text: d.text,
      fontSize: draft.bubble.fontSize,
      pageW: page.width,
      pageH: page.height,
      preferred: d.preferredQuadrant ?? planSpace,
      avoid,
      readingDirection: a.readingDirection,
      size: draft.size,
    });
    a.placed.push(rect);
    avoid.push(rect);
    const bubble = Bubble.parse({
      ...draft.bubble,
      ...rect,
      tailTarget: defaultTailTarget(rect, panel.frame, d.speakerId ? a.positions.get(d.speakerId) : undefined),
    });
    const [dl] = await tx
      .insert(dialogueLines)
      .values({
        projectId: a.projectId,
        pageId: page.id,
        panelId: panel.id,
        characterId: d.speakerId,
        order: (a.firstOrder ?? 0) + dialogueIds.length,
        text: d.text,
        bubble,
      })
      .returning({ id: dialogueLines.id });
    dialogueIds.push(dl!.id);
  }
  const sfxIds: string[] = [];
  for (const [k, text] of a.planned.sfx.entries()) {
    const style = SfxStyle.parse({
      ...lettering.sfx,
      x: Math.min(0.95, panel.frame.x + panel.frame.width * (0.6 + 0.1 * k)),
      y: Math.min(0.95, panel.frame.y + panel.frame.height * 0.7),
    });
    const [sf] = await tx
      .insert(soundEffects)
      .values({ projectId: a.projectId, pageId: page.id, panelId: panel.id, text, style })
      .returning({ id: soundEffects.id });
    sfxIds.push(sf!.id);
  }
  return { dialogueIds, sfxIds };
}

export async function applyChapterPlan(db: Database, chapterId: string, plan: ChapterPlan, opts: { replace: boolean }) {
  return db.transaction(async (tx) => {
    const [chapter] = await tx.select().from(chapters).where(eq(chapters.id, chapterId));
    if (!chapter) throw new Error("Chapter not found");
    const [project] = await tx.select().from(projects).where(eq(projects.id, chapter.projectId));
    if (!project) throw new Error("Project not found");
    const existingPages = await tx.select({ id: pages.id }).from(pages).where(eq(pages.chapterId, chapterId));
    if (existingPages.length && !opts.replace) {
      await tx.update(chapters).set({ lastPlan: plan }).where(eq(chapters.id, chapterId));
      return { applied: false, pages: 0, panels: 0 };
    }
    if (existingPages.length) {
      await tx.delete(narrationLines).where(
        and(
          eq(narrationLines.chapterId, chapterId),
          inArray(
            narrationLines.pageId,
            existingPages.map((p) => p.id),
          ),
        ),
      );
      await tx.delete(pages).where(eq(pages.chapterId, chapterId));
    }
    await tx.delete(scenes).where(eq(scenes.chapterId, chapterId));

    const chars = await tx
      .select({ c: characters })
      .from(characters)
      .where(and(eq(characters.projectId, project.id), isNull(characters.deletedAt)));
    const aliasRows = chars.length
      ? await tx
          .select()
          .from(characterAliases)
          .where(
            inArray(
              characterAliases.characterId,
              chars.map((c) => c.c.id),
            ),
          )
      : [];
    const findChar = (key: string) => {
      const k = key.toLowerCase();
      return (
        chars.find(
          ({ c }) => c.id === key || c.analysisKey === key || slug(c.name) === slug(key) || c.name.toLowerCase() === k,
        )?.c ?? chars.find(({ c }) => aliasRows.some((a) => a.characterId === c.id && a.alias.toLowerCase() === k))?.c
      );
    };
    const locs = await tx
      .select()
      .from(locations)
      .where(and(eq(locations.projectId, project.id), isNull(locations.deletedAt)));
    const findLoc = (key?: string) =>
      key ? locs.find((l) => l.id === key || l.analysisKey === key || slug(l.name) === slug(key)) : undefined;
    const prps = await tx
      .select()
      .from(props)
      .where(and(eq(props.projectId, project.id), isNull(props.deletedAt)));
    const findProp = (key: string) =>
      prps.find((p) => p.id === key || p.analysisKey === key || slug(p.name) === slug(key));

    // Outfits the plan names switch the character from that panel on, like a change set in the editor. Each
    // character starts the chapter in whatever the chapters before it left them in.
    const outfitRows = chars.length
      ? await tx
          .select()
          .from(characterOutfits)
          .where(
            inArray(
              characterOutfits.characterId,
              chars.map(({ c }) => c.id),
            ),
          )
      : [];
    const wearing = new Map<string, string>();
    for (const t of await outfitTimeline(
      tx,
      chars.map(({ c }) => c.id),
    ))
      if (t.scope === "onward" && t.chapterOrder < chapter.order) wearing.set(t.characterId, t.outfitId);

    const s = project.settings;
    const lettering = resolveLettering(s);
    const dir = project.readingDirection;
    /** How many pages of each panel count took one of the project's layouts so far: the next takes the next one. */
    const customSeen = new Map<number, number>();
    let pageOrder = 0;
    let lineOrder = 0;
    let panelCount = 0;

    for (const [si, sc] of plan.scenes.entries()) {
      const loc = findLoc(sc.locationKey);
      const [scene] = await tx
        .insert(scenes)
        .values({
          projectId: project.id,
          chapterId,
          order: si + 1,
          title: sc.title,
          summary: sc.summary,
          locationId: loc?.id ?? null,
          time: sc.time,
          weather: sc.weather,
          characterIds: sc.characterKeys.map((k) => findChar(k)?.id).filter((x): x is string => Boolean(x)),
          purpose: sc.purpose,
          opening: sc.opening,
          progression: sc.progression,
          climax: sc.climax,
          ending: sc.ending,
          continuityNotes: sc.continuityNotes,
          initialState: sc.initialState,
          finalState: sc.finalState,
          continuityDeltas: sc.continuityDeltas,
        })
        .returning();
      if (sc.beats.length)
        await tx
          .insert(storyBeats)
          .values(
            sc.beats.map((b, i) => ({ projectId: project.id, sceneId: scene!.id, order: i + 1, description: b })),
          );

      // One panel per page for film (each is a shot) and for vertical strips, where the strip discards page
      // geometry anyway: one panel per page leaves each panel's height free and makes the seam between two
      // panels unambiguous, instead of some seams being gutters inside a page and others page boundaries.
      const oneFramePerPage = project.settings.format === "film" || project.settings.format === "vertical";
      const plannedPages = oneFramePerPage
        ? sc.pages.flatMap((pg) => pg.panels.map((pp) => ({ ...pg, panels: [pp], layoutTemplate: "full-page" })))
        : sc.pages;
      for (const pg of plannedPages) {
        const n = pg.panels.length;
        // The project's own layouts come first: each new page takes one with its panel count, in turn.
        const custom = oneFramePerPage ? null : pickLayout(s.layouts, n, customSeen.get(n) ?? 0);
        if (custom) customSeen.set(n, (customSeen.get(n) ?? 0) + 1);
        const tpl = layoutByKey(pg.layoutTemplate);
        const template = tpl && tpl.frames.length === n ? tpl : defaultTemplateForCount(n);
        let frames = custom
          ? customLayoutFrames(custom, dir).map(clampFrame)
          : templateFrames(template.key, {
              margin: s.pageMargin,
              gutter: s.pageGutter,
              readingDirection: dir,
            });
        if (frames.length < n) {
          const rowH = (1 - s.pageMargin * 2) / n;
          frames = Array.from({ length: n }, (_, i) => ({
            x: s.pageMargin,
            y: s.pageMargin + i * rowH,
            width: 1 - s.pageMargin * 2,
            height: rowH - s.pageGutter,
          }));
        }
        // A strip panel's height is its pacing, and it fills its own page, so the pacing lives on the page. Read
        // before the insert because the page has to exist before its panel does.
        const stripPanel = oneFramePerPage && project.settings.format === "vertical" ? pg.panels[0] : null;
        const stripHeight = stripPanel ? PanelSpec.safeParse(stripPanel.spec) : null;
        const [page] = await tx
          .insert(pages)
          .values({
            projectId: project.id,
            chapterId,
            sceneId: scene!.id,
            order: ++pageOrder,
            purpose: pg.purpose,
            pacing: pg.pacing,
            visualEmphasis: pg.visualEmphasis,
            pageTurnHook: pg.pageTurnHook,
            layoutTemplate: custom
              ? customLayoutKey(custom.id)
              : frames.length === template.frames.length
                ? template.key
                : null,
            width: s.pageWidth,
            height:
              stripHeight?.success === true ? stripPageHeight(s.pageWidth, stripHeight.data.height) : s.pageHeight,
          })
          .returning();
        const placed: { x: number; y: number; width: number; height: number }[] = [];

        for (const [pi, pp] of pg.panels.entries()) {
          const frame = frames[pi]!;
          const spec = PanelSpec.parse(pp.spec);
          const panelChars = spec.characters.map((pc) => ({ pc, ch: findChar(pc.characterId) })).filter((x) => x.ch);
          const panelLoc = findLoc(spec.locationId) ?? loc;
          const propVersionIds = spec.propIds
            .map((k) => findProp(k)?.currentVersionId)
            .filter((x): x is string => Boolean(x));
          const [panel] = await tx
            .insert(panels)
            .values({
              projectId: project.id,
              pageId: page!.id,
              sceneId: scene!.id,
              order: pi + 1,
              frame,
              shotType: spec.shotType,
              cameraAngle: spec.cameraAngle,
              storyBeat: spec.beat,
              // Only a strip reads seams; a paged project storing one would be inert but misleading.
              seam: project.settings.format === "vertical" ? (spec.seam ?? null) : null,
              locationVersionId: panelLoc?.currentVersionId ?? null,
              characterVersionIds: [
                ...new Set(panelChars.map((x) => x.ch!.currentVersionId).filter((x): x is string => Boolean(x))),
              ],
              propVersionIds,
            })
            .returning();
          panelCount++;
          for (const { pc, ch } of panelChars) {
            const mine = outfitRows.filter((o) => o.characterId === ch!.id);
            const named = outfitNamedIn(mine, pc.outfit);
            const current = wearing.get(ch!.id) ?? mine.find((o) => o.isDefault)?.id;
            if (!named || named.id === current) continue;
            // "panel" dresses this panel only and leaves what the character is wearing from here on alone.
            const scope = pc.outfitScope === "panel" ? "panel" : "onward";
            await tx
              .insert(outfitAssignments)
              .values({ projectId: project.id, characterId: ch!.id, outfitId: named.id, panelId: panel!.id, scope })
              .onConflictDoNothing();
            if (scope === "onward") wearing.set(ch!.id, named.id);
          }

          // Speakers resolved to characters now, so a plan kept for later letters the same way.
          const planned: PlannedLettering = {
            dialogue: pp.dialogue.map((d) => ({
              speakerId: (d.speaker ? findChar(d.speaker)?.id : undefined) ?? null,
              text: d.text,
              kind: d.kind,
              preferredQuadrant: d.preferredQuadrant,
            })),
            sfx: pp.sfx,
          };
          const lettered = lettering.autoPlace
            ? await letterPanel(tx, {
                projectId: project.id,
                page: page!,
                panel: { id: panel!.id, frame, shotType: spec.shotType },
                lettering,
                readingDirection: dir,
                planned,
                positions: new Map(panelChars.map((x) => [x.ch!.id, x.pc.position])),
                negativeSpace: spec.negativeSpace?.area,
                placed,
              })
            : { dialogueIds: [], sfxIds: [] };
          if (!lettering.autoPlace && (planned.dialogue.length || planned.sfx.length))
            await tx.update(panels).set({ plannedLettering: planned }).where(eq(panels.id, panel!.id));
          const dialogueIds = lettered.dialogueIds;
          const avoid = [...faceAvoidZone(frame, spec.shotType), ...placed];
          const narrationIds: string[] = [];
          for (const text of pp.narration) {
            let box: Bubble | null = null;
            if (lettering.autoPlace) {
              const draft = draftBubble(text, "narration", lettering, page!.width, page!.height, frame.width);
              // Captions read first: prefer the reading-order top corner, but never cover bubbles or faces.
              const rect = placeBubble({
                panel: frame,
                text,
                fontSize: draft.bubble.fontSize,
                pageW: page!.width,
                pageH: page!.height,
                preferred: dir === "rtl" ? "top-right" : "top-left",
                avoid,
                readingDirection: dir,
                size: {
                  width: Math.min(frame.width - 0.02, draft.size.width),
                  height: Math.min(frame.height * 0.5, draft.size.height),
                },
              });
              avoid.push(rect);
              placed.push(rect);
              box = Bubble.parse({ ...draft.bubble, ...rect, tail: false });
            }
            const [nl] = await tx
              .insert(narrationLines)
              .values({
                projectId: project.id,
                chapterId,
                pageId: page!.id,
                panelId: panel!.id,
                order: ++lineOrder,
                language: project.language,
                text,
                showOnPage: box !== null,
                box,
              })
              .returning({ id: narrationLines.id });
            for (const [k, seg] of segmentNarration(text, 400, s.narrationPauseMs).entries()) {
              await tx.insert(narrationSegments).values({
                projectId: project.id,
                narrationLineId: nl!.id,
                order: k,
                text: seg.text,
                textSha256: segmentTextSha(seg.text, s.pronunciation),
                pauseAfterMs: seg.pauseAfterMs,
              });
            }
            narrationIds.push(nl!.id);
          }
          const sfxIds = lettered.sfxIds;
          const storedSpec: PanelSpec = {
            ...spec,
            characters: panelChars.map((x) => ({ ...x.pc, characterId: x.ch!.id })),
            locationId: panelLoc?.id,
            propIds: spec.propIds.map((k) => findProp(k)?.id).filter((x): x is string => Boolean(x)),
            dialogueIds,
            narrationIds,
            sfxIds,
          };
          await tx.insert(panelSpecs).values({ panelId: panel!.id, versionNumber: 1, spec: storedSpec, source: "ai" });
        }
      }
    }

    await tx
      .update(chapters)
      .set({
        summary: plan.chapterSummary || chapter.summary,
        openingState: plan.openingState,
        closingState: plan.closingState,
        characterStateChanges: plan.characterStateChanges,
        locationStateChanges: plan.locationStateChanges,
        revealedFacts: plan.revealedFacts,
        lastPlan: plan,
        planStatus: "draft",
      })
      .where(eq(chapters.id, chapterId));
    // After the update: with no source excerpt the plan's summary is what a later plan would read. The plan writes
    // the panels' narration with them, so that is current too.
    await recordPlanFingerprint(tx, chapterId);
    await recordNarrationFingerprint(tx, chapterId);
    return { applied: true, pages: pageOrder, panels: panelCount };
  });
}
