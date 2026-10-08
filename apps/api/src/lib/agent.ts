import {
  type AgentRunStep,
  agentRuns,
  and,
  chapters,
  eq,
  generationJobs,
  inArray,
  isNull,
  projects,
  sql,
  userServices,
} from "@openmanga/db";
import { PRIORITY } from "@openmanga/domain";
import { agentPlanV1, agentStepV1 } from "@openmanga/prompts";
import type { AgentPlan, AgentStep } from "@openmanga/schemas";
import { z } from "zod";
import type { Deps } from "../context.ts";
import { approvalRun, runTool } from "../mcp/approvals.ts";
import { loadActor, type McpActor } from "../mcp/context.ts";
import type { McpTool } from "../mcp/registry.ts";
import { asToolError } from "../mcp/runtime.ts";
import { ALL_SCOPES } from "../mcp/scopes.ts";
import { visibleTo } from "../mcp/server.ts";
import { MCP_TOOLS } from "../mcp/tools/index.ts";

type Run = typeof agentRuns.$inferSelect;

/** A run gives up after this many tool calls, whatever the plan says. */
export const MAX_AGENT_STEPS = 25;
/** Tools the agent never gets: it works inside one project and never makes, copies or deletes projects. */
const EXCLUDED = new Set(["create_project", "duplicate_project", "delete_project", "list_projects"]);
const ACTIVE = ["planning", "running", "waiting_approval"] as const;

/**
 * The user's in-app agent connection, made the first time they start a run: every scope, approval asked for anything
 * that spends or changes (they can loosen that in Agent access like any connection). Each run narrows it to its
 * one project.
 */
export async function agentService(deps: Deps, userId: string) {
  const [s] = await deps.db
    .select()
    .from(userServices)
    .where(and(eq(userServices.userId, userId), eq(userServices.kind, "app"), isNull(userServices.revokedAt)));
  if (s) return s;
  const [made] = await deps.db
    .insert(userServices)
    .values({
      userId,
      kind: "app",
      name: "In-app agent",
      scopes: [...ALL_SCOPES],
      projectAccess: "all",
      allowProjectCreate: false,
      approvalMode: "REQUIRE_APPROVAL",
    })
    .returning();
  return made!;
}

async function actorFor(deps: Deps, run: Run): Promise<McpActor | null> {
  const a = await loadActor(deps.db, run.serviceId);
  return a && { ...a, projectAccess: "selected", projectIds: new Set([run.projectId]), allowProjectCreate: false };
}

const toolsFor = (actor: McpActor) => MCP_TOOLS.filter((t) => visibleTo(t, actor) && !EXCLUDED.has(t.name));
const firstSentences = (s: string, max = 280) => (s.length <= max ? s : `${s.slice(0, max).replace(/\s+\S*$/, "")}…`);
const catalogue = (tools: McpTool[]) =>
  tools.map((t) => ({ name: t.name, description: firstSentences(t.description) }));
const schemaOf = (t: McpTool) => {
  try {
    return z.toJSONSchema(t.input as z.ZodType, { unrepresentable: "any" });
  } catch {
    return { type: "object" };
  }
};
/** A result cut to `max` characters of JSON, so a long listing cannot fill the prompt. */
const clip = (v: unknown, max: number) => {
  const s = JSON.stringify(v ?? null);
  return s.length <= max ? v : `${s.slice(0, max)}… (cut; ${s.length} characters)`;
};

/** Everything the project has recorded as spent, in USD. */
export async function projectSpendUsd(deps: Deps, projectId: string) {
  const [r] = await deps.db.execute<{ usd: number }>(
    sql`select coalesce(sum(estimated_cost_usd), 0)::float as usd from ai_usage where project_id = ${projectId}`,
  );
  return r?.usd ?? 0;
}

async function queueThinking(deps: Deps, run: Run, phase: "plan" | "step", prompt: unknown) {
  const tpl = phase === "plan" ? agentPlanV1 : agentStepV1;
  const job = await deps.db.transaction((tx) =>
    deps.jobs.createGenerationJob(tx, {
      projectId: run.projectId,
      userId: run.userId,
      kind: "agent_step",
      priority: PRIORITY.interactive,
      targetType: "agent_run",
      targetId: run.id,
      templateName: tpl.name,
      templateVersion: tpl.version,
      provider: run.run.provider,
      model: run.run.model,
      parameters: run.run.parameters,
      input: { runId: run.id, phase, prompt },
    }),
  );
  await deps.jobs.kick();
  return job.id;
}

async function planPrompt(deps: Deps, run: Run, tools: McpTool[]) {
  const [p] = await deps.db.select().from(projects).where(eq(projects.id, run.projectId));
  const [n] = await deps.db.execute<{ n: number }>(
    sql`select count(*)::int as n from ${chapters} where ${chapters.projectId} = ${run.projectId}`,
  );
  return {
    goal: run.goal,
    project: {
      id: p!.id,
      title: p!.title,
      description: p!.description,
      format: p!.settings.format ?? "comic",
      language: p!.language,
      chapters: n?.n ?? 0,
    },
    tools: catalogue(tools),
    budgetUsd: run.budgetUsd === null ? null : Number(run.budgetUsd),
    revision: run.feedback ? { plan: run.plan, feedback: run.feedback } : null,
  };
}

function stepPrompt(run: Run, tools: McpTool[], budgetLeftUsd: number | null) {
  const plan = run.plan as AgentPlan | null;
  // The schemas of the tools the plan names, and of any the agent looked up since: the rest are names only.
  const named = new Set([
    ...(plan?.steps ?? []).flatMap((s) => s.tools),
    ...run.steps.flatMap((s) =>
      s.tool === "describe_tools" && Array.isArray(s.arguments?.names) ? (s.arguments.names as string[]) : [],
    ),
  ]);
  const schemas = Object.fromEntries(tools.filter((t) => named.has(t.name)).map((t) => [t.name, schemaOf(t)]));
  const recent = run.steps.length - 3;
  return {
    goal: run.goal,
    projectId: run.projectId,
    plan,
    tools: catalogue(tools),
    schemas,
    // ponytail: older results are cut harder than the last three; a summary step would keep long runs smaller.
    history: run.steps.map((s, i) => ({ ...s, result: clip(s.result, i >= recent ? 6000 : 600) })),
    stepsLeft: MAX_AGENT_STEPS - run.steps.filter((s) => s.tool).length,
    budgetLeftUsd,
  };
}

/** Runs the tool the model chose, as the run's narrowed connection. Never throws: an error is a step result. */
async function callTool(deps: Deps, run: Run, actor: McpActor, tools: McpTool[], step: AgentStep) {
  const base = { at: new Date().toISOString(), thought: step.thought };
  const name = step.action!.tool;
  const args = { ...step.action!.arguments };
  if (name === "describe_tools") {
    const names = Array.isArray(args.names) ? (args.names as unknown[]).map(String) : [];
    const found = tools.filter((t) => names.includes(t.name));
    return {
      ...base,
      tool: name,
      arguments: args,
      status: "completed",
      result: Object.fromEntries(found.map((t) => [t.name, { description: t.description, input: schemaOf(t) }])),
    } satisfies AgentRunStep;
  }
  const tool = tools.find((t) => t.name === name);
  if (!tool)
    return {
      ...base,
      tool: name,
      arguments: args,
      status: "error",
      result: { code: "unknown_tool", message: `There is no tool called ${name}. Use a name from the catalogue.` },
    } satisfies AgentRunStep;
  try {
    const r = await runTool(deps, actor, tool, args, `agent-${run.id}-${run.steps.length + 1}`);
    if (r.status === "pending_approval")
      return {
        ...base,
        tool: name,
        arguments: args,
        status: "pending_approval",
        approvalRequestId: r.approval!.approvalRequestId,
        result: { summary: r.approval!.summary, estimatedCostUsd: r.approval!.estimatedCostUsd },
      } satisfies AgentRunStep;
    return {
      ...base,
      tool: name,
      arguments: args,
      status: "completed",
      result: clip(r.data, 20_000),
    } satisfies AgentRunStep;
  } catch (e) {
    const err = asToolError(e);
    return {
      ...base,
      tool: name,
      arguments: args,
      status: "error",
      result: { code: err.code, message: err.message, details: clip(err.details, 2000) },
    } satisfies AgentRunStep;
  }
}

async function save(deps: Deps, id: string, patch: Partial<typeof agentRuns.$inferInsert>) {
  const [r] = await deps.db.update(agentRuns).set(patch).where(eq(agentRuns.id, id)).returning();
  return r!;
}
const finish = (status: "completed" | "stopped" | "failed", extra: Partial<typeof agentRuns.$inferInsert> = {}) => ({
  status,
  currentJobId: null,
  finishedAt: new Date(),
  ...extra,
});

/**
 * Moves a run one notch: collects a finished thinking job, runs the tool it chose or notes the plan, and queues the
 * next thinking job. Called on every read of the run (so a watched run moves at once) and by the API's timer. One
 * caller at a time: the run is leased while it advances.
 */
export async function advanceAgentRun(deps: Deps, runId: string) {
  const [run] = await deps.db
    .update(agentRuns)
    .set({ lockedUntil: sql`now() + interval '2 minutes'` })
    .where(
      and(
        eq(agentRuns.id, runId),
        inArray(agentRuns.status, [...ACTIVE]),
        sql`(${agentRuns.lockedUntil} is null or ${agentRuns.lockedUntil} < now())`,
      ),
    )
    .returning();
  if (!run) return;
  try {
    await step(deps, run);
  } catch (e) {
    deps.logger.error("agent run failed to advance", { runId, error: String(e) });
    await save(deps, run.id, finish("failed", { error: "Something went wrong running this step." }));
  } finally {
    await deps.db.update(agentRuns).set({ lockedUntil: null }).where(eq(agentRuns.id, run.id));
  }
}

async function step(deps: Deps, run: Run) {
  const actor = await actorFor(deps, run);
  if (!actor) return save(deps, run.id, finish("failed", { error: "The in-app agent's access was turned off." }));
  const tools = toolsFor(actor);

  if (run.status === "waiting_approval") {
    const r = await approvalRun(deps, run.serviceId, run.approvalRequestId!).catch(() => null);
    if (r?.status === "pending_approval") return;
    const view = r?.data as { status: string; result?: unknown; error?: unknown; next?: string } | undefined;
    const outcome: AgentRunStep["status"] =
      view?.status === "executed" ? "completed" : view?.status === "denied" ? "denied" : "error";
    const steps = run.steps.map((s) =>
      s.approvalRequestId === run.approvalRequestId && s.status === "pending_approval"
        ? { ...s, status: outcome, result: clip(view?.status === "executed" ? view.result : view, 6000) }
        : s,
    );
    return save(deps, run.id, { steps, status: "running", approvalRequestId: null });
  }

  if (run.currentJobId) {
    const [job] = await deps.db.select().from(generationJobs).where(eq(generationJobs.id, run.currentJobId));
    if (!job || job.status === "failed" || job.status === "cancelled")
      return save(
        deps,
        run.id,
        finish("failed", { error: job?.failureReason || "The agent's thinking step did not finish." }),
      );
    if (job.status !== "completed") return;
    const result = job.result as { plan?: AgentPlan; step?: AgentStep };
    if (run.status === "planning")
      return save(deps, run.id, { status: "awaiting_plan", plan: result.plan!, currentJobId: null });
    const next = result.step!;
    if (next.done || !next.action) {
      const steps = [
        ...run.steps,
        { at: new Date().toISOString(), thought: next.thought, tool: null, status: "finished" as const },
      ];
      return save(deps, run.id, finish("completed", { steps, summary: next.summary || next.thought }));
    }
    const done = await callTool(deps, run, actor, tools, next);
    const steps = [...run.steps, done];
    return save(deps, run.id, {
      steps,
      currentJobId: null,
      ...(done.status === "pending_approval"
        ? { status: "waiting_approval", approvalRequestId: done.approvalRequestId }
        : {}),
    });
  }

  if (run.status === "planning") {
    const id = await queueThinking(deps, run, "plan", await planPrompt(deps, run, tools));
    return save(deps, run.id, { currentJobId: id });
  }
  // running, between steps: check the limits, then think about the next one.
  const calls = run.steps.filter((s) => s.tool).length;
  if (calls >= MAX_AGENT_STEPS)
    return save(deps, run.id, finish("stopped", { error: `Stopped after ${MAX_AGENT_STEPS} steps.` }));
  let left: number | null = null;
  if (run.budgetUsd !== null) {
    left = Number(run.budgetUsd) - ((await projectSpendUsd(deps, run.projectId)) - Number(run.spendAtStartUsd));
    if (left <= 0)
      return save(
        deps,
        run.id,
        finish("stopped", { error: `Stopped: the run's budget ($${run.budgetUsd}) is spent.` }),
      );
  }
  const id = await queueThinking(deps, run, "step", stepPrompt(run, tools, left));
  return save(deps, run.id, { currentJobId: id });
}

/** Advance every active run; called on a timer by the API process. */
export async function tickAgentRuns(deps: Deps) {
  const rows = await deps.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(inArray(agentRuns.status, [...ACTIVE]));
  for (const r of rows) await advanceAgentRun(deps, r.id);
}
