import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { toast } from "../components/ui.tsx";
import { coalesce } from "../lib/coalesce.ts";
import { get, post } from "./client.ts";
import type { Meta, SessionUser } from "./types.ts";

export const qk = {
  me: ["me"] as const,
  meta: ["meta"] as const,
  authConfig: ["auth-config"] as const,
  projects: (status: string) => ["projects", status] as const,
  project: (id: string) => ["project", id] as const,
  story: (id: string) => ["project", id, "story"] as const,
  analysis: (id: string) => ["analysis", id] as const,
  cast: (id: string) => ["project", id, "cast"] as const,
  character: (id: string) => ["character", id] as const,
  locations: (id: string) => ["project", id, "locations"] as const,
  props: (id: string) => ["project", id, "props"] as const,
  location: (id: string) => ["location", id] as const,
  prop: (id: string) => ["prop", id] as const,
  style: (id: string) => ["project", id, "style"] as const,
  chapters: (id: string) => ["project", id, "chapters"] as const,
  chapter: (id: string) => ["chapter", id] as const,
  page: (id: string) => ["page", id] as const,
  panel: (id: string) => ["panel", id] as const,
  generations: (id: string) => ["project", id, "generations"] as const,
  job: (id: string) => ["job", id] as const,
  narration: (chapterId: string) => ["chapter", chapterId, "narration"] as const,
  exports: (id: string) => ["project", id, "exports"] as const,
  assets: (id: string) => ["project", id, "assets"] as const,
  usage: (id: string) => ["project", id, "usage"] as const,
};

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: () => get<{ user: SessionUser | null }>("/auth/me").then((r) => r.user),
    staleTime: 60_000,
  });
}

export function useMeta() {
  return useQuery({ queryKey: qk.meta, queryFn: () => get<Meta>("/meta"), staleTime: Number.POSITIVE_INFINITY });
}

/** Mutation helper with toast on error and targeted invalidation. */
export function useAction<TVars = void, TRes = unknown>(
  fn: (v: TVars) => Promise<TRes>,
  opts: {
    invalidate?: readonly (readonly unknown[])[];
    success?: string | ((r: TRes) => string);
    onSuccess?: (r: TRes, v: TVars) => void;
  } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (r, v) => {
      for (const key of opts.invalidate ?? []) await qc.invalidateQueries({ queryKey: key });
      const message = typeof opts.success === "function" ? opts.success(r) : opts.success;
      if (message) toast.success(message);
      opts.onSuccess?.(r, v);
    },
    onError: (e) => toast.error(e),
  });
}

type ProjectEvent = { type: string; projectId: string; [k: string]: unknown };
const listeners = new Set<(e: ProjectEvent) => void>();
export function onProjectEvent(fn: (e: ProjectEvent) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

let chapterRefresh: { qc: QueryClient; run: () => void } | undefined;
const refreshChapters = (qc: QueryClient) => {
  if (chapterRefresh?.qc !== qc)
    chapterRefresh = { qc, run: coalesce(() => qc.invalidateQueries({ queryKey: ["chapter"] }), 1500) };
  chapterRefresh.run();
};

function invalidateFor(qc: QueryClient, projectId: string, e: ProjectEvent) {
  const inv = (key: readonly unknown[]) => qc.invalidateQueries({ queryKey: key });
  switch (e.type) {
    case "job.updated":
      inv(qk.generations(projectId));
      inv(["job", e.jobId]);
      inv(qk.project(projectId));
      if (e.status === "completed" || e.status === "failed") inv(qk.usage(projectId));
      if (e.kind === "story_rewrite" || e.kind === "story_analysis") inv(qk.story(projectId));
      if (e.kind === "page_prompts" && e.targetId) inv(qk.page(String(e.targetId)));
      if (e.targetType === "panel" && e.targetId) inv(qk.panel(String(e.targetId)));
      if (e.batchId) inv(["batch", e.batchId]);
      break;
    case "panel.updated":
      if (e.pageId) inv(qk.page(String(e.pageId)));
      inv(qk.panel(String(e.panelId)));
      inv(qk.chapters(projectId));
      break;
    case "reference.updated":
      inv(qk.cast(projectId));
      inv(qk.locations(projectId));
      inv(qk.props(projectId));
      inv(qk.style(projectId));
      inv(["character"]);
      inv(["location"]);
      inv(["prop"]);
      break;
    case "analysis.updated":
      inv(qk.story(projectId));
      inv(["analysis", e.analysisId]);
      break;
    case "chapter.updated":
      inv(qk.chapters(projectId));
      inv(qk.chapter(String(e.chapterId)));
      // Replanning replaces a chapter's pages, so every cached page document is suspect — but a shots grid can
      // hold a hundred of them, and refetching the lot at once is what tripped the rate limit. Mark them stale
      // and let each refetch when something actually mounts it; the page list above refetches immediately.
      qc.invalidateQueries({ queryKey: ["page"], refetchType: "none" });
      break;
    case "audio.updated":
    case "narration.updated":
      // Voicing a chapter sends several events per segment. Refetching every chapter query on each one was
      // thousands of requests a minute and tripped the rate limit, so a stream of them shares one refetch.
      refreshChapters(qc);
      break;
    case "export.updated":
      inv(qk.exports(projectId));
      break;
  }
}

/** SSE subscription for a project; reconnects automatically and invalidates affected queries. */
export function useProjectEvents(projectId: string | undefined) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!projectId) return;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const connect = () => {
      es = new EventSource(`/api/projects/${projectId}/events`, { withCredentials: true });
      es.addEventListener("message", (m) => {
        try {
          const e = JSON.parse(m.data) as ProjectEvent;
          invalidateFor(qc, projectId, e);
          for (const l of listeners) l(e);
          if (e.type === "job.updated" && e.status === "failed" && e.failureReason)
            toast.error(`${String(e.kind).replace(/_/g, " ")} failed: ${e.failureReason}`);
          // A paste-it-yourself run parks silently otherwise, and the only place to answer it is the job's own
          // page — so say where it is. Covers every operation, and each later question of a multi-step one. Not
          // shown on that page itself, where the answer box is already in front of you.
          if (
            e.type === "job.updated" &&
            e.status === "awaiting_input" &&
            !window.location.pathname.endsWith(`/generation/${e.jobId}`)
          )
            toast.action(
              e.failureReason
                ? `That answer was rejected — ${String(e.kind).replace(/_/g, " ")} is waiting for a corrected one.`
                : `${String(e.kind).replace(/_/g, " ")} is waiting for your answer. Copy its prompt into your chat and paste the reply back.`,
              { label: "Open it in Generation", to: `/projects/${projectId}/generation/${e.jobId}` },
            );
          if (e.type === "export.updated" && e.status === "completed") toast.success("Export ready");
        } catch {}
      });
      es.onerror = () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 3000);
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      es?.close();
    };
  }, [projectId, qc]);
}

export const logout = () => post("/auth/logout");
