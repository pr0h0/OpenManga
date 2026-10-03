import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { ConfirmDialog, toast } from "../../components/ui.tsx";
import { useAiBody } from "../ai/AiPicker.tsx";

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
