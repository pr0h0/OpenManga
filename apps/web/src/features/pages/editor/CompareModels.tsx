import { providerCatalog } from "@openmanga/domain/browser";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { get, post } from "../../../api/client.ts";
import { qk, useAction } from "../../../api/hooks.ts";
import { AssetImage, fmt, StatusChip } from "../../../components/ui.tsx";
import { useAiChoices, useAiOptions } from "../../ai/AiPicker.tsx";

type Run = {
  jobId: string;
  status: string;
  provider: string | null;
  model: string | null;
  credentialId: string | null;
  failureReason: string | null;
  assetId: string | null;
  durationMs: number | null;
  costUsd: number;
  check: { status: string; verdict?: string; problems?: string[] } | null;
};
type Row = { credentialId: string | null; model: string };

/**
 * Model comparison: the panel drawn by 2-4 image models at once, side by side with time, cost and the visual check;
 * the picked one becomes the panel's artwork and the image model for what you draw next.
 */
export function CompareModels({
  panelId,
  locked,
  invalidate,
}: {
  panelId: string;
  locked: boolean;
  invalidate: readonly (readonly unknown[])[];
}) {
  const qc = useQueryClient();
  const opts = useAiOptions();
  const setChoice = useAiChoices((s) => s.set);
  const creds = (opts.data?.credentials ?? []).filter((c) => {
    const p = providerCatalog(c.kind);
    return p && (p.kind === "openai_compatible" || p.imageModels.length > 0);
  });
  const modelsOf = (credentialId: string | null) => {
    const c = creds.find((x) => x.id === credentialId);
    if (!c) return opts.data?.defaults.image ? [opts.data.defaults.image.model] : [];
    return providerCatalog(c.kind)?.imageModels ?? [];
  };
  const first = creds[0]?.id ?? null;
  const [rows, setRows] = useState<Row[]>(() => [
    { credentialId: first, model: "" },
    { credentialId: creds[1]?.id ?? first, model: "" },
  ]);
  const key = [...qk.panel(panelId), "compare"];
  const q = useQuery({
    queryKey: key,
    queryFn: () => get<{ compareId: string | null; runs: Run[] }>(`/panels/${panelId}/compare`),
    refetchInterval: (r) =>
      r.state.data?.runs.some(
        (x) =>
          !["completed", "failed", "cancelled"].includes(x.status) ||
          (x.check && x.check.status !== "completed" && x.check.status !== "failed"),
      )
        ? 3000
        : false,
  });
  const run = useAction(
    () =>
      post(`/panels/${panelId}/compare`, {
        runs: rows.map((r) => ({
          credentialId: r.credentialId,
          model: r.model || modelsOf(r.credentialId)[0] || null,
        })),
      }),
    { invalidate: [key], success: "Drawing with each model" },
  );
  const pick = useAction(
    (jobId: string) =>
      post<{ credentialId: string | null; model: string | null }>(`/panels/${panelId}/compare/pick`, { jobId }),
    {
      success: "Using that one: it is also your image model now",
      onSuccess: (r) => {
        setChoice("image", { credentialId: r.credentialId, model: r.model ?? "" });
        for (const k of invalidate) void qc.invalidateQueries({ queryKey: k });
      },
    },
  );
  const label = (r: { credentialId: string | null }) =>
    creds.find((c) => c.id === r.credentialId)?.label ?? "Server default";
  return (
    <details className="rounded-lg border border-[var(--border)] p-2">
      <summary className="cursor-pointer text-sm font-medium">Compare models</summary>
      <div className="mt-2 space-y-2 text-xs">
        <p className="muted">
          Draw this panel with several image models at once, then keep the best. Each run spends that key's credits; the
          panel keeps its artwork until you pick one.
        </p>
        {rows.map((r, i) => (
          <div key={i} className="flex gap-1">
            <select
              className="input py-1 text-xs"
              aria-label={`Model ${i + 1}: key`}
              value={r.credentialId ?? ""}
              onChange={(e) =>
                setRows((rs) => rs.map((x, k) => (k === i ? { credentialId: e.target.value || null, model: "" } : x)))
              }
            >
              {opts.data?.defaults.image && <option value="">Server default</option>}
              {creds.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <input
              className="input py-1 text-xs"
              aria-label={`Model ${i + 1}: model`}
              list={`models-${panelId}-${i}`}
              placeholder={modelsOf(r.credentialId)[0] ?? "model"}
              value={r.model}
              onChange={(e) => setRows((rs) => rs.map((x, k) => (k === i ? { ...x, model: e.target.value } : x)))}
            />
            <datalist id={`models-${panelId}-${i}`}>
              {modelsOf(r.credentialId).map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
            {rows.length > 2 && (
              <button
                type="button"
                className="btn-ghost p-1"
                aria-label={`Remove model ${i + 1}`}
                onClick={() => setRows((rs) => rs.filter((_, k) => k !== i))}
              >
                <Trash2 className="size-3.5" />
              </button>
            )}
          </div>
        ))}
        <div className="flex gap-1">
          {rows.length < 4 && (
            <button
              type="button"
              className="btn-ghost px-2 py-1 text-xs"
              onClick={() => setRows((rs) => [...rs, { credentialId: first, model: "" }])}
            >
              <Plus className="size-3.5" /> Model
            </button>
          )}
          <button
            type="button"
            className="btn-primary ml-auto px-2 py-1 text-xs"
            disabled={locked || run.isPending}
            onClick={() => run.mutate()}
          >
            Draw with {rows.length} models
          </button>
        </div>
        {Boolean(q.data?.runs.length) && (
          <ul className="grid grid-cols-2 gap-2" aria-label="Comparison">
            {q.data!.runs.map((r) => (
              <li key={r.jobId} className="space-y-1 rounded-md border border-[var(--border)] p-1">
                {r.assetId ? (
                  <AssetImage
                    assetId={r.assetId}
                    alt={`${r.model} result`}
                    className="aspect-square w-full rounded"
                    fit="contain"
                  />
                ) : (
                  <div className="flex aspect-square items-center justify-center rounded bg-[var(--panel-2)]">
                    <StatusChip status={r.status} />
                  </div>
                )}
                <div className="truncate font-medium" title={`${r.provider} · ${r.model}`}>
                  {label(r)} · {r.model}
                </div>
                <div className="muted">
                  {r.durationMs !== null ? `${(r.durationMs / 1000).toFixed(1)} s` : "…"} · {fmt.usd(r.costUsd)}
                </div>
                {r.check?.verdict && (
                  <div className={r.check.verdict === "ok" ? "text-emerald-600" : "text-amber-600"}>
                    Check: {r.check.verdict}
                    {r.check.problems?.length ? ` (${r.check.problems.length})` : ""}
                  </div>
                )}
                {r.failureReason && <div className="text-red-500">{r.failureReason}</div>}
                <button
                  type="button"
                  className="btn-secondary w-full px-2 py-1 text-xs"
                  disabled={!r.assetId || locked || pick.isPending}
                  onClick={() => pick.mutate(r.jobId)}
                >
                  Use this one
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
