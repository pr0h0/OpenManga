import type { ImageDescription } from "@openmanga/schemas";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Plus, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";
import { get, patch, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { LocationCard, ProjectStyleRow, PropCard, Reference, StylePresetRow } from "../../api/types.ts";
import {
  AssetImage,
  EmptyState,
  ErrorBox,
  fmt,
  Modal,
  PageHeader,
  SaveIndicator,
  Spinner,
  StatusChip,
  Tabs,
  toast,
  useAutosave,
} from "../../components/ui.tsx";
import { ReferencePanel } from "../cast/ReferencePanel.tsx";
import { useProject, useProjectId } from "../project/ProjectLayout.tsx";
import { DescribeImageButton } from "../vision/DescribeImageButton.tsx";

type Tab = "locations" | "props" | "style" | "notes";

export function WorldPage() {
  const [tab, setTab] = useState<Tab>("locations");
  return (
    <div className="p-6">
      <PageHeader title="World" subtitle="Recurring locations, props, art style and world notes." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "locations", label: "Locations" },
          { value: "props", label: "Props" },
          { value: "style", label: "Style" },
          { value: "notes", label: "World notes" },
        ]}
      />
      {tab === "locations" && <EntityGrid kind="locations" />}
      {tab === "props" && <EntityGrid kind="props" />}
      {tab === "style" && <StyleTab />}
      {tab === "notes" && <NotesTab />}
    </div>
  );
}

function EntityGrid({ kind }: { kind: "locations" | "props" }) {
  const projectId = useProjectId();
  const [trash, setTrash] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [summary, setSummary] = useState("");
  const baseKey = kind === "locations" ? qk.locations(projectId) : qk.props(projectId);
  const { data, error, isLoading, refetch } = useQuery({
    queryKey: [...baseKey, trash],
    queryFn: () =>
      get<Record<string, (LocationCard | PropCard)[]>>(`/projects/${projectId}/${kind}${trash ? "?trash=1" : ""}`),
  });
  const create = useAction(
    () => post(`/projects/${projectId}/${kind}`, { name: name.trim(), description: { summary } }),
    {
      invalidate: [baseKey],
      success: "Created",
      onSuccess: () => {
        setCreating(false);
        setName("");
        setSummary("");
      },
    },
  );
  const restore = useAction((id: string) => post(`/${kind}/${id}/restore`), {
    invalidate: [baseKey],
    success: "Restored",
  });
  const list = data?.[kind] ?? [];
  const singular = kind === "locations" ? "location" : "prop";
  return (
    <>
      <div className="mb-4 flex gap-2">
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
          <Plus className="size-4" /> New {singular}
        </button>
        <button type="button" className="btn-secondary" onClick={() => setTrash(!trash)}>
          {trash ? "Show active" : "Trash"}
        </button>
      </div>
      <ErrorBox error={error} onRetry={() => refetch()} />
      {isLoading && <Spinner className="size-6" />}
      {data && !list.length && (
        <EmptyState title={trash ? "Trash is empty" : `No ${kind} yet`}>
          {!trash &&
            "Story analysis creates recurring ones automatically. Only important recurring items need references."}
        </EmptyState>
      )}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
        {list.map((e) => (
          <div key={e.id} className="card overflow-hidden">
            <Link
              to={
                kind === "locations"
                  ? "/projects/$projectId/world/locations/$entityId"
                  : "/projects/$projectId/world/props/$entityId"
              }
              params={{ projectId, entityId: e.id }}
              className="block"
            >
              <AssetImage assetId={e.previewAssetId} alt={e.name} className="aspect-[4/3] w-full" />
              <div className="space-y-1 p-3">
                <div className="truncate font-medium">{e.name}</div>
                <div className="flex flex-wrap items-center gap-1 text-xs">
                  {e.currentVersion && (
                    <span className="muted">
                      v{e.currentVersion.versionNumber} {e.currentVersion.status}
                    </span>
                  )}
                  <StatusChip status={e.referenceStatus} label={`ref: ${e.referenceStatus}`} />
                  <span className="muted">{e.appearances} panels</span>
                </div>
              </div>
            </Link>
            {trash && (
              <button
                type="button"
                className="btn-secondary m-3 mt-0 w-[calc(100%-1.5rem)] text-xs"
                onClick={() => restore.mutate(e.id)}
              >
                <RotateCcw className="size-3" /> Restore
              </button>
            )}
          </div>
        ))}
      </div>
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title={`New ${singular}`}
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!name.trim() || create.isPending}
              onClick={() => create.mutate()}
            >
              Create
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <label className="block">
            <span className="label">Name</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">Summary</span>
            <textarea className="input min-h-20" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </label>
        </div>
      </Modal>
    </>
  );
}

type StyleState = {
  currentStyleId: string | null;
  versions: (ProjectStyleRow & { preset: StylePresetRow | null })[];
  references: Reference[];
};

/** Every definition field that reaches the prompt, in the order styleSection() renders them. */
const STYLE_FIELDS = [
  ["summary", "Summary"],
  ["lineTreatment", "Lines"],
  ["colorPolicy", "Color"],
  ["shading", "Shading"],
  ["detailLevel", "Detail"],
  ["faceRendering", "Faces"],
  ["backgroundRendering", "Backgrounds"],
  ["motionEffects", "Motion effects"],
  ["contrast", "Contrast"],
  ["screenTones", "Screentones"],
  ["lighting", "Lighting style"],
] as const;
type StyleField = (typeof STYLE_FIELDS)[number][0];

function StyleTab() {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const style = useQuery({
    queryKey: qk.style(projectId),
    queryFn: () => get<StyleState>(`/projects/${projectId}/style`),
  });
  const presets = useQuery({
    queryKey: ["style-presets"],
    queryFn: () => get<{ presets: StylePresetRow[] }>("/style-presets"),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const current = style.data?.versions.find((v) => v.id === style.data.currentStyleId) ?? style.data?.versions[0];
  const [presetKey, setPresetKey] = useState<string | null | undefined>(undefined);
  const [custom, setCustom] = useState<string | undefined>(undefined);
  const [edits, setEdits] = useState<Partial<Record<StyleField, string>>>({});
  const [excl, setExcl] = useState<string | undefined>(undefined);
  const chosenKey = presetKey === undefined ? (current?.preset?.key ?? null) : presetKey;
  const customText = custom ?? current?.customDescription ?? "";
  // A style applied from a described image lives on a project-scoped preset, which /style-presets does not list;
  // the version query already joins it, so fall back to that rather than hiding the whole definition.
  const chosen =
    presets.data?.presets.find((p) => p.key === chosenKey) ??
    (current?.preset?.key === chosenKey ? current?.preset : null);
  const fieldValue = (k: StyleField) => edits[k] ?? chosen?.definition?.[k] ?? "";
  const exclText = excl ?? (chosen?.definition?.exclusions ?? []).join("\n");
  const edited = Object.keys(edits).length > 0 || excl !== undefined;
  const refresh = useCallback(() => qc.invalidateQueries({ queryKey: qk.style(projectId) }), [qc, projectId]);
  const makeCurrent = useAction((id: string) => post(`/project-styles/${id}/make-current`), {
    invalidate: [qk.style(projectId), qk.project(projectId)],
    success: "Style version restored",
  });
  const apply = useAction(
    () =>
      post(`/projects/${projectId}/style`, {
        stylePresetKey: chosenKey,
        customDescription: customText,
        // Only sent when a field was touched: the endpoint mints a project-scoped preset from a definition, so
        // sending one unchanged would fork a "Custom" copy of a built-in preset on every apply.
        ...(edited
          ? {
              customDefinition: {
                ...chosen?.definition,
                ...edits,
                ...(excl === undefined
                  ? {}
                  : {
                      exclusions: excl
                        .split("\n")
                        .map((t) => t.trim())
                        .filter(Boolean),
                    }),
              },
            }
          : {}),
      }),
    {
      invalidate: [qk.style(projectId), qk.project(projectId)],
      success: "New style version applied",
      onSuccess: () => {
        setPresetKey(undefined);
        setCustom(undefined);
        setEdits({});
        setExcl(undefined);
      },
    },
  );
  if (style.isLoading || presets.isLoading) return <Spinner className="size-6" />;
  if (style.error || presets.error) return <ErrorBox error={style.error ?? presets.error} />;
  return (
    <div className="space-y-5">
      <section className="card p-4">
        <div className="mb-3 flex items-center gap-2">
          <h2 className="mr-auto font-semibold">Art direction</h2>
          {current && (
            <span className="muted text-xs">
              current: v{current.versionNumber} · {current.preset?.name ?? "custom"}
            </span>
          )}
          <DescribeImageButton
            projectId={projectId}
            aspect="style"
            title="Take the art style from an image"
            onUse={(d: ImageDescription) => {
              // Fills the editor rather than applying: the user reviews it and clicks "Apply as new version".
              const st = d.style ?? {};
              const lines = Object.entries(st)
                .filter(([, v]) => (Array.isArray(v) ? v.length : String(v ?? "").trim()))
                .map(
                  ([k, v]) => `${k.replace(/([A-Z])/g, " $1").toLowerCase()}: ${Array.isArray(v) ? v.join(", ") : v}`,
                );
              setPresetKey(null);
              setCustom(lines.join("\n"));
              toast.info("Style description filled in — review it, then apply as a new version");
            }}
          />
          <button type="button" className="btn-primary" disabled={apply.isPending} onClick={() => apply.mutate()}>
            Apply as new version
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {presets.data?.presets.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                setPresetKey(p.key);
                setEdits({});
              }}
              aria-pressed={p.key === chosenKey}
              className={`rounded-lg border p-2 text-left text-sm ${p.key === chosenKey ? "border-accent-500 bg-accent-500/10" : "border-[var(--border)] hover:bg-[var(--panel-2)]"}`}
            >
              <div className="font-medium">{p.name}</div>
              <div className="muted line-clamp-2 text-xs">{p.definition.summary}</div>
            </button>
          ))}
          <button
            type="button"
            onClick={() => setPresetKey(null)}
            aria-pressed={chosenKey === null}
            className={`rounded-lg border p-2 text-left text-sm ${chosenKey === null ? "border-accent-500 bg-accent-500/10" : "border-[var(--border)]"}`}
          >
            <div className="font-medium">No preset</div>
            <div className="muted text-xs">Custom description only</div>
          </button>
        </div>
        <div className="mt-3">
          <div className="mb-1 flex items-baseline gap-2">
            <span className="label mb-0">Style definition</span>
            <span className="muted text-xs">
              {edited ? "Edited — applying saves it as a custom style" : "Every line below goes into the image prompt"}
            </span>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            {STYLE_FIELDS.map(([k, label]) => (
              <label key={k} className="block">
                <span className="muted text-xs">{label}</span>
                <textarea
                  className="input min-h-14 text-xs"
                  value={fieldValue(k)}
                  onChange={(e) => setEdits((p) => ({ ...p, [k]: e.target.value }))}
                />
              </label>
            ))}
            <label className="block sm:col-span-2">
              <span className="muted text-xs">Avoid — one per line</span>
              <textarea
                className="input min-h-14 text-xs"
                value={exclText}
                placeholder="photoreal rendering&#10;3D render look"
                onChange={(e) => setExcl(e.target.value)}
              />
            </label>
          </div>
        </div>
        <label className="mt-3 block">
          <span className="label">Project-specific style description</span>
          <textarea
            className="input min-h-20"
            value={customText}
            onChange={(e) => setCustom(e.target.value)}
            placeholder="e.g. heavy rain atmosphere, teal and orange grading"
          />
        </label>
      </section>
      {current && (
        <ReferencePanel
          subject="style"
          versionPath="project-styles"
          versionId={current.id}
          versionStatus={current.status}
          references={style.data?.references ?? []}
          onChanged={refresh}
        />
      )}
      <section className="card p-4">
        <h2 className="mb-2 font-semibold">Style history</h2>
        <ul className="space-y-1 text-sm">
          {style.data?.versions.map((v) => (
            <li key={v.id} className="flex items-center gap-2">
              <span className="font-medium">v{v.versionNumber}</span>
              <StatusChip status={v.status} />
              <span>{v.preset?.name ?? "custom"}</span>
              <span className="muted truncate">{v.customDescription}</span>
              <span className="muted ml-auto text-xs">{fmt.date(v.createdAt)}</span>
              {v.id === style.data?.currentStyleId ? (
                <span className="muted text-xs">current</span>
              ) : (
                // Applying a style always minted a new version, so comparing two meant retyping one by hand.
                <button
                  type="button"
                  className="btn-ghost text-xs"
                  disabled={makeCurrent.isPending}
                  onClick={() => makeCurrent.mutate(v.id)}
                >
                  Make current
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

function NotesTab() {
  const projectId = useProjectId();
  const { data } = useProject();
  if (!data) return <Spinner />;
  return <NotesEditor key={projectId} projectId={projectId} initial={data.project.settings.worldNotes} />;
}

function NotesEditor({ projectId, initial }: { projectId: string; initial: string }) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState(initial);
  const { state } = useAutosave(notes, async (v) => {
    await patch(`/projects/${projectId}`, { settings: { worldNotes: v } });
    qc.invalidateQueries({ queryKey: qk.project(projectId) });
  });
  return (
    <section className="card p-4">
      <div className="mb-2 flex items-center">
        <h2 className="mr-auto font-semibold">World notes</h2>
        <SaveIndicator state={state} />
      </div>
      <p className="muted mb-2 text-xs">
        World rules, factions, technology, magic and uniforms. Included as structured context when planning chapters.
      </p>
      <textarea
        className="input min-h-80 font-mono text-sm"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        aria-label="World notes"
      />
    </section>
  );
}
