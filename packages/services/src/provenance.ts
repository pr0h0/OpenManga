import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  and,
  asc,
  assetMarks,
  assets,
  audioJobs,
  chapters,
  type Database,
  desc,
  eq,
  generationJobs,
  inArray,
  isNull,
  narrationLines,
  narrationSegments,
  pages,
  panels,
  projects,
  referenceAssets,
  sql,
  storyRevisions,
} from "@openmanga/db";
import { resolveLettering } from "@openmanga/domain";

/** Licences of the fonts the app ships for lettering; any other font is the project's to account for. */
const FONT_LICENCES: Record<string, string> = {
  "Comic Neue": "SIL Open Font License 1.1",
  "DejaVu Sans": "Bitstream Vera / DejaVu fonts licence (free to use and embed)",
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** `column in (ids)`, bound as parameters; false for none. */
const anyOf = (column: ReturnType<typeof sql>, ids: string[]) =>
  ids.length
    ? sql`${column} in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`
    : sql`false`;

/**
 * Where an output came from: the app build, the story revision, every panel's artwork with the job, model, template
 * version and prompt-lab rules that made it (or the upload and tool), the references the panels draw on, the
 * narration voices, the lettering fonts, and the licence notes recorded for uploads (Assets → a file's licence).
 * Scope: a chapter, some pages, or the whole project. Content Credentials (C2PA) are not embedded.
 */
export async function buildProvenance(
  db: Database,
  projectId: string,
  scope: { chapterId?: string | null; pageIds?: string[] },
  app: { version: string; sha: string | null; builtAt: string | null },
) {
  const [project] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!project) throw new Error("Project not found");
  const [revision] = await db
    .select({ id: storyRevisions.id, number: storyRevisions.revisionNumber, createdAt: storyRevisions.createdAt })
    .from(storyRevisions)
    .where(eq(storyRevisions.projectId, projectId))
    .orderBy(desc(storyRevisions.revisionNumber))
    .limit(1);
  const pageWhere = scope.pageIds?.length
    ? and(eq(pages.projectId, projectId), inArray(pages.id, scope.pageIds))
    : scope.chapterId
      ? eq(pages.chapterId, scope.chapterId)
      : eq(pages.projectId, projectId);
  const rows = await db
    .select({
      panelId: panels.id,
      chapter: chapters.order,
      page: pages.order,
      panel: panels.order,
      characterVersionIds: panels.characterVersionIds,
      locationVersionId: panels.locationVersionId,
      propVersionIds: panels.propVersionIds,
      clipAssetId: sql<string | null>`${panels.video}->>'clipAssetId'`,
      asset: assets,
      job: generationJobs,
    })
    .from(panels)
    .innerJoin(pages, eq(pages.id, panels.pageId))
    .innerJoin(chapters, eq(chapters.id, pages.chapterId))
    .leftJoin(assets, eq(assets.id, panels.activeArtworkAssetId))
    .leftJoin(generationJobs, eq(generationJobs.id, assets.generationJobId))
    .where(pageWhere)
    .orderBy(asc(chapters.order), asc(pages.order), asc(panels.order));

  // The clips the panels play in videos, with the jobs that made them.
  const clipIds = rows.flatMap((r) => (r.clipAssetId ? [r.clipAssetId] : []));
  const clipRows = clipIds.length
    ? await db
        .select({ asset: assets, job: generationJobs })
        .from(assets)
        .leftJoin(generationJobs, eq(generationJobs.id, assets.generationJobId))
        .where(and(inArray(assets.id, clipIds), isNull(assets.deletedAt)))
    : [];
  const clipOf = new Map(clipRows.map((c) => [c.asset.id, c]));
  const assetIds = new Set<string>();
  const panelsOut = rows.map((r) => {
    const clip = r.clipAssetId ? clipOf.get(r.clipAssetId) : undefined;
    const cm = (clip?.asset.metadata ?? {}) as {
      parts?: number;
      seconds?: number;
      resolution?: string;
      audio?: boolean;
    };
    if (r.asset) assetIds.add(r.asset.id);
    const overrides = (r.job?.parameters?.promptOverrides ?? null) as Record<string, number> | null;
    return {
      chapter: r.chapter,
      page: r.page,
      panel: r.panel,
      art: r.asset
        ? {
            assetId: r.asset.id,
            sha256: r.asset.sha256,
            createdAt: r.asset.createdAt,
            source: r.job
              ? r.job.kind === "panel_edit"
                ? "edited"
                : "generated"
              : r.asset.parentAssetId
                ? "derived"
                : "uploaded",
            tool: (r.asset.metadata?.tool as string | undefined) ?? null,
            job: r.job
              ? {
                  id: r.job.id,
                  kind: r.job.kind,
                  provider: r.job.provider,
                  model: r.job.model,
                  template: r.job.templateName ? `${r.job.templateName} v${r.job.templateVersion}` : null,
                  promptSha256: r.job.compiledPrompt ? sha(r.job.compiledPrompt) : null,
                  promptOverrides: overrides,
                  createdAt: r.job.createdAt,
                }
              : null,
          }
        : null,
      // The generated video clip this panel plays in place of its still (made from the artwork above, or from words).
      clip: clip
        ? {
            assetId: clip.asset.id,
            sha256: clip.asset.sha256,
            createdAt: clip.asset.createdAt,
            durationMs: clip.asset.durationMs,
            seconds: cm.seconds ?? null,
            parts: cm.parts ?? 1,
            resolution: cm.resolution ?? null,
            sound: Boolean(cm.audio),
            fromAssetId: clip.asset.parentAssetId,
            job: clip.job
              ? {
                  id: clip.job.id,
                  provider: clip.job.provider,
                  model: clip.job.model,
                  template: clip.job.templateName ? `${clip.job.templateName} v${clip.job.templateVersion}` : null,
                  promptSha256: clip.job.compiledPrompt ? sha(clip.job.compiledPrompt) : null,
                  createdAt: clip.job.createdAt,
                }
              : null,
          }
        : null,
    };
  });

  // The references the scope's panels draw on: the cast, places and props in them.
  const versionIds = {
    character: [...new Set(rows.flatMap((r) => r.characterVersionIds))],
    location: [...new Set(rows.flatMap((r) => (r.locationVersionId ? [r.locationVersionId] : [])))],
    prop: [...new Set(rows.flatMap((r) => r.propVersionIds))],
  };
  const refs = await db.execute<{
    asset_id: string;
    kind: string;
    name: string;
    sha256: string;
    generation_job_id: string | null;
    original_name: string | null;
    provider: string | null;
    model: string | null;
  }>(sql`
    select ra.asset_id, case when ra.character_version_id is not null then 'character'
        when ra.location_version_id is not null then 'location' else 'prop' end as kind,
      coalesce(c.name, l.name, pr.name) as name, a.sha256, a.generation_job_id,
      a.metadata->>'originalName' as original_name, g.provider, g.model
    from reference_assets ra
    join assets a on a.id = ra.asset_id
    left join generation_jobs g on g.id = a.generation_job_id
    left join character_versions cv on cv.id = ra.character_version_id left join characters c on c.id = cv.character_id
    left join location_versions lv on lv.id = ra.location_version_id left join locations l on l.id = lv.location_id
    left join prop_versions pv on pv.id = ra.prop_version_id left join props pr on pr.id = pv.prop_id
    where ra.project_id = ${projectId} and a.deleted_at is null and (
      ${anyOf(sql`ra.character_version_id`, versionIds.character)}
      or ${anyOf(sql`ra.location_version_id`, versionIds.location)}
      or ${anyOf(sql`ra.prop_version_id`, versionIds.prop)})
    order by kind, name`);
  for (const r of refs) assetIds.add(r.asset_id);

  // Licence notes recorded for files (uploads especially), from the asset library.
  const licences = assetIds.size
    ? await db
        .select({ assetId: assetMarks.assetId, licence: assetMarks.licence })
        .from(assetMarks)
        .where(inArray(assetMarks.assetId, [...assetIds]))
    : [];
  const licenceOf = new Map(licences.flatMap((l) => (l.licence ? [[l.assetId, l.licence] as const] : [])));

  // Narration: the voices and speech providers of the takes that play.
  const voices = await db
    .selectDistinct({ voice: audioJobs.voice, options: audioJobs.options })
    .from(audioJobs)
    .innerJoin(narrationSegments, eq(narrationSegments.activeAudioAssetId, audioJobs.audioAssetId))
    .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
    .innerJoin(chapters, eq(chapters.id, narrationLines.chapterId))
    .where(and(eq(chapters.projectId, projectId), scope.chapterId ? eq(chapters.id, scope.chapterId) : undefined));

  // The text work behind the plan and narration: templates and models by kind.
  const textJobs = await db
    .select({
      kind: generationJobs.kind,
      provider: generationJobs.provider,
      model: generationJobs.model,
      template: generationJobs.templateName,
      version: generationJobs.templateVersion,
      n: sql<number>`count(*)::int`,
    })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.projectId, projectId),
        eq(generationJobs.status, "completed"),
        inArray(generationJobs.kind, ["story_analysis", "chapter_plan", "page_prompts", "narration_text"]),
        scope.chapterId
          ? sql`(${generationJobs.targetId} = ${scope.chapterId} or ${generationJobs.kind} = 'story_analysis')`
          : undefined,
      ),
    )
    .groupBy(
      generationJobs.kind,
      generationJobs.provider,
      generationJobs.model,
      generationJobs.templateName,
      generationJobs.templateVersion,
    );

  const lettering = resolveLettering(project.settings);
  const fonts = [...new Set([...Object.values(lettering.types).map((t) => t.font), lettering.sfx.font])].sort();
  const models = new Map<string, { kind: string; provider: string | null; model: string | null; uses: number }>();
  const addModel = (kind: string, provider: string | null, model: string | null, uses = 1) => {
    const k = `${kind}|${provider}|${model}`;
    const m = models.get(k) ?? { kind, provider, model, uses: 0 };
    m.uses += uses;
    models.set(k, m);
  };
  for (const p of panelsOut) if (p.art?.job) addModel("image", p.art.job.provider, p.art.job.model);
  for (const p of panelsOut) if (p.clip?.job) addModel("video", p.clip.job.provider, p.clip.job.model);

  // The music bed under the videos: an uploaded track, with the licence note recorded for it.
  const musicId = project.settings.video?.music?.assetId ?? null;
  const [musicAsset] = musicId
    ? await db
        .select()
        .from(assets)
        .where(and(eq(assets.id, musicId), isNull(assets.deletedAt)))
    : [];
  if (musicAsset) {
    assetIds.add(musicAsset.id);
    const [mark] = await db
      .select({ licence: assetMarks.licence })
      .from(assetMarks)
      .where(eq(assetMarks.assetId, musicAsset.id));
    if (mark?.licence) licenceOf.set(musicAsset.id, mark.licence);
  }
  for (const j of textJobs) addModel("text", j.provider, j.model, j.n);

  return {
    format: "openmanga-provenance/1",
    createdAt: new Date().toISOString(),
    app: { name: "OpenManga", ...app },
    project: { id: project.id, title: project.title, language: project.language, format: project.settings.format },
    scope: scope.pageIds?.length
      ? { pageIds: scope.pageIds }
      : scope.chapterId
        ? { chapterId: scope.chapterId }
        : "project",
    story: revision ? { revisionId: revision.id, revision: revision.number, savedAt: revision.createdAt } : null,
    models: [...models.values()],
    textWork: textJobs.map((j) => ({
      kind: j.kind,
      template: j.template ? `${j.template} v${j.version}` : null,
      provider: j.provider,
      model: j.model,
      jobs: j.n,
    })),
    panels: panelsOut,
    references: [...refs].map((r) => ({
      kind: r.kind,
      name: r.name,
      assetId: r.asset_id,
      sha256: r.sha256,
      source: r.generation_job_id ? "generated" : r.original_name ? "uploaded" : "made",
      uploadedName: r.original_name,
      provider: r.provider,
      model: r.model,
      licence: licenceOf.get(r.asset_id) ?? null,
    })),
    music: musicAsset
      ? {
          assetId: musicAsset.id,
          sha256: musicAsset.sha256,
          uploadedName: (musicAsset.metadata?.originalName as string | undefined) ?? null,
          licence: licenceOf.get(musicAsset.id) ?? null,
        }
      : null,
    narration: {
      voices: voices.map((v) => ({
        voice: v.voice,
        provider: ((v.options?.ai as { provider?: string } | undefined)?.provider ?? "local voice (Kokoro)") as string,
      })),
    },
    fonts: fonts.map((f) => ({ name: f, licence: FONT_LICENCES[f] ?? "not bundled with the app: check its licence" })),
    licences: [...licenceOf.entries()].map(([assetId, licence]) => ({ assetId, ...licence })),
    notes: [
      "AI-generated artwork and text: check each provider's terms for how outputs may be used.",
      "Content Credentials (C2PA) are not embedded in the files.",
    ],
  };
}
export type Provenance = Awaited<ReturnType<typeof buildProvenance>>;

/** The same record as a page a person can read. */
export function provenanceMarkdown(p: Provenance) {
  const lines = [
    `# Provenance: ${p.project.title}`,
    "",
    `Made with ${p.app.name} ${p.app.version}${p.app.sha ? ` (${p.app.sha.slice(0, 7)})` : ""} on ${p.createdAt}.`,
    p.story ? `Story revision ${p.story.revision} (${p.story.revisionId}).` : "No story revision.",
    "",
    "## Models",
    ...p.models.map(
      (m) => `- ${m.kind}: ${m.provider ?? "?"} ${m.model ?? ""} (${m.uses} use${m.uses === 1 ? "" : "s"})`,
    ),
    "",
    "## Panels",
    ...p.panels.map(
      (x) =>
        `- Chapter ${x.chapter}, page ${x.page}, panel ${x.panel}: ${
          x.art
            ? `${x.art.source}${x.art.job ? ` by ${x.art.job.provider} ${x.art.job.model ?? ""}, ${x.art.job.template ?? ""}` : ""}${x.art.tool ? `, tool ${x.art.tool}` : ""} · sha256 ${x.art.sha256.slice(0, 12)}`
            : "no artwork"
        }${x.clip ? ` · video clip by ${x.clip.job?.provider ?? "?"} ${x.clip.job?.model ?? ""}${x.clip.parts > 1 ? ` in ${x.clip.parts} parts` : ""} · sha256 ${x.clip.sha256.slice(0, 12)}` : ""}`,
    ),
    "",
    "## References",
    ...(p.references.length
      ? p.references.map(
          (r) =>
            `- ${r.kind} ${r.name}: ${r.source}${r.uploadedName ? ` (${r.uploadedName})` : ""}${r.licence ? ` · licence: ${r.licence.text}${r.licence.url ? ` <${r.licence.url}>` : ""}` : ""}`,
        )
      : ["- none"]),
    "",
    ...(p.music
      ? [
          "## Music",
          `- ${p.music.uploadedName ?? p.music.assetId}${p.music.licence ? ` · licence: ${p.music.licence.text}${p.music.licence.url ? ` <${p.music.licence.url}>` : ""}` : " · no licence note recorded"}`,
          "",
        ]
      : []),
    "## Narration voices",
    ...(p.narration.voices.length ? p.narration.voices.map((v) => `- ${v.voice} (${v.provider})`) : ["- none"]),
    "",
    "## Fonts",
    ...p.fonts.map((f) => `- ${f.name}: ${f.licence}`),
    "",
    "## Notes",
    ...p.notes.map((n) => `- ${n}`),
    "",
  ];
  return lines.join("\n");
}

/** The build this process runs (an image's build-info.json, else the checkout's package version), for records. */
export function appBuild(root = process.cwd()): { version: string; sha: string | null; builtAt: string | null } {
  try {
    return JSON.parse(readFileSync(join(root, "build-info.json"), "utf8"));
  } catch {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version?: string };
      return { version: pkg.version ?? "0.0.0", sha: null, builtAt: null };
    } catch {
      return { version: "0.0.0", sha: null, builtAt: null };
    }
  }
}
