import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, CircleDot, Loader2, PauseCircle, Rocket, XCircle } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { ConfirmDialog, fmt, toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";

type Step = { key: string; label: string; status: string; note?: string };
type Run = { id: string; status: string; reason: string | null; steps: Step[]; createdAt: string };

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
  const aiText = useAiBody("text");
  const aiImage = useAiBody("image");
  const [open, setOpen] = useState(false);
  const [o, setO] = useState({ reviewGates: true, preparePrompts: true, render: true, youtube: format === "film" });
  const [busy, setBusy] = useState(false);
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
  const active = run && ["running", "waiting", "paused", "failed"].includes(run.status);

  return (
    <div className="card space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="mr-auto flex items-center gap-2 text-sm font-medium">
          <Rocket className="size-4" /> Production run
        </h3>
        {!active && (
          <button type="button" className="btn-primary" onClick={() => setOpen(true)}>
            Produce
          </button>
        )}
      </div>
      {!run && (
        <p className="muted text-xs">
          One button for the whole pipeline: analysis, references, chapter plans, prompts, artwork, narration, audio,
          thumbnail and the video, skipping whatever already exists.
        </p>
      )}
      {run && (
        <>
          <p className="text-xs">
            <span className="font-medium capitalize">{run.status}</span>
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
                onClick={() => act(`/production-runs/${run.id}/cancel`)}
              >
                Stop
              </button>
            </div>
          )}
        </>
      )}
      <ConfirmDialog
        open={open}
        title="Produce this project"
        confirmLabel="Start"
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={async () => {
          await act(`/projects/${projectId}/production-runs`, {
            ...o,
            ai: { text: aiText().ai ?? null, image: aiImage().ai ?? null },
          });
          setOpen(false);
        }}
      >
        <div className="space-y-3 text-sm">
          <p>
            Runs every step that still has work to do. It spends up to the project's <strong>budget cap</strong> without
            asking again, and pauses there; the batch setting in Project settings → Production decides what waits for a
            half-price provider batch.
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
