import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { query, USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import { Codex, type UserInput } from "@openai/codex-sdk";
import { ConcurrencyLimiter, ProviderError, withRetry } from "@openmanga/domain/browser";
import type { Logger } from "@openmanga/logger";
import {
  type ChatImage,
  type ChatMessage,
  runStructured,
  type StructuredRequest,
  type StructuredResult,
  type TextAIProvider,
  type TextRequest,
  type TextResult,
} from "./index.ts";
import { formatPrompt } from "./prompt-text.ts";

/**
 * Text through a coding agent's own CLI, billed to the person's Claude or ChatGPT subscription instead of an API key.
 * The agent gets no tools, no settings and an empty working directory: it only answers the prompt. Story content
 * is untrusted, and an agent that could run a command could be talked into reading the server's secrets.
 */
type AgentOpts = { model: string; timeoutMs: number; maxConcurrency: number; tempRoot: string; logger?: Logger };

/** System text, the conversation as one prompt (a single user turn is sent as-is), and every image in it. */
function flatten(messages: ChatMessage[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const rest = messages.filter((m) => m.role !== "system");
  const prompt =
    rest.length === 1 && rest[0]!.role === "user" ? rest[0]!.content : formatPrompt(rest.map(({ images, ...m }) => m));
  return { system, prompt, images: rest.flatMap((m) => m.images ?? []) };
}

/** An agent CLI failure as a provider error: a spent plan is final, a busy one is retried. */
export function classifyAgentError(provider: string, msg: string): ProviderError {
  const m = msg.slice(0, 500);
  if (USAGE_LIMIT_ERROR_PREFIXES.some((p) => m.includes(p)) || /usage limit|quota|out of credits/i.test(m))
    return new ProviderError(provider, "quota", `Subscription usage limit reached: ${m}`, { retryable: false });
  if (/rate.?limit|429|overloaded/i.test(m)) return new ProviderError(provider, "rate_limited", m);
  if (/401|403|unauthori[sz]ed|authenticat|not logged in|log ?in again|(oauth|access|refresh) token/i.test(m))
    return new ProviderError(provider, "auth", `The subscription sign-in was rejected: ${m}`, {
      retryable: false,
    });
  return new ProviderError(provider, "server_error", m);
}

abstract class AgentTextProvider implements TextAIProvider {
  abstract readonly provider: string;
  readonly model: string;
  private readonly limiter: ConcurrencyLimiter;

  constructor(protected readonly opts: AgentOpts) {
    this.model = opts.model;
    this.limiter = new ConcurrencyLimiter(opts.maxConcurrency);
  }

  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return runStructured(this, req);
  }

  generateText(req: TextRequest): Promise<TextResult> {
    return withRetry(() => this.limiter.run(() => this.timed(req)), {
      retries: 1,
      onRetry: (e, attempt, delay) => {
        if (e.code === "rate_limited") this.limiter.cooldown(delay);
        this.opts.logger?.warn(`${this.provider} retry`, { code: e.code, attempt, delayMs: Math.round(delay) });
      },
    });
  }

  private async timed(req: TextRequest): Promise<TextResult> {
    const started = performance.now();
    const signal = AbortSignal.any([...(req.signal ? [req.signal] : []), AbortSignal.timeout(this.opts.timeoutMs)]);
    const cwd = await mkdtemp(join(this.opts.tempRoot, `${this.provider}-`));
    try {
      const r = await this.once(req, cwd, signal);
      return {
        text: r.text,
        finishReason: "stop",
        call: {
          provider: this.provider,
          model: this.model,
          requestId: r.id,
          purpose: "primary",
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          cachedTokens: r.cachedTokens,
          latencyMs: Math.round(performance.now() - started),
          rawUsage: r.raw,
          success: true,
        },
      };
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      if (signal.aborted)
        throw new ProviderError(this.provider, req.signal?.aborted ? "cancelled" : "timeout", String(signal.reason), {
          retryable: !req.signal?.aborted,
        });
      throw classifyAgentError(this.provider, (e as Error).message ?? String(e));
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  }

  protected abstract once(
    req: TextRequest,
    cwd: string,
    signal: AbortSignal,
  ): Promise<{
    text: string;
    id: string | null;
    inputTokens: number;
    outputTokens: number;
    cachedTokens: number;
    raw: Record<string, unknown>;
  }>;
}

/** Claude Agent SDK on a `claude setup-token` OAuth token (a Pro/Max subscription). */
export class ClaudeAgentTextProvider extends AgentTextProvider {
  readonly provider = "claude_code";

  constructor(private readonly auth: AgentOpts & { oauthToken: string }) {
    super(auth);
    if (!auth.oauthToken) throw new Error("Claude subscription token is not configured");
  }

  protected async once(req: TextRequest, cwd: string, signal: AbortSignal) {
    const { system, prompt, images } = flatten(req.messages);
    const abortController = new AbortController();
    const onAbort = () => abortController.abort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    const content = [
      ...images.map((img: ChatImage) => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: img.mime as "image/png",
          data: Buffer.from(img.data).toString("base64"),
        },
      })),
      { type: "text" as const, text: prompt },
    ];
    async function* input() {
      yield { type: "user" as const, message: { role: "user" as const, content }, parent_tool_use_id: null };
    }
    try {
      let limited = false;
      for await (const m of query({
        prompt: images.length ? input() : prompt,
        options: {
          model: this.model,
          ...(system ? { systemPrompt: system } : {}),
          tools: [],
          allowedTools: [],
          settingSources: [],
          permissionMode: "dontAsk",
          persistSession: false,
          maxTurns: 1,
          cwd,
          abortController,
          // Never process.env: the server's own secrets stay out of the child, and a stray ANTHROPIC_API_KEY would
          // silently outrank the subscription token.
          env: {
            PATH: process.env.PATH,
            HOME: cwd,
            CLAUDE_CODE_OAUTH_TOKEN: this.auth.oauthToken,
            CLAUDE_CODE_ENTRYPOINT: "openmanga",
            CLAUDE_AGENT_SDK_CLIENT_APP: "openmanga",
          },
        },
      })) {
        if (m.type === "assistant") {
          if (m.error === "rate_limit") limited = true;
          const text = m.message.content
            .flatMap((b: { type: string; text?: string }) => (b.type === "text" ? [b.text ?? ""] : []))
            .join("");
          if (text) req.onText?.(text);
        } else if (m.type === "result") {
          const text = m.subtype === "success" ? m.result : m.errors.join("; ");
          if (m.subtype !== "success" || m.is_error) {
            const e = classifyAgentError(this.provider, text || m.subtype);
            throw limited && e.code !== "quota" ? new ProviderError(this.provider, "rate_limited", e.message) : e;
          }
          if (m.stop_reason === "refusal")
            throw new ProviderError(this.provider, "content_policy", "Claude declined the request");
          const u = m.usage;
          return {
            text,
            id: m.session_id ?? null,
            inputTokens: u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens,
            outputTokens: u.output_tokens,
            cachedTokens: u.cache_read_input_tokens,
            // total_cost_usd is what the API would have charged; the subscription bills nothing per call.
            raw: { ...u, apiEquivalentUsd: m.total_cost_usd },
          };
        }
      }
      throw new ProviderError(this.provider, "invalid_response", "Claude ended without an answer");
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}

/** Every Codex tool and integration off: it answers, it never acts. */
const CODEX_LOCKDOWN = {
  features: Object.fromEntries(
    [
      "shell_tool",
      "unified_exec",
      "js_repl",
      "apps",
      "plugins",
      "hooks",
      "memories",
      "browser_use",
      "in_app_browser",
      "computer_use",
      "image_generation",
      "multi_agent",
      "view_image",
      "goals",
      "code_mode_host",
      "standalone_web_search",
      "tool_search",
      "search_tool",
    ].map((f) => [f, false]),
  ),
  shell_environment_policy: { inherit: "none" },
  history: { persistence: "none" },
};

/**
 * Codex SDK on the ChatGPT sign-in stored in `codexHome` (`codex login --device-auth` run once by the operator,
 * see docs/WITHOUT_API_KEYS.md). The home holds nothing but that sign-in: no config, MCP servers or plugins.
 */
export class CodexTextProvider extends AgentTextProvider {
  readonly provider = "codex";

  constructor(private readonly home: AgentOpts & { codexHome: string }) {
    super(home);
  }

  protected async once(req: TextRequest, cwd: string, signal: AbortSignal) {
    const { system, prompt, images } = flatten(req.messages);
    await mkdir(this.home.codexHome, { recursive: true });
    const codex = new Codex({
      config: CODEX_LOCKDOWN,
      env: { PATH: process.env.PATH ?? "", HOME: cwd, CODEX_HOME: this.home.codexHome },
    });
    const thread = codex.startThread({
      model: this.model,
      sandboxMode: "read-only",
      approvalPolicy: "never",
      networkAccessEnabled: false,
      webSearchMode: "disabled",
      workingDirectory: cwd,
      skipGitRepoCheck: true,
    });
    const text = system ? `${system}\n\n${prompt}` : prompt;
    const input: UserInput[] = [{ type: "text", text }];
    for (const [i, img] of images.entries()) {
      const path = join(cwd, `image-${i}.${img.mime.split("/")[1] ?? "png"}`);
      await writeFile(path, img.data);
      input.push({ type: "local_image", path });
    }
    try {
      const turn = await thread.run(images.length ? input : text, { signal });
      // Its tools are off, so an attempt fails closed; worth a log line all the same (story text may be steering it).
      const acted = turn.items.find((i) => !["agent_message", "reasoning", "error", "todo_list"].includes(i.type));
      if (acted) this.opts.logger?.warn("codex tried to use a tool", { type: acted.type });
      if (!turn.finalResponse)
        throw new ProviderError(this.provider, "invalid_response", "Codex ended without an answer");
      req.onText?.(turn.finalResponse);
      const u = turn.usage;
      return {
        text: turn.finalResponse,
        id: thread.id,
        inputTokens: u?.input_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
        cachedTokens: u?.cached_input_tokens ?? 0,
        raw: (u ?? {}) as Record<string, unknown>,
      };
    } finally {
      // No --ephemeral through the SDK: drop this thread's transcript, which holds the story text.
      if (thread.id) await dropSession(this.home.codexHome, thread.id);
    }
  }
}

async function dropSession(home: string, id: string) {
  const dir = join(home, "sessions");
  const files = await readdir(dir, { recursive: true }).catch(() => [] as string[]);
  await Promise.all(files.filter((f) => f.includes(id)).map((f) => rm(join(dir, f), { force: true })));
}
