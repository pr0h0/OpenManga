import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { Check, ExternalLink, RotateCcw, Upload, XCircle } from "lucide-react";
import { useState } from "react";
import { assetUrl, get, post } from "../../api/client.ts";
import { qk, useAction } from "../../api/hooks.ts";
import type { JobDetail } from "../../api/types.ts";
import { AssetImage, ErrorBox, fmt, KeyValue, PageHeader, Spinner, StatusChip, toast } from "../../components/ui.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { CopyButton, JsonBlock, kindLabel } from "./shared.tsx";

const str = (v: unknown) => (typeof v === "string" && v ? v : null);
const DOCS_URL = "https://github.com/pr0h0/OpenManga/blob/master/docs/WITHOUT_API_KEYS.md";

/**
 * The other half of a keyless run: the prompt is above, this is where the answer comes back. Held to exactly the
 * schema a provider's answer is, so a rejected paste explains itself and can simply be pasted again.
 */
function ManualAnswer({
  jobId,
  lastError,
  attachments,
  answered,
  onSubmitted,
}: {
  jobId: string;
  lastError: string | null;
  attachments: string[];
  answered: number;
  onSubmitted: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  // Refetched per question: a plan's outline and its scenes each want a differently shaped answer.
  const guide = useQuery({
    queryKey: [...qk.job(jobId), "manual", answered],
    queryFn: () => get<{ example: string | null }>(`/generations/${jobId}/manual`),
  });
  const send = async (answer: string) => {
    if (!answer.trim()) return;
    setBusy(true);
    try {
      await post(`/generations/${jobId}/manual`, { text: answer.trim() });
      toast.success("Answer submitted — checking it against the schema");
      setText("");
      onSubmitted();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card border-amber-500/40 p-4">
      <h2 className="mb-1 font-medium">Waiting for your answer{answered > 0 ? ` · question ${answered + 1}` : ""}</h2>
      <p className="muted mb-3 text-sm">
        Copy the compiled prompt below into any chat, then paste the reply here. It is checked against the same schema a
        provider's answer is, so nothing is applied until it fits.
      </p>
      {attachments.length > 0 && (
        <div className="mb-3 rounded-lg bg-[var(--panel-2)] p-3 text-sm">
          <p className="mb-2">
            This question is about {attachments.length === 1 ? "an image" : `${attachments.length} images`}. A copied
            prompt cannot carry pictures, so download {attachments.length === 1 ? "it" : "them"} and attach{" "}
            {attachments.length === 1 ? "it" : "them"} to your chat — the prompt marks where each one goes.
          </p>
          <div className="flex flex-wrap gap-2">
            {attachments.map((id, n) => (
              <a key={id} href={assetUrl(id)} download target="_blank" rel="noreferrer" className="text-center text-xs">
                <AssetImage assetId={id} alt={`Image ${n + 1}`} className="size-24 rounded object-cover" />
                image {n + 1}
              </a>
            ))}
          </div>
        </div>
      )}
      {lastError && (
        <p className="mb-3 rounded-lg bg-red-500/10 p-2 font-mono text-xs break-words text-red-500">{lastError}</p>
      )}
      <details className="mb-3 rounded-lg border border-[var(--border)] p-2 text-sm">
        <summary className="cursor-pointer font-medium">What should the answer look like?</summary>
        <div className="mt-2 space-y-2">
          <p className="muted">
            JSON matching the schema at the end of the prompt — which is also what the prompt tells your chat to reply
            with. Wrapping it in a code fence or a sentence of prose is fine; only the JSON is read. Here is a valid
            answer to <em>this</em> question, to show its shape. Its content is placeholder, not a real reading of your
            story — paste your chat's reply, not this.
          </p>
          {guide.data?.example ? (
            <>
              <div className="flex justify-end">
                <CopyButton text={guide.data.example} />
              </div>
              <pre className="max-h-72 overflow-auto rounded-lg bg-[var(--panel-2)] p-2 font-mono text-xs">
                {guide.data.example}
              </pre>
            </>
          ) : (
            <p className="muted text-xs">{guide.isLoading ? "Loading an example…" : "No example for this one."}</p>
          )}
          <p className="text-xs">
            Every operation, the API, and a worked example are in{" "}
            <a href={DOCS_URL} target="_blank" rel="noreferrer" className="text-accent-500 hover:underline">
              Running without any API keys
            </a>
            .
          </p>
        </div>
      </details>
      <textarea
        className="input min-h-40 font-mono text-xs"
        placeholder="Paste the model's reply — JSON, optionally inside a code fence"
        value={text}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-primary" disabled={busy || !text.trim()} onClick={() => send(text)}>
          {busy ? <Spinner /> : <Check className="size-4" />} Submit answer
        </button>
        <label className="btn-secondary cursor-pointer">
          <Upload className="size-4" /> Upload a file
          <input
            type="file"
            className="sr-only"
            accept=".json,.txt,application/json,text/plain"
            disabled={busy}
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) await send(await f.text());
            }}
          />
        </label>
      </div>
    </section>
  );
}

export function JobDetailPage() {
  const projectId = useProjectId();
  const { jobId } = useParams({ strict: false }) as { jobId: string };
  const q = useQuery({
    queryKey: qk.job(jobId),
    queryFn: () => get<JobDetail>(`/generations/${jobId}`),
    refetchInterval: (query) =>
      ["queued", "processing", "cancel_requested"].includes(query.state.data?.job.status ?? "") ? 3000 : false,
  });
  const cancel = useAction(() => post<{ result: string }>(`/generations/${jobId}/cancel`), {
    invalidate: [qk.job(jobId), qk.generations(projectId)],
    success: (r) => (r.result === "cancelled" ? "Cancelled" : "Cancellation requested"),
  });
  const retry = useAction(() => post<{ job: { id: string } }>(`/generations/${jobId}/retry`), {
    invalidate: [qk.job(jobId), qk.generations(projectId)],
    success: "Retry queued as a new job",
  });

  if (q.isLoading)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );
  if (q.error)
    return (
      <div className="p-6">
        <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      </div>
    );
  const { job, inputs, outputs, usage, retries, totals } = q.data!;
  const pageId = str(job.input.pageId);
  const promptInput = job.input as Record<string, unknown>;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <Link to="/projects/$projectId/generation" params={{ projectId }} className="muted text-xs hover:underline">
        ← Generation queue
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            {kindLabel(job.kind)} <StatusChip status={job.status} />
          </span>
        }
        subtitle={`Job ${job.id}`}
        actions={
          <>
            {(job.status === "queued" || job.status === "processing" || job.status === "awaiting_input") && (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                <XCircle className="size-4" /> Cancel
              </button>
            )}
            {(job.status === "failed" || job.status === "cancelled") && (
              <button type="button" className="btn-primary" onClick={() => retry.mutate()} disabled={retry.isPending}>
                <RotateCcw className="size-4" /> Retry
              </button>
            )}
          </>
        }
      />
      {job.failureReason && (
        <div
          role="alert"
          className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-300"
        >
          <span className="font-medium">{job.failureCode ?? "failed"}:</span> {job.failureReason}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-3 font-medium">Request</h2>
          <KeyValue
            items={[
              [
                "Target",
                job.targetType === "panel" && pageId ? (
                  <Link
                    key="t"
                    to="/projects/$projectId/pages/$pageId"
                    params={{ projectId, pageId }}
                    search={{ panelId: job.targetId ?? undefined }}
                    className="text-accent-500 hover:underline"
                  >
                    panel {job.targetId?.slice(0, 8)}
                  </Link>
                ) : (
                  `${job.targetType ?? "—"} ${job.targetId ?? ""}`
                ),
              ],
              ["Provider / model", `${job.provider ?? "—"} / ${job.model ?? "—"}`],
              ["Quality", String(job.parameters.quality ?? "—")],
              ["Template", job.templateName ? `${job.templateName} v${job.templateVersion ?? "?"}` : "—"],
              [
                "Prompt hash",
                <code key="p" className="text-xs">
                  {job.promptHash ?? "—"}
                </code>,
              ],
              [
                "References hash",
                <code key="r" className="text-xs">
                  {job.referencesHash ?? "—"}
                </code>,
              ],
              [
                "Options hash",
                <code key="o" className="text-xs">
                  {job.optionsHash ?? "—"}
                </code>,
              ],
              [
                "Provider request id",
                <code key="q" className="text-xs">
                  {job.providerRequestId ?? "—"}
                </code>,
              ],
              ["Priority / attempts", `${job.priority} / ${job.attempts} of ${job.maxAttempts}`],
              ["Created", fmt.date(job.createdAt)],
              ["Started", fmt.date(job.startedAt)],
              ["Finished", fmt.date(job.finishedAt)],
              ["Latency", job.latencyMs ? fmt.ms(job.latencyMs) : "—"],
            ]}
          />
        </section>
        <section className="card p-4">
          <h2 className="mb-3 font-medium">Parameters & structured input</h2>
          <KeyValue
            items={[
              [
                "Character versions",
                Array.isArray(promptInput.characterVersionIds)
                  ? (promptInput.characterVersionIds as string[]).map((v) => v.slice(0, 8)).join(", ") || "none"
                  : "—",
              ],
              ["Location version", str(promptInput.locationVersionId)?.slice(0, 8) ?? "—"],
              ["Style", str(promptInput.styleId)?.slice(0, 8) ?? "—"],
            ]}
          />
          <div className="mt-3 space-y-2">
            <div className="label">Parameters</div>
            <JsonBlock value={job.parameters} maxHeight="12rem" />
            <details>
              <summary className="muted cursor-pointer text-xs">Full job input</summary>
              <JsonBlock value={job.input} />
            </details>
          </div>
        </section>
      </div>

      {job.status === "awaiting_input" && (
        <ManualAnswer
          jobId={job.id}
          lastError={job.failureReason}
          attachments={
            Array.isArray(job.parameters.manualAttachments) ? (job.parameters.manualAttachments as string[]) : []
          }
          answered={Array.isArray(job.parameters.manualAnswers) ? job.parameters.manualAnswers.length : 0}
          onSubmitted={() => q.refetch()}
        />
      )}

      <section className="card p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Compiled prompt</h2>
          {job.compiledPrompt && <CopyButton text={job.compiledPrompt} />}
        </div>
        {job.compiledPrompt ? (
          <pre className="max-h-[32rem] overflow-auto rounded-lg bg-[var(--panel-2)] p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
            {job.compiledPrompt}
          </pre>
        ) : (
          <p className="muted text-sm">
            Not recorded yet (text jobs record their messages when the provider is called).
          </p>
        )}
      </section>

      <section className="card p-4">
        <h2 className="mb-3 font-medium">Images sent ({inputs.length})</h2>
        {!inputs.length ? (
          <p className="muted text-sm">No reference images were attached.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {inputs.map((i) => {
              const m = i.metadata as {
                canonicalWidth?: number;
                canonicalHeight?: number;
                maxWidth?: number;
                maxHeight?: number;
                referenceBytes?: number;
              };
              return (
                <div key={i.id} className="flex gap-3 rounded-lg border border-[var(--border)] p-2">
                  <AssetImage assetId={i.assetId} alt={i.label} className="size-20 shrink-0 rounded" fit="contain" />
                  <div className="min-w-0 text-xs">
                    <div className="font-medium">
                      #{i.order + 1} {i.role.replace(/_/g, " ")}
                    </div>
                    <div className="muted truncate" title={i.label}>
                      {i.label}
                    </div>
                    {i.sentAs === "prompt_ref_derivative" ? (
                      <div className="mt-1 text-emerald-600 dark:text-emerald-400">
                        Sent as small derivative {i.width}×{i.height}
                        {m.maxWidth ? ` (max ${m.maxWidth}×${m.maxHeight})` : ""}
                        {m.referenceBytes || i.variant
                          ? ` · ${fmt.bytes(m.referenceBytes ?? i.variant?.byteSize)}`
                          : ""}
                      </div>
                    ) : (
                      <div className="mt-1 text-sky-600 dark:text-sky-400">
                        Sent at full resolution {i.width}×{i.height}
                      </div>
                    )}
                    {m.canonicalWidth && (
                      <div className="muted">
                        Canonical {m.canonicalWidth}×{m.canonicalHeight}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {outputs.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-3 font-medium">Outputs</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            {outputs.map((o) => (
              <div key={o.id}>
                <a href={assetUrl(o.assetId)} target="_blank" rel="noreferrer">
                  <AssetImage
                    assetId={o.assetId}
                    variant={null}
                    alt="Generated output"
                    className="max-h-[28rem] w-full rounded-lg"
                    fit="contain"
                  />
                </a>
                <div className="mt-1 flex items-center gap-2 text-xs">
                  {o.activated ? (
                    <StatusChip status="approved" label="activated" />
                  ) : (
                    <StatusChip status="draft" label="not activated" />
                  )}
                  <a
                    className="text-accent-500 hover:underline"
                    href={assetUrl(o.assetId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Full resolution <ExternalLink className="inline size-3" />
                  </a>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card overflow-x-auto p-4">
        <h2 className="mb-3 font-medium">Usage ({fmt.usd(totals.costUsd)})</h2>
        {!usage.length ? (
          <p className="muted text-sm">No provider usage recorded.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="muted text-left">
              <tr className="border-b border-[var(--border)]">
                {[
                  "Provider",
                  "Model",
                  "Operation",
                  "Purpose",
                  "Text in",
                  "Text out",
                  "Image in",
                  "Image out",
                  "Cached",
                  "Cost",
                  "Latency",
                  "Request id",
                ].map((h) => (
                  <th key={h} className="p-1.5">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {usage.map((u) => (
                <tr key={u.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="p-1.5">{u.provider}</td>
                  <td className="p-1.5">{u.model}</td>
                  <td className="p-1.5">{u.operation}</td>
                  <td className="p-1.5">{String((u.metadata as { purpose?: string }).purpose ?? "—")}</td>
                  <td className="p-1.5">{fmt.num(u.textInputTokens)}</td>
                  <td className="p-1.5">{fmt.num(u.textOutputTokens)}</td>
                  <td className="p-1.5">{fmt.num(u.imageInputTokens)}</td>
                  <td className="p-1.5">{fmt.num(u.imageOutputTokens)}</td>
                  <td className="p-1.5">{fmt.num(u.cachedInputTokens)}</td>
                  <td className="p-1.5">{fmt.usd(u.estimatedCostUsd)}</td>
                  <td className="p-1.5">{fmt.ms(u.latencyMs)}</td>
                  <td className="p-1.5">
                    <code>{u.requestId ?? "—"}</code>
                  </td>
                </tr>
              ))}
              <tr className="font-medium">
                <td className="p-1.5" colSpan={4}>
                  Total
                </td>
                <td className="p-1.5">{fmt.num(totals.textInputTokens)}</td>
                <td className="p-1.5">{fmt.num(totals.textOutputTokens)}</td>
                <td className="p-1.5">{fmt.num(totals.imageInputTokens)}</td>
                <td className="p-1.5">{fmt.num(totals.imageOutputTokens)}</td>
                <td className="p-1.5" />
                <td className="p-1.5">{fmt.usd(totals.costUsd)}</td>
                <td className="p-1.5" colSpan={2} />
              </tr>
            </tbody>
          </table>
        )}
        {usage[0]?.rawUsage && (
          <details className="mt-2">
            <summary className="muted cursor-pointer text-xs">Raw provider usage</summary>
            <JsonBlock value={usage.map((u) => u.rawUsage)} />
          </details>
        )}
      </section>

      {retries.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-2 font-medium">Retries</h2>
          <ul className="space-y-1 text-sm">
            {retries.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <Link
                  to="/projects/$projectId/generation/$jobId"
                  params={{ projectId, jobId: r.id }}
                  className="text-accent-500 hover:underline"
                >
                  {r.id.slice(0, 8)}
                </Link>
                <StatusChip status={r.status} /> <span className="muted text-xs">{fmt.ago(r.createdAt)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
