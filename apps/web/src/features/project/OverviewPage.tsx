import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { CheckCircle2, Circle, Download, ImagePlus, MonitorPlay, Share2, Users } from "lucide-react";
import { useEffect, useState } from "react";
import { get, patch, post } from "../../api/client.ts";
import { qk } from "../../api/hooks.ts";
import type { CastCard, JobListItem, ProjectOverview } from "../../api/types.ts";
import {
  AssetImage,
  ErrorBox,
  Field,
  fmt,
  KeyValue,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
  toast,
} from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { MembersDialog } from "./MembersDialog.tsx";
import { ProductionRunCard } from "./ProductionRun.tsx";
import { useProject, useProjectId } from "./ProjectLayout.tsx";
import { ShareDialog } from "./ShareDialog.tsx";

export function OverviewPage() {
  const projectId = useProjectId();
  const { data } = useProject();
  const jobs = useQuery({
    queryKey: [...qk.generations(projectId), "recent"],
    queryFn: () => get<{ jobs: JobListItem[] }>(`/projects/${projectId}/generations?limit=8`),
  });
  const cast = useQuery({
    queryKey: qk.cast(projectId),
    queryFn: () => get<{ characters: CastCard[] }>(`/projects/${projectId}/characters`),
  });
  const [coverOpen, setCoverOpen] = useState(false);
  const [thumbOpen, setThumbOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [membersOpen, setMembersOpen] = useState(false);
  if (!data) return null;
  const { project: p, counts, style } = data;
  const c = counts as Record<string, number>;
  const approvedCast =
    cast.data?.characters.filter((ch) => ch.referenceStatus === "approved" || ch.referenceStatus === "locked").length ??
    0;
  const steps: { done: boolean; label: string; to: string; hint: string }[] = [
    {
      done: (c.storyRevisions ?? 0) > 0,
      label: "Add your story",
      to: "/projects/$projectId/story",
      hint: "Paste story, chapter, outline, screenplay or idea",
    },
    {
      done: (c.characters ?? 0) > 0,
      label: "Analyze & apply cast/world",
      to: "/projects/$projectId/story",
      hint: "The text model extracts characters, locations and chapters",
    },
    {
      done: approvedCast > 0 && approvedCast === (cast.data?.characters.length ?? -1),
      label: "Design and approve character references",
      to: "/projects/$projectId/cast",
      hint: `${approvedCast}/${cast.data?.characters.length ?? 0} characters approved`,
    },
    {
      done: (c.pages ?? 0) > 0,
      label: "Plan chapters into scenes, pages and panels",
      to: "/projects/$projectId/chapters",
      hint: `${c.chapters ?? 0} chapters · ${c.pages ?? 0} pages`,
    },
    {
      done: (c.panelsWithArt ?? 0) > 0,
      label: "Review panels and generate artwork",
      to: "/projects/$projectId/pages",
      hint: `${c.panelsWithArt ?? 0}/${c.panels ?? 0} panels have artwork`,
    },
    {
      done: (c.narrationSegments ?? 0) > 0,
      label: "Letter pages and write narration",
      to: "/projects/$projectId/narration",
      hint: `${c.narrationSegments ?? 0} narration segments`,
    },
    {
      done: false,
      label: "Export",
      to: "/projects/$projectId/exports",
      hint: "PNG, PDF, webtoon strip, narration, project package",
    },
  ];
  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <PageHeader
        title={p.title}
        subtitle={p.description || "No description"}
        actions={
          <>
            <button type="button" className="btn-secondary" onClick={() => setMembersOpen(true)}>
              <Users className="size-4" /> Members
            </button>
            {(data.role === "owner" || data.role === "admin") && (
              <button type="button" className="btn-secondary" onClick={() => setShareOpen(true)}>
                <Share2 className="size-4" /> Share
              </button>
            )}
            <button type="button" className="btn-secondary" onClick={() => setThumbOpen(true)}>
              <MonitorPlay className="size-4" /> Generate thumbnail
            </button>
            <button type="button" className="btn-secondary" onClick={() => setCoverOpen(true)}>
              <ImagePlus className="size-4" /> Generate cover
            </button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ["Chapters", c.chapters],
              ["Pages", c.pages],
              ["Panels", `${c.panelsWithArt}/${c.panels}`],
              ["Characters", c.characters],
              ["Locations", c.locations],
              ["Generations", c.generations],
              ["Active jobs", c.activeJobs],
              ["API spend", fmt.usd(c.spendUsd)],
            ].map(([k, v]) => (
              <div key={String(k)} className="card p-3">
                <div className="muted text-xs">{k}</div>
                <div className="text-lg font-semibold">{v ?? 0}</div>
              </div>
            ))}
          </div>
          {data.disk && <DiskUsage disk={data.disk} />}
          <ReadinessCard
            projectId={projectId}
            budgetUsd={p.settings.budgetUsd ?? null}
            spentUsd={c.spendUsd ?? 0}
            unpricedCalls={c.unpricedCalls ?? 0}
          />
          <div className="card p-4">
            <h2 className="mb-3 font-medium">Production pipeline</h2>
            <ol className="space-y-2">
              {steps.map((s) => (
                <li key={s.label}>
                  <Link
                    to={s.to}
                    params={{ projectId }}
                    className="flex items-center gap-3 rounded-lg p-2 hover:bg-[var(--panel-2)]"
                  >
                    {s.done ? (
                      <CheckCircle2 className="size-5 text-emerald-500" />
                    ) : (
                      <Circle className="muted size-5" />
                    )}
                    <div>
                      <div className="text-sm font-medium">{s.label}</div>
                      <div className="muted text-xs">{s.hint}</div>
                    </div>
                  </Link>
                </li>
              ))}
            </ol>
          </div>
          <div className="card p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-medium">Recent generations</h2>
              <Link
                to="/projects/$projectId/generation"
                params={{ projectId }}
                className="text-sm text-accent-500 hover:underline"
              >
                View all
              </Link>
            </div>
            {jobs.isLoading && <Spinner />}
            {jobs.data && !jobs.data.jobs.length && <p className="muted text-sm">No generations yet.</p>}
            <ul className="divide-y divide-[var(--border)]">
              {jobs.data?.jobs.map((j) => (
                <li key={j.id}>
                  <Link
                    to="/projects/$projectId/generation/$jobId"
                    params={{ projectId, jobId: j.id }}
                    className="flex items-center gap-3 py-2 text-sm hover:underline"
                  >
                    <AssetImage assetId={j.outputAssetId} alt="" className="size-10 rounded" />
                    <span className="flex-1 capitalize">{j.kind.replace(/_/g, " ")}</span>
                    <span className="muted text-xs">
                      {fmt.usd(j.costUsd)} · {fmt.ago(j.createdAt)}
                    </span>
                    <StatusChip status={j.status} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <aside className="space-y-4">
          <ProductionRunCard projectId={projectId} format={p.settings.format} />
          {p.settings.thumbnail && <ThumbnailCard projectId={projectId} saved={p.settings.thumbnail} />}
          <div className="card overflow-hidden">
            <AssetImage assetId={p.coverAssetId} variant={null} alt="Cover artwork" className="aspect-[2/3] w-full" />
            <div className="muted p-2 text-xs">
              Cover artwork is generated without text; titles are composited on export.
            </div>
          </div>
          <div className="card p-4">
            <h3 className="mb-2 text-sm font-medium">Project</h3>
            <KeyValue
              items={[
                [
                  "Type",
                  <span key="t" className="capitalize">
                    {p.projectType.replace("_", " ")}
                  </span>,
                ],
                ["Reading", p.readingDirection.toUpperCase()],
                ["Color", p.colorMode.replace("_", " ")],
                ["Style", style?.preset?.name ?? "Custom"],
                ["Language", p.language],
                ["Page size", `${p.settings.pageWidth}×${p.settings.pageHeight}`],
                ["Image quality", p.settings.imageQuality],
                ["Created", fmt.date(p.createdAt)],
              ]}
            />
          </div>
        </aside>
      </div>
      <CoverModal
        open={coverOpen}
        onClose={() => setCoverOpen(false)}
        projectId={projectId}
        title={p.title}
        cast={cast.data?.characters ?? []}
      />
      <ShareDialog projectId={projectId} open={shareOpen} onClose={() => setShareOpen(false)} />
      <MembersDialog projectId={projectId} open={membersOpen} onClose={() => setMembersOpen(false)} />
      <CoverModal
        thumbnail
        open={thumbOpen}
        onClose={() => setThumbOpen(false)}
        projectId={projectId}
        title={p.settings.thumbnail?.title || p.title}
        cast={cast.data?.characters ?? []}
      />
    </div>
  );
}

type Thumbnail = { assetId: string; title: string; subtitle: string; side: "left" | "right" };

/** The video thumbnail with its headline composited live: rewording it redraws nothing and costs nothing. */
function ThumbnailCard({ projectId, saved }: { projectId: string; saved: Thumbnail }) {
  const qc = useQueryClient();
  const [t, setT] = useState(saved);
  const [shown, setShown] = useState(saved);
  // Keyed on the values: a refetch of the project returns a new but equal object, which must not wipe typing.
  useEffect(() => {
    setT(saved);
    setShown(saved);
  }, [saved.assetId, saved.title, saved.subtitle, saved.side]);
  // The preview follows typing after a pause, not on every key.
  useEffect(() => {
    const h = setTimeout(() => setShown(t), 500);
    return () => clearTimeout(h);
  }, [t]);
  const url = (download: boolean) =>
    `/api/projects/${projectId}/thumbnail.png?${new URLSearchParams({
      title: shown.title,
      subtitle: shown.subtitle,
      side: shown.side,
      v: saved.assetId,
      ...(download ? { download: "1" } : { width: "640" }),
    })}`;
  const dirty = t.title !== saved.title || t.subtitle !== saved.subtitle || t.side !== saved.side;
  return (
    <div className="card overflow-hidden">
      <img src={url(false)} alt="Video thumbnail" className="aspect-video w-full bg-[var(--panel-2)] object-cover" />
      <div className="space-y-2 p-2">
        <input
          className="input"
          aria-label="Headline"
          placeholder="Headline"
          value={t.title}
          maxLength={120}
          onChange={(e) => setT({ ...t, title: e.target.value })}
        />
        <input
          className="input"
          aria-label="Subtitle"
          placeholder="Subtitle (optional)"
          value={t.subtitle}
          maxLength={120}
          onChange={(e) => setT({ ...t, subtitle: e.target.value })}
        />
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            className="input w-auto"
            aria-label="Headline side"
            value={t.side}
            onChange={(e) => setT({ ...t, side: e.target.value as Thumbnail["side"] })}
          >
            <option value="left">Headline left</option>
            <option value="right">Headline right</option>
          </select>
          {dirty && (
            <button
              type="button"
              className="btn-secondary"
              onClick={async () => {
                try {
                  await patch(`/projects/${projectId}`, { settings: { thumbnail: t } });
                  await qc.invalidateQueries({ queryKey: qk.project(projectId), exact: true });
                } catch (e) {
                  toast.error(e);
                }
              }}
            >
              Save
            </button>
          )}
          <a className="btn-secondary ml-auto" href={url(true)}>
            <Download className="size-4" /> 1280×720 PNG
          </a>
        </div>
      </div>
    </div>
  );
}

function CoverModal({
  thumbnail,
  open,
  onClose,
  projectId,
  title,
  cast,
}: {
  /** A 16:9 video thumbnail instead of the portrait cover. */
  thumbnail?: boolean;
  open: boolean;
  onClose: () => void;
  projectId: string;
  title: string;
  cast: CastCard[];
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ title, subtitle: "", composition: "", characterIds: [] as string[] });
  const [side, setSide] = useState<"left" | "right">("left");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const aiImage = useAiBody("image");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={thumbnail ? "Generate video thumbnail" : "Generate cover"}
      footer={
        <>
          <AiChip cap="image" className="mr-auto" />
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await post(`/projects/${projectId}/${thumbnail ? "thumbnail" : "cover"}`, {
                  ...aiImage(),
                  ...form,
                  ...(thumbnail ? { side } : {}),
                });
                await qc.invalidateQueries({ queryKey: qk.generations(projectId) });
                toast.info(thumbnail ? "Thumbnail generation queued" : "Cover generation queued");
                onClose();
              } catch (e) {
                setError(e);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy && <Spinner />} Generate
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {thumbnail && (
          <Field label="Headline side (the art keeps that side clear)">
            <select className="input" value={side} onChange={(e) => setSide(e.target.value as "left" | "right")}>
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </Field>
        )}
        <Field
          label={
            thumbnail
              ? "Headline (composited by the app, editable later for free)"
              : "Title (composited by the app, not drawn by the model)"
          }
        >
          <input className="input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <Field label="Subtitle">
          <input
            className="input"
            value={form.subtitle}
            onChange={(e) => setForm({ ...form, subtitle: e.target.value })}
          />
        </Field>
        <Field label="Composition request">
          <textarea
            className="input min-h-16"
            value={form.composition}
            onChange={(e) => setForm({ ...form, composition: e.target.value })}
            placeholder="Protagonist in the foreground, rival silhouetted behind, rainy city at night"
          />
        </Field>
        <fieldset>
          <legend className="label">Characters (approved references are attached as small derivatives)</legend>
          <div className="flex flex-wrap gap-2">
            {cast.map((ch) => (
              <label key={ch.id} className="chip cursor-pointer bg-[var(--panel-2)] px-2 py-1 text-xs">
                <input
                  type="checkbox"
                  checked={form.characterIds.includes(ch.id)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      characterIds: e.target.checked
                        ? [...form.characterIds, ch.id]
                        : form.characterIds.filter((x) => x !== ch.id),
                    })
                  }
                />
                {ch.name}
              </label>
            ))}
          </div>
        </fieldset>
        <ErrorBox error={error} />
      </div>
    </Modal>
  );
}

type ReadinessIssue = {
  code: string;
  severity: "block" | "info";
  chapterLabel: string | null;
  message: string;
  area: string;
};

/** Export readiness + budget at a glance: what an export would ship incomplete right now. */
function ReadinessCard({
  projectId,
  budgetUsd,
  spentUsd,
  unpricedCalls,
}: {
  projectId: string;
  budgetUsd: number | null;
  spentUsd: number;
  unpricedCalls: number;
}) {
  const q = useQuery({
    queryKey: ["readiness", projectId, null, ""],
    queryFn: () =>
      get<{
        issues: ReadinessIssue[];
        language: string;
        credentials: { text: boolean; image: boolean; mockMode: boolean };
      }>(`/projects/${projectId}/readiness`),
  });
  const blocking = (q.data?.issues ?? []).filter((i) => i.severity === "block");
  return (
    <div className="card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-medium">Export readiness</h2>
        {budgetUsd !== null && (
          <span className={spentUsd >= budgetUsd ? "chip bg-red-500/15 text-red-600" : "chip"}>
            Budget {fmt.usd(spentUsd)} / {fmt.usd(budgetUsd)}
          </span>
        )}
        <Link to="/projects/$projectId/exports" params={{ projectId }} className="btn-ghost text-xs">
          Exports
        </Link>
      </div>
      {unpricedCalls > 0 && (
        <p className="muted mb-2 text-sm">
          {unpricedCalls} call{unpricedCalls === 1 ? "" : "s"} could not be priced (no rate snapshot for that model), so
          spend is understated and the budget cap may not trip.
        </p>
      )}
      {q.data?.credentials &&
        !q.data.credentials.mockMode &&
        !(q.data.credentials.text && q.data.credentials.image) && (
          <p className="mb-2 rounded-md bg-amber-500/10 p-2 text-sm text-amber-700 dark:text-amber-300">
            No usable API key for {!q.data.credentials.image ? "image" : "text"} generation. This server has no shared
            keys —{" "}
            <Link to="/account" className="underline">
              add your own
            </Link>{" "}
            before generating.
          </p>
        )}
      {q.isLoading ? (
        <Spinner />
      ) : !blocking.length ? (
        <p className="text-sm text-emerald-600">Nothing missing — every chapter has artwork, narration and audio.</p>
      ) : (
        <ul className="max-h-48 list-disc space-y-0.5 overflow-auto pl-5 text-sm text-amber-700 dark:text-amber-300">
          {blocking.map((i) => (
            <li key={`${i.code}-${i.chapterLabel}`}>
              {i.chapterLabel ? `${i.chapterLabel}: ` : ""}
              {i.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** What the project's files take on disk: every stored original and derived copy, including the trash. */
function DiskUsage({ disk }: { disk: NonNullable<ProjectOverview["disk"]> }) {
  const parts: [string, number][] = [
    ["Artwork", disk.byCategory.artwork],
    ["References", disk.byCategory.references],
    ["Narration audio", disk.byCategory.narration],
    ["Exports", disk.byCategory.exports],
    ["Video render cache", disk.byCategory.renderCache],
    ["Previews and thumbnails", disk.byCategory.derived],
  ];
  return (
    <div className="card flex flex-wrap items-baseline gap-x-4 gap-y-1 p-3">
      <div>
        <span className="muted text-xs">On disk </span>
        <span className="text-lg font-semibold">{fmt.bytes(disk.totalBytes)}</span>
      </div>
      <div className="muted flex flex-wrap gap-x-3 gap-y-1 text-xs">
        {parts
          .filter(([, b]) => b > 0)
          .map(([label, b]) => (
            <span key={label}>
              {label} {fmt.bytes(b)}
            </span>
          ))}
        {disk.trashBytes > 0 && <span>· of which in trash {fmt.bytes(disk.trashBytes)}</span>}
      </div>
    </div>
  );
}
