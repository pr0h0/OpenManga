import type { CoverLayout, PrintIssue } from "@openmanga/domain/browser";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { API_BASE, get } from "../../api/client.ts";
import { Field, Spinner } from "../../components/ui.tsx";

export const PRINT_SIZES = [
  ["kdp_5x8", 'KDP 5" × 8"'],
  ["kdp_5_5x8_5", 'KDP 5.5" × 8.5"'],
  ["kdp_6x9", 'KDP 6" × 9"'],
  ["kdp_7x10", 'KDP 7" × 10"'],
  ["kdp_8_5x11", 'KDP 8.5" × 11"'],
  ["A4", "A4"],
  ["A5", "A5"],
  ["B5", "B5"],
  ["letter", "Letter"],
  ["tankobon", "Tankōbon"],
] as const;

const inches = (v: number) => `${v.toFixed(3)}"`;

/** Problems first, then notes; "info" lines say how it will print rather than what is wrong. */
export function PrintIssues({ issues, ok }: { issues: PrintIssue[]; ok: string }) {
  if (!issues.length) return <p className="text-xs text-emerald-600">{ok}</p>;
  const rank = { block: 0, warn: 1, info: 2 };
  return (
    <ul className="space-y-1 text-xs">
      {[...issues]
        .sort((a, b) => rank[a.severity] - rank[b.severity])
        .map((i) => (
          <li
            key={`${i.code}-${i.message}`}
            className={
              i.severity === "info"
                ? "muted"
                : i.severity === "block"
                  ? "text-red-600 dark:text-red-400"
                  : "text-amber-700 dark:text-amber-300"
            }
          >
            {i.message}
          </li>
        ))}
    </ul>
  );
}

/** The cover's size and spine for the chosen print options, checked before anything is rendered. */
export function CoverCheck(props: {
  projectId: string;
  chapterId: string | null;
  pageSize: string;
  paper: string;
  pageCount: string;
  toc: boolean;
  rectoChapters: boolean;
}) {
  const q = new URLSearchParams({
    pageSize: props.pageSize,
    paper: props.paper,
    toc: String(props.toc),
    rectoChapters: String(props.rectoChapters),
    ...(props.chapterId ? { chapterId: props.chapterId } : {}),
    ...(Number(props.pageCount) > 0 ? { pageCount: props.pageCount } : {}),
  });
  const check = useQuery({
    queryKey: ["print-cover", props.projectId, q.toString()],
    queryFn: () => get<{ pageCount: number; layout: CoverLayout }>(`/projects/${props.projectId}/print/cover?${q}`),
  });
  if (check.isLoading) return <Spinner />;
  if (!check.data) return null;
  const { layout, pageCount } = check.data;
  return (
    <div className="space-y-2 rounded-lg border border-[var(--border)] p-2 text-xs" data-testid="cover-check">
      <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5">
        <dt className="muted">Pages</dt>
        <dd>{pageCount}</dd>
        <dt className="muted">Spine</dt>
        <dd>{inches(layout.spineIn)}</dd>
        <dt className="muted">Full cover with bleed</dt>
        <dd>
          {inches(layout.widthIn)} × {inches(layout.heightIn)}
        </dd>
        {layout.artDpi !== null && (
          <>
            <dt className="muted">Front art</dt>
            <dd>{layout.artDpi} DPI</dd>
          </>
        )}
      </dl>
      <PrintIssues issues={layout.issues} ok="Cover check: nothing to fix." />
    </div>
  );
}

type PreflightRow = {
  page: number;
  kind: string;
  pageId?: string;
  chapter?: number;
  order?: number;
  imageDpi?: number;
  artDpi?: number | null;
  inkPct?: number;
  shiftPct?: number;
  textOutsideSafe?: string[];
};
export type PreflightReportData = {
  pageCount: number;
  evenPageCount: boolean;
  inkModel: string;
  inkLimitPct: number;
  minDpi: number;
  lowestDpi: number;
  maxInkPct: number;
  mostShiftedPage: { page: number; pageId: string; shiftPct: number } | null;
  fonts: { family: string; uses: number; installed: boolean | null }[];
  issues: PrintIssue[];
  pages: PreflightRow[];
};

/** A finished preflight: the summary, the issues, the fonts, every page's numbers, and a soft proof of any page. */
export function PreflightReport({ report, grey }: { report: PreflightReportData; grey: boolean }) {
  const pages = report.pages.filter((p) => p.pageId);
  const [pageId, setPageId] = useState(report.mostShiftedPage?.pageId ?? pages[0]?.pageId ?? "");
  const flagged = (p: PreflightRow) =>
    Math.min(p.imageDpi ?? report.minDpi, p.artDpi ?? report.minDpi) < report.minDpi ||
    (p.inkPct ?? 0) > report.inkLimitPct ||
    Boolean(p.textOutsideSafe?.length);
  const src = (proof?: string) => `${API_BASE}/pages/${pageId}/render.png?width=600${proof ? `&proof=${proof}` : ""}`;
  return (
    <div className="mt-2 space-y-3 text-sm" data-testid="preflight-report">
      <div className="flex flex-wrap gap-1.5 text-xs">
        <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5">
          {report.pageCount} pages{report.evenPageCount ? "" : " (odd)"}
        </span>
        <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5">Lowest {report.lowestDpi} DPI</span>
        <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5">Most ink {report.maxInkPct}%</span>
        <span className="rounded bg-[var(--panel-2)] px-1.5 py-0.5">
          {report.fonts.length} font{report.fonts.length === 1 ? "" : "s"}
        </span>
      </div>
      <PrintIssues issues={report.issues} ok="Preflight: nothing to fix." />
      {report.fonts.length > 0 && (
        <p className="muted text-xs">
          Fonts:{" "}
          {report.fonts
            .map(
              (f) =>
                `${f.family} (${f.uses}${f.installed === false ? ", not installed" : f.installed ? ", installed" : ""})`,
            )
            .join(", ")}
        </p>
      )}
      <details className="text-xs">
        <summary className="cursor-pointer">Every page ({report.pages.length})</summary>
        <div className="mt-1 max-h-64 overflow-auto">
          <table className="w-full text-left">
            <thead className="muted">
              <tr>
                <th className="pr-2 font-normal">Page</th>
                <th className="pr-2 font-normal">DPI (page / art)</th>
                <th className="pr-2 font-normal">Ink</th>
                <th className="font-normal">Proof shift</th>
              </tr>
            </thead>
            <tbody>
              {report.pages.map((p) => (
                <tr key={p.page} className={flagged(p) ? "text-amber-700 dark:text-amber-300" : ""}>
                  <td className="pr-2">
                    {p.page}
                    {p.kind === "page" ? ` · ch${p.chapter} p${p.order}` : ` · ${p.kind}`}
                  </td>
                  <td className="pr-2">
                    {p.imageDpi ?? "—"} / {p.artDpi ?? "—"}
                  </td>
                  <td className="pr-2">{p.inkPct === undefined ? "—" : `${p.inkPct}%`}</td>
                  <td>{p.shiftPct === undefined ? "—" : `${p.shiftPct}%`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      {pageId && (
        <div className="space-y-2">
          <Field
            label={grey ? "Soft proof (black ink only)" : "Soft proof (through CMYK)"}
            hint={
              grey
                ? "The page as a greyscale interior prints it."
                : "Colours a press cannot print shift as they will on paper. A generic press profile, not your printer's."
            }
          >
            <select className="input" value={pageId} onChange={(e) => setPageId(e.target.value)}>
              {pages.map((p) => (
                <option key={p.pageId} value={p.pageId}>
                  Page {p.page} (ch{p.chapter} p{p.order})
                  {p.pageId === report.mostShiftedPage?.pageId ? " — shifts most" : ""}
                </option>
              ))}
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-2">
            <figure>
              <img className="w-full rounded border border-[var(--border)]" src={src()} alt="Page as rendered (RGB)" />
              <figcaption className="muted mt-0.5 text-xs">RGB</figcaption>
            </figure>
            <figure>
              <img
                className="w-full rounded border border-[var(--border)]"
                src={src(grey ? "grey" : "cmyk")}
                alt="Page soft-proofed for print"
              />
              <figcaption className="muted mt-0.5 text-xs">{grey ? "Black ink" : "CMYK proof"}</figcaption>
            </figure>
          </div>
        </div>
      )}
    </div>
  );
}
