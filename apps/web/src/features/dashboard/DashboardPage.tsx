import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  Check,
  Copy,
  Download,
  FolderOpen,
  LogOut,
  MailOpen,
  MoreVertical,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  Users,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { del, get, post } from "../../api/client.ts";
import { useAction, useMe } from "../../api/hooks.ts";
import type { ProjectListItem } from "../../api/types.ts";
import {
  AssetImage,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  fmt,
  PageHeader,
  Popover,
  Spinner,
  StatusChip,
  Tabs,
  toast,
} from "../../components/ui.tsx";

type Filter = "active" | "archived" | "trash";

export function DashboardPage() {
  const [filter, setFilter] = useState<Filter>("active");
  const q = useQuery({
    queryKey: ["projects", filter],
    queryFn: () => get<{ projects: ProjectListItem[] }>(`/projects?status=${filter}`),
  });
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader
        title="Projects"
        subtitle="Structured story state, consistent characters, deterministic lettering."
        actions={
          <div className="flex gap-2">
            <ImportProjectButton />
            <Link to="/projects/new" className="btn-primary">
              <Plus className="size-4" /> New project
            </Link>
          </div>
        }
      />
      <Tabs
        value={filter}
        onChange={setFilter}
        tabs={[
          { value: "active", label: "Recent" },
          { value: "archived", label: "Archived" },
          { value: "trash", label: "Trash" },
        ]}
      />
      <PendingInvites />
      {q.isLoading && <Spinner className="size-6" />}
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      {q.data && q.data.projects.length === 0 && (
        <EmptyState
          title={filter === "active" ? "No projects yet" : `Nothing in ${filter}`}
          action={
            filter === "active" && (
              <Link to="/projects/new" className="btn-primary">
                <Plus className="size-4" /> Create your first project
              </Link>
            )
          }
        >
          {filter === "active" &&
            "Paste a story, extract the cast and world, design references, plan pages and generate panels."}
        </EmptyState>
      )}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {q.data?.projects.map((p) => (
          <ProjectCard key={p.id} p={p} filter={filter} />
        ))}
      </div>
    </div>
  );
}

type Invite = {
  id: string;
  role: "editor" | "viewer";
  projectId: string;
  projectTitle: string;
  invitedBy: string | null;
  expiresAt: string;
};

/** Invitations to other people's projects, answered here. */
function PendingInvites() {
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ["invites"], queryFn: () => get<{ invites: Invite[] }>("/invites") });
  const answer = useAction(
    (v: { id: string; accept: boolean }) =>
      post<{ projectId?: string }>(`/invites/${v.id}/${v.accept ? "accept" : "decline"}`),
    {
      invalidate: [["invites"], ["projects"]],
      onSuccess: (r) => {
        if (r.projectId) navigate({ to: "/projects/$projectId", params: { projectId: r.projectId } });
      },
    },
  );
  if (!q.data?.invites.length) return null;
  return (
    <section className="card mb-4 p-3" aria-label="Invitations">
      <h2 className="mb-2 flex items-center gap-2 text-sm font-medium">
        <MailOpen className="size-4" /> Invitations
      </h2>
      <ul className="divide-y divide-[var(--border)]">
        {q.data.invites.map((i) => (
          <li key={i.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
            <div className="mr-auto min-w-0">
              <div className="truncate font-medium">{i.projectTitle}</div>
              <div className="muted text-xs">
                {i.invitedBy ? `@${i.invitedBy}` : "Someone"} invited you as{" "}
                {i.role === "editor" ? "an editor" : "a viewer"} · expires {fmt.date(i.expiresAt)}
              </div>
            </div>
            <button
              type="button"
              className="btn-primary"
              disabled={answer.isPending}
              onClick={() => answer.mutate({ id: i.id, accept: true })}
            >
              <Check className="size-4" /> Accept
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={answer.isPending}
              onClick={() => answer.mutate({ id: i.id, accept: false })}
            >
              <X className="size-4" /> Decline
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function ImportProjectButton() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const upload = async (file: File) => {
    setBusy(true);
    try {
      // Sent as a raw body: multipart would buffer the whole package, and a project export can be over a gigabyte.
      const r = await post<{ project: { id: string } }>(`/projects/import?name=${encodeURIComponent(file.name)}`, file);
      toast.success("Import started");
      await navigate({ to: "/projects/$projectId/exports", params: { projectId: r.project.id } });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".zip,.json,application/zip,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void upload(f);
        }}
      />
      <button type="button" className="btn-secondary" disabled={busy} onClick={() => input.current?.click()}>
        {busy ? <Spinner /> : <Upload className="size-4" />} Import project
      </button>
    </>
  );
}

function ProjectCard({ p, filter }: { p: ProjectListItem; filter: Filter }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [menu, setMenu] = useState(false);
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const [confirm, setConfirm] = useState<null | "trash" | "delete">(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["projects"] });
  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    try {
      await fn();
      toast.success(msg);
      await refresh();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
      setMenu(false);
      setConfirm(null);
    }
  };
  const open = () => navigate({ to: "/projects/$projectId", params: { projectId: p.id } });
  const { data: me } = useMe();
  const shared = p.role !== "owner";
  return (
    <div className="card group relative">
      <button
        type="button"
        className="block w-full overflow-hidden rounded-t-xl text-left"
        onClick={open}
        disabled={filter === "trash"}
        aria-label={`Open ${p.title}`}
      >
        {/* Covers are portrait, so a landscape crop cut most of one away. 3:4 shows the whole cover. */}
        <AssetImage assetId={p.thumbnailAssetId} alt={`${p.title} thumbnail`} className="aspect-[3/4] w-full" />
      </button>
      <div className="p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="truncate font-medium" title={p.title}>
              {p.title}
            </h3>
            <div className="muted text-xs capitalize">
              {p.projectType.replace("_", " ")} · updated {fmt.ago(p.updatedAt)}
            </div>
            {shared && (
              <div
                className="muted mt-1 flex items-center gap-1 text-xs"
                title={`Shared with you by @${p.ownerUsername}`}
              >
                <span className="chip bg-accent-600/15 text-[var(--text)]">
                  <Users className="size-3" /> Shared
                </span>
                <span className="truncate">
                  @{p.ownerUsername} · {p.role}
                </span>
              </div>
            )}
          </div>
          <StatusChip status={p.deletedAt ? "cancelled" : p.status} label={p.deletedAt ? "trash" : p.status} />
          <div>
            <button
              ref={menuAnchor}
              type="button"
              className="btn-ghost p-1"
              aria-label="Project actions"
              onClick={() => setMenu((m) => !m)}
              disabled={busy}
            >
              {busy ? <Spinner /> : <MoreVertical className="size-4" />}
            </button>
            <Popover anchor={menuAnchor} open={menu} onClose={() => setMenu(false)} className="w-44 p-1">
              <div onMouseLeave={() => setMenu(false)}>
                {filter !== "trash" && (
                  <>
                    <button type="button" className="btn-ghost w-full justify-start" onClick={open}>
                      <FolderOpen className="size-4" /> Open
                    </button>
                    {p.role !== "viewer" && (
                      <button
                        type="button"
                        className="btn-ghost w-full justify-start"
                        onClick={() => run(() => post(`/projects/${p.id}/duplicate`), "Project duplicated")}
                      >
                        <Copy className="size-4" /> Duplicate
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn-ghost w-full justify-start"
                      onClick={() => navigate({ to: "/projects/$projectId/exports", params: { projectId: p.id } })}
                    >
                      <Download className="size-4" /> Export
                    </button>
                    {shared ? (
                      <button
                        type="button"
                        className="btn-ghost w-full justify-start text-red-500"
                        disabled={!me}
                        onClick={() => run(() => del(`/projects/${p.id}/members/${me?.id}`), "You left the project")}
                      >
                        <LogOut className="size-4" /> Leave project
                      </button>
                    ) : p.status === "active" ? (
                      <button
                        type="button"
                        className="btn-ghost w-full justify-start"
                        onClick={() => run(() => post(`/projects/${p.id}/status`, { action: "archive" }), "Archived")}
                      >
                        <Archive className="size-4" /> Archive
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-ghost w-full justify-start"
                        onClick={() => run(() => post(`/projects/${p.id}/status`, { action: "unarchive" }), "Restored")}
                      >
                        <ArchiveRestore className="size-4" /> Unarchive
                      </button>
                    )}
                    {!shared && (
                      <button
                        type="button"
                        className="btn-ghost w-full justify-start text-red-500"
                        onClick={() => setConfirm("trash")}
                      >
                        <Trash2 className="size-4" /> Move to trash
                      </button>
                    )}
                  </>
                )}
                {filter === "trash" && !shared && (
                  <>
                    <button
                      type="button"
                      className="btn-ghost w-full justify-start"
                      onClick={() =>
                        run(() => post(`/projects/${p.id}/status`, { action: "restore" }), "Restored from trash")
                      }
                    >
                      <RotateCcw className="size-4" /> Restore
                    </button>
                    <button
                      type="button"
                      className="btn-ghost w-full justify-start text-red-500"
                      onClick={() => setConfirm("delete")}
                    >
                      <Trash2 className="size-4" /> Delete forever
                    </button>
                  </>
                )}
              </div>
            </Popover>
          </div>
        </div>
        <dl className="muted mt-2 grid grid-cols-4 gap-1 text-center text-[11px]">
          <div>
            <dt>Chapters</dt>
            <dd className="text-sm text-[var(--text)]">{p.stats.chapters}</dd>
          </div>
          <div>
            <dt>Panels</dt>
            <dd className="text-sm text-[var(--text)]">{p.stats.panels}</dd>
          </div>
          <div>
            <dt>Gens</dt>
            <dd className="text-sm text-[var(--text)]">{p.stats.generations}</dd>
          </div>
          <div>
            <dt>Spend</dt>
            <dd className="text-sm text-[var(--text)]">{fmt.usd(p.stats.estimatedSpendUsd)}</dd>
          </div>
        </dl>
      </div>
      <ConfirmDialog
        open={confirm === "trash"}
        title="Move to trash?"
        danger
        confirmLabel="Move to trash"
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={() => run(() => post(`/projects/${p.id}/status`, { action: "trash" }), "Moved to trash")}
      >
        “{p.title}” will be moved to trash. You can restore it later; nothing is deleted yet.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm === "delete"}
        title="Delete permanently?"
        danger
        confirmLabel="Delete forever"
        busy={busy}
        onClose={() => setConfirm(null)}
        onConfirm={() => run(() => del(`/projects/${p.id}`), "Project deleted")}
      >
        This permanently deletes “{p.title}”, all structured data and every generated file. This cannot be undone.
      </ConfirmDialog>
    </div>
  );
}
