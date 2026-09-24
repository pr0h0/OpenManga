import { join } from "node:path";
import { concatWav, ffmpegConvert, parseWav } from "@openmanga/audio";
import {
  and,
  asc,
  assets,
  audioAssets,
  chapters,
  characterAliases,
  characters,
  characterVersions,
  desc,
  dialogueLines,
  eq,
  inArray,
  isNull,
  locations,
  locationVersions,
  narrationLines,
  narrationSegments,
  pages,
  panelSpecs,
  panels,
  projectStyles,
  type projects,
  props,
  propVersions,
  referenceAssets,
  scenes,
  soundEffects,
  storyBeats,
  storyRevisions,
  stylePresets,
} from "@openmanga/db";
import { readingOrder } from "@openmanga/domain";
import { extForMime, sharp } from "@openmanga/image-utils";
import type { PanelSpec } from "@openmanga/schemas";
import { loadRenderPage, projectReadiness, renderPageImage } from "@openmanga/services";
import type { WorkerDeps } from "../context.ts";
import { ZipWriter } from "../lib/zip.ts";

type Project = typeof projects.$inferSelect;
const enc = (s: string) => new TextEncoder().encode(s);
const pad = (n: number, w: number) => String(n).padStart(w, "0");
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48) || "untitled";

const REF_KIND_ORDER = [
  "portrait",
  "full_body",
  "multi_angle",
  "uploaded",
  "outfit",
  "expression_sheet",
  "location",
  "location_sheet",
  "location_panorama",
  "prop",
  "prop_multi_angle",
  "style",
];

/**
 * Self-describing hand-off package for another agent or editor: stable readable IDs, one manifest linking pages,
 * panels, characters, locations, dialogue and narration timing, plus plain-language docs next to every asset.
 */
export async function buildAgentPackage(
  deps: WorkerDeps,
  project: Project,
  chapterId: string | null,
  progress: (p: number) => Promise<void>,
  opts: { scale?: number; language?: string; dir: string },
) {
  const { db } = deps;
  const language = opts.language || project.language;
  const readiness = await projectReadiness(db, project.id, { chapterId, language });
  const warnings = readiness.issues.map(
    (i) => `${i.chapterLabel ?? "Project"}: ${i.message}${i.severity === "info" ? " (info)" : ""}`,
  );
  const zip = new ZipWriter(join(opts.dir, "agent_package.zip"));
  const used = new Set<string>();
  const uniqueSlug = (group: string, name: string) => {
    let candidate = slug(name);
    for (let i = 2; used.has(`${group}/${candidate}`); i++) candidate = `${slug(name)}-${i}`;
    used.add(`${group}/${candidate}`);
    return candidate;
  };
  const readAsset = async (id: string | null | undefined) => {
    if (!id) return null;
    const [a] = await db.select().from(assets).where(eq(assets.id, id));
    if (!a || a.deletedAt) return null;
    const data = await deps.assets.read(a).catch(() => null);
    return data ? { asset: a, data } : null;
  };
  const bestRef = async (
    col: "characterVersionId" | "locationVersionId" | "propVersionId" | "projectStyleId",
    versionId: string | null,
  ) => {
    if (!versionId) return null;
    const rows = await db
      .select()
      .from(referenceAssets)
      .where(and(eq(referenceAssets[col], versionId), inArray(referenceAssets.status, ["approved", "locked", "draft"])))
      .orderBy(desc(referenceAssets.createdAt));
    rows.sort(
      (a, b) =>
        Number(b.status !== "draft") - Number(a.status !== "draft") ||
        Number(b.isPrimary) - Number(a.isPrimary) ||
        REF_KIND_ORDER.indexOf(a.kind) - REF_KIND_ORDER.indexOf(b.kind),
    );
    return rows[0] ?? null;
  };

  // ---------------------------------------------------------------- cast & world
  const castRows = await db
    .select({ c: characters, v: characterVersions })
    .from(characters)
    .leftJoin(characterVersions, eq(characterVersions.id, characters.currentVersionId))
    .where(and(eq(characters.projectId, project.id), isNull(characters.deletedAt)));
  const allCharVersions = castRows.length
    ? await db
        .select()
        .from(characterVersions)
        .where(
          inArray(
            characterVersions.characterId,
            castRows.map((r) => r.c.id),
          ),
        )
    : [];
  const aliasRows = castRows.length
    ? await db
        .select()
        .from(characterAliases)
        .where(
          inArray(
            characterAliases.characterId,
            castRows.map((r) => r.c.id),
          ),
        )
    : [];
  const charById = new Map<string, { id: string; name: string; reference: string | null }>();
  const charByVersion = new Map<string, string>();
  const characterDocs = [];
  for (const { c, v } of castRows) {
    const charSlug = uniqueSlug("characters", c.name);
    const id = `char-${charSlug}`;
    const dir = `characters/${charSlug}`;
    const ref = await bestRef("characterVersionId", v?.id ?? null);
    const img = ref ? await readAsset(ref.assetId) : null;
    const refPath = img ? `${dir}/reference.${extForMime(img.asset.mimeType)}` : null;
    if (img && refPath) await zip.add(refPath, img.data);
    const b = v?.description;
    const aliases = aliasRows.filter((a) => a.characterId === c.id).map((a) => a.alias);
    await zip.add(
      `${dir}/description.md`,
      enc(
        [
          `# ${c.name} (\`${id}\`)`,
          `Role: ${c.role}${aliases.length ? ` · Aliases: ${aliases.join(", ")}` : ""}`,
          v ? `Design version: v${v.versionNumber} (${v.status})` : "",
          refPath
            ? `Reference image: \`${refPath}\`${ref?.status === "draft" ? " (draft, not yet approved)" : ""}`
            : "Reference image: none",
          "",
          b?.summary ?? "",
          "",
          "## Appearance",
          ...Object.entries({
            Presentation: b?.genderPresentation,
            Age: b?.ageRange,
            Height: b?.height,
            Build: b?.build,
            Face: b?.faceShape,
            Skin: b?.skinTone,
            Eyes: b?.eyes,
            Hair: b?.hair,
            "Facial hair": b?.facialHair,
            Wardrobe: b?.wardrobe,
            Personality: b?.personality,
            Mannerisms: b?.visualMannerisms,
          })
            .filter(([, val]) => val)
            .map(([k, val]) => `- **${k}:** ${val}`),
          b?.distinctiveFeatures?.length ? `- **Distinctive:** ${b.distinctiveFeatures.join("; ")}` : "",
          v?.immutableTraits.length ? `- **Never changes:** ${v.immutableTraits.join("; ")}` : "",
        ]
          .filter((l) => l !== undefined)
          .join("\n"),
      ),
    );
    charById.set(c.id, { id, name: c.name, reference: refPath });
    for (const cv of allCharVersions.filter((x) => x.characterId === c.id)) charByVersion.set(cv.id, c.id);
    characterDocs.push({
      id,
      name: c.name,
      role: c.role,
      aliases,
      description: `${dir}/description.md`,
      reference: refPath,
    });
  }

  const worldDocs = async (kind: "location" | "prop") => {
    const rows =
      kind === "location"
        ? await db
            .select({ e: locations, v: locationVersions })
            .from(locations)
            .leftJoin(locationVersions, eq(locationVersions.id, locations.currentVersionId))
            .where(and(eq(locations.projectId, project.id), isNull(locations.deletedAt)))
        : await db
            .select({ e: props, v: propVersions })
            .from(props)
            .leftJoin(propVersions, eq(propVersions.id, props.currentVersionId))
            .where(and(eq(props.projectId, project.id), isNull(props.deletedAt)));
    const map = new Map<string, { id: string; name: string; reference: string | null }>();
    const byVersion = new Map<string, string>();
    const docs = [];
    for (const { e, v } of rows) {
      const entitySlug = uniqueSlug(kind, e.name);
      const id = `${kind === "location" ? "loc" : "prop"}-${entitySlug}`;
      const dir = `${kind === "location" ? "locations" : "props"}/${entitySlug}`;
      const ref = await bestRef(kind === "location" ? "locationVersionId" : "propVersionId", v?.id ?? null);
      const img = ref ? await readAsset(ref.assetId) : null;
      const refPath = img ? `${dir}/reference.${extForMime(img.asset.mimeType)}` : null;
      if (img && refPath) await zip.add(refPath, img.data);
      const d = v?.description as Record<string, unknown> | undefined;
      await zip.add(
        `${dir}/description.md`,
        enc(
          [
            `# ${e.name} (\`${id}\`)`,
            refPath ? `Reference image: \`${refPath}\`` : "Reference image: none",
            "",
            String(d?.summary ?? ""),
            "",
            ...Object.entries(d ?? {})
              .filter(([k, val]) => k !== "summary" && (Array.isArray(val) ? val.length : val))
              .map(([k, val]) => `- **${k}:** ${Array.isArray(val) ? val.join("; ") : String(val)}`),
          ].join("\n"),
        ),
      );
      map.set(e.id, { id, name: e.name, reference: refPath });
      if (v) byVersion.set(v.id, e.id);
      docs.push({ id, name: e.name, description: `${dir}/description.md`, reference: refPath });
    }
    return { map, byVersion, docs };
  };
  const locs = await worldDocs("location");
  const prps = await worldDocs("prop");
  await progress(0.1);

  const [style] = project.currentStyleId
    ? await db
        .select({ s: projectStyles, p: stylePresets })
        .from(projectStyles)
        .leftJoin(stylePresets, eq(stylePresets.id, projectStyles.stylePresetId))
        .where(eq(projectStyles.id, project.currentStyleId))
    : [];
  const [latestStory] = await db
    .select()
    .from(storyRevisions)
    .where(eq(storyRevisions.projectId, project.id))
    .orderBy(desc(storyRevisions.revisionNumber))
    .limit(1);
  if (latestStory)
    await zip.add("story/story.md", enc(`# ${latestStory.title || project.title}\n\n${latestStory.content}`));

  // ---------------------------------------------------------------- chapters
  const chapterRows = await db
    .select()
    .from(chapters)
    .where(
      chapterId
        ? and(eq(chapters.projectId, project.id), eq(chapters.id, chapterId))
        : eq(chapters.projectId, project.id),
    )
    .orderBy(asc(chapters.order));
  const totalPages = (
    await db
      .select({ id: pages.id })
      .from(pages)
      .where(
        inArray(
          pages.chapterId,
          chapterRows.length ? chapterRows.map((c) => c.id) : ["00000000-0000-0000-0000-000000000000"],
        ),
      )
  ).length;
  let pagesDone = 0;
  const chapterDocs = [];

  for (const ch of chapterRows) {
    const chId = `ch${pad(ch.order, 2)}`;
    const chDir = `chapters/${pad(ch.order, 2)}-${slug(ch.title)}`;
    const sceneRows = await db.select().from(scenes).where(eq(scenes.chapterId, ch.id)).orderBy(asc(scenes.order));
    const beatRows = sceneRows.length
      ? await db
          .select()
          .from(storyBeats)
          .where(
            inArray(
              storyBeats.sceneId,
              sceneRows.map((s) => s.id),
            ),
          )
          .orderBy(asc(storyBeats.order))
      : [];
    const sceneId = (id: string | null) => {
      const s = sceneRows.find((x) => x.id === id);
      return s ? `${chId}-sc${pad(s.order, 2)}` : null;
    };
    if (ch.sourceExcerpt) await zip.add(`${chDir}/source.md`, enc(`# ${ch.title}\n\n${ch.sourceExcerpt}`));

    const pageRows = await db.select().from(pages).where(eq(pages.chapterId, ch.id)).orderBy(asc(pages.order));
    const panelIdMap = new Map<string, { id: string; pageId: string; readingOrder: number; globalIndex: number }>();
    const pageDocs = [];
    let globalIndex = 0;
    const panelDocsByDbId = new Map<
      string,
      { narrationSegmentIds: string[]; narrationTiming: { segmentId: string; startMs: number; durationMs: number }[] }
    >();

    for (const pg of pageRows) {
      const pgId = `${chId}-p${pad(pg.order, 3)}`;
      const render = await loadRenderPage(db, deps.assets.storage, pg.id, project.readingDirection);
      const img = await renderPageImage(render, "png", { scale: opts.scale ?? 1 });
      const pageImage = `${chDir}/pages/page-${pad(pg.order, 3)}.png`;
      await zip.add(pageImage, img.data);
      const pnRows = await db.select().from(panels).where(eq(panels.pageId, pg.id));
      const ordered = readingOrder(pnRows, pg.readingDirection ?? project.readingDirection);
      const dlg = await db
        .select()
        .from(dialogueLines)
        .where(eq(dialogueLines.pageId, pg.id))
        .orderBy(asc(dialogueLines.order));
      const sfx = await db.select().from(soundEffects).where(eq(soundEffects.pageId, pg.id));
      const panelDocs = [];
      for (const [i, pn] of ordered.entries()) {
        const pnId = `${pgId}-pn${pad(i + 1, 2)}`;
        panelIdMap.set(pn.id, { id: pnId, pageId: pgId, readingOrder: i + 1, globalIndex: globalIndex++ });
        const base = `${chDir}/panels/${pnId}`;
        const art = await readAsset(pn.activeArtworkAssetId);
        const artPath = art ? `${base}.${extForMime(art.asset.mimeType)}` : null;
        if (art && artPath) await zip.add(artPath, art.data);
        const f = pn.frame;
        const box = {
          left: Math.max(0, Math.round(f.x * img.width)),
          top: Math.max(0, Math.round(f.y * img.height)),
          width: Math.max(1, Math.round(f.width * img.width)),
          height: Math.max(1, Math.round(f.height * img.height)),
        };
        box.width = Math.min(box.width, img.width - box.left);
        box.height = Math.min(box.height, img.height - box.top);
        const letteredPath = `${base}.lettered.png`;
        await zip.add(letteredPath, new Uint8Array(await sharp(img.data).extract(box).png().toBuffer()));
        const [specRow] = await db
          .select()
          .from(panelSpecs)
          .where(eq(panelSpecs.panelId, pn.id))
          .orderBy(desc(panelSpecs.versionNumber))
          .limit(1);
        const spec = specRow?.spec as PanelSpec | undefined;
        const chars = [
          ...new Set(pn.characterVersionIds.map((v) => charByVersion.get(v)).filter((x): x is string => Boolean(x))),
        ].map((cid) => {
          const info = charById.get(cid)!;
          const ps = spec?.characters.find((c) => c.characterId === cid);
          return {
            id: info.id,
            name: info.name,
            reference: info.reference,
            expression: ps?.expression ?? "",
            pose: ps?.pose ?? "",
            position: ps?.position ?? "",
          };
        });
        const locId = pn.locationVersionId ? locs.byVersion.get(pn.locationVersionId) : undefined;
        const loc = locId ? locs.map.get(locId) : undefined;
        const dialogue = dlg
          .filter((d) => d.panelId === pn.id)
          .map((d) => ({
            speaker: d.characterId ? (charById.get(d.characterId)?.name ?? null) : null,
            speakerId: d.characterId ? (charById.get(d.characterId)?.id ?? null) : null,
            type: d.bubble.type,
            text: d.text,
          }));
        const effects = sfx.filter((s) => s.panelId === pn.id).map((s) => s.text);
        const narrationRef = {
          narrationSegmentIds: [] as string[],
          narrationTiming: [] as { segmentId: string; startMs: number; durationMs: number }[],
        };
        panelDocsByDbId.set(pn.id, narrationRef);
        await zip.add(
          `${base}.md`,
          enc(
            [
              `# Panel ${pnId}`,
              `Chapter ${ch.order} · page ${pg.order} · panel ${i + 1} in reading order (${pg.readingDirection ?? project.readingDirection})`,
              "",
              `- **Clean artwork (no lettering):** ${artPath ? `\`${artPath}\`` : "not generated yet"}`,
              `- **As printed (with bubbles/SFX):** \`${letteredPath}\``,
              `- **Story beat:** ${pn.storyBeat}`,
              `- **Shot / camera:** ${pn.shotType}${pn.cameraAngle ? ` / ${pn.cameraAngle}` : ""}`,
              spec?.action ? `- **Action:** ${spec.action}` : "",
              spec?.emotion ? `- **Mood:** ${spec.emotion}` : "",
              spec?.composition ? `- **Composition:** ${spec.composition}` : "",
              `- **Location:** ${loc ? `${loc.name} (\`${loc.id}\`)` : "unspecified"}`,
              `- **Characters:** ${chars.length ? chars.map((c) => `${c.name} (\`${c.id}\`)${c.expression ? ` — ${c.expression}` : ""}`).join("; ") : "none"}`,
              "",
              "## Dialogue",
              ...(dialogue.length
                ? dialogue.map((d) => `- ${d.speaker ?? "(no speaker)"} [${d.type}]: “${d.text}”`)
                : ["- none"]),
              "",
              "## Sound effects",
              effects.length ? `- ${effects.join(", ")}` : "- none",
              "",
              "Narration for this panel is listed in the chapter `narration/timeline.json` (field `panelId`).",
            ]
              .filter((l) => l !== "")
              .join("\n"),
          ),
        );
        panelDocs.push({
          id: pnId,
          readingOrder: i + 1,
          image: artPath,
          letteredImage: letteredPath,
          descriptionFile: `${base}.md`,
          frame: { normalized: f, pixels: box },
          storyBeat: pn.storyBeat,
          shotType: pn.shotType,
          cameraAngle: pn.cameraAngle,
          action: spec?.action ?? null,
          emotion: spec?.emotion ?? null,
          composition: spec?.composition ?? null,
          location: loc ? { id: loc.id, name: loc.name, reference: loc.reference } : null,
          characters: chars,
          dialogue,
          sfx: effects,
          narration: narrationRef,
        });
      }
      const layoutFile = `${chDir}/pages/page-${pad(pg.order, 3)}.json`;
      await zip.add(
        layoutFile,
        enc(
          JSON.stringify(
            {
              id: pgId,
              order: pg.order,
              image: pageImage,
              size: { width: img.width, height: img.height },
              readingDirection: pg.readingDirection ?? project.readingDirection,
              layoutTemplate: pg.layoutTemplate,
              scene: sceneId(pg.sceneId),
              purpose: pg.purpose,
              panels: panelDocs.map((p) => ({
                id: p.id,
                readingOrder: p.readingOrder,
                frame: p.frame,
                image: p.image,
                letteredImage: p.letteredImage,
              })),
            },
            null,
            2,
          ),
        ),
      );
      pageDocs.push({
        id: pgId,
        order: pg.order,
        image: pageImage,
        layoutFile,
        scene: sceneId(pg.sceneId),
        purpose: pg.purpose,
        pageTurnHook: pg.pageTurnHook,
        panels: panelDocs,
      });
      pagesDone++;
      await progress(0.1 + (pagesDone / Math.max(1, totalPages)) * 0.7);
    }

    // ---- narration: explicit panel links, otherwise inferred from surrounding lines in reading order
    const lines = await db
      .select()
      .from(narrationLines)
      .where(and(eq(narrationLines.chapterId, ch.id), eq(narrationLines.language, language)))
      .orderBy(asc(narrationLines.order));
    const orderedPanels = [...panelIdMap.entries()].sort((a, b) => a[1].globalIndex - b[1].globalIndex);
    const narratedPanels = new Set(lines.map((l) => l.panelId).filter((id) => id && panelIdMap.has(id))).size;
    const narrationCoverage = panelIdMap.size ? narratedPanels / panelIdMap.size : 1;
    const resolved: { panelDbId: string | null; inferred: boolean }[] = lines.map((l) => ({
      panelDbId: l.panelId && panelIdMap.has(l.panelId) ? l.panelId : null,
      inferred: false,
    }));
    for (let i = 0; i < resolved.length; i++) {
      if (resolved[i]!.panelDbId) continue;
      const prev = resolved
        .slice(0, i)
        .reverse()
        .find((r) => r.panelDbId && !r.inferred);
      const next = resolved.slice(i + 1).find((r) => r.panelDbId && !r.inferred);
      const fallback = orderedPanels.length
        ? orderedPanels[
            Math.min(orderedPanels.length - 1, Math.floor((i / Math.max(1, resolved.length)) * orderedPanels.length))
          ]![0]
        : null;
      resolved[i] = { panelDbId: prev?.panelDbId ?? next?.panelDbId ?? fallback, inferred: true };
    }
    const segs = lines.length
      ? await db
          .select({ s: narrationSegments, a: audioAssets })
          .from(narrationSegments)
          .leftJoin(audioAssets, eq(audioAssets.assetId, narrationSegments.activeAudioAssetId))
          .where(
            inArray(
              narrationSegments.narrationLineId,
              lines.map((l) => l.id),
            ),
          )
          .orderBy(asc(narrationSegments.order))
      : [];
    const timeline = [];
    const wavParts: { wav: Uint8Array; pauseAfterMs: number }[] = [];
    let t = 0;
    let n = 0;
    for (const [li, line] of lines.entries()) {
      for (const { s, a } of segs.filter((x) => x.s.narrationLineId === line.id)) {
        n++;
        const segId = `${chId}-seg-${pad(n, 4)}`;
        const link = resolved[li]!;
        const panel = link.panelDbId ? panelIdMap.get(link.panelDbId) : undefined;
        let file: string | null = null;
        let durationMs = 0;
        if (a) {
          const audio = await readAsset(a.assetId);
          if (audio) {
            file = `${chDir}/narration/${segId}.wav`;
            let wav = audio.data;
            const info = parseWav(wav);
            if (info.sampleRate !== 24000 || info.channels !== 1 || info.bitsPerSample !== 16)
              wav = await ffmpegConvert(wav, "wav", { tempDir: deps.config.TEMP_ROOT });
            await zip.add(file, wav);
            durationMs = parseWav(wav).durationMs;
            wavParts.push({ wav, pauseAfterMs: s.pauseAfterMs });
          }
        }
        const entry = {
          id: segId,
          lineOrder: line.order,
          text: s.text,
          panelId: panel?.id ?? null,
          pageId: panel?.pageId ?? null,
          panelLinkInferred: link.inferred,
          shownOnPage: line.showOnPage,
          audio: file,
          voice: a?.voice ?? null,
          startMs: file ? t : null,
          durationMs: file ? durationMs : null,
          pauseAfterMs: s.pauseAfterMs,
        };
        if (file) t += durationMs + s.pauseAfterMs;
        timeline.push(entry);
        if (panel && link.panelDbId) {
          const ref = panelDocsByDbId.get(link.panelDbId)!;
          ref.narrationSegmentIds.push(segId);
          if (entry.startMs !== null)
            ref.narrationTiming.push({ segmentId: segId, startMs: entry.startMs, durationMs: entry.durationMs ?? 0 });
        }
      }
    }
    let chapterAudio: { wav: string; mp3: string | null } | null = null;
    if (wavParts.length) {
      const joined = concatWav(wavParts);
      chapterAudio = { wav: `${chDir}/narration/narration.wav`, mp3: `${chDir}/narration/narration.mp3` };
      await zip.add(chapterAudio.wav, joined);
      try {
        await zip.add(
          chapterAudio.mp3!,
          await ffmpegConvert(joined, "mp3", {
            normalize: true,
            tempDir: deps.config.TEMP_ROOT,
          }),
        );
      } catch {
        chapterAudio.mp3 = null;
      }
    }
    const timelineFile = `${chDir}/narration/timeline.json`;
    await zip.add(
      timelineFile,
      enc(
        JSON.stringify(
          {
            chapterId: chId,
            audio: chapterAudio,
            totalDurationMs: t,
            note: "startMs is the offset inside the chapter narration track (segments without audio have null timing). panelLinkInferred=true means the narration line had no explicit panel and was attached to the nearest linked panel in reading order.",
            segments: timeline,
          },
          null,
          2,
        ),
      ),
    );

    await zip.add(
      `${chDir}/chapter.md`,
      enc(
        [
          `# Chapter ${ch.order}: ${ch.title} (\`${chId}\`)`,
          "",
          ch.summary,
          ch.openingState ? `\n**Opening state:** ${ch.openingState}` : "",
          ch.closingState ? `**Closing state:** ${ch.closingState}` : "",
          "",
          "## Scenes",
          ...sceneRows.flatMap((s) => [
            `### ${sceneId(s.id)} — ${s.title}`,
            s.summary,
            [s.time && `Time: ${s.time}`, s.weather && `Weather: ${s.weather}`].filter(Boolean).join(" · "),
            ...beatRows.filter((b) => b.sceneId === s.id).map((b) => `- ${b.description}`),
            "",
          ]),
          "## Pages",
          ...pageDocs.map(
            (p) => `- \`${p.id}\` → \`${p.image}\` (${p.panels.length} panels${p.purpose ? `, ${p.purpose}` : ""})`,
          ),
          "",
          `Narration: ${timeline.length} segments${chapterAudio ? `, full track \`${chapterAudio.wav}\`` : " (no synthesized audio yet)"}; timing in \`${timelineFile}\`.`,
        ]
          .filter((l) => l !== undefined)
          .join("\n"),
      ),
    );

    chapterDocs.push({
      id: chId,
      order: ch.order,
      title: ch.title,
      summary: ch.summary,
      overviewFile: `${chDir}/chapter.md`,
      sourceFile: ch.sourceExcerpt ? `${chDir}/source.md` : null,
      memory: {
        openingState: ch.openingState,
        closingState: ch.closingState,
        characterStateChanges: ch.characterStateChanges,
        revealedFacts: ch.revealedFacts,
      },
      scenes: sceneRows.map((s) => ({
        id: sceneId(s.id),
        title: s.title,
        summary: s.summary,
        time: s.time,
        weather: s.weather,
        location: s.locationId ? (locs.map.get(s.locationId)?.id ?? null) : null,
        characters: s.characterIds.map((c) => charById.get(c)?.id).filter(Boolean),
        beats: beatRows.filter((b) => b.sceneId === s.id).map((b) => b.description),
      })),
      pages: pageDocs,
      narration: {
        audio: chapterAudio,
        timelineFile,
        totalDurationMs: t,
        segmentCount: timeline.length,
        lineCount: lines.length,
        panelCoverage: Math.round(narrationCoverage * 1000) / 1000,
      },
    });
  }
  await progress(0.9);

  const manifest = {
    format: "openmanga-agent-package",
    formatVersion: 1,
    generatedAt: new Date().toISOString(),
    project: {
      title: project.title,
      description: project.description,
      type: project.projectType,
      language: project.language,
      readingDirection: project.readingDirection,
      colorMode: project.colorMode,
      style: style ? { preset: style.p?.name ?? null, notes: style.s.customDescription } : null,
      storyFile: latestStory ? "story/story.md" : null,
    },
    characters: characterDocs,
    locations: locs.docs,
    props: prps.docs,
    /** Problems a consumer should know about before assembling (missing art, narration gaps, missing audio…). */
    warnings,
    narrationLanguage: language,
    readiness: readiness.issues,
    chapters: chapterDocs,
  };
  await zip.add("manifest.json", enc(JSON.stringify(manifest, null, 2)));
  await zip.add(
    "README.md",
    enc(
      (warnings.length ? `> **Warnings**\n${warnings.map((w) => `> - ${w}`).join("\n")}\n\n` : "") +
        readme(project, manifest.chapters.length),
    ),
  );
  if (warnings.length) deps.logger.warn("agent package warnings", { projectId: project.id, warnings });
  return {
    name: `${slug(project.title)}_agent_package${chapterId ? `_${chapterDocs[0]?.id ?? "chapter"}` : ""}.zip`,
    path: await zip.close(),
  };
}

function readme(project: Project, chapterCount: number) {
  return `# ${project.title} — agent hand-off package

Generated by OpenManga. Everything needed to assemble a comic, webtoon or narrated recap video is here,
linked by stable, readable IDs. Start with \`manifest.json\`; every image and audio file also has a Markdown
description next to it or in its chapter folder.

## IDs
| Pattern | Meaning |
| --- | --- |
| \`ch01\` | chapter 1 |
| \`ch01-sc02\` | scene 2 of chapter 1 |
| \`ch01-p003\` | page 3 of chapter 1 |
| \`ch01-p003-pn02\` | panel 2 on that page, **in reading order** (${project.readingDirection}) |
| \`ch01-seg-0007\` | narration segment 7 of chapter 1 (chapter-wide order) |
| \`char-<name>\`, \`loc-<name>\`, \`prop-<name>\` | characters, locations, props |

## Layout
\`\`\`
manifest.json                  all links (see below)
story/story.md                 latest story text
characters/<name>/             description.md + reference image (identity source of truth)
locations/<name>/, props/<name>/
chapters/NN-<title>/
  chapter.md                   summary, scenes, beats, page list
  source.md                    source text for this chapter
  pages/page-NNN.png           final lettered page
  pages/page-NNN.json          panel frames (normalized 0..1 and pixels) in reading order
  panels/<panelId>.png         clean artwork (no text)
  panels/<panelId>.lettered.png  panel cropped from the final page (with bubbles/SFX)
  panels/<panelId>.md          shot, action, characters, location, dialogue, SFX
  narration/<segmentId>.wav    one file per narration segment (24 kHz mono)
  narration/narration.wav|mp3  full chapter narration track
  narration/timeline.json      text, panelId, pageId, startMs, durationMs per segment
\`\`\`

## manifest.json
- \`chapters[].pages[].panels[]\` are in reading order and include image paths, characters (with reference images),
  location, dialogue (speaker, bubble type, text), SFX and \`narration.narrationSegmentIds\` plus
  \`narration.narrationTiming\` (start/duration inside the chapter track).
- \`chapters[].narration.timelineFile\` holds every segment. \`panelLinkInferred: true\` means the narration line had no
  explicit panel and was attached to the nearest linked panel in reading order; treat it as a suggestion.
- Segments without synthesized audio have \`audio: null\` and null timing.

## Suggested video assembly (${chapterCount} chapter${chapterCount === 1 ? "" : "s"})
1. For each chapter, play \`narration/narration.wav\` (or the mp3) as the voice track.
2. Walk panels in reading order. Show a panel from the earliest \`startMs\` of its narration segments until the next
   panel's first segment starts; give panels without narration 2–3 seconds between their neighbours.
3. Use \`<panelId>.lettered.png\` when dialogue should be readable on screen, the clean \`<panelId>.png\` when you add your
   own captions (dialogue text is in the panel's \`dialogue\` list).
4. Panel images can be larger or differently shaped than their page frames; \`frame\` in \`pages/page-NNN.json\` shows
   how they were cropped on the printed page. Slow pan/zoom works well for still panels.
5. Keep character identity consistent with \`characters/<name>/reference.*\` if you generate anything new.
`;
}
