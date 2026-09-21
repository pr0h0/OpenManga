import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useNavigate, useParams } from "@tanstack/react-router";
import {
  BookText,
  Clapperboard,
  Cpu,
  Download,
  FileText,
  Globe2,
  Images,
  LayoutDashboard,
  LayoutGrid,
  Mic,
  PiggyBank,
  ScanEye,
  Search,
  Settings,
  Users,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { get } from "../../api/client.ts";
import { qk, useProjectEvents } from "../../api/hooks.ts";
import type { ProjectOverview } from "../../api/types.ts";
import { ErrorBox, Spinner } from "../../components/ui.tsx";
import { FloatingBatches } from "../generation/BatchStatus.tsx";

export function useProjectId() {
  return useParams({ strict: false }).projectId as string;
}

export function useProject() {
  const projectId = useProjectId();
  return useQuery({
    queryKey: qk.project(projectId),
    queryFn: () => get<ProjectOverview>(`/projects/${projectId}`),
    enabled: Boolean(projectId),
  });
}

const NAV = [
  { to: "/projects/$projectId", label: "Overview", icon: LayoutDashboard, exact: true },
  { to: "/projects/$projectId/story", label: "Story", icon: BookText },
  { to: "/projects/$projectId/cast", label: "Cast", icon: Users },
  { to: "/projects/$projectId/world", label: "World", icon: Globe2 },
  { to: "/projects/$projectId/chapters", label: "Chapters", icon: FileText },
  { to: "/projects/$projectId/pages", label: "Pages", icon: LayoutGrid },
  { to: "/projects/$projectId/generation", label: "Generation", icon: Cpu },
  { to: "/projects/$projectId/narration", label: "Narration", icon: Mic },
  { to: "/projects/$projectId/describe", label: "Describe", icon: ScanEye },
  { to: "/projects/$projectId/assets", label: "Assets", icon: Images },
  { to: "/projects/$projectId/exports", label: "Exports", icon: Download },
  { to: "/projects/$projectId/usage", label: "Cost", icon: PiggyBank },
  { to: "/projects/$projectId/settings", label: "Settings", icon: Settings },
] as const;

/** Film projects call pages "Shots" and vertical ones "Strip": each page is one frame of a continuous column. */
const navLabel = (label: string, format: string | undefined) =>
  label !== "Pages" ? label : format === "film" ? "Shots" : format === "vertical" ? "Strip" : label;

type SearchResult = {
  characters: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  props: { id: string; name: string }[];
  chapters: { id: string; title: string; order: number }[];
  panels: { id: string; pageId: string; storyBeat: string; pageOrder: number; order: number }[];
  dialogue: { id: string; text: string; pageId: string; panelId: string | null; pageOrder: number }[];
};

function ProjectSearch({ projectId }: { projectId: string }) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const { data, isFetching } = useQuery({
    queryKey: ["search", projectId, debounced],
    queryFn: () => get<SearchResult>(`/projects/${projectId}/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length > 0,
  });
  const go = (to: string, params: Record<string, string>, search?: Record<string, string>) => {
    setOpen(false);
    setQ("");
    navigate({ to, params: { projectId, ...params }, search } as never);
  };
  const total = data
    ? data.characters.length +
      data.locations.length +
      data.props.length +
      data.chapters.length +
      data.panels.length +
      data.dialogue.length
    : 0;
  return (
    <div ref={box} className="relative px-2 pb-2">
      <div className="relative">
        <Search className="muted absolute top-2 left-2 size-4" />
        <input
          className="input pl-8"
          placeholder="Search project…"
          value={q}
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          aria-label="Search project"
        />
      </div>
      {open && debounced && (
        <div className="card absolute top-full right-2 left-2 z-30 mt-1 max-h-96 overflow-y-auto p-1 text-sm shadow-xl">
          {isFetching && (
            <div className="muted flex items-center gap-2 p-2">
              <Spinner /> Searching…
            </div>
          )}
          {data && total === 0 && <div className="muted p-2">No matches</div>}
          {data?.characters.map((r) => (
            <button
              key={r.id}
              type="button"
              className="btn-ghost w-full justify-start"
              onClick={() => go("/projects/$projectId/cast/$characterId", { characterId: r.id })}
            >
              👤 {r.name}
            </button>
          ))}
          {data?.locations.map((r) => (
            <button
              key={r.id}
              type="button"
              className="btn-ghost w-full justify-start"
              onClick={() => go("/projects/$projectId/world/locations/$entityId", { entityId: r.id })}
            >
              📍 {r.name}
            </button>
          ))}
          {data?.props.map((r) => (
            <button
              key={r.id}
              type="button"
              className="btn-ghost w-full justify-start"
              onClick={() => go("/projects/$projectId/world/props/$entityId", { entityId: r.id })}
            >
              🗡️ {r.name}
            </button>
          ))}
          {data?.chapters.map((r) => (
            <button
              key={r.id}
              type="button"
              className="btn-ghost w-full justify-start"
              onClick={() => go("/projects/$projectId/chapters/$chapterId", { chapterId: r.id })}
            >
              📄 Ch. {r.order} {r.title}
            </button>
          ))}
          {data?.panels.map((r) => (
            <button
              key={r.id}
              type="button"
              className="btn-ghost w-full justify-start truncate"
              onClick={() => go("/projects/$projectId/pages/$pageId", { pageId: r.pageId }, { panelId: r.id })}
            >
              🖼️ p{r.pageOrder}·{r.order} {r.storyBeat}
            </button>
          ))}
          {data?.dialogue.map((r) => (
            <button
              key={r.id}
              type="button"
              className="btn-ghost w-full justify-start truncate"
              onClick={() =>
                go("/projects/$projectId/pages/$pageId", { pageId: r.pageId }, r.panelId ? { panelId: r.panelId } : {})
              }
            >
              💬 “{r.text}”
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function ProjectLayout() {
  const projectId = useProjectId();
  const { data, error, isLoading, refetch } = useProject();
  useProjectEvents(projectId);
  if (isLoading)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  if (error)
    return (
      <div className="p-6">
        <ErrorBox error={error} onRetry={() => refetch()} />
      </div>
    );
  const p = data!.project;
  return (
    <div className="flex h-full">
      <aside
        className="hidden w-56 shrink-0 flex-col border-r border-[var(--border)] bg-[var(--panel)] md:flex"
        aria-label="Project navigation"
      >
        <div className="px-4 pt-4 pb-2">
          <Link to="/" className="muted text-xs hover:underline">
            ← All projects
          </Link>
          <div className="mt-1 flex items-center gap-2">
            <Clapperboard className="size-4 shrink-0 text-accent-500" />
            <div className="truncate font-semibold" title={p.title}>
              {p.title}
            </div>
          </div>
          <div className="muted text-xs capitalize">
            {p.projectType.replace("_", " ")} · {p.readingDirection.toUpperCase()}
          </div>
        </div>
        <ProjectSearch projectId={projectId} />
        <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-4">
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              params={{ projectId }}
              activeOptions={{ exact: "exact" in n }}
              className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm muted hover:bg-[var(--panel-2)] hover:text-[var(--text)]"
              activeProps={{ className: "!bg-accent-600/15 !text-[var(--text)] font-medium" }}
            >
              <n.icon className="size-4" /> {navLabel(n.label, p.settings.format)}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <nav
          className="flex gap-1 overflow-x-auto border-b border-[var(--border)] bg-[var(--panel)] px-2 py-1 md:hidden"
          aria-label="Project navigation"
        >
          {NAV.map((n) => (
            <Link
              key={n.to}
              to={n.to}
              params={{ projectId }}
              activeOptions={{ exact: "exact" in n }}
              className="btn-ghost shrink-0 text-xs"
              activeProps={{ className: "bg-[var(--panel-2)]" }}
            >
              {navLabel(n.label, p.settings.format)}
            </Link>
          ))}
        </nav>
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
        <FloatingBatches projectId={projectId} />
      </div>
    </div>
  );
}
