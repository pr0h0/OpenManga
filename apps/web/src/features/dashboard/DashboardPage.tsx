import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  Archive,
  ArchiveRestore,
  Copy,
  Download,
  FolderOpen,
  MoreVertical,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { useRef, useState } from "react";
import { del, get, post } from "../../api/client.ts";
import type { ProjectListItem } from "../../api/types.ts";
import {
  AssetImage,
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  fmt,
  PageHeader,
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
          </div>
          <StatusChip status={p.deletedAt ? "cancelled" : p.status} label={p.deletedAt ? "trash" : p.status} />
          <div className="relative">
            <button
              type="button"
              className="btn-ghost p-1"
              aria-label="Project actions"
              onClick={() => setMenu((m) => !m)}
              disabled={busy}
            >
              {busy ? <Spinner /> : <MoreVertical className="size-4" />}
            </button>
            {menu && (
              <div className="card absolute right-0 z-20 mt-1 w-44 p-1 shadow-xl" onMouseLeave={() => setMenu(false)}>
                {filter !== "trash" && (
                  <>
                    <button type="button" className="btn-ghost w-full justify-start" onClick={open}>
                      <FolderOpen className="size-4" /> Open
                    </button>
                    <button
                      type="button"
                      className="btn-ghost w-full justify-start"
                      onClick={() => run(() => post(`/projects/${p.id}/duplicate`), "Project duplicated")}
                    >
                      <Copy className="size-4" /> Duplicate
                    </button>
                    <button
                      type="button"
                      className="btn-ghost w-full justify-start"
                      onClick={() => navigate({ to: "/projects/$projectId/exports", params: { projectId: p.id } })}
                    >
                      <Download className="size-4" /> Export
                    </button>
                    {p.status === "active" ? (
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
                    <button
                      type="button"
                      className="btn-ghost w-full justify-start text-red-500"
                      onClick={() => setConfirm("trash")}
                    >
                      <Trash2 className="size-4" /> Move to trash
                    </button>
                  </>
                )}
                {filter === "trash" && (
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
            )}
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
