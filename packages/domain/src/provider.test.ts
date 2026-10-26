import { describe, expect, test } from "bun:test";
import { ConcurrencyLimiter, classifyHttpStatus, ProviderError, parseRetryAfter, withRetry } from "./provider.ts";

describe("retry policy", () => {
  const noSleep = async () => {};
  test("retries transient errors then succeeds", async () => {
    let n = 0;
    const r = await withRetry(
      async () => {
        n++;
        if (n < 3) throw new ProviderError("x", n === 1 ? "rate_limited" : "server_error", "t");
        return "ok";
      },
      { retries: 3, sleep: noSleep },
    );
    expect(r).toBe("ok");
    expect(n).toBe(3);
  });
  test("never retries auth, policy, invalid request", async () => {
    for (const code of ["auth", "content_policy", "invalid_request", "quota", "invalid_json"] as const) {
      let n = 0;
      await expect(
        withRetry(
          async () => {
            n++;
            throw new ProviderError("x", code, "nope");
          },
          { retries: 5, sleep: noSleep },
        ),
      ).rejects.toBeInstanceOf(ProviderError);
      expect(n).toBe(1);
    }
  });
  test("gives up after retries and honors retry-after", async () => {
    const delays: number[] = [];
    await expect(
      withRetry(
        async () => {
          throw new ProviderError("x", "rate_limited", "t", { retryAfterMs: 5000 });
        },
        { retries: 2, sleep: async (ms) => void delays.push(ms) },
      ),
    ).rejects.toThrow();
    expect(delays).toHaveLength(2);
    expect(delays.every((d) => d >= 5000)).toBe(true);
  });
  test("a retry-after past the ceiling is thrown rather than waited out", async () => {
    let n = 0;
    await expect(
      withRetry(
        async () => {
          n++;
          throw new ProviderError("x", "rate_limited", "t", { retryAfterMs: 86_400_000 });
        },
        { retries: 3, maxMs: 30_000, sleep: async () => {} },
      ),
    ).rejects.toBeInstanceOf(ProviderError);
    expect(n).toBe(1);
  });
  test("status classification and retry-after parsing", () => {
    expect(classifyHttpStatus(429)).toBe("rate_limited");
    expect(classifyHttpStatus(502)).toBe("server_error");
    expect(classifyHttpStatus(401)).toBe("auth");
    expect(classifyHttpStatus(400)).toBe("invalid_request");
    expect(parseRetryAfter("3")).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 10_000).toUTCString())).toBeGreaterThan(8000);
  });
});

test("limiter caps concurrency and queues", async () => {
  const l = new ConcurrencyLimiter(2);
  let active = 0;
  let peak = 0;
  await Promise.all(
    Array.from({ length: 6 }, () =>
      l.run(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
      }),
    ),
  );
  expect(peak).toBe(2);
});
