import { z } from "zod";

const str = z.string().trim();

/** The in-app agent's plan for a goal, shown to the user before anything runs. */
export const AgentPlan = z.object({
  summary: str.min(1).max(2000),
  steps: z
    .array(z.object({ title: str.min(1).max(300), tools: z.array(str.min(1).max(80)).max(10).default([]) }))
    .min(1)
    .max(20),
  estimatedCostUsd: z.number().min(0).max(100_000).nullable().default(null),
  risks: str.max(1000).default(""),
});
export type AgentPlan = z.infer<typeof AgentPlan>;

/** The agent's next move: one tool call, or done with a summary. */
export const AgentStep = z.object({
  thought: str.max(2000).default(""),
  action: z
    .object({ tool: str.min(1).max(80), arguments: z.record(z.string(), z.unknown()).default({}) })
    .nullable()
    .default(null),
  done: z.boolean().default(false),
  summary: str.max(4000).default(""),
});
export type AgentStep = z.infer<typeof AgentStep>;
