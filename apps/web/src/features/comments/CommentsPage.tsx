import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { get } from "../../api/client.ts";
import type { ChapterListItem } from "../../api/types.ts";
import { EmptyState, ErrorBox, Field, fmt, PageHeader, Spinner, Tabs } from "../../components/ui.tsx";
import { useProjectId } from "../project/ProjectLayout.tsx";
import { type Comment, CommentText, commentKeys } from "./comments.tsx";

type Status = "open" | "resolved" | "all";
type Row = Comment & {
  pageId: string;
  pageOrder: number;
  panelOrder: number;
  chapterId: string;
  chapterOrder: number;
  chapterTitle: string;
  replies: number;
  lastActivityAt: string;
};

/** Every comment thread in the project (or one chapter), open ones first: the review queue for a shared project. */
export function CommentsPage() {
  const projectId = useProjectId();
  const [status, setStatus] = useState<Status>("open");
  const [chapterId, setChapterId] = useState("");
  const chapters = useQuery({
    queryKey: ["project", projectId, "chapters"],
    queryFn: () => get<{ chapters: ChapterListItem[] }>(`/projects/${projectId}/chapters`),
  });
  const q = useQuery({
    queryKey: [...commentKeys.project(projectId), status, chapterId],
    queryFn: () =>
      get<{ threads: Row[] }>(
        `/projects/${projectId}/comments?status=${status}${chapterId ? `&chapterId=${chapterId}` : ""}`,
      ),
  });
  return (
    <div className="mx-auto max-w-4xl p-4 sm:p-6">
      <PageHeader title="Comments" subtitle="What the project's members said about its panels." />
      <div className="mb-3 flex flex-wrap items-end gap-3">
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
            {chapters.data?.chapters.map((ch) => (
              <option key={ch.id} value={ch.id}>
                Chapter {ch.order}: {ch.title}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {q.isLoading && <Spinner />}
      <ErrorBox error={q.error} onRetry={() => q.refetch()} />
      {q.data && !q.data.threads.length && (
        <EmptyState title={status === "open" ? "No open comments" : "No comments"}>
          Comment on a panel from the page editor's Comments tab.
        </EmptyState>
      )}
      <ul className="space-y-2">
        {q.data?.threads.map((t) => (
          <li key={t.id}>
            <Link
              to="/projects/$projectId/pages/$pageId"
              params={{ projectId, pageId: t.pageId }}
              search={{ panelId: t.panelId, tab: "comments" }}
              className="card block space-y-1 p-3 hover:border-accent-500"
            >
              <div className="muted flex flex-wrap gap-x-2 text-xs">
                <span>
                  Ch. {t.chapterOrder} · page {t.pageOrder} · panel {t.panelOrder}
                </span>
                <span>
                  {t.authorName || t.author || "Former member"} · {fmt.ago(t.lastActivityAt)}
                </span>
                {t.replies > 0 && (
                  <span>
                    {t.replies} repl{t.replies === 1 ? "y" : "ies"}
                  </span>
                )}
                {t.resolvedAt && <span>resolved</span>}
              </div>
              {t.deletedAt ? <p className="muted text-sm italic">Comment deleted</p> : <CommentText body={t.body} />}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
