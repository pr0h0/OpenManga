import { z } from "zod";
import type { Deps } from "../context.ts";
import type { McpActor } from "./context.ts";
import { type InvokeOptions, invoke } from "./runtime.ts";
import type { McpScope } from "./scopes.ts";

/**
 * How much a call can hurt, which decides whether a REQUIRE_APPROVAL connection parks it:
 * read and write run; sensitive-write, spend and delete wait for the user.
 */
export type Sensitivity = "read" | "write" | "sensitive-write" | "spend" | "delete";
export const PARKED: ReadonlySet<Sensitivity> = new Set(["sensitive-write", "spend", "delete"]);

/** What one concrete call is: its class, the stable key remembered rules match on, and what to show the user. */
export type Classification = {
  sensitivity: Sensitivity;
  actionKey: string;
  /** The project the call acts in (remembered rules are per project); null when it has none. */
  projectId: string | null;
  /** Plain English, shown on the approval screen. */
  summary: string;
  /**
   * The state of what the call acts on. Stored with a parked request and recomputed before it runs: any difference
   * (or the target being gone) makes the request stale instead of running an old decision against new state.
   */
  target?: unknown;
  /** Spending estimate shown with the request, when there is one. */
  estimate?: { estimatedUsd?: number | null; count?: number; provider?: unknown } & Record<string, unknown>;
};

export type ToolContext = {
  deps: Deps;
  actor: McpActor;
  requestId: string;
  /** True when this run is an approved request being executed: it may carry headers a direct call never gets. */
  approved: boolean;
  invoke: <T = Record<string, unknown>>(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    opts?: InvokeOptions,
  ) => Promise<T>;
};

export type ToolOutput = {
  data: unknown;
  links?: Record<string, string>;
  /** Extra content blocks (images for a manual question) next to the JSON text. */
  content?: ({ type: "image"; data: string; mimeType: string } | { type: "text"; text: string })[];
};

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: false;
};

export type McpTool<I extends z.ZodObject = z.ZodObject> = {
  name: string;
  title: string;
  /** Model-facing: what it does, side effects, spending, async behaviour, what to call next. */
  description: string;
  input: I;
  /** The shape of `data` in a successful result, documented and returned as the output schema. */
  output: z.ZodType;
  /** Every scope the tool can need; a call needs these unless `classify` narrows them per action. */
  scopes: McpScope[];
  /** The scopes one call needs, for a tool whose actions need different ones. Defaults to `scopes`. */
  scopesFor?: (args: z.infer<I>) => McpScope[];
  /** The worst class any call of this tool can have (the documented one); `classify` gives each call's own. */
  sensitivity: Sensitivity;
  /** Safe to repeat with the same arguments. */
  idempotent: boolean;
  /** The REST routes it wraps, for the catalogue. */
  routes: string[];
  /** Stable approval keys this tool can produce, for the catalogue. */
  actionKeys: string[];
  /** Classifies one call. Required for anything that is not a plain read. */
  classify?: (args: z.infer<I>, ctx: ToolContext) => Promise<Classification>;
  handler: (args: z.infer<I>, ctx: ToolContext) => Promise<ToolOutput>;
};

/** Every write that can repeat a side effect takes an optional caller-chosen key; a retry with it replays the result. */
export const IdempotencyKey = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[\w.:-]+$/)
  .optional()
  .describe(
    "Optional client request id. Retrying with the same key and arguments returns the first result instead of repeating the action; the same key with different arguments is a conflict.",
  );

export function defineMcpTool<I extends z.ZodObject>(t: McpTool<I>): McpTool<I> {
  if (t.sensitivity !== "read" && !t.classify) throw new Error(`${t.name}: a non-read tool needs classify`);
  return t;
}

export function annotationsFor(t: McpTool): ToolAnnotations {
  return {
    readOnlyHint: t.sensitivity === "read",
    destructiveHint: t.sensitivity === "delete" || t.sensitivity === "sensitive-write",
    idempotentHint: t.idempotent,
    openWorldHint: false,
  };
}

/**
 * The same envelope for every result: `status` says whether it ran (`data`) or is waiting for the user (`approval`:
 * approvalRequestId, action, summary, sensitivity, estimatedCostUsd, expiresAt, pollAfterSeconds, approvalUrl).
 * The approval part is left loose here — it is the same on every tool, and spelling it out 70 times made up a third
 * of tools/list.
 */
export const ResultEnvelope = (data: z.ZodType) =>
  z.object({
    ok: z.literal(true),
    status: z.enum(["completed", "pending_approval"]),
    data: data.optional(),
    approval: z.object({ approvalRequestId: z.string(), approvalUrl: z.string() }).passthrough().optional(),
    requestId: z.string(),
    links: z.record(z.string(), z.string()).optional(),
  });

export function toolContext(deps: Deps, actor: McpActor, requestId: string, approved: boolean): ToolContext {
  return {
    deps,
    actor,
    requestId,
    approved,
    invoke: (method, path, opts) => invoke(deps, actor, method, path, { requestId, ...opts }),
  };
}

/** A loose object output for results that pass the REST payload through: documented fields, anything else kept. */
export const Passthrough = z.object({}).passthrough();
