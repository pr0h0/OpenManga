import { rm } from "node:fs/promises";
import { join } from "node:path";
import { parseWav } from "@openmanga/audio";
import {
  and,
  approvalStatus,
  audioAssets,
  chapters,
  characterAliases,
  characterOutfits,
  characters,
  characterVersions,
  colorMode,
  dialogueLines,
  eq,
  type exportJobs,
  isNull,
  locations,
  locationVersions,
  narrationLines,
  narrationSegments,
  outfitAssignments,
  pages,
  panelSpecs,
  panels,
  projectStyles,
  projects,
  projectType,
  props,
  propVersions,
  REFERENCE_KINDS,
  readingDirection,
  referenceAssets,
  scenes,
  soundEffects,
  storyBeats,
  storyRevisions,
  stylePresets,
  type Tx,
} from "@openmanga/db";
import { probeImage } from "@openmanga/image-utils";
import { UnrecoverableError } from "@openmanga/queue";
import { type PanelSpec, ProjectInterchange } from "@openmanga/schemas";
import type { AssetType } from "@openmanga/services";
import { sha256Hex } from "@openmanga/storage";
import type { WorkerDeps } from "../context.ts";
import { type ExtractedFiles, type ExtractLimits, extractZip } from "../lib/zip.ts";

type ExportJob = typeof exportJobs.$inferSelect;
export type ImportResult = { projectId: string; warnings: string[]; counts: Record<string, number> };

const MAX_WARNINGS = 200;
/** Enough for a project.json at the schema's array limits; it is read into memory, unlike the assets. */
const MAX_MANIFEST_BYTES = 256 * 1024 * 1024;

const limitsFrom = (config: WorkerDeps["config"]): ExtractLimits => ({
  maxEntryBytes: config.IMPORT_MAX_ENTRY_MB * 1024 * 1024,
  maxTotalBytes: config.IMPORT_MAX_UPLOAD_MB * 1024 * 1024,
  maxRatio: config.IMPORT_MAX_COMPRESSION_RATIO,
});

const pick = <T extends string, F = T>(values: readonly T[], v: string | null | undefined, fallback: F): T | F =>
  values.includes(v as T) ? (v as T) : fallback;
/** Interchange timestamps are strings from another machine: anything unparseable falls back to the column default. */
const date = (v: string | null | undefined) => {
  const d = v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
};

/**
 * Reads the manifest out of the upload: a zip_package ZIP (project.json + asset files) or a bare project_json
 * document. Only project.json is extracted here — the assets are streamed in a second pass, once the manifest says
 * which entries matter.
 *
 * A ZIP may wrap everything in one directory — that is what GitHub's "Download ZIP" produces, and how a project
 * published as a browsable repository arrives — so the wrapper is found and reported for stripping.
 */
async function readManifest(uploadPath: string, dir: string, config: WorkerDeps["config"]) {
  const head = new Uint8Array(await Bun.file(uploadPath).slice(0, 4).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
  if (!isZip) return { json: await Bun.file(uploadPath).text(), isZip, prefix: "", otherManifests: [] };
  const names: string[] = [];
  let found: ExtractedFiles;
  try {
    found = await extractZip({
      path: uploadPath,
      dir,
      wanted: (name) => {
        if (name !== "project.json" && !name.endsWith("/project.json")) return null;
        names.push(name);
        return name;
      },
      // No ratio guard on this pass: project.json is text and compresses well (a hand-zipped project_json export
      // runs 20x), and the entry cap above is what bounds it.
      limits: { ...limitsFrom(config), maxEntryBytes: MAX_MANIFEST_BYTES, maxRatio: Number.POSITIVE_INFINITY },
      // Deliberately reads to the end rather than stopping at the first hit: an archive can hold several projects
      // side by side (a repository of samples, zipped), and importing one of them silently is worse than the
      // second pass over the file. Memory stays flat either way.
    });
  } catch (e) {
    if (e instanceof UnrecoverableError) throw e;
    throw new UnrecoverableError("The ZIP file is corrupt or unsupported");
  }
  // Shallowest match wins, so a stray nested copy cannot shadow the real one.
  const name = names.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))[0];
  if (!name) throw new UnrecoverableError("The ZIP does not contain project.json");
  return {
    json: new TextDecoder().decode(await found.read(name)),
    isZip,
    prefix: name.slice(0, -"project.json".length),
    /** Other manifests in the same archive, so importing one of several projects is not silent. */
    otherManifests: names.filter((n) => n !== name),
  };
}

/**
 * Recreates a project from OpenManga's interchange format into the (empty) placeholder project the job belongs to.
 * Everything is inserted in one transaction, so a failure leaves no half-imported rows (stored files become orphans
 * that maintenance cleans). The placeholder is archived on failure and the upload is always deleted.
 */
/** Resident megabytes of this process, so an import reports what it actually cost. */
const rssMb = () => Math.round(process.memoryUsage().rss / 1024 / 1024);

export async function importProject(
  deps: WorkerDeps,
  job: ExportJob,
  progress: (p: number) => Promise<void>,
): Promise<ImportResult> {
  const uploadPath = String((job.options as { uploadPath?: string }).uploadPath ?? "");
  // Entries are streamed into here one chunk at a time, so peak memory is one asset rather than the package.
  const scratch = join(deps.config.TEMP_ROOT, "imports", `x-${job.id}`);
  try {
    if (!uploadPath.startsWith(deps.config.TEMP_ROOT))
      throw new UnrecoverableError("Import upload is missing; upload the file again");
    if (!(await Bun.file(uploadPath).exists()) || Bun.file(uploadPath).size === 0)
      throw new UnrecoverableError("Import upload is missing; upload the file again");
    const upload = await readManifest(uploadPath, join(scratch, "manifest"), deps.config);
    deps.logger.info("import stage", { stage: "manifest", rssMb: rssMb() });
    let parsed: unknown;
    try {
      parsed = JSON.parse(upload.json);
    } catch {
      throw new UnrecoverableError("project.json is not valid JSON");
    }
    const check = ProjectInterchange.safeParse(parsed);
    if (!check.success)
      throw new UnrecoverableError(
        `Not a valid OpenManga project file: ${check.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ")}`,
      );
    const doc = check.data;
    const wanted = new Set(Object.values(doc.assets).map((a) => a.path));
    const unwrap = (n: string) => (upload.prefix && n.startsWith(upload.prefix) ? n.slice(upload.prefix.length) : n);
    let files: ExtractedFiles = { has: () => false, read: async () => new Uint8Array(0), bytes: 0 };
    if (upload.isZip) {
      try {
        files = await extractZip({
          path: uploadPath,
          dir: join(scratch, "assets"),
          wanted: (name) => {
            const key = unwrap(name);
            return wanted.has(key) ? key : null;
          },
          limits: limitsFrom(deps.config),
        });
      } catch (e) {
        if (e instanceof UnrecoverableError) throw e;
        throw new UnrecoverableError("The ZIP file is corrupt or unsupported");
      }
    }
    await progress(0.1);
    deps.logger.info("import stage", { stage: "extracted", bytes: files.bytes, rssMb: rssMb() });
    const result = await deps.db.transaction((tx) => restore(deps, tx, job, doc, files, progress));
    // A repository ZIP can hold several projects side by side; one import job restores one of them.
    if (upload.otherManifests.length)
      result.warnings.push(
        `The archive contains ${upload.otherManifests.length + 1} projects; this import restored ${
          upload.prefix || "the one at the root"
        } and ignored ${upload.otherManifests.join(", ")}. Import the others separately.`,
      );
    deps.logger.info("import stage", { stage: "restored", assets: result.counts.assets, rssMb: rssMb() });
    return result;
  } catch (e) {
    await deps.db
      .update(projects)
      .set({ status: "archived", title: await failedTitle(deps, job.projectId) })
      .where(eq(projects.id, job.projectId))
      .catch(() => {});
    throw e;
  } finally {
    if (uploadPath.startsWith(deps.config.TEMP_ROOT)) {
      await rm(uploadPath, { force: true }).catch(() => {});
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function failedTitle(deps: WorkerDeps, projectId: string) {
  const [p] = await deps.db.select({ title: projects.title }).from(projects).where(eq(projects.id, projectId));
  const title = p?.title ?? "Imported project";
  return title.startsWith("[import failed] ") ? title : `[import failed] ${title}`.slice(0, 200);
}

async function restore(
  deps: WorkerDeps,
  tx: Tx,
  job: ExportJob,
  doc: ProjectInterchange,
  files: ExtractedFiles,
  progress: (p: number) => Promise<void>,
): Promise<ImportResult> {
  const projectId = job.projectId;
  const userId = job.userId;
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push(w);
  };
  const counts: Record<string, number> = {
    storyRevisions: 0,
    characters: 0,
    locations: 0,
    props: 0,
    references: 0,
    chapters: 0,
    scenes: 0,
    pages: 0,
    panels: 0,
    dialogue: 0,
    sfx: 0,
    narrationLines: 0,
    narrationSegments: 0,
    assets: 0,
  };
  let missingFiles = 0;

  const [placeholder] = await tx.select().from(projects).where(eq(projects.id, projectId));
  if (!placeholder) throw new UnrecoverableError("Project no longer exists");
  const existing = await tx
    .select({ id: chapters.id })
    .from(chapters)
    .where(eq(chapters.projectId, projectId))
    .limit(1);
  const existingChars = await tx
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.projectId, projectId), isNull(characters.deletedAt)))
    .limit(1);
  if (existing.length || existingChars.length) throw new UnrecoverableError("Imports can only target an empty project");

  /** source ref (e.g. "c-<uuid>") -> new row id */
  const refs = new Map<string, string>();
  /**
   * Panel specs carry raw source ids rather than refs. Refs used to be an 8-character prefix of the id, so a
   * package written before that changed is still resolvable by falling back to the short form.
   */
  const byUuid = (prefix: string, id: string | null | undefined) =>
    id ? (refs.get(`${prefix}-${id}`) ?? refs.get(`${prefix}-${id.slice(0, 8)}`)) : undefined;
  const assetIds = new Map<string, { id: string; sampleRate?: number; durationMs?: number }>();
  /**
   * Every row of the transaction would otherwise share its commit timestamp, and artwork versions are numbered by
   * createdAt (apps/api/src/routes/pages.ts), so history would come back in an arbitrary order. Rows are created in
   * document order, so one millisecond each off a common base preserves the order the package recorded. The base sits
   * far enough in the past that no row lands in the future.
   */
  const base = Date.now() - 2 * Object.keys(doc.assets).length - 1;
  let seq = 0;
  const nextCreatedAt = () => new Date(base + seq++);

  const importAsset = async (
    key: string | null | undefined,
    type: AssetType,
    opts: { metadata?: Record<string, unknown>; status?: "draft" | "approved" | "locked" | "superseded" } = {},
  ) => {
    if (!key) return null;
    const cached = assetIds.get(key);
    if (cached) return cached;
    const entry = doc.assets[key];
    if (!entry) {
      warn(`Asset ${key} is referenced but missing from the manifest`);
      return null;
    }
    const data = files.has(entry.path) ? await files.read(entry.path) : new Uint8Array(0);
    if (!data.length) {
      missingFiles++;
      return null;
    }
    let meta: { mimeType: string; width: number | null; height: number | null; durationMs: number | null };
    let sampleRate: number | undefined;
    try {
      if (type === "audio") {
        const wav = parseWav(data);
        sampleRate = wav.sampleRate;
        meta = { mimeType: "audio/wav", width: null, height: null, durationMs: wav.durationMs };
      } else {
        const img = await probeImage(data);
        meta = { mimeType: img.mime, width: img.width, height: img.height, durationMs: null };
      }
    } catch {
      warn(`${entry.path} is not a valid ${type === "audio" ? "WAV file" : "PNG/JPEG/WebP image"}; skipped`);
      return null;
    }
    // Fail closed: a file that does not match the checksum in its own manifest has been altered or corrupted, and
    // importing it anyway would silently put content the package did not describe into the project.
    if (entry.sha256 && sha256Hex(data) !== entry.sha256)
      throw new UnrecoverableError(`${entry.path} does not match the checksum recorded in the package`);
    const row = await deps.assets.store(
      {
        projectId,
        ownerUserId: userId,
        type,
        data,
        ...meta,
        status: opts.status ?? pick(approvalStatus.enumValues, entry.status, "draft"),
        metadata: { ...opts.metadata, importedFrom: key, exportJobId: job.id },
        createdAt: nextCreatedAt(),
      },
      tx,
    );
    counts.assets!++;
    const out = { id: row.id, sampleRate, durationMs: meta.durationMs ?? undefined };
    assetIds.set(key, out);
    return out;
  };

  type Refs = ProjectInterchange["characters"][number]["versions"][number]["references"];
  const importRefs = async (
    list: Refs,
    subject: "character" | "location" | "prop",
    versionId: string,
    type: AssetType,
  ) => {
    for (const r of list) {
      const status = pick(approvalStatus.enumValues, r.status, "draft");
      const asset = await importAsset(r.asset, type, { status });
      if (!asset) continue;
      await tx.insert(referenceAssets).values({
        projectId,
        subjectType: subject,
        characterVersionId: subject === "character" ? versionId : null,
        locationVersionId: subject === "location" ? versionId : null,
        propVersionId: subject === "prop" ? versionId : null,
        // Outfits are inserted before the versions, so the planner's outfit join survives the round trip.
        outfitId: (subject === "character" && r.outfit && refs.get(r.outfit)) || null,
        kind: pick(REFERENCE_KINDS, r.kind, "uploaded"),
        assetId: asset.id,
        status,
        isPrimary: r.isPrimary,
        createdAt: nextCreatedAt(),
      });
      counts.references!++;
    }
  };

  // project + style
  const p = doc.project;
  for (const [field, values, value] of [
    ["projectType", projectType.enumValues, p.projectType],
    ["readingDirection", readingDirection.enumValues, p.readingDirection],
    ["colorMode", colorMode.enumValues, p.colorMode],
  ] as const)
    if (!(values as readonly string[]).includes(value)) warn(`Unknown ${field} "${value}"; kept the default`);
  let styleId: string | null = null;
  if (doc.style) {
    let presetId: string | null = null;
    if (doc.style.presetKey) {
      const [builtin] = await tx
        .select({ id: stylePresets.id })
        .from(stylePresets)
        .where(and(eq(stylePresets.key, doc.style.presetKey), eq(stylePresets.isBuiltin, true)));
      if (builtin) presetId = builtin.id;
      else {
        const [custom] = await tx
          .insert(stylePresets)
          .values({
            key: `project-${projectId}-${Date.now()}`,
            name: "Custom",
            projectId,
            definition: doc.style.definition,
          })
          .returning({ id: stylePresets.id });
        presetId = custom!.id;
      }
    }
    const [style] = await tx
      .insert(projectStyles)
      .values({ projectId, versionNumber: 1, stylePresetId: presetId, customDescription: doc.style.customDescription })
      .returning({ id: projectStyles.id });
    styleId = style!.id;
    for (const key of doc.style.references) {
      const asset = await importAsset(key, "style_reference", { status: "approved" });
      if (!asset) continue;
      await tx.insert(referenceAssets).values({
        projectId,
        subjectType: "style",
        projectStyleId: styleId,
        kind: "style",
        assetId: asset.id,
        status: "approved",
        createdAt: nextCreatedAt(),
      });
      counts.references!++;
    }
  }
  const cover = await importAsset(p.cover, "cover");
  await tx
    .update(projects)
    .set({
      title: p.title.trim().slice(0, 200) || placeholder.title,
      description: p.description.slice(0, 5000),
      projectType: pick(projectType.enumValues, p.projectType, placeholder.projectType),
      language: p.language || placeholder.language,
      readingDirection: pick(readingDirection.enumValues, p.readingDirection, placeholder.readingDirection),
      colorMode: pick(colorMode.enumValues, p.colorMode, placeholder.colorMode),
      settings: p.settings,
      currentStyleId: styleId,
      coverAssetId: cover?.id ?? null,
    })
    .where(eq(projects.id, projectId));

  for (const r of doc.storyRevisions) {
    await tx.insert(storyRevisions).values({
      projectId,
      revisionNumber: r.revisionNumber,
      source: pick(["initial", "user_edit", "ai_rewrite", "import"] as const, r.source, "import"),
      inputKind: pick(["story", "chapter", "outline", "screenplay", "idea"] as const, r.inputKind, "story"),
      title: r.title,
      content: r.content,
      contentSha256: sha256Hex(r.content),
      lockedAt: date(r.lockedAt),
      createdByUserId: userId,
      createdAt: date(r.createdAt) ?? undefined,
    });
    counts.storyRevisions!++;
  }
  await progress(0.15);

  // cast & world
  for (const c of doc.characters) {
    const [row] = await tx
      .insert(characters)
      .values({
        projectId,
        name: c.name,
        role: pick(["protagonist", "antagonist", "supporting", "minor"] as const, c.role, "supporting"),
      })
      .returning({ id: characters.id });
    refs.set(c.ref, row!.id);
    counts.characters!++;
    // Outfits first: reference rows point at them. Their own version link can only be set once the versions exist.
    for (const o of c.outfits) {
      const [outfit] = await tx
        .insert(characterOutfits)
        .values({ characterId: row!.id, name: o.name, description: o.description, isDefault: o.isDefault })
        .returning({ id: characterOutfits.id });
      if (o.ref) refs.set(o.ref, outfit!.id);
    }
    for (const v of c.versions) {
      const [nv] = await tx
        .insert(characterVersions)
        .values({
          characterId: row!.id,
          versionNumber: v.versionNumber,
          description: v.description,
          immutableTraits: v.immutableTraits,
          status: pick(approvalStatus.enumValues, v.status, "draft"),
          createdByUserId: userId,
        })
        .returning({ id: characterVersions.id });
      refs.set(v.ref, nv!.id);
      await importRefs(v.references, "character", nv!.id, "character_reference");
    }
    const aliases = [...new Set(c.aliases)];
    if (aliases.length)
      await tx.insert(characterAliases).values(aliases.map((alias) => ({ characterId: row!.id, alias })));
    for (const o of c.outfits) {
      const outfitId = o.ref && refs.get(o.ref);
      const versionId = o.characterVersion && refs.get(o.characterVersion);
      if (outfitId && versionId)
        await tx
          .update(characterOutfits)
          .set({ characterVersionId: versionId })
          .where(eq(characterOutfits.id, outfitId));
    }
    const current = c.currentVersion ? refs.get(c.currentVersion) : undefined;
    if (current) await tx.update(characters).set({ currentVersionId: current }).where(eq(characters.id, row!.id));
  }
  for (const l of doc.locations) {
    const [row] = await tx.insert(locations).values({ projectId, name: l.name }).returning({ id: locations.id });
    refs.set(l.ref, row!.id);
    counts.locations!++;
    for (const v of l.versions) {
      const [nv] = await tx
        .insert(locationVersions)
        .values({
          locationId: row!.id,
          versionNumber: v.versionNumber,
          description: v.description,
          status: pick(approvalStatus.enumValues, v.status, "draft"),
          createdByUserId: userId,
        })
        .returning({ id: locationVersions.id });
      refs.set(v.ref, nv!.id);
      await importRefs(v.references, "location", nv!.id, "location_reference");
    }
    const current = l.currentVersion ? refs.get(l.currentVersion) : undefined;
    if (current) await tx.update(locations).set({ currentVersionId: current }).where(eq(locations.id, row!.id));
  }
  for (const pr of doc.props) {
    const [row] = await tx.insert(props).values({ projectId, name: pr.name }).returning({ id: props.id });
    refs.set(pr.ref, row!.id);
    counts.props!++;
    for (const v of pr.versions) {
      const [nv] = await tx
        .insert(propVersions)
        .values({
          propId: row!.id,
          versionNumber: v.versionNumber,
          description: v.description,
          status: pick(approvalStatus.enumValues, v.status, "draft"),
          createdByUserId: userId,
        })
        .returning({ id: propVersions.id });
      refs.set(v.ref, nv!.id);
      await importRefs(v.references, "prop", nv!.id, "prop_reference");
    }
    const current = pr.currentVersion ? refs.get(pr.currentVersion) : undefined;
    if (current) await tx.update(props).set({ currentVersionId: current }).where(eq(props.id, row!.id));
  }
  await progress(0.3);

  // Panel specs hold SOURCE uuids; match their first 8 chars against the source refs, drop what can't be mapped.
  const mapSpec = (spec: PanelSpec): PanelSpec => ({
    ...spec,
    characters: spec.characters.flatMap((c) => {
      const id = byUuid("c", c.characterId);
      return id ? [{ ...c, characterId: id }] : [];
    }),
    locationId: byUuid("l", spec.locationId),
    propIds: spec.propIds.flatMap((id) => byUuid("p", id) ?? []),
    dialogueIds: [],
    narrationIds: [],
    sfxIds: [],
  });

  const totalPanels = Math.max(
    1,
    doc.chapters.reduce((n, ch) => n + ch.pages.reduce((m, pg) => m + pg.panels.length, 0), 0),
  );
  let donePanels = 0;
  let reported = 0.3;
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const record = (v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"))
      : {};

  for (const ch of doc.chapters) {
    const m = ch.memory;
    const [chapter] = await tx
      .insert(chapters)
      .values({
        projectId,
        order: ch.order,
        title: ch.title,
        summary: ch.summary,
        openingState: str(m.openingState),
        closingState: str(m.closingState),
        characterStateChanges: strings(m.characterStateChanges),
        locationStateChanges: strings(m.locationStateChanges),
        revealedFacts: strings(m.revealedFacts),
        sourceExcerpt: str(m.sourceExcerpt),
      })
      .returning({ id: chapters.id });
    const chapterId = chapter!.id;
    refs.set(ch.ref, chapterId);
    counts.chapters!++;

    for (const s of ch.scenes) {
      const d = s.details;
      const [scene] = await tx
        .insert(scenes)
        .values({
          projectId,
          chapterId,
          order: s.order,
          title: s.title,
          summary: s.summary,
          locationId: (s.location && refs.get(s.location)) || null,
          time: str(d.time),
          weather: str(d.weather),
          characterIds: strings(d.characters).flatMap((r) => refs.get(r) ?? []),
          purpose: str(d.purpose),
          opening: str(d.opening),
          progression: str(d.progression),
          climax: str(d.climax),
          ending: str(d.ending),
          continuityNotes: strings(d.continuityNotes),
          initialState: record(d.initialState),
          finalState: record(d.finalState),
          continuityDeltas: strings(d.continuityDeltas),
        })
        .returning({ id: scenes.id });
      refs.set(s.ref, scene!.id);
      counts.scenes!++;
      if (s.beats.length)
        await tx
          .insert(storyBeats)
          .values(s.beats.map((description, order) => ({ projectId, sceneId: scene!.id, order, description })));
    }

    const panelPage = new Map<string, string>();
    for (const pg of ch.pages) {
      const sceneId = (pg.scene && refs.get(pg.scene)) || null;
      const [page] = await tx
        .insert(pages)
        .values({
          projectId,
          chapterId,
          sceneId,
          order: pg.order,
          purpose: pg.purpose,
          layoutTemplate: pg.layoutTemplate,
          width: Math.round(pg.width),
          height: Math.round(pg.height),
          // Null is meaningful here: it means "follow the project", not "left to right".
          readingDirection: pg.readingDirection ? pick(readingDirection.enumValues, pg.readingDirection, null) : null,
          status: pick(approvalStatus.enumValues, pg.status, "draft"),
        })
        .returning({ id: pages.id });
      const pageId = page!.id;
      refs.set(pg.ref, pageId);
      counts.pages!++;

      for (const pn of pg.panels) {
        const [panel] = await tx
          .insert(panels)
          .values({
            projectId,
            pageId,
            sceneId,
            order: pn.order,
            frame: pn.frame,
            imageTransform: pn.imageTransform,
            shotType: pn.shotType,
            cameraAngle: pn.cameraAngle,
            storyBeat: pn.storyBeat,
            locationVersionId: (pn.location && refs.get(pn.location)) || null,
            characterVersionIds: pn.characters.flatMap((r) => refs.get(r) ?? []),
            propVersionIds: pn.props.flatMap((r) => refs.get(r) ?? []),
            approvalStatus: pick(approvalStatus.enumValues, pn.approvalStatus, "draft"),
            promptOverride: pn.promptOverride,
          })
          .returning({ id: panels.id });
        const panelId = panel!.id;
        refs.set(pn.ref, panelId);
        panelPage.set(pn.ref, pageId);
        counts.panels!++;

        // history first (oldest -> newest) so version numbering by createdAt survives
        for (const key of pn.artworkHistory) await importAsset(key, "panel_art", { metadata: { panelId } });
        const art = await importAsset(pn.artwork, "panel_art", { metadata: { panelId } });
        if (art)
          await tx.update(panels).set({ activeArtworkAssetId: art.id, status: "ready" }).where(eq(panels.id, panelId));
        if (pn.spec)
          // ponytail: column is typed "ai" | "user"; "import" marks provenance without a schema change
          await tx
            .insert(panelSpecs)
            .values({ panelId, versionNumber: 1, spec: mapSpec(pn.spec), source: "import" as "user" });
        for (const [order, dl] of pn.dialogue.entries()) {
          await tx.insert(dialogueLines).values({
            projectId,
            pageId,
            panelId,
            characterId: (dl.speaker && refs.get(dl.speaker)) || null,
            order,
            text: dl.text,
            bubble: dl.bubble,
          });
          counts.dialogue!++;
        }
        for (const w of pn.outfits) {
          const characterId = refs.get(w.character);
          const outfitId = refs.get(w.outfit);
          if (characterId && outfitId)
            await tx.insert(outfitAssignments).values({ projectId, characterId, outfitId, panelId, scope: w.scope });
        }
        for (const sfx of pn.sfx) {
          await tx.insert(soundEffects).values({ projectId, pageId, panelId, text: sfx.text, style: sfx.style });
          counts.sfx!++;
        }
        donePanels++;
        const pct = 0.3 + (donePanels / totalPanels) * 0.6;
        if (pct - reported >= 0.02) {
          reported = pct;
          await progress(pct);
        }
      }
    }

    const lineOrder = new Map<string, number>(); // order is per (chapter, language) track
    for (const nl of ch.narration) {
      const language = nl.language || p.language || "en";
      const order = (lineOrder.get(language) ?? 0) + 1;
      lineOrder.set(language, order);
      const [line] = await tx
        .insert(narrationLines)
        .values({
          projectId,
          chapterId,
          pageId: (nl.panel && panelPage.get(nl.panel)) || null,
          panelId: (nl.panel && refs.get(nl.panel)) || null,
          order,
          language,
          text: nl.text,
          showOnPage: nl.showOnPage,
          box: nl.box,
        })
        .returning({ id: narrationLines.id });
      counts.narrationLines!++;
      for (const [order, seg] of nl.segments.entries()) {
        const textSha256 = sha256Hex(seg.text);
        const audio = await importAsset(seg.audio, "audio");
        const [segment] = await tx
          .insert(narrationSegments)
          .values({
            projectId,
            narrationLineId: line!.id,
            order,
            text: seg.text,
            textSha256,
            voice: seg.voice,
            speed: seg.speed,
            pauseAfterMs: seg.pauseAfterMs,
            activeAudioAssetId: audio?.id ?? null,
          })
          .returning({ id: narrationSegments.id });
        counts.narrationSegments!++;
        if (audio)
          await tx.insert(audioAssets).values({
            projectId,
            assetId: audio.id,
            segmentId: segment!.id,
            textSha256,
            voice: seg.voice ?? p.settings.narrationVoice,
            speed: seg.speed ?? p.settings.narrationSpeed,
            language,
            provider: "import",
            sampleRate: audio.sampleRate ?? 24000,
            durationMs: audio.durationMs ?? 0,
            format: "wav",
          });
      }
    }
  }

  const unreferenced = Object.keys(doc.assets).length - counts.assets!;
  if (unreferenced > 0)
    warn(
      `${unreferenced} asset(s) in the manifest are not referenced by anything and were not imported (extracted and discarded)`,
    );
  if (missingFiles)
    warnings.unshift(
      `${missingFiles} asset file(s) were not included in the upload and were skipped (artwork, references or audio)`,
    );
  await progress(0.95);
  return { projectId, warnings, counts };
}
