import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { get, patch, post } from "../../api/client.ts";
import { ConfirmDialog, toast } from "../../components/ui.tsx";
import { useAiBody } from "../ai/AiPicker.tsx";
import { useProject } from "./ProjectLayout.tsx";

export type StaleChapter = {
  chapterId: string;
  title: string;
  pages: number;
  panels: number;
  drawnPanels: number;
  narrationLines: number;
};
export type Staleness = {
  stages: { key: string; count: number; note: string }[];
  stalePlans: StaleChapter[];
  staleNarration: StaleChapter[];
  /** The YouTube text and the thumbnail headline: flagged, never regenerated on their own. */
  publishing: { key: "youtube_text" | "thumbnail"; stale: boolean; reasons: string[] }[];
};

/** The project's staleness report; every query under this key prefix is refreshed after a decision. */
export const useStaleness = (projectId: string, extra?: unknown) =>
  useQuery({
    queryKey: ["project", projectId, "staleness", extra],
    queryFn: () => get<Staleness>(`/projects/${projectId}/staleness`),
  });

/**
 * Chapters whose plan (or narration) was made from text that has changed since, with the choice for each: keep it
 * as it is, or redo it. Redoing replaces work, so it says how much and asks first; nothing is redone on its own.
 */
export function StaleChapters({
  projectId,
  stage,
  chapters,
}: {
  projectId: string;
  stage: "plan" | "narration";
  chapters: StaleChapter[];
}) {
  const qc = useQueryClient();
  const aiText = useAiBody("text");
  const [busy, setBusy] = useState<string | null>(null);
  const [redo, setRedo] = useState<StaleChapter | null>(null);
  const done = () => qc.invalidateQueries({ queryKey: ["project", projectId, "staleness"] });
  const keep = async (c: StaleChapter) => {
    setBusy(c.chapterId);
    try {
      await post(`/chapters/${c.chapterId}/keep`, { stage });
      await done();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };
  const redoIt = async (c: StaleChapter) => {
    setBusy(c.chapterId);
    try {
      await post(stage === "plan" ? `/chapters/${c.chapterId}/plan` : `/chapters/${c.chapterId}/narration/generate`, {
        replace: true,
        ai: aiText().ai ?? null,
      });
      toast.success(stage === "plan" ? `Re-planning ${c.title}` : `Writing the narration of ${c.title} again`);
      await done();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
      setRedo(null);
    }
  };
  if (!chapters.length) return null;
  const work = (c: StaleChapter) =>
    stage === "plan"
      ? `${c.pages} page(s), ${c.drawnPanels} of ${c.panels} panel(s) drawn`
      : `${c.narrationLines} narration line(s)`;
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      <p className="font-medium text-amber-800 dark:text-amber-200">
        {stage === "plan"
          ? "Chapters whose text changed after they were planned"
          : "Chapters that changed after their narration was written"}
      </p>
      <ul className="space-y-2">
        {chapters.map((c) => (
          <li key={c.chapterId} className="flex flex-wrap items-center gap-2">
            <span className="mr-auto min-w-0">
              <span className="font-medium">{c.title}</span> <span className="muted">· {work(c)}</span>
            </span>
            <button
              type="button"
              className="btn-secondary px-2 py-1 text-xs"
              disabled={busy !== null}
              onClick={() => keep(c)}
            >
              Keep current
            </button>
            <button
              type="button"
              className="btn-secondary px-2 py-1 text-xs"
              disabled={busy !== null}
              onClick={() => setRedo(c)}
            >
              {stage === "plan" ? "Re-plan" : "Write again"}
            </button>
          </li>
        ))}
      </ul>
      <ConfirmDialog
        open={redo !== null}
        title={stage === "plan" ? "Re-plan this chapter" : "Write this narration again"}
        confirmLabel={stage === "plan" ? "Re-plan" : "Write again"}
        danger
        busy={busy !== null}
        onClose={() => setRedo(null)}
        onConfirm={() => redo && redoIt(redo)}
      >
        {redo &&
          (stage === "plan" ? (
            <p>
              Re-planning <strong>{redo.title}</strong> replaces its <strong>{redo.pages} page(s)</strong> and{" "}
              <strong>{redo.panels} panel(s)</strong>, including the artwork of the {redo.drawnPanels} drawn ones and
              the narration on them, with a new plan from the current text. It uses the text model and spends.
            </p>
          ) : (
            <p>
              Writing the narration of <strong>{redo.title}</strong> again replaces its{" "}
              <strong>{redo.narrationLines} narration line(s)</strong> and their audio. It uses the text model and
              spends.
            </p>
          ))}
      </ConfirmDialog>
    </div>
  );
}

/**
 * The YouTube text and thumbnail headline when what they were written from changed: regenerate them (the YouTube
 * package route, or the headline set to the current title) or keep them. Nothing here happens on its own.
 */
export function PublishingFlags({ projectId, flags }: { projectId: string; flags: Staleness["publishing"] }) {
  const qc = useQueryClient();
  const project = useProject();
  const aiText = useAiBody("text");
  const [busy, setBusy] = useState(false);
  const stale = flags.filter((f) => f.stale);
  if (!stale.length) return null;
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(done);
      await qc.invalidateQueries({ queryKey: ["project", projectId] });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const thumb = project.data?.project.settings.thumbnail;
  return (
    <div className="space-y-2 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
      {stale.map((f) => (
        <div key={f.key} className="flex flex-wrap items-center gap-2">
          <span className="mr-auto min-w-0">
            <span className="font-medium text-amber-800 dark:text-amber-200">
              {f.key === "youtube_text" ? "YouTube text may be out of date" : "Thumbnail headline may be out of date"}
            </span>
            <span className="muted"> · {f.reasons.join("; ")}</span>
          </span>
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            disabled={busy || (f.key === "thumbnail" && !thumb)}
            onClick={() =>
              f.key === "youtube_text"
                ? act(
                    () => post(`/projects/${projectId}/youtube-package`, { ai: aiText().ai ?? null }),
                    "Writing the YouTube text again",
                  )
                : act(
                    () =>
                      patch(`/projects/${projectId}`, {
                        settings: { thumbnail: { ...thumb, title: project.data?.project.title ?? "" } },
                      }),
                    "Headline set to the current title",
                  )
            }
          >
            {f.key === "youtube_text" ? "Regenerate" : "Use the current title"}
          </button>
          <button
            type="button"
            className="btn-secondary px-2 py-1 text-xs"
            disabled={busy}
            onClick={() => act(() => post(`/projects/${projectId}/keep-current`, { item: f.key }), "Kept as it is")}
          >
            Keep current
          </button>
        </div>
      ))}
    </div>
  );
}
