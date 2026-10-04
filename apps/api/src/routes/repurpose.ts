import { and, dialogueLines, eq, inArray } from "@openmanga/db";
import {
  PRIORITY,
  pickCarousel,
  pickQuotes,
  pickShorts,
  pickShortsSet,
  REPURPOSE_PRESETS,
  SHORTS_MIN_MS,
} from "@openmanga/domain";
import { socialCopyV1 } from "@openmanga/prompts";
import type { RepurposeItem } from "@openmanga/schemas";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { AiChoiceInput, assertBudget, textRun } from "../lib/ai.ts";
import { badRequest, body, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { shortsCandidates } from "./video.ts";

export const repurposeRoutes = new Hono<AppEnv>();

const RepurposeQuery = z.object({
  language: z.string().trim().min(2).max(16).optional(),
  /** How many Shorts the suggestion cuts, each from its own part of the story. */
  shorts: z.coerce.number().int().min(1).max(10).default(3),
  minHoldMs: z.coerce.number().int().min(500).max(30_000).default(1500),
});

type Project = Awaited<ReturnType<typeof projectAccess>>;

/** Every panel of the project as a repurposing candidate: the Shorts candidate plus its quotable lines. */
async function candidates(db: AppEnv["Variables"]["deps"]["db"], p: Project, language: string, minHoldMs: number) {
  const cands = await shortsCandidates(db, p, { chapterId: null }, language, minHoldMs);
  const dialogue = cands.length
    ? await db
        .select({ panelId: dialogueLines.panelId, text: dialogueLines.text })
        .from(dialogueLines)
        .where(
          and(
            eq(dialogueLines.projectId, p.id),
            inArray(
              dialogueLines.panelId,
              cands.map((x) => x.id),
            ),
          ),
        )
    : [];
  return cands.map((x) => ({
    ...x,
    quotes: [x.text, ...dialogue.filter((d) => d.panelId === x.id).map((d) => d.text)].filter(Boolean),
  }));
}

/** A fresh plan: N Shorts from distinct parts of the story, a trailer, a teaser, a carousel and three quote images. */
export function suggestRepurpose(cands: Awaited<ReturnType<typeof candidates>>, shorts: number): RepurposeItem[] {
  const video = (kind: "trailer" | "teaser", label: string): RepurposeItem[] => {
    const pr = REPURPOSE_PRESETS[kind];
    const ids = pickShorts(cands, pr);
    return ids.length
      ? [{ id: kind, kind, label, panelIds: ids, lengthSeconds: pr.maxMs / 1000, aspect: pr.aspect, ...blank }]
      : [];
  };
  const blank = { text: "", title: "", caption: "" };
  const carousel = pickCarousel(cands);
  return [
    ...pickShortsSet(cands, shorts, REPURPOSE_PRESETS.short).map(
      (ids, i): RepurposeItem => ({
        id: `short-${i + 1}`,
        kind: "short",
        label: `Short ${i + 1}`,
        panelIds: ids,
        lengthSeconds: REPURPOSE_PRESETS.short.maxMs / 1000,
        aspect: REPURPOSE_PRESETS.short.aspect,
        ...blank,
      }),
    ),
    ...video("trailer", "Trailer"),
    ...video("teaser", "Teaser"),
    ...(carousel.length
      ? [{ id: "carousel", kind: "carousel", label: "Carousel", panelIds: carousel, aspect: "4:5", ...blank } as const]
      : []),
    ...pickQuotes(cands).map(
      (q, i): RepurposeItem => ({
        id: `quote-${i + 1}`,
        kind: "quote",
        label: `Quote ${i + 1}`,
        panelIds: [q.panelId],
        aspect: "4:5",
        ...blank,
        text: q.text,
      }),
    ),
  ];
}

doc({
  method: "GET",
  path: "/api/projects/:projectId/repurpose",
  summary:
    "The repurposing plan: `items` (saved in settings.repurpose; panels that no longer exist are dropped), `suggestion` (a fresh plan: `shorts` non-overlapping Shorts, a 60–90 s trailer, a 15–30 s teaser, a 10-slide carousel and 3 quote images) and `candidates` (every panel in story order with its hold, narration, art and quotable lines). Save an edited plan with PATCH /api/projects/:projectId { settings: { repurpose: { items } } }, then render each item with POST exports (video_shorts, carousel or quote_image).",
  tag: "exports",
});
repurposeRoutes.get("/projects/:projectId/repurpose", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, RepurposeQuery);
  const cands = await candidates(c.get("deps").db, p, q.language || p.language, q.minHoldMs);
  const known = new Set(cands.map((x) => x.id));
  return c.json({
    items: (p.settings.repurpose?.items ?? []).map((it) => ({
      ...it,
      panelIds: it.panelIds.filter((id) => known.has(id)),
    })),
    suggestion: suggestRepurpose(cands, q.shorts),
    candidates: cands,
    presets: REPURPOSE_PRESETS,
    shortsMinMs: SHORTS_MIN_MS,
  });
});

const SocialCopyInput = z.object({
  /** The saved items to write for (default: all of them). Their current title and caption are replaced. */
  itemIds: z.array(z.string().max(40)).max(40).optional(),
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/repurpose/copy",
  summary:
    "Queue a text job that writes a social title and caption for saved repurposing items (itemIds, default all), from each item's narration. When it completes, the titles and captions are in settings.repurpose.items, where they can be edited.",
  tag: "generations",
  body: SocialCopyInput,
});
repurposeRoutes.post("/projects/:projectId/repurpose/copy", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  const { itemIds, ai } = await body(c, SocialCopyInput);
  const saved = (p.settings.repurpose?.items ?? []).filter((it) => !itemIds || itemIds.includes(it.id));
  if (!saved.length) throw badRequest("Save a repurposing plan first");
  const deps = c.get("deps");
  const cands = await shortsCandidates(deps.db, p, { chapterId: null }, p.language, 1500);
  const textOf = new Map(cands.map((x) => [x.id, x.text]));
  // What each item shows, as the model reads it: its narration, capped so a long cut stays a short prompt.
  const items = saved.map((it) => ({
    id: it.id,
    kind: it.kind,
    label: it.label,
    quote: it.kind === "quote" ? it.text : undefined,
    narration: it.panelIds
      .map((id) => textOf.get(id) ?? "")
      .join(" ")
      .slice(0, 1500),
  }));
  await assertBudget(c, p.id);
  const run = await textRun(c, ai);
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(tx, {
      projectId: p.id,
      userId: user(c).id,
      kind: "social_copy",
      priority: PRIORITY.single,
      targetType: "project",
      targetId: p.id,
      templateName: socialCopyV1.name,
      templateVersion: socialCopyV1.version,
      provider: run.provider,
      model: run.model,
      parameters: run.parameters,
      input: { items },
    }),
  );
  await deps.jobs.kick();
  return c.json({ job }, 202);
});
