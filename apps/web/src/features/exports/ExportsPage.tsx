import {
  captionsSupported,
  NARRATION_LANGUAGES,
  type PrintIssue,
  SHORTS_DEFAULT_MS,
  type VideoAspect,
} from "@openmanga/domain/browser";
import type { ShortsCaptions } from "@openmanga/schemas";
import { useQuery } from "@tanstack/react-query";
import { Download, FileDown, Trash2, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { ApiError, assetUrl, del, get, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { ChapterListItem, ExportListItem } from "../../api/types.ts";
import {
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  fmt,
  PageHeader,
  Spinner,
  StatusChip,
} from "../../components/ui.tsx";
import { ProgressBar } from "../generation/shared.tsx";
import { useProject, useProjectId } from "../project/ProjectLayout.tsx";
import { PreviewVideoButton } from "../video/VideoPreview.tsx";
import { CoverCheck, PRINT_SIZES, PreflightReport, type PreflightReportData, PrintIssues } from "./PrintPanels.tsx";
import { CaptionsField, ShortsPicker } from "./ShortsPicker.tsx";
import { YoutubePackageCard } from "./YoutubePackage.tsx";

const KINDS = [
  { value: "png_pages", label: "PNG page sequence", chapter: true },
  { value: "jpg_pages", label: "JPG page sequence", chapter: true },
  { value: "pdf", label: "PDF", chapter: true },
  { value: "cbz", label: "CBZ comic archive (Komga, Kavita, comic readers)", chapter: true },
  { value: "epub", label: "EPUB e-book (Kindle, Apple Books, Kobo)", chapter: true },
  { value: "webtoon", label: "Webtoon vertical strip", chapter: true },
  { value: "print_cover", label: "Print cover: back, spine and front with bleed (PDF)", chapter: true },
  { value: "print_preflight", label: "Print preflight: DPI, ink, fonts, soft proof", chapter: true },
  { value: "psd_pages", label: "Layered PSD per page (Photoshop, Clip Studio)", chapter: true },
  {
    value: "layered_package",
    label: "Separated art and lettering (ZIP: text-free pages, SVG, manifest)",
    chapter: true,
  },
  { value: "narration_audio", label: "Narration audio package", chapter: true },
  { value: "timeline", label: "Timeline manifest (JSON)", chapter: true },
  { value: "project_json", label: "Project JSON", chapter: false },
  { value: "zip_package", label: "Full project ZIP package", chapter: false },
  { value: "agent_package", label: "Agent hand-off package (everything linked)", chapter: false },
  { value: "video_pages", label: "Narrated video — page cut (MP4)", chapter: false },
  { value: "video_panels", label: "Narrated video — panel cut, Ken Burns (MP4)", chapter: false },
  { value: "video_shorts", label: "Shorts — a trailer of key shots, up to 3 min (MP4)", chapter: false },
  { value: "youtube_package", label: "YouTube package (newest video + thumbnail + text)", chapter: false },
] as const;
const AREAS: Record<string, ("art" | "narration")[]> = {
  png_pages: ["art"],
  jpg_pages: ["art"],
  pdf: ["art"],
  cbz: ["art"],
  epub: ["art"],
  webtoon: ["art"],
  print_cover: [],
  print_preflight: ["art"],
  psd_pages: ["art"],
  layered_package: ["art"],
  zip_package: ["art"],
  narration_audio: ["narration"],
  timeline: ["narration"],
  agent_package: ["art", "narration"],
  video_pages: ["art", "narration"],
  video_panels: ["art", "narration"],
  video_shorts: [],
  youtube_package: ["art", "narration"],
};
const USES_LANGUAGE = new Set([
  "narration_audio",
  "timeline",
  "agent_package",
  "video_pages",
  "video_panels",
  "video_shorts",
]);
const isVideo = (k: string) => k === "video_pages" || k === "video_panels" || k === "video_shorts";
/** Chapter kinds that can also cover the whole project: they stream to disk, so length costs no memory. */
const WHOLE_PROJECT = new Set([
  "png_pages",
  "jpg_pages",
  "pdf",
  "cbz",
  "epub",
  "webtoon",
  "print_cover",
  "print_preflight",
  "psd_pages",
  "layered_package",
]);
/** Kinds that take the PDF's page options: the preflight measures the PDF those options make. */
const PDF_OPTIONS = new Set(["pdf", "print_preflight"]);
type Issue = {
  code: string;
  area: "art" | "narration";
  severity: "block" | "info";
  chapterLabel: string | null;
  count: number;
  message: string;
};
type Kind = (typeof KINDS)[number]["value"];

export function ExportsPage() {
  const projectId = useProjectId();
  const { data: overview } = useProject();
  const chapters = useQuery({
    queryKey: qk.chapters(projectId),
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
  });
  const jobs = useQuery({
    queryKey: qk.exports(projectId),
    queryFn: () => get<{ jobs: ExportListItem[] }>(`/projects/${projectId}/exports`),
    refetchInterval: (q) =>
      q.state.data?.jobs.some((j) => j.status === "queued" || j.status === "processing") ? 4000 : false,
  });

  const [chosenKind, setKind] = useState<Kind>();
  // A strip's natural export is the stitched webtoon image, not a PDF of pages that do not exist as pages.
  const format = overview?.project.settings.format;
  const kind: Kind = chosenKind ?? (format === "film" ? "video_panels" : format === "vertical" ? "webtoon" : "pdf");
  const [chapterId, setChapterId] = useState("");
  const [scale, setScale] = useState(1);
  const [jpgQuality, setJpgQuality] = useState(90);
  const [pdf, setPdf] = useState({
    pageSize: "source",
    marginMm: 0,
    bleedMm: 0,
    dpi: 300,
    readingDirection: "",
    rectoChapters: false,
    toc: false,
  });
  const [bookMeta, setBookMeta] = useState({ title: "", author: "", subject: "", keywords: "", language: "" });
  const [print, setPrint] = useState({ paper: "white", pageCount: "" });
  const [webtoon, setWebtoon] = useState({ width: 800, gap: 40, split: true, maxChunkHeight: 12000, format: "jpg" });
  const [audio, setAudio] = useState({ format: "mp3", normalize: true });
  const [includeAssets, setIncludeAssets] = useState(true);
  const [language, setLanguage] = useState("");
  const [video, setVideo] = useState({
    height: 1080,
    fps: 30,
    minHoldMs: 2500,
    framing: "width" as "width" | "height" | "scroll",
    pageWidthRatio: 0.6,
    zoom: 0.06,
  });
  // Frame shape: landscape unless chosen; a Short opens vertical.
  const [chosenAspect, setAspect] = useState<VideoAspect>();
  const [shortsPick, setShortsPick] = useState<string[]>([]);
  const [shortsSeconds, setShortsSeconds] = useState(SHORTS_DEFAULT_MS / 1000);
  const [captions, setCaptions] = useState<ShortsCaptions>("off");
  // Partial renders: the first N minutes, and/or a range of pages within the chosen chapter.
  const [maxMinutes, setMaxMinutes] = useState("");
  const [pageRange, setPageRange] = useState({ from: "", to: "" });
  const [notReady, setNotReady] = useState<Issue[] | null>(null);
  // A project with a target runtime holds each shot at least its shortest shot length.
  const minShot = overview?.project.settings.targetRuntime?.minShotSeconds;
  useEffect(() => {
    if (minShot) setVideo((v) => ({ ...v, minHoldMs: Math.round(minShot * 1000) }));
  }, [minShot]);
  // The project's export defaults (Settings → Video, or its channel profile) pick the starting shape and resolution.
  const output = overview?.project.settings.video?.output;
  useEffect(() => {
    if (output?.height) setVideo((v) => ({ ...v, height: output.height }));
  }, [output?.height]);

  const needsChapter = KINDS.find((k) => k.value === kind)!.chapter;
  const shorts = kind === "video_shorts";
  const aspect: VideoAspect = chosenAspect ?? (shorts ? "9:16" : (output?.aspect ?? "16:9"));
  const [agentChapter, setAgentChapter] = useState("");
  const wholeProject = WHOLE_PROJECT.has(kind) && chapterId === "all";
  const selectedChapter = (chapterId !== "all" && chapterId) || chapters.data?.chapters[0]?.id || "";

  const scopeChapter = needsChapter
    ? wholeProject
      ? null
      : selectedChapter
    : kind === "agent_package" || isVideo(kind) || kind === "youtube_package"
      ? agentChapter || null
      : null;
  const lang = language || overview?.project.language || "en";
  const rangeChapter = useQuery({
    queryKey: qk.chapter(agentChapter),
    queryFn: () => get<{ pages: { id: string; order: number }[] }>(`/chapters/${agentChapter}`),
    enabled: isVideo(kind) && Boolean(agentChapter),
  });
  const rangePageIds = (() => {
    if (!isVideo(kind) || shorts || !agentChapter || (!pageRange.from && !pageRange.to)) return undefined;
    const pgs = rangeChapter.data?.pages ?? [];
    const lo = Number(pageRange.from) || 1;
    const hi = Number(pageRange.to) || Number.POSITIVE_INFINITY;
    return pgs.filter((p) => p.order >= lo && p.order <= hi).map((p) => p.id);
  })();
  const create = useAction(
    (acknowledgeIssues: boolean) =>
      post(`/projects/${projectId}/exports`, {
        kind,
        chapterId: scopeChapter,
        scale,
        jpgQuality,
        pdf: {
          ...pdf,
          // A cover is always a print size; it starts at KDP 6" × 9" when the PDF is set to the page's own size.
          pageSize: kind === "print_cover" && pdf.pageSize === "source" ? "kdp_6x9" : pdf.pageSize,
          readingDirection: pdf.readingDirection || undefined,
          metadata: {
            title: bookMeta.title || undefined,
            author: bookMeta.author || undefined,
            subject: bookMeta.subject || undefined,
            keywords: bookMeta.keywords
              .split(",")
              .map((k) => k.trim())
              .filter(Boolean),
            language: bookMeta.language || undefined,
          },
        },
        print: { paper: print.paper, ...(Number(print.pageCount) > 0 ? { pageCount: Number(print.pageCount) } : {}) },
        webtoon,
        audio,
        includeAssets,
        video: {
          ...video,
          // A narrow frame shows a page at its full width unless chosen otherwise.
          pageWidthRatio: aspect === "16:9" ? video.pageWidthRatio : 1,
          aspect,
          ...(shorts ? { shortsSeconds, captions: captionsSupported(lang) ? captions : "off" } : {}),
          ...(isVideo(kind) && !shorts && Number(maxMinutes) > 0
            ? { maxDurationMs: Math.round(Number(maxMinutes) * 60_000) }
            : {}),
        },
        ...(rangePageIds?.length ? { pageIds: rangePageIds } : {}),
        ...(shorts ? { panelIds: shortsPick } : {}),
        ...(USES_LANGUAGE.has(kind) ? { language: lang } : {}),
        acknowledgeIssues,
      }),
    {
      invalidate: [qk.exports(projectId)],
      success: "Export queued",
      onSuccess: () => setNotReady(null),
    },
  );
  const submit = async (acknowledge: boolean) => {
    try {
      await create.mutateAsync(acknowledge);
    } catch (e) {
      if (e instanceof ApiError && e.code === "export_not_ready")
        setNotReady((e.details as { issues: Issue[] }).issues);
    }
  };
  const readiness = useQuery({
    queryKey: ["readiness", projectId, scopeChapter, USES_LANGUAGE.has(kind) ? lang : ""],
    queryFn: () =>
      get<{ issues: Issue[]; language: string }>(
        `/projects/${projectId}/readiness?${new URLSearchParams({
          ...(scopeChapter ? { chapterId: scopeChapter } : {}),
          ...(USES_LANGUAGE.has(kind) ? { language: lang } : {}),
        })}`,
      ),
    enabled: !(needsChapter && !selectedChapter),
  });
  const relevant = (readiness.data?.issues ?? []).filter((i) => (AREAS[kind] ?? []).includes(i.area));
  const cancel = useAction((id: string) => post(`/exports/${id}/cancel`), {
    invalidate: [qk.exports(projectId)],
    success: "Cancellation sent",
  });

  // Deleting removes the files from disk now instead of at their 30-day expiry.
  const [deleting, setDeleting] = useState<"all" | string | null>(null);
  const remove = useAction(
    (target: "all" | string) =>
      target === "all"
        ? del<{ exports: number; bytes: number }>(`/projects/${projectId}/exports`)
        : del<{ exports: number; bytes: number }>(`/exports/${target}`),
    {
      invalidate: [qk.exports(projectId), qk.project(projectId)],
      success: (r) => `Deleted ${r.exports} export(s), ${fmt.bytes(r.bytes)} freed`,
      onSuccess: () => setDeleting(null),
    },
  );
  const running = (st: string) => st === "queued" || st === "processing" || st === "cancel_requested";

  const num = (v: string) => Number(v);
  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title="Exports"
        subtitle="Deterministic composition from structured pages. No AI calls."
        actions={
          jobs.data?.jobs.some((j) => !running(j.status) && j.kind !== "project_import") ? (
            <button type="button" className="btn-ghost text-red-500" onClick={() => setDeleting("all")}>
              <Trash2 className="size-4" /> Delete all exports
            </button>
          ) : undefined
        }
      />
      <YoutubePackageCard />
      <ConfirmDialog
        open={deleting !== null}
        title={deleting === "all" ? "Delete all exports?" : "Delete this export?"}
        confirmLabel="Delete"
        danger
        busy={remove.isPending}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      >
        {deleting === "all"
          ? "Every finished export of this project and its files are deleted from disk now. Running exports are kept."
          : "This export and its files are deleted from disk now."}{" "}
        This cannot be undone; export again to get the files back.
      </ConfirmDialog>
      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <form
          className="card space-y-3 self-start p-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <Field label="Format">
            <select className="input" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
              {KINDS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
            </select>
          </Field>
          {needsChapter && (
            <Field label="Chapter">
              <select
                className="input"
                value={wholeProject ? "all" : selectedChapter}
                onChange={(e) => setChapterId(e.target.value)}
              >
                {WHOLE_PROJECT.has(kind) && <option value="all">Whole project (all chapters)</option>}
                {chapters.data?.chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    Ch. {c.order} — {c.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(kind === "agent_package" || isVideo(kind) || kind === "youtube_package") && (
            <>
              <Field label="Chapters">
                <select className="input" value={agentChapter} onChange={(e) => setAgentChapter(e.target.value)}>
                  <option value="">
                    {isVideo(kind) || kind === "youtube_package" ? "Whole project (one video)" : "All chapters"}
                  </option>
                  {chapters.data?.chapters.map((c) => (
                    <option key={c.id} value={c.id}>
                      Ch. {c.order} — {c.title}
                    </option>
                  ))}
                </select>
              </Field>
              {kind === "agent_package" && (
                <p className="muted text-xs">
                  ZIP with a README and manifest.json linking every page, panel (clean and lettered images), character
                  and location reference, dialogue and narration segment with timings, so another agent or editor can
                  stitch it together.
                </p>
              )}
            </>
          )}
          {(kind === "png_pages" ||
            kind === "jpg_pages" ||
            kind === "pdf" ||
            kind === "cbz" ||
            kind === "epub" ||
            kind === "psd_pages" ||
            kind === "layered_package" ||
            kind === "agent_package") && (
            <Field label={`Scale ×${scale}`}>
              <input
                type="range"
                min={0.25}
                max={3}
                step={0.25}
                value={scale}
                onChange={(e) => setScale(num(e.target.value))}
                className="w-full"
              />
            </Field>
          )}
          {(kind === "jpg_pages" ||
            kind === "cbz" ||
            kind === "epub" ||
            (kind === "webtoon" && webtoon.format === "jpg")) && (
            <Field label={`JPG quality ${jpgQuality}`}>
              <input
                type="range"
                min={40}
                max={100}
                value={jpgQuality}
                onChange={(e) => setJpgQuality(num(e.target.value))}
                className="w-full"
              />
            </Field>
          )}
          {(kind === "psd_pages" || kind === "layered_package") && (
            <p className="muted text-xs">
              {kind === "psd_pages"
                ? "One Photoshop file per page (zipped when there are several): a white background, a group per panel with its art, frame and hidden layout guide, then effects, captions and dialogue, each element its own named layer at its place on the page. Clip Studio Paint opens it too."
                : "Per page: the lettered page, the page without lettering, the lettering as one vector SVG, and every panel's art, frame and guide and every bubble, caption and sound effect as its own transparent PNG. manifest.json gives each file's place on the page (x, y, width, height), its stacking order and its text."}
            </p>
          )}
          {kind === "print_cover" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Print size">
                <select
                  className="input"
                  value={pdf.pageSize === "source" ? "kdp_6x9" : pdf.pageSize}
                  onChange={(e) => setPdf({ ...pdf, pageSize: e.target.value })}
                >
                  {PRINT_SIZES.map(([v, l]) => (
                    <option key={v} value={v}>
                      {l}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Paper">
                <select
                  className="input"
                  value={print.paper}
                  onChange={(e) => setPrint({ ...print, paper: e.target.value })}
                >
                  <option value="white">White</option>
                  <option value="cream">Cream</option>
                  <option value="color">Colour</option>
                </select>
              </Field>
              <Field label="Page count" hint="Empty: the interior's">
                <input
                  type="number"
                  className="input"
                  min={1}
                  max={2000}
                  placeholder="Interior"
                  value={print.pageCount}
                  onChange={(e) => setPrint({ ...print, pageCount: e.target.value })}
                />
              </Field>
              <Field label="DPI">
                <input
                  type="number"
                  className="input"
                  min={72}
                  max={600}
                  value={pdf.dpi}
                  onChange={(e) => setPdf({ ...pdf, dpi: num(e.target.value) })}
                />
              </Field>
              <div className="col-span-2">
                <CoverCheck
                  projectId={projectId}
                  chapterId={scopeChapter}
                  pageSize={pdf.pageSize === "source" ? "kdp_6x9" : pdf.pageSize}
                  paper={print.paper}
                  pageCount={print.pageCount}
                  toc={pdf.toc}
                  rectoChapters={pdf.rectoChapters}
                />
              </div>
              <p className="muted col-span-2 text-xs">
                One PDF of back, spine and front with 0.125" bleed: the project's cover art on the front with the title
                and author, the title on the spine (79 pages or more), the description on the back above the barcode
                area. The page count follows the interior with the contents and right-hand-start options below.
              </p>
            </div>
          )}
          {PDF_OPTIONS.has(kind) && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Page size">
                <select
                  className="input"
                  value={pdf.pageSize}
                  onChange={(e) => setPdf({ ...pdf, pageSize: e.target.value })}
                >
                  {["source", "A4", "A5", "B5", "letter", "tankobon"].map((s) => (
                    <option key={s}>{s}</option>
                  ))}
                  <optgroup label="Amazon KDP print (full bleed)">
                    {[
                      ["kdp_5x8", '5" × 8"'],
                      ["kdp_5_5x8_5", '5.5" × 8.5"'],
                      ["kdp_6x9", '6" × 9"'],
                      ["kdp_7x10", '7" × 10"'],
                      ["kdp_8_5x11", '8.5" × 11"'],
                    ].map(([v, l]) => (
                      <option key={v} value={v}>
                        KDP {l}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </Field>
              {pdf.pageSize.startsWith("kdp_") && (
                <p className="muted col-span-2 text-xs">
                  Interior file for Amazon KDP with bleed: art fills each page edge to edge and is trimmed 0.125" at the
                  outside edges, so keep lettering off the very edge. Upload the cover separately. KDP expects 300 DPI,
                  so raise the scale if the pages are small, and a paperback needs at least 24 pages.
                </p>
              )}
              <Field label="DPI">
                <input
                  type="number"
                  className="input"
                  min={72}
                  max={600}
                  value={pdf.dpi}
                  onChange={(e) => setPdf({ ...pdf, dpi: num(e.target.value) })}
                />
              </Field>
              <Field label="Margin (mm)">
                <input
                  type="number"
                  className="input"
                  min={0}
                  max={50}
                  value={pdf.marginMm}
                  onChange={(e) => setPdf({ ...pdf, marginMm: num(e.target.value) })}
                />
              </Field>
              <Field label="Bleed (mm)">
                <input
                  type="number"
                  className="input"
                  min={0}
                  max={10}
                  value={pdf.bleedMm}
                  onChange={(e) => setPdf({ ...pdf, bleedMm: num(e.target.value) })}
                />
              </Field>
              <Field label="Reading direction">
                <select
                  className="input"
                  value={pdf.readingDirection}
                  onChange={(e) => setPdf({ ...pdf, readingDirection: e.target.value })}
                >
                  <option value="">Project default ({overview?.project.readingDirection})</option>
                  <option value="ltr">LTR</option>
                  <option value="rtl">RTL</option>
                  <option value="vertical">Vertical</option>
                </select>
              </Field>
            </div>
          )}
          {(PDF_OPTIONS.has(kind) || kind === "print_cover") && (
            <div className="space-y-1 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={pdf.rectoChapters}
                  onChange={(e) => setPdf({ ...pdf, rectoChapters: e.target.checked })}
                />{" "}
                Start chapters on a right-hand page (adds blank pages)
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={pdf.toc} onChange={(e) => setPdf({ ...pdf, toc: e.target.checked })} />{" "}
                Contents page
              </label>
            </div>
          )}
          {kind === "pdf" && (
            <details className="text-sm">
              <summary className="cursor-pointer">Book metadata</summary>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="col-span-2">
                  <Field label="Title">
                    <input
                      className="input"
                      placeholder={overview?.project.title}
                      value={bookMeta.title}
                      onChange={(e) => setBookMeta({ ...bookMeta, title: e.target.value })}
                    />
                  </Field>
                </div>
                <Field label="Author">
                  <input
                    className="input"
                    placeholder={overview?.project.settings.author || "Project author"}
                    value={bookMeta.author}
                    onChange={(e) => setBookMeta({ ...bookMeta, author: e.target.value })}
                  />
                </Field>
                <Field label="Language">
                  <input
                    className="input"
                    placeholder={overview?.project.language}
                    value={bookMeta.language}
                    onChange={(e) => setBookMeta({ ...bookMeta, language: e.target.value })}
                  />
                </Field>
                <div className="col-span-2">
                  <Field label="Subject" hint="Empty: the project description">
                    <input
                      className="input"
                      value={bookMeta.subject}
                      onChange={(e) => setBookMeta({ ...bookMeta, subject: e.target.value })}
                    />
                  </Field>
                </div>
                <div className="col-span-2">
                  <Field label="Keywords" hint="Comma-separated">
                    <input
                      className="input"
                      value={bookMeta.keywords}
                      onChange={(e) => setBookMeta({ ...bookMeta, keywords: e.target.value })}
                    />
                  </Field>
                </div>
              </div>
            </details>
          )}
          {kind === "webtoon" && (
            <div className="grid grid-cols-2 gap-2">
              <Field label="Width (px)">
                <input
                  type="number"
                  className="input"
                  min={320}
                  max={2000}
                  value={webtoon.width}
                  onChange={(e) => setWebtoon({ ...webtoon, width: num(e.target.value) })}
                />
              </Field>
              <Field label="Gap (px)">
                <input
                  type="number"
                  className="input"
                  min={0}
                  max={1000}
                  value={webtoon.gap}
                  onChange={(e) => setWebtoon({ ...webtoon, gap: num(e.target.value) })}
                />
              </Field>
              <Field label="Format">
                <select
                  className="input"
                  value={webtoon.format}
                  onChange={(e) => setWebtoon({ ...webtoon, format: e.target.value })}
                >
                  <option value="jpg">JPG</option>
                  <option value="png">PNG</option>
                </select>
              </Field>
              <Field label="Max chunk height">
                <input
                  type="number"
                  className="input"
                  min={1000}
                  max={40000}
                  disabled={!webtoon.split}
                  value={webtoon.maxChunkHeight}
                  onChange={(e) => setWebtoon({ ...webtoon, maxChunkHeight: num(e.target.value) })}
                />
              </Field>
              <label className="col-span-2 flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={webtoon.split}
                  onChange={(e) => setWebtoon({ ...webtoon, split: e.target.checked })}
                />{" "}
                Split into platform-safe chunks
              </label>
            </div>
          )}
          {kind === "narration_audio" && (
            <div className="grid grid-cols-2 items-end gap-2">
              <Field label="Audio format">
                <select
                  className="input"
                  value={audio.format}
                  onChange={(e) => setAudio({ ...audio, format: e.target.value })}
                >
                  <option>mp3</option>
                  <option>ogg</option>
                  <option>wav</option>
                </select>
              </Field>
              <label className="flex items-center gap-2 pb-2 text-sm">
                <input
                  type="checkbox"
                  checked={audio.normalize}
                  onChange={(e) => setAudio({ ...audio, normalize: e.target.checked })}
                />{" "}
                Normalize loudness
              </label>
            </div>
          )}
          {USES_LANGUAGE.has(kind) && (
            <Field label="Narration language">
              <select className="input" value={lang} onChange={(e) => setLanguage(e.target.value)}>
                {NARRATION_LANGUAGES.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.name}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {isVideo(kind) && (
            <div className="grid grid-cols-2 gap-2">
              <div className="col-span-2">
                {shorts ? (
                  <ShortsPicker
                    projectId={projectId}
                    chapterId={agentChapter || null}
                    language={lang}
                    minHoldMs={video.minHoldMs}
                    aspect={aspect}
                    lengthSeconds={shortsSeconds}
                    onLength={setShortsSeconds}
                    value={shortsPick}
                    onChange={setShortsPick}
                  />
                ) : agentChapter ? (
                  <PreviewVideoButton
                    projectId={projectId}
                    scope={{ chapterId: agentChapter }}
                    label="Preview in browser first"
                    title="Preview before rendering"
                    className="btn-secondary w-full"
                    defaultAspect={aspect}
                    defaultMinHoldMs={video.minHoldMs}
                  />
                ) : (
                  <p className="muted text-xs">Pick a chapter to preview it in the browser before rendering.</p>
                )}
              </div>
              <Field label="Resolution">
                <select
                  className="input"
                  value={video.height}
                  onChange={(e) => setVideo({ ...video, height: num(e.target.value) })}
                >
                  <option value={720}>720p</option>
                  <option value={1080}>1080p</option>
                  <option value={1440}>1440p</option>
                </select>
              </Field>
              <Field label="Shape">
                <select className="input" value={aspect} onChange={(e) => setAspect(e.target.value as VideoAspect)}>
                  <option value="16:9">16:9 landscape</option>
                  <option value="9:16">9:16 vertical (Shorts, Reels)</option>
                  <option value="1:1">1:1 square</option>
                </select>
              </Field>
              {shorts && <CaptionsField value={captions} onChange={setCaptions} language={lang} />}
              {!shorts && (
                <Field label="Only the first … minutes (for a check)">
                  <input
                    className="input"
                    type="number"
                    min={1}
                    step={1}
                    placeholder="Whole video"
                    value={maxMinutes}
                    onChange={(e) => setMaxMinutes(e.target.value)}
                  />
                </Field>
              )}
              {agentChapter && !shorts && (
                <Field label="Pages (from – to)">
                  <div className="flex items-center gap-1">
                    <input
                      className="input"
                      type="number"
                      min={1}
                      placeholder="first"
                      aria-label="From page"
                      value={pageRange.from}
                      onChange={(e) => setPageRange({ ...pageRange, from: e.target.value })}
                    />
                    <span className="muted">–</span>
                    <input
                      className="input"
                      type="number"
                      min={1}
                      placeholder="last"
                      aria-label="To page"
                      value={pageRange.to}
                      onChange={(e) => setPageRange({ ...pageRange, to: e.target.value })}
                    />
                  </div>
                </Field>
              )}
              <Field label={kind === "video_pages" ? "Min seconds per page" : "Min seconds per panel"}>
                <input
                  className="input"
                  type="number"
                  min={1}
                  max={30}
                  step={0.5}
                  value={video.minHoldMs / 1000}
                  onChange={(e) => setVideo({ ...video, minHoldMs: Math.round(num(e.target.value) * 1000) })}
                />
              </Field>
              {kind !== "video_pages" ? (
                <div className="col-span-2">
                  <Field label={`Ken Burns zoom ${Math.round(video.zoom * 100)}%`}>
                    <input
                      type="range"
                      min={0}
                      max={0.15}
                      step={0.01}
                      value={video.zoom}
                      onChange={(e) => setVideo({ ...video, zoom: num(e.target.value) })}
                      className="w-full"
                    />
                  </Field>
                </div>
              ) : (
                <div className="col-span-2">
                  <Field label="Page framing">
                    <select
                      className="input"
                      value={video.framing}
                      onChange={(e) => setVideo({ ...video, framing: e.target.value as typeof video.framing })}
                    >
                      <option value="width">3/5 frame width, slow scroll (readable)</option>
                      <option value="scroll">3/5 frame width, scroll the whole page (continuous)</option>
                      <option value="height">Whole page visible (small text)</option>
                    </select>
                  </Field>
                </div>
              )}
              <p className="muted col-span-2 text-xs">
                {shorts
                  ? "The picked shots in story order, each with its own narration, up to the chosen length and without the intro and outro cards. Vertical and square frames crop each panel's art around its focal point; nothing is generated again. The logo watermark still applies."
                  : kind === "video_panels"
                    ? "Each panel's clean artwork (cropped as on the page, no bubbles) fills the frame for its own narration over a blurred copy of itself. Wide shots slowly push in, close-ups pull out. Panels without art use their lettered page crop."
                    : video.framing === "scroll"
                      ? "Each page is shown for the length of its own narration (at least the minimum) over a blurred copy of itself, scrolling from its top to its bottom over that time."
                      : "Each page is shown for the length of its own narration (at least the minimum) over a blurred copy of itself; tall pages scroll at most 60 px/s."}{" "}
                Hard cuts. Audio is loudness-normalised once over the whole film, the file is checked against the
                narration length, and an .srt subtitle file is included.
              </p>
            </div>
          )}
          <ReadinessList issues={relevant} loading={readiness.isLoading} />
          {kind === "zip_package" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={includeAssets} onChange={(e) => setIncludeAssets(e.target.checked)} />{" "}
              Include reference, panel and audio files
            </label>
          )}
          <ConfirmDialog
            open={Boolean(notReady)}
            title="Export anyway?"
            confirmLabel="Export anyway"
            busy={create.isPending}
            onClose={() => setNotReady(null)}
            onConfirm={() => void submit(true)}
          >
            <p className="mb-2">The readiness check found problems. The export will include a list of them.</p>
            <ReadinessList issues={notReady ?? []} loading={false} />
          </ConfirmDialog>
          <button
            type="submit"
            className="btn-primary w-full"
            disabled={create.isPending || (needsChapter && !selectedChapter) || (shorts && !shortsPick.length)}
          >
            {create.isPending ? <Spinner /> : <FileDown className="size-4" />} Export
          </button>
          {needsChapter && !chapters.isLoading && !chapters.data?.chapters.length && (
            <p className="muted text-xs">Create a chapter first.</p>
          )}
        </form>

        <div>
          {jobs.error && <ErrorBox error={jobs.error} onRetry={() => jobs.refetch()} />}
          {jobs.isLoading ? (
            <Spinner />
          ) : !jobs.data?.jobs.length ? (
            <EmptyState icon={<Download className="size-8" />} title="No exports yet">
              Choose a format and export.
            </EmptyState>
          ) : (
            <ul className="space-y-2">
              {jobs.data.jobs.map((j) => (
                <li key={j.id} className="card p-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">
                      {j.kind === "project_import"
                        ? "Project import"
                        : j.kind === "carousel"
                          ? "Carousel images (ZIP)"
                          : j.kind === "quote_image"
                            ? "Quote image"
                            : (KINDS.find((k) => k.value === j.kind)?.label ?? j.kind)}
                    </span>
                    {j.chapter && (
                      <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5 text-xs" title={j.chapter.title}>
                        Ch. {j.chapter.order} — {j.chapter.title}
                      </span>
                    )}
                    <StatusChip status={j.status} />
                    <span className="muted text-xs">{fmt.ago(j.createdAt)}</span>
                    {(j.status === "queued" || j.status === "processing") && (
                      <button type="button" className="btn-ghost ml-auto" onClick={() => cancel.mutate(j.id)}>
                        <XCircle className="size-4" /> Cancel
                      </button>
                    )}
                    {!running(j.status) && (
                      <button
                        type="button"
                        className="btn-ghost ml-auto p-1.5"
                        aria-label="Delete export"
                        title="Delete this export and its files"
                        onClick={() => setDeleting(j.id)}
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
                  </div>
                  {j.status === "processing" && (
                    <div className="mt-2">
                      <ProgressBar value={j.progress} label="Export progress" />
                    </div>
                  )}
                  {j.failureReason && <p className="mt-1 text-sm text-red-500">{j.failureReason}</p>}
                  {j.status === "completed" && (j.result?.warnings as string[] | undefined)?.length ? (
                    <details className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                      <summary className="cursor-pointer">
                        {(j.result!.warnings as string[]).length} import warning(s)
                      </summary>
                      <ul className="mt-1 list-disc space-y-0.5 pl-4">
                        {(j.result!.warnings as string[]).map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {j.status === "completed" && j.kind === "print_preflight" && j.result?.preflight ? (
                    <PreflightReport
                      report={j.result.preflight as PreflightReportData}
                      grey={overview?.project.colorMode !== "full_color"}
                    />
                  ) : null}
                  {j.status === "completed" && j.kind === "print_cover" && j.result?.cover ? (
                    <CoverResult
                      cover={j.result.cover as CoverResultData}
                      guides={j.files.find((f) => f.fileName.endsWith("_cover_guides.png"))?.assetId}
                    />
                  ) : null}
                  {j.files.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {j.files.map((f) => (
                        <a
                          key={f.id}
                          className="btn-secondary max-w-full"
                          href={assetUrl(f.assetId, undefined, f.fileName)}
                          title={f.fileName}
                        >
                          <Download className="size-4 shrink-0" /> <span className="truncate">{f.fileName}</span>
                          <span className="muted shrink-0">({fmt.bytes(f.byteSize)})</span>
                        </a>
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function ReadinessList({ issues, loading }: { issues: Issue[]; loading: boolean }) {
  if (loading) return null;
  const blocking = issues.filter((i) => i.severity === "block");
  if (!issues.length) return <p className="text-xs text-emerald-600">Readiness check: nothing missing.</p>;
  return (
    <div
      className={
        blocking.length
          ? "rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300"
          : "muted rounded-lg border border-[var(--border)] p-2 text-xs"
      }
    >
      <p className="font-medium">
        {blocking.length
          ? `Readiness check: ${blocking.length} problem(s) would ship in this export`
          : "Readiness notes"}
      </p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4">
        {issues.map((i) => (
          <li key={`${i.code}-${i.chapterLabel}`} className={i.severity === "info" ? "opacity-70" : ""}>
            {i.chapterLabel ? `${i.chapterLabel}: ` : ""}
            {i.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

type CoverResultData = { spineIn: number; widthIn: number; heightIn: number; pageCount: number; issues: PrintIssue[] };

function CoverResult({ cover, guides }: { cover: CoverResultData; guides?: string }) {
  return (
    <div className="mt-2 space-y-2">
      <p className="muted text-xs">
        {cover.pageCount} pages, spine {cover.spineIn.toFixed(3)}", full cover {cover.widthIn.toFixed(3)}" ×{" "}
        {cover.heightIn.toFixed(3)}" with bleed.
      </p>
      <PrintIssues issues={cover.issues} ok="Cover: nothing to fix." />
      {guides && (
        <img
          className="w-full max-w-xl rounded border border-[var(--border)]"
          src={assetUrl(guides)}
          alt="Cover with trim, safe area, spine and barcode guides"
        />
      )}
    </div>
  );
}
