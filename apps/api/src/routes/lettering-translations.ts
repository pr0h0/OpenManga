import { and, desc, eq, generationJobs, inArray, letteringTranslations, sql } from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { letteringTranslateV1 } from "@openmanga/prompts";
import { chapterLettering, saveTranslations, sourceSha, translationsOf } from "@openmanga/services";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { entityAccess } from "../lib/access.ts";
import {
  AiChoiceInput,
  assertBatchable,
  assertBudget,
  BatchInput,
  batchParameters,
  queueTextBatchSubmit,
  textRun,
} from "../lib/ai.ts";
import { badRequest, body, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";

/**
 * Translated lettering: a chapter's bubbles and captions in another language, re-lettered into the same bubbles for
 * a translated edition of the same art. Renders and exports take `language` and swap the text.
 */
export const letteringTranslationRoutes = new Hono<AppEnv>();

const Lang = z.string().trim().min(2).max(16);

doc({
  method: "GET",
  path: "/api/chapters/:id/lettering",
  summary:
    "A chapter's lettering in another language (?language=): every bubble and on-page caption in reading order with its original, its translation (or null), `stale` when the original changed after it was translated, and `edited` for a hand edit; plus the newest translation job.",
  tag: "pages",
  query: z.object({ language: Lang }),
});
letteringTranslationRoutes.get("/chapters/:id/lettering", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "chapter", id, "read");
  const { language } = query(c, z.object({ language: Lang }));
  const { db } = c.get("deps");
  const lines = await chapterLettering(db, id, p.language);
  const tr = await translationsOf(
    db,
    lines.map((l) => l.sourceId),
    language,
  );
  const [job] = await db
    .select({ id: generationJobs.id, status: generationJobs.status, failureReason: generationJobs.failureReason })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.kind, "lettering_translate"),
        eq(generationJobs.targetId, id),
        sql`${generationJobs.input}->>'language' = ${language}`,
      ),
    )
    .orderBy(desc(generationJobs.createdAt))
    .limit(1);
  const view = lines.map((l) => {
    const t = tr.get(l.sourceId);
    return {
      ...l,
      translation: t?.text ?? null,
      stale: Boolean(t && t.sourceSha256 !== sourceSha(l.text)),
      edited: t?.edited ?? false,
    };
  });
  return c.json({
    language,
    sourceLanguage: p.language,
    lines: view,
    translated: view.filter((l) => l.translation).length,
    job: job ?? null,
  });
});

const EditInput = z.object({
  language: Lang,
  lines: z
    .array(
      z.object({
        sourceType: z.enum(["dialogue", "caption"]),
        sourceId: z.string().uuid(),
        /** Empty removes the translation (the original shows again). */
        text: z.string().trim().max(1000),
      }),
    )
    .min(1)
    .max(1000),
});
doc({
  method: "PUT",
  path: "/api/chapters/:id/lettering",
  summary:
    "Edit translations by hand (kept by later machine translations). Lines must be the chapter's own bubbles or captions; empty text removes a translation.",
  tag: "pages",
  body: EditInput,
});
letteringTranslationRoutes.put("/chapters/:id/lettering", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "chapter", id, "write");
  const input = await body(c, EditInput);
  if (input.language === p.language) throw badRequest("That is the project's own language: edit the lettering itself");
  const { db } = c.get("deps");
  const lines = new Map((await chapterLettering(db, id, p.language)).map((l) => [l.sourceId, l]));
  if (input.lines.some((l) => lines.get(l.sourceId)?.sourceType !== l.sourceType))
    throw badRequest("A line is not this chapter's bubble or caption");
  const clear = input.lines.filter((l) => !l.text).map((l) => l.sourceId);
  if (clear.length)
    await db
      .delete(letteringTranslations)
      .where(and(inArray(letteringTranslations.sourceId, clear), eq(letteringTranslations.language, input.language)));
  const saved = await saveTranslations(
    db,
    p.id,
    input.language,
    input.lines.filter((l) => l.text).map((l) => ({ ...l, original: lines.get(l.sourceId)!.text, edited: true })),
  );
  return c.json({ saved, cleared: clear.length });
});

const TranslateInput = z.object({ language: Lang, ai: AiChoiceInput, batch: BatchInput });
doc({
  method: "POST",
  path: "/api/chapters/:id/lettering/translate",
  summary:
    "Translate the chapter's bubbles and captions into `language` (a lettering_translate text job, paste mode included). Saved as it completes; hand-edited lines are kept.",
  tag: "pages",
  body: TranslateInput,
});
letteringTranslationRoutes.post("/chapters/:id/lettering/translate", async (c) => {
  const id = uuidParam(c, "id");
  const p = await entityAccess(c, "chapter", id, "generate");
  const input = await body(c, TranslateInput);
  if (input.language === p.language) throw badRequest("That is the project's own language");
  const deps = c.get("deps");
  if (!(await chapterLettering(deps.db, id, p.language)).length)
    throw badRequest("This chapter has no bubbles or captions to translate");
  await assertBudget(c, p.id);
  const run = await textRun(c, input.ai);
  assertBatchable(c, input.batch, run.provider);
  const batchId = input.batch ? crypto.randomUUID() : null;
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(
      tx,
      {
        projectId: p.id,
        userId: user(c).id,
        kind: "lettering_translate",
        priority: PRIORITY.single,
        targetType: "chapter",
        targetId: id,
        batchId,
        templateName: letteringTranslateV1.name,
        templateVersion: letteringTranslateV1.version,
        provider: run.provider,
        model: run.model,
        parameters: { ...run.parameters, ...batchParameters(input.batch) },
        input: { chapterId: id, language: input.language },
      },
      { enqueue: !input.batch },
    ),
  );
  if (batchId) await queueTextBatchSubmit(c, { projectId: p.id, batchId, ai: input.ai });
  await deps.jobs.kick();
  return c.json({ job }, 202);
});
