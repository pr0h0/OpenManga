import { expect, test } from "bun:test";
import { classifyAgentError } from "./index.ts";

test("agent CLI failures map to provider error codes", () => {
  const code = (m: string) => classifyAgentError("claude_code", m).code;
  expect(code("You've hit your limit · resets 5pm")).toBe("quota");
  expect(code("API Error: 429 rate_limit_error")).toBe("rate_limited");
  expect(code("Invalid API key · Please run /login · 401")).toBe("auth");
  expect(code("refresh token was already used")).toBe("auth");
  expect(code("max output tokens exceeded")).toBe("server_error");
  // Status digits inside ids and counts are not status codes.
  expect(code("request req_011403a9 failed after 4013 tokens")).toBe("server_error");
  expect(classifyAgentError("codex", "usage limit reached").retryable).toBe(false);
});

test("a cancel the CLI reports as a failed result is a non-retryable cancel, not a server error", async () => {
  const { tmpdir } = await import("node:os");
  const { ClaudeAgentTextProvider } = await import("./index.ts");
  const { ProviderError } = await import("@openmanga/domain/browser");
  const ctl = new AbortController();
  class Cancelled extends ClaudeAgentTextProvider {
    protected override async once(): Promise<never> {
      ctl.abort(new Error("cancelled by user"));
      throw new ProviderError("claude_code", "server_error", "error_during_execution");
    }
  }
  const p = new Cancelled({
    model: "haiku",
    oauthToken: "t",
    timeoutMs: 60_000,
    maxConcurrency: 1,
    tempRoot: tmpdir(),
  });
  const e = await p.generateText({ messages: [{ role: "user", content: "x" }], signal: ctl.signal }).catch((x) => x);
  expect(e).toMatchObject({ code: "cancelled", retryable: false });
});
