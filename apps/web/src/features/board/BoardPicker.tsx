import { LayoutDashboard } from "lucide-react";
import { useState } from "react";
import { post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import { AssetImage } from "../../components/ui.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { useBoard } from "./BoardPage.tsx";

/** Picks a reference board image as a panel's layout guide. */
export function BoardGuidePicker({
  panelId,
  strength,
  disabled,
  invalidate,
}: {
  panelId: string;
  strength: "loose" | "strict";
  disabled?: boolean;
  invalidate: readonly (readonly unknown[])[];
}) {
  const projectId = useProjectId();
  const [open, setOpen] = useState(false);
  const board = useBoard(projectId);
  const use = useAction((id: string) => post(`/board-items/${id}/use`, { target: "guide", panelId, strength }), {
    invalidate,
    success: "Layout guide set from the board",
    onSuccess: () => setOpen(false),
  });
  if (!board.data?.length) return null;
  return (
    <>
      <button type="button" className="btn-secondary text-xs" disabled={disabled} onClick={() => setOpen(!open)}>
        <LayoutDashboard className="size-3.5" /> From board
      </button>
      {open && (
        <div className="grid w-full grid-cols-4 gap-1" role="listbox" aria-label="Board images">
          {board.data.map((it) => (
            <button
              key={it.id}
              type="button"
              role="option"
              aria-selected={false}
              aria-label={it.note || "Board image"}
              className="rounded border border-[var(--border)] hover:border-accent-500"
              disabled={use.isPending}
              onClick={() => use.mutate(it.id)}
            >
              <AssetImage assetId={it.assetId} alt="" className="aspect-square w-full" fit="cover" />
            </button>
          ))}
        </div>
      )}
    </>
  );
}
