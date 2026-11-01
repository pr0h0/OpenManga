import { useQuery, useQueryClient } from "@tanstack/react-query";
import { FileAudio } from "lucide-react";
import { useState } from "react";
import { api, get, post } from "../../api/client.ts";
import { qk } from "../../api/hooks.ts";
import { ConfirmDialog, fmt, Spinner, toast } from "../../components/ui.tsx";

type Result = {
  segments: number;
  attached: number;
  missedCount: number;
  missed: { segmentId: string; text: string; matched: number; words: number }[];
  recordingMs: number;
};
type JobView = { job: { id: string; status: string; failureReason: string | null; result: unknown } };

/**
 * Narration recorded outside OpenManga, cut into this chapter's (or the whole project's) segments: the recording is
 * transcribed on the server and each segment whose words are found gets its stretch of the recording as audio.
 */
export function ImportRecording({
  projectId,
  chapterId,
  language,
}: {
  projectId: string;
  chapterId: string;
  language: string;
}) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"chapter" | "project">("chapter");
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [job, setJob] = useState<{ id: string; startedAt: number } | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const send = async () => {
    if (!file) return;
    setUploading(true);
    try {
      const base = scope === "chapter" ? `/chapters/${chapterId}` : `/projects/${projectId}`;
      const r = await api<{ job: { id: string } }>(
        `${base}/narration/import?language=${encodeURIComponent(language)}&name=${encodeURIComponent(file.name)}`,
        { method: "POST", body: file },
      );
      setJob({ id: r.job.id, startedAt: Date.now() });
      setResult(null);
      setOpen(false);
      setFile(null);
    } catch (e) {
      toast.error(e);
    } finally {
      setUploading(false);
    }
  };

  useQuery({
    queryKey: ["narration-import", job?.id],
    enabled: Boolean(job),
    refetchInterval: 5000,
    queryFn: async () => {
      const { job: j } = await get<JobView>(`/generations/${job!.id}`);
      if (!["completed", "failed", "cancelled"].includes(j.status)) return j.status;
      setJob(null);
      if (j.status === "completed") {
        const r = j.result as Result;
        setResult(r);
        toast.success(`Recording imported: ${r.attached} of ${r.segments} segments have its audio`);
      } else if (j.status === "failed") toast.error(new Error(j.failureReason ?? "The import failed"));
      await qc.invalidateQueries({ queryKey: qk.narration(chapterId) });
      await qc.invalidateQueries({ queryKey: ["narration-progress", projectId] });
      return j.status;
    },
  });

  const cancel = async () => {
    if (!job) return;
    try {
      await post(`/generations/${job.id}/cancel`);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <>
      <button
        type="button"
        className="btn-secondary"
        onClick={() => setOpen(true)}
        disabled={Boolean(job)}
        title="Use a narration recorded elsewhere: it is cut into the segments it reads"
      >
        <FileAudio className="size-4" /> Import recording
      </button>
      {job && (
        <div className="flex w-full items-center gap-2 rounded-lg border border-[var(--border)] p-2 text-sm">
          <Spinner />
          <span>
            Importing the recording (started {new Date(job.startedAt).toLocaleTimeString()}) — transcribing takes about
            half its length.
          </span>
          <button type="button" className="btn-ghost ml-auto py-1" onClick={cancel}>
            Cancel
          </button>
        </div>
      )}
      {result && (
        <details className="w-full rounded-lg border border-[var(--border)] p-2 text-sm" open={result.missedCount > 0}>
          <summary className="cursor-pointer">
            Imported {fmt.ms(result.recordingMs)} of audio: {result.attached} of {result.segments} segments
            {result.missedCount ? `, ${result.missedCount} not found in the recording` : ""}
            <button type="button" className="btn-ghost ml-2 py-0 text-xs" onClick={() => setResult(null)}>
              Dismiss
            </button>
          </summary>
          {result.missedCount > 0 && (
            <>
              <p className="muted my-1 text-xs">
                These kept the audio they had. Fix their text to match the recording and import again, or upload their
                take on the segment.
              </p>
              <ul className="space-y-1">
                {result.missed.map((m) => (
                  <li key={m.segmentId} className="text-xs">
                    <span className="muted">
                      {m.matched}/{m.words} words heard ·{" "}
                    </span>
                    {m.text}
                  </li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
      <ConfirmDialog
        open={open}
        title="Import a narration recording"
        confirmLabel="Upload and import"
        busy={uploading}
        disabled={!file}
        onClose={() => setOpen(false)}
        onConfirm={send}
      >
        <div className="space-y-3 text-sm">
          <p>
            A recording of the narration exactly as written here, in order (any audio format). It is transcribed on this
            server and cut at the pauses between segments; each segment found gets its part of the recording as its
            audio. "Synthesize all missing" leaves imported audio alone.
          </p>
          <label className="flex items-center gap-2">
            <input type="radio" checked={scope === "chapter"} onChange={() => setScope("chapter")} />
            This chapter's narration
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={scope === "project"} onChange={() => setScope("project")} />
            The whole project: every chapter, in order
          </label>
          <input
            type="file"
            accept="audio/*,.mp3,.wav,.m4a,.ogg,.flac,.opus"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          {file && (
            <p className="muted text-xs">
              {file.name} · {fmt.bytes(file.size)}
            </p>
          )}
        </div>
      </ConfirmDialog>
    </>
  );
}
