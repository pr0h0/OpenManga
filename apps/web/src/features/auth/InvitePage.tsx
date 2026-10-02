import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { get, post } from "../../api/client.ts";
import { qk, useMe } from "../../api/hooks.ts";
import type { SessionUser } from "../../api/types.ts";
import { ErrorBox, Spinner } from "../../components/ui.tsx";
import { AuthCard } from "./AuthPages.tsx";

type InvitePreview = {
  email: string;
  role: "editor" | "viewer";
  projectTitle: string;
  invitedBy: string | null;
  expiresAt: string;
  accountExists: boolean;
};

/**
 * An emailed invitation link. Signed in to the invited address's account: accept. No account for that address:
 * create one here, which works even when registration is closed. Otherwise: sign in first.
 */
export function InvitePage() {
  const { token } = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useMe();
  const preview = useQuery({
    queryKey: ["invite-link", token],
    queryFn: () => get<{ invite: InvitePreview }>(`/public/invites/${encodeURIComponent(token ?? "")}`),
    enabled: Boolean(token),
    retry: false,
  });
  const [form, setForm] = useState({ username: "", displayName: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const go = (projectId: string) => navigate({ to: "/projects/$projectId", params: { projectId } });
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  const accept = () =>
    run(async () => {
      const r = await post<{ projectId: string }>("/invites/accept-link", { token });
      go(r.projectId);
    });
  const signup = (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setError(new Error("Passwords do not match"));
    void run(async () => {
      const r = await post<{ user: SessionUser; projectId: string }>("/auth/invite-signup", {
        token,
        username: form.username,
        password: form.password,
        ...(form.displayName.trim() ? { displayName: form.displayName } : {}),
      });
      qc.setQueryData(qk.me, r.user);
      go(r.projectId);
    });
  };
  const home = (
    <Link to="/" className="text-accent-500 hover:underline">
      Go to OpenManga
    </Link>
  );
  if (!token || preview.error)
    return (
      <AuthCard title="Invitation not available" footer={home}>
        <p className="text-sm">
          This invitation link is invalid, already used, revoked or expired. Ask the project's owner to invite you
          again.
        </p>
      </AuthCard>
    );
  if (!preview.data || me.isLoading)
    return (
      <div className="flex min-h-full items-center justify-center">
        <Spinner className="size-6" />
      </div>
    );
  const inv = preview.data.invite;
  const subtitle = `${inv.invitedBy ? `@${inv.invitedBy}` : "Someone"} invited ${inv.email} to “${inv.projectTitle}” as ${inv.role === "editor" ? "an editor" : "a viewer"}.`;
  const signedIn = me.data;
  if (signedIn) {
    const other = signedIn.email !== inv.email;
    return (
      <AuthCard title="Join project" subtitle={subtitle} footer={home}>
        {other && (
          <p className="mb-3 text-sm">
            You are signed in as {signedIn.username} ({signedIn.email}). This invitation is for {inv.email}: sign in
            with that account to accept it.
          </p>
        )}
        <ErrorBox error={error} title="Could not accept" />
        <button type="button" className="btn-primary w-full" disabled={busy || other} onClick={accept}>
          {busy && <Spinner />} Accept invitation
        </button>
      </AuthCard>
    );
  }
  if (inv.accountExists)
    return (
      <AuthCard title="Join project" subtitle={subtitle}>
        <p className="mb-3 text-sm">An account for {inv.email} already exists. Sign in to accept the invitation.</p>
        <Link
          to="/login"
          search={{ next: `${window.location.pathname}${window.location.search}` }}
          className="btn-primary w-full justify-center"
        >
          Sign in
        </Link>
      </AuthCard>
    );
  return (
    <AuthCard title="Create your account" subtitle={subtitle}>
      <form onSubmit={signup} className="space-y-3">
        <div>
          <span className="label">Email</span>
          <div className="input muted truncate">{inv.email}</div>
        </div>
        <div>
          <label htmlFor="inv-username" className="label">
            Username
          </label>
          <input
            id="inv-username"
            className="input"
            autoComplete="username"
            value={form.username}
            onChange={set("username")}
            required
            minLength={3}
            maxLength={32}
            pattern="[A-Za-z0-9_][A-Za-z0-9_.\-]{2,31}"
            title="3-32 letters, digits, _ . -"
          />
        </div>
        <div>
          <label htmlFor="inv-name" className="label">
            Display name (optional)
          </label>
          <input
            id="inv-name"
            className="input"
            value={form.displayName}
            onChange={set("displayName")}
            maxLength={80}
          />
        </div>
        <div>
          <label htmlFor="inv-pw" className="label">
            Password (min 10 characters)
          </label>
          <input
            id="inv-pw"
            className="input"
            type="password"
            autoComplete="new-password"
            value={form.password}
            onChange={set("password")}
            required
            minLength={10}
          />
        </div>
        <div>
          <label htmlFor="inv-pw2" className="label">
            Confirm password
          </label>
          <input
            id="inv-pw2"
            className="input"
            type="password"
            autoComplete="new-password"
            value={form.confirm}
            onChange={set("confirm")}
            required
            minLength={10}
          />
        </div>
        <ErrorBox error={error} title="Could not create account" />
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy && <Spinner />} Create account and join
        </button>
      </form>
    </AuthCard>
  );
}
