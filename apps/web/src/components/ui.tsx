import { Link } from "@tanstack/react-router";
import clsx from "clsx";
import { AlertTriangle, CheckCircle2, CircleDashed, ImageOff, Loader2, X } from "lucide-react";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { create } from "zustand";
import { assetUrl, errorMessage } from "../api/client.ts";

export { clsx };

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={clsx("animate-spin", className ?? "size-4")} aria-label="Loading" />;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="muted mt-0.5 text-sm">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <div className="muted">{icon ?? <CircleDashed className="size-8" />}</div>
      <h3 className="font-medium">{title}</h3>
      {children && <div className="muted max-w-md text-sm">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorBox({
  error,
  title = "Something went wrong",
  onRetry,
}: {
  error: unknown;
  title?: string;
  onRetry?: () => void;
}) {
  if (!error) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-sm text-red-600 dark:text-red-300"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-medium">{title}</div>
        <div className="break-words">{errorMessage(error)}</div>
      </div>
      {onRetry && (
        <button type="button" className="btn-secondary" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

const STATUS_STYLE: Record<string, string> = {
  completed: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  ready: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  approved: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  applied: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  locked: "bg-violet-500/15 text-violet-600 dark:text-violet-300",
  processing: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  generating: "bg-sky-500/15 text-sky-600 dark:text-sky-300",
  queued: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  /** Waiting in a provider's batch: paid for, arriving within 24h. */
  submitted: "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  /** Parked for a pasted answer: nothing will happen until someone answers it. */
  awaiting_input: "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  pending: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "prompt-ready": "bg-indigo-500/15 text-indigo-600 dark:text-indigo-300",
  failed: "bg-red-500/15 text-red-600 dark:text-red-300",
  cancel_requested: "bg-orange-500/15 text-orange-600 dark:text-orange-300",
  cancelled: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  superseded: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  draft: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  planned: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  none: "bg-zinc-500/10 text-zinc-500",
  archived: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-300",
  active: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-300",
  disabled: "bg-red-500/15 text-red-600 dark:text-red-300",
};

export function StatusChip({ status, label }: { status: string; label?: string }) {
  const spinning = status === "processing" || status === "generating";
  return (
    <span
      className={clsx("chip", STATUS_STYLE[status] ?? STATUS_STYLE.draft)}
      title={status === "submitted" ? "Waiting in a provider batch — results arrive within 24h" : undefined}
    >
      {spinning && <Loader2 className="size-3 animate-spin" />}
      {label ?? (status === "submitted" ? "in batch" : status.replace(/_/g, " "))}
    </span>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean | "xl";
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  // Callers pass inline onClose; reading it through a ref keeps the effect (and its focus call) to open/close only.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onCloseRef.current();
    window.addEventListener("keydown", onKey);
    ref.current?.focus();
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 pt-[8vh]"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className={clsx(
          "card w-full shadow-2xl outline-none",
          wide === "xl" ? "max-w-5xl" : wide ? "max-w-3xl" : "max-w-lg",
        )}
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <h2 id={id} className="font-semibold">
            {title}
          </h2>
          <button type="button" className="btn-ghost p-1" onClick={onClose} aria-label="Close">
            <X className="size-4" />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-[var(--border)] px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  danger,
  busy,
  disabled,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  disabled?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button type="button" className="btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? "btn-danger" : "btn-primary"}
            disabled={busy || disabled}
            onClick={onConfirm}
          >
            {busy && <Spinner />} {confirmLabel}
          </button>
        </>
      }
    >
      <div className="text-sm">{children}</div>
    </Modal>
  );
}

/** An in-app path (relative to the /app base) and what to call it. */
type ToastLink = { label: string; to: string };
type Toast = { id: number; kind: "success" | "error" | "info"; message: string; link?: ToastLink };
export const useToasts = create<{
  toasts: Toast[];
  push: (kind: Toast["kind"], message: string, link?: ToastLink) => void;
  dismiss: (id: number) => void;
}>((set) => ({
  toasts: [],
  push: (kind, message, link) => {
    const id = Date.now() + Math.random();
    set((s) => ({ toasts: [...s.toasts.slice(-4), { id, kind, message, link }] }));
    // A toast with something to click lasts long enough to read and act on; the rest only report.
    const ms = link ? 15_000 : kind === "error" ? 8000 : 4000;
    setTimeout(() => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
export const toast = {
  success: (m: string) => useToasts.getState().push("success", m),
  error: (e: unknown) => useToasts.getState().push("error", errorMessage(e)),
  info: (m: string) => useToasts.getState().push("info", m),
  /** A toast that asks for something: it carries a link to where it is done, and stays long enough to click. */
  action: (m: string, link: ToastLink) => useToasts.getState().push("info", m, link),
};

export function Toaster() {
  const { toasts, dismiss } = useToasts();
  return (
    <div className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={clsx(
            "card pointer-events-auto flex items-start gap-2 p-3 text-sm shadow-lg",
            t.kind === "error" && "border-red-500/50",
          )}
        >
          {t.kind === "error" ? (
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-red-500" />
          ) : (
            <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-emerald-500" />
          )}
          <div className="min-w-0 flex-1 break-words">
            {t.message}
            {t.link && (
              <Link
                to={t.link.to as never}
                className="mt-1 block font-medium text-accent-500 hover:underline"
                onClick={() => dismiss(t.id)}
              >
                {t.link.label} →
              </Link>
            )}
          </div>
          <button type="button" className="muted" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function AssetImage({
  assetId,
  variant = "thumbnail",
  alt,
  className,
  fit = "cover",
}: {
  assetId: string | null | undefined;
  variant?: "thumbnail" | "preview" | undefined | null;
  alt: string;
  className?: string;
  fit?: "cover" | "contain";
}) {
  const [failed, setFailed] = useState(false);
  if (!assetId || failed)
    return (
      <div
        className={clsx("flex items-center justify-center bg-[var(--panel-2)] muted", className)}
        role="img"
        aria-label={alt}
      >
        <ImageOff className="size-6 opacity-50" />
      </div>
    );
  return (
    <img
      src={assetUrl(assetId, variant ?? undefined)}
      alt={alt}
      loading="lazy"
      onError={() => setFailed(true)}
      className={clsx(fit === "cover" ? "object-cover" : "object-contain", "bg-[var(--panel-2)]", className)}
    />
  );
}

/** Label wraps its control so the text is the control's accessible name (implicit association). */
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children (implicit association)
    <label className="block">
      <span className="label">{label}</span>
      {children}
      {hint && <span className="muted mt-1 block text-xs">{hint}</span>}
    </label>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  tabs,
}: {
  value: T;
  onChange: (v: T) => void;
  tabs: { value: T; label: ReactNode }[];
}) {
  return (
    <div role="tablist" className="mb-4 flex gap-1 border-b border-[var(--border)]">
      {tabs.map((t) => (
        <button
          key={t.value}
          type="button"
          role="tab"
          aria-selected={value === t.value}
          onClick={() => onChange(t.value)}
          className={clsx(
            "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
            value === t.value
              ? "border-accent-500 text-[var(--text)]"
              : "border-transparent muted hover:text-[var(--text)]",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function SaveIndicator({ state }: { state: "idle" | "saving" | "saved" | "error" }) {
  if (state === "idle") return null;
  return (
    <span
      className={clsx("inline-flex items-center gap-1 text-xs", state === "error" ? "text-red-500" : "muted")}
      aria-live="polite"
    >
      {state === "saving" && <Spinner className="size-3" />}
      {state === "saving" ? "Saving…" : state === "saved" ? "Saved" : "Error saving"}
    </span>
  );
}

/** Debounced autosave with Saving/Saved/Error states. Never drops the latest value. */
export function useAutosave<T>(
  value: T,
  save: (v: T) => Promise<void>,
  opts: { delay?: number; enabled?: boolean } = {},
) {
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const latest = useRef(value);
  const lastSaved = useRef(value);
  const saveRef = useRef(save);
  saveRef.current = save;
  latest.current = value;
  useEffect(() => {
    if (
      opts.enabled === false ||
      Object.is(value, lastSaved.current) ||
      JSON.stringify(value) === JSON.stringify(lastSaved.current)
    )
      return;
    const t = setTimeout(async () => {
      const v = latest.current;
      setState("saving");
      try {
        await saveRef.current(v);
        lastSaved.current = v;
        setState("saved");
      } catch (e) {
        setState("error");
        toast.error(e);
      }
    }, opts.delay ?? 1200);
    return () => clearTimeout(t);
  }, [value, opts.delay, opts.enabled]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (JSON.stringify(latest.current) !== JSON.stringify(lastSaved.current)) e.preventDefault();
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  return { state, markSaved: (v: T) => (lastSaved.current = v) };
}

export const fmt = {
  usd: (n: number | string | null | undefined) => {
    const v = Number(n ?? 0);
    return v === 0 ? "$0.00" : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
  },
  bytes: (n: number | null | undefined) => {
    const v = Number(n ?? 0);
    if (v < 1024) return `${v} B`;
    if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
    return `${(v / 1024 ** 3).toFixed(2)} GB`;
  },
  date: (s: string | null | undefined) => (s ? new Date(s).toLocaleString() : "—"),
  ago: (s: string | null | undefined) => {
    if (!s) return "—";
    const d = (Date.now() - new Date(s).getTime()) / 1000;
    if (d < 60) return "just now";
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
    return `${Math.floor(d / 86400)}d ago`;
  },
  ms: (n: number | null | undefined) => {
    const v = Number(n ?? 0);
    return v < 1000
      ? `${v} ms`
      : v < 60_000
        ? `${(v / 1000).toFixed(1)} s`
        : `${Math.floor(v / 60000)}m ${Math.round((v % 60000) / 1000)}s`;
  },
  num: (n: number | null | undefined) => Number(n ?? 0).toLocaleString(),
};

export function KeyValue({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="muted">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function TagInput({
  value,
  onChange,
  placeholder,
  disabled,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const v = draft.trim();
    if (v && !value.includes(v)) onChange([...value, v]);
    setDraft("");
  };
  return (
    <div className="input flex min-h-9 flex-wrap items-center gap-1">
      {value.map((t) => (
        <span key={t} className="chip bg-[var(--panel-2)]">
          {t}
          {!disabled && (
            <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
              <X className="size-3" />
            </button>
          )}
        </span>
      ))}
      {!disabled && (
        <input
          className="min-w-24 flex-1 bg-transparent outline-none"
          value={draft}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            } else if (e.key === "Backspace" && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={add}
        />
      )}
    </div>
  );
}
