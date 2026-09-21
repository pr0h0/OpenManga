import type { Frame } from "@openmanga/schemas";
import { Sparkles } from "lucide-react";
import { useState } from "react";
import { post } from "../../api/client.ts";
import { ConfirmDialog, fmt, Spinner, toast } from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { useInvalidateBatches } from "../generation/BatchStatus.tsx";

type Scope = { pageId?: string; sceneId?: string; chapterId?: string; panelIds?: string[] };
type Estimate = {
  confirmRequired?: boolean;
  count: number;
  skipped: number;
  total?: number;
  skippedReasons?: { inProgress: number; hasArtwork: number; locked: number };
  estimatedUsd: number | null;
  budget?: {
    limitUsd: number | null;
    spentUsd: number;
    remainingUsd: number | null;
    exceeded: boolean;
    unpricedCalls: number;
  };
  provider?: { provider: string; model: string };
  /** Which mode this price was calculated for; the dialog will not show it against the other one. */
  batch?: boolean;
  preflight?: Preflight;
  credentials?: { text: boolean; image: boolean; mockMode: boolean };
};

type Preflight = {
  panels: number;
  harmVocabulary: { panels: number; terms: { term: string; panels: number }[] };
  characterWarnings: { characterId: string; name: string; versionNumber: number; panels: number; terms: string[] }[];
  distress: { panels: number };
  staleReferences: { name: string; versionNumber: number; panels: number }[];
  missingReferences: { name: string; versionNumber: number; panels: number }[];
};

/** What is likely to be blocked or lose identity, found before spending. Informational; nothing is prevented. */
export function PreflightNotes({ preflight: f }: { preflight: Preflight }) {
  const notes: string[] = [];
  for (const c of f.characterWarnings)
    notes.push(
      `${c.name} v${c.versionNumber} (in ${c.panels} panel${c.panels === 1 ? "" : "s"}) is described with ${c.terms.map((t) => `“${t}”`).join(", ")}`,
    );
  const panelTerms = f.harmVocabulary.terms.filter((t) => !f.characterWarnings.some((c) => c.terms.includes(t.term)));
  if (panelTerms.length) notes.push(`Panel text uses ${panelTerms.map((t) => `“${t.term}” (${t.panels})`).join(", ")}`);
  if (f.distress.panels)
    notes.push(
      `${f.distress.panels} panel${f.distress.panels === 1 ? "" : "s"} combine a lone figure with dark or underlit lighting and a distressed mood or high/tilted camera`,
    );
  for (const r of f.staleReferences)
    notes.push(
      `${r.name} v${r.versionNumber}'s approved reference was made from an older description (${r.panels} panels)`,
    );
  for (const r of f.missingReferences)
    notes.push(
      `${r.name} v${r.versionNumber} has no approved reference, so identity isn't pinned (${r.panels} panels)`,
    );
  if (!notes.length) return null;
  return (
    <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
      <p className="mb-1 font-medium text-amber-700 dark:text-amber-300">Likely to be blocked or drift</p>
      <ul className="list-disc space-y-0.5 pl-4">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
      <p className="muted mt-1">
        Image content filters (Meta Muse especially) block these combinations some of the time even in harmless scenes.
        Fix the wording or regenerate the reference first, or generate anyway.
      </p>
    </div>
  );
}

function skippedText(e: Estimate) {
  const r = e.skippedReasons;
  if (!r) return e.skipped ? `${e.skipped} skipped` : "";
  return [
    r.inProgress && `${r.inProgress} already queued or generating`,
    r.hasArtwork && `${r.hasArtwork} already have artwork`,
    r.locked && `${r.locked} locked`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** Bulk generation with count/cost confirmation. Progress is shown by the shared, server-backed batch status. */
export function BulkGenerateButton({
  projectId,
  scope,
  label,
  className,
}: {
  projectId: string;
  scope: Scope;
  label: string;
  className?: string;
}) {
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [batch, setBatch] = useState(false);
  const [busy, setBusy] = useState(false);
  const invalidateBatches = useInvalidateBatches(projectId);
  const aiImage = useAiBody("image");

  // Both toggles pass their new value in: state set in the same handler is not visible to this closure yet, so
  // reading `batch` here priced the run against the previous setting and left the estimate a click behind.
  const ask = async (missing = onlyMissing, asBatch = batch) => {
    setBusy(true);
    try {
      setEstimate(
        await post<Estimate>(`/projects/${projectId}/generations/bulk`, {
          ...aiImage(),
          scope,
          onlyMissing: missing,
          batch: asBatch,
        }),
      );
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await post<{ batchId: string | null; jobs: unknown[]; failures?: { error: string }[] }>(
        `/projects/${projectId}/generations/bulk`,
        { ...aiImage(), scope, onlyMissing, confirm: true, batch },
      );
      setEstimate(null);
      if (!r.batchId) toast.info("Nothing to generate");
      else {
        await invalidateBatches();
        toast.success(
          batch
            ? `Sent ${r.jobs.length} panel${r.jobs.length === 1 ? "" : "s"} to a provider batch — results within 24h`
            : `Queued ${r.jobs.length} panel generation${r.jobs.length === 1 ? "" : "s"}`,
        );
      }
      if (r.failures?.length) toast.error(`${r.failures.length} panel(s) could not be queued: ${r.failures[0]!.error}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const nothing = estimate !== null && estimate.count === 0;
  return (
    <>
      <AiChip cap="image" />
      <button type="button" className={className ?? "btn-primary"} disabled={busy} onClick={() => ask()}>
        {busy ? <Spinner /> : <Sparkles className="size-4" />} {label}
      </button>
      <ConfirmDialog
        open={Boolean(estimate)}
        title={label}
        confirmLabel={nothing ? "Nothing to queue" : `Generate ${estimate?.count ?? 0}`}
        busy={busy}
        disabled={nothing}
        onClose={() => setEstimate(null)}
        onConfirm={confirm}
      >
        {estimate && (
          <div className="space-y-3">
            {nothing ? (
              <p>
                <strong>Nothing to generate.</strong> All {estimate.total ?? estimate.skipped} panels are skipped
                {skippedText(estimate) ? `: ${skippedText(estimate)}` : ""}.
                {estimate.skippedReasons?.inProgress
                  ? " Their progress is shown in the batch status on this screen and at the bottom of the window."
                  : ""}
              </p>
            ) : (
              <>
                <p>
                  This will queue <strong>{estimate.count}</strong> individual image generation
                  {estimate.count === 1 ? "" : "s"}
                  {skippedText(estimate) ? ` (skipped: ${skippedText(estimate)})` : ""}.
                </p>
                <p>
                  Estimated cost:{" "}
                  <strong>
                    {/* The response says which mode it priced, so a price is never shown against the other one. */}
                    {estimate.batch !== batch
                      ? "re-pricing…"
                      : estimate.estimatedUsd === null
                        ? "unknown (no rate snapshot)"
                        : `≈ ${fmt.usd(estimate.estimatedUsd)}`}
                  </strong>
                  <span className="muted"> — rough estimate; actual provider usage is recorded per job.</span>
                </p>
                {estimate.credentials && !estimate.credentials.image && !estimate.credentials.mockMode && (
                  <p className="rounded-md bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
                    You have no image-capable API key saved. This server has no shared keys, so these jobs will fail
                    until you add one in Account → AI providers.
                  </p>
                )}
                <label className="flex items-start gap-2 rounded-md bg-[var(--panel-2)] p-2 text-sm">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={batch}
                    disabled={busy}
                    onChange={(e) => {
                      setBatch(e.target.checked);
                      // Re-price immediately: the batch rate is half, and some providers cannot batch at all.
                      // The old estimate stays on screen while that runs — clearing it closed the whole dialog,
                      // and a re-price that fails (a provider with no batch API) left nothing but a toast.
                      void ask(onlyMissing, e.target.checked);
                    }}
                  />
                  <span>
                    <strong>Send as a provider batch</strong> — half price, results within 24h (often sooner).
                    <span className="muted">
                      {" "}
                      Panels wait at the provider instead of generating now. OpenAI and Google keys only.
                    </span>
                  </span>
                </label>
                {estimate.preflight && <PreflightNotes preflight={estimate.preflight} />}
                {estimate.provider && (
                  <p className="muted text-xs">
                    Using {estimate.provider.provider} · {estimate.provider.model}
                  </p>
                )}
                {estimate.budget?.limitUsd != null && (
                  <p
                    className={
                      estimate.budget.spentUsd + (estimate.estimatedUsd ?? 0) >= estimate.budget.limitUsd
                        ? "rounded-md bg-amber-500/15 p-2 text-sm text-amber-700 dark:text-amber-300"
                        : "muted text-sm"
                    }
                  >
                    Project budget: {fmt.usd(estimate.budget.spentUsd)} of {fmt.usd(estimate.budget.limitUsd)} spent
                    {estimate.budget.spentUsd + (estimate.estimatedUsd ?? 0) >= estimate.budget.limitUsd
                      ? " — this batch would go over; you'll be asked to confirm."
                      : ` — ${fmt.usd(estimate.budget.remainingUsd ?? 0)} left.`}
                  </p>
                )}
                {!!estimate.budget?.unpricedCalls && (
                  <p className="muted text-sm">
                    {estimate.budget.unpricedCalls} earlier call
                    {estimate.budget.unpricedCalls === 1 ? "" : "s"} could not be priced (no rate snapshot for that
                    model), so spend so far is understated.
                  </p>
                )}
              </>
            )}
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={onlyMissing}
                onChange={(e) => {
                  setOnlyMissing(e.target.checked);
                  void ask(e.target.checked);
                }}
              />
              Only panels without artwork
            </label>
          </div>
        )}
      </ConfirmDialog>
    </>
  );
}

export function LayoutThumb({ frames, className }: { frames: Frame[]; className?: string }) {
  return (
    <svg viewBox="0 0 100 150" className={className ?? "h-12 w-8"} aria-hidden="true">
      <rect width="100" height="150" fill="currentColor" opacity="0.08" />
      {frames.map((f, i) => (
        <rect
          key={i}
          x={f.x * 100 + 2}
          y={f.y * 150 + 2}
          width={Math.max(1, f.width * 100 - 4)}
          height={Math.max(1, f.height * 150 - 4)}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
        />
      ))}
    </svg>
  );
}
