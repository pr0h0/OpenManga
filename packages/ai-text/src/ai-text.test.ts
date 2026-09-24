import { describe, expect, test } from "bun:test";
import { ProviderError } from "@openmanga/domain/browser";
import { jsonRepairV1, storyAnalysisV1 } from "@openmanga/prompts";
import { StoryAnalysis } from "@openmanga/schemas";
import { z } from "zod";
import {
  AnthropicTextProvider,
  DeepSeekTextProvider,
  extractJson,
  FakeTextAIProvider,
  MetaMuseTextProvider,
  StructuredOutputError,
} from "./index.ts";

const STORY = `Woo Jin climbed onto the rooftop in the rain. Woo Jin heard footsteps behind him.
"Who's there?" Woo Jin asked. Kim Do-yun stepped out of the shadows. Kim Do-yun smiled.`;

const repair = (a: { raw: string; error: string; schemaText: string }) =>
  jsonRepairV1.build({ schemaName: "StoryAnalysis", error: a.error, raw: a.raw, schemaText: a.schemaText });

describe("extractJson", () => {
  test("plain, fenced, prose-wrapped", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Sure!\n```json\n{"a":2}\n```')).toEqual({ a: 2 });
    expect(extractJson('Result: {"a":{"b":3}} done')).toEqual({ a: { b: 3 } });
    expect(() => extractJson("{ nope")).toThrow();
  });
});

describe("FakeTextAIProvider structured pipeline", () => {
  const p = new FakeTextAIProvider();
  const msgs = (story: string) =>
    storyAnalysisV1.build({ story, inputKind: "story", language: "en", projectType: "manhwa" });

  test("story analysis resolves characters and validates", async () => {
    const r = await p.generateStructured({
      messages: msgs(STORY),
      schema: StoryAnalysis,
      schemaName: "StoryAnalysis",
      buildRepairMessages: repair,
    });
    expect(r.repaired).toBe(false);
    const names = r.data.characters.map((c) => c.name);
    expect(names).toContain("Woo Jin");
    expect(names).toContain("Kim Do-yun");
    expect(r.data.chapters.length).toBeGreaterThan(0);
    expect(r.calls[0]!.inputTokens).toBeGreaterThan(0);
  });

  test("fenced JSON is extracted without repair", async () => {
    const r = await p.generateStructured({
      messages: msgs(`${STORY} [[mock:fenced-json]]`),
      schema: StoryAnalysis,
      schemaName: "StoryAnalysis",
      buildRepairMessages: repair,
    });
    expect(r.repaired).toBe(false);
  });

  test("schema-invalid output is repaired with one extra call", async () => {
    const r = await p.generateStructured({
      messages: msgs(`${STORY} [[mock:repairable]]`),
      schema: StoryAnalysis,
      schemaName: "StoryAnalysis",
      buildRepairMessages: repair,
    });
    expect(r.repaired).toBe(true);
    expect(r.calls.map((c) => c.purpose)).toEqual(["primary", "repair"]);
  });

  test("the repair call sends no temperature", async () => {
    // Reasoning models answer 400 to any non-default temperature, which failed every repair and killed the job.
    const seen: (number | undefined)[] = [];
    class Recording extends FakeTextAIProvider {
      override generateText(req: Parameters<FakeTextAIProvider["generateText"]>[0]) {
        seen.push(req.temperature);
        return super.generateText(req);
      }
    }
    const r = await new Recording().generateStructured({
      messages: msgs(`${STORY} [[mock:repairable]]`),
      schema: StoryAnalysis,
      schemaName: "StoryAnalysis",
      buildRepairMessages: repair,
    });
    expect(r.repaired).toBe(true);
    expect(seen).toEqual([undefined, undefined]);
  });

  test("unrepairable output fails clearly with call records", async () => {
    try {
      await p.generateStructured({
        messages: msgs(`${STORY} [[mock:invalid-json]]`),
        schema: StoryAnalysis,
        schemaName: "StoryAnalysis",
        buildRepairMessages: repair,
      });
      throw new Error("should fail");
    } catch (e) {
      expect(e).toBeInstanceOf(StructuredOutputError);
      expect((e as StructuredOutputError).code).toBe("invalid_json");
      expect((e as StructuredOutputError).retryable).toBe(false);
      expect((e as StructuredOutputError).calls).toHaveLength(2);
    }
  });

  test("provider errors map to codes", async () => {
    await expect(p.generateText({ messages: [{ role: "user", content: "[[mock:auth]]" }] })).rejects.toMatchObject({
      code: "auth",
      retryable: false,
    });
    await expect(p.generateText({ messages: [{ role: "user", content: "[[mock:429]]" }] })).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });
});

describe("DeepSeekTextProvider over HTTP", () => {
  function fakeFetch(responses: (() => Response | Promise<Response>)[]) {
    let i = 0;
    const seen: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, body: JSON.parse(String(init.body)), headers: new Headers(init.headers) });
      const r = responses[Math.min(i++, responses.length - 1)]!;
      return r();
    }) as unknown as typeof fetch;
    return { f, seen };
  }
  const ok = (content: string) =>
    new Response(
      JSON.stringify({
        id: "req-1",
        model: "deepseek-v4-flash",
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 40 },
      }),
      {
        headers: { "content-type": "application/json" },
      },
    );
  const make = (f: typeof fetch) =>
    new DeepSeekTextProvider({
      apiKey: "sk-test",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      timeoutMs: 5000,
      maxConcurrency: 2,
      retries: 2,
      fetch: f,
    });

  test("sends official request shape and records usage", async () => {
    const { f, seen } = fakeFetch([() => ok('{"x":1}')]);
    const r = await make(f).generateStructured({
      messages: [{ role: "user", content: "hi" }],
      schema: z.object({ x: z.number() }),
      schemaName: "X",
    });
    expect(seen[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(seen[0]!.body.model).toBe("deepseek-v4-flash");
    expect(seen[0]!.body.response_format).toEqual({ type: "json_object" });
    expect(seen[0]!.headers.get("authorization")).toBe("Bearer sk-test");
    expect(r.calls[0]).toMatchObject({ requestId: "req-1", inputTokens: 100, outputTokens: 20, cachedTokens: 40 });
  });

  test("retries 429 and 503 then succeeds", async () => {
    const { f, seen } = fakeFetch([
      () => new Response("{}", { status: 429, headers: { "retry-after": "0" } }),
      () => new Response("{}", { status: 503 }),
      () => ok('{"x":2}'),
    ]);
    const p = make(f);
    const r = await p.generateText({ messages: [{ role: "user", content: "x" }] });
    expect(r.text).toBe('{"x":2}');
    expect(seen).toHaveLength(3);
  }, 20000);

  test("does not retry 401", async () => {
    const { f, seen } = fakeFetch([
      () => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 }),
    ]);
    await expect(make(f).generateText({ messages: [{ role: "user", content: "x" }] })).rejects.toMatchObject({
      code: "auth",
    });
    expect(seen).toHaveLength(1);
  });

  test("connection reset maps to network error", async () => {
    const f = (async () => {
      const e = new TypeError("fetch failed") as TypeError & { code: string };
      e.code = "ECONNRESET";
      throw e;
    }) as unknown as typeof fetch;
    const p = new DeepSeekTextProvider({
      apiKey: "k",
      baseUrl: "http://x",
      model: "m",
      timeoutMs: 1000,
      maxConcurrency: 1,
      retries: 0,
      fetch: f,
    });
    const err = await p.generateText({ messages: [] }).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err.code).toBe("network");
  });

  test("timeout maps to timeout error", async () => {
    const f = ((_: string, init: RequestInit) =>
      new Promise((_r, rej) =>
        init.signal?.addEventListener("abort", () => rej(init.signal?.reason)),
      )) as unknown as typeof fetch;
    const p = new DeepSeekTextProvider({
      apiKey: "k",
      baseUrl: "http://x",
      model: "m",
      timeoutMs: 30,
      maxConcurrency: 1,
      retries: 0,
      fetch: f,
    });
    await expect(p.generateText({ messages: [] })).rejects.toMatchObject({ code: "timeout" });
  });

  test("streams when the caller shows the answer as it arrives, and still records usage", async () => {
    const chunks = (events: unknown[]) =>
      new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    const { f, seen } = fakeFetch([
      () =>
        chunks([
          { id: "req-s", model: "deepseek-v4-flash", choices: [{ delta: { content: "Three " } }] },
          { id: "req-s", choices: [{ delta: { content: "titles." }, finish_reason: "stop" }] },
          { id: "req-s", choices: [], usage: { prompt_tokens: 50, completion_tokens: 3, prompt_cache_hit_tokens: 10 } },
          "[DONE]",
        ]),
    ]);
    const seenSoFar: string[] = [];
    const r = await make(f).generateText({
      messages: [{ role: "user", content: "titles?" }],
      onText: (t) => seenSoFar.push(t),
    });
    expect(seenSoFar).toEqual(["Three ", "Three titles."]);
    expect(r.text).toBe("Three titles.");
    expect(r.call).toMatchObject({ requestId: "req-s", inputTokens: 50, outputTokens: 3, cachedTokens: 10 });
    expect(seen[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    // Without a listener the request is the plain one it always was.
    const plain = fakeFetch([() => ok("hello")]);
    await make(plain.f).generateText({ messages: [{ role: "user", content: "hi" }] });
    expect(plain.seen[0]!.body.stream).toBe(false);
  });
});

describe("MetaMuseTextProvider", () => {
  const sse = (events: unknown[], status = 200) =>
    new Response(events.map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), {
      status,
      headers: { "content-type": "text/event-stream", "x-request-id": "meta-req" },
    });
  const make = (responses: (() => Response)[]) => {
    const seen: RequestInit[] = [];
    let i = 0;
    const f = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return responses[Math.min(i++, responses.length - 1)]!();
    }) as unknown as typeof fetch;
    const p = new MetaMuseTextProvider({
      apiKey: "k",
      baseUrl: "https://api.meta.ai/v1",
      model: "muse-spark-1.3-contributor",
      timeoutMs: 5000,
      maxConcurrency: 2,
      retries: 1,
      fetch: f,
    });
    return { p, seen };
  };
  const msg = [{ role: "user" as const, content: "hi" }];

  test("assembles streamed JSON deltas, usage and request id; sends streaming JSON-mode request", async () => {
    const { p, seen } = make([
      () =>
        sse([
          { id: "chatcmpl-1", model: "muse-spark-1.3-contributor", choices: [{ delta: { content: '{"a":' } }] },
          { id: "chatcmpl-1", choices: [{ delta: { content: "1}" }, finish_reason: "stop" }] },
          {
            id: "chatcmpl-1",
            choices: [],
            usage: { prompt_tokens: 22, completion_tokens: 306, prompt_tokens_details: { cached_tokens: 4 } },
          },
          "[DONE]",
        ]),
    ]);
    const r = await p.generateText({ messages: msg, json: true, maxTokens: 1000 });
    expect(r.text).toBe('{"a":1}');
    expect(r.call).toMatchObject({
      provider: "meta",
      requestId: "chatcmpl-1",
      inputTokens: 22,
      outputTokens: 306,
      cachedTokens: 4,
    });
    const body = JSON.parse(String(seen[0]!.body));
    expect(body).toMatchObject({ stream: true, max_completion_tokens: 1000, response_format: { type: "json_object" } });
    expect(body.temperature).toBeUndefined();
  });

  test("passes the text on as it streams in", async () => {
    const { p } = make([
      () =>
        sse([
          { id: "c", choices: [{ delta: { content: "A " } }] },
          { id: "c", choices: [{ delta: { content: "hook." }, finish_reason: "stop" }] },
          "[DONE]",
        ]),
    ]);
    const soFar: string[] = [];
    const r = await p.generateText({ messages: msg, onText: (t) => soFar.push(t) });
    expect(soFar).toEqual(["A ", "A hook."]);
    expect(r.text).toBe("A hook.");
  });

  test("truncation is non-retryable; content_filter is policy; 429 retries; mid-stream error surfaces", async () => {
    const trunc = make([() => sse([{ choices: [{ delta: { content: "{" }, finish_reason: "length" }] }])]);
    const e1 = await trunc.p.generateText({ messages: msg, json: true }).catch((e) => e);
    expect(e1.code).toBe("invalid_json");
    expect(trunc.seen).toHaveLength(1);

    const filt = make([() => sse([{ choices: [{ delta: {}, finish_reason: "content_filter" }] }])]);
    expect((await filt.p.generateText({ messages: msg }).catch((e) => e)).code).toBe("content_policy");

    const limited = make([
      () =>
        new Response(JSON.stringify({ error: { message: "slow" } }), { status: 429, headers: { "retry-after": "0" } }),
      () => sse([{ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] }]),
    ]);
    expect((await limited.p.generateText({ messages: msg })).text).toBe("ok");
    expect(limited.seen).toHaveLength(2);

    const auth = make([() => new Response(JSON.stringify({ error: { message: "bad key" } }), { status: 401 })]);
    expect((await auth.p.generateText({ messages: msg }).catch((e) => e)).code).toBe("auth");

    const broken = make([
      () => sse([{ choices: [{ delta: { content: "par" } }] }, { error: { message: "overloaded" } }]),
    ]);
    const e2 = await broken.p.generateText({ messages: msg }).catch((e) => e);
    expect(e2).toBeInstanceOf(ProviderError);
    expect(e2.message).toContain("overloaded");
  });
});

describe("AnthropicTextProvider", () => {
  const sseLines = (events: unknown[]) =>
    new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
      headers: { "request-id": "req_a" },
    });
  const mk = (responses: (() => Response)[]) => {
    const seen: RequestInit[] = [];
    let i = 0;
    const f = (async (_u: string, init: RequestInit) => {
      seen.push(init);
      return responses[Math.min(i++, responses.length - 1)]!();
    }) as unknown as typeof fetch;
    return {
      seen,
      p: new AnthropicTextProvider({
        apiKey: "sk-ant-1234",
        baseUrl: "https://api.anthropic.com",
        model: "claude-sonnet-5",
        timeoutMs: 5000,
        maxConcurrency: 1,
        retries: 1,
        fetch: f,
      }),
    };
  };

  test("moves system messages to `system`, assembles text deltas and usage", async () => {
    const { p, seen } = mk([
      () =>
        sseLines([
          { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5", usage: { input_tokens: 40 } } },
          { type: "content_block_delta", delta: { type: "text_delta", text: '{"ok":' } },
          { type: "content_block_delta", delta: { type: "text_delta", text: "true}" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } },
          { type: "message_stop" },
        ]),
    ]);
    const r = await p.generateText({
      messages: [
        { role: "system", content: "be json" },
        { role: "user", content: "hi" },
      ],
      json: true,
      maxTokens: 500,
    });
    expect(r.text).toBe('{"ok":true}');
    expect(r.call).toMatchObject({ provider: "anthropic", requestId: "msg_1", inputTokens: 40, outputTokens: 7 });
    const body = JSON.parse(String(seen[0]!.body));
    expect(body).toMatchObject({ system: "be json", max_tokens: 500, stream: true });
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect((seen[0]!.headers as Record<string, string>)["x-api-key"]).toBe("sk-ant-1234");
  });

  test("max_tokens stop is non-retryable; overloaded retries; refusal is policy", async () => {
    const trunc = mk([() => sseLines([{ type: "message_delta", delta: { stop_reason: "max_tokens" } }])]);
    expect((await trunc.p.generateText({ messages: [{ role: "user", content: "x" }] }).catch((e) => e)).code).toBe(
      "invalid_json",
    );
    const over = mk([
      () => new Response(JSON.stringify({ error: { type: "overloaded_error", message: "busy" } }), { status: 529 }),
      () =>
        sseLines([
          { type: "content_block_delta", delta: { type: "text_delta", text: "fine" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
        ]),
    ]);
    expect((await over.p.generateText({ messages: [{ role: "user", content: "x" }] })).text).toBe("fine");
    const refuse = mk([() => sseLines([{ type: "message_delta", delta: { stop_reason: "refusal" } }])]);
    expect((await refuse.p.generateText({ messages: [{ role: "user", content: "x" }] }).catch((e) => e)).code).toBe(
      "content_policy",
    );
  });
});

describe("structured output extraction", () => {
  test("takes the JSON out of prose, fences, trailing commas and a second object", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Here you go:\n```json\n{"a":[1,2]}\n```\nHope that helps!')).toEqual({ a: [1, 2] });
    expect(extractJson('Thinking about it… {"a":{"b":"}"}} and then some notes {"c":2}')).toEqual({ a: { b: "}" } });
    expect(extractJson('{"a":[1,2,],}')).toEqual({ a: [1, 2] });
    expect(extractJson('{"text":"a \\"quoted\\" word"}')).toEqual({ text: 'a "quoted" word' });
  });

  test("recovers a cut-off response so the partial plan can still validate", () => {
    expect(extractJson('{"scenes":[{"title":"One","pages":[]},{"title":"Two"')).toEqual({
      scenes: [{ title: "One", pages: [] }, { title: "Two" }],
    });
    expect(extractJson('{"lines":[{"text":"half a sen')).toEqual({ lines: [{ text: "half a sen" }] });
    expect(() => extractJson("no json at all")).toThrow();
  });
});
