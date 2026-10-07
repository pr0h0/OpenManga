import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Bell } from "lucide-react";
import { useRef, useState } from "react";
import { get, post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import { fmt, Popover } from "../../components/ui.tsx";

type Notification = {
  id: string;
  kind: "mention" | "reply" | "assigned" | "guest";
  guestName: string | null;
  readAt: string | null;
  createdAt: string;
  actor: string | null;
  viaAgent: boolean;
  projectId: string;
  projectTitle: string;
  body: string;
  panelId: string;
  pageId: string;
};

const key = ["notifications"] as const;

/**
 * Mentions and replies, with an unread count in the header. Polled once a minute, and refreshed at once by a comment
 * event on whichever project page is open.
 */
export function NotificationBell() {
  const navigate = useNavigate();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<{ notifications: Notification[]; unread: number }>("/notifications"),
    refetchInterval: 60_000,
  });
  const markRead = useAction((ids?: string[]) => post("/notifications/read", ids ? { ids } : {}), {
    invalidate: [key],
  });
  const unread = q.data?.unread ?? 0;
  const go = (n: Notification) => {
    setOpen(false);
    if (!n.readAt) markRead.mutate([n.id]);
    navigate({
      to: "/projects/$projectId/pages/$pageId",
      params: { projectId: n.projectId, pageId: n.pageId },
      search: { panelId: n.panelId, tab: "comments" },
    });
  };
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className="btn-ghost relative"
        aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Bell className="size-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-red-500 px-1 text-center text-[10px] font-semibold leading-4 text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} className="w-80 max-w-[calc(100vw-1rem)] p-1">
        <div className="flex items-center justify-between px-2 py-1 text-sm">
          <span className="font-medium">Notifications</span>
          {unread > 0 && (
            <button type="button" className="btn-ghost py-0.5 text-xs" onClick={() => markRead.mutate(undefined)}>
              Mark all read
            </button>
          )}
        </div>
        {!q.data?.notifications.length && <p className="muted px-2 py-3 text-sm">Nothing yet.</p>}
        <ul className="max-h-96 overflow-y-auto">
          {q.data?.notifications.map((n) => (
            <li key={n.id}>
              <button
                type="button"
                className={`w-full rounded-lg px-2 py-1.5 text-left text-sm hover:bg-[var(--panel-2)] ${n.readAt ? "muted" : ""}`}
                onClick={() => go(n)}
              >
                <div className="flex items-center gap-1.5 text-xs">
                  {!n.readAt && <span className="size-1.5 shrink-0 rounded-full bg-accent-500" title="Unread" />}
                  <span className="truncate">
                    {n.kind === "guest" ? `${n.guestName ?? "A guest"} (guest)` : `@${n.actor ?? "someone"}`}
                    {n.viaAgent ? " (via MCP)" : ""}{" "}
                    {
                      {
                        mention: "mentioned you",
                        reply: "replied",
                        assigned: "assigned you a thread",
                        guest: "commented through a reader link",
                      }[n.kind]
                    }{" "}
                    in {n.projectTitle}
                  </span>
                  <span className="muted ml-auto shrink-0">{fmt.ago(n.createdAt)}</span>
                </div>
                {/* Text only: a comment is never rendered as markup. */}
                <div className="line-clamp-2 break-words text-xs">{n.body}</div>
              </button>
            </li>
          ))}
        </ul>
      </Popover>
    </>
  );
}
