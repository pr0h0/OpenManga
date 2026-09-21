import { NARRATION_LANGUAGES } from "@openmanga/domain/browser";
import { useQuery } from "@tanstack/react-query";
import { Download, FileDown, XCircle } from "lucide-react";
import { useState } from "react";
import { ApiError, assetUrl, get, post } from "../../api/client.ts";
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

const KINDS = [
  { value: "png_pages", label: "PNG page sequence", chapter: true },
  { value: "jpg_pages", label: "JPG page sequence", chapter: true },
  { value: "pdf", label: "PDF", chapter: true },
  { value: "webtoon", label: "Webtoon vertical strip", chapter: true },
  { value: "narration_audio", label: "Narration audio package", chapter: true },
  { value: "timeline", label: "Timeline manifest (JSON)", chapter: true },
  { value: "project_json", label: "Project JSON", chapter: false },
  { value: "zip_package", label: "Full project ZIP package", chapter: false },
  { value: "agent_package", label: "Agent hand-off package (everything linked)", chapter: false },
  { value: "video_pages", label: "Narrated video — page cut (MP4)", chapter: false },
  { value: "video_panels", label: "Narrated video — panel cut, Ken Burns (MP4)", chapter: false },
] as const;
const AREAS: Record<string, ("art" | "narration")[]> = {
  png_pages: ["art"],
  jpg_pages: ["art"],
  pdf: ["art"],
  webtoon: ["art"],
  zip_package: ["art"],
  narration_audio: ["narration"],
  timeline: ["narration"],
  agent_package: ["art", "narration"],
  video_pages: ["art", "narration"],
  video_panels: ["art", "narration"],
};
const USES_LANGUAGE = new Set(["narration_audio", "timeline", "agent_package", "video_pages", "video_panels"]);
const isVideo = (k: string) => k === "video_pages" || k === "video_panels";
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
  const [pdf, setPdf] = useState({ pageSize: "source", marginMm: 0, bleedMm: 0, dpi: 300, readingDirection: "" });
  const [webtoon, setWebtoon] = useState({ width: 800, gap: 40, split: true, maxChunkHeight: 12000, format: "jpg" });
  const [audio, setAudio] = useState({ format: "mp3", normalize: true });
  const [includeAssets, setIncludeAssets] = useState(true);
  const [language, setLanguage] = useState("");
  const [video, setVideo] = useState({
    height: 1080,
    fps: 30,
    minHoldMs: 2500,
    framing: "width" as "width" | "height",
    pageWidthRatio: 0.6,
    zoom: 0.06,
  });
  const [notReady, setNotReady] = useState<Issue[] | null>(null);

  const needsChapter = KINDS.find((k) => k.value === kind)!.chapter;
  const [agentChapter, setAgentChapter] = useState("");
  const selectedChapter = chapterId || chapters.data?.chapters[0]?.id || "";

  const scopeChapter = needsChapter
    ? selectedChapter
    : kind === "agent_package" || isVideo(kind)
      ? agentChapter || null
      : null;
  const lang = language || overview?.project.language || "en";
  const create = useAction(
    (acknowledgeIssues: boolean) =>
      post(`/projects/${projectId}/exports`, {
        kind,
        chapterId: scopeChapter,
        scale,
        jpgQuality,
        pdf: { ...pdf, readingDirection: pdf.readingDirection || undefined },
        webtoon,
        audio,
        includeAssets,
        video,
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

  const num = (v: string) => Number(v);
  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader title="Exports" subtitle="Deterministic composition from structured pages. No AI calls." />
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
              <select className="input" value={selectedChapter} onChange={(e) => setChapterId(e.target.value)}>
                {chapters.data?.chapters.map((c) => (
                  <option key={c.id} value={c.id}>
                    Ch. {c.order} — {c.title}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {(kind === "agent_package" || isVideo(kind)) && (
            <>
              <Field label="Chapters">
                <select className="input" value={agentChapter} onChange={(e) => setAgentChapter(e.target.value)}>
                  <option value="">{isVideo(kind) ? "Whole project (one video)" : "All chapters"}</option>
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
          {(kind === "png_pages" || kind === "jpg_pages" || kind === "pdf" || kind === "agent_package") && (
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
          {(kind === "jpg_pages" || (kind === "webtoon" && webtoon.format === "jpg")) && (
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
          {kind === "pdf" && (
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
                </select>
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
                {agentChapter ? (
                  <PreviewVideoButton
                    projectId={projectId}
                    scope={{ chapterId: agentChapter }}
                    label="Preview in browser first"
                    title="Preview before rendering"
                    className="btn-secondary w-full"
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
              <Field label={kind === "video_panels" ? "Min seconds per panel" : "Min seconds per page"}>
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
              {kind === "video_panels" ? (
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
                      onChange={(e) => setVideo({ ...video, framing: e.target.value as "width" | "height" })}
                    >
                      <option value="width">3/5 frame width, slow scroll (readable)</option>
                      <option value="height">Whole page visible (small text)</option>
                    </select>
                  </Field>
                </div>
              )}
              <p className="muted col-span-2 text-xs">
                {kind === "video_panels"
                  ? "Each panel's clean artwork (cropped as on the page, no bubbles) fills the frame for its own narration over a blurred copy of itself. Wide shots slowly push in, close-ups pull out. Panels without art use their lettered page crop."
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
            disabled={create.isPending || (needsChapter && !selectedChapter)}
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
                  {j.files.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {j.files.map((f) => (
                        <a key={f.id} className="btn-secondary" href={assetUrl(f.assetId, undefined, f.fileName)}>
                          <Download className="size-4" /> {f.fileName}{" "}
                          <span className="muted">({fmt.bytes(f.byteSize)})</span>
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
