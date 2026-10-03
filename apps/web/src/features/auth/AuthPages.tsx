import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useState } from "react";
import { get, post } from "../../api/client.ts";
import { qk } from "../../api/hooks.ts";
import type { SessionUser } from "../../api/types.ts";
import { Logo } from "../../components/Logo.tsx";
import { ErrorBox, Spinner } from "../../components/ui.tsx";

type AuthConfig = { registrationEnabled: boolean; devMailboxEnabled: boolean };
const useAuthConfig = () =>
  useQuery({ queryKey: qk.authConfig, queryFn: () => get<AuthConfig>("/auth/config"), staleTime: 300_000 });

export function AuthCard({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2 text-lg font-semibold">
          <Logo className="size-6 text-accent-500" /> OpenManga
        </div>
        <div className="card p-6 shadow-sm">
          <h1 className="text-lg font-semibold">{title}</h1>
          {subtitle && <p className="muted mt-1 text-sm">{subtitle}</p>}
          <div className="mt-5">{children}</div>
        </div>
        {footer && <div className="muted mt-4 text-center text-sm">{footer}</div>}
      </div>
    </div>
  );
}

function safeNext(next: string | undefined) {
  if (!next) return "/";
  try {
    const u = new URL(next, window.location.origin);
    if (u.origin !== window.location.origin) return "/";
    return u.pathname.replace(/^\/app/, "") + u.search || "/";
  } catch {
    return "/";
  }
}

export function LoginPage() {
  const { next } = useSearch({ strict: false }) as { next?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cfg = useAuthConfig();
  const [identifier, setIdentifier] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ user: SessionUser }>("/auth/login", { identifier, password });
      qc.setQueryData(qk.me, r.user);
      navigate({ to: safeNext(next) });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard
      title="Sign in"
      subtitle="Use your username or email."
      footer={
        cfg.data?.registrationEnabled && (
          <>
            New here?{" "}
            <Link to="/register" className="text-accent-500 hover:underline">
              Create an account
            </Link>
          </>
        )
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="identifier" className="label">
            Username or email
          </label>
          <input
            id="identifier"
            className="input"
            autoComplete="username"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div>
          <label htmlFor="password" className="label">
            Password
          </label>
          <input
            id="password"
            className="input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <ErrorBox error={error} title="Sign-in failed" />
        <button type="submit" className="btn-primary w-full" disabled={busy}>
          {busy && <Spinner />} Sign in
        </button>
        <div className="flex justify-between text-xs">
          <Link to="/forgot-password" className="muted hover:underline">
            Forgot password?
          </Link>
          {cfg.data?.devMailboxEnabled && (
            <Link to="/dev/mailbox" className="muted hover:underline">
              Dev mailbox
            </Link>
          )}
        </div>
      </form>
    </AuthCard>
  );
}

export function RegisterPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const cfg = useAuthConfig();
  const [form, setForm] = useState({ username: "", email: "", password: "", confirm: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (form.password !== form.confirm) return setError(new Error("Passwords do not match"));
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ user: SessionUser }>("/auth/register", {
        username: form.username,
        email: form.email,
        password: form.password,
      });
      qc.setQueryData(qk.me, r.user);
      navigate({ to: "/" });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (cfg.data && !cfg.data.registrationEnabled)
    return (
      <AuthCard
        title="Registration disabled"
        footer={
          <Link to="/login" search={{}} className="text-accent-500 hover:underline">
            Back to sign in
          </Link>
        }
      >
        <p className="text-sm">Accounts on this server are created by an administrator.</p>
      </AuthCard>
    );
  return (
    <AuthCard
      title="Create account"
      footer={
        <>
          Already have an account?{" "}
          <Link to="/login" search={{}} className="text-accent-500 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label htmlFor="username" className="label">
            Username
          </label>
          <input
            id="username"
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
          <label htmlFor="email" className="label">
            Email
          </label>
          <input
            id="email"
            className="input"
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={set("email")}
            required
          />
        </div>
        <div>
          <label htmlFor="pw" className="label">
            Password (min 10 characters)
          </label>
          <input
            id="pw"
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
          <label htmlFor="pw2" className="label">
            Confirm password
          </label>
          <input
            id="pw2"
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
          {busy && <Spinner />} Create account
        </button>
      </form>
    </AuthCard>
  );
}

export function ForgotPasswordPage() {
  const cfg = useAuthConfig();
  const [identifier, setIdentifier] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post("/auth/password-reset/request", { identifier });
      setSent(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthCard
      title="Reset password"
      subtitle="We'll send a one-time reset link."
      footer={
        <Link to="/login" search={{}} className="text-accent-500 hover:underline">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <div className="space-y-2 text-sm">
          <p>If an account exists for that username or email, a reset link has been sent. It expires in one hour.</p>
          {cfg.data?.devMailboxEnabled && (
            <p className="muted">
              Email delivery is mocked on this server. The message is stored in the{" "}
              <Link to="/dev/mailbox" className="text-accent-500 hover:underline">
                dev mailbox
              </Link>{" "}
              (administrators only in production).
            </p>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="rid" className="label">
              Username or email
            </label>
            <input
              id="rid"
              className="input"
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
              autoFocus
            />
          </div>
          <ErrorBox error={error} />
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy && <Spinner />} Send reset link
          </button>
        </form>
      )}
    </AuthCard>
  );
}

export function ResetPasswordPage() {
  const { token } = useSearch({ strict: false }) as { token?: string };
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) return setError(new Error("Passwords do not match"));
    setBusy(true);
    setError(null);
    try {
      await post("/auth/password-reset/confirm", { token, password });
      setDone(true);
      setTimeout(() => navigate({ to: "/login", search: {} }), 1500);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (!token)
    return (
      <AuthCard
        title="Invalid link"
        footer={
          <Link to="/forgot-password" className="text-accent-500 hover:underline">
            Request a new link
          </Link>
        }
      >
        <p className="text-sm">This reset link is missing its token.</p>
      </AuthCard>
    );
  return (
    <AuthCard title="Choose a new password" subtitle="All existing sessions will be signed out.">
      {done ? (
        <p className="text-sm">Password updated. Redirecting to sign in…</p>
      ) : (
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="np" className="label">
              New password (min 10 characters)
            </label>
            <input
              id="np"
              className="input"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={10}
              autoFocus
            />
          </div>
          <div>
            <label htmlFor="np2" className="label">
              Confirm password
            </label>
            <input
              id="np2"
              className="input"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={10}
            />
          </div>
          <ErrorBox error={error} />
          <button type="submit" className="btn-primary w-full" disabled={busy}>
            {busy && <Spinner />} Update password
          </button>
        </form>
      )}
    </AuthCard>
  );
}
