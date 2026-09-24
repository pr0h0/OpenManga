import { AsyncLocalStorage } from "node:async_hooks";
import { auditEvents, type DbOrTx, errorEvents } from "@openmanga/db";

/**
 * The connected agent acting in the current async call chain, if any. The MCP layer sets it around each tool call,
 * so every audit event recorded underneath (by the same routes the web app uses) is attributed to the connection
 * without those routes knowing MCP exists.
 */
export const agentContext = new AsyncLocalStorage<{ serviceId: string; serviceName: string }>();

export async function recordAudit(
  db: DbOrTx,
  e: {
    userId?: string | null;
    projectId?: string | null;
    action: string;
    targetType?: string;
    targetId?: string;
    metadata?: Record<string, unknown>;
    ip?: string | null;
    requestId?: string | null;
    serviceId?: string | null;
  },
) {
  const agent = agentContext.getStore();
  await db.insert(auditEvents).values({
    userId: e.userId ?? null,
    projectId: e.projectId ?? null,
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    // "<connection> via <user>": the name is kept beside the id, so history still reads after a revoke.
    metadata: agent ? { ...(e.metadata ?? {}), via: agent.serviceName } : (e.metadata ?? {}),
    ip: e.ip ?? null,
    requestId: e.requestId ?? null,
    serviceId: e.serviceId ?? agent?.serviceId ?? null,
  });
}

export async function recordError(
  db: DbOrTx,
  e: {
    source: string;
    code?: string | null;
    message: string;
    requestId?: string | null;
    jobId?: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  await db
    .insert(errorEvents)
    .values({
      source: e.source,
      code: e.code ?? null,
      message: e.message.slice(0, 2000),
      requestId: e.requestId ?? null,
      jobId: e.jobId ?? null,
      metadata: e.metadata ?? {},
    })
    .catch(() => {});
}
