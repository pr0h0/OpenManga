import {
  CAMERA_HEIGHTS,
  FIGURE_DEPTHS,
  FIGURE_FACINGS,
  FIGURE_VIEWS,
  type FigureDirection,
  LENS_FEELS,
  type PanelDirection,
  SHOT_PURPOSES,
} from "@openmanga/schemas";
import { Field } from "../../../components/ui.tsx";

const label = (s: string) => s.replace(/-/g, " ");

function Pick<T extends string>({
  name,
  value,
  options,
  onChange,
  empty = "—",
}: {
  name: string;
  /** What the empty choice reads as: the field's own name where no label sits above it. */
  empty?: string;
  value: T | undefined;
  options: readonly T[];
  onChange: (v: T | undefined) => void;
}) {
  return (
    <select
      className="input"
      aria-label={name}
      value={value ?? ""}
      onChange={(e) => onChange((e.target.value || undefined) as T | undefined)}
    >
      <option value="">{empty}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {label(o)}
        </option>
      ))}
    </select>
  );
}

/**
 * Directing controls: optional staging for the panel's camera and for each figure in it. Empty fields leave the choice
 * to the beat and composition; saved with the panel spec, so a change marks drawn art out of date.
 */
export function Directing({
  value,
  figures,
  onChange,
}: {
  value: PanelDirection | undefined;
  figures: { id: string; name: string }[];
  onChange: (v: PanelDirection) => void;
}) {
  const d: PanelDirection = value ?? { figures: [] };
  const set = (patch: Partial<PanelDirection>) => onChange({ ...d, ...patch });
  const figure = (id: string) => d.figures.find((f) => f.characterId === id) ?? { characterId: id };
  const setFigure = (id: string, patch: Partial<FigureDirection>) => {
    const next = { ...figure(id), ...patch };
    const others = d.figures.filter((f) => f.characterId !== id);
    set({ figures: [...others, next] });
  };
  const set2 = d.cameraHeight || d.lens || d.depthOfField || d.purpose || d.focus || d.figures.length;
  return (
    <details className="rounded-lg border border-[var(--border)] p-2" open={Boolean(set2)}>
      <summary className="cursor-pointer text-sm font-medium">Directing</summary>
      <div className="mt-2 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <Field label="Camera height">
            <Pick
              name="Camera height"
              value={d.cameraHeight}
              options={CAMERA_HEIGHTS}
              onChange={(v) => set({ cameraHeight: v })}
            />
          </Field>
          <Field label="Lens feel">
            <Pick name="Lens feel" value={d.lens} options={LENS_FEELS} onChange={(v) => set({ lens: v })} />
          </Field>
          <Field label="Depth of field">
            <Pick
              name="Depth of field"
              value={d.depthOfField}
              options={["deep", "shallow"] as const}
              onChange={(v) => set({ depthOfField: v })}
            />
          </Field>
          <Field label="Shot purpose">
            <Pick name="Shot purpose" value={d.purpose} options={SHOT_PURPOSES} onChange={(v) => set({ purpose: v })} />
          </Field>
        </div>
        <Field label="Focus subject">
          <input
            className="input"
            maxLength={200}
            placeholder="What the eye lands on first"
            value={d.focus ?? ""}
            onChange={(e) => set({ focus: e.target.value || undefined })}
          />
        </Field>
        {figures.map((c) => {
          const f = figure(c.id);
          return (
            <fieldset key={c.id} className="space-y-1 rounded-md bg-[var(--panel-2)] p-2">
              <legend className="px-1 text-xs font-medium">{c.name}</legend>
              <div className="grid grid-cols-3 gap-1">
                <Pick
                  name={`${c.name}: side shown`}
                  value={f.view}
                  options={FIGURE_VIEWS}
                  empty="Side shown"
                  onChange={(v) => setFigure(c.id, { view: v })}
                />
                <Pick
                  name={`${c.name}: facing`}
                  value={f.facing}
                  options={FIGURE_FACINGS}
                  empty="Facing"
                  onChange={(v) => setFigure(c.id, { facing: v })}
                />
                <Pick
                  name={`${c.name}: depth`}
                  value={f.depth}
                  options={FIGURE_DEPTHS}
                  empty="Depth"
                  onChange={(v) => setFigure(c.id, { depth: v })}
                />
              </div>
              <div className="grid grid-cols-2 gap-1">
                <input
                  className="input text-xs"
                  aria-label={`${c.name}: looking`}
                  placeholder="Looking: at Hana"
                  maxLength={200}
                  value={f.eyeLine ?? ""}
                  onChange={(e) => setFigure(c.id, { eyeLine: e.target.value || undefined })}
                />
                <input
                  className="input text-xs"
                  aria-label={`${c.name}: holding`}
                  placeholder="Holding: sword in right hand"
                  maxLength={200}
                  value={f.holding ?? ""}
                  onChange={(e) => setFigure(c.id, { holding: e.target.value || undefined })}
                />
              </div>
            </fieldset>
          );
        })}
      </div>
    </details>
  );
}
