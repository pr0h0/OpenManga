import { useRouterState } from "@tanstack/react-router";
import { useEffect } from "react";
import { post } from "../api/client.ts";
import { useMe } from "../api/hooks.ts";

/**
 * Local usage stats: active time per screen, sent to this app's own API (never anywhere else) by route template
 * (`/projects/$projectId/pages/$pageId`), so no id, title or text is ever reported. Time counts while the tab is
 * visible and someone touched it in the last minute; the API keeps daily totals the user can see, export and clear.
 */
const TICK_MS = 5_000;
const IDLE_MS = 60_000;
const REPORT_MS = 60_000;
/** The same rule the API checks: literal segments and `$params`. */
const TEMPLATE = /^\/(?:(?:\$[a-zA-Z]{1,40}|[a-z][a-z-]{0,40})(?:\/|$))*$/;

const totals = new Map<string, { visits: number; ms: number }>();
let current: string | null = null;
let lastInput = Date.now();

function entry(route: string) {
  const e = totals.get(route) ?? { visits: 0, ms: 0 };
  totals.set(route, e);
  return e;
}

function report() {
  const pages = [...totals].filter(([, v]) => v.visits || v.ms).map(([route, v]) => ({ route, ...v }));
  totals.clear();
  if (pages.length) post("/me/activity", { pages: pages.slice(0, 50) }).catch(() => {});
}

export function ActivityTracker() {
  const { data: me } = useMe();
  const on = Boolean(me) && me?.settings?.activityTracking !== false;
  const route = useRouterState({ select: (s) => s.matches.at(-1)?.fullPath ?? null });

  useEffect(() => {
    if (!on || !route || !TEMPLATE.test(route) || route === current) return;
    current = route;
    entry(route).visits++;
  }, [on, route]);

  useEffect(() => {
    if (!on) {
      totals.clear();
      current = null;
      return;
    }
    const touch = () => {
      lastInput = Date.now();
    };
    const events = ["pointerdown", "keydown", "wheel", "scroll", "pointermove"] as const;
    for (const e of events) window.addEventListener(e, touch, { passive: true, capture: true });
    const tick = setInterval(() => {
      if (current && document.visibilityState === "visible" && Date.now() - lastInput < IDLE_MS)
        entry(current).ms += TICK_MS;
    }, TICK_MS);
    const send = setInterval(report, REPORT_MS);
    // Leaving or hiding the tab sends what is counted so far, so a closed tab loses at most one tick.
    const hidden = () => document.visibilityState === "hidden" && report();
    document.addEventListener("visibilitychange", hidden);
    return () => {
      for (const e of events) window.removeEventListener(e, touch, { capture: true });
      clearInterval(tick);
      clearInterval(send);
      document.removeEventListener("visibilitychange", hidden);
      report();
    };
  }, [on]);
  return null;
}
