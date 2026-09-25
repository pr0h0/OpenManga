import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  and,
  auditEvents,
  eq,
  mcpApprovalRequests,
  mcpIdempotency,
  oauthAccessTokens,
  personalAccessTokens,
  projects,
  sql,
  users,
} from "@openmanga/db";
import { mockStoryAnalysis } from "@openmanga/testing";
import { isPrivateAddress } from "../../apps/api/src/mcp/oauth.ts";
import { startHarness, type TestClient, waitFor } from "./harness.ts";

let h: Awaited<ReturnType<typeof startHarness>>;
let alice: TestClient;

const STORY = `Ines repairs lighthouses that nobody visits any more.
The keeper at Vell says the lamp turns by itself on the nights he forgets to wind it.
She stays awake to watch, and at three in the morning the lamp turns.
Ines writes the hour in her notebook and decides not to fix what is already working.`;

type Grant = {
  name: string;
  scopes: string[];
  projectAccess: "all" | "selected";
  projectIds?: string[];
  allowProjectCreate?: boolean;
  approvalMode?: "ALLOW_ALL" | "REQUIRE_APPROVAL";
  expiresInDays?: number | null;
};
const ALL = [
  "projects:read",
  "projects:write",
  "projects:create",
  "story:read",
  "story:write",
  "library:read",
  "library:write",
  "chapters:read",
  "chapters:write",
  "panels:read",
  "panels:write",
  "generations:read",
  "generations:run",
  "narration:read",
  "narration:write",
  "exports:read",
  "exports:create",
  "experts:use",
  "usage:read",
];

/** A request as it arrives over the network: with the Host header a real client always sends. */
const req = (url: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("host", new URL(url).host);
  return Promise.resolve(h.app.request(url, { ...init, headers }));
};

async function pat(grant: Grant) {
  return alice.post<{ token: string; connection: { id: string } }>("/api/agents/tokens", grant, 201);
}

/** An MCP client talking to the in-process app, exactly as a remote client would over HTTP. */
async function mcp(token: string) {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL("http://test.local/mcp"), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
    fetch: (url, init) => req(String(url), init as RequestInit),
  });
  await client.connect(transport);
  const call = async <T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }).catch((e: Error) => ({
      // A tool the connection is not shown is not callable: the protocol answers "not found".
      isError: true,
      content: [{ type: "text", text: JSON.stringify({ error: { code: "unknown_tool", message: e.message } }) }],
      structuredContent: undefined,
      _meta: undefined,
    }));
    const text = (r.content as { type: string; text?: string }[]).find((c) => c.type === "text")?.text ?? "{}";
    return {
      isError: Boolean(r.isError),
      structured: r.structuredContent as T & {
        status: string;
        approval?: { approvalRequestId: string; approvalUrl: string; sensitivity: string };
      },
      error: r.isError
        ? (JSON.parse(text) as { error: { code: string; message: string; details?: unknown } }).error
        : null,
      meta: r._meta as Record<string, unknown> | undefined,
      content: r.content as { type: string; mimeType?: string }[],
    };
  };
  return { client, call };
}

let allowAll: Awaited<ReturnType<typeof mcp>>;
let allowAllToken: string;
let projectId: string;
let analysisId: string;

beforeAll(async () => {
  h = await startHarness();
  alice = h.client();
  await alice.post(
    "/api/auth/register",
    { username: "agentowner", email: "agent@example.com", password: "agent-pass-123" },
    201,
  );
  const t = await pat({
    name: "Local agent",
    scopes: ALL,
    projectAccess: "all",
    allowProjectCreate: true,
    approvalMode: "ALLOW_ALL",
  });
  allowAllToken = t.token;
  allowAll = await mcp(t.token);
});
afterAll(() => h?.stop());

describe("discovery and authentication", () => {
  test("protected resource and authorization server metadata", async () => {
    const pr = await (await h.app.request("http://test.local/.well-known/oauth-protected-resource/mcp")).json();
    expect(pr.resource).toBe("http://test.local/mcp");
    expect(pr.authorization_servers).toEqual(["http://test.local"]);
    expect(pr.scopes_supported).toContain("projects:read");
    const as = await (await h.app.request("http://test.local/.well-known/oauth-authorization-server")).json();
    expect(as.issuer).toBe("http://test.local");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.token_endpoint_auth_methods_supported).toEqual(["none"]);
    expect(as.authorization_response_iss_parameter_supported).toBe(true);
    expect(as.client_id_metadata_document_supported).toBe(true);
  });

  test("no token: 401 with a resource_metadata challenge; a bad token: invalid_token", async () => {
    const res = await req("http://test.local/mcp", {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="http://test.local/.well-known/oauth-protected-resource/mcp"',
    );
    const bad = await req("http://test.local/mcp", {
      method: "POST",
      headers: { authorization: "Bearer om_pat_nope" },
    });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  test("a foreign Host is refused (DNS rebinding protection)", async () => {
    const res = await req("http://evil.example/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${allowAllToken}` },
    });
    expect(res.status).toBe(403);
  });

  test("a PAT is shown once and only its hash is stored", async () => {
    const rows = await h.deps.db.select().from(personalAccessTokens);
    expect(rows.every((r) => !r.tokenHash.includes("om_pat_") && r.tokenHash.length === 64)).toBe(true);
    const list = await alice.get<{ connections: Record<string, unknown>[] }>("/api/agents/connections");
    expect(JSON.stringify(list)).not.toContain(allowAllToken);
  });

  test("tools/list: every tool has a schema, annotations and an OAuth security scheme", async () => {
    const { tools } = await allowAll.client.listTools();
    expect(tools.length).toBeGreaterThan(50);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
      expect(t.annotations?.openWorldHint).toBe(false);
      expect((t._meta as { securitySchemes: unknown[] }).securitySchemes.length).toBe(1);
      expect(t.name).toMatch(/^[a-z_]+$/);
    }
    // No generic escape hatch.
    expect(tools.map((t) => t.name)).not.toContain("call_api");
  });

  test("server info, one answer schema, a filtered API description", async () => {
    const info = await allowAll.call<{ data: { connection: { approvalMode: string }; answerSchemas: string[] } }>(
      "get_server_info",
    );
    expect(info.structured.data.connection.approvalMode).toBe("ALLOW_ALL");
    expect(info.structured.data.answerSchemas).toContain("ScenePages");
    const schema = await allowAll.call("get_answer_schema", { name: "ChapterOutline" });
    const d = schema.structured.data as { name: string; interface: string; jsonSchema: object };
    expect(d.name).toBe("ChapterOutline");
    expect(d.interface).toContain("interface ChapterOutline");
    const api = await allowAll.call("describe_api", { tag: "chapters" });
    const ops = (api.structured.data as { operations: { tag: string; path: string }[] }).operations;
    expect(ops.length).toBeGreaterThan(0);
    expect(ops.length).toBeLessThanOrEqual(20);
    expect(ops.every((o) => o.tag === "chapters")).toBe(true);
    const admin = await allowAll.call("describe_api", { path: "/admin" });
    expect((admin.structured.data as { total: number }).total).toBe(0);
  });
});

describe("manual pipeline over MCP", () => {
  test("create project, save story, analyse in paste mode", async () => {
    const created = await allowAll.call<{ data: { project: { id: string } } }>("create_project", {
      title: "MCP Lighthouse",
    });
    projectId = created.structured.data.project.id;
    const rev = await allowAll.call<{ data: { revision: { id: string } } }>("save_story_revision", {
      projectId,
      content: STORY,
    });
    const run = await allowAll.call<{ data: { job: { id: string; status: string } } }>("run_story_analysis", {
      revisionId: rev.structured.data.revision.id,
      ai: { manual: true },
    });
    expect(run.isError).toBe(false);
    const jobId = run.structured.data.job.id;
    await waitFor(
      async () => {
        const j = await allowAll.call<{ data: { job: { status: string } } }>("get_job", { jobId });
        return j.structured.data.job.status === "awaiting_input";
      },
      { label: "analysis awaiting input" },
    );
    const prompt = await allowAll.call<{ data: { format: { name: string }; prompt: string; awaitingAnswer: boolean } }>(
      "get_manual_prompt",
      { jobId },
    );
    expect(prompt.structured.data.format.name).toBe("StoryAnalysis");
    expect(prompt.structured.data.awaitingAnswer).toBe(true);
    // A wrong answer is rejected with its reason and the job waits again.
    await allowAll.call("submit_manual_answer", { jobId, answer: { not: "an analysis" } });
    await waitFor(
      async () => {
        const p = await allowAll.call<{ data: { lastError: string | null; awaitingAnswer: boolean } }>(
          "get_manual_prompt",
          { jobId },
        );
        return p.structured.data.awaitingAnswer && p.structured.data.lastError?.includes("Invalid StoryAnalysis");
      },
      { label: "rejected answer" },
    );
    await allowAll.call("submit_manual_answer", { jobId, answer: mockStoryAnalysis(STORY) as Record<string, unknown> });
    await waitFor(
      async () => {
        const j = await allowAll.call<{ data: { job: { status: string } } }>("get_job", { jobId });
        return j.structured.data.job.status === "completed";
      },
      { label: "analysis completed" },
    );
    const story = await allowAll.call<{ data: { analyses: { id: string; status: string }[] } }>("get_story", {
      projectId,
    });
    analysisId = story.structured.data.analyses[0]!.id;
    const applied = await allowAll.call<{ data: { created: Record<string, number> } }>("apply_story_analysis", {
      analysisId,
    });
    expect(applied.isError).toBe(false);
  });

  test("plan a chapter by answering each question in turn", async () => {
    const list = await allowAll.call<{ data: { chapters: { id: string }[] } }>("list_chapters", { projectId });
    const chapterId = list.structured.data.chapters[0]!.id;
    const run = await allowAll.call<{ data: { job: { id: string } } }>("run_chapter_plan", {
      chapterId,
      ai: { manual: true },
    });
    const jobId = run.structured.data.job.id;
    const asked: string[] = [];
    for (let i = 0; i < 20; i++) {
      const state = await waitFor(
        async () => {
          const j = await allowAll.call<{ data: { job: { status: string } } }>("get_job", { jobId });
          const s = j.structured.data.job.status;
          return s === "awaiting_input" || s === "completed" || s === "failed" ? s : null;
        },
        { label: "plan step" },
      );
      if (state !== "awaiting_input") break;
      const p = await allowAll.call<{ data: { format: { name: string }; example: string; answered: number } }>(
        "get_manual_prompt",
        { jobId },
      );
      asked.push(p.structured.data.format.name);
      await allowAll.call("submit_manual_answer", { jobId, answer: p.structured.data.example });
      // Wait for the job to move off the answered question before looking again.
      await waitFor(async () => {
        const j = await allowAll.call<{ data: { job: { status: string; manualAnswers?: number } } }>("get_job", {
          jobId,
        });
        return j.structured.data.job.status !== "queued" || null;
      });
    }
    expect(asked[0]).toBe("ChapterOutline");
    expect(asked.slice(1).every((n) => n === "ScenePages")).toBe(true);
    expect(asked.length).toBeGreaterThan(1);
    const panels = await allowAll.call<{ data: { items: unknown[]; total: number; nextOffset: number | null } }>(
      "list_chapter_panels",
      { chapterId, limit: 2 },
    );
    expect(panels.structured.data.items.length).toBeLessThanOrEqual(2);
    expect(panels.structured.data.total).toBeGreaterThan(0);
    // The same state the browser sees: REST and MCP read the same rows.
    const rest = await alice.get<{ panels: unknown[] }>(`/api/chapters/${chapterId}/panels`);
    expect(rest.panels.length).toBe(panels.structured.data.total);
  });

  test("bulk generation needs a matching estimate token", async () => {
    const list = await allowAll.call<{ data: { chapters: { id: string }[] } }>("list_chapters", { projectId });
    const chapterId = list.structured.data.chapters[0]!.id;
    const est = await allowAll.call<{ data: { count: number; estimateToken: string } }>("estimate_bulk_generation", {
      projectId,
      scope: { chapterId },
    });
    expect(est.structured.data.count).toBeGreaterThan(0);
    const wrong = await allowAll.call("run_bulk_generation", {
      projectId,
      scope: { chapterId },
      estimateToken: "0000000000000000",
    });
    expect(wrong.error?.code).toBe("estimate_changed");
  });

  test("MCP actions are audited as the connection acting for the user", async () => {
    const rows = await h.deps.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.projectId, projectId), eq(auditEvents.action, "story.analysis_applied")));
    expect(rows[0]?.serviceId).toBeTruthy();
    expect((rows[0]?.metadata as { via?: string } | undefined)?.via).toBe("Local agent");
  });
});

describe("manual questions about images", () => {
  test("a manual check of generated artwork shows the image as MCP image content", async () => {
    const list = await allowAll.call<{ data: { chapters: { id: string }[] } }>("list_chapters", { projectId });
    const { panels } = await alice.get<{ panels: { id: string }[] }>(
      `/api/chapters/${list.structured.data.chapters[0]!.id}/panels`,
    );
    const panelId = panels[0]!.id;
    const gen = await allowAll.call<{ data: { job: { id: string } } }>("generate_panel", { panelId });
    await waitFor(
      async () => {
        const j = await allowAll.call<{ data: { job: { status: string } } }>("get_job", {
          jobId: gen.structured.data.job.id,
        });
        return j.structured.data.job.status === "completed";
      },
      { label: "panel art" },
    );
    const check = await allowAll.call<{ data: { job: { id: string } } }>("run_panel_check", {
      panelId,
      ai: { manual: true },
    });
    const jobId = check.structured.data.job.id;
    await waitFor(
      async () => {
        const j = await allowAll.call<{ data: { job: { status: string } } }>("get_job", { jobId });
        return j.structured.data.job.status === "awaiting_input";
      },
      { label: "check awaiting input" },
    );
    const p = await allowAll.call<{ data: { imagesIncluded: number; format: { name: string } } }>("get_manual_prompt", {
      jobId,
    });
    expect(p.structured.data.format.name).toBe("PanelCheck");
    expect(p.structured.data.imagesIncluded).toBeGreaterThan(0);
    expect(p.content.some((c) => c.type === "image" && c.mimeType?.startsWith("image/"))).toBe(true);
  });
});

describe("idempotency", () => {
  test("same key + same args replays; same key + different args conflicts", async () => {
    const a = await allowAll.call<{ data: { project: { id: string } } }>("create_project", {
      title: "Once",
      idempotencyKey: "create-once-1",
    });
    const b = await allowAll.call<{ data: { project: { id: string } } }>("create_project", {
      title: "Once",
      idempotencyKey: "create-once-1",
    });
    expect(b.structured.data.project.id).toBe(a.structured.data.project.id);
    const c = await allowAll.call("create_project", { title: "Other", idempotencyKey: "create-once-1" });
    expect(c.error?.code).toBe("idempotency_conflict");
  });

  test("simultaneous calls with one key act once", async () => {
    const runs = await Promise.all(
      Array.from({ length: 6 }, () =>
        allowAll.call<{ data: { project: { id: string } } }>("create_project", {
          title: "Race",
          idempotencyKey: "race-key-1",
        }),
      ),
    );
    const made = await h.deps.db.select().from(projects).where(eq(projects.title, "Race"));
    expect(made.length).toBe(1);
    // Every caller either got that one project or was told the call is still running.
    for (const r of runs)
      if (r.isError) expect(r.error?.code).toBe("operation_in_progress");
      else expect(r.structured.data.project.id).toBe(made[0]!.id);
    const again = await allowAll.call<{ data: { project: { id: string } } }>("create_project", {
      title: "Race",
      idempotencyKey: "race-key-1",
    });
    expect(again.structured.data.project.id).toBe(made[0]!.id);
  });

  test("an interrupted call leaves its key unknown, not free to act again", async () => {
    await allowAll.call("create_project", { title: "Crash", idempotencyKey: "crash-key-1" });
    const where = and(eq(mcpIdempotency.key, "crash-key-1"), eq(mcpIdempotency.toolName, "create_project"));
    await h.deps.db.update(mcpIdempotency).set({ state: "running", result: null, createdAt: new Date() }).where(where);
    const busy = await allowAll.call("create_project", { title: "Crash", idempotencyKey: "crash-key-1" });
    expect(busy.error?.code).toBe("operation_in_progress");
    await h.deps.db
      .update(mcpIdempotency)
      .set({ createdAt: new Date(Date.now() - 20 * 60_000) })
      .where(where);
    const lost = await allowAll.call("create_project", { title: "Crash", idempotencyKey: "crash-key-1" });
    expect(lost.error?.code).toBe("execution_unknown");
    expect((await h.deps.db.select().from(projects).where(eq(projects.title, "Crash"))).length).toBe(1);
  });

  test("a failed call frees its key for a corrected retry", async () => {
    const bad = await allowAll.call("save_story_revision", {
      revisionId: "00000000-0000-4000-8000-000000000000",
      content: "x",
      idempotencyKey: "fail-key-1",
    });
    expect(bad.error?.code).toBe("not_found");
    const rows = await h.deps.db.select().from(mcpIdempotency).where(eq(mcpIdempotency.key, "fail-key-1"));
    expect(rows.length).toBe(0);
  });
});

describe("scopes and project restrictions", () => {
  test("an access token lists only the tools it can call; a missing scope is still refused", async () => {
    const t = await pat({ name: "Reader", scopes: ["projects:read"], projectAccess: "all" });
    const reader = await mcp(t.token);
    const names = (await reader.client.listTools()).tools.map((x) => x.name);
    expect(names).toContain("list_projects");
    expect(names).toContain("get_server_info");
    expect(names).not.toContain("save_story_revision");
    expect(names).not.toContain("create_project");
    expect(names.length).toBeLessThan(15);
    const r = await reader.call("save_story_revision", { projectId, content: "x" });
    expect(r.error?.code).toBe("unknown_tool");
    // A tool it can see but whose action needs another scope gets the structured error.
    const run = await reader.call("list_projects");
    expect(run.isError).toBe(false);
    const t2 = await pat({ name: "Panel reader", scopes: ["panels:read"], projectAccess: "all" });
    const panelReader = await mcp(t2.token);
    const set = await panelReader.call("manage_panel_outfits", { action: "set", panelId: projectId });
    expect(set.error?.code).toBe("scope_missing");
  });

  test("a selected-project connection sees only its projects, by id or through an entity", async () => {
    const other = await alice.post<{ project: { id: string } }>(
      "/api/projects",
      { title: "Private", story: { content: STORY } },
      201,
    );
    const t = await pat({
      name: "One project",
      scopes: ALL,
      projectAccess: "selected",
      projectIds: [projectId],
      approvalMode: "ALLOW_ALL",
    });
    const scoped = await mcp(t.token);
    const listed = await scoped.call<{ data: { items: { id: string }[] } }>("list_projects");
    expect(listed.structured.data.items.map((p) => p.id)).toEqual([projectId]);
    const direct = await scoped.call("get_project", { projectId: other.project.id });
    expect(direct.error?.code).toBe("project_not_granted");
    const story = await alice.get<{ latest: { id: string } }>(`/api/projects/${other.project.id}/story`);
    const viaEntity = await scoped.call("get_story_revision", { revisionId: story.latest.id });
    expect(viaEntity.error?.code).toBe("project_not_granted");
    const write = await scoped.call("save_story_revision", { revisionId: story.latest.id, content: "hijack" });
    expect(write.error?.code).toBe("project_not_granted");
    // Creating is not allowed for this connection.
    const create = await scoped.call("create_project", { title: "Nope" });
    expect(create.error?.code).toBe("unknown_tool");
  });

  test("a project created by a selected-access connection is granted to it", async () => {
    const t = await pat({
      name: "Creator",
      scopes: ALL,
      projectAccess: "selected",
      allowProjectCreate: true,
      approvalMode: "ALLOW_ALL",
    });
    const creator = await mcp(t.token);
    const made = await creator.call<{ data: { project: { id: string } } }>("create_project", { title: "Mine" });
    const read = await creator.call("get_project", { projectId: made.structured.data.project.id });
    expect(read.isError).toBe(false);
  });

  test("another user's project is not found, not forbidden", async () => {
    const bob = h.client();
    await bob.post(
      "/api/auth/register",
      { username: "bobagent", email: "bob@example.com", password: "bob-pass-12345" },
      201,
    );
    const theirs = await bob.post<{ project: { id: string } }>("/api/projects", { title: "Bob's" }, 201);
    const r = await allowAll.call("get_project", { projectId: theirs.project.id });
    expect(r.error?.code).toBe("not_found");
  });
});

describe("approvals", () => {
  let gated: Awaited<ReturnType<typeof mcp>>;
  let chapterIds: string[];

  beforeAll(async () => {
    const t = await pat({
      name: "Careful agent",
      scopes: ALL,
      projectAccess: "selected",
      projectIds: [projectId],
      approvalMode: "REQUIRE_APPROVAL",
    });
    gated = await mcp(t.token);
    // Spare chapters to delete, so the planned first chapter survives for the later tests.
    for (const title of ["Spare A", "Spare B"])
      await alice.post(`/api/projects/${projectId}/chapters`, { title, summary: "spare" }, 201);
    const list = await gated.call<{ data: { chapters: { id: string }[] } }>("list_chapters", { projectId });
    chapterIds = list.structured.data.chapters.map((c) => c.id);
  });

  test("reads and ordinary writes run; a delete parks, once, and runs exactly once when approved", async () => {
    const edit = await gated.call("manage_chapter", {
      action: "update",
      chapterId: chapterIds[0],
      fields: { summary: "edited by agent" },
    });
    expect(edit.structured.status).toBe("completed");
    const first = await gated.call("manage_chapter", { action: "delete", chapterId: chapterIds.at(-1) });
    expect(first.isError).toBe(false);
    expect(first.structured.status).toBe("pending_approval");
    const id = first.structured.approval!.approvalRequestId;
    expect(first.structured.approval!.approvalUrl).toContain(id);
    // Retrying while it waits gives back the same request instead of a second one.
    const again = await gated.call("manage_chapter", { action: "delete", chapterId: chapterIds.at(-1) });
    expect(again.structured.approval!.approvalRequestId).toBe(id);
    const poll = await gated.call<{ data: { status: string } }>("get_approval_request", { approvalRequestId: id });
    expect(poll.structured.data.status).toBe("pending");

    const pending = await alice.get<{ approvals: { id: string }[] }>("/api/agents/approvals");
    expect(pending.approvals.map((a) => a.id)).toContain(id);
    const decided = await alice.post<{ approval: { status: string } }>(`/api/agents/approvals/${id}/decide`, {
      decision: "approve",
    });
    expect(decided.approval.status).toBe("executed");
    const twice = await alice.raw("POST", `/api/agents/approvals/${id}/decide`, { decision: "approve" });
    expect(twice.status).toBe(409);
    const done = await gated.call<{ data: { status: string; result: { data: { ok: boolean } } } }>(
      "get_approval_request",
      { approvalRequestId: id },
    );
    expect(done.structured.data.status).toBe("executed");
    expect(done.structured.data.result.data.ok).toBe(true);
    const audits = await h.deps.db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.action, "mcp.approval_executed"), eq(auditEvents.targetId, id)));
    expect(audits.length).toBe(1);
  });

  test("deny and remember: denied now, refused immediately next time without a new request", async () => {
    const r = await gated.call("set_project_status", { projectId, action: "trash" });
    const id = r.structured.approval!.approvalRequestId;
    await alice.post(`/api/agents/approvals/${id}/decide`, {
      decision: "deny",
      remember: true,
      reason: "not this one",
    });
    const poll = await gated.call<{ data: { status: string; decisionReason: string } }>("get_approval_request", {
      approvalRequestId: id,
    });
    expect(poll.structured.data.status).toBe("denied");
    expect(poll.structured.data.decisionReason).toBe("not this one");
    const before = await h.deps.db.select({ n: sql<number>`count(*)::int` }).from(mcpApprovalRequests);
    const later = await gated.call("set_project_status", { projectId, action: "trash" });
    expect(later.error?.code).toBe("approval_denied_by_rule");
    const after = await h.deps.db.select({ n: sql<number>`count(*)::int` }).from(mcpApprovalRequests);
    expect(after[0]!.n).toBe(before[0]!.n);
    // Flip the rule in the UI: now it runs without asking.
    const { rules } = await alice.get<{ rules: { id: string; actionKey: string }[] }>("/api/agents/rules");
    const rule = rules.find((x) => x.actionKey === "project.trash")!;
    await alice.patch(`/api/agents/rules/${rule.id}`, { decision: "ALLOW" });
    const allowed = await gated.call("set_project_status", { projectId, action: "trash" });
    expect(allowed.structured.status).toBe("completed");
    await alice.post(`/api/projects/${projectId}/status`, { action: "restore" });
  });

  test("a target that changed while waiting makes the request stale", async () => {
    const r = await gated.call("manage_chapter", { action: "delete", chapterId: chapterIds[1] });
    const id = r.structured.approval!.approvalRequestId;
    await alice.patch(`/api/chapters/${chapterIds[1]}`, { title: "Renamed meanwhile" });
    const d = await alice.post<{ approval: { status: string } }>(`/api/agents/approvals/${id}/decide`, {
      decision: "approve",
    });
    expect(d.approval.status).toBe("stale");
    // Nothing was deleted.
    await alice.get(`/api/chapters/${chapterIds[1]}`);
  });

  test("a scope removed while waiting fails the request instead of running it", async () => {
    const t = await pat({ name: "Shrinking", scopes: ALL, projectAccess: "all", approvalMode: "REQUIRE_APPROVAL" });
    const agent = await mcp(t.token);
    const r = await agent.call("manage_chapter", { action: "delete", chapterId: chapterIds[1] });
    const id = r.structured.approval!.approvalRequestId;
    await alice.patch(`/api/agents/connections/${t.connection.id}`, { scopes: ["projects:read"] });
    const d = await alice.post<{ approval: { status: string; error: { code: string } } }>(
      `/api/agents/approvals/${id}/decide`,
      { decision: "approve" },
    );
    expect(d.approval.status).toBe("failed");
    expect(d.approval.error.code).toBe("scope_missing");
  });

  test("spending parks; the same text work in manual mode runs at once", async () => {
    const { panels } = await alice.get<{ panels: { id: string }[] }>(`/api/chapters/${chapterIds[0]}/panels`);
    const spend = await gated.call("generate_panel", { panelId: panels[0]!.id });
    expect(spend.structured.status).toBe("pending_approval");
    expect(spend.structured.approval!.sensitivity).toBe("spend");
    const story = await gated.call<{ data: { latestRevisionId: string } }>("get_story", { projectId });
    const manual = await gated.call("run_story_rewrite", {
      revisionId: story.structured.data.latestRevisionId,
      instruction: "Make it shorter",
      ai: { manual: true },
    });
    expect(manual.structured.status).toBe("completed");
    const paid = await gated.call("run_story_rewrite", {
      revisionId: story.structured.data.latestRevisionId,
      instruction: "Make it shorter",
    });
    expect(paid.structured.status).toBe("pending_approval");
    const exported = await gated.call("create_export", { projectId, kind: "project_json" });
    expect(exported.structured.status).toBe("pending_approval");
  });

  test("a request nobody decides expires", async () => {
    const r = await gated.call("manage_chapter", { action: "delete", chapterId: chapterIds[1] });
    const id = r.structured.approval!.approvalRequestId;
    await h.deps.db
      .update(mcpApprovalRequests)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(mcpApprovalRequests.id, id));
    const poll = await gated.call<{ data: { status: string } }>("get_approval_request", { approvalRequestId: id });
    expect(poll.structured.data.status).toBe("expired");
    const late = await alice.raw("POST", `/api/agents/approvals/${id}/decide`, { decision: "approve" });
    expect(late.status).toBe(409);
  });

  test("simultaneous identical sensitive calls park one request", async () => {
    const runs = await Promise.all(
      Array.from({ length: 6 }, () => gated.call("manage_chapter", { action: "delete", chapterId: chapterIds[1] })),
    );
    const ids = new Set(runs.map((r) => r.structured.approval!.approvalRequestId));
    expect(ids.size).toBe(1);
    const keyed = await Promise.all(
      Array.from({ length: 4 }, () =>
        gated.call("manage_chapter", { action: "delete", chapterId: chapterIds[1], idempotencyKey: "park-race-1" }),
      ),
    );
    for (const r of keyed)
      if (r.isError) expect(r.error?.code).toBe("operation_in_progress");
      else expect(r.structured.approval!.approvalRequestId).toBeTruthy();
    const pending = await h.deps.db
      .select()
      .from(mcpApprovalRequests)
      .where(and(eq(mcpApprovalRequests.status, "pending"), eq(mcpApprovalRequests.toolName, "manage_chapter")));
    // The keyed and unkeyed calls have the same arguments, so they share the one waiting request.
    expect(pending.length).toBe(1);
  });

  test("an approval interrupted mid-execution becomes execution_unknown, never re-run", async () => {
    const r = await gated.call("manage_chapter", { action: "delete", chapterId: chapterIds[1] });
    const id = r.structured.approval!.approvalRequestId;
    // As if the process died right after claiming it: approved, but no outcome recorded.
    await h.deps.db
      .update(mcpApprovalRequests)
      .set({ status: "approved", decidedAt: new Date(Date.now() - 20 * 60_000) })
      .where(eq(mcpApprovalRequests.id, id));
    const poll = await gated.call<{ data: { status: string; next: string } }>("get_approval_request", {
      approvalRequestId: id,
    });
    expect(poll.structured.data.status).toBe("execution_unknown");
    expect(poll.structured.data.next).toContain("Re-read the target");
    const again = await alice.raw("POST", `/api/agents/approvals/${id}/decide`, { decision: "approve" });
    expect(again.status).toBe(409);
    await alice.get(`/api/chapters/${chapterIds[1]}`);
  });

  test("manual text work is not spending: it runs without approval", async () => {
    const r = await gated.call("run_chapter_plan", { chapterId: chapterIds[0], ai: { manual: true }, replace: false });
    // The chapter already has pages, so this is refused by the route itself (409), not parked for approval.
    expect(r.error?.code).toBe("conflict");
    expect(r.error?.message).toContain("replace=true");
  });
});

describe("credential lifecycle", () => {
  test("revoked and expired tokens stop working at once", async () => {
    const t = await pat({ name: "Temp", scopes: ["projects:read"], projectAccess: "all" });
    const ok = await req("http://test.local/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${t.token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(ok.status).not.toBe(401);
    await alice.post(`/api/agents/connections/${t.connection.id}/revoke`);
    const revoked = await req("http://test.local/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${t.token}` },
    });
    expect(revoked.status).toBe(401);

    const e = await pat({ name: "Expiring", scopes: ["projects:read"], projectAccess: "all", expiresInDays: 1 });
    await h.deps.db
      .update(personalAccessTokens)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(personalAccessTokens.serviceId, e.connection.id));
    const expired = await req("http://test.local/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${e.token}` },
    });
    expect(expired.status).toBe(401);
  });
});

describe("OAuth 2.1", () => {
  const verifier = `${"v".repeat(20)}erifier-0123456789-abcdefghijklmnop`;
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const redirect = "https://agent.example/callback";
  let clientId: string;

  const authorize = (extra: Record<string, string> = {}) => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirect,
      state: "st-1",
      code_challenge: challenge,
      code_challenge_method: "S256",
      resource: "http://test.local/mcp",
      scope: "projects:read story:read",
      ...extra,
    });
    return h.app.request(`http://test.local/oauth/authorize?${q}`, { redirect: "manual" });
  };
  const token = (form: Record<string, string>) =>
    h.app.request("http://test.local/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });

  async function consent() {
    const res = await authorize();
    expect(res.status).toBe(302);
    const loc = res.headers.get("location")!;
    expect(loc).toContain("/app/connect/");
    const requestId = loc.split("/connect/")[1]!;
    const view = await alice.get<{ request: { client: { name: string }; scopes: { scope: string }[] } }>(
      `/api/agents/consent/${requestId}`,
    );
    expect(view.request.client.name).toBe("Test Agent");
    const done = await alice.post<{ redirectTo: string }>(`/api/agents/consent/${requestId}`, {
      approve: true,
      grant: { name: "ChatGPT", scopes: ["projects:read"], projectAccess: "all", approvalMode: "REQUIRE_APPROVAL" },
    });
    const back = new URL(done.redirectTo);
    expect(back.origin + back.pathname).toBe(redirect);
    expect(back.searchParams.get("state")).toBe("st-1");
    expect(back.searchParams.get("iss")).toBe("http://test.local");
    return back.searchParams.get("code")!;
  }

  test("dynamic registration validates redirect URIs", async () => {
    const bad = await h.app.request("http://test.local/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x", redirect_uris: ["http://evil.example/cb"] }),
    });
    expect(bad.status).toBe(400);
    const wild = await h.app.request("http://test.local/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x", redirect_uris: ["https://*.example/cb"] }),
    });
    expect(wild.status).toBe(400);
    const ok = await h.app.request("http://test.local/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Test Agent",
        redirect_uris: [redirect],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(ok.status).toBe(201);
    clientId = ((await ok.json()) as { client_id: string }).client_id;
    // Grants this server never issues are ignored (Claude's client document lists jwt-bearer too); a client that
    // cannot use the code flow at all is refused.
    const extra = await h.app.request("http://test.local/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Claude-like",
        redirect_uris: [redirect],
        grant_types: ["authorization_code", "refresh_token", "urn:ietf:params:oauth:grant-type:jwt-bearer"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(extra.status).toBe(201);
    const noCode = await h.app.request("http://test.local/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "x", redirect_uris: [redirect], grant_types: ["client_credentials"] }),
    });
    expect(noCode.status).toBe(400);
  });

  test("authorize refuses missing or plain PKCE, a wrong resource and an unregistered redirect", async () => {
    const plain = await authorize({ code_challenge_method: "plain" });
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    expect(new URL(plain.headers.get("location")!).searchParams.get("iss")).toBe("http://test.local");
    const missing = await authorize({ code_challenge: "" });
    expect(new URL(missing.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const resource = await authorize({ resource: "https://other.example/mcp" });
    expect(new URL(resource.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");
    const redirectBad = await authorize({ redirect_uri: "https://agent.example/other" });
    expect(redirectBad.status).toBe(400);
    expect(redirectBad.headers.get("location")).toBeNull();
  });

  test("code exchange: PKCE, single use, then refresh rotation and reuse detection", async () => {
    const code = await consent();
    const wrongVerifier = await token({
      grant_type: "authorization_code",
      code,
      client_id: clientId,
      redirect_uri: redirect,
      code_verifier: `${verifier}x`,
      resource: "http://test.local/mcp",
    });
    expect(wrongVerifier.status).toBe(400);

    const code2 = await consent();
    const wrongResource = await token({
      grant_type: "authorization_code",
      code: code2,
      client_id: clientId,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource: "https://x.example/mcp",
    });
    expect(((await wrongResource.json()) as { error: string }).error).toBe("invalid_target");

    const code3 = await consent();
    const good = await token({
      grant_type: "authorization_code",
      code: code3,
      client_id: clientId,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource: "http://test.local/mcp",
    });
    expect(good.status).toBe(200);
    const t = (await good.json()) as { access_token: string; refresh_token: string; scope: string; expires_in: number };
    expect(t.access_token.startsWith("om_mcp_at_")).toBe(true);
    expect(t.scope).toBe("projects:read");
    expect(t.expires_in).toBe(900);
    // The access token works on /mcp, and carries only what was granted.
    const agent = await mcp(t.access_token);
    const read = await agent.call("list_projects");
    expect(read.isError).toBe(false);
    const write = await agent.call("save_story_revision", { projectId, content: "x" });
    expect(write.error?.code).toBe("scope_missing");
    expect(String((write.meta?.["mcp/www_authenticate"] as string[] | undefined)?.[0])).toContain(
      'error="insufficient_scope"',
    );

    const r1 = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId });
    expect(r1.status).toBe(200);
    const next = (await r1.json()) as { refresh_token: string; access_token: string };
    expect(next.refresh_token).not.toBe(t.refresh_token);
    // Presenting the old one again means it leaked: the whole family is revoked.
    const replay = await token({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: clientId });
    expect(replay.status).toBe(400);
    const afterReplay = await token({
      grant_type: "refresh_token",
      refresh_token: next.refresh_token,
      client_id: clientId,
    });
    expect(afterReplay.status).toBe(400);
    const dead = await req("http://test.local/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${next.access_token}` },
    });
    expect(dead.status).toBe(401);
    const audit = await h.deps.db.select().from(auditEvents).where(eq(auditEvents.action, "oauth.refresh_reuse"));
    expect(audit.length).toBe(1);
    // A code is single use; presenting it again also cuts off what it produced.
    const reuse = await token({
      grant_type: "authorization_code",
      code: code3,
      client_id: clientId,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource: "http://test.local/mcp",
    });
    expect(reuse.status).toBe(400);
  });

  test("scopes are strict: unknown ones are refused, and a refresh cannot widen the grant", async () => {
    const unknown = await authorize({ scope: "projects:read completely_fake_scope" });
    expect(new URL(unknown.headers.get("location")!).searchParams.get("error")).toBe("invalid_scope");
    const code = await consent();
    const t = (await (
      await token({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource: "http://test.local/mcp",
      })
    ).json()) as { refresh_token: string };
    const wider = await token({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: clientId,
      scope: "projects:read story:write",
    });
    expect(((await wider.json()) as { error: string }).error).toBe("invalid_scope");
    // Refused before the token was spent: it still works.
    const ok = await token({
      grant_type: "refresh_token",
      refresh_token: t.refresh_token,
      client_id: clientId,
      scope: "projects:read",
    });
    expect(ok.status).toBe(200);
  });

  test("an expired access token is refused; a disabled user's tokens stop working", async () => {
    const code = await consent();
    const t = (await (
      await token({
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: redirect,
        code_verifier: verifier,
        resource: "http://test.local/mcp",
      })
    ).json()) as { access_token: string };
    const ok = await req("http://test.local/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}` },
    });
    expect(ok.status).not.toBe(401);
    await h.deps.db.update(oauthAccessTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await req("http://test.local/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${t.access_token}` },
    });
    expect(expired.status).toBe(401);
    await h.deps.db.update(users).set({ status: "disabled" }).where(eq(users.username, "agentowner"));
    const disabled = await req("http://test.local/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${allowAllToken}` },
    });
    expect(disabled.status).toBe(401);
    await h.deps.db.update(users).set({ status: "active" }).where(eq(users.username, "agentowner"));
  });

  test("a CIMD client id pointing inside the network is refused", async () => {
    const q = new URLSearchParams({
      response_type: "code",
      client_id: "https://127.0.0.1/client.json",
      redirect_uri: "https://127.0.0.1/cb",
    });
    const res = await h.app.request(`http://test.local/oauth/authorize?${q}`, { redirect: "manual" });
    expect(res.status).toBe(400);
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("::ffff:192.168.1.1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
  });

  test("tokens, codes and verifiers never reach the audit log", async () => {
    const rows = await h.deps.db.select().from(auditEvents);
    const all = JSON.stringify(rows);
    expect(all).not.toContain("om_mcp_at_");
    expect(all).not.toContain("om_mcp_rt_");
    expect(all).not.toContain("om_mcp_ac_");
    expect(all).not.toContain("om_pat_");
    expect(all).not.toContain(verifier);
  });
});
