import { useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Bot, Check, Copy, KeyRound, ShieldCheck, Trash2, X } from "lucide-react";
import { useState } from "react";
import { del, get, patch, post } from "../../api/client.ts";
import { useAction } from "../../api/hooks.ts";
import {
  ConfirmDialog,
  EmptyState,
  ErrorBox,
  Field,
  fmt,
  Modal,
  PageHeader,
  Spinner,
  StatusChip,
  Tabs,
} from "../../components/ui.tsx";

export type Grant = {
  name: string;
  scopes: string[];
  projectAccess: "all" | "selected";
  projectIds: string[];
  allowProjectCreate: boolean;
  approvalMode: "ALLOW_ALL" | "REQUIRE_APPROVAL";
};

type Info = {
  enabled: boolean;
  endpoint: string;
  issuer: string;
  scopes: { scope: string; description: string }[];
  approvalTtlMinutes: number;
};
type Connection = Omit<Grant, "projectIds"> & {
  id: string;
  kind: "oauth" | "pat";
  clientId: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  projects: { id: string; title: string }[];
  tokens: { id: string; hint: string; expiresAt: string | null; lastUsedAt: string | null; revokedAt: string | null }[];
};
type Approval = {
  id: string;
  status: string;
  tool: string;
  action: string;
  summary: string;
  sensitivity: string;
  estimate: { estimatedUsd?: number | null; count?: number } | null;
  decisionReason: string | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
  arguments: Record<string, unknown>;
  connection: { id: string; name: string } | null;
  project: { id: string; title: string } | null;
};
type Rule = {
  id: string;
  actionKey: string;
  decision: "ALLOW" | "DENY";
  connection: string;
  project: string;
  updatedAt: string;
};

const keys = {
  info: ["agents", "info"],
  connections: ["agents", "connections"],
  approvals: (v: string) => ["agents", "approvals", v],
  rules: ["agents", "rules"],
} as const;

export const useAgentInfo = () => useQuery({ queryKey: keys.info, queryFn: () => get<Info>("/agents/info") });

/** Scopes, project access, project creation and approval mode: the same form for a token, a connection and consent. */
export function GrantEditor({
  value,
  onChange,
  offered,
  nameLabel = "Connection name",
}: {
  value: Grant;
  onChange: (g: Grant) => void;
  offered?: string[];
  nameLabel?: string;
}) {
  const info = useAgentInfo();
  const projects = useQuery({
    queryKey: ["projects", "all-for-agents"],
    queryFn: () => get<{ projects: { id: string; title: string }[] }>("/projects?status=all"),
  });
  const scopes = (info.data?.scopes ?? []).filter((s) => !offered || offered.includes(s.scope));
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  return (
    <div className="space-y-4">
      <Field label={nameLabel}>
        <input
          className="input"
          value={value.name}
          maxLength={100}
          onChange={(e) => onChange({ ...value, name: e.target.value })}
        />
      </Field>
      <fieldset>
        <legend className="label">What it may do</legend>
        <div className="mb-2 flex gap-2 text-xs">
          <button
            type="button"
            className="btn-ghost px-2 py-1"
            onClick={() => onChange({ ...value, scopes: scopes.map((s) => s.scope) })}
          >
            All
          </button>
          <button
            type="button"
            className="btn-ghost px-2 py-1"
            onClick={() =>
              onChange({ ...value, scopes: scopes.filter((s) => s.scope.endsWith(":read")).map((s) => s.scope) })
            }
          >
            Read only
          </button>
          <button type="button" className="btn-ghost px-2 py-1" onClick={() => onChange({ ...value, scopes: [] })}>
            None
          </button>
        </div>
        <div className="grid gap-1 sm:grid-cols-2">
          {scopes.map((s) => (
            <label
              key={s.scope}
              className="flex items-start gap-2 rounded px-1 py-0.5 text-sm hover:bg-[var(--panel-2)]"
            >
              <input
                type="checkbox"
                className="mt-1"
                checked={value.scopes.includes(s.scope)}
                onChange={() => onChange({ ...value, scopes: toggle(value.scopes, s.scope) })}
              />
              <span>
                <code className="text-xs">{s.scope}</code>
                <span className="muted block text-xs">{s.description}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="label">Projects</legend>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={value.projectAccess === "selected"}
            onChange={() => onChange({ ...value, projectAccess: "selected" })}
          />
          Only the projects I choose
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            checked={value.projectAccess === "all"}
            onChange={() => onChange({ ...value, projectAccess: "all" })}
          />
          All my projects, including future ones
        </label>
        {value.projectAccess === "selected" && (
          <div className="max-h-48 overflow-y-auto rounded border border-[var(--border)] p-2">
            {projects.isLoading && <Spinner />}
            {projects.data?.projects.length === 0 && <p className="muted text-sm">You have no projects yet.</p>}
            {projects.data?.projects.map((p) => (
              <label key={p.id} className="flex items-center gap-2 py-0.5 text-sm">
                <input
                  type="checkbox"
                  checked={value.projectIds.includes(p.id)}
                  onChange={() => onChange({ ...value, projectIds: toggle(value.projectIds, p.id) })}
                />
                {p.title}
              </label>
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={value.allowProjectCreate}
            onChange={(e) => onChange({ ...value, allowProjectCreate: e.target.checked })}
          />
          May create new projects{" "}
          {value.projectAccess === "selected" && (
            <span className="muted">(and gets access to the ones it creates)</span>
          )}
        </label>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="label">Approvals</legend>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            className="mt-1"
            checked={value.approvalMode === "REQUIRE_APPROVAL"}
            onChange={() => onChange({ ...value, approvalMode: "REQUIRE_APPROVAL" })}
          />
          <span>
            Ask me first <span className="muted">(recommended)</span>
            <span className="muted block text-xs">
              Reading and ordinary edits run at once. Spending provider credits, deleting, applying analyses, locking
              versions and exports wait for you here.
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            className="mt-1"
            checked={value.approvalMode === "ALLOW_ALL"}
            onChange={() => onChange({ ...value, approvalMode: "ALLOW_ALL" })}
          />
          <span>
            Allow everything it has scopes for
            <span className="muted block text-xs">Budgets, locked versions and project access still apply.</span>
          </span>
        </label>
      </fieldset>
    </div>
  );
}

const emptyGrant = (name: string): Grant => ({
  name,
  scopes: [],
  projectAccess: "selected",
  projectIds: [],
  allowProjectCreate: false,
  approvalMode: "REQUIRE_APPROVAL",
});

function TokenWizard({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [grant, setGrant] = useState<Grant>(emptyGrant("My agent"));
  const [expires, setExpires] = useState<string>("90");
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const info = useAgentInfo();
  const create = useAction(
    () => post<{ token: string }>("/agents/tokens", { ...grant, expiresInDays: expires ? Number(expires) : null }),
    { invalidate: [keys.connections], onSuccess: (r) => setToken(r.token) },
  );
  const close = () => {
    setToken(null);
    setCopied(false);
    setGrant(emptyGrant("My agent"));
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      wide
      title={token ? "Your new access token" : "New personal access token"}
      footer={
        token ? (
          <button type="button" className="btn-primary" onClick={close}>
            Done
          </button>
        ) : (
          <>
            <button type="button" className="btn-secondary" onClick={close}>
              Cancel
            </button>
            <button
              type="button"
              className="btn-primary"
              disabled={create.isPending || !grant.name.trim() || !grant.scopes.length}
              onClick={() => create.mutate()}
            >
              {create.isPending && <Spinner />} Create token
            </button>
          </>
        )
      }
    >
      {token ? (
        <div className="space-y-3 text-sm">
          <p>
            Copy it now. <strong>It will not be shown again</strong>; only a fingerprint of it is stored. If you lose
            it, revoke this connection and create a new token.
          </p>
          <div className="flex items-center gap-2">
            <code className="block flex-1 break-all rounded bg-[var(--panel-2)] p-2 text-xs">{token}</code>
            <button
              type="button"
              className="btn-secondary"
              onClick={async () => {
                await navigator.clipboard.writeText(token);
                setCopied(true);
              }}
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />} {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="muted">
            Point your agent at <code>{info.data?.endpoint}</code> (MCP, Streamable HTTP) with the header{" "}
            <code>Authorization: Bearer &lt;token&gt;</code>.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="muted text-sm">
            For MCP agents other than ChatGPT (ChatGPT connects with OAuth and asks you here instead). The agent acts as
            you, limited to what you choose below.
          </p>
          <GrantEditor value={grant} onChange={setGrant} />
          <Field label="Expires">
            <select className="input" value={expires} onChange={(e) => setExpires(e.target.value)}>
              <option value="7">in 7 days</option>
              <option value="30">in 30 days</option>
              <option value="90">in 90 days</option>
              <option value="365">in a year</option>
              <option value="">never</option>
            </select>
          </Field>
        </div>
      )}
    </Modal>
  );
}

function EditConnection({ connection, onClose }: { connection: Connection; onClose: () => void }) {
  const [grant, setGrant] = useState<Grant>({ ...connection, projectIds: connection.projects.map((p) => p.id) });
  const save = useAction(() => patch(`/agents/connections/${connection.id}`, grant), {
    invalidate: [keys.connections],
    success: "Connection updated",
    onSuccess: onClose,
  });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`Edit ${connection.name}`}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={save.isPending || !grant.scopes.length}
            onClick={() => save.mutate()}
          >
            {save.isPending && <Spinner />} Save
          </button>
        </>
      }
    >
      <p className="muted mb-3 text-sm">
        Changes apply to its very next call; narrowing never waits for a token to expire.
      </p>
      <GrantEditor value={grant} onChange={setGrant} />
    </Modal>
  );
}

function Connections() {
  const q = useQuery({
    queryKey: keys.connections,
    queryFn: () => get<{ connections: Connection[] }>("/agents/connections"),
  });
  const [wizard, setWizard] = useState(false);
  const [editing, setEditing] = useState<Connection | null>(null);
  const [revoking, setRevoking] = useState<Connection | null>(null);
  const revoke = useAction((id: string) => post(`/agents/connections/${id}/revoke`), {
    invalidate: [keys.connections],
    success: "Connection revoked",
    onSuccess: () => setRevoking(null),
  });
  const info = useAgentInfo();
  return (
    <div className="space-y-3">
      <div className="card space-y-1 p-4 text-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            MCP endpoint: <code>{info.data?.endpoint ?? "…"}</code>
          </div>
          <button type="button" className="btn-primary" onClick={() => setWizard(true)}>
            <KeyRound className="size-4" /> New access token
          </button>
        </div>
        <p className="muted text-xs">
          In ChatGPT, add this URL as a connector; it signs in with OAuth and you approve it here. Other agents use a
          personal access token.
        </p>
      </div>
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} />
      {q.data?.connections.length === 0 && (
        <EmptyState icon={<Bot className="size-8" />} title="No agents connected">
          Connect ChatGPT with the endpoint above, or create a personal access token for another MCP agent.
        </EmptyState>
      )}
      {q.data?.connections.map((c) => (
        <div key={c.id} className={`card p-4 ${c.revokedAt ? "opacity-60" : ""}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <div className="flex items-center gap-2 font-medium">
                {c.name}
                <span className="chip">{c.kind === "oauth" ? "ChatGPT / OAuth" : "Access token"}</span>
                {c.revokedAt ? (
                  <StatusChip status="cancelled" label="revoked" />
                ) : (
                  <StatusChip status="completed" label="active" />
                )}
              </div>
              <div className="muted mt-1 text-xs">
                Connected {fmt.date(c.createdAt)} · last used {fmt.ago(c.lastUsedAt)}
                {c.tokens.map((t) => (
                  <span key={t.id}>
                    {" "}
                    · token …{t.hint} {t.expiresAt ? `expires ${fmt.date(t.expiresAt)}` : "never expires"}
                  </span>
                ))}
              </div>
            </div>
            {!c.revokedAt && (
              <div className="flex gap-2">
                <button type="button" className="btn-secondary" onClick={() => setEditing(c)}>
                  Edit
                </button>
                <button type="button" className="btn-danger" onClick={() => setRevoking(c)}>
                  Revoke
                </button>
              </div>
            )}
          </div>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
            <div>
              <div className="label">Approvals</div>
              {c.approvalMode === "ALLOW_ALL" ? "Allow everything" : "Ask me first"}
            </div>
            <div>
              <div className="label">Projects</div>
              {c.projectAccess === "all" ? "All projects" : c.projects.map((p) => p.title).join(", ") || "None yet"}
              {c.allowProjectCreate && " · can create"}
            </div>
            <div>
              <div className="label">Scopes</div>
              <span className="break-words">{c.scopes.join(", ") || "none"}</span>
            </div>
          </div>
        </div>
      ))}
      <TokenWizard open={wizard} onClose={() => setWizard(false)} />
      {editing && <EditConnection connection={editing} onClose={() => setEditing(null)} />}
      <ConfirmDialog
        open={Boolean(revoking)}
        title="Revoke connection"
        danger
        confirmLabel="Revoke"
        busy={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
        onClose={() => setRevoking(null)}
      >
        {revoking?.name} loses access immediately. Its tokens stop working and anything waiting for your approval is
        cancelled.
      </ConfirmDialog>
    </div>
  );
}

const SENSITIVITY: Record<string, string> = {
  spend: "Spends provider credits",
  delete: "Deletes",
  "sensitive-write": "Sensitive change",
  write: "Edit",
  read: "Read",
};

function ApprovalCard({ a, focused }: { a: Approval; focused: boolean }) {
  const [reason, setReason] = useState("");
  const [showArgs, setShowArgs] = useState(false);
  const decide = useAction(
    (d: { decision: "approve" | "deny"; remember: boolean }) =>
      post<{ approval: Approval }>(`/agents/approvals/${a.id}/decide`, { ...d, reason: reason || undefined }),
    {
      invalidate: [keys.approvals("pending"), keys.approvals("history"), keys.rules],
      success: (r) =>
        r.approval.status === "executed"
          ? "Approved and done"
          : r.approval.status === "denied"
            ? "Denied"
            : r.approval.status === "stale"
              ? "Not run: what it acted on changed meanwhile"
              : r.approval.status === "execution_unknown"
                ? "Interrupted: check whether it took effect before trying again"
                : `Approved, but it failed: ${r.approval.error?.message ?? r.approval.status}`,
    },
  );
  const pending = a.status === "pending";
  return (
    <div className={`card space-y-2 p-4 ${focused ? "ring-2 ring-accent-500" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="chip">{SENSITIVITY[a.sensitivity] ?? a.sensitivity}</span>
        <span className="font-medium">{a.summary}</span>
        {!pending && (
          <StatusChip
            status={
              a.status === "executed"
                ? "completed"
                : a.status === "denied"
                  ? "cancelled"
                  : a.status === "failed" || a.status === "execution_unknown"
                    ? "failed"
                    : a.status === "approved"
                      ? "processing"
                      : "queued"
            }
            label={
              a.status === "execution_unknown" ? "outcome unknown" : a.status === "approved" ? "running" : a.status
            }
          />
        )}
      </div>
      <div className="muted text-xs">
        {a.connection?.name ?? "A connection"} · {a.project?.title ?? "no project"} · <code>{a.action}</code> via{" "}
        <code>{a.tool}</code> · {fmt.ago(a.createdAt)}
        {pending && ` · expires ${fmt.date(a.expiresAt)}`}
        {a.estimate?.estimatedUsd != null && ` · about ${fmt.usd(a.estimate.estimatedUsd)}`}
        {a.estimate?.count != null && ` · ${a.estimate.count} item(s)`}
      </div>
      {a.decisionReason && <p className="text-sm">Reason: {a.decisionReason}</p>}
      {a.error && a.status !== "denied" && <p className="text-sm text-red-500">{a.error.message}</p>}
      <button type="button" className="btn-ghost px-1 text-xs" onClick={() => setShowArgs(!showArgs)}>
        {showArgs ? "Hide" : "Show"} exact request
      </button>
      {showArgs && (
        <pre className="max-h-64 overflow-auto rounded bg-[var(--panel-2)] p-2 text-xs">
          {JSON.stringify(a.arguments, null, 2)}
        </pre>
      )}
      {pending && (
        <div className="space-y-2">
          <input
            className="input"
            placeholder="Reason (optional, shown to the agent when denied)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ decision: "approve", remember: false })}
            >
              <Check className="size-4" /> Approve
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={decide.isPending || !a.project}
              title={a.project ? undefined : "Only project actions can be remembered"}
              onClick={() => decide.mutate({ decision: "approve", remember: true })}
            >
              Approve & always allow in this project
            </button>
            <button
              type="button"
              className="btn-danger"
              disabled={decide.isPending}
              onClick={() => decide.mutate({ decision: "deny", remember: false })}
            >
              <X className="size-4" /> Deny
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={decide.isPending || !a.project}
              onClick={() => decide.mutate({ decision: "deny", remember: true })}
            >
              Deny & always deny in this project
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Approvals({ view, focus }: { view: "pending" | "history"; focus?: string }) {
  const q = useQuery({
    queryKey: keys.approvals(view),
    queryFn: () => get<{ approvals: Approval[] }>(`/agents/approvals?view=${view}`),
    refetchInterval: view === "pending" ? 10_000 : false,
  });
  if (q.isLoading) return <Spinner />;
  if (q.error) return <ErrorBox error={q.error} />;
  if (!q.data?.approvals.length)
    return (
      <EmptyState
        icon={<ShieldCheck className="size-8" />}
        title={view === "pending" ? "Nothing waiting for you" : "No decisions yet"}
      >
        {view === "pending" ? "When an agent asks to do something sensitive, it appears here." : undefined}
      </EmptyState>
    );
  return (
    <div className="space-y-3">
      {q.data.approvals.map((a) => (
        <ApprovalCard key={a.id} a={a} focused={a.id === focus} />
      ))}
    </div>
  );
}

function Rules() {
  const q = useQuery({ queryKey: keys.rules, queryFn: () => get<{ rules: Rule[] }>("/agents/rules") });
  const flip = useAction(
    (r: Rule) => patch(`/agents/rules/${r.id}`, { decision: r.decision === "ALLOW" ? "DENY" : "ALLOW" }),
    {
      invalidate: [keys.rules],
      success: "Rule changed",
    },
  );
  const remove = useAction((id: string) => del(`/agents/rules/${id}`), {
    invalidate: [keys.rules],
    success: "Rule removed; it will ask again",
  });
  if (q.isLoading) return <Spinner />;
  if (!q.data?.rules.length)
    return (
      <EmptyState title="No remembered decisions">
        "Always allow" and "always deny" choices appear here, per connection, project and action. Change or remove them
        any time.
      </EmptyState>
    );
  return (
    <div className="card divide-y divide-[var(--border)]">
      {q.data.rules.map((r) => (
        <div key={r.id} className="flex flex-wrap items-center gap-3 p-3 text-sm">
          <span className={`chip ${r.decision === "ALLOW" ? "bg-green-500/15" : "bg-red-500/15"}`}>
            {r.decision === "ALLOW" ? "Always allow" : "Always deny"}
          </span>
          <code className="text-xs">{r.actionKey}</code>
          <span className="muted">
            {r.connection} · {r.project} · {fmt.ago(r.updatedAt)}
          </span>
          <div className="ml-auto flex gap-2">
            <button type="button" className="btn-secondary" disabled={flip.isPending} onClick={() => flip.mutate(r)}>
              Switch to {r.decision === "ALLOW" ? "deny" : "allow"}
            </button>
            <button type="button" className="btn-ghost" aria-label="Remove rule" onClick={() => remove.mutate(r.id)}>
              <Trash2 className="size-4" />
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

type Tab = "connections" | "pending" | "history" | "rules";

export function AgentsPage() {
  const search = useSearch({ strict: false }) as { tab?: Tab; request?: string };
  const navigate = useNavigate();
  const tab: Tab = search.tab ?? "connections";
  const pending = useQuery({
    queryKey: keys.approvals("pending"),
    queryFn: () => get<{ approvals: Approval[] }>("/agents/approvals?view=pending"),
  });
  const waiting = pending.data?.approvals.length ?? 0;
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader
        title="Agent access"
        subtitle="AI agents (ChatGPT and other MCP clients) that can work on your projects as you, and what they have asked to do."
      />
      <Tabs<Tab>
        value={tab}
        onChange={(t) => navigate({ to: "/agents", search: { tab: t } })}
        tabs={[
          { value: "connections", label: "Connections" },
          { value: "pending", label: waiting ? `Waiting for you (${waiting})` : "Waiting for you" },
          { value: "history", label: "History" },
          { value: "rules", label: "Remembered decisions" },
        ]}
      />
      {tab === "connections" && <Connections />}
      {(tab === "pending" || tab === "history") && <Approvals view={tab} focus={search.request} />}
      {tab === "rules" && <Rules />}
    </div>
  );
}
