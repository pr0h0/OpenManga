import { useState } from "react";
import { post } from "../../../api/client.ts";
import { useAction } from "../../../api/hooks.ts";
import { AiChip, useAiBody } from "../../ai/AiPicker.tsx";
import { useBoard } from "../../board/BoardPage.tsx";
import { useProjectId } from "../../project/ProjectLayout.tsx";

/**
 * Image tools on the panel's artwork. Quick ones run at once and free; AI ones are masked edits of the whole picture
 * (or of the area outpainting adds). Each makes a new version, so the previous one is a click away in Versions.
 */
export function ImageTools({
  panelId,
  cast,
  hasArt,
  locked,
  invalidate,
}: {
  panelId: string;
  cast: string[];
  hasArt: boolean;
  locked: boolean;
  invalidate: readonly (readonly unknown[])[];
}) {
  const projectId = useProjectId();
  const board = useBoard(projectId);
  const aiImage = useAiBody("image");
  const [palette, setPalette] = useState("");
  const [light, setLight] = useState("");
  const [who, setWho] = useState("");
  const [expression, setExpression] = useState("");
  const [aspect, setAspect] = useState("9:16");
  const run = useAction((body: Record<string, unknown>) => post<{ job?: unknown }>(`/panels/${panelId}/tools`, body), {
    invalidate,
    success: (r) => (r.job ? "Edit queued: the result becomes a new version" : "Done: a new version is active"),
  });
  const ai = (body: Record<string, unknown>) => run.mutate({ ...body, ...aiImage() });
  const off = !hasArt || locked || run.isPending;
  const btn = "btn-secondary px-2 py-1 text-xs";
  return (
    <details className="rounded-lg border border-[var(--border)] p-2">
      <summary className="cursor-pointer text-sm font-medium">Image tools</summary>
      <div className="mt-2 space-y-2 text-xs">
        {!hasArt && <p className="muted">Draw the panel first.</p>}
        <div className="label mb-0">Quick (no AI, free)</div>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={btn} disabled={off} onClick={() => run.mutate({ tool: "upscale" })}>
            Upscale 2x
          </button>
          <button type="button" className={btn} disabled={off} onClick={() => run.mutate({ tool: "lineart" })}>
            Line art
          </button>
        </div>
        {Boolean(board.data?.length) && (
          <div className="flex gap-1">
            <select
              className="input py-1 text-xs"
              aria-label="Palette from"
              value={palette}
              onChange={(e) => setPalette(e.target.value)}
            >
              <option value="">Palette from a board image…</option>
              {board.data?.map((b, i) => (
                <option key={b.id} value={b.assetId}>
                  {b.note || `Board image ${i + 1}`}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={btn}
              disabled={off || !palette}
              onClick={() => run.mutate({ tool: "palette", paletteAssetId: palette })}
            >
              Apply palette
            </button>
          </div>
        )}
        <div className="flex items-center">
          <span className="label mr-auto mb-0">With AI (a masked edit)</span>
          <AiChip cap="image" />
        </div>
        <div className="flex flex-wrap gap-1">
          <button type="button" className={btn} disabled={off} onClick={() => ai({ tool: "repair" })}>
            Repair faces & details
          </button>
          <button type="button" className={btn} disabled={off} onClick={() => ai({ tool: "background" })}>
            Remove background
          </button>
          <button type="button" className={btn} disabled={off} onClick={() => ai({ tool: "colorize" })}>
            Colourise
          </button>
        </div>
        <div className="flex gap-1">
          <input
            className="input py-1 text-xs"
            placeholder="Light: warm sunset from the left"
            aria-label="New light"
            value={light}
            onChange={(e) => setLight(e.target.value)}
          />
          <button
            type="button"
            className={btn}
            disabled={off || light.trim().length < 3}
            onClick={() => ai({ tool: "relight", light })}
          >
            Relight
          </button>
        </div>
        {cast.length > 0 && (
          <div className="flex gap-1">
            <select
              className="input w-auto py-1 text-xs"
              aria-label="Whose expression"
              value={who}
              onChange={(e) => setWho(e.target.value)}
            >
              <option value="">Who…</option>
              {cast.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
            <input
              className="input py-1 text-xs"
              placeholder="Expression: a tired smile"
              aria-label="New expression"
              value={expression}
              onChange={(e) => setExpression(e.target.value)}
            />
            <button
              type="button"
              className={btn}
              disabled={off || !who || expression.trim().length < 2}
              onClick={() => ai({ tool: "expression", character: who, expression })}
            >
              Change
            </button>
          </div>
        )}
        <div className="flex gap-1">
          <select
            className="input w-auto py-1 text-xs"
            aria-label="Outpaint to"
            value={aspect}
            onChange={(e) => setAspect(e.target.value)}
          >
            {["9:16", "16:9", "1:1", "4:5", "2:3"].map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <button type="button" className={btn} disabled={off} onClick={() => ai({ tool: "outpaint", aspect })}>
            Outpaint (widen instead of crop)
          </button>
        </div>
      </div>
    </details>
  );
}
