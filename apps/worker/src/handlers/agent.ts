import { agentPlanV1, agentStepV1 } from "@openmanga/prompts";
import { AgentPlan, AgentStep } from "@openmanga/schemas";
import type { WorkerDeps } from "../context.ts";
import { InputError, type ProjectJob } from "../lib/runner.ts";
import { structured } from "./text.ts";

/**
 * One step of the in-app agent's thinking. The API composes everything the model sees (goal, catalogue, history) into
 * the job's input and runs whatever tool it picks; this only asks the model and returns its answer.
 */
export async function agentStep(deps: WorkerDeps, job: ProjectJob) {
  const prompt = job.input.prompt as never;
  if (job.input.phase === "plan") {
    const r = await structured(deps, job, agentPlanV1.build(prompt), AgentPlan, "AgentPlan", 8_000);
    return { plan: r.data, repaired: r.repaired };
  }
  if (job.input.phase === "step") {
    const r = await structured(deps, job, agentStepV1.build(prompt), AgentStep, "AgentStep", 8_000);
    return { step: r.data, repaired: r.repaired };
  }
  throw new InputError("Unknown agent phase");
}
