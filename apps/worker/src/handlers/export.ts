import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { AUDIO_MIME, concatWav, ffmpegConvert, parseWav } from "@openmanga/audio";
import {
  and,
  asc,
  assets,
  audioAssets,
  chapters,
  characterAliases,
  characterOutfits,
  characters,
  characterVersions,
  desc,
  dialogueLines,
  eq,
  exportJobs,
  exportsTable,
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
  projectStyles,
  projects,
  props,
  propVersions,
  referenceAssets,
  scenes,
  soundEffects,
  sql,
  storyBeats,
  storyRevisions,
  stylePresets,
} from "@openmanga/db";
import { buildTimeline, chunkStrip, type SeamedBlock, youtubeChapters } from "@openmanga/domain";
import { extForMime, sharp } from "@openmanga/image-utils";
import { type Job, UnrecoverableError } from "@openmanga/queue";
import { ProjectInterchange as InterchangeSchema, type ProjectInterchange } from "@openmanga/schemas";
import {
  loadRenderPage,
  renderCover,
  renderPageImage,
  renderStrip,
  renderThumbnail,
  renderWebtoonBlocks,
} from "@openmanga/services";
import { withTempDir } from "@openmanga/storage";
import type { WorkerDeps } from "../context.ts";
import { type BookImage, type BookMeta, writeBook } from "../lib/ebook.ts";
import { type ImagePage, PdfWriter } from "../lib/pdf.ts";
import { renderPageCutVideo, renderPanelCutVideo, type VideoOptions } from "../lib/video.ts";
import { ZipWriter } from "../lib/zip.ts";
import { buildAgentPackage } from "./agent-package.ts";
import { importProject } from "./import.ts";

type ExportJob = typeof exportJobs.$inferSelect;
type Opts = {
  kind: ExportJob["kind"];
  chapterId: string | null;
  pageIds?: string[];
  scale: number;
  jpgQuality: number;
  pdf: {
    pageSize: string;
    marginMm: number;
    bleedMm: number;
    dpi: number;
    readingDirection?: "ltr" | "rtl" | "vertical";
  };
  webtoon: { width?: number; gap?: number; split: boolean; maxChunkHeight?: number; format: "png" | "jpg" };
  audio: { format: "wav" | "mp3" | "ogg"; normalize: boolean };
  includeAssets: boolean;
  language?: string;
  video?: Partial<VideoOptions>;
};

class ExportCancelled extends Error {}
const safeName = (s: string) =>
  s
    .replace(/[^\w\- ]+/g, "")
    .trim()
    .replace(/\s+/g, "_")
    .slice(0, 60) || "export";
const PAGE_SIZES_PT: Record<string, [number, number]> = {
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  B5: [498.9, 708.66],
  letter: [612, 792],
  tankobon: [362.83, 515.91],
};
const mm = (v: number) => (v / 25.4) * 72;
/** Amazon KDP trim sizes in inches. Printed with bleed: the page is 0.125" wider and 0.25" taller than the trim. */
const KDP_TRIM_IN: Record<string, [number, number]> = {
  kdp_5x8: [5, 8],
  kdp_5_5x8_5: [5.5, 8.5],
  kdp_6x9: [6, 9],
  kdp_7x10: [7, 10],
  kdp_8_5x11: [8.5, 11],
};

export async function processExport(deps: WorkerDeps, bullJob: Job) {
  const id = String(bullJob.data.exportJobId);
  const [job] = await deps.db.select().from(exportJobs).where(eq(exportJobs.id, id));
  if (!job || job.status === "completed" || job.status === "cancelled") return;
  const opts = job.options as unknown as Opts;
  const publish = (status: string, progress: number, failureReason?: string | null) =>
    deps.events.publish(job.projectId, { type: "export.updated", exportJobId: id, status, progress, failureReason });
  await deps.db
    .update(exportJobs)
    .set({ status: "processing", startedAt: new Date(), attempts: sql`${exportJobs.attempts} + 1` })
    .where(eq(exportJobs.id, id));
  await publish("processing", 0);
  const progress = async (p: number) => {
    const [row] = await deps.db
      .update(exportJobs)
      .set({ progress: p })
      .where(eq(exportJobs.id, id))
      .returning({ status: exportJobs.status });
    if (row?.status === "cancel_requested") throw new ExportCancelled();
    await publish("processing", p);
  };
  try {
    // Project import rides the render queue: it restores into job.projectId instead of producing files.
    if (job.kind === "project_import") {
      const result = await importProject(deps, job, progress);
      await deps.db
        .update(exportJobs)
        .set({ status: "completed", progress: 1, finishedAt: new Date(), failureReason: null, result })
        .where(eq(exportJobs.id, id));
      await publish("completed", 1);
      return result;
    }
    await mkdir(deps.config.TEMP_ROOT, { recursive: true });
    const [project] = await deps.db.select().from(projects).where(eq(projects.id, job.projectId));
    if (!project) throw new UnrecoverableError("Project no longer exists");
    // Files built on disk (video, PDF, archives) are stored from the temp dir, so everything happens before it is removed.
    const files = await withTempDir(deps.config.TEMP_ROOT, async (dir) => {
      const files = await buildExport(deps, job, opts, project, progress, dir);
      await deps.db.transaction(async (tx) => {
        for (const f of files) {
          const asset = await deps.assets.store(
            {
              projectId: job.projectId,
              ownerUserId: job.userId,
              type: "export",
              ...("path" in f ? { filePath: f.path } : { data: f.data }),
              mimeType: f.mime,
              width: f.width ?? null,
              height: f.height ?? null,
              durationMs: f.durationMs ?? null,
              metadata: { exportJobId: id, kind: job.kind, fileName: f.name },
            },
            tx,
          );
          await tx.insert(exportsTable).values({
            projectId: job.projectId,
            exportJobId: id,
            assetId: asset.id,
            kind: job.kind,
            fileName: f.name,
            expiresAt: new Date(Date.now() + 30 * 86400_000),
          });
        }
        await tx
          .update(exportJobs)
          .set({ status: "completed", progress: 1, finishedAt: new Date(), failureReason: null })
          .where(eq(exportJobs.id, id));
      });
      return files;
    });
    await publish("completed", 1);
    return { files: files.map((f) => f.name) };
  } catch (e) {
    if (e instanceof ExportCancelled) {
      await deps.db
        .update(exportJobs)
        .set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(exportJobs.id, id));
      await publish("cancelled", 0);
      return;
    }
    const message = e instanceof Error ? e.message : String(e);
    deps.logger.error("export failed", {
      exportJobId: id,
      error: message,
      stack: e instanceof Error ? e.stack : undefined,
    });
    const isImport = job.kind === "project_import"; // imports delete their upload, so they never retry
    const final =
      isImport || e instanceof UnrecoverableError || bullJob.attemptsMade + 1 >= (bullJob.opts.attempts ?? 1);
    const safe =
      e instanceof UnrecoverableError
        ? message
        : isImport
          ? "Import failed while restoring the project. Check the logs and upload the file again."
          : "Export failed while composing files. Check the logs or retry.";
    await deps.db
      .update(exportJobs)
      .set({ status: final ? "failed" : "queued", failureReason: safe, finishedAt: final ? new Date() : null })
      .where(eq(exportJobs.id, id));
    await publish(final ? "failed" : "queued", 0, safe);
    throw e;
  }
}

type OutFile = { name: string; mime: string; width?: number; height?: number; durationMs?: number } & (
  | { data: Uint8Array }
  | { path: string }
);

/**
 * The export's pages in reading order, each with its chapter's number: a chosen chapter, a page selection, or the
 * whole project. Always scoped to the job's own project: page ids reach this through job options, i.e. from a request
 * body.
 */
async function pagesFor(deps: WorkerDeps, opts: Opts, projectId: string) {
  return deps.db
    .select({ id: pages.id, chapter: chapters.order })
    .from(pages)
    .innerJoin(chapters, eq(chapters.id, pages.chapterId))
    .where(
      and(
        eq(pages.projectId, projectId),
        opts.pageIds?.length
          ? inArray(pages.id, opts.pageIds)
          : opts.chapterId
            ? eq(pages.chapterId, opts.chapterId)
            : undefined,
      ),
    )
    .orderBy(asc(chapters.order), asc(pages.order));
}

async function buildExport(
  deps: WorkerDeps,
  job: ExportJob,
  opts: Opts,
  project: typeof projects.$inferSelect,
  progress: (p: number) => Promise<void>,
  dir: string,
): Promise<OutFile[]> {
  const base = safeName(project.title);
  const [chapter] = opts.chapterId
    ? await deps.db
        .select({ title: chapters.title, order: chapters.order })
        .from(chapters)
        .where(eq(chapters.id, opts.chapterId))
    : [];
  // Printed on the PDF cover, so it stays the plain title.
  const chapterTitle = opts.chapterId ? (chapter?.title ?? "chapter") : "project";
  // Filenames lead with the number instead: chapter titles repeat across a series, and a downloaded file has to
  // identify itself on disk long after the page that produced it is closed.
  const scope = opts.chapterId
    ? `ch${String(chapter?.order ?? 0).padStart(2, "0")}_${safeName(chapterTitle)}`
    : "project";
  const prefix = `${base}_${scope}`;

  switch (job.kind) {
    case "png_pages":
    case "jpg_pages": {
      const fmt = job.kind === "png_pages" ? "png" : "jpg";
      const ids = await pagesFor(deps, opts, project.id);
      if (!ids.length) throw new UnrecoverableError("No pages to export");
      const zip = ids.length > 1 ? new ZipWriter(join(dir, "pages.zip")) : null;
      for (const [i, { id: pid, chapter: chapterNo }] of ids.entries()) {
        const page = await loadRenderPage(deps.db, deps.assets.storage, pid, project.readingDirection);
        const img = await renderPageImage(page, fmt, { scale: opts.scale, quality: opts.jpgQuality });
        // Page numbers restart in every chapter, so an export spanning chapters names each page by both.
        const pageNo = `p${String(page.order).padStart(3, "0")}`;
        const name = opts.chapterId
          ? `${prefix}_${pageNo}.${fmt}`
          : `${prefix}_ch${String(chapterNo).padStart(2, "0")}_${pageNo}.${fmt}`;
        if (!zip) return [{ name, data: img.data, mime: img.mime, width: img.width, height: img.height }];
        await zip.add(name, img.data);
        await progress((i + 1) / ids.length);
      }
      return [{ name: `${prefix}_${fmt}_pages.zip`, path: await zip!.close(), mime: "application/zip" }];
    }
    case "pdf": {
      const ids = await pagesFor(deps, opts, project.id);
      if (!ids.length) throw new UnrecoverableError("No pages to export");
      // Streamed page by page into the file, so a whole-project PDF costs the memory of one page.
      const path = join(dir, "book.pdf");
      const pdf = await PdfWriter.create(path, {
        title: opts.chapterId ? `${project.title} — ${chapterTitle}` : project.title,
        rtl: (opts.pdf.readingDirection ?? project.readingDirection) === "rtl",
      });
      // A KDP interior carries no cover: the cover is a separate file uploaded next to it.
      if (project.coverAssetId && !KDP_TRIM_IN[opts.pdf.pageSize]) {
        const cover = await deps.assets.get(project.coverAssetId);
        if (cover) {
          const png = await renderCover(
            await deps.assets.read(cover),
            project.title,
            opts.chapterId ? chapterTitle : "",
            project.settings.author,
          );
          await pdf.addPage(imagePage(png, 1200, 1800, opts));
        }
      }
      for (const [i, { id: pid }] of ids.entries()) {
        const page = await loadRenderPage(deps.db, deps.assets.storage, pid, project.readingDirection);
        const img = await renderPageImage(page, "png", { scale: opts.scale });
        await pdf.addPage(imagePage(img.data, img.width, img.height, opts, i));
        await progress((i + 1) / ids.length);
      }
      await pdf.close();
      return [{ name: `${prefix}.pdf`, path, mime: "application/pdf" }];
    }
    case "webtoon": {
      const ids = await pagesFor(deps, opts, project.id);
      if (!ids.length) throw new UnrecoverableError("No pages to export");
      const width = opts.webtoon.width ?? project.settings.webtoonWidth;
      const gap = opts.webtoon.gap ?? project.settings.webtoonGap;
      const maxH = opts.webtoon.maxChunkHeight ?? project.settings.webtoonChunkHeight;
      // Panel blocks wait on disk, not in memory: a whole project is thousands of them. Only the chunk being
      // stitched is read back, so memory is bounded by the chunk height rather than by the length of the strip.
      const blocks: (SeamedBlock & { path: string })[] = [];
      for (const [i, { id: pid }] of ids.entries()) {
        const page = await loadRenderPage(deps.db, deps.assets.storage, pid, project.readingDirection);
        for (const b of await renderWebtoonBlocks(page, width)) {
          const path = join(dir, `block-${blocks.length}.png`);
          await Bun.write(path, b.data);
          blocks.push({ path, height: b.height, seam: b.seam });
        }
        await progress(((i + 1) / ids.length) * 0.8);
      }
      // Seam-aware: a vertical project authors what happens between panels, so chunking has to respect blends
      // and stacking has to honour them. With no seams this produces the same strip as the old uniform stack.
      const chunks = opts.webtoon.split ? chunkStrip(blocks, maxH, { gap }) : [blocks];
      const zip = chunks.length > 1 ? new ZipWriter(join(dir, "webtoon.zip")) : null;
      for (const [i, chunk] of chunks.entries()) {
        const loaded = await Promise.all(chunk.map(async (b) => ({ ...b, data: await Bun.file(b.path).bytes() })));
        const strip = await renderStrip(loaded, width, gap);
        const data =
          opts.webtoon.format === "jpg"
            ? new Uint8Array(
                await sharp(strip.data, { limitInputPixels: false })
                  .jpeg({ quality: opts.jpgQuality, mozjpeg: true })
                  .toBuffer(),
              )
            : strip.data;
        const name = `${prefix}_webtoon_${String(i + 1).padStart(2, "0")}.${opts.webtoon.format}`;
        if (!zip) return [{ name, data, mime: opts.webtoon.format === "jpg" ? "image/jpeg" : "image/png", width }];
        await zip.add(name, data);
        await progress(0.8 + ((i + 1) / chunks.length) * 0.2);
      }
      await progress(1);
      return [{ name: `${prefix}_webtoon.zip`, path: await zip!.close(), mime: "application/zip" }];
    }
    case "narration_audio":
    case "timeline": {
      if (!opts.chapterId) throw new UnrecoverableError("Choose a chapter");
      const rows = await deps.db
        .select({ s: narrationSegments, l: narrationLines, a: audioAssets })
        .from(narrationSegments)
        .innerJoin(narrationLines, eq(narrationLines.id, narrationSegments.narrationLineId))
        .leftJoin(audioAssets, eq(audioAssets.assetId, narrationSegments.activeAudioAssetId))
        .where(
          and(
            eq(narrationLines.chapterId, opts.chapterId),
            eq(narrationLines.language, opts.language || project.language),
          ),
        )
        .orderBy(asc(narrationLines.order), asc(narrationSegments.order));
      const timeline = buildTimeline(
        opts.chapterId,
        rows.map((r) => ({
          panelId: r.l.panelId,
          segmentId: r.s.id,
          audioAssetId: r.a?.assetId ?? null,
          durationMs: r.a?.durationMs ?? null,
          pauseAfterMs: r.s.pauseAfterMs,
          text: r.s.text,
        })),
      );
      const timelineJson = new TextEncoder().encode(JSON.stringify(timeline, null, 2));
      if (job.kind === "timeline")
        return [{ name: `${prefix}_timeline.json`, data: timelineJson, mime: "application/json" }];
      const withAudio = rows.filter((r) => r.a);
      if (!withAudio.length)
        throw new UnrecoverableError("No synthesized narration in this chapter yet. Synthesize segments first.");
      const zip = new ZipWriter(join(dir, "narration.zip"));
      await zip.add("timeline.json", timelineJson);
      const parts: { wav: Uint8Array; pauseAfterMs: number }[] = [];
      for (const [i, r] of withAudio.entries()) {
        const asset = await deps.assets.get(r.a!.assetId);
        if (!asset) continue;
        let wav = await deps.assets.read(asset);
        const info = parseWav(wav);
        if (info.sampleRate !== 24000 || info.channels !== 1 || info.bitsPerSample !== 16)
          wav = await ffmpegConvert(wav, "wav", { tempDir: deps.config.TEMP_ROOT });
        parts.push({ wav, pauseAfterMs: r.s.pauseAfterMs });
        await zip.add(`segments/${String(i + 1).padStart(4, "0")}.wav`, wav);
        await progress(((i + 1) / withAudio.length) * 0.7);
      }
      const joined = concatWav(parts);
      const final =
        opts.audio.format === "wav" && !opts.audio.normalize
          ? joined
          : await ffmpegConvert(joined, opts.audio.format, {
              normalize: opts.audio.normalize,
              tempDir: deps.config.TEMP_ROOT,
            });
      await zip.add(`chapter.${opts.audio.format}`, final);
      const missing = rows.length - withAudio.length;
      if (missing)
        await zip.add(
          "MISSING_SEGMENTS.txt",
          new TextEncoder().encode(`${missing} segment(s) had no synthesized audio and were skipped.\n`),
        );
      await progress(1);
      return [
        {
          name: `${prefix}_narration.${opts.audio.format}`,
          data: final,
          mime: AUDIO_MIME[opts.audio.format],
          durationMs: parseWav(joined).durationMs,
        },
        { name: `${prefix}_narration_package.zip`, path: await zip.close(), mime: "application/zip" },
      ];
    }
    case "project_json": {
      const { doc } = await buildInterchange(deps, project, false);
      return [
        {
          name: `${base}_project.json`,
          data: new TextEncoder().encode(JSON.stringify(doc, null, 2)),
          mime: "application/json",
        },
      ];
    }
    case "video_pages":
    case "video_panels": {
      const v: VideoOptions = {
        height: 1080,
        fps: 30,
        minHoldMs: 2500,
        framing: "width",
        pageWidthRatio: 0.6,
        pageHeightRatio: 0.96,
        maxScrollPxPerSec: 60,
        zoom: 0.06,
        breathMs: 150,
        concurrency: deps.config.VIDEO_ENCODE_CONCURRENCY,
        ...opts.video,
      };
      const render = job.kind === "video_panels" ? renderPanelCutVideo : renderPageCutVideo;
      // A page selection narrows the film to those pages; otherwise the chapter, or the whole project.
      const scope = opts.pageIds?.length ? { pageIds: opts.pageIds } : undefined;
      const out = await render(deps, project, opts.chapterId, { ...v, language: opts.language, scope }, dir, progress);
      deps.logger.info("video export rendered", {
        exportJobId: job.id,
        kind: job.kind,
        ...out.report,
        pages: undefined,
        panels: undefined,
        loudness: undefined,
      });
      await progress(1);
      const name = `${prefix}_${out.report.language}_${job.kind === "video_panels" ? "panel" : "page"}-cut_${v.height}p`;
      return [
        {
          name: `${name}.mp4`,
          path: out.path,
          mime: "video/mp4",
          width: out.width,
          height: out.height,
          durationMs: out.durationMs,
        },
        { name: `${name}.srt`, data: new TextEncoder().encode(out.srt), mime: "application/x-subrip" },
        ...(await chapterFile(deps, out.chapterStarts, name)),
      ];
    }
    case "youtube_package": {
      // Packs what already exists (exports make no AI calls): the newest finished video of the same scope, with
      // its subtitles and chapter timestamps, the thumbnail and the saved publishing text.
      const yt = project.settings.youtubePackage;
      if (!yt?.titles.length)
        throw new UnrecoverableError("Write the YouTube package first (Exports → YouTube package)");
      const [video] = await deps.db
        .select({ id: exportJobs.id })
        .from(exportJobs)
        .where(
          and(
            eq(exportJobs.projectId, project.id),
            inArray(exportJobs.kind, ["video_pages", "video_panels"]),
            eq(exportJobs.status, "completed"),
            opts.chapterId ? eq(exportJobs.chapterId, opts.chapterId) : isNull(exportJobs.chapterId),
            // The full film only: not a page selection or a first-minutes check render of the same scope.
            sql`coalesce(jsonb_array_length(${exportJobs.options}->'pageIds'), 0) = 0`,
            sql`${exportJobs.options}->'video'->'maxDurationMs' is null`,
          ),
        )
        .orderBy(desc(exportJobs.createdAt))
        .limit(1);
      if (!video)
        throw new UnrecoverableError(
          `Render the ${opts.chapterId ? "chapter's" : "whole project's"} video first; the package reuses the newest one`,
        );
      const files = await deps.db
        .select({ name: exportsTable.fileName, a: assets })
        .from(exportsTable)
        .innerJoin(assets, eq(assets.id, exportsTable.assetId))
        .where(eq(exportsTable.exportJobId, video.id));
      const enc = new TextEncoder();
      const zip = new ZipWriter(join(dir, "youtube.zip"));
      let chaptersText = "";
      for (const [i, f] of files.entries()) {
        if (f.name.endsWith(".mp4"))
          await zip.addStream(`video/${f.name}`, deps.assets.storage.stream(f.a.storageKey), f.a.byteSize);
        else {
          const data = await deps.assets.read(f.a);
          if (f.name.endsWith(".chapters.txt")) chaptersText = new TextDecoder().decode(data).trim();
          await zip.add(`video/${f.name}`, data);
        }
        await progress(((i + 1) / files.length) * 0.8);
      }
      const thumb = project.settings.thumbnail;
      const art = thumb ? await deps.assets.get(thumb.assetId) : null;
      if (thumb && art && !art.deletedAt)
        await zip.add(
          "thumbnail.png",
          await renderThumbnail(await deps.assets.read(art), thumb.title, thumb.subtitle, thumb.side),
        );
      const description = chaptersText ? `${yt.description.trim()}\n\n${chaptersText}` : yt.description.trim();
      await zip.add("description.txt", enc.encode(`${description}\n`));
      await zip.add("titles.txt", enc.encode(`${yt.titles.join("\n")}\n`));
      await zip.add("tags.txt", enc.encode(`${yt.tags.join(", ")}\n`));
      if (yt.pinnedComment.trim()) await zip.add("pinned-comment.txt", enc.encode(`${yt.pinnedComment.trim()}\n`));
      if (yt.thumbnailHeadlines.length)
        await zip.add("thumbnail-headlines.txt", enc.encode(`${yt.thumbnailHeadlines.join("\n")}\n`));
      await progress(1);
      return [{ name: `${prefix}_youtube.zip`, path: await zip.close(), mime: "application/zip" }];
    }
    case "project_import":
      throw new UnrecoverableError("Project imports are handled by the import processor");
    case "agent_package": {
      const pkg = await buildAgentPackage(deps, project, opts.chapterId, progress, {
        scale: opts.scale,
        language: opts.language,
        dir,
      });
      await progress(1);
      return [{ name: pkg.name, path: pkg.path, mime: "application/zip" }];
    }
    case "cbz":
    case "epub": {
      const ids = await pagesFor(deps, opts, project.id);
      if (!ids.length) throw new UnrecoverableError("No pages to export");
      const meta: BookMeta = {
        id: job.id,
        title: opts.chapterId ? `${project.title} — ${chapterTitle}` : project.title,
        series: project.title,
        number: opts.chapterId ? chapter?.order : undefined,
        author: project.settings.author ?? "",
        summary: project.description,
        language: project.language,
        rtl: project.readingDirection === "rtl",
        blackAndWhite: project.colorMode !== "full_color",
      };
      let cover: BookImage | undefined;
      if (job.kind === "epub" && project.coverAssetId) {
        const art = await deps.assets.get(project.coverAssetId);
        if (art) {
          const png = await renderCover(
            await deps.assets.read(art),
            project.title,
            opts.chapterId ? chapterTitle : "",
            meta.author,
          );
          const jpg = await sharp(png)
            .jpeg({ quality: opts.jpgQuality, mozjpeg: true })
            .toBuffer({ resolveWithObject: true });
          cover = { data: new Uint8Array(jpg.data), width: jpg.info.width, height: jpg.info.height };
        }
      }
      // Each page goes into the archive as it is composed; only its size is kept for the EPUB package files.
      async function* rendered() {
        for (const [i, { id: pid }] of ids.entries()) {
          const page = await loadRenderPage(deps.db, deps.assets.storage, pid, project.readingDirection);
          yield await renderPageImage(page, "jpg", { scale: opts.scale, quality: opts.jpgQuality });
          await progress(((i + 1) / ids.length) * 0.95);
        }
      }
      const ext = job.kind === "cbz" ? "cbz" : "epub";
      const path = await writeBook(job.kind, join(dir, `book.${ext}`), meta, rendered(), cover);
      return [
        {
          name: `${prefix}.${ext}`,
          path,
          mime: job.kind === "cbz" ? "application/vnd.comicbook+zip" : "application/epub+zip",
        },
      ];
    }
    case "zip_package": {
      const zip = new ZipWriter(join(dir, "package.zip"));
      const { doc } = await buildInterchange(deps, project, opts.includeAssets, progress, zip);
      const chaptersRows = await deps.db
        .select()
        .from(chapters)
        .where(eq(chapters.projectId, project.id))
        .orderBy(asc(chapters.order));
      let n = 0;
      const pageRows = await deps.db
        .select({ id: pages.id, chapterId: pages.chapterId, order: pages.order })
        .from(pages)
        .where(eq(pages.projectId, project.id));
      for (const ch of chaptersRows) {
        for (const pg of pageRows.filter((p) => p.chapterId === ch.id).sort((a, b) => a.order - b.order)) {
          const page = await loadRenderPage(deps.db, deps.assets.storage, pg.id, project.readingDirection);
          const img = await renderPageImage(page, "png", { scale: 0.75 });
          await zip.add(
            `pages/${String(ch.order).padStart(2, "0")}_${safeName(ch.title)}/p${String(pg.order).padStart(3, "0")}.png`,
            img.data,
          );
          n++;
          await progress(0.5 + (n / Math.max(1, pageRows.length)) * 0.5);
        }
      }
      await zip.add("project.json", new TextEncoder().encode(JSON.stringify(doc, null, 2)));
      return [{ name: `${base}_package.zip`, path: await zip.close(), mime: "application/zip" }];
    }
  }
}

/** "0:00 Chapter 1: …" lines for a video description, when the film spans more than one chapter. */
async function chapterFile(deps: WorkerDeps, starts: { chapterId: string; startMs: number }[], name: string) {
  if (starts.length < 2) return [];
  const rows = await deps.db
    .select({ id: chapters.id, order: chapters.order, title: chapters.title })
    .from(chapters)
    .where(
      inArray(
        chapters.id,
        starts.map((s) => s.chapterId),
      ),
    );
  const text = youtubeChapters(
    starts.map((s) => {
      const ch = rows.find((r) => r.id === s.chapterId);
      return { startMs: s.startMs, title: ch ? `Chapter ${ch.order}: ${ch.title}` : "Chapter" };
    }),
  );
  return text
    ? [{ name: `${name}.chapters.txt`, data: new TextEncoder().encode(`${text}\n`), mime: "text/plain" }]
    : [];
}

/** Page size and image placement in points, for the page size, margins and bleed the export asked for. */
function imagePage(
  png: Uint8Array,
  pxW: number,
  pxH: number,
  opts: Opts,
  /** Interior page index, for which edge is the outside one in a KDP book. */
  index = 0,
): ImagePage {
  const kdp = KDP_TRIM_IN[opts.pdf.pageSize];
  if (kdp) {
    // Full bleed to KDP's spec: the art covers the whole page (cropping a sliver at the edges) and the trim box
    // marks where the book is cut — bleed on the outside edge, which is the right of a recto (odd) page.
    const [tw, th] = [kdp[0] * 72, kdp[1] * 72];
    const [width, height] = [tw + 9, th + 18];
    const k = Math.max(width / pxW, height / pxH);
    return {
      png,
      width,
      height,
      image: { x: (width - pxW * k) / 2, y: (height - pxH * k) / 2, width: pxW * k, height: pxH * k },
      trimBox: { x: index % 2 === 0 ? 0 : 9, y: 9, width: tw, height: th },
      bleedBox: { x: 0, y: 0, width, height },
    };
  }
  const bleed = mm(opts.pdf.bleedMm);
  const margin = mm(opts.pdf.marginMm);
  let pageW: number;
  let pageH: number;
  if (opts.pdf.pageSize === "source") {
    pageW = (pxW / opts.pdf.dpi) * 72 + (margin + bleed) * 2;
    pageH = (pxH / opts.pdf.dpi) * 72 + (margin + bleed) * 2;
  } else {
    const [w, h] = PAGE_SIZES_PT[opts.pdf.pageSize] ?? PAGE_SIZES_PT.A4!;
    pageW = w + bleed * 2;
    pageH = h + bleed * 2;
  }
  const availW = pageW - (margin + bleed) * 2;
  const availH = pageH - (margin + bleed) * 2;
  const k = Math.min(availW / pxW, availH / pxH);
  const w = pxW * k;
  const h = pxH * k;
  return { png, width: pageW, height: pageH, image: { x: (pageW - w) / 2, y: (pageH - h) / 2, width: w, height: h } };
}

/** Stable interchange document (schemaVersion 1). Never raw DB rows; assets referenced by manifest id. */
export async function buildInterchange(
  deps: WorkerDeps,
  project: typeof projects.$inferSelect,
  includeAssetFiles: boolean,
  progress?: (p: number) => Promise<void>,
  /** Asset and story files are streamed into this archive when given. */
  zip?: ZipWriter,
) {
  const db = deps.db;
  const manifest: ProjectInterchange["assets"] = {};
  const assetRef = async (assetId: string | null, folder: string): Promise<string | null> => {
    if (!assetId) return null;
    // Full id, not a prefix: a collision here would alias one panel's artwork onto another and still pass the
    // manifest checksum, because the checksum belongs to whichever asset won.
    const key = `asset-${assetId}`;
    if (manifest[key]) return key;
    const [a] = await db.select().from(assets).where(eq(assets.id, assetId));
    if (!a || a.deletedAt) return null;
    const path = `${folder}/${key}.${extForMime(a.mimeType)}`;
    manifest[key] = {
      path,
      type: a.type,
      mimeType: a.mimeType,
      width: a.width,
      height: a.height,
      sha256: a.sha256,
      status: a.status,
      metadata: {},
    };
    if (includeAssetFiles && zip) {
      // Failing beats writing a zero-byte entry: that ships a package whose images are empty but which imports
      // "successfully", with the loss showing up only as a missing-files warning at the other end.
      const data = await deps.assets.read(a);
      if (!data.length) throw new UnrecoverableError(`Asset ${a.id} (${a.type}) is missing from storage`);
      await zip.add(path, data);
    }
    return key;
  };
  const refsFor = async (
    col: "characterVersionId" | "locationVersionId" | "propVersionId" | "projectStyleId",
    versionId: string,
    folder: string,
  ) => {
    const rows = await db
      .select()
      .from(referenceAssets)
      .where(and(eq(referenceAssets[col], versionId), sql`${referenceAssets.status} <> 'superseded'`))
      // Creation order, id as tiebreak: two exports of the same project must be byte-identical (invariant 7).
      .orderBy(asc(referenceAssets.createdAt), asc(referenceAssets.id));
    const out = [];
    for (const r of rows) {
      const asset = await assetRef(r.assetId, folder);
      if (asset)
        out.push({
          kind: r.kind,
          asset,
          isPrimary: r.isPrimary,
          status: r.status,
          outfit: r.outfitId ? `o-${r.outfitId}` : null,
        });
    }
    return out;
  };

  const revs = await db
    .select()
    .from(storyRevisions)
    .where(eq(storyRevisions.projectId, project.id))
    .orderBy(asc(storyRevisions.revisionNumber));
  for (const r of revs)
    await zip?.add(
      `story/revision_${String(r.revisionNumber).padStart(3, "0")}.txt`,
      new TextEncoder().encode(r.content),
    );

  const [style] = project.currentStyleId
    ? await db
        .select({ s: projectStyles, p: stylePresets })
        .from(projectStyles)
        .leftJoin(stylePresets, eq(stylePresets.id, projectStyles.stylePresetId))
        .where(eq(projectStyles.id, project.currentStyleId))
    : [];

  const chars = await db
    .select()
    .from(characters)
    .where(and(eq(characters.projectId, project.id), isNull(characters.deletedAt)))
    .orderBy(asc(characters.createdAt), asc(characters.id));
  const characterDocs: ProjectInterchange["characters"] = [];
  for (const c of chars) {
    const versions = await db
      .select()
      .from(characterVersions)
      .where(eq(characterVersions.characterId, c.id))
      .orderBy(asc(characterVersions.versionNumber));
    const aliases = await db
      .select()
      .from(characterAliases)
      .where(eq(characterAliases.characterId, c.id))
      .orderBy(asc(characterAliases.alias));
    const outfits = await db
      .select()
      .from(characterOutfits)
      .where(eq(characterOutfits.characterId, c.id))
      .orderBy(asc(characterOutfits.createdAt), asc(characterOutfits.id));
    const vdocs = [];
    for (const v of versions)
      vdocs.push({
        ref: `cv-${v.id}`,
        versionNumber: v.versionNumber,
        status: v.status,
        description: v.description,
        immutableTraits: v.immutableTraits,
        references: await refsFor("characterVersionId", v.id, `characters/${safeName(c.name)}`),
      });
    characterDocs.push({
      ref: `c-${c.id}`,
      name: c.name,
      role: c.role,
      aliases: aliases.map((a) => a.alias),
      outfits: outfits.map((o) => ({
        ref: `o-${o.id}`,
        name: o.name,
        description: o.description,
        isDefault: o.isDefault,
        characterVersion: o.characterVersionId ? `cv-${o.characterVersionId}` : null,
      })),
      currentVersion: c.currentVersionId ? `cv-${c.currentVersionId}` : null,
      versions: vdocs,
    });
  }
  await progress?.(0.15);

  const locs = await db
    .select()
    .from(locations)
    .where(and(eq(locations.projectId, project.id), isNull(locations.deletedAt)))
    .orderBy(asc(locations.createdAt), asc(locations.id));
  const locationDocs: ProjectInterchange["locations"] = [];
  for (const l of locs) {
    const versions = await db
      .select()
      .from(locationVersions)
      .where(eq(locationVersions.locationId, l.id))
      .orderBy(asc(locationVersions.versionNumber));
    const vdocs = [];
    for (const v of versions)
      vdocs.push({
        ref: `lv-${v.id}`,
        versionNumber: v.versionNumber,
        status: v.status,
        description: v.description,
        immutableTraits: v.description.immutableTraits,
        references: await refsFor("locationVersionId", v.id, `locations/${safeName(l.name)}`),
      });
    locationDocs.push({
      ref: `l-${l.id}`,
      name: l.name,
      currentVersion: l.currentVersionId ? `lv-${l.currentVersionId}` : null,
      versions: vdocs,
    });
  }
  const prs = await db
    .select()
    .from(props)
    .where(and(eq(props.projectId, project.id), isNull(props.deletedAt)))
    .orderBy(asc(props.createdAt), asc(props.id));
  const propDocs: ProjectInterchange["props"] = [];
  for (const p of prs) {
    const versions = await db
      .select()
      .from(propVersions)
      .where(eq(propVersions.propId, p.id))
      .orderBy(asc(propVersions.versionNumber));
    const vdocs = [];
    for (const v of versions)
      vdocs.push({
        ref: `pv-${v.id}`,
        versionNumber: v.versionNumber,
        status: v.status,
        description: v.description,
        immutableTraits: v.description.immutableTraits,
        references: await refsFor("propVersionId", v.id, `props/${safeName(p.name)}`),
      });
    propDocs.push({
      ref: `p-${p.id}`,
      name: p.name,
      currentVersion: p.currentVersionId ? `pv-${p.currentVersionId}` : null,
      versions: vdocs,
    });
  }
  await progress?.(0.25);

  const chapterDocs: ProjectInterchange["chapters"] = [];
  const chs = await db.select().from(chapters).where(eq(chapters.projectId, project.id)).orderBy(asc(chapters.order));
  for (const ch of chs) {
    const sc = await db.select().from(scenes).where(eq(scenes.chapterId, ch.id)).orderBy(asc(scenes.order));
    const beats = sc.length
      ? await db
          .select()
          .from(storyBeats)
          .where(
            inArray(
              storyBeats.sceneId,
              sc.map((s) => s.id),
            ),
          )
          .orderBy(asc(storyBeats.order))
      : [];
    const pgs = await db.select().from(pages).where(eq(pages.chapterId, ch.id)).orderBy(asc(pages.order));
    const pageDocs = [];
    for (const pg of pgs) {
      const pns = await db.select().from(panels).where(eq(panels.pageId, pg.id)).orderBy(asc(panels.order));
      const panelDocs = [];
      for (const pn of pns) {
        const [spec] = await db
          .select()
          .from(panelSpecs)
          .where(eq(panelSpecs.panelId, pn.id))
          .orderBy(desc(panelSpecs.versionNumber))
          .limit(1);
        const history = await db
          .select({ id: assets.id })
          .from(assets)
          .where(
            and(
              eq(assets.projectId, project.id),
              eq(assets.type, "panel_art"),
              isNull(assets.deletedAt),
              sql`${assets.metadata}->>'panelId' = ${pn.id}`,
            ),
          )
          .orderBy(asc(assets.createdAt), asc(assets.id));
        const artworkHistory: string[] = [];
        for (const h of history) {
          const r = await assetRef(h.id, "panels");
          if (r) artworkHistory.push(r);
        }
        const dl = await db
          .select()
          .from(dialogueLines)
          .where(eq(dialogueLines.panelId, pn.id))
          .orderBy(asc(dialogueLines.order));
        const sf = await db
          .select()
          .from(soundEffects)
          .where(eq(soundEffects.panelId, pn.id))
          .orderBy(asc(soundEffects.createdAt), asc(soundEffects.id));
        const worn = await db
          .select()
          .from(outfitAssignments)
          .where(eq(outfitAssignments.panelId, pn.id))
          .orderBy(asc(outfitAssignments.createdAt), asc(outfitAssignments.id));
        panelDocs.push({
          ref: `pn-${pn.id}`,
          order: pn.order,
          frame: pn.frame,
          imageTransform: pn.imageTransform,
          shotType: pn.shotType,
          cameraAngle: pn.cameraAngle,
          storyBeat: pn.storyBeat,
          location: pn.locationVersionId ? `lv-${pn.locationVersionId}` : null,
          characters: pn.characterVersionIds.map((v) => `cv-${v}`),
          props: pn.propVersionIds.map((v) => `pv-${v}`),
          approvalStatus: pn.approvalStatus,
          spec: spec?.spec ?? null,
          promptOverride: pn.promptOverride,
          artwork: await assetRef(pn.activeArtworkAssetId, "panels"),
          artworkHistory,
          dialogue: dl.map((d) => ({
            speaker: d.characterId ? `c-${d.characterId}` : null,
            text: d.text,
            bubble: d.bubble,
          })),
          sfx: sf.map((s) => ({ text: s.text, style: s.style })),
          // Speakers as character refs, like dialogue lines, so they resolve to the imported characters.
          plannedLettering: pn.plannedLettering && {
            ...pn.plannedLettering,
            dialogue: pn.plannedLettering.dialogue.map((d) => ({
              ...d,
              speakerId: d.speakerId ? `c-${d.speakerId}` : null,
            })),
          },
          outfits: worn.map((w) => ({ character: `c-${w.characterId}`, outfit: `o-${w.outfitId}`, scope: w.scope })),
          video: pn.video ?? null,
        });
      }
      pageDocs.push({
        ref: `pg-${pg.id}`,
        order: pg.order,
        scene: pg.sceneId ? `s-${pg.sceneId}` : null,
        layoutTemplate: pg.layoutTemplate,
        width: pg.width,
        height: pg.height,
        purpose: pg.purpose,
        status: pg.status,
        readingDirection: pg.readingDirection,
        panels: panelDocs,
      });
    }
    const lines = await db
      .select()
      .from(narrationLines)
      .where(eq(narrationLines.chapterId, ch.id))
      .orderBy(asc(narrationLines.order));
    const narration = [];
    for (const l of lines) {
      const segs = await db
        .select()
        .from(narrationSegments)
        .where(eq(narrationSegments.narrationLineId, l.id))
        .orderBy(asc(narrationSegments.order));
      const segDocs = [];
      for (const s of segs)
        segDocs.push({
          text: s.text,
          voice: s.voice,
          speed: s.speed,
          pauseAfterMs: s.pauseAfterMs,
          audio: await assetRef(s.activeAudioAssetId, "audio"),
        });
      narration.push({
        language: l.language,
        text: l.text,
        panel: l.panelId ? `pn-${l.panelId}` : null,
        showOnPage: l.showOnPage,
        box: l.box,
        video: l.video && { ...l.video, untilPanelId: l.video.untilPanelId && `pn-${l.video.untilPanelId}` },
        segments: segDocs,
      });
    }
    chapterDocs.push({
      ref: `ch-${ch.id}`,
      order: ch.order,
      title: ch.title,
      summary: ch.summary,
      memory: {
        openingState: ch.openingState,
        closingState: ch.closingState,
        characterStateChanges: ch.characterStateChanges,
        locationStateChanges: ch.locationStateChanges,
        revealedFacts: ch.revealedFacts,
        sourceExcerpt: ch.sourceExcerpt,
      },
      scenes: sc.map((s) => ({
        ref: `s-${s.id}`,
        order: s.order,
        title: s.title,
        summary: s.summary,
        location: s.locationId ? `l-${s.locationId}` : null,
        details: {
          time: s.time,
          weather: s.weather,
          purpose: s.purpose,
          opening: s.opening,
          progression: s.progression,
          climax: s.climax,
          ending: s.ending,
          continuityNotes: s.continuityNotes,
          initialState: s.initialState,
          finalState: s.finalState,
          continuityDeltas: s.continuityDeltas,
          characters: s.characterIds.map((c) => `c-${c}`),
        },
        beats: beats.filter((b) => b.sceneId === s.id).map((b) => b.description),
      })),
      pages: pageDocs,
      narration,
    });
  }
  await progress?.(0.45);

  const styleRefs: string[] = [];
  if (style) for (const r of await refsFor("projectStyleId", style.s.id, "style")) styleRefs.push(r.asset);

  const doc: ProjectInterchange = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    project: {
      title: project.title,
      description: project.description,
      projectType: project.projectType,
      language: project.language,
      readingDirection: project.readingDirection,
      colorMode: project.colorMode,
      settings: project.settings,
      cover: await assetRef(project.coverAssetId, "exports"),
      videoLogo: await assetRef(project.settings.video?.watermark?.assetId ?? null, "exports"),
    },
    style: style
      ? {
          presetKey: style.p?.key ?? null,
          customDescription: style.s.customDescription,
          definition: style.p?.definition ?? {
            summary: "",
            lineTreatment: "",
            colorPolicy: "",
            shading: "",
            detailLevel: "",
            faceRendering: "",
            backgroundRendering: "",
            motionEffects: "",
            contrast: "",
            screenTones: "",
            lighting: "",
            exclusions: [],
          },
          references: styleRefs,
        }
      : null,
    storyRevisions: revs.map((r) => ({
      revisionNumber: r.revisionNumber,
      source: r.source,
      inputKind: r.inputKind,
      title: r.title,
      content: r.content,
      createdAt: r.createdAt.toISOString(),
      lockedAt: r.lockedAt?.toISOString() ?? null,
    })),
    characters: characterDocs,
    locations: locationDocs,
    props: propDocs,
    chapters: chapterDocs,
    assets: manifest,
  };
  InterchangeSchema.parse(doc);
  return { doc };
}
