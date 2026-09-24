import { buildLabel } from "@openmanga/domain/browser";
import { useQueryClient } from "@tanstack/react-query";
import { Link, Outlet, useNavigate } from "@tanstack/react-router";
import { BarChart3, LogOut, MessagesSquare, Moon, Shield, Sun, User } from "lucide-react";
import { useState } from "react";
import { logout, useMe, useMeta } from "../api/hooks.ts";
import { Logo } from "./Logo.tsx";

const WEB_BUILD = buildLabel(__WEB_BUILD__);

export function AppShell() {
  const { data: me } = useMe();
  const { data: meta } = useMeta();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"));
  const toggleTheme = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("mf-theme", next ? "dark" : "light");
    } catch {}
  };
  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4">
        <Link to="/" className="flex items-center gap-2 font-semibold tracking-tight">
          <Logo className="size-5 text-accent-500" />
          OpenManga
        </Link>
        {meta?.build && (
          <span
            className="muted hidden font-mono text-[11px] sm:inline"
            title={[
              `Server ${meta.build.label}${meta.build.sha ? ` · ${meta.build.sha.slice(0, 7)}` : ""}`,
              `Web ${WEB_BUILD}${__WEB_BUILD__.sha ? ` · ${__WEB_BUILD__.sha.slice(0, 7)}` : ""}`,
            ].join("\n")}
          >
            {meta.build.label}
          </span>
        )}
        {meta?.mockMode && (
          <span
            className="chip bg-amber-500/15 text-amber-600 dark:text-amber-300"
            title="AI providers are mocked; no API spend"
          >
            Mock AI
          </span>
        )}
        <nav className="ml-auto flex items-center gap-1 text-sm">
          <Link to="/experts" className="btn-ghost" activeProps={{ className: "bg-[var(--panel-2)]" }}>
            <MessagesSquare className="size-4" /> <span className="hidden sm:inline">Experts</span>
          </Link>
          <Link to="/usage" className="btn-ghost" activeProps={{ className: "bg-[var(--panel-2)]" }}>
            <BarChart3 className="size-4" /> <span className="hidden sm:inline">Usage</span>
          </Link>
          {me?.role === "admin" && (
            <Link to="/admin" className="btn-ghost" activeProps={{ className: "bg-[var(--panel-2)]" }}>
              <Shield className="size-4" /> <span className="hidden sm:inline">Admin</span>
            </Link>
          )}
          <button type="button" className="btn-ghost" onClick={toggleTheme} aria-label="Toggle theme">
            {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <Link to="/account" className="btn-ghost">
            <User className="size-4" /> <span className="hidden sm:inline">{me?.username}</span>
          </Link>
          <button
            type="button"
            className="btn-ghost"
            aria-label="Sign out"
            onClick={async () => {
              await logout().catch(() => {});
              qc.clear();
              navigate({ to: "/login", search: {} });
            }}
          >
            <LogOut className="size-4" />
          </button>
        </nav>
      </header>
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
