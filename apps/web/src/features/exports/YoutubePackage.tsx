import { ProjectSettings } from "@openmanga/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Download, Sparkles, Youtube } from "lucide-react";
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
  const [headlinesText, setHeadlinesText] = useState((saved ?? EMPTY).thumbnailHeadlines.join("\n"));
  const [writing, setWriting] = useState(false);
  const key = JSON.stringify(saved);
  useEffect(() => {
    setP(saved ?? EMPTY);
    setTitlesText((saved ?? EMPTY).titles.join("\n"));
    setTagsText((saved ?? EMPTY).tags.join(", "));
    setHeadlinesText((saved ?? EMPTY).thumbnailHeadlines.join("\n"));
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
  const current: Pkg = {
    ...p,
    titles: split(titlesText, "\n"),
    tags: split(tagsText, ","),
    thumbnailHeadlines: split(headlinesText, "\n"),
  };
  const thumb = data?.project.settings.thumbnail;
  const dirty = JSON.stringify(current) !== JSON.stringify(saved ?? EMPTY);
  // The same limits the server applies, said before saving instead of as a failed save.
  const problem = (() => {
    const r = ProjectSettings.shape.youtubePackage.safeParse(current);
    if (r.success) return null;
    const LIMITS: Record<string, string> = {
      titles: "up to 8 titles of at most 100 characters",
      thumbnailHeadlines: "up to 8 headlines of at most 60 characters",
      tags: "up to 30 tags of at most 60 characters",
      description: "a description of at most 4,500 characters",
      pinnedComment: "a pinned comment of at most 2,000 characters",
    };
    return `YouTube allows ${LIMITS[String(r.error.issues[0]?.path[0])] ?? "less than this"}.`;
  })();

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
          <button type="button" className="btn-primary" disabled={Boolean(problem)} onClick={() => save(current)}>
            Save
          </button>
        )}
      </div>
      <p className="muted text-xs">
        Titles, description, tags, a pinned comment and thumbnail headlines, written by the text model and yours to
        edit. The <strong>YouTube package</strong> export zips them with the newest rendered video of the same scope,
        its subtitles and chapter timestamps (added to the description), and the thumbnail.
      </p>
      {dirty && problem && <p className="text-xs text-red-600 dark:text-red-400">{problem}</p>}
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
          <Field label="Thumbnail headlines (one per line)">
            <textarea
              className="input min-h-20"
              value={headlinesText}
              onChange={(e) => setHeadlinesText(e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <CopyButton
              text={[current.titles[0] ?? "", "", p.description, "", current.tags.join(", ")].join("\n")}
              label="Copy all"
            />
          </div>
          <div className="md:col-span-2">
            <span className="label">Thumbnail variants</span>
            {!thumb ? (
              <p className="muted text-xs">Generate a thumbnail on the overview to see each headline on it.</p>
            ) : (
              <>
                <p className="muted mb-2 text-xs">
                  Each headline on the same art, to compare side by side; nothing is generated. The YouTube package
                  export includes them all as separate images, for YouTube's Test &amp; compare (three at a time).
                </p>
                <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {current.thumbnailHeadlines.map((h, i) => {
                    const url = (download: boolean) =>
                      `/api/projects/${projectId}/thumbnail.png?${new URLSearchParams({
                        title: h,
                        subtitle: thumb.subtitle,
                        side: thumb.side,
                        v: thumb.assetId,
                        ...(download ? { download: "1" } : { width: "480" }),
                      })}`;
                    return (
                      <li key={`${i}:${h}`} className="overflow-hidden rounded-lg border border-[var(--border)]">
                        <img src={url(false)} alt={`Thumbnail: ${h}`} className="aspect-video w-full object-cover" />
                        <div className="flex items-center gap-1 p-1.5 text-xs">
                          <span className="min-w-0 flex-1 truncate" title={h}>
                            {h}
                          </span>
                          {thumb.title === h ? (
                            <span className="chip flex items-center gap-1">
                              <Check className="size-3" /> In use
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn-ghost px-1.5 py-0.5 text-xs"
                              title="Use this as the thumbnail's headline"
                              onClick={() => applyHeadline(h)}
                            >
                              Use
                            </button>
                          )}
                          <a
                            className="btn-ghost px-1.5 py-0.5"
                            href={url(true)}
                            aria-label={`Download the 1280×720 PNG: ${h}`}
                            title="1280×720 PNG"
                          >
                            <Download className="size-3.5" />
                          </a>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </div>
      ) : (
        <p className="muted text-sm">Nothing written yet.</p>
      )}
    </section>
  );
}
