import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { BookCopy, Link2Off, Plus, RefreshCw, Scissors, Search } from "lucide-react";
import { type FormEvent, useState } from "react";
import { del, get, patch, post } from "../../api/client.ts";
import {
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  fmt,
  PageHeader,
  Spinner,
  StatusChip,
  toast,
} from "../../components/ui.tsx";

type SeriesItem = { id: string; title: string; description: string; episodes: number; libraryProjectId: string };
type Episode = {
  id: string;
  title: string;
  episodeNumber: number;
  status: string;
  chapters: number;
  panels: number;
  panelsDrawn: number;
  spendUsd: number;
  exports: number;
  openComments: number;
  behind: number;
};
type Dashboard = {
  series: SeriesItem & { channelProfileId: string | null };
  library: { projectId: string; characters: number; locations: number; props: number; facts: number };
  episodes: Episode[];
  totals: {
    episodes: number;
    panels: number;
    panelsDrawn: number;
    spendUsd: number;
    exports: number;
    openComments: number;
    behind: number;
  };
};
type Profile = { id: string; name: string };

const useProfiles = () =>
  useQuery({ queryKey: ["channel-profiles"], queryFn: () => get<{ profiles: Profile[] }>("/channel-profiles") });

/** Every series of the user's, and a form to start one. */
export function SeriesListPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["series"], queryFn: () => get<{ series: SeriesItem[] }>("/series") });
  const profiles = useProfiles();
  const [title, setTitle] = useState("");
  const [profileId, setProfileId] = useState("");
  const [busy, setBusy] = useState(false);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post("/series", { title: title.trim(), channelProfileId: profileId || null });
      setTitle("");
      await qc.invalidateQueries({ queryKey: ["series"] });
      toast.success("Series created");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader
        title="Series"
        subtitle="Episodes that share one library: cast, places, props, style and story bible, and a channel profile."
      />
      <form className="card mb-6 flex flex-wrap items-end gap-3 p-4" onSubmit={(e) => void create(e)}>
        <Field label="New series">
          <input
            className="input w-72 max-w-full"
            placeholder="Title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Channel profile">
          <select className="input" value={profileId} onChange={(e) => setProfileId(e.target.value)}>
            <option value="">None</option>
            {profiles.data?.profiles.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </Field>
        <button type="submit" className="btn-primary" disabled={busy || !title.trim()}>
          {busy ? <Spinner /> : <Plus className="size-4" />} Create
        </button>
      </form>
      <ErrorBox error={q.error} />
      {q.isLoading && <Spinner />}
      {q.data && !q.data.series.length && (
        <EmptyState title="No series yet">Create one, then add episodes or adopt projects you already have.</EmptyState>
      )}
      <ul className="grid gap-3 sm:grid-cols-2">
        {q.data?.series.map((s) => (
          <li key={s.id}>
            <Link
              to="/series/$seriesId"
              params={{ seriesId: s.id }}
              className="card block p-4 hover:bg-[var(--panel-2)]"
            >
              <div className="font-medium">{s.title}</div>
              <div className="muted text-sm">
                {s.episodes} episode{s.episodes === 1 ? "" : "s"}
                {s.description && ` · ${s.description}`}
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One series: its episodes at a glance, the shared library, and the tools to grow and sync it. */
export function SeriesDetailPage() {
  const { seriesId } = useParams({ strict: false }) as { seriesId: string };
  const qc = useQueryClient();
  const key = ["series", seriesId] as const;
  const q = useQuery({ queryKey: key, queryFn: () => get<Dashboard>(`/series/${seriesId}`) });
  const [busy, setBusy] = useState(false);
  const [detach, setDetach] = useState<Episode | null>(null);
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: key });
      if (done) toast.success(done);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  if (q.isLoading) return <Spinner className="m-6" />;
  if (q.error || !q.data) return <ErrorBox error={q.error} />;
  const { series: s, library: lib, episodes, totals } = q.data;
  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <PageHeader
        title={s.title}
        subtitle={s.description || "A series of episodes sharing one library."}
        actions={
          <>
            <button
              type="button"
              className="btn-secondary"
              disabled={busy || !episodes.length}
              onClick={() => void run(() => post(`/series/${s.id}/sync`, {}), "Episodes synced with the library")}
            >
              <RefreshCw className="size-4" /> Sync all
            </button>
            <SeriesSettings dashboard={q.data} onSaved={() => void qc.invalidateQueries({ queryKey: key })} />
          </>
        }
      />

      <section aria-label="Totals" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {[
          ["Episodes", totals.episodes],
          ["Panels drawn", `${totals.panelsDrawn} / ${totals.panels}`],
          ["Spent", `$${totals.spendUsd.toFixed(2)}`],
          ["Exports", totals.exports],
          ["Open comments", totals.openComments],
        ].map(([label, value]) => (
          <div key={label} className="card p-3">
            <div className="muted text-xs">{label}</div>
            <div className="text-lg font-semibold tabular-nums">{value}</div>
          </div>
        ))}
      </section>

      <section aria-label="Library" className="card space-y-2 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <BookCopy className="size-4" />
          <h2 className="font-medium">Library</h2>
          <span className="muted text-sm">
            {lib.characters} characters · {lib.locations} places · {lib.props} props · {lib.facts} bible facts
          </span>
        </div>
        <p className="muted text-sm">
          Edit the shared cast and world here; episodes follow it when synced, pointing at the same reference images.
        </p>
        <div className="flex flex-wrap gap-2 text-sm">
          {(
            [
              ["Cast", "/projects/$projectId/cast"],
              ["World and style", "/projects/$projectId/world"],
              ["Bible", "/projects/$projectId/bible"],
            ] as const
          ).map(([label, to]) => (
            <Link key={label} className="btn-secondary" to={to} params={{ projectId: lib.projectId }}>
              {label}
            </Link>
          ))}
        </div>
      </section>

      <section aria-label="Episodes" className="space-y-2">
        <h2 className="font-medium">Episodes</h2>
        {!episodes.length && (
          <p className="muted text-sm">No episodes yet: add one, adopt a project, or split a story.</p>
        )}
        {episodes.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
            <table className="w-full text-sm">
              <thead className="muted text-left text-xs">
                <tr className="[&>th]:px-3 [&>th]:py-2">
                  <th>#</th>
                  <th>Episode</th>
                  <th>Status</th>
                  <th className="text-right">Drawn</th>
                  <th className="text-right">Spent</th>
                  <th className="text-right">Exports</th>
                  <th className="text-right">Comments</th>
                  <th>Library</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {episodes.map((e) => (
                  <tr key={e.id} className="[&>td]:px-3 [&>td]:py-2">
                    <td className="tabular-nums">{e.episodeNumber}</td>
                    <td>
                      <Link className="link" to="/projects/$projectId" params={{ projectId: e.id }}>
                        {e.title}
                      </Link>
                      <div className="muted text-xs">{e.chapters} chapters</div>
                    </td>
                    <td>
                      <StatusChip status={e.status} />
                    </td>
                    <td className="text-right tabular-nums">
                      {e.panelsDrawn} / {e.panels}
                    </td>
                    <td className="text-right tabular-nums">${e.spendUsd.toFixed(2)}</td>
                    <td className="text-right tabular-nums">{e.exports}</td>
                    <td className="text-right tabular-nums">{e.openComments}</td>
                    <td>
                      {e.behind ? (
                        <button
                          type="button"
                          className="chip bg-amber-500/15 text-amber-700 dark:text-amber-300"
                          title="Library entries, style or facts this episode has not taken yet. Click to sync it."
                          disabled={busy}
                          onClick={() =>
                            void run(() => post(`/series/${s.id}/sync`, { projectId: e.id }), "Episode synced")
                          }
                        >
                          {e.behind} behind · sync
                        </button>
                      ) : (
                        <span className="chip bg-emerald-500/15 text-emerald-600">in step</span>
                      )}
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn-ghost p-1"
                        aria-label={`Detach ${e.title}`}
                        title="Take it out of the series"
                        onClick={() => setDetach(e)}
                      >
                        <Link2Off className="size-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <AddEpisode seriesId={s.id} onDone={() => void qc.invalidateQueries({ queryKey: key })} />
        <AdoptProject seriesId={s.id} onDone={() => void qc.invalidateQueries({ queryKey: key })} />
        <SplitStory seriesId={s.id} onDone={() => void qc.invalidateQueries({ queryKey: key })} />
        <Appearances seriesId={s.id} libraryId={lib.projectId} />
      </div>

      <ConfirmDialog
        open={Boolean(detach)}
        title={`Detach "${detach?.title}"?`}
        confirmLabel="Detach"
        onClose={() => setDetach(null)}
        onConfirm={() =>
          void run(
            () => post(`/series/${s.id}/episodes/${detach!.id}/detach`, {}).then(() => setDetach(null)),
            "Episode detached",
          )
        }
      >
        It leaves the series and keeps its cast and world as its own: they stop following the library.
      </ConfirmDialog>
    </div>
  );
}

function SeriesSettings({ dashboard, onSaved }: { dashboard: Dashboard; onSaved: () => void }) {
  const profiles = useProfiles();
  const s = dashboard.series;
  const [confirmDelete, setConfirmDelete] = useState(false);
  return (
    <>
      <select
        className="input w-48"
        aria-label="Channel profile"
        value={s.channelProfileId ?? ""}
        onChange={(e) =>
          void patch(`/series/${s.id}`, { channelProfileId: e.target.value || null })
            .then(onSaved)
            .catch(toast.error)
        }
      >
        <option value="">No channel profile</option>
        {profiles.data?.profiles.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {!dashboard.episodes.length && (
        <button type="button" className="btn-ghost text-red-600" onClick={() => setConfirmDelete(true)}>
          Delete
        </button>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title={`Delete "${s.title}"?`}
        confirmLabel="Delete series"
        danger
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          void del(`/series/${s.id}`)
            .then(() => {
              window.location.assign(`${import.meta.env.BASE_URL}series`);
            })
            .catch(toast.error)
        }
      >
        The library project goes to the trash.
      </ConfirmDialog>
    </>
  );
}

function AddEpisode({ seriesId, onDone }: { seriesId: string; onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [story, setStory] = useState("");
  const [busy, setBusy] = useState(false);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await post(`/series/${seriesId}/episodes`, {
        title: title.trim(),
        ...(story.trim() ? { story: { content: story, inputKind: "story" } } : {}),
      });
      setTitle("");
      setStory("");
      onDone();
      toast.success("Episode added, linked to the library");
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form aria-label="Add episode" className="card space-y-2 p-4" onSubmit={(e) => void add(e)}>
      <h3 className="font-medium">Add an episode</h3>
      <Field label="Title">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
      </Field>
      <Field label="Story (optional)">
        <textarea className="input min-h-20 text-sm" value={story} onChange={(e) => setStory(e.target.value)} />
      </Field>
      <button type="submit" className="btn-primary" disabled={busy || !title.trim()}>
        {busy ? <Spinner /> : <Plus className="size-4" />} Add episode
      </button>
    </form>
  );
}

function AdoptProject({ seriesId, onDone }: { seriesId: string; onDone: () => void }) {
  const projects = useQuery({
    queryKey: ["projects", "adoptable"],
    queryFn: () =>
      get<{ projects: { id: string; title: string; seriesId: string | null; role: string }[] }>("/projects"),
  });
  const [projectId, setProjectId] = useState("");
  const [applyProfile, setApplyProfile] = useState(false);
  const [busy, setBusy] = useState(false);
  const free = projects.data?.projects.filter((p) => !p.seriesId && p.role === "owner") ?? [];
  const adopt = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await post<{ synced: { linked: number; created: number } }>(`/series/${seriesId}/adopt`, {
        projectId,
        applyProfile,
      });
      setProjectId("");
      onDone();
      toast.success(`Adopted: ${r.synced.linked} linked by name, ${r.synced.created} added from the library`);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form aria-label="Adopt project" className="card space-y-2 p-4" onSubmit={(e) => void adopt(e)}>
      <h3 className="font-medium">Adopt a project</h3>
      <p className="muted text-xs">
        It becomes the next episode. Its characters, places and props named like the library's become linked to them.
      </p>
      <select
        className="input"
        aria-label="Project to adopt"
        value={projectId}
        onChange={(e) => setProjectId(e.target.value)}
      >
        <option value="">Choose one of your projects…</option>
        {free.map((p) => (
          <option key={p.id} value={p.id}>
            {p.title}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={applyProfile} onChange={(e) => setApplyProfile(e.target.checked)} />
        Also apply the series' channel profile
      </label>
      <button type="submit" className="btn-secondary" disabled={busy || !projectId}>
        Adopt
      </button>
    </form>
  );
}

function SplitStory({ seriesId, onDone }: { seriesId: string; onDone: () => void }) {
  const [story, setStory] = useState("");
  const [per, setPer] = useState(3);
  const [preview, setPreview] = useState<{ title: string; chapters: number; characters: number }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (confirm: boolean) => {
    setBusy(true);
    try {
      const r = await post<{ episodes: { title: string; chapters: number; characters: number }[] }>(
        `/series/${seriesId}/split`,
        { story, perEpisode: per, confirm },
      );
      if (confirm) {
        setStory("");
        setPreview(null);
        onDone();
        toast.success(`${r.episodes.length} episodes created`);
      } else setPreview(r.episodes);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Split a story" className="card space-y-2 p-4">
      <h3 className="font-medium">Split a long story into episodes</h3>
      <textarea
        className="input min-h-24 text-sm"
        aria-label="Long story"
        placeholder="Paste the whole story; it is cut at its chapter headings."
        value={story}
        onChange={(e) => {
          setStory(e.target.value);
          setPreview(null);
        }}
      />
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Chapters per episode">
          <input
            className="input w-24"
            type="number"
            min={1}
            max={50}
            value={per}
            onChange={(e) => {
              setPer(Math.max(1, Number(e.target.value) || 1));
              setPreview(null);
            }}
          />
        </Field>
        <button type="button" className="btn-secondary" disabled={busy || !story.trim()} onClick={() => void go(false)}>
          <Scissors className="size-4" /> Preview
        </button>
        {preview && (
          <button type="button" className="btn-primary" disabled={busy} onClick={() => void go(true)}>
            Create {preview.length} episodes
          </button>
        )}
      </div>
      {preview && (
        <ol className="list-decimal space-y-0.5 pl-5 text-sm">
          {preview.map((p) => (
            <li key={p.title}>
              {p.title}{" "}
              <span className="muted text-xs">
                · {p.chapters ? `${p.chapters} chapters · ` : ""}
                {fmt.num(p.characters)} characters
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function Appearances({ seriesId, libraryId }: { seriesId: string; libraryId: string }) {
  const cast = useQuery({
    queryKey: ["project", libraryId, "characters"],
    queryFn: () => get<{ characters: { id: string; name: string }[] }>(`/projects/${libraryId}/characters`),
  });
  const [id, setId] = useState("");
  const q = useQuery({
    queryKey: ["series", seriesId, "appearances", id],
    enabled: Boolean(id),
    queryFn: () =>
      get<{
        episodes: {
          projectId: string;
          title: string;
          episodeNumber: number;
          panels: number;
          chapters: { id: string; order: number; title: string; panels: number }[];
        }[];
      }>(`/series/${seriesId}/appearances?kind=character&id=${id}`),
  });
  return (
    <section aria-label="Appearances" className="card space-y-2 p-4">
      <h3 className="flex items-center gap-2 font-medium">
        <Search className="size-4" /> Where a character appears
      </h3>
      <select className="input" aria-label="Library character" value={id} onChange={(e) => setId(e.target.value)}>
        <option value="">Choose a library character…</option>
        {cast.data?.characters.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      {q.isFetching && <Spinner />}
      <ErrorBox error={q.error} />
      {q.data && !q.data.episodes.length && <p className="muted text-sm">Not in any episode yet.</p>}
      <ul className="space-y-1.5 text-sm">
        {q.data?.episodes.map((e) => (
          <li key={e.projectId}>
            <span className="font-medium">
              {e.episodeNumber}. {e.title}
            </span>{" "}
            <span className="muted">· {e.panels} panels</span>
            <ul className="muted ml-4 text-xs">
              {e.chapters.map((ch) => (
                <li key={ch.id}>
                  <Link
                    className="link"
                    to="/projects/$projectId/storyboard"
                    params={{ projectId: e.projectId }}
                    search={{ chapterId: ch.id }}
                  >
                    Ch. {ch.order} {ch.title}
                  </Link>{" "}
                  · {ch.panels} panels
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </section>
  );
}
