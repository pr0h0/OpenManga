import type { ChannelProfile, ProjectSettings } from "@openmanga/schemas";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { get, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import { ErrorBox, Field, fmt, Modal, Spinner } from "../../components/ui.tsx";

export const useProfiles = () =>
  useQuery({
    queryKey: ["channel-profiles"],
    queryFn: () => get<{ profiles: ChannelProfile[] }>("/channel-profiles"),
  });

type Change = { key: string; from: unknown; to: unknown };
const LABELS: Record<string, string> = {
  imageQuality: "Image quality",
  referencePolicy: "References to generate",
  batchPolicy: "Production runs spend",
  targetRuntime: "Target runtime",
  narrationVoice: "Narrator voice",
  narrationSpeed: "Narration speed",
  pronunciation: "Pronunciation dictionary",
  lettering: "Lettering and card fonts",
  thumbnailStyle: "Thumbnail style",
  youtubeRules: "YouTube rules",
  "video.fadeAtSceneBreaks": "Fade at scene breaks",
  "video.watermark": "Logo watermark",
  "video.intro": "Intro card",
  "video.outro": "Outro card",
  "video.output": "Export frame and resolution",
};
const show = (v: unknown) =>
  v === null || v === undefined ? "none" : typeof v === "object" ? JSON.stringify(v) : String(v);

/**
 * Where the project's settings came from, and re-applying a profile: what would change is listed first, and nothing
 * is copied until it is confirmed. A profile is not linked live, so later edits to it reach a project only this way.
 */
export function ProfileCard({ projectId, from }: { projectId: string; from: ProjectSettings["channelProfile"] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="card space-y-2 p-4">
      <h3 className="text-sm font-medium">Channel profile</h3>
      <p className="muted text-xs">
        {from ? (
          <>
            From profile <strong className="text-[var(--text)]">{from.name}</strong>, applied {fmt.ago(from.appliedAt)}.
          </>
        ) : (
          "Not made from a profile."
        )}
      </p>
      <button type="button" className="btn-secondary w-full justify-center" onClick={() => setOpen(true)}>
        {from ? "Re-apply profile" : "Apply a profile"}
      </button>
      {open && <ApplyDialog projectId={projectId} fromId={from?.id ?? null} onClose={() => setOpen(false)} />}
    </div>
  );
}

function ApplyDialog({
  projectId,
  fromId,
  onClose,
}: {
  projectId: string;
  fromId: string | null;
  onClose: () => void;
}) {
  const profiles = useProfiles();
  const list = profiles.data?.profiles ?? [];
  const [chosen, setChosen] = useState<string>();
  const profileId = chosen ?? (list.some((p) => p.id === fromId) ? fromId : list[0]?.id) ?? "";
  const diff = useQuery({
    queryKey: ["project", projectId, "profile-diff", profileId],
    queryFn: () => post<{ changes: Change[] }>(`/projects/${projectId}/apply-profile`, { profileId }),
    enabled: Boolean(profileId),
    gcTime: 0,
  });
  const apply = useAction(() => post(`/projects/${projectId}/apply-profile`, { profileId, confirm: true }), {
    invalidate: [qk.project(projectId)],
    success: "Profile applied",
    onSuccess: onClose,
  });
  const changes = diff.data?.changes ?? [];
  return (
    <Modal
      open
      onClose={onClose}
      title="Apply a channel profile"
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!changes.length || apply.isPending}
            onClick={() => apply.mutate()}
          >
            {apply.isPending && <Spinner />} Apply {changes.length || ""} change{changes.length === 1 ? "" : "s"}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {profiles.isLoading && <Spinner />}
        {profiles.data && !list.length && (
          <p className="text-sm">
            You have no channel profiles yet.{" "}
            <Link to="/profiles" className="text-accent-500 hover:underline">
              Create one
            </Link>
            .
          </p>
        )}
        {fromId && profiles.data && !list.some((p) => p.id === fromId) && (
          <p className="muted text-xs">
            The profile this project came from is not one of yours (it was deleted, or the project is someone else's).
          </p>
        )}
        {list.length > 0 && (
          <Field label="Profile">
            <select className="input" value={profileId} onChange={(e) => setChosen(e.target.value)}>
              {list.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <ErrorBox error={diff.error} />
        {diff.isFetching && <Spinner />}
        {diff.data &&
          (changes.length ? (
            <ul className="divide-y divide-[var(--border)] text-sm">
              {changes.map((c) => (
                <li key={c.key} className="py-2">
                  <div className="font-medium">{LABELS[c.key] ?? c.key}</div>
                  <div className="text-xs break-all">
                    <span className="muted line-through">{show(c.from)}</span> → {show(c.to)}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted text-sm">This project already matches the profile: nothing would change.</p>
          ))}
        <p className="muted text-xs">
          Only the profile's settings are copied: format, type and style stay as they are, and nothing stays linked.
        </p>
      </div>
    </Modal>
  );
}
