/**
 * Export targets: a platform's preset (the export kind and options it needs) and its published limits, checked before
 * an export (from the project's pages and timing) and after it (from the files made). Limits are the platforms' own
 * as of 2026; they change, so every message names the number it checked against.
 */

const MB = 1024 * 1024;
const MIN = 60_000;

export type TargetKind = "video_panels" | "video_shorts" | "carousel" | "webtoon" | "pdf";

export type ExportTarget = {
  key: string;
  label: string;
  kind: TargetKind;
  /** The export options this target sets (merged over the form's). */
  options: {
    video?: { aspect: "16:9" | "9:16" | "1:1"; height: 720 | 1080 | 1440 };
    still?: { aspect: "1:1" | "4:5" };
    webtoon?: { width: number; maxChunkHeight: number; format: "jpg" | "png"; split: true; exactHeight?: boolean };
    pdf?: { pageSize: string; dpi: number };
    jpgQuality?: number;
  };
  limits: {
    /** Video length. */
    minDurationMs?: number;
    maxDurationMs?: number;
    /** One file (a video, a PDF, one image). */
    maxFileBytes?: number;
    /** Images in a set (carousel slides, strip images). */
    maxImages?: number;
    /** Every image's own limits. */
    imageWidth?: number;
    maxImageHeight?: number;
    maxImageBytes?: number;
    /** All images of an episode together. */
    maxTotalBytes?: number;
    /** Printed pages. */
    minPages?: number;
    maxPages?: number;
  };
  /** What a check cannot measure: safe areas, naming, codecs. Shown with the preset. */
  notes: string[];
};

export const EXPORT_TARGETS: ExportTarget[] = [
  {
    key: "youtube",
    label: "YouTube video",
    kind: "video_panels",
    options: { video: { aspect: "16:9", height: 1080 } },
    limits: { maxDurationMs: 12 * 60 * MIN, maxFileBytes: 256 * 1024 * MB },
    notes: [
      "MP4, H.264 video and AAC audio (what the render makes).",
      "Chapter timestamps need at least three chapters of 10 s or more, the first at 0:00.",
      "Keep text out of the bottom tenth: the player's controls cover it.",
    ],
  },
  {
    key: "youtube_shorts",
    label: "YouTube Shorts",
    kind: "video_shorts",
    options: { video: { aspect: "9:16", height: 1080 } },
    limits: { maxDurationMs: 3 * MIN },
    notes: [
      "Vertical 9:16 and at most 3 minutes, or YouTube uploads it as a regular video.",
      "Keep faces and captions out of the bottom fifth and the right edge: the title, buttons and comments cover them.",
    ],
  },
  {
    key: "tiktok",
    label: "TikTok",
    kind: "video_shorts",
    options: { video: { aspect: "9:16", height: 1080 } },
    limits: { maxDurationMs: 10 * MIN },
    notes: [
      "Vertical 9:16, up to 10 minutes uploaded from a computer.",
      "Keep text out of the bottom fifth and the right edge (caption, sound and buttons).",
    ],
  },
  {
    key: "reels",
    label: "Instagram Reels",
    kind: "video_shorts",
    options: { video: { aspect: "9:16", height: 1080 } },
    limits: { maxDurationMs: 3 * MIN },
    notes: [
      "Vertical 9:16, up to 3 minutes.",
      "The grid shows the middle 3:4 of the frame: keep the subject there. The caption covers the bottom fifth.",
    ],
  },
  {
    key: "instagram_carousel",
    label: "Instagram carousel",
    kind: "carousel",
    options: { still: { aspect: "4:5" }, jpgQuality: 90 },
    limits: { maxImages: 20, imageWidth: 1080, maxImageBytes: 30 * MB },
    notes: ["Up to 20 slides, each 1080×1350 (4:5) or 1080×1080; the first slide is the cover in the grid."],
  },
  {
    key: "webtoon_canvas",
    label: "WEBTOON Canvas",
    kind: "webtoon",
    options: {
      webtoon: { width: 800, maxChunkHeight: 1280, format: "jpg", split: true, exactHeight: true },
      jpgQuality: 90,
    },
    limits: { imageWidth: 800, maxImageHeight: 1280, maxImageBytes: 2 * MB, maxTotalBytes: 20 * MB },
    notes: [
      "Images 800 px wide, at most 1280 px tall and 2 MB each, 20 MB per episode; JPG or PNG.",
      "Images upload in name order: the numbered names (…_01, …_02) keep the strip in sequence.",
    ],
  },
  {
    key: "tapas",
    label: "Tapas",
    kind: "webtoon",
    options: { webtoon: { width: 940, maxChunkHeight: 4000, format: "jpg", split: true }, jpgQuality: 90 },
    limits: { imageWidth: 940 },
    notes: ["Images 940 px wide, the width Tapas shows a strip at; JPG.", "Upload in name order."],
  },
  {
    key: "kdp_paperback",
    label: "Amazon KDP paperback (6×9 in)",
    kind: "pdf",
    options: { pdf: { pageSize: "kdp_6x9", dpi: 300 } },
    limits: { minPages: 24, maxPages: 828, maxFileBytes: 650 * MB },
    notes: [
      "Interior printed full bleed at 300 dpi; KDP needs 24 to 828 pages (fewer in colour: 600 on standard colour).",
      "Keep lettering 0.25 in inside the trim, more on the spine side for thick books (the print preflight checks it).",
    ],
  },
  {
    key: "pdf",
    label: "PDF (any reader)",
    kind: "pdf",
    options: { pdf: { pageSize: "source", dpi: 300 } },
    limits: {},
    notes: ["Pages at their own size; no platform limits apply."],
  },
];

export const exportTarget = (key: string) => EXPORT_TARGETS.find((t) => t.key === key);

/** What is known about an export, before (estimated) or after (measured) it is made. */
export type TargetFacts = {
  durationMs?: number;
  pages?: number;
  /** Each file, or each image inside an archive. */
  images?: { name: string; width?: number; height?: number; bytes?: number }[];
  files?: { name: string; bytes: number }[];
};

export type TargetIssue = { level: "block" | "info"; code: string; message: string };

const mb = (n: number) => `${(n / MB).toFixed(n < 10 * MB ? 1 : 0)} MB`;
const dur = (ms: number) => {
  const s = Math.round(ms / 1000);
  return s >= 3600
    ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** The target's limits against what is known; "block" means the platform would refuse or misfile it. */
export function checkExportTarget(t: ExportTarget, f: TargetFacts): TargetIssue[] {
  const out: TargetIssue[] = [];
  const l = t.limits;
  const add = (code: string, message: string, level: TargetIssue["level"] = "block") =>
    out.push({ level, code, message });
  if (f.durationMs != null) {
    if (l.maxDurationMs && f.durationMs > l.maxDurationMs)
      add("too_long", `${dur(f.durationMs)} long; ${t.label} takes at most ${dur(l.maxDurationMs)}.`);
    if (l.minDurationMs && f.durationMs < l.minDurationMs)
      add("too_short", `${dur(f.durationMs)} long; ${t.label} needs at least ${dur(l.minDurationMs)}.`);
  }
  if (f.pages != null) {
    if (l.minPages && f.pages < l.minPages)
      add("too_few_pages", `${f.pages} pages; ${t.label} needs at least ${l.minPages}.`);
    if (l.maxPages && f.pages > l.maxPages)
      add("too_many_pages", `${f.pages} pages; ${t.label} takes at most ${l.maxPages}.`);
  }
  for (const file of f.files ?? [])
    if (l.maxFileBytes && file.bytes > l.maxFileBytes)
      add("file_too_big", `${file.name} is ${mb(file.bytes)}; ${t.label} takes at most ${mb(l.maxFileBytes)}.`);
  const images = f.images ?? [];
  if (l.maxImages && images.length > l.maxImages)
    add("too_many_images", `${images.length} images; ${t.label} takes at most ${l.maxImages}.`);
  const bad = (pick: (i: (typeof images)[number]) => boolean) => images.filter(pick).map((i) => i.name);
  const list = (names: string[]) =>
    `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` and ${names.length - 3} more` : ""}`;
  const wrongWidth = bad((i) => Boolean(l.imageWidth && i.width && i.width !== l.imageWidth));
  if (wrongWidth.length)
    add("image_width", `${list(wrongWidth)} not ${l.imageWidth} px wide, the width ${t.label} shows.`, "info");
  const tall = bad((i) => Boolean(l.maxImageHeight && i.height && i.height > l.maxImageHeight));
  if (tall.length) add("image_too_tall", `${list(tall)} taller than ${l.maxImageHeight} px.`);
  const heavy = bad((i) => Boolean(l.maxImageBytes && i.bytes && i.bytes > l.maxImageBytes));
  if (heavy.length) add("image_too_big", `${list(heavy)} over ${mb(l.maxImageBytes!)}.`);
  const total = images.reduce((n, i) => n + (i.bytes ?? 0), 0);
  if (l.maxTotalBytes && total > l.maxTotalBytes)
    add("total_too_big", `${mb(total)} of images; ${t.label} takes at most ${mb(l.maxTotalBytes)} per episode.`);
  return out;
}
