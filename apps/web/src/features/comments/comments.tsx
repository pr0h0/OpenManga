import { useQuery } from "@tanstack/react-query";
import { Check, MessageSquare, Pencil, RotateCcw, Trash2 } from "lucide-react";
import { type FormEvent, Fragment, useState } from "react";
import { del, get, patch, post } from "../../api/client.ts";
import { useAction, useMe } from "../../api/hooks.ts";
import { ErrorBox, fmt, Spinner } from "../../components/ui.tsx";
import { useMembers } from "../project/MembersDialog.tsx";

export type Comment = {
  id: string;
  panelId: string;
  threadId: string | null;
  authorUserId: string | null;
  author: string | null;
  authorName: string | null;
  body: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};
export type Thread = Comment & { replies: Comment[] };

export const commentKeys = {
  panel: (panelId: string) => ["comments", panelId] as const,
  project: (projectId: string) => ["project", projectId, "comments"] as const,
  counts: (projectId: string) => ["project", projectId, "comment-counts"] as const,
};

/** Open threads per panel and per page, for the badges. */
export function useCommentCounts(projectId: string) {
  return useQuery({
    queryKey: commentKeys.counts(projectId),
    queryFn: () =>
      get<{ panels: Record<string, number>; pages: Record<string, number> }>(`/projects/${projectId}/comment-counts`),
    staleTime: 30_000,
  });
}

/** A small count of open threads; nothing when there are none. */
export function CommentBadge({ n, className = "" }: { n: number | undefined; className?: string }) {
  if (!n) return null;
  return (
    <span
      className={`inline-flex items-center gap-0.5 rounded-full bg-accent-600 px-1.5 text-[10px] font-semibold leading-4 text-white ${className}`}
      title={`${n} open comment thread${n === 1 ? "" : "s"}`}
    >
      <MessageSquare className="size-2.5" aria-hidden /> {n}
      <span className="sr-only"> open comment threads</span>
    </span>
  );
}

/**
 * A comment's words, as text: React escapes every character, so nothing a member writes is ever markup. @mentions are
 * only set in bold.
 */
export function CommentText({ body }: { body: string }) {
  const parts = body.split(/(@[a-z0-9_][a-z0-9_.-]{2,31})/gi);
  return (
    <p className="whitespace-pre-wrap break-words text-sm">
      {parts.map((part, i) =>
        i % 2 ? (
          <strong key={i} className="text-accent-500">
            {part}
          </strong>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        ),
      )}
    </p>
  );
}

function Composer({
  projectId,
  placeholder,
  initial = "",
  submitLabel,
  busy,
  onSubmit,
  onCancel,
}: {
  projectId: string;
  placeholder: string;
  initial?: string;
  submitLabel: string;
  busy: boolean;
  onSubmit: (body: string) => Promise<unknown>;
  onCancel?: () => void;
}) {
  const [text, setText] = useState(initial);
  const members = useMembers(projectId);
  const { data: me } = useMe();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    // A failure is already shown as a toast; the text stays so nothing typed is lost.
    if (
      await onSubmit(text.trim()).then(
        () => true,
        () => false,
      )
    )
      setText("");
  };
  const others = members.data?.members.filter((m) => m.userId !== me?.id) ?? [];
  return (
    <form onSubmit={submit} className="space-y-1.5">
      <textarea
        className="input min-h-16 text-sm"
        value={text}
        maxLength={4000}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
        }}
      />
      <div className="flex flex-wrap items-center gap-1">
        {others.length > 0 && <span className="muted text-[11px]">Mention:</span>}
        {others.map((m) => (
          <button
            key={m.userId}
            type="button"
            className="btn-ghost px-1.5 py-0 text-[11px]"
            onClick={() => setText((t) => `${t}${t && !t.endsWith(" ") ? " " : ""}@${m.username} `)}
          >
            @{m.username}
          </button>
        ))}
        <span className="ml-auto flex gap-1">
          {onCancel && (
            <button type="button" className="btn-ghost text-xs" onClick={onCancel}>
              Cancel
            </button>
          )}
          <button type="submit" className="btn-primary py-1 text-xs" disabled={busy || !text.trim()}>
            {busy && <Spinner />} {submitLabel}
          </button>
        </span>
      </div>
    </form>
  );
}

function CommentItem({
  c,
  projectId,
  invalidate,
}: {
  c: Comment;
  projectId: string;
  invalidate: readonly (readonly unknown[])[];
}) {
  const { data: me } = useMe();
  const [editing, setEditing] = useState(false);
  const edit = useAction((body: string) => patch(`/comments/${c.id}`, { body }), {
    invalidate,
    onSuccess: () => setEditing(false),
  });
  const remove = useAction(() => del(`/comments/${c.id}`), { invalidate, success: "Comment deleted" });
  const mine = me && c.authorUserId === me.id;
  if (c.deletedAt) return <p className="muted text-xs italic">Comment deleted</p>;
  return (
    <div className="group space-y-0.5">
      <div className="flex items-baseline gap-1.5 text-xs">
        <span className="font-medium">{c.authorName || c.author || "Former member"}</span>
        <span className="muted">
          {fmt.ago(c.createdAt)}
          {c.editedAt && " · edited"}
        </span>
        {mine && !editing && (
          <span className="ml-auto flex gap-0.5">
            <button
              type="button"
              className="btn-ghost p-0.5"
              aria-label="Edit comment"
              onClick={() => setEditing(true)}
            >
              <Pencil className="size-3" />
            </button>
            <button
              type="button"
              className="btn-ghost p-0.5 text-red-500"
              aria-label="Delete comment"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              <Trash2 className="size-3" />
            </button>
          </span>
        )}
      </div>
      {editing ? (
        <Composer
          projectId={projectId}
          placeholder="Edit comment"
          initial={c.body}
          submitLabel="Save"
          busy={edit.isPending}
          onSubmit={(b) => edit.mutateAsync(b)}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <CommentText body={c.body} />
      )}
    </div>
  );
}

/** One thread: its first comment, replies, a reply box, and resolve or reopen. */
export function ThreadView({ t, projectId }: { t: Thread; projectId: string }) {
  const invalidate = [commentKeys.panel(t.panelId), commentKeys.project(projectId), commentKeys.counts(projectId)];
  const [replying, setReplying] = useState(false);
  const reply = useAction((body: string) => post(`/panels/${t.panelId}/comments`, { body, threadId: t.id }), {
    invalidate,
    onSuccess: () => setReplying(false),
  });
  const resolve = useAction((resolved: boolean) => post(`/comments/${t.id}/resolve`, { resolved }), { invalidate });
  return (
    <li className={`card space-y-2 p-2.5 ${t.resolvedAt ? "opacity-70" : ""}`}>
      <CommentItem c={t} projectId={projectId} invalidate={invalidate} />
      {t.replies.length > 0 && (
        <ul className="space-y-2 border-l-2 border-[var(--border)] pl-2.5">
          {t.replies.map((r) => (
            <li key={r.id}>
              <CommentItem c={r} projectId={projectId} invalidate={invalidate} />
            </li>
          ))}
        </ul>
      )}
      {replying ? (
        <Composer
          projectId={projectId}
          placeholder="Reply"
          submitLabel="Reply"
          busy={reply.isPending}
          onSubmit={(b) => reply.mutateAsync(b)}
          onCancel={() => setReplying(false)}
        />
      ) : (
        <div className="flex items-center gap-1 text-xs">
          <button type="button" className="btn-ghost py-0.5 text-xs" onClick={() => setReplying(true)}>
            Reply
          </button>
          {t.resolvedAt ? (
            <>
              <span className="muted">Resolved{t.resolvedBy ? ` by @${t.resolvedBy}` : ""}</span>
              <button
                type="button"
                className="btn-ghost ml-auto py-0.5 text-xs"
                disabled={resolve.isPending}
                onClick={() => resolve.mutate(false)}
              >
                <RotateCcw className="size-3" /> Reopen
              </button>
            </>
          ) : (
            <button
              type="button"
              className="btn-ghost ml-auto py-0.5 text-xs"
              disabled={resolve.isPending}
              onClick={() => resolve.mutate(true)}
            >
              <Check className="size-3" /> Resolve
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/** A panel's comment threads and a box to start one. Every member, viewers included, can take part. */
export function PanelComments({ projectId, panelId }: { projectId: string; panelId: string }) {
  const q = useQuery({
    queryKey: commentKeys.panel(panelId),
    queryFn: () => get<{ threads: Thread[] }>(`/panels/${panelId}/comments`),
  });
  const create = useAction((body: string) => post(`/panels/${panelId}/comments`, { body }), {
    invalidate: [commentKeys.panel(panelId), commentKeys.project(projectId), commentKeys.counts(projectId)],
  });
  const [showResolved, setShowResolved] = useState(false);
  const threads = q.data?.threads ?? [];
  const resolved = threads.filter((t) => t.resolvedAt).length;
  return (
    <div className="space-y-3">
      <Composer
        projectId={projectId}
        placeholder="Comment on this panel"
        submitLabel="Comment"
        busy={create.isPending}
        onSubmit={(b) => create.mutateAsync(b)}
      />
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} />
      {q.data && !threads.length && <p className="muted text-xs">No comments on this panel yet.</p>}
      <ul className="space-y-2">
        {threads
          .filter((t) => showResolved || !t.resolvedAt)
          .map((t) => (
            <ThreadView key={t.id} t={t} projectId={projectId} />
          ))}
      </ul>
      {resolved > 0 && (
        <button type="button" className="btn-ghost text-xs" onClick={() => setShowResolved((v) => !v)}>
          {showResolved ? "Hide" : "Show"} {resolved} resolved
        </button>
      )}
    </div>
  );
}
