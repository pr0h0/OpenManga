import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, EyeOff, ListChecks, RotateCcw, ScrollText } from "lucide-react";
import { useState } from "react";
import { get, patch, post } from "../../api/client.ts";
import type { ContinuityFindingRow } from "../../api/types.ts";
import {
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  fmt,
  Modal,
  Spinner,
  StatusChip,
  Tabs,
  toast,
} from "../../components/ui.tsx";
import { AiChip, useAiBody } from "../ai/AiPicker.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { type BibleData, bibleKey, FactForm } from "./BiblePage.tsx";

type Verdict = "pass" | "warn" | "fail";
type Report = {
  chapters: { id: string; order: number; title: string }[];
  findings: ContinuityFindingRow[];
  rules: {
    factId: string;
    kind: string;
    subject: string;
    text: string;
    verdict: Verdict | null;
    chapters: { chapterId: string; order: number; verdict: Verdict; note: string; checkedAt: string }[];
  }[];
  running: number;
};
type Estimate = { count: number; skipped: number; estimatedUsd: number | null; provider: { model: string } };

const reportKey = (projectId: string) => ["project", projectId, "continuity"] as const;
const useReport = (projectId: string) =>
  useQuery({
    queryKey: reportKey(projectId),
    queryFn: () => get<Report>(`/projects/${projectId}/continuity`),
    // A check runs for a while; its job events refresh this too.
    refetchInterval: (q) => ((q.state.data?.running ?? 0) > 0 ? 5000 : false),
  });

const SEVERITY: Record<string, string> = { high: "failed", medium: "queued", low: "draft" };
const VERDICT: Record<Verdict, string> = { fail: "failed", warn: "queued", pass: "completed" };

/** Run a continuity check of one chapter or all of them: first an estimate, then the run. */
function RunCheck({ data, label }: { data: BibleData; label: string }) {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const aiText = useAiBody("text");
  const [chapterId, setChapterId] = useState("");
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);
  const request = (confirm: boolean) =>
    post<Estimate>(`/projects/${projectId}/continuity-checks`, {
      ...aiText(),
      chapterId: chapterId || undefined,
      confirm,
    });
  const ask = async () => {
    setBusy(true);
    try {
      setEstimate(await request(false));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const run = async () => {
    setBusy(true);
    try {
      await request(true);
      setEstimate(null);
      await qc.invalidateQueries({ queryKey: reportKey(projectId) });
      toast.success("Continuity check queued");
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-wrap items-end gap-2">
      <Field label="Check">
        <select className="input" value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
          <option value="">Every chapter</option>
          {data.chapters.map((c) => (
            <option key={c.id} value={c.id}>
              Chapter {c.order}: {c.title}
            </option>
          ))}
        </select>
      </Field>
      <AiChip cap="text" />
      <button type="button" className="btn-primary" disabled={busy} onClick={ask}>
        {busy ? <Spinner /> : <ListChecks className="size-4" />} {label}
      </button>
      <ConfirmDialog
        open={Boolean(estimate)}
        title="Check continuity"
        confirmLabel={`Check ${estimate?.count ?? 0} chapter${estimate?.count === 1 ? "" : "s"}`}
        busy={busy}
        disabled={!estimate?.count}
        onClose={() => setEstimate(null)}
        onConfirm={run}
      >
        {estimate?.count ? (
          <p>
            One text request per chapter compares its scenes, panels and narration with the story bible and its
            neighbours, using {estimate.provider.model}.{" "}
            {estimate.estimatedUsd === null
              ? "No price is known for this model."
              : `About ${fmt.usd(estimate.estimatedUsd)}.`}
            {estimate.skipped ? ` ${estimate.skipped} chapter(s) with nothing planned or narrated are skipped.` : ""}
          </p>
        ) : (
          <p>Nothing to check yet: plan a chapter or write its narration first.</p>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** Where a finding is, as a link to the place to fix it. */
function PlaceLink({ f, chapters }: { f: ContinuityFindingRow; chapters: Report["chapters"] }) {
  const projectId = useProjectId();
  const ch = chapters.find((c) => c.id === f.chapterId);
  const label = `Ch. ${ch?.order ?? "?"} · ${f.place.ref}`;
  if (f.place.pageId && f.place.panelId)
    return (
      <Link
        className="underline"
        to="/projects/$projectId/pages/$pageId"
        params={{ projectId, pageId: f.place.pageId }}
        search={{ panelId: f.place.panelId }}
      >
        {label}
      </Link>
    );
  if (f.place.narrationLineId)
    return (
      <Link
        className="underline"
        to="/projects/$projectId/narration"
        params={{ projectId }}
        search={{ chapterId: f.chapterId }}
      >
        {label}
      </Link>
    );
  return (
    <Link
      className="underline"
      to="/projects/$projectId/chapters/$chapterId"
      params={{ projectId, chapterId: f.chapterId }}
    >
      {label}
    </Link>
  );
}

/** The contradiction queue: fix (go to the place), ignore with a reason, or explain with a new bible fact. */
export function ContinuityQueue({ data }: { data: BibleData }) {
  const projectId = useProjectId();
  const qc = useQueryClient();
  const q = useReport(projectId);
  const [status, setStatus] = useState<"open" | "resolved" | "all">("open");
  const [chapterId, setChapterId] = useState("");
  const [ignoring, setIgnoring] = useState<ContinuityFindingRow | null>(null);
  const [reason, setReason] = useState("");
  const [explaining, setExplaining] = useState<ContinuityFindingRow | null>(null);
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: reportKey(projectId) });
    await qc.invalidateQueries({ queryKey: bibleKey(projectId) });
  };
  const resolve = async (f: ContinuityFindingRow, next: "open" | "fixed" | "ignored", why = "") => {
    try {
      await patch(`/continuity-findings/${f.id}`, { status: next, reason: why });
      await refresh();
    } catch (e) {
      toast.error(e);
    }
  };
  const shown = (q.data?.findings ?? []).filter(
    (f) =>
      (!chapterId || f.chapterId === chapterId) &&
      (status === "all" || (status === "open" ? f.status === "open" : f.status !== "open")),
  );
  return (
    <div className="space-y-3">
      <RunCheck data={data} label="Check continuity" />
      {(q.data?.running ?? 0) > 0 && (
        <p className="muted flex items-center gap-2 text-sm">
          <Spinner /> {q.data!.running} chapter check{q.data!.running === 1 ? "" : "s"} running
        </p>
      )}
      <div className="flex flex-wrap items-end gap-3">
        <Tabs
          value={status}
          onChange={setStatus}
          tabs={[
            { value: "open", label: "Open" },
            { value: "resolved", label: "Resolved" },
            { value: "all", label: "All" },
          ]}
        />
        <Field label="Chapter">
          <select className="input" value={chapterId} onChange={(e) => setChapterId(e.target.value)}>
            <option value="">All chapters</option>
            {data.chapters.map((c) => (
              <option key={c.id} value={c.id}>
                Chapter {c.order}: {c.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      {q.data && !shown.length && (
        <EmptyState title={status === "open" ? "No open contradictions" : "Nothing here"}>
          A check compares each chapter's scenes, panels and narration with the bible and the chapters around it.
        </EmptyState>
      )}
      <ul className="space-y-2">
        {shown.map((f) => (
          <li key={f.id} className="card space-y-1.5 p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <StatusChip status={SEVERITY[f.severity] ?? "draft"} label={f.severity} />
              <PlaceLink f={f} chapters={q.data!.chapters} />
              {f.status !== "open" && <StatusChip status="completed" label={f.status} />}
            </div>
            <p>{f.message}</p>
            {f.quote && <p className="muted italic">“{f.quote}”</p>}
            {f.evidence && (
              <p className="muted text-xs">
                <ScrollText className="mr-1 inline size-3" />
                {f.evidence}
              </p>
            )}
            {f.status !== "open" && f.resolution && <p className="muted text-xs">Resolution: {f.resolution}</p>}
            <div className="flex flex-wrap gap-2 pt-1">
              {f.status === "open" ? (
                <>
                  <button type="button" className="btn-secondary text-xs" onClick={() => resolve(f, "fixed")}>
                    <Check className="size-3.5" /> Fixed
                  </button>
                  <button
                    type="button"
                    className="btn-secondary text-xs"
                    onClick={() => {
                      setReason("");
                      setIgnoring(f);
                    }}
                  >
                    <EyeOff className="size-3.5" /> Ignore
                  </button>
                  <button type="button" className="btn-secondary text-xs" onClick={() => setExplaining(f)}>
                    <ScrollText className="size-3.5" /> Explain
                  </button>
                </>
              ) : (
                <button type="button" className="btn-ghost text-xs" onClick={() => resolve(f, "open")}>
                  <RotateCcw className="size-3.5" /> Reopen
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      <Modal
        open={Boolean(ignoring)}
        onClose={() => setIgnoring(null)}
        title="Ignore this finding"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setIgnoring(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={!reason.trim()}
              onClick={async () => {
                await resolve(ignoring!, "ignored", reason);
                setIgnoring(null);
              }}
            >
              Ignore
            </button>
          </>
        }
      >
        <Field label="Why it is not a problem" hint="Later checks do not raise the same finding again.">
          <textarea
            className="input min-h-20"
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </Field>
      </Modal>
      {explaining && (
        <FactForm
          data={data}
          fact={null}
          title="Explain with a bible fact"
          initial={{ fromChapterId: explaining.chapterId }}
          onClose={() => setExplaining(null)}
          onSubmit={async (fact) => {
            await post(`/continuity-findings/${explaining.id}/explain`, { fact });
            await refresh();
          }}
        />
      )}
    </div>
  );
}

/** Each fixed rule as a test: its verdict in every checked chapter, from the latest check of each. */
export function RuleChecks({ data }: { data: BibleData }) {
  const projectId = useProjectId();
  const q = useReport(projectId);
  return (
    <div className="space-y-3">
      <RunCheck data={data} label="Run checks" />
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      {q.data && !q.data.rules.length && (
        <EmptyState title="No fixed rules">
          Mark a fact as fixed (“no guns exist in this world”, “scar on the LEFT jaw”) to check it as a rule.
        </EmptyState>
      )}
      <ul className="space-y-2">
        {q.data?.rules.map((r) => (
          <li key={r.factId} className="card space-y-2 p-3 text-sm">
            <div className="flex flex-wrap items-start gap-2">
              {r.verdict ? (
                <StatusChip status={VERDICT[r.verdict]} label={r.verdict} />
              ) : (
                <StatusChip status="draft" label="not checked" />
              )}
              <p className="min-w-0 flex-1">
                {r.subject && <strong>{r.subject}: </strong>}
                {r.text}
              </p>
            </div>
            {r.chapters.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {r.chapters.map((c) => (
                  <span key={c.chapterId} title={c.note || undefined}>
                    <StatusChip status={VERDICT[c.verdict]} label={`ch. ${c.order}: ${c.verdict}`} />
                  </span>
                ))}
              </div>
            )}
            {r.chapters
              .filter((c) => c.verdict !== "pass" && c.note)
              .map((c) => (
                <p key={c.chapterId} className="muted text-xs">
                  Ch. {c.order}: {c.note}
                </p>
              ))}
          </li>
        ))}
      </ul>
      <p className="muted text-xs">
        Checked by text: what the plan, panel specs, dialogue and narration say. The artwork itself is not looked at.
      </p>
    </div>
  );
}
