import { agentRuns, and, desc, eq, generationJobs, mcpApprovalRequests } from "@openmanga/db";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.ts";
import { projectAccess } from "../lib/access.ts";
import { advanceAgentRun, agentService, projectSpendUsd } from "../lib/agent.ts";
import { AiChoiceInput, assertBudget, textRun } from "../lib/ai.ts";
import { body, conflict, notFound, user, uuidParam } from "../lib/http.ts";
import { doc } from "../lib/openapi.ts";
import { approvalView } from "../mcp/approvals.ts";

/** The in-app project agent. Mounted beside agent access, never on the router MCP tools call: an agent cannot start one. */
export const agentRunRoutes = new Hono<AppEnv>();

const NewRun = z.object({
  goal: z.string().trim().min(3).max(4000),
  budgetUsd: z.number().min(0).max(10_000).nullable().default(null),
  ai: AiChoiceInput,
});
doc({
  method: "POST",
  path: "/api/projects/:projectId/agent-runs",
  summary:
    "Start the project agent on a goal. It first writes a plan, which waits for approval (POST /api/agent-runs/:id/plan); it then works one tool call at a time through the MCP tools as your in-app agent connection, limited to this project, asking for approval wherever that connection's approval mode says. `budgetUsd` stops it once the project has spent that much since the run started.",
  tag: "agent",
  body: NewRun,
});
agentRunRoutes.post("/projects/:projectId/agent-runs", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "write");
  const input = await body(c, NewRun);
  await assertBudget(c, p.id);
  const run = await textRun(c, input.ai);
  const deps = c.get("deps");
  const service = await agentService(deps, user(c).id);
  const [row] = await deps.db
    .insert(agentRuns)
    .values({
      userId: user(c).id,
      projectId: p.id,
      serviceId: service.id,
      goal: input.goal,
      budgetUsd: input.budgetUsd === null ? null : String(input.budgetUsd),
      spendAtStartUsd: String(await projectSpendUsd(deps, p.id)),
      run: { provider: run.provider, model: run.model, parameters: run.parameters },
    })
    .returning();
  await advanceAgentRun(deps, row!.id);
  return c.json({ run: await view(c, row!.id) }, 201);
});

doc({
  method: "GET",
  path: "/api/projects/:projectId/agent-runs",
  summary: "Your agent runs in a project, newest first",
  tag: "agent",
});
agentRunRoutes.get("/projects/:projectId/agent-runs", async (c) => {
  const p = await projectAccess(c, uuidParam(c, "projectId"), "read");
  const rows = await c
    .get("deps")
    .db.select({
      id: agentRuns.id,
      goal: agentRuns.goal,
      status: agentRuns.status,
      summary: agentRuns.summary,
      createdAt: agentRuns.createdAt,
      finishedAt: agentRuns.finishedAt,
    })
    .from(agentRuns)
    .where(and(eq(agentRuns.projectId, p.id), eq(agentRuns.userId, user(c).id)))
    .orderBy(desc(agentRuns.createdAt))
    .limit(50);
  return c.json({ runs: rows });
});

/** A run is its starter's: another member of the project does not see it. */
async function ownRun(c: Parameters<typeof uuidParam>[0], id: string) {
  const [r] = await c.get("deps").db.select().from(agentRuns).where(eq(agentRuns.id, id));
  if (!r || r.userId !== user(c).id) throw notFound("Agent run");
  await projectAccess(c, r.projectId, "read");
  return r;
}

/** The run with what the page needs beside it: the thinking job's state and the approval it waits on. */
async function view(c: Parameters<typeof uuidParam>[0], id: string) {
  const deps = c.get("deps");
  const r = await ownRun(c, id);
  const [job] = r.currentJobId
    ? await deps.db
        .select({ id: generationJobs.id, status: generationJobs.status, failureReason: generationJobs.failureReason })
        .from(generationJobs)
        .where(eq(generationJobs.id, r.currentJobId))
    : [];
  const [approval] = r.approvalRequestId
    ? await deps.db.select().from(mcpApprovalRequests).where(eq(mcpApprovalRequests.id, r.approvalRequestId))
    : [];
  const { lockedUntil: _l, run: _r, ...rest } = r;
  return {
    ...rest,
    model: r.run.model,
    job: job ?? null,
    approval: approval ? approvalView(deps, approval) : null,
    spentUsd: Math.max(0, (await projectSpendUsd(deps, r.projectId)) - Number(r.spendAtStartUsd)),
  };
}

doc({
  method: "GET",
  path: "/api/agent-runs/:id",
  summary: "An agent run: plan, steps, the approval it waits on. Reading it also moves it on when it can.",
  tag: "agent",
});
agentRunRoutes.get("/agent-runs/:id", async (c) => {
  const id = uuidParam(c, "id");
  await ownRun(c, id);
  await advanceAgentRun(c.get("deps"), id);
  return c.json({ run: await view(c, id) });
});

const PlanDecision = z.object({
  decision: z.enum(["approve", "revise"]),
  /** What to change, when sending the plan back. */
  feedback: z.string().trim().max(2000).optional(),
});
doc({
  method: "POST",
  path: "/api/agent-runs/:id/plan",
  summary: "Approve the agent's plan (it starts working), or send it back with feedback for a new plan.",
  tag: "agent",
  body: PlanDecision,
});
agentRunRoutes.post("/agent-runs/:id/plan", async (c) => {
  const r = await ownRun(c, uuidParam(c, "id"));
  const input = await body(c, PlanDecision);
  if (r.status !== "awaiting_plan") throw conflict("The run is not waiting for its plan to be approved");
  if (input.decision === "revise" && !input.feedback) throw conflict("Say what to change in the plan");
  const deps = c.get("deps");
  await deps.db
    .update(agentRuns)
    .set(
      input.decision === "approve"
        ? { status: "running" }
        : { status: "planning", feedback: input.feedback!, currentJobId: null },
    )
    .where(and(eq(agentRuns.id, r.id), eq(agentRuns.status, "awaiting_plan")));
  await advanceAgentRun(deps, r.id);
  return c.json({ run: await view(c, r.id) });
});

doc({
  method: "POST",
  path: "/api/agent-runs/:id/cancel",
  summary: "Stop an agent run; its thinking job is cancelled",
  tag: "agent",
});
agentRunRoutes.post("/agent-runs/:id/cancel", async (c) => {
  const r = await ownRun(c, uuidParam(c, "id"));
  if (["completed", "stopped", "failed", "cancelled"].includes(r.status)) return c.json({ run: await view(c, r.id) });
  const deps = c.get("deps");
  if (r.currentJobId) await deps.jobs.cancelGeneration(r.currentJobId).catch(() => null);
  await deps.db
    .update(agentRuns)
    .set({ status: "cancelled", currentJobId: null, finishedAt: new Date() })
    .where(eq(agentRuns.id, r.id));
  return c.json({ run: await view(c, r.id) });
});
