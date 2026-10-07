import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { RotateCcw, Search, Shield, UserPlus, Wrench, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { del, get, patch, post, put } from "../../api/client.ts";
import { useAction, useMe } from "../../api/hooks.ts";
import type { GenerationJobRow, UsageSummary, UserRow } from "../../api/types.ts";
import {
  EmptyState,
  ErrorBox,
  Field,
  fmt,
  KeyValue,
  Modal,
  PageHeader,
  Pager,
  Spinner,
  StatusChip,
  Tabs,
} from "../../components/ui.tsx";
import { JOB_STATUSES, JsonBlock, kindLabel } from "../generation/shared.tsx";
import { UsageDashboard } from "../usage/UsageDashboard.tsx";
import { StorageTab } from "./StorageTab.tsx";

type Tab = "overview" | "users" | "jobs" | "usage" | "rates" | "storage";
type Overview = {
  counts: Record<string, number>;
  queues: Record<string, Record<string, number>> | null;
  tts: { ok: boolean; state: string; detail?: string };
  disk: { totalBytes: number; freeBytes: number } | null;
  recentErrors: { id: string; source: string; code: string | null; message: string; createdAt: string }[];
  providers: {
    image: { provider: string; model: string; quality: string } | null;
    text: { provider: string; model: string } | null;
  };
  mockMode: boolean;
};

export function AdminPage() {
  const { data: me } = useMe();
  const search = useSearch({ strict: false }) as { tab?: Tab };
  const [tab, setTab] = useState<Tab>(search.tab ?? "overview");
  useEffect(() => {
    if (search.tab) setTab(search.tab);
  }, [search.tab]);
  if (me?.role !== "admin")
    return (
      <div className="p-6">
        <EmptyState icon={<Shield className="size-8" />} title="Administrators only">
          You do not have access to admin tools.
        </EmptyState>
      </div>
    );
  return (
    <div className="mx-auto max-w-7xl overflow-y-auto p-6">
      <PageHeader title="Admin" subtitle="Operations, accounts, jobs and cost." />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: "overview", label: "Overview" },
          { value: "users", label: "Users" },
          { value: "jobs", label: "Jobs" },
          { value: "usage", label: "Usage" },
          { value: "rates", label: "Rates" },
          { value: "storage", label: "Storage" },
        ]}
      />
      {tab === "overview" && <OverviewTab />}
      {tab === "users" && <UsersTab />}
      {tab === "jobs" && <JobsTab />}
      {tab === "usage" && <AdminUsage />}
      {tab === "rates" && <RatesTab />}
      {tab === "storage" && <StorageTab />}
    </div>
  );
}

function OverviewTab() {
  const q = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => get<Overview>("/admin/overview"),
    refetchInterval: 10_000,
  });
  const maint = useAction(() => post("/admin/maintenance"), { success: "Maintenance queued" });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Spinner />;
  const d = q.data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Object.entries(d.counts)
          .filter(([k]) => !k.endsWith("Bytes"))
          .map(([k, v]) => (
            <div key={k} className="card p-3">
              <div className="muted text-xs">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</div>
              <div className="text-xl font-semibold">{fmt.num(v)}</div>
            </div>
          ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="card p-4">
          <h2 className="mb-2 font-medium">System</h2>
          <KeyValue
            items={[
              ["Mode", d.mockMode ? <StatusChip key="m" status="queued" label="mock AI" /> : "live providers"],
              [
                "Image provider",
                d.providers.image
                  ? `${d.providers.image.provider} / ${d.providers.image.model} (${d.providers.image.quality})`
                  : "each user's own key",
              ],
              [
                "Text provider",
                d.providers.text ? `${d.providers.text.provider} / ${d.providers.text.model}` : "each user's own key",
              ],
              [
                "Kokoro",
                <span key="k">
                  <StatusChip
                    status={d.tts.ok ? "ready" : d.tts.state === "disabled" ? "draft" : "failed"}
                    label={d.tts.state}
                  />{" "}
                  {d.tts.detail && <span className="muted text-xs">{d.tts.detail}</span>}
                </span>,
              ],
              ["Asset storage", `${fmt.bytes(d.counts.assetBytes)} + ${fmt.bytes(d.counts.variantBytes)} derivatives`],
              [
                "Disk",
                d.disk ? `${fmt.bytes(d.disk.freeBytes)} free of ${fmt.bytes(d.disk.totalBytes)}` : "unavailable",
              ],
            ]}
          />
          <button
            type="button"
            className="btn-secondary mt-3"
            onClick={() => maint.mutate()}
            disabled={maint.isPending}
          >
            <Wrench className="size-4" /> Run maintenance now
          </button>
        </section>
        <section className="card overflow-x-auto p-4">
          <h2 className="mb-2 font-medium">Queues</h2>
          {!d.queues ? (
            <p className="muted text-sm">Redis unavailable</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="muted text-left">
                <tr>
                  {["Queue", "waiting", "prioritized", "active", "delayed", "failed", "completed"].map((h) => (
                    <th key={h} className="p-1.5 font-normal">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.entries(d.queues).map(([name, c]) => (
                  <tr key={name} className="border-t border-[var(--border)]">
                    <td className="p-1.5 font-medium">{name}</td>
                    {["waiting", "prioritized", "active", "delayed", "failed", "completed"].map((k) => (
                      <td key={k} className="p-1.5">
                        {c[k] ?? 0}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
      <CredentialEncryption />
      <section className="card p-4">
        <h2 className="mb-2 font-medium">Recent errors</h2>
        {!d.recentErrors.length ? (
          <p className="muted text-sm">No recorded errors.</p>
        ) : (
          <ul className="space-y-2 text-sm">
            {d.recentErrors.map((e) => (
              <li key={e.id} className="border-b border-[var(--border)] pb-2 last:border-0">
                <div className="muted text-xs">
                  {fmt.date(e.createdAt)} · {e.source}
                  {e.code ? ` · ${e.code}` : ""}
                </div>
                <details>
                  <summary className="cursor-pointer truncate">{e.message.split("\n")[0]}</summary>
                  <pre className="mt-1 overflow-auto text-xs whitespace-pre-wrap">{e.message}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

type EncryptionStatus = {
  primaryKeyId: string;
  configuredKeyIds: string[];
  byKey: Record<string, number>;
  pending: number;
};

/** API-key encryption: which key encrypts, how many saved keys still use an older key, and a manual rotate. */
function CredentialEncryption() {
  const q = useQuery({
    queryKey: ["admin", "credential-encryption"],
    queryFn: () => get<EncryptionStatus>("/admin/credentials/encryption"),
  });
  const rotate = useAction(() => post<{ rotated: number; failed: number }>("/admin/credentials/rotate"), {
    invalidate: [["admin", "credential-encryption"]],
    success: (r) => `Re-encrypted ${r.rotated} key(s)${r.failed ? `, ${r.failed} failed — see errors/logs` : ""}`,
  });
  if (!q.data) return q.error ? <ErrorBox error={q.error} /> : null;
  const d = q.data;
  return (
    <section className="card p-4">
      <h2 className="mb-2 font-medium">Saved API key encryption</h2>
      <KeyValue
        items={[
          ["Primary key id", <code key="p">{d.primaryKeyId}</code>],
          ["Keys that can decrypt", d.configuredKeyIds.join(", ")],
          [
            "Saved keys by encryption key",
            Object.entries(d.byKey).length
              ? Object.entries(d.byKey)
                  .map(([k, n]) => `${k === d.primaryKeyId ? `${k} (primary)` : k}: ${n}`)
                  .join(" · ")
              : "none",
          ],
          [
            "Pending rotation",
            d.pending ? <StatusChip key="r" status="queued" label={`${d.pending} to re-encrypt`} /> : "none",
          ],
        ]}
      />
      <p className="muted mt-2 text-xs">
        To rotate: set a new CREDENTIALS_ENCRYPTION_KEY, move the old one to CREDENTIALS_ENCRYPTION_OLD_KEYS and
        restart. Re-encryption runs on startup and during maintenance; both keys decrypt meanwhile. Remove the old key
        once pending is 0.
      </p>
      <button
        type="button"
        className="btn-secondary mt-3"
        onClick={() => rotate.mutate()}
        disabled={rotate.isPending || !d.pending}
      >
        Re-encrypt now
      </button>
    </section>
  );
}

type AdminUser = UserRow & { projects: number; lastSeen: string | null };
function UsersTab() {
  const { data: me } = useMe();
  const q = useQuery({ queryKey: ["admin", "users"], queryFn: () => get<{ users: AdminUser[] }>("/admin/users") });
  const update = useAction((v: { id: string; body: Record<string, string> }) => patch(`/admin/users/${v.id}`, v.body), {
    invalidate: [["admin", "users"]],
    success: "User updated",
  });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ username: "", email: "", password: "", role: "user" });
  const create = useAction(() => post("/admin/users", form), {
    invalidate: [["admin", "users"]],
    success: "Account created",
    onSuccess: () => {
      setCreating(false);
      setForm({ username: "", email: "", password: "", role: "user" });
    },
  });
  if (q.error) return <ErrorBox error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button type="button" className="btn-primary" onClick={() => setCreating(true)}>
          <UserPlus className="size-4" /> Create account
        </button>
      </div>
      {!q.data ? (
        <Spinner />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="muted text-left text-xs">
              <tr className="border-b border-[var(--border)]">
                {["User", "Role", "Status", "Projects", "Last seen", "Created", ""].map((h) => (
                  <th key={h} className="p-2 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.users.map((u) => (
                <tr key={u.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="p-2">
                    <div className="font-medium">{u.username}</div>
                    <div className="muted text-xs">{u.email}</div>
                  </td>
                  <td className="p-2">{u.role}</td>
                  <td className="p-2">
                    <StatusChip status={u.status} />
                  </td>
                  <td className="p-2">{u.projects}</td>
                  <td className="muted p-2 text-xs">{fmt.ago(u.lastSeen)}</td>
                  <td className="muted p-2 text-xs">{fmt.date(u.createdAt)}</td>
                  <td className="p-2 text-right">
                    {u.id !== me?.id && (
                      <div className="flex justify-end gap-1">
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() =>
                            update.mutate({ id: u.id, body: { status: u.status === "active" ? "disabled" : "active" } })
                          }
                        >
                          {u.status === "active" ? "Disable" : "Enable"}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() =>
                            update.mutate({ id: u.id, body: { role: u.role === "admin" ? "user" : "admin" } })
                          }
                        >
                          {u.role === "admin" ? "Demote" : "Make admin"}
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create account"
        footer={
          <>
            <button type="button" className="btn-secondary" onClick={() => setCreating(false)}>
              Cancel
            </button>
            <button type="button" className="btn-primary" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending && <Spinner />} Create
            </button>
          </>
        }
      >
        <div className="space-y-3">
          <Field label="Username">
            <input
              className="input"
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              autoComplete="off"
            />
          </Field>
          <Field label="Email">
            <input
              className="input"
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
          <Field label="Password" hint="At least 10 characters">
            <input
              className="input"
              type="password"
              value={form.password}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <Field label="Role">
            <select className="input" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </Field>
        </div>
      </Modal>
    </div>
  );
}

type AdminJob = Omit<GenerationJobRow, "compiledPrompt"> & { projectTitle: string };
const JOB_PAGE = 100;
function JobsTab() {
  const [status, setStatus] = useState("failed");
  const [page, setPage] = useState(0);
  const [inspect, setInspect] = useState<string | null>(null);
  const key = ["admin", "jobs", status, page];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      get<{ jobs: AdminJob[]; total: number }>(
        `/admin/jobs?limit=${JOB_PAGE}&offset=${page * JOB_PAGE}${status ? `&status=${status}` : ""}`,
      ),
    placeholderData: keepPreviousData,
  });
  const pager = (className?: string) => (
    <Pager
      page={page}
      size={JOB_PAGE}
      total={q.data?.total ?? 0}
      onPage={setPage}
      busy={q.isPlaceholderData}
      className={className}
    />
  );
  const retry = useAction((id: string) => post(`/admin/jobs/${id}/retry`), {
    invalidate: [key],
    success: "Retry queued",
  });
  const cancel = useAction((id: string) => post<{ result: string }>(`/admin/jobs/${id}/cancel`), {
    invalidate: [key],
    success: (r) => `Result: ${r.result.replace("_", " ")}`,
  });
  const detail = useQuery({
    queryKey: ["admin", "job", inspect],
    queryFn: () => get<{ job: GenerationJobRow; inputs: unknown[] }>(`/admin/jobs/${inspect}`),
    enabled: Boolean(inspect),
  });
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <select
          className="input w-auto"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setPage(0);
          }}
          aria-label="Status filter"
        >
          <option value="">All</option>
          {JOB_STATUSES.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </select>
        {pager("ml-auto")}
      </div>
      {q.error && <ErrorBox error={q.error} />}
      {!q.data ? (
        <Spinner />
      ) : !q.data.jobs.length ? (
        <EmptyState title="No jobs" />
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <tbody>
              {q.data.jobs.map((j) => (
                <tr key={j.id} className="border-b border-[var(--border)] align-top last:border-0">
                  <td className="p-2">
                    <div className="font-medium">{kindLabel(j.kind)}</div>
                    <div className="muted text-xs">
                      {j.projectTitle} · {fmt.ago(j.createdAt)}
                    </div>
                    {j.failureReason && <div className="text-xs text-red-500">{j.failureReason}</div>}
                  </td>
                  <td className="p-2">
                    <StatusChip status={j.status} />
                  </td>
                  <td className="p-2 text-xs">
                    {j.attempts}/{j.maxAttempts}
                  </td>
                  <td className="p-2 text-right">
                    <div className="flex justify-end gap-1">
                      <button type="button" className="btn-ghost" onClick={() => setInspect(j.id)}>
                        <Search className="size-4" /> Inspect
                      </button>
                      {(j.status === "failed" || j.status === "cancelled") && (
                        <button type="button" className="btn-ghost" onClick={() => retry.mutate(j.id)}>
                          <RotateCcw className="size-4" /> Retry
                        </button>
                      )}
                      {(j.status === "queued" || j.status === "processing") && (
                        <button type="button" className="btn-ghost" onClick={() => cancel.mutate(j.id)}>
                          <XCircle className="size-4" /> Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pager("mt-3")}
      <Modal open={Boolean(inspect)} onClose={() => setInspect(null)} title="Generation" wide="xl">
        {detail.error && <ErrorBox error={detail.error} />}
        {!detail.data ? (
          <Spinner />
        ) : (
          <div className="space-y-3">
            <div className="label">Compiled prompt</div>
            <pre className="max-h-80 overflow-auto rounded-lg bg-[var(--panel-2)] p-3 text-xs whitespace-pre-wrap">
              {detail.data.job.compiledPrompt ?? "—"}
            </pre>
            <div className="label">Job</div>
            <JsonBlock value={{ ...detail.data.job, compiledPrompt: undefined }} />
            <div className="label">Inputs</div>
            <JsonBlock value={detail.data.inputs} />
          </div>
        )}
      </Modal>
    </div>
  );
}

function AdminUsage() {
  const q = useQuery({ queryKey: ["admin", "usage"], queryFn: () => get<UsageSummary>("/admin/usage") });
  return (
    <div className="space-y-4">
      <ServerBudget />
      {q.error ? <ErrorBox error={q.error} /> : q.data ? <UsageDashboard data={q.data} /> : <Spinner />}
    </div>
  );
}

type InstanceBudget = {
  limitUsd: number | null;
  source: "admin" | "env" | "none";
  spentUsd: number;
  remainingUsd: number | null;
  exceeded: boolean;
  monthStart: string;
};

/** This month's spend across the whole server against the admin-set ceiling, and the form to change it. */
function ServerBudget() {
  const q = useQuery({
    queryKey: ["admin", "budget"],
    queryFn: () => get<{ budget: InstanceBudget; envDefaultUsd: number | null }>("/admin/budget"),
  });
  const [draft, setDraft] = useState<string | null>(null);
  const save = useAction((monthlyUsd: number | null) => put("/admin/budget", { monthlyUsd }), {
    invalidate: [["admin", "budget"]],
    success: "Server budget saved",
    onSuccess: () => setDraft(null),
  });
  const reset = useAction(() => del("/admin/budget"), {
    invalidate: [["admin", "budget"]],
    success: "Server budget reset to the default",
    onSuccess: () => setDraft(null),
  });
  if (!q.data) return q.error ? <ErrorBox error={q.error} /> : null;
  const { budget: b, envDefaultUsd } = q.data;
  const value = draft ?? (b.limitUsd === null ? "" : String(b.limitUsd));
  const pct = b.limitUsd ? Math.min(100, (b.spentUsd / b.limitUsd) * 100) : 0;
  const month = new Date(b.monthStart).toLocaleDateString([], { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <section className="card p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="mr-auto font-medium">Server budget · {month} (UTC)</h2>
        <span
          className={
            b.exceeded
              ? "chip bg-red-500/15 text-red-600 dark:text-red-300"
              : "chip bg-[var(--panel-2)] text-[var(--text)]"
          }
        >
          {fmt.usd(b.spentUsd)} {b.limitUsd === null ? "spent, no ceiling" : `of ${fmt.usd(b.limitUsd)}`}
        </span>
      </div>
      {b.limitUsd !== null && (
        <div
          className="mb-3 h-2 overflow-hidden rounded-full bg-[var(--panel-2)]"
          role="progressbar"
          aria-label="Server spend this month"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
        >
          <div
            className={b.exceeded ? "h-full bg-red-500" : pct >= 80 ? "h-full bg-amber-500" : "h-full bg-accent-500"}
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
      <p className="muted mb-3 text-sm">
        A ceiling on all AI spend on this server per calendar month, on top of each project's own cap. Once it is
        reached, new AI work is refused and queued batches pause until it is raised or the month turns. Nobody can
        confirm past it.
        {b.exceeded && " It is reached now."}
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(value === "" ? null : Math.max(0, Number(value)));
        }}
      >
        <div className="w-44">
          <Field label="Monthly ceiling (USD)">
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              placeholder="No ceiling"
              value={value}
              onChange={(e) => setDraft(e.target.value)}
            />
          </Field>
        </div>
        <button type="submit" className="btn-primary" disabled={save.isPending || draft === null}>
          Save
        </button>
        {b.source === "admin" && (
          <button type="button" className="btn-secondary" disabled={reset.isPending} onClick={() => reset.mutate()}>
            Use default
          </button>
        )}
      </form>
      <p className="muted mt-2 text-xs">
        {b.source === "admin"
          ? "Set here. "
          : b.source === "env"
            ? "From INSTANCE_BUDGET_USD_MONTHLY. "
            : "No ceiling set. "}
        Default from the environment: {envDefaultUsd === null ? "none" : fmt.usd(envDefaultUsd)}. Leave the field empty
        and save for no ceiling at all.
      </p>
    </section>
  );
}

type Rate = {
  id: string;
  provider: string;
  model: string;
  effectiveFrom: string;
  textInputRate: string;
  cachedInputRate: string;
  textOutputRate: string;
  imageInputRate: string;
  imageOutputRate: string;
  metadata: { note?: string };
};
const RATE_FIELDS = [
  "textInputRate",
  "cachedInputRate",
  "textOutputRate",
  "imageInputRate",
  "imageOutputRate",
] as const;
function RatesTab() {
  const q = useQuery({ queryKey: ["admin", "rates"], queryFn: () => get<{ rates: Rate[] }>("/admin/rates") });
  const [f, setF] = useState({
    provider: "openai",
    model: "gpt-image-2",
    effectiveFrom: new Date().toISOString().slice(0, 10),
    textInputRate: 0,
    cachedInputRate: 0,
    textOutputRate: 0,
    imageInputRate: 0,
    imageOutputRate: 0,
    note: "",
  });
  const add = useAction(() => post("/admin/rates", { ...f, effectiveFrom: new Date(f.effectiveFrom).toISOString() }), {
    invalidate: [["admin", "rates"]],
    success: "Rate snapshot added",
  });
  return (
    <div className="space-y-4">
      <p className="muted text-sm">
        Rates are editable estimates in USD per 1M tokens. Costs are computed from recorded provider token usage with
        the snapshot effective at call time; add a new snapshot when prices change.
      </p>
      {q.error && <ErrorBox error={q.error} />}
      {q.data && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="muted text-left text-xs">
              <tr className="border-b border-[var(--border)]">
                {[
                  "Provider",
                  "Model",
                  "Effective",
                  "Text in",
                  "Cached in",
                  "Text out",
                  "Image in",
                  "Image out",
                  "Note",
                ].map((h) => (
                  <th key={h} className="p-2 font-normal">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {q.data.rates.map((r) => (
                <tr key={r.id} className="border-b border-[var(--border)] last:border-0">
                  <td className="p-2">{r.provider}</td>
                  <td className="p-2">{r.model}</td>
                  <td className="p-2 text-xs">{fmt.date(r.effectiveFrom)}</td>
                  {RATE_FIELDS.map((k) => (
                    <td key={k} className="p-2">
                      ${Number(r[k])}
                    </td>
                  ))}
                  <td className="muted p-2 text-xs">{r.metadata.note ?? ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <form
        className="card grid gap-3 p-4 sm:grid-cols-4"
        onSubmit={(e) => {
          e.preventDefault();
          add.mutate();
        }}
      >
        <Field label="Provider">
          <input
            className="input"
            value={f.provider}
            onChange={(e) => setF({ ...f, provider: e.target.value })}
            required
          />
        </Field>
        <Field label="Model">
          <input className="input" value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} required />
        </Field>
        <Field label="Effective from">
          <input
            className="input"
            type="date"
            value={f.effectiveFrom}
            onChange={(e) => setF({ ...f, effectiveFrom: e.target.value })}
            required
          />
        </Field>
        <Field label="Note">
          <input className="input" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        </Field>
        {RATE_FIELDS.map((k) => (
          <Field key={k} label={`${k.replace("Rate", "").replace(/([A-Z])/g, " $1")} ($/1M)`}>
            <input
              className="input"
              type="number"
              step="0.000001"
              min={0}
              value={f[k]}
              onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })}
            />
          </Field>
        ))}
        <div className="flex items-end">
          <button type="submit" className="btn-primary w-full" disabled={add.isPending}>
            {add.isPending && <Spinner />} Add snapshot
          </button>
        </div>
      </form>
    </div>
  );
}
