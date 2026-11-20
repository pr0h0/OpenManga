import { expect, test } from "bun:test";
import { classifyAgentError } from "./index.ts";

test("agent CLI failures map to provider error codes", () => {
  const code = (m: string) => classifyAgentError("claude_code", m).code;
  expect(code("You've hit your limit · resets 5pm")).toBe("quota");
  expect(code("API Error: 429 rate_limit_error")).toBe("rate_limited");
  expect(code("Invalid API key · Please run /login · 401")).toBe("auth");
  expect(code("refresh token was already used")).toBe("auth");
  expect(code("max output tokens exceeded")).toBe("server_error");
  expect(classifyAgentError("codex", "usage limit reached").retryable).toBe(false);
});
