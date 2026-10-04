import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, CircleDot, Loader2, PauseCircle, Rocket, XCircle } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { ConfirmDialog, fmt, toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { AnalysisDiff } from "../story/AnalysisDiff.tsx";
import { PublishingFlags, StaleChapters, useStaleness } from "./StaleChapters.tsx";

type Step = { key: string; label: string; status: string; note?: string; ref?: string };
type Run = {
  id: string;
  status: string;
  reason: string | null;
  steps: Step[];
  createdAt: string;
  /** Changes with every step the run takes, which is what the staleness view must follow. */
  updatedAt: string;
  /** Jobs it queued that have not started: what Stop cancels by default. */
  pendingJobs: number;
  warnings: Warnings | null;
};
type Warnings = {
  failedJobs: { id: string; kind: string; step: string; reason: string | null }[];
  failedJobCount: number;
  panelsWithoutArt: number;
  segmentsWithoutAudio: number;
  panelsNeedingReview: number;
  failedExports: { id: string; kind: string; reason: string | null }[];
  chaptersWithoutNarration?: number;
  failedChecks?: number;
  video?: string | null;
};

const STAGE_LABEL: Record<string, string> = {
  story: "Story",
  plan: "Plan",
  prompts: "Prompts",
  art: "Art",
  narration: "Narration",
  audio: "Audio",
  render: "Video",
};

const ICON: Record<string, typeof Circle> = {
  pending: Circle,
  running: Loader2,
  review: PauseCircle,
  done: CheckCircle2,
  skipped: CheckCircle2,
  failed: XCircle,
};

/**
 * One-click production: every step from the story to the rendered video, reusing what exists, pausing for review
 * where asked and at the project's budget cap.
 */
export function ProductionRunCard({ projectId, format }: { projectId: string; format: string }) {
  const qc = useQueryClient();
  const key = ["project", projectId, "production-runs"];
  const runs = useQuery({
    queryKey: key,
    queryFn: () => get<{ runs: Run[] }>(`/projects/${projectId}/production-runs`),
    refetchInterval: (q) => (q.state.data?.runs[0]?.status === "running" ? 10_000 : false),
  });
  // Keyed on the run's last change, not its status: going from one review to the next keeps the status at
  // "waiting", and the list of changed chapters would otherwise stay hidden until a reload.
  const staleness = useStaleness(projectId, runs.data?.runs[0]?.updatedAt);
  // A revised story counts too: the update re-analyses it and always stops for a review before applying.
  const updatable = staleness.data?.stages.some((s) => s.count > 0) ?? false;
  const [update, setUpdate] = useState(false);
  const aiText = useAiBody("text");
  const aiImage = useAiBody("image");
  const [open, setOpen] = useState(false);
  const [o, setO] = useState({ reviewGates: true, preparePrompts: true, render: true, youtube: format === "film" });
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [cancelJobs, setCancelJobs] = useState(true);
  const act = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      await post(path, body);
      await qc.invalidateQueries({ queryKey: key });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const run = runs.data?.runs[0];
  const reviewing =
    run?.status === "waiting" && run.steps.some((s) => s.key === "review_analysis" && s.status === "review");
  const analysisRef = run?.steps.find((s) => s.key === "analyze")?.ref;
  const deciding = run?.status === "waiting" ? run.steps.find((s) => s.status === "review")?.key : undefined;
  const active = run && ["running", "waiting", "paused", "failed"].includes(run.status);

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto flex items-center gap-2 text-sm font-medium">
          <Rocket className="size-4" /> Production run
        </h3>
        {!active && (
          <>
            <button
              type="button"
              className="btn-secondary"
              disabled={!updatable}
              title={updatable ? "Run only the out-of-date steps below" : "Nothing is out of date"}
              onClick={() => {
                setUpdate(true);
                setOpen(true);
              }}
            >
              Update production
            </button>
            <button
              type="button"
              className="btn-primary"
              onClick={() => {
                setUpdate(false);
                setOpen(true);
              }}
            >
              Produce
            </button>
          </>
        )}
      </div>
      {staleness.data && (
        // What is out of date, in the order each stage is made from the one before it.
        <ol className="flex flex-wrap items-center gap-1 text-xs" aria-label="What is out of date">
          {staleness.data.stages.map((s, i) => (
            <li key={s.key} className="flex items-center gap-1">
              {i > 0 && <span className="muted">→</span>}
              <span
                className={
                  s.count > 0
                    ? "chip bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : "chip bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                }
                title={s.count > 0 ? s.note : "Up to date"}
              >
                {STAGE_LABEL[s.key] ?? s.key}
                {s.count > 0 && s.key !== "render" && s.key !== "story" ? ` ${s.count}` : s.count > 0 ? " !" : " ✓"}
              </span>
            </li>
          ))}
          {staleness.data.publishing
            .filter((f) => f.stale)
            .map((f) => (
              <li key={f.key}>
                <span className="chip bg-amber-500/15 text-amber-700 dark:text-amber-300" title={f.reasons.join("; ")}>
                  {f.key === "youtube_text" ? "YouTube text !" : "Thumbnail !"}
                </span>
              </li>
            ))}
        </ol>
      )}
      {!run && (
        <p className="muted text-xs">
          One button for the whole pipeline: analysis, references, chapter plans, prompts, artwork, narration, audio,
          thumbnail and the video, skipping whatever already exists.
        </p>
      )}
      {run && (
        <>
          <p className="text-xs">
            <span className="inline-block font-medium first-letter:uppercase">{run.status.replaceAll("_", " ")}</span>
            <span className="muted"> · started {fmt.ago(run.createdAt)}</span>
            {run.reason && <span className="muted"> · {run.reason}</span>}
          </p>
          <ol className="space-y-1 text-xs">
            {run.steps.map((s) => {
              const Icon = ICON[s.status] ?? CircleDot;
              return (
                <li key={s.key} className="flex items-start gap-2">
                  <Icon
                    className={
                      s.status === "done" || s.status === "skipped"
                        ? "mt-0.5 size-3.5 shrink-0 text-emerald-600"
                        : s.status === "failed"
                          ? "mt-0.5 size-3.5 shrink-0 text-red-500"
                          : s.status === "running"
                            ? "mt-0.5 size-3.5 shrink-0 animate-spin"
                            : s.status === "review"
                              ? "mt-0.5 size-3.5 shrink-0 text-amber-600"
                              : "muted mt-0.5 size-3.5 shrink-0"
                    }
                  />
                  <span className={s.status === "skipped" ? "muted" : ""}>
                    {s.label}
                    {s.status === "skipped" && " (skipped)"}
                    {s.note && <span className="muted"> — {s.note}</span>}
                  </span>
                </li>
              );
            })}
          </ol>
          {reviewing && analysisRef && (
            // A re-analysis waits here: what applying it would change, and where to choose anything to remove.
            <div className="space-y-2">
              <AnalysisDiff analysisId={analysisRef} />
              <Link
                to="/projects/$projectId/story"
                params={{ projectId }}
                className="text-xs text-accent-500 hover:underline"
              >
                Review it on the Story page, where you can also choose what to remove →
              </Link>
            </div>
          )}
          {deciding === "review_plans" && staleness.data && (
            <StaleChapters projectId={projectId} stage="plan" chapters={staleness.data.stalePlans} />
          )}
          {deciding === "review_narration" && staleness.data && (
            <StaleChapters projectId={projectId} stage="narration" chapters={staleness.data.staleNarration} />
          )}
          {!active && staleness.data && <PublishingFlags projectId={projectId} flags={staleness.data.publishing} />}
          {run.status === "completed_with_warnings" && run.warnings && (
            <RunWarnings
              projectId={projectId}
              format={format}
              warnings={run.warnings}
              onChanged={() => qc.invalidateQueries({ queryKey: key })}
            />
          )}
          {active && (
            <div className="flex flex-wrap gap-2">
              {run.status !== "running" && (
                <button
                  type="button"
                  className="btn-primary"
                  disabled={busy}
                  onClick={() => act(`/production-runs/${run.id}/continue`)}
                >
                  {run.status === "waiting" ? "Continue" : run.status === "failed" ? "Retry the failed step" : "Resume"}
                </button>
              )}
              <button
                type="button"
                className="btn-secondary"
                disabled={busy}
                onClick={() => {
                  setCancelJobs(true);
                  setStopping(true);
                }}
              >
                Stop
              </button>
            </div>
          )}
        </>
      )}
      {run && (
        <ConfirmDialog
          open={stopping}
          title="Stop the production run"
          confirmLabel="Stop"
          danger
          busy={busy}
          onClose={() => setStopping(false)}
          onConfirm={async () => {
            await act(`/production-runs/${run.id}/cancel`, { jobs: cancelJobs });
            setStopping(false);
          }}
        >
          <fieldset className="space-y-2">
            <legend className="sr-only">What to stop</legend>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="stop-run"
                className="mt-0.5"
                checked={cancelJobs}
                onChange={() => setCancelJobs(true)}
              />
              <span>
                Stop and cancel its queued jobs (recommended)
                <span className="muted block text-xs">
                  {run.pendingJobs === 1 ? "1 job" : `${run.pendingJobs} jobs`} not started yet would be cancelled. Jobs
                  already running at a provider finish, and nothing further happens with them.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input
                type="radio"
                name="stop-run"
                className="mt-0.5"
                checked={!cancelJobs}
                onChange={() => setCancelJobs(false)}
              />
              <span>
                Stop the run only
                <span className="muted block text-xs">
                  Its queued jobs still run and spend; cancel them in Generation.
                </span>
              </span>
            </label>
          </fieldset>
        </ConfirmDialog>
      )}
      <ConfirmDialog
        open={open}
        title={update ? "Update the production" : "Produce this project"}
        confirmLabel="Start"
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          await act(`/projects/${projectId}/production-runs`, {
            ...o,
            update,
            ai: { text: aiText().ai ?? null, image: aiImage().ai ?? null },
          });
          setOpen(false);
        }}
      >
        <div className="space-y-3 text-sm">
          <p>
            {update
              ? "Runs only what is out of date, from the first stale stage on: a revised story is analysed again and waits for your review before it is applied, then missing plans, prompts and artwork, artwork whose panel was edited after it was drawn, narration, audio and the video, which reuses every unchanged section of the last render."
              : "Runs every step that still has work to do."}{" "}
            Either way it spends up to the project's <strong>budget cap</strong> without asking again, and pauses there;
            the batch setting in Project settings → Production decides what waits for a half-price provider batch.
          </p>
          <div className="flex flex-wrap gap-2">
            <AiChip cap="text" />
            <AiChip cap="image" />
          </div>
          {(
            [
              ["reviewGates", "Pause for my review after the analysis, the references and before the final render"],
              ["preparePrompts", "Prepare panel prompts with the text model before drawing"],
              ["render", "Render the video at the end"],
              ["youtube", "Write the YouTube package and export it"],
            ] as const
          ).map(([k, label]) => (
            <label key={k} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={o[k]}
                onChange={(e) => setO({ ...o, [k]: e.target.checked })}
              />
              {label}
            </label>
          ))}
        </div>
      </ConfirmDialog>
    </div>
  );
}

/**
 * What a finished run left unresolved, each with where to deal with it: failed jobs are retried as new jobs through
 * the usual retry route, panels and narration open where they are fixed, and a failed video can be rendered anyway.
 */
function RunWarnings({
  projectId,
  format,
  warnings: w,
  onChanged,
}: {
  projectId: string;
  format: string;
  warnings: Warnings;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const failedVideo = w.failedExports.some((e) => e.kind === "video_pages" || e.kind === "video_panels");
  const total =
    w.failedJobCount +
    w.panelsWithoutArt +
    w.segmentsWithoutAudio +
    w.panelsNeedingReview +
    w.failedExports.length +
    (w.chaptersWithoutNarration ?? 0) +
    (w.failedChecks ?? 0) +
    (w.video ? 1 : 0);
  const retry = async () => {
    setBusy(true);
    let ok = 0;
    let firstError: unknown = null;
    for (const j of w.failedJobs) {
      try {
        await post(`/generations/${j.id}/retry`);
        ok++;
      } catch (e) {
        firstError ??= e;
      }
    }
    setBusy(false);
    if (ok) toast.success(`${ok} job${ok === 1 ? "" : "s"} queued again`);
    if (firstError) toast.error(firstError);
    onChanged();
  };
  const render = async () => {
    setBusy(true);
    try {
      await post(`/projects/${projectId}/exports`, {
        kind: format === "film" ? "video_panels" : "video_pages",
        acknowledgeIssues: true,
      });
      toast.success("Render queued");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const items: { n: number; text: string; to: string; search?: Record<string, string> }[] = [
    { n: w.failedJobCount, text: "failed generation job(s)", to: "/projects/$projectId/generation" },
    {
      n: w.panelsWithoutArt,
      text: "panel(s) without artwork",
      to: "/projects/$projectId/storyboard",
      search: { filter: "noArt" },
    },
    {
      n: w.panelsNeedingReview,
      text: "panel(s) needing review",
      to: "/projects/$projectId/storyboard",
      search: { filter: "review" },
    },
    {
      n: w.segmentsWithoutAudio,
      text: "narration segment(s) without current audio",
      to: "/projects/$projectId/narration",
    },
    { n: w.failedExports.length, text: "failed export(s)", to: "/projects/$projectId/exports" },
    { n: w.chaptersWithoutNarration ?? 0, text: "chapter(s) without narration", to: "/projects/$projectId/narration" },
    {
      n: w.failedChecks ?? 0,
      text: "panel(s) that failed a visual check",
      to: "/projects/$projectId/storyboard",
      search: { filter: "mismatch" },
    },
  ];
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      <p className="font-medium text-amber-800 dark:text-amber-200">
        Finished with {total} unresolved item{total === 1 ? "" : "s"}
      </p>
      <ul className="space-y-1">
        {items
          .filter((i) => i.n > 0)
          .map((i) => (
            <li key={i.text}>
              <Link to={i.to} params={{ projectId }} search={i.search} className="text-accent-500 hover:underline">
                {i.n} {i.text} →
              </Link>
            </li>
          ))}
        {w.video && (
          <li>
            <Link to="/projects/$projectId/exports" params={{ projectId }} className="text-accent-500 hover:underline">
              {w.video} →
            </Link>
          </li>
        )}
        {w.failedExports.map((e) => (
          <li key={e.id} className="muted">
            {e.kind}: {e.reason ?? "failed"}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-2">
        {w.failedJobs.length > 0 && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={retry}>
            Retry failed ({w.failedJobs.length})
          </button>
        )}
        {(w.panelsWithoutArt > 0 || w.panelsNeedingReview > 0) && (
          <Link
            to="/projects/$projectId/storyboard"
            params={{ projectId }}
            search={{ filter: w.panelsNeedingReview > 0 ? "review" : "noArt" }}
            className="btn-secondary"
          >
            Review
          </Link>
        )}
        {failedVideo && (
          <button type="button" className="btn-secondary" disabled={busy} onClick={render}>
            Render anyway
          </button>
        )}
      </div>
    </div>
  );
}
