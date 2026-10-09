import { EDGE_STYLES, type EdgeStyle } from "@openmanga/schemas";

const LABEL: Record<EdgeStyle["style"], string> = {
  straight: "Straight",
  wavy: "Wavy",
  torn: "Torn paper",
  rough: "Rough cut",
  brush: "Brush stroke",
  burnt: "Burnt",
};

/**
 * An edge style and its depth. With `inheritLabel`, an empty choice means "inherit" (the project's default for a
 * panel) and is reported as undefined.
 */
export function EdgePicker({
  label,
  value,
  onChange,
  inheritLabel,
  disabled,
}: {
  label: string;
  value: EdgeStyle | undefined;
  onChange: (v: EdgeStyle | undefined) => void;
  inheritLabel?: string;
  disabled?: boolean;
}) {
  const style = value?.style ?? (inheritLabel ? "" : "straight");
  const size = value?.size ?? 0.5;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-xs">
        <span className="label">{label}</span>
        <select
          className="input w-40"
          aria-label={label}
          disabled={disabled}
          value={style}
          onChange={(e) => onChange(e.target.value ? { style: e.target.value as EdgeStyle["style"], size } : undefined)}
        >
          {inheritLabel && <option value="">{inheritLabel}</option>}
          {EDGE_STYLES.map((s) => (
            <option key={s} value={s}>
              {LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      {value && value.style !== "straight" && (
        <label className="text-xs">
          <span className="label">Depth</span>
          <input
            type="range"
            className="w-32"
            aria-label={`${label} depth`}
            min={0.1}
            max={1}
            step={0.05}
            disabled={disabled}
            value={size}
            onChange={(e) => onChange({ style: value.style, size: Number(e.target.value) })}
          />
        </label>
      )}
    </div>
  );
}
