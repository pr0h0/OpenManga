import { useQuery } from "@tanstack/react-query";
import { Bot, Check, Crosshair, MessageSquare, Pencil, RotateCcw, Trash2, X } from "lucide-react";
import { type FormEvent, Fragment, useState } from "react";
import { assetUrl, del, get, patch, post } from "../../api/client.ts";
import { useAction, useMe } from "../../api/hooks.ts";
import { ErrorBox, fmt, Spinner } from "../../components/ui.tsx";
import { useMembers } from "../project/MembersDialog.tsx";
import { PreviewVideoButton } from "../video/VideoPreview.tsx";

export type Anchor = { x: number; y: number };
export type Comment = {
  id: string;
  panelId: string;
  chapterId: string;
  /** Left by a guest through a reader link: their name, and no account. */
  guestName: string | null;
  anchor: Anchor | null;
  timecodeMs: number | null;
  assigneeUserId: string | null;
  assignee: string | null;
  artworkAssetId: string | null;
  resolvedArtworkAssetId: string | null;
  currentArtworkAssetId: string | null;
  threadId: string | null;
  authorUserId: string | null;
  author: string | null;
  authorName: string | null;
  body: string;
  /** Written through an agent connection (MCP); its name only when it is the viewer's own. */
  viaAgent: boolean;
  agentName: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedViaAgent: boolean;
  resolvedAgentName: string | null;
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};
export type Thread = Comment & { replies: Comment[] };

/**
 * How a comment was written: by hand, or through an agent connection. Everyone sees "MCP"; the member whose
 * connection it was also sees its name.
 */
export function Source({ viaAgent, agentName }: { viaAgent: boolean; agentName: string | null }) {
  if (!viaAgent) return <span className="muted">by hand</span>;
  return (
    <span
      className="chip inline-flex items-center gap-1 px-1.5 py-0 text-[11px]"
      title={agentName ? `Written through your connection "${agentName}"` : "Written through an agent connection (MCP)"}
    >
      <Bot className="size-3" /> MCP{agentName ? ` · ${agentName}` : ""}
    </span>
  );
}

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
        <span className="font-medium">
          {c.guestName ? `${c.guestName} (guest)` : c.authorName || c.author || "Former member"}
        </span>
        {!c.guestName && <Source viaAgent={c.viaAgent} agentName={c.agentName} />}
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

const mmss = (ms: number) => `${Math.floor(ms / 60_000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;

/** The panel's artwork when the thread was started next to the art it was resolved on (or shows now), when they differ. */
function BeforeAfter({ t }: { t: Thread }) {
  const after = t.resolvedAt ? t.resolvedArtworkAssetId : t.currentArtworkAssetId;
  if (!t.artworkAssetId || !after || after === t.artworkAssetId) return null;
  return (
    <div className="grid grid-cols-2 gap-1.5 text-[11px]">
      {[
        ["When commented", t.artworkAssetId],
        [t.resolvedAt ? "When resolved" : "Now", after],
      ].map(([label, id]) => (
        <figure key={label} className="space-y-0.5">
          <img src={assetUrl(id!, "thumbnail")} alt={label!} className="aspect-square w-full rounded object-cover" />
          <figcaption className="muted">{label}</figcaption>
        </figure>
      ))}
    </div>
  );
}

/** One thread: its first comment, replies, a reply box, and resolve or reopen. */
export function ThreadView({ t, projectId, pinNo }: { t: Thread; projectId: string; pinNo?: number }) {
  const invalidate = [commentKeys.panel(t.panelId), commentKeys.project(projectId), commentKeys.counts(projectId)];
  const [replying, setReplying] = useState(false);
  const reply = useAction((body: string) => post(`/panels/${t.panelId}/comments`, { body, threadId: t.id }), {
    invalidate,
    onSuccess: () => setReplying(false),
  });
  const resolve = useAction((resolved: boolean) => post(`/comments/${t.id}/resolve`, { resolved }), { invalidate });
  const assign = useAction((assigneeUserId: string | null) => post(`/comments/${t.id}/assign`, { assigneeUserId }), {
    invalidate,
  });
  const members = useMembers(projectId);
  return (
    <li className={`card space-y-2 p-2.5 ${t.resolvedAt ? "opacity-70" : ""}`}>
      {(pinNo || t.timecodeMs !== null || t.assignee || !t.resolvedAt) && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          {pinNo && (
            <span
              className="inline-flex size-4 items-center justify-center rounded-full bg-accent-600 font-semibold text-white"
              title="Pinned spot on the artwork"
            >
              {pinNo}
            </span>
          )}
          {t.timecodeMs !== null && (
            <PreviewVideoButton
              projectId={projectId}
              scope={{ chapterId: t.chapterId }}
              label={mmss(t.timecodeMs)}
              title={`The chapter's video at ${mmss(t.timecodeMs)}`}
              className="chip px-1.5 py-0 text-[11px]"
              startAtMs={t.timecodeMs}
            />
          )}
          <label className="ml-auto flex items-center gap-1">
            <span className="muted">Assigned to</span>
            <select
              className="input w-auto py-0 text-[11px]"
              aria-label="Assigned to"
              value={t.assigneeUserId ?? ""}
              disabled={assign.isPending}
              onChange={(e) => assign.mutate(e.target.value || null)}
            >
              <option value="">nobody</option>
              {members.data?.members.map((m) => (
                <option key={m.userId} value={m.userId}>
                  @{m.username}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <CommentItem c={t} projectId={projectId} invalidate={invalidate} />
      <BeforeAfter t={t} />
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
              <span className="muted inline-flex flex-wrap items-center gap-1">
                Resolved{t.resolvedBy ? ` by @${t.resolvedBy}` : ""}
                {t.resolvedViaAgent && <Source viaAgent agentName={t.resolvedAgentName} />}
              </span>
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

/**
 * The panel's artwork with the open threads' pins, numbered as in the list; while `picking`, a click sets the spot a new
 * thread points at. The image keeps its own shape, so a click's fraction of its box is a fraction of the artwork.
 */
function PinBoard({
  assetId,
  pins,
  picked,
  picking,
  onPick,
}: {
  assetId: string;
  pins: { n: number; anchor: Anchor }[];
  picked: Anchor | null;
  picking: boolean;
  onPick: (a: Anchor) => void;
}) {
  const dot = (a: Anchor, label: string, extra: string) => (
    <span
      key={label}
      className={`pointer-events-none absolute flex size-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full text-[10px] font-semibold text-white shadow ring-2 ring-white ${extra}`}
      style={{ left: `${a.x * 100}%`, top: `${a.y * 100}%` }}
    >
      {label}
    </span>
  );
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: picking a spot is pointer-only; the comment works without one.
    <div
      className={`relative overflow-hidden rounded-lg border border-[var(--border)] ${picking ? "cursor-crosshair ring-2 ring-accent-500" : ""}`}
      onClick={(e) => {
        if (!picking) return;
        const r = e.currentTarget.getBoundingClientRect();
        onPick({
          x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)),
          y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)),
        });
      }}
    >
      <img src={assetUrl(assetId, "web")} alt="Panel artwork" className="block h-auto w-full" draggable={false} />
      {pins.map((p) => dot(p.anchor, String(p.n), "bg-accent-600"))}
      {picked && dot(picked, "+", "bg-amber-500")}
    </div>
  );
}

/** A panel's comment threads and a box to start one. Every member, viewers included, can take part. */
export function PanelComments({ projectId, panelId }: { projectId: string; panelId: string }) {
  const q = useQuery({
    queryKey: commentKeys.panel(panelId),
    queryFn: () => get<{ threads: Thread[] }>(`/panels/${panelId}/comments`),
  });
  const art = useQuery({
    queryKey: ["panel-art", panelId],
    queryFn: () => get<{ panel: { activeArtworkAssetId: string | null } }>(`/panels/${panelId}`),
  }).data?.panel.activeArtworkAssetId;
  const members = useMembers(projectId);
  const [pin, setPin] = useState<Anchor | null>(null);
  const [picking, setPicking] = useState(false);
  const [assignee, setAssignee] = useState("");
  const create = useAction(
    (body: string) =>
      post(`/panels/${panelId}/comments`, {
        body,
        ...(pin ? { anchor: pin } : {}),
        ...(assignee ? { assigneeUserId: assignee } : {}),
      }),
    {
      invalidate: [commentKeys.panel(panelId), commentKeys.project(projectId), commentKeys.counts(projectId)],
      onSuccess: () => {
        setPin(null);
        setAssignee("");
      },
    },
  );
  const [showResolved, setShowResolved] = useState(false);
  const threads = q.data?.threads ?? [];
  const resolved = threads.filter((t) => t.resolvedAt).length;
  // Pins are numbered over the open threads that have one, in list order.
  const pinNo = new Map(threads.filter((t) => !t.resolvedAt && t.anchor).map((t, i) => [t.id, i + 1] as const));
  return (
    <div className="space-y-3">
      {art && (
        <PinBoard
          assetId={art}
          pins={threads.filter((t) => pinNo.has(t.id)).map((t) => ({ n: pinNo.get(t.id)!, anchor: t.anchor! }))}
          picked={pin}
          picking={picking}
          onPick={(a) => {
            setPin(a);
            setPicking(false);
          }}
        />
      )}
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        {art &&
          (pin ? (
            <button type="button" className="btn-ghost px-1.5 py-0.5 text-xs" onClick={() => setPin(null)}>
              <X className="size-3" /> Remove the pin
            </button>
          ) : (
            <button
              type="button"
              className={`btn-ghost px-1.5 py-0.5 text-xs ${picking ? "bg-[var(--panel-2)]" : ""}`}
              aria-pressed={picking}
              onClick={() => setPicking((v) => !v)}
            >
              <Crosshair className="size-3" /> {picking ? "Click the spot on the artwork" : "Pin a spot"}
            </button>
          ))}
        <label className="ml-auto flex items-center gap-1">
          <span className="muted">Assign to</span>
          <select
            className="input w-auto py-0 text-xs"
            aria-label="Assign the new thread to"
            value={assignee}
            onChange={(e) => setAssignee(e.target.value)}
          >
            <option value="">nobody</option>
            {members.data?.members.map((m) => (
              <option key={m.userId} value={m.userId}>
                @{m.username}
              </option>
            ))}
          </select>
        </label>
      </div>
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
            <ThreadView key={t.id} t={t} projectId={projectId} pinNo={pinNo.get(t.id)} />
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
