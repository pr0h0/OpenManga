import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { get, post } from "../../api/client.ts";
import { ErrorBox, fmt, Spinner, toast } from "../../components/ui.tsx";
import { CommentText } from "../comments/comments.tsx";

type GuestComment = {
  id: string;
  panelId: string;
  threadId: string | null;
  guestName: string | null;
  author: string | null;
  authorName: string | null;
  body: string;
  resolvedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};
type GuestThread = GuestComment & { replies: GuestComment[] };
type Page = { id: string; order: number; panels: { id: string; order: number }[] };

const NAME_KEY = "om-guest-name";
const readName = () => {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
};

const who = (c: GuestComment) => (c.guestName ? `${c.guestName} (guest)` : c.authorName || c.author || "The team");

/**
 * Comments on a reader link that allows them: a reader picks a page and a panel and writes under a name (kept in this
 * browser), and sees the threads readers started through this link, with the team's replies. Nothing else.
 */
export function GuestComments({
  token,
  pages,
  pageId,
  onPage,
  onClose,
}: {
  token: string;
  pages: Page[];
  pageId: string;
  onPage: (id: string) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const key = ["guest-comments", token, pageId] as const;
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<{ threads: GuestThread[] }>(`/public/shares/${token}/comments?pageId=${pageId}`),
  });
  const page = pages.find((p) => p.id === pageId);
  const [name, setName] = useState(readName);
  const [panelId, setPanelId] = useState("");
  const [text, setText] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setPanelId(page?.panels[0]?.id ?? ""), [pageId]);
  const send = async (e: FormEvent, threadId?: string, threadPanel?: string) => {
    e.preventDefault();
    if (!name.trim() || !text.trim()) return;
    setBusy(true);
    try {
      await post(`/public/shares/${token}/comments`, {
        panelId: threadPanel ?? panelId,
        name: name.trim(),
        body: text.trim(),
        ...(threadId ? { threadId } : {}),
      });
      try {
        localStorage.setItem(NAME_KEY, name.trim());
      } catch {}
      setText("");
      setReplyTo(null);
      await qc.invalidateQueries({ queryKey: key });
      toast.success("Comment sent");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const panelNo = (id: string) => (page?.panels.findIndex((p) => p.id === id) ?? -1) + 1;
  const form = (threadId?: string, threadPanel?: string) => (
    <form className="space-y-1.5" onSubmit={(e) => void send(e, threadId, threadPanel)}>
      <textarea
        className="input min-h-16 text-sm"
        maxLength={4000}
        placeholder={threadId ? "Reply" : "Your comment"}
        aria-label={threadId ? "Reply" : "Your comment"}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <button type="submit" className="btn-primary text-xs" disabled={busy || !name.trim() || !text.trim()}>
        {busy && <Spinner />} {threadId ? "Reply" : "Comment"}
      </button>
    </form>
  );
  return (
    <aside
      aria-label="Comments"
      className="fixed inset-y-0 right-0 z-20 flex w-full flex-col gap-3 overflow-y-auto border-l border-[var(--border)] bg-[var(--panel)] p-4 sm:w-96"
    >
      <div className="flex items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold">Comments</h2>
        <button type="button" className="btn-ghost p-1" aria-label="Close comments" onClick={onClose}>
          <X className="size-4" />
        </button>
      </div>
      <p className="muted text-xs">
        Your name and comment are seen by the team behind this book and by other readers of this link.
      </p>
      <label className="text-xs">
        <span className="label">Your name</span>
        <input className="input" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <label>
          <span className="label">Page</span>
          <select className="input" value={pageId} onChange={(e) => onPage(e.target.value)}>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>
                Page {p.order}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="label">Panel</span>
          <select className="input" value={panelId} onChange={(e) => setPanelId(e.target.value)}>
            {page?.panels.map((p, i) => (
              <option key={p.id} value={p.id}>
                Panel {i + 1}
              </option>
            ))}
          </select>
        </label>
      </div>
      {!replyTo && form()}
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} />
      {q.data && !q.data.threads.length && <p className="muted text-xs">No comments on this page yet.</p>}
      <ul className="space-y-2">
        {q.data?.threads.map((t) => (
          <li key={t.id} className={`card space-y-1.5 p-2.5 text-sm ${t.resolvedAt ? "opacity-70" : ""}`}>
            <div className="flex flex-wrap items-baseline gap-1.5 text-xs">
              <span className="font-medium">{who(t)}</span>
              <span className="muted">
                panel {panelNo(t.panelId)} · {fmt.ago(t.createdAt)}
                {t.resolvedAt && " · resolved"}
              </span>
            </div>
            <CommentText body={t.body} />
            {t.replies.map((r) => (
              <div key={r.id} className="border-l-2 border-[var(--border)] pl-2">
                <div className="text-xs">
                  <span className="font-medium">{who(r)}</span> <span className="muted">{fmt.ago(r.createdAt)}</span>
                </div>
                <CommentText body={r.body} />
              </div>
            ))}
            {replyTo === t.id ? (
              <>
                {form(t.id, t.panelId)}
                <button type="button" className="btn-ghost text-xs" onClick={() => setReplyTo(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <button type="button" className="btn-ghost text-xs" onClick={() => setReplyTo(t.id)}>
                Reply
              </button>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
