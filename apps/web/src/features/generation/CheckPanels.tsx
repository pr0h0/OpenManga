import { useQueryClient } from "@tanstack/react-query";
import { ScanEye } from "lucide-react";
import { useState } from "react";
import { post } from "../../api/client.ts";
import { ConfirmDialog, fmt, Spinner, toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";

type Scope = { pageId?: string; chapterId?: string };
type Estimate = {
  count: number;
  total: number;
  skippedReasons: { noArtwork: number; inProgress: number; alreadyChecked: number };
  estimatedUsd: number | null;
  provider: { provider: string; model: string };
};

/**
 * Check all panels: the vision consistency check for a page, chapter or project in one run, priced first. The
 * results feed the drift flags and "Move bubbles off faces".
 */
export function CheckPanelsButton({
  projectId,
  scope,
  label = "Check all panels",
  className = "btn-secondary",
}: {
  projectId: string;
  scope: Scope;
  label?: string;
  className?: string;
}) {
  const qc = useQueryClient();
  const aiText = useAiBody("text");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [onlyUnchecked, setOnlyUnchecked] = useState(true);
  const [busy, setBusy] = useState(false);
  const call = async (confirm: boolean, only = onlyUnchecked) => {
    setBusy(true);
    try {
      const r = await post<Estimate & { jobs?: unknown[] }>(`/projects/${projectId}/checks`, {
        ...aiText(),
        scope,
        onlyUnchecked: only,
        confirm,
      });
      if (!confirm) setEstimate(r);
      else {
        setEstimate(null);
        toast.success(r.jobs?.length ? `Queued ${r.jobs.length} checks` : "Nothing to check");
        await qc.invalidateQueries({ queryKey: ["project", projectId, "generations"] });
      }
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const skipped = estimate
    ? [
        estimate.skippedReasons.alreadyChecked && `${estimate.skippedReasons.alreadyChecked} already checked`,
        estimate.skippedReasons.inProgress && `${estimate.skippedReasons.inProgress} being checked`,
        estimate.skippedReasons.noArtwork && `${estimate.skippedReasons.noArtwork} without artwork`,
      ]
        .filter(Boolean)
        .join(", ")
    : "";
  return (
    <>
      <AiChip cap="text" />
      <button type="button" className={className} disabled={busy} onClick={() => call(false)}>
        {busy ? <Spinner /> : <ScanEye className="size-4" />} {label}
      </button>
      <ConfirmDialog
        open={Boolean(estimate)}
        title={label}
        confirmLabel={estimate?.count ? `Check ${estimate.count}` : "Nothing to check"}
        disabled={!estimate?.count}
        busy={busy}
        onClose={() => setEstimate(null)}
        onConfirm={() => call(true)}
      >
        {estimate && (
          <div className="space-y-3 text-sm">
            <p>
              A vision model looks at <strong>{estimate.count}</strong> panel{estimate.count === 1 ? "" : "s"}: whether
              the expected characters are there, and where their faces are.
              {skipped && <span className="muted"> Skipped: {skipped}.</span>}
            </p>
            <p>
              Estimated cost:{" "}
              <strong>
                {estimate.estimatedUsd === null ? "unknown (no rate snapshot)" : `≈ ${fmt.usd(estimate.estimatedUsd)}`}
              </strong>
              <span className="muted">
                {" "}
                · {estimate.provider.provider} · {estimate.provider.model}
              </span>
            </p>
            <p className="muted text-xs">
              Uses the key set in Project settings → Consistency check when there is one; otherwise the text model
              above, which must be able to read images.
            </p>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={onlyUnchecked}
                onChange={(e) => {
                  setOnlyUnchecked(e.target.checked);
                  void call(false, e.target.checked);
                }}
              />
              Only panels without a current check
            </label>
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}
