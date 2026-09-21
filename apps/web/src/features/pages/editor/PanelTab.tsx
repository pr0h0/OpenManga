import { CameraAngle, PanelSpec, ShotType } from "@openmanga/schemas";
import { useQuery } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Copy, Lock, Move, SplitSquareHorizontal, SplitSquareVertical, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { get, patch, post, put } from "../../../api/client.ts";
import { qk, useAction } from "../../../api/hooks.ts";
import type { EditorPanel, LocationCard, PageDocument, PropCard } from "../../../api/types.ts";
import { clsx, Field, StatusChip, TagInput } from "../../../components/ui.tsx";
import { useAiBody } from "../../ai/AiPicker.tsx";
import { useProject, useProjectId } from "../../project/ProjectLayout.tsx";
import { PreviewVideoButton } from "../../video/VideoPreview.tsx";
import { useEditor } from "./store.ts";

/** Prepared prompt fields the planner prefers over the panel spec, in the order the prompt reads them. */
const DRAFT_FIELDS = ["intent", "action", "expression", "composition", "lighting", "continuity"] as const;

type PanelDetail = {
  characters: { id: string; versionNumber: number; status: string; characterId: string; name: string }[];
};

export function PanelList({ data, onDelete }: { data: PageDocument; onDelete: (id: string) => void }) {
  const doc = useEditor((s) => s.doc);
  const selection = useEditor((s) => s.selection);
  const select = useEditor((s) => s.select);
  const ordered = [...doc.panels].sort((a, b) => a.order - b.order);
  const reorder = useAction((panelIds: string[]) => post(`/pages/${data.page.id}/reorder-panels`, { panelIds }), {
    invalidate: [qk.page(data.page.id)],
  });
  const move = (idx: number, dir: -1 | 1) => {
    const ids = ordered.map((p) => p.id);
    const [id] = ids.splice(idx, 1);
    ids.splice(idx + dir, 0, id!);
    useEditor
      .getState()
      .commit((d) => ({ ...d, panels: d.panels.map((p) => ({ ...p, order: ids.indexOf(p.id) + 1 })) }));
    reorder.mutate(ids);
  };
  return (
    <ul className="space-y-1" aria-label="Panels in reading order">
      {ordered.map((p, i) => {
        const server = data.panels.find((s) => s.id === p.id);
        const active = selection?.type === "panel" && selection.ids.includes(p.id);
        return (
          <li
            key={p.id}
            className={clsx(
              "flex items-center gap-1 rounded-lg border px-2 py-1 text-xs",
              active ? "border-accent-500 bg-accent-600/10" : "border-[var(--border)]",
            )}
          >
            <button
              type="button"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={(e) => select({ type: "panel", ids: [p.id] }, e.shiftKey)}
            >
              <span className="font-semibold tabular-nums">{i + 1}</span>
              <span className="muted truncate">{server?.storyBeat || "Untitled panel"}</span>
            </button>
            {server && <StatusChip status={server.status} />}
            <button
              type="button"
              className="btn-ghost p-0.5"
              aria-label="Move panel earlier"
              disabled={i === 0}
              onClick={() => move(i, -1)}
            >
              <ArrowUp className="size-3.5" />
            </button>
            <button
              type="button"
              className="btn-ghost p-0.5"
              aria-label="Move panel later"
              disabled={i === ordered.length - 1}
              onClick={() => move(i, 1)}
            >
              <ArrowDown className="size-3.5" />
            </button>
            <button
              type="button"
              className="btn-ghost p-0.5 text-red-500"
              aria-label="Delete panel"
              onClick={() => onDelete(p.id)}
            >
              <Trash2 className="size-3.5" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}

const areas = ["upper-left", "upper-right", "top", "bottom", "lower-left", "lower-right", "left", "right"];

function AdjustImageButton({ panelId, disabled }: { panelId: string; disabled: boolean }) {
  const active = useEditor((s) => s.adjustImageFor === panelId);
  return (
    <button
      type="button"
      className={active ? "btn-primary flex-1 text-xs" : "btn-secondary flex-1 text-xs"}
      disabled={disabled}
      aria-pressed={active}
      onClick={() => useEditor.getState().setAdjustImage(active ? null : panelId)}
    >
      <Move className="size-3.5" /> {active ? "Done moving image" : "Move / zoom image on page"}
    </button>
  );
}

export function PanelTab({
  data,
  panel,
  onDelete,
}: {
  data: PageDocument;
  panel: EditorPanel;
  onDelete: (id: string) => void;
}) {
  const projectId = useProjectId();
  const locked = panel.approvalStatus === "locked";
  const [spec, setSpec] = useState<PanelSpec>(
    () => panel.spec ?? PanelSpec.parse({ beat: panel.storyBeat || "New panel" }),
  );
  useEffect(
    () => setSpec(panel.spec ?? PanelSpec.parse({ beat: panel.storyBeat || "New panel" })),
    [panel.id, panel.specVersion],
  );
  const detail = useQuery({ queryKey: qk.panel(panel.id), queryFn: () => get<PanelDetail>(`/panels/${panel.id}`) });
  const locations = useQuery({
    queryKey: qk.locations(projectId),
    queryFn: () => get<{ locations: LocationCard[] }>(`/projects/${projectId}/locations`),
    select: (r) => r.locations,
  });
  const props = useQuery({
    queryKey: qk.props(projectId),
    queryFn: () => get<{ props: PropCard[] }>(`/projects/${projectId}/props`),
    select: (r) => r.props,
  });
  const inv = [qk.page(data.page.id), qk.panel(panel.id)];

  const saveSpec = useAction(() => put(`/panels/${panel.id}/spec`, { spec }), {
    invalidate: inv,
    success: "Panel spec saved",
  });
  const patchPanel = useAction((body: Record<string, unknown>) => patch(`/panels/${panel.id}`, body), {
    invalidate: inv,
  });
  const duplicate = useAction(() => post(`/pages/${data.page.id}/panels`, { duplicateOf: panel.id }), {
    invalidate: [qk.page(data.page.id)],
    success: "Panel duplicated",
  });
  const split = useAction((direction: "horizontal" | "vertical") => post(`/panels/${panel.id}/split`, { direction }), {
    invalidate: [qk.page(data.page.id)],
    success: "Panel split",
  });

  const attached = detail.data?.characters ?? [];
  const isStrip = useProject().data?.project.settings.format === "vertical";
  const seam = panel.seam ?? undefined;
  // Prepared text outranks the spec fields in the compiled prompt (intent over the beat, action, expression,
  // composition and lighting), so an edit here looks ignored until it is discarded. Continuity merges instead.
  const draft = (panel.promptDraft ?? null) as Record<string, unknown> | null;
  const draftFields = DRAFT_FIELDS.filter((k) => {
    const v = draft?.[k];
    return Array.isArray(v) ? v.length > 0 : String(v ?? "").trim().length > 0;
  });
  const draftHasContinuity = draftFields.includes("continuity");
  const toggleCharacter = (c: PageDocument["cast"][number]) => {
    const current = attached.find((a) => a.characterId === c.id);
    const ids = current
      ? panel.characterVersionIds.filter((v) => v !== current.id)
      : c.currentVersionId
        ? [...panel.characterVersionIds, c.currentVersionId]
        : panel.characterVersionIds;
    patchPanel.mutate({ characterVersionIds: ids });
    setSpec((s) => ({
      ...s,
      characters: current
        ? s.characters.filter((x) => x.characterId !== c.id)
        : [...s.characters, { characterId: c.id, expression: "", pose: "", action: "", outfit: "", position: "" }],
    }));
  };
  const setField = <K extends keyof PanelSpec>(k: K, v: PanelSpec[K]) => setSpec((s) => ({ ...s, [k]: v }));
  const transform =
    useEditor((s) => s.doc.panels.find((p) => p.id === panel.id)?.imageTransform) ?? panel.imageTransform;
  const setTransform = (k: "focalX" | "focalY" | "scale", v: number) =>
    useEditor.getState().commit((d) => ({
      ...d,
      panels: d.panels.map((p) => (p.id === panel.id ? { ...p, imageTransform: { ...p.imageTransform, [k]: v } } : p)),
    }));

  return (
    <div className="space-y-4 text-sm">
      <div className="flex flex-wrap items-center gap-1">
        <StatusChip status={panel.status} />
        <StatusChip status={panel.approvalStatus} />
        <QaBadge panelId={panel.id} qa={panel.qa as Qa | null} hasArt={Boolean(panel.activeArtworkAssetId)} />
        {panel.review && <ReviewBadge panelId={panel.id} review={panel.review} invalidate={inv} />}
        <div className="ml-auto flex gap-1">
          <button
            type="button"
            className="btn-ghost p-1.5"
            title="Duplicate (Ctrl+D)"
            aria-label="Duplicate panel"
            disabled={locked}
            onClick={() => duplicate.mutate()}
          >
            <Copy className="size-4" />
          </button>
          <button
            type="button"
            className="btn-ghost p-1.5"
            title="Split horizontally"
            aria-label="Split horizontally"
            disabled={locked}
            onClick={() => split.mutate("horizontal")}
          >
            <SplitSquareVertical className="size-4" />
          </button>
          <button
            type="button"
            className="btn-ghost p-1.5"
            title="Split vertically"
            aria-label="Split vertically"
            disabled={locked}
            onClick={() => split.mutate("vertical")}
          >
            <SplitSquareHorizontal className="size-4" />
          </button>
          <button
            type="button"
            className="btn-ghost p-1.5 text-red-500"
            aria-label="Delete panel"
            disabled={locked}
            onClick={() => onDelete(panel.id)}
          >
            <Trash2 className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex gap-1">
        {panel.approvalStatus !== "approved" && !locked && (
          <button
            type="button"
            className="btn-secondary flex-1"
            onClick={() => patchPanel.mutate({ approvalStatus: "approved" })}
          >
            Approve
          </button>
        )}
        {panel.approvalStatus === "approved" && (
          <button
            type="button"
            className="btn-secondary flex-1"
            onClick={() => patchPanel.mutate({ approvalStatus: "draft" })}
          >
            Unapprove
          </button>
        )}
        {panel.approvalStatus === "approved" && (
          <button
            type="button"
            className="btn-secondary flex-1"
            onClick={() => patchPanel.mutate({ approvalStatus: "locked" })}
          >
            <Lock className="size-3.5" /> Lock
          </button>
        )}
        {locked && <p className="muted text-xs">Locked panels are read-only.</p>}
      </div>

      {draftFields.length > 0 && (
        <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
          <div className="font-medium">Prepared prompt text is in use</div>
          <p className="mt-1">
            "Prepare page prompts" wrote {draftFields.join(", ")} for this panel, and the compiled prompt uses that text
            instead of the matching fields below{draftHasContinuity ? " (continuity is added to yours)" : ""}. Discard
            it to go back to what you type here.
          </p>
          <button
            type="button"
            className="btn-ghost mt-1 text-xs"
            disabled={locked || patchPanel.isPending}
            onClick={() => patchPanel.mutate({ promptDraft: null })}
          >
            Discard prepared text
          </button>
        </div>
      )}

      <fieldset disabled={locked} className="space-y-3">
        <Field label="Story beat">
          <textarea className="input" rows={2} value={spec.beat} onChange={(e) => setField("beat", e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Shot type">
            <select
              className="input"
              value={spec.shotType}
              onChange={(e) => setField("shotType", e.target.value as PanelSpec["shotType"])}
            >
              {ShotType.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Camera angle">
            <select
              className="input"
              value={spec.cameraAngle}
              onChange={(e) => setField("cameraAngle", e.target.value as PanelSpec["cameraAngle"])}
            >
              {CameraAngle.options.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div>
          <div className="label">Characters in panel</div>
          <div className="flex flex-wrap gap-1">
            {data.cast.map((c) => {
              const a = attached.find((x) => x.characterId === c.id);
              const stale = a && c.currentVersionId && a.id !== c.currentVersionId;
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={Boolean(a)}
                  onClick={() => toggleCharacter(c)}
                  className={clsx("chip border", a ? "border-accent-500 bg-accent-600/15" : "border-[var(--border)]")}
                  title={stale ? "An older appearance version is attached" : undefined}
                >
                  {c.name}
                  {a && (
                    <span className="muted">
                      v{a.versionNumber}
                      {stale ? " (old)" : ""}
                    </span>
                  )}
                </button>
              );
            })}
            {!data.cast.length && <span className="muted text-xs">No characters in this project yet.</span>}
          </div>
        </div>
        {spec.characters.map((pc, i) => {
          const name = data.cast.find((c) => c.id === pc.characterId)?.name ?? "Character";
          const upd = (k: "expression" | "pose" | "action" | "outfit" | "position", v: string) =>
            setField(
              "characters",
              spec.characters.map((x, j) => (j === i ? { ...x, [k]: v } : x)),
            );
          return (
            <div key={pc.characterId} className="rounded-lg border border-[var(--border)] p-2">
              <div className="mb-1 text-xs font-medium">{name}</div>
              <div className="grid grid-cols-2 gap-1.5">
                {(["expression", "pose", "action", "outfit", "position"] as const).map((k) => (
                  <input
                    key={k}
                    className="input text-xs"
                    placeholder={k}
                    aria-label={`${name} ${k}`}
                    value={pc[k]}
                    onChange={(e) => upd(k, e.target.value)}
                  />
                ))}
              </div>
            </div>
          );
        })}

        <Field label="Location">
          <select
            className="input"
            value={
              locations.data?.find(
                (l) =>
                  l.currentVersionId === panel.locationVersionId || l.currentVersion?.id === panel.locationVersionId,
              )?.id ?? ""
            }
            onChange={(e) => {
              const loc = locations.data?.find((l) => l.id === e.target.value);
              patchPanel.mutate({ locationVersionId: loc?.currentVersionId ?? null });
              setField("locationId", loc?.id);
            }}
          >
            <option value="">None</option>
            {locations.data?.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Field>

        {/*
          The API and the prompt have always taken props; only the editor never sent them, so a prop reached a
          panel exactly once — when AI planning put it there — and could never be added or removed by hand.
        */}
        {isStrip && (
          // Vertical strips only: the seam belongs to the panel that follows it, so a scene change is authored on
          // the panel that opens the new scene. The first panel of a strip ignores its own seam.
          <Field
            label="Seam above this panel"
            hint="How this panel meets the one before it in the scrolling strip. Size is in strip pixels; blank uses the project gap."
          >
            <div className="grid grid-cols-2 gap-1.5">
              <select
                className="input text-xs"
                aria-label="Seam kind"
                value={seam?.kind ?? "gap"}
                onChange={(e) => {
                  const kind = e.target.value as NonNullable<EditorPanel["seam"]>["kind"];
                  patchPanel.mutate({ seam: kind === "gap" && !seam?.size ? null : { ...seam, kind } });
                }}
              >
                <option value="gap">Gap — separate beats</option>
                <option value="butt">No gap — continuous action</option>
                <option value="bleed">Overlap — hard edge</option>
                <option value="dissolve">Overlap — blended</option>
                <option value="fade">Fade through a colour</option>
              </select>
              <input
                className="input text-xs"
                type="number"
                min={0}
                max={2000}
                step={10}
                aria-label="Seam size in pixels"
                placeholder="size (px)"
                value={seam?.size ?? ""}
                onChange={(e) => {
                  const size = e.target.value === "" ? undefined : Math.max(0, Number(e.target.value));
                  patchPanel.mutate({ seam: { kind: seam?.kind ?? "gap", ...seam, size } });
                }}
              />
            </div>
            {seam?.kind === "fade" && (
              <input
                className="input mt-1.5 text-xs"
                aria-label="Fade colour"
                placeholder="#000000 (defaults to the strip background)"
                value={seam.color ?? ""}
                onChange={(e) => {
                  const color = e.target.value.trim();
                  patchPanel.mutate({ seam: { ...seam, color: /^#[0-9a-fA-F]{6}$/.test(color) ? color : undefined } });
                }}
              />
            )}
          </Field>
        )}

        <Field label="Props" hint="Attached props are described in the prompt and their references are sent.">
          <div className="flex flex-wrap gap-1">
            {props.data?.map((p) => {
              const attached = p.currentVersionId ? panel.propVersionIds.includes(p.currentVersionId) : false;
              return (
                <button
                  key={p.id}
                  type="button"
                  disabled={!p.currentVersionId}
                  aria-pressed={attached}
                  onClick={() =>
                    patchPanel.mutate({
                      propVersionIds: attached
                        ? panel.propVersionIds.filter((v) => v !== p.currentVersionId)
                        : [...panel.propVersionIds, p.currentVersionId!],
                    })
                  }
                  className={clsx(
                    "chip border",
                    attached ? "border-accent-500 bg-accent-600/15" : "border-[var(--border)]",
                  )}
                >
                  {p.name}
                </button>
              );
            })}
            {!props.data?.length && <span className="muted text-xs">No props in this project yet.</span>}
          </div>
        </Field>

        {(["composition", "foreground", "midground", "background", "lighting", "emotion", "action"] as const).map(
          (k) => (
            <Field key={k} label={k[0]!.toUpperCase() + k.slice(1)}>
              <input className="input" value={spec[k] ?? ""} onChange={(e) => setField(k, e.target.value)} />
            </Field>
          ),
        )}
        <Field label="Continuity requirements">
          <TagInput
            value={spec.continuityRequirements}
            onChange={(v) => setField("continuityRequirements", v)}
            placeholder="e.g. left sleeve torn"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Negative space">
            <select
              className="input"
              value={spec.negativeSpace?.area ?? ""}
              onChange={(e) =>
                setField(
                  "negativeSpace",
                  e.target.value
                    ? { area: e.target.value, purpose: spec.negativeSpace?.purpose ?? "dialogue" }
                    : undefined,
                )
              }
            >
              <option value="">None</option>
              {areas.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="For">
            <select
              className="input"
              disabled={!spec.negativeSpace}
              value={spec.negativeSpace?.purpose ?? "dialogue"}
              onChange={(e) =>
                spec.negativeSpace &&
                setField("negativeSpace", { ...spec.negativeSpace, purpose: e.target.value as "dialogue" })
              }
            >
              <option value="dialogue">dialogue</option>
              <option value="narration">narration</option>
              <option value="sfx">sfx</option>
            </select>
          </Field>
        </div>
        <button
          type="button"
          className="btn-primary w-full"
          disabled={saveSpec.isPending}
          onClick={() => saveSpec.mutate()}
        >
          Save panel spec
        </button>
      </fieldset>

      {panel.artwork && (
        <div className="space-y-2 rounded-lg border border-[var(--border)] p-2">
          <div className="label">Artwork crop (original is never modified)</div>
          <div className="flex flex-wrap gap-1">
            <AdjustImageButton panelId={panel.id} disabled={locked} />
            <PreviewVideoButton
              projectId={projectId}
              scope={{ panelId: panel.id }}
              label="Preview move"
              title="Preview — panel Ken Burns move"
              className="btn-ghost text-xs"
            />
            <button
              type="button"
              className="btn-ghost text-xs"
              disabled={locked}
              onClick={() =>
                useEditor.getState().commit((d) => ({
                  ...d,
                  panels: d.panels.map((p) =>
                    p.id === panel.id ? { ...p, imageTransform: { focalX: 0.5, focalY: 0.5, scale: 1 } } : p,
                  ),
                }))
              }
            >
              Reset
            </button>
          </div>
          <p className="muted text-xs">
            Or double-click the panel on the page. Drag to move the image, scroll to zoom; the faded area shows what is
            cropped out. Press Enter or Esc when done.
          </p>
          {(
            [
              ["focalX", "Focal X", 0, 1, 0.01],
              ["focalY", "Focal Y", 0, 1, 0.01],
              ["scale", "Zoom", 1, 8, 0.05],
            ] as const
          ).map(([k, label, min, max, step]) => (
            <label key={k} className="flex items-center gap-2 text-xs">
              <span className="w-14">{label}</span>
              <input
                type="range"
                className="flex-1"
                min={min}
                max={max}
                step={step}
                value={transform[k]}
                disabled={locked}
                onChange={(e) => setTransform(k, Number(e.target.value))}
              />
              <span className="w-10 text-right tabular-nums">{transform[k].toFixed(2)}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

/** Art that needs a human look, e.g. generated on the fallback provider after a content-policy block. */
function ReviewBadge({
  panelId,
  review,
  invalidate,
}: {
  panelId: string;
  review: { message: string };
  invalidate: readonly (readonly unknown[])[];
}) {
  const dismiss = useAction(() => post(`/panels/${panelId}/review/dismiss`), {
    invalidate,
    success: "Marked as reviewed",
  });
  return (
    <button
      type="button"
      className="chip bg-violet-500/15 text-violet-700 dark:text-violet-300"
      title={`${review.message} Click to mark as reviewed.`}
      disabled={dismiss.isPending}
      onClick={() => dismiss.mutate()}
    >
      needs review
    </button>
  );
}

type Qa = { verdict: "ok" | "mismatch"; problems: string[]; stale?: boolean; model?: string; checkedAt?: string };

/** Result of the automatic cast/headcount check, plus a manual "check now". */
function QaBadge({ panelId, qa, hasArt }: { panelId: string; qa: Qa | null; hasArt: boolean }) {
  // Falls back to a text key of the caller's; the project's configured vision key still takes priority server-side.
  const aiText = useAiBody("text");
  const check = useAction(() => post(`/panels/${panelId}/check`, aiText()), { success: "Consistency check queued" });
  if (!hasArt) return null;
  const label = !qa ? "not checked" : qa.stale ? "check outdated" : qa.verdict === "ok" ? "cast OK" : "cast mismatch";
  const cls =
    qa?.verdict === "mismatch" && !qa.stale
      ? "chip bg-amber-500/15 text-amber-700 dark:text-amber-300"
      : qa?.verdict === "ok" && !qa.stale
        ? "chip bg-emerald-500/15 text-emerald-600"
        : "chip";
  return (
    <button
      type="button"
      className={cls}
      disabled={check.isPending}
      title={
        qa
          ? `${qa.problems.length ? qa.problems.join("; ") : "Expected cast and headcount match"}${qa.model ? ` — ${qa.model}` : ""}. Click to check again.`
          : "Run the vision consistency check (Project settings → Consistency check)"
      }
      onClick={() => check.mutate()}
    >
      {label}
    </button>
  );
}
