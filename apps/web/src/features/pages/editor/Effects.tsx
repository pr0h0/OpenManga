import { EFFECT_TYPES, type PanelEffect } from "@openmanga/schemas";
import { useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { patch } from "../../../api/client.ts";
import { SaveIndicator, useAutosave } from "../../../components/ui.tsx";

const LABEL: Record<PanelEffect["type"], string> = {
  speed: "Speed lines",
  focus: "Focus lines",
  impact: "Impact flash",
  tone: "Screentone",
  rain: "Rain",
  snow: "Snow",
  dust: "Dust",
  glow: "Glow",
  flashback: "Flashback tint",
};
/** Which knobs each effect reads. */
const KNOBS: Record<PanelEffect["type"], ("angle" | "centre" | "density" | "strength" | "size" | "color")[]> = {
  speed: ["angle", "density", "strength", "color"],
  focus: ["centre", "size", "density", "strength", "color"],
  impact: ["centre", "size", "density", "strength", "color"],
  tone: ["density", "strength", "color"],
  rain: ["angle", "density", "strength"],
  snow: ["density", "strength"],
  dust: ["density", "strength", "color"],
  glow: ["centre", "size", "strength", "color"],
  flashback: ["strength"],
};
const fresh = (type: PanelEffect["type"]): PanelEffect => ({
  type,
  x: 0.5,
  y: 0.5,
  angle: type === "rain" ? 75 : 0,
  density: 0.5,
  strength: 0.8,
  size: 0.35,
  color: type === "glow" ? "#ffd27a" : "#000000",
});

/**
 * Comic effects over the panel's art: drawn by the app (no AI, no cost), the same on the canvas and in every page,
 * strip and video render. Saved as you change them.
 */
export function Effects({
  panelId,
  value,
  locked,
  invalidate,
}: {
  panelId: string;
  value: PanelEffect[] | null;
  locked: boolean;
  invalidate: readonly (readonly unknown[])[];
}) {
  const qc = useQueryClient();
  const [list, setList] = useState<PanelEffect[]>(value ?? []);
  const [adding, setAdding] = useState<PanelEffect["type"]>("speed");
  const { state } = useAutosave(
    list,
    async (effects) => {
      await patch(`/panels/${panelId}`, { effects });
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: key });
    },
    { enabled: !locked, delay: 400 },
  );
  const set = (i: number, p: Partial<PanelEffect>) => setList((l) => l.map((e, k) => (k === i ? { ...e, ...p } : e)));
  const slider = (i: number, key: "density" | "strength" | "size", label: string) => (
    <label className="flex items-center gap-1">
      <span className="w-16 shrink-0">{label}</span>
      <input
        type="range"
        min={key === "size" ? 0.05 : 0}
        max={1}
        step={0.05}
        value={list[i]![key]}
        aria-label={`${LABEL[list[i]!.type]}: ${label}`}
        onChange={(e) => set(i, { [key]: Number(e.target.value) })}
        className="flex-1"
      />
    </label>
  );
  return (
    <details className="rounded-lg border border-[var(--border)] p-2" open={list.length > 0}>
      <summary className="cursor-pointer text-sm font-medium">Effects</summary>
      <fieldset disabled={locked} className="mt-2 space-y-2 text-xs">
        <div className="flex items-center">
          <p className="muted mr-auto">Drawn over the art in every render, without AI. Up to 6.</p>
          <SaveIndicator state={state} />
        </div>
        {list.map((e, i) => (
          <div key={`${i}-${e.type}`} className="space-y-1 rounded-md bg-[var(--panel-2)] p-2">
            <div className="flex items-center">
              <span className="mr-auto font-medium">{LABEL[e.type]}</span>
              <button
                type="button"
                className="btn-ghost p-1 text-red-500"
                aria-label={`Remove ${LABEL[e.type]}`}
                onClick={() => setList((l) => l.filter((_, k) => k !== i))}
              >
                <Trash2 className="size-3.5" />
              </button>
            </div>
            {KNOBS[e.type].includes("angle") && (
              <label className="flex items-center gap-1">
                <span className="w-16 shrink-0">Angle</span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  step={5}
                  value={e.angle}
                  aria-label={`${LABEL[e.type]}: angle`}
                  onChange={(ev) => set(i, { angle: Number(ev.target.value) })}
                  className="flex-1"
                />
              </label>
            )}
            {KNOBS[e.type].includes("centre") && (
              <div className="grid grid-cols-2 gap-1">
                {(["x", "y"] as const).map((k) => (
                  <label key={k} className="flex items-center gap-1">
                    <span className="w-4">{k.toUpperCase()}</span>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={e[k]}
                      aria-label={`${LABEL[e.type]}: centre ${k}`}
                      onChange={(ev) => set(i, { [k]: Number(ev.target.value) })}
                      className="flex-1"
                    />
                  </label>
                ))}
              </div>
            )}
            {KNOBS[e.type].includes("size") && slider(i, "size", "Size")}
            {KNOBS[e.type].includes("density") && slider(i, "density", "Density")}
            {KNOBS[e.type].includes("strength") && slider(i, "strength", "Strength")}
            {KNOBS[e.type].includes("color") && (
              <label className="flex items-center gap-1">
                <span className="w-16 shrink-0">Colour</span>
                <input
                  type="color"
                  value={e.color}
                  aria-label={`${LABEL[e.type]}: colour`}
                  onChange={(ev) => set(i, { color: ev.target.value })}
                />
              </label>
            )}
          </div>
        ))}
        {list.length < 6 && (
          <div className="flex gap-1">
            <select
              className="input py-1 text-xs"
              aria-label="Effect to add"
              value={adding}
              onChange={(e) => setAdding(e.target.value as PanelEffect["type"])}
            >
              {EFFECT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {LABEL[t]}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn-secondary px-2 py-1 text-xs"
              onClick={() => setList((l) => [...l, fresh(adding)])}
            >
              <Plus className="size-3.5" /> Add
            </button>
          </div>
        )}
      </fieldset>
    </details>
  );
}
