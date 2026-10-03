import {
  and,
  asc,
  bibleFacts,
  chapters,
  continuityFindings,
  desc,
  eq,
  generationJobs,
  inArray,
  sql,
} from "@openmanga/db";
import { batchModel, estimateCostUsd, PRIORITY } from "@openmanga/domain";
import { continuityCheckV1 } from "@openmanga/prompts";
import { projectBudget, recordAudit } from "@openmanga/services";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import {
  AiChoiceInput,
  assertBatchable,
  assertBudget,
  BatchInput,
  batchParameters,
  queueTextBatchSubmit,
  textRun,
} from "../lib/ai.ts";
import { body, conflict, notFound, query, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { FactInput } from "./bible.ts";

/**
 * Continuity checks: a text job per chapter compares its plan, scenes, panels and narration with the story bible and
 * the neighbouring chapters. Findings go to a queue to fix, ignore or explain; each fixed rule gets a verdict.
 */
export const continuityRoutes = new Hono<AppEnv>();

const Uuid = z.string().uuid();

const CheckInput = z.object({
  /** One chapter; omitted for every chapter that has panels or narration. */
  chapterId: Uuid.optional(),
  /** Without it, only the count and an estimate come back. */
  confirm: z.boolean().default(false),
  ai: AiChoiceInput,
  batch: BatchInput,
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/continuity-checks",
  summary:
    "Check continuity of one chapter or the whole project (one continuity_check text job per chapter with panels or narration). Without confirm=true returns the count and an estimate only.",
  tag: "bible",
  body: CheckInput,
});
continuityRoutes.post("/projects/:projectId/continuity-checks", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "generate");
  const input = await body(c, CheckInput);
  const deps = c.get("deps");
  // What each chapter would send: its panels and narration lines, which is what the prompt grows with.
  const rows = await deps.db
    .select({
      id: chapters.id,
      order: chapters.order,
      panels: sql<number>`(select count(*)::int from panels pn join pages pg on pg.id = pn.page_id where pg.chapter_id = "chapters"."id")`,
      lines: sql<number>`(select count(*)::int from narration_lines nl where nl.chapter_id = "chapters"."id")`,
    })
    .from(chapters)
    .where(and(eq(chapters.projectId, p.id), input.chapterId ? eq(chapters.id, input.chapterId) : undefined))
    .orderBy(asc(chapters.order));
  if (input.chapterId && !rows.length) throw notFound("Chapter");
  const eligible = rows.filter((r) => r.panels + r.lines > 0);
  const run = await textRun(c, input.ai);
  assertBatchable(c, input.batch, run.provider);
  const rate = await deps.usage.rateFor(run.provider, input.batch ? batchModel(run.model) : run.model);
  const [facts] = await deps.db
    .select({ n: sql<number>`count(*)::int` })
    .from(bibleFacts)
    .where(eq(bibleFacts.projectId, p.id));
  // About 2,500 tokens of instructions and schema, ~80 per panel, ~60 per narration line, ~30 per bible entry.
  const tokens = (r: (typeof rows)[number]) =>
    2500 + Math.min(r.panels, 400) * 80 + Math.min(r.lines, 400) * 60 + Math.min(facts?.n ?? 0, 160) * 30;
  const estimatedUsd = rate
    ? eligible.reduce(
        (s, r) =>
          s +
          estimateCostUsd(
            {
              textInputTokens: tokens(r),
              cachedInputTokens: 0,
              textOutputTokens: 1500,
              imageInputTokens: 0,
              imageOutputTokens: 0,
              images: 0,
            },
            rate,
          ),
        0,
      )
    : null;
  const estimate = {
    count: eligible.length,
    skipped: rows.length - eligible.length,
    estimatedUsd,
    provider: { provider: run.provider, model: run.model },
    batch: input.batch,
  };
  if (!input.confirm) return c.json({ confirmRequired: true, ...estimate, budget: await projectBudget(deps.db, p.id) });
  await assertBudget(c, p.id, estimatedUsd ?? 0);
  if (!eligible.length) throw conflict("Nothing to check yet: plan a chapter or write its narration first");
  const batchId = crypto.randomUUID();
  const jobs = await deps.db.transaction(async (tx) => {
    const out = [];
    for (const r of eligible)
      out.push(
        await deps.jobs.createGenerationJob(
          tx,
          {
            projectId: p.id,
            userId: user(c).id,
            kind: "continuity_check",
            priority: input.chapterId ? PRIORITY.single : PRIORITY.chapter,
            targetType: "chapter",
            targetId: r.id,
            batchId,
            templateName: continuityCheckV1.name,
            templateVersion: continuityCheckV1.version,
            provider: run.provider,
            model: run.model,
            parameters: { ...run.parameters, ...batchParameters(input.batch) },
            input: { chapterId: r.id },
          },
          { enqueue: !input.batch },
        ),
      );
    return out;
  });
  if (input.batch) await queueTextBatchSubmit(c, { projectId: p.id, batchId, ai: input.ai });
  await deps.jobs.kick();
  await recordAudit(deps.db, {
    userId: user(c).id,
    projectId: p.id,
    action: "continuity.check",
    metadata: { chapters: jobs.length, chapterId: input.chapterId ?? null, batch: input.batch },
    requestId: c.get("requestId"),
  });
  return c.json({ batchId, jobs: jobs.map((j) => ({ id: j.id, chapterId: j.targetId })), ...estimate }, 202);
});

type Verdict = "pass" | "warn" | "fail";
const WORST: Verdict[] = ["fail", "warn", "pass"];

const ReportQuery = z.object({
  chapterId: Uuid.optional(),
  status: z.enum(["open", "resolved", "all"]).default("all"),
});
doc({
  method: "GET",
  path: "/api/projects/:projectId/continuity",
  summary:
    "The continuity report: findings (with where to fix them), each fixed rule's verdict per chapter from its latest check, and the checks still running.",
  tag: "bible",
  query: ReportQuery,
});
continuityRoutes.get("/projects/:projectId/continuity", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const q = query(c, ReportQuery);
  const { db } = c.get("deps");
  const chs = await db
    .select({ id: chapters.id, order: chapters.order, title: chapters.title })
    .from(chapters)
    .where(eq(chapters.projectId, p.id))
    .orderBy(asc(chapters.order));
  const findings = await db
    .select()
    .from(continuityFindings)
    .where(
      and(
        eq(continuityFindings.projectId, p.id),
        q.chapterId ? eq(continuityFindings.chapterId, q.chapterId) : undefined,
        q.status === "open"
          ? eq(continuityFindings.status, "open")
          : q.status === "resolved"
            ? inArray(continuityFindings.status, ["fixed", "ignored", "explained"])
            : undefined,
      ),
    )
    .orderBy(desc(continuityFindings.createdAt));
  const order = (id: string) => chs.find((x) => x.id === id)?.order ?? 0;
  const rank = { high: 0, medium: 1, low: 2 } as const;
  findings.sort((a, b) => order(a.chapterId) - order(b.chapterId) || rank[a.severity] - rank[b.severity]);

  // The latest finished check of each chapter carries that chapter's verdict for every fixed rule it was given.
  const latest = await db.execute<{
    target_id: string;
    result: { rules?: { factId: string; verdict: Verdict; note: string }[] };
    finished_at: string;
  }>(
    sql`select distinct on (target_id) target_id, result, finished_at from generation_jobs
        where project_id = ${p.id} and kind = 'continuity_check' and status = 'completed'
        order by target_id, created_at desc`,
  );
  const fixed = await db
    .select()
    .from(bibleFacts)
    .where(and(eq(bibleFacts.projectId, p.id), eq(bibleFacts.fixed, true)))
    .orderBy(asc(bibleFacts.createdAt));
  const rules = fixed.map((f) => {
    const perChapter = [...latest]
      .flatMap((j) => {
        const v = j.result?.rules?.find((r) => r.factId === f.id);
        return v && chs.some((x) => x.id === j.target_id)
          ? [
              {
                chapterId: j.target_id,
                order: order(j.target_id),
                verdict: v.verdict,
                note: v.note,
                checkedAt: j.finished_at,
              },
            ]
          : [];
      })
      .filter((v) => !q.chapterId || v.chapterId === q.chapterId)
      .sort((a, b) => a.order - b.order);
    return {
      factId: f.id,
      kind: f.kind,
      subject: f.subject,
      text: f.text,
      verdict: WORST.find((w) => perChapter.some((v) => v.verdict === w)) ?? null,
      chapters: perChapter,
    };
  });
  const running = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(generationJobs)
    .where(
      and(
        eq(generationJobs.projectId, p.id),
        eq(generationJobs.kind, "continuity_check"),
        inArray(generationJobs.status, ["queued", "processing", "submitted", "awaiting_input"]),
      ),
    );
  return c.json({ chapters: chs, findings, rules, running: running[0]?.n ?? 0 });
});

async function findingOf(c: Context<AppEnv>) {
  const [f] = await c
    .get("deps")
    .db.select()
    .from(continuityFindings)
    .where(eq(continuityFindings.id, uuidParam(c, "id")));
  if (!f) throw notFound("Finding");
  await projectAccess(c, f.projectId, "write");
  return f;
}

const Resolve = z.object({
  /** fixed: you changed the place it names. ignored: it is not a problem (say why). open: back on the queue. */
  status: z.enum(["open", "fixed", "ignored"]),
  reason: z.string().trim().max(1000).default(""),
});
doc({
  method: "PATCH",
  path: "/api/continuity-findings/:id",
  summary: "Mark a finding fixed, ignored (with a reason, so later checks do not raise it again) or open again",
  tag: "bible",
  body: Resolve,
});
continuityRoutes.patch("/continuity-findings/:id", async (c) => {
  const f = await findingOf(c);
  const input = await body(c, Resolve);
  const open = input.status === "open";
  const [finding] = await c
    .get("deps")
    .db.update(continuityFindings)
    .set({
      status: input.status,
      resolution: open ? "" : input.reason,
      resolvedByUserId: open ? null : user(c).id,
      resolvedAt: open ? null : new Date(),
    })
    .where(eq(continuityFindings.id, f.id))
    .returning();
  return c.json({ finding });
});

const Explain = z.object({ fact: FactInput });
doc({
  method: "POST",
  path: "/api/continuity-findings/:id/explain",
  summary:
    "Explain a finding with a new story bible fact (it is not a contradiction because…): saves the fact and marks the finding explained",
  tag: "bible",
  body: Explain,
});
continuityRoutes.post("/continuity-findings/:id/explain", async (c) => {
  const f = await findingOf(c);
  const { fact: input } = await body(c, Explain);
  const { db } = c.get("deps");
  const ids = [input.fromChapterId, input.untilChapterId].filter((x): x is string => Boolean(x));
  if (ids.length) {
    const found = await db
      .select({ id: chapters.id })
      .from(chapters)
      .where(and(eq(chapters.projectId, f.projectId), inArray(chapters.id, ids)));
    if (found.length !== new Set(ids).size) throw notFound("Chapter");
  }
  const out = await db.transaction(async (tx) => {
    const [fact] = await tx
      .insert(bibleFacts)
      .values({ ...input, projectId: f.projectId, source: "continuity", createdByUserId: user(c).id })
      .returning();
    const [finding] = await tx
      .update(continuityFindings)
      .set({
        status: "explained",
        resolution: input.text,
        factId: fact!.id,
        resolvedByUserId: user(c).id,
        resolvedAt: new Date(),
      })
      .where(eq(continuityFindings.id, f.id))
      .returning();
    return { fact, finding };
  });
  return c.json(out, 201);
});
