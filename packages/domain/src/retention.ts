/**
 * The server's storage policy: files older than `maxAgeDays`, and then the oldest files until the total is under
 * `maxTotalGb`, are deleted — whichever limit is crossed first — but only files the app can do without (see
 * `RetentionKind`). `auto` deletes them at the next maintenance pass; `approve` waits for an administrator.
 */
export type RetentionPolicy = {
  enabled: boolean;
  /** Delete expendable files older than this many days; null: no age limit. */
  maxAgeDays: number | null;
  /** Keep all stored files (in use or not) under this many gigabytes; null: no size limit. */
  maxTotalGb: number | null;
  mode: "auto" | "approve";
};

/**
 * What the policy may delete: what can be made again or is no longer in use. Never artwork a panel shows, approved or
 * locked art, references, covers, thumbnails, uploads, or narration a segment plays.
 */
export const RETENTION_KINDS = [
  "render_cache",
  "export",
  "panel_version",
  "audio_take",
  "trash",
  "prompt_reference",
] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

export const RETENTION_LABELS: Record<RetentionKind, string> = {
  render_cache: "Cached video sections",
  export: "Export files",
  panel_version: "Older panel artwork versions",
  audio_take: "Narration takes no longer used",
  trash: "Trashed files",
  prompt_reference: "Prompt reference copies",
};

export type RetentionCandidate = { id: string; kind: RetentionKind; bytes: number; createdAt: Date | string };

export const GB = 1024 ** 3;

/**
 * Which candidates the policy deletes now: every one older than the age limit, then — while all stored files still
 * total more than the size limit — the oldest of the rest, until the total is under it. `overLimitBytes` is what is
 * still over the size limit after deleting everything allowed (files in use cannot be deleted to make room).
 */
export function selectForRetention(
  candidates: RetentionCandidate[],
  totalBytes: number,
  policy: RetentionPolicy,
  now: Date = new Date(),
) {
  const sorted = [...candidates].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt));
  const cutoff = policy.maxAgeDays === null ? null : now.getTime() - policy.maxAgeDays * 86_400_000;
  const selected: RetentionCandidate[] = [];
  const reasons = { age: 0, size: 0 };
  let total = totalBytes;
  const rest: RetentionCandidate[] = [];
  for (const c of sorted) {
    if (cutoff !== null && +new Date(c.createdAt) < cutoff) {
      selected.push(c);
      reasons.age++;
      total -= c.bytes;
    } else rest.push(c);
  }
  const limit = policy.maxTotalGb === null ? null : policy.maxTotalGb * GB;
  if (limit !== null)
    for (const c of rest) {
      if (total <= limit) break;
      selected.push(c);
      reasons.size++;
      total -= c.bytes;
    }
  const byKind: Partial<Record<RetentionKind, { files: number; bytes: number }>> = {};
  for (const c of selected) {
    const k = byKind[c.kind] ?? { files: 0, bytes: 0 };
    k.files++;
    k.bytes += c.bytes;
    byKind[c.kind] = k;
  }
  return {
    selected,
    files: selected.length,
    bytes: totalBytes - total,
    afterBytes: total,
    overLimitBytes: limit === null ? 0 : Math.max(0, total - limit),
    reasons,
    byKind,
  };
}
