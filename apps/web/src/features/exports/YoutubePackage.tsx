import { useQueryClient } from "@tanstack/react-query";
import { Sparkles, Youtube } from "lucide-react";
import { useEffect, useState } from "react";
import { patch, post } from "../../api/client.ts";
import { onProjectEvent, qk } from "../../api/hooks.ts";
import { Field, Spinner, toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { CopyButton } from "../generation/shared.tsx";
import { useProject, useProjectId } from "../project/ProjectLayout.tsx";

type Pkg = {
  titles: string[];
  description: string;
  tags: string[];
  pinnedComment: string;
  thumbnailHeadlines: string[];
};
const EMPTY: Pkg = { titles: [], description: "", tags: [], pinnedComment: "", thumbnailHeadlines: [] };

/**
 * Publishing text for the video: written once by the text model, then edited here. The "YouTube package" export
 * zips it with the newest video, its subtitles and chapter timestamps, and the thumbnail.
 */
export function YoutubePackageCard() {
  const projectId = useProjectId();
  const { data } = useProject();
  const qc = useQueryClient();
  const aiText = useAiBody("text");
  const saved = (data?.project.settings.youtubePackage as Pkg | undefined) ?? null;
  const [p, setP] = useState<Pkg>(saved ?? EMPTY);
  // Typed as text and parsed when saved, so a new line or comma being typed is not stripped mid-word.
  const [titlesText, setTitlesText] = useState((saved ?? EMPTY).titles.join("\n"));
  const [tagsText, setTagsText] = useState((saved ?? EMPTY).tags.join(", "));
  const [writing, setWriting] = useState(false);
  const key = JSON.stringify(saved);
  useEffect(() => {
    setP(saved ?? EMPTY);
    setTitlesText((saved ?? EMPTY).titles.join("\n"));
    setTagsText((saved ?? EMPTY).tags.join(", "));
  }, [key]);
  // The job writes into the project settings; refresh when it finishes.
  useEffect(
    () =>
      onProjectEvent((e) => {
        if (
          e.type === "job.updated" &&
          e.kind === "youtube_package" &&
          (e.status === "completed" || e.status === "failed")
        ) {
          setWriting(false);
          void qc.invalidateQueries({ queryKey: qk.project(projectId), exact: true });
          if (e.status === "failed") toast.error("The YouTube package could not be written");
        }
      }),
    [projectId, qc],
  );
  const write = async () => {
    setWriting(true);
    try {
      await post(`/projects/${projectId}/youtube-package`, aiText());
    } catch (e) {
      setWriting(false);
      toast.error(e);
    }
  };
  const save = async (next: Pkg) => {
    try {
      await patch(`/projects/${projectId}`, { settings: { youtubePackage: next } });
      await qc.invalidateQueries({ queryKey: qk.project(projectId), exact: true });
      toast.success("Saved");
    } catch (e) {
      toast.error(e);
    }
  };
  const applyHeadline = async (h: string) => {
    const t = data?.project.settings.thumbnail;
    if (!t) return toast.info("Generate a thumbnail on the overview first");
    await patch(`/projects/${projectId}`, { settings: { thumbnail: { ...t, title: h } } });
    await qc.invalidateQueries({ queryKey: qk.project(projectId), exact: true });
    toast.success("Thumbnail headline updated");
  };
  const split = (v: string, sep: string) =>
    v
      .split(sep)
      .map((s) => s.trim())
      .filter(Boolean);
  const current: Pkg = { ...p, titles: split(titlesText, "\n"), tags: split(tagsText, ",") };
  const dirty = JSON.stringify(current) !== JSON.stringify(saved ?? EMPTY);

  return (
    <section className="card mb-4 space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto flex items-center gap-2 font-medium">
          <Youtube className="size-4" /> YouTube package
        </h2>
        <AiChip cap="text" />
        <button type="button" className="btn-secondary" disabled={writing} onClick={write}>
          {writing ? <Spinner /> : <Sparkles className="size-4" />} {saved ? "Rewrite" : "Write"} with AI
        </button>
        {dirty && (
          <button type="button" className="btn-primary" onClick={() => save(current)}>
            Save
          </button>
        )}
      </div>
      <p className="muted text-xs">
        Titles, description, tags, a pinned comment and thumbnail headlines, written by the text model and yours to
        edit. The <strong>YouTube package</strong> export zips them with the newest rendered video of the same scope,
        its subtitles and chapter timestamps (added to the description), and the thumbnail.
      </p>
      {saved || dirty ? (
        <div className="grid gap-3 md:grid-cols-2">
          <Field label="Title options (one per line)">
            <textarea className="input min-h-24" value={titlesText} onChange={(e) => setTitlesText(e.target.value)} />
          </Field>
          <Field label="Description">
            <textarea
              className="input min-h-24"
              value={p.description}
              onChange={(e) => setP({ ...p, description: e.target.value })}
            />
          </Field>
          <Field label="Tags (comma separated)">
            <input className="input" value={tagsText} onChange={(e) => setTagsText(e.target.value)} />
          </Field>
          <Field label="Pinned comment">
            <input
              className="input"
              value={p.pinnedComment}
              onChange={(e) => setP({ ...p, pinnedComment: e.target.value })}
            />
          </Field>
          <div className="md:col-span-2">
            <span className="label">Thumbnail headlines</span>
            <div className="flex flex-wrap gap-2">
              {p.thumbnailHeadlines.map((h) => (
                <button
                  key={h}
                  type="button"
                  className="btn-secondary text-xs"
                  title="Use this as the thumbnail's headline"
                  onClick={() => applyHeadline(h)}
                >
                  {h}
                </button>
              ))}
              <CopyButton
                text={[current.titles[0] ?? "", "", p.description, "", current.tags.join(", ")].join("\n")}
                label="Copy all"
              />
            </div>
          </div>
        </div>
      ) : (
        <p className="muted text-sm">Nothing written yet.</p>
      )}
    </section>
  );
}
