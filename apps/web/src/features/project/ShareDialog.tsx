import { useQuery } from "@tanstack/react-query";
import { ExternalLink, Trash2 } from "lucide-react";
import { useState } from "react";
import { del, get, post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import type { ChapterListItem } from "../../api/types.ts";
import { ErrorBox, Field, fmt, Modal, Spinner } from "../../components/ui.tsx";
import { CopyButton } from "../generation/shared.tsx";

type Share = { id: string; token: string; chapterId: string | null; chapterTitle: string | null; createdAt: string };

const readerUrl = (token: string) => `${window.location.origin}/app/read/${token}`;

/** Unlisted, read-only reader links: anyone with one can read, nobody can change anything, and revoking is instant. */
export function ShareDialog({ projectId, open, onClose }: { projectId: string; open: boolean; onClose: () => void }) {
  const key = ["project", projectId, "shares"] as const;
  const shares = useQuery({
    queryKey: key,
    queryFn: () => get<{ shares: Share[] }>(`/projects/${projectId}/shares`),
    enabled: open,
  });
  const chapters = useQuery({
    queryKey: ["project", projectId, "chapters"],
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
    enabled: open,
  });
  const [chapterId, setChapterId] = useState("");
  const create = useAction(() => post(`/projects/${projectId}/shares`, { chapterId: chapterId || null }), {
    invalidate: [key],
    success: "Link created",
  });
  const revoke = useAction((id: string) => del(`/shares/${id}`), { invalidate: [key], success: "Link revoked" });
  return (
    <Modal open={open} onClose={onClose} title="Share a reader link">
      <div className="space-y-4">
        <p className="muted text-sm">
          Anyone with a link can read the pages, lettered, without an account. They can't see anything else or change
          anything. Links aren't listed anywhere; revoke one to close it at once.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Field label="What to share">
            <select className="input" value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
              <option value="">The whole project</option>
              {chapters.data?.chapters.map((ch) => (
                <option key={ch.id} value={ch.id}>
                  Chapter {ch.order}: {ch.title}
                </option>
              ))}
            </select>
          </Field>
          <button type="button" className="btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
            {create.isPending && <Spinner />} Create link
          </button>
        </div>
        <ErrorBox error={shares.error} />
        {shares.data && !shares.data.shares.length && <p className="muted text-sm">No links yet.</p>}
        <ul className="divide-y divide-[var(--border)]">
          {shares.data?.shares.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <div className="mr-auto min-w-0">
                <div className="truncate font-medium">{s.chapterTitle ?? "Whole project"}</div>
                <div className="muted truncate text-xs">
                  {readerUrl(s.token)} · {fmt.ago(s.createdAt)}
                </div>
              </div>
              <CopyButton text={readerUrl(s.token)} />
              <a className="btn-secondary" href={readerUrl(s.token)} target="_blank" rel="noreferrer" title="Open">
                <ExternalLink className="size-4" />
              </a>
              <button
                type="button"
                className="btn-secondary"
                title="Revoke"
                aria-label="Revoke link"
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(s.id)}
              >
                <Trash2 className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
