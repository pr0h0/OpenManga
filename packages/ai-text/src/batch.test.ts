import { expect, test } from "bun:test";
import {
  chunkText,
  estimateTextInputTokens,
  GeminiTextBatchProvider,
  OpenAITextBatchProvider,
  type TextBatchRequestSpec,
} from "./batch.ts";

const spec = (key: string, chars = 400, images = 0): TextBatchRequestSpec => ({
  key,
  messages: [
    { role: "system", content: "You plan comic pages." },
    {
      role: "user",
      content: "x".repeat(chars),
      images: Array.from({ length: images }, () => ({ mime: "image/png", data: new Uint8Array(40 * 1024) })),
    },
  ],
  maxTokens: 8000,
  json: true,
});

function fakeFetch(routes: [string, (init: RequestInit) => unknown][]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const route = routes.find(([m]) => String(url).includes(m));
    if (!route) throw new Error(`no fake route for ${url}`);
    const body = route[1](init);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const openai = (fetchFn: typeof fetch, maxEnqueuedTokens = 1_000_000) =>
  new OpenAITextBatchProvider({
    apiKey: "k",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    timeoutMs: 1000,
    maxEnqueuedTokens,
    fetch: fetchFn,
  });

const gemini = (fetchFn: typeof fetch) =>
  new GeminiTextBatchProvider({
    apiKey: "k",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3.6-flash",
    timeoutMs: 1000,
    fetch: fetchFn,
  });

test("the token estimate grows with prose and with attached images", () => {
  expect(estimateTextInputTokens(spec("a", 4000))).toBeGreaterThan(estimateTextInputTokens(spec("a", 400)));
  expect(estimateTextInputTokens(spec("a", 400, 2))).toBeGreaterThan(estimateTextInputTokens(spec("a", 400)));
});

test("chunkText cuts on the binding budget and never drops a request", () => {
  const reqs = Array.from({ length: 7 }, (_, i) => spec(`k${i}`));
  const chunks = chunkText(reqs, [{ limit: 3, cost: () => 1 }]);
  expect(chunks.map((c) => c.length)).toEqual([3, 3, 1]);
  expect(chunks.flat()).toHaveLength(7);
});

test("OpenAI text submit writes one chat-completions line per job, keyed by job id", async () => {
  const { fn, calls } = fakeFetch([
    ["/files", () => ({ id: "file-1" })],
    ["/batches", () => ({ id: "batch_t1" })],
  ]);
  const handle = await openai(fn).submitBatch([spec("job-a"), spec("job-b", 100, 1)], "idem-t");
  expect(handle.handle).toBe("batch_t1");
  expect(handle.ownedFileIds).toEqual(["file-1"]);
  const blob = (calls[0]!.init.body as FormData).get("file") as Blob;
  const lines = (await blob.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines.map((l) => l.custom_id)).toEqual(["job-a", "job-b"]);
  expect(lines[0].url).toBe("/v1/chat/completions");
  expect(lines[0].body.response_format).toEqual({ type: "json_object" });
  expect(lines[0].body.max_completion_tokens).toBe(8000);
  // An attached image rides inline as a data URL, exactly as the synchronous chat body sends it.
  const parts = lines[1].body.messages[1].content;
  expect(parts[0].type).toBe("text");
  expect(parts[1].image_url.url.startsWith("data:image/png;base64,")).toBe(true);
});

test("OpenAI text poll returns completions and errors against their keys", async () => {
  const output = `${JSON.stringify({
    custom_id: "job-a",
    response: {
      status_code: 200,
      body: {
        choices: [{ message: { content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1200, completion_tokens: 300, prompt_tokens_details: { cached_tokens: 100 } },
      },
    },
  })}\n`;
  const errors = `${JSON.stringify({
    custom_id: "job-b",
    response: { status_code: 400, body: { error: { message: "context length exceeded", code: "context_length" } } },
  })}\n`;
  const { fn } = fakeFetch([
    [
      "/batches/batch_t1",
      () => ({
        status: "completed",
        request_counts: { total: 2, completed: 1, failed: 1 },
        output_file_id: "o",
        error_file_id: "e",
      }),
    ],
    ["/files/o/content", () => new Response(output)],
    ["/files/e/content", () => new Response(errors)],
  ]);
  const status = await openai(fn).pollBatch({ handle: "batch_t1", keys: ["job-a", "job-b"], idempotencyKey: "i" });
  expect(status.state).toBe("partial");
  const a = status.items!.find((i) => i.key === "job-a")!;
  expect(a.ok).toBe(true);
  if (a.ok) {
    expect(a.text).toBe('{"ok":true}');
    expect(a.usage).toEqual({ inputTokens: 1200, outputTokens: 300, cachedTokens: 100 });
  }
  const b = status.items!.find((i) => i.key === "job-b")!;
  expect(b.ok).toBe(false);
  if (!b.ok) expect(b.code).toBe("context_length");
});

test("Gemini text submit splits the system prompt out and keeps turn order", async () => {
  const { fn, calls } = fakeFetch([[":batchGenerateContent", () => ({ name: "batches/t" })]]);
  await gemini(fn).submitBatch([spec("job-a", 50, 1)], "idem-g");
  const body = JSON.parse(calls[0]!.init.body as string);
  const req = body.batch.input_config.requests.requests[0].request;
  expect(req.systemInstruction.parts[0].text).toBe("You plan comic pages.");
  expect(req.contents).toHaveLength(1);
  expect(req.contents[0].role).toBe("user");
  expect(req.contents[0].parts[1].inline_data.mime_type).toBe("image/png");
  expect(req.generationConfig.responseMimeType).toBe("application/json");
  expect(body.batch.input_config.requests.requests[0].metadata).toEqual({ key: "job-a" });
});

test("Gemini text poll joins text parts and skips thoughts", async () => {
  const { fn } = fakeFetch([
    [
      "/batches/t",
      () => ({
        metadata: {
          state: "BATCH_STATE_SUCCEEDED",
          batchStats: { requestCount: "1", successfulRequestCount: "1" },
          output: {
            inlinedResponses: {
              inlinedResponses: [
                {
                  metadata: { key: "job-a" },
                  response: {
                    candidates: [
                      {
                        content: { parts: [{ text: "thinking…", thought: true }, { text: '{"a":' }, { text: "1}" }] },
                        finishReason: "STOP",
                      },
                    ],
                    usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 120 },
                  },
                },
              ],
            },
          },
        },
      }),
    ],
  ]);
  const status = await gemini(fn).pollBatch({ handle: "batches/t", keys: ["job-a"], idempotencyKey: "i" });
  expect(status.state).toBe("succeeded");
  const item = status.items![0]!;
  expect(item.ok).toBe(true);
  if (item.ok) {
    expect(item.text).toBe('{"a":1}');
    expect(item.usage.inputTokens).toBe(900);
  }
});

test("a refusal comes back as a content_policy failure, not as empty text", async () => {
  const { fn } = fakeFetch([
    [
      "/batches/t",
      () => ({
        metadata: {
          state: "BATCH_STATE_SUCCEEDED",
          batchStats: { requestCount: "1", failedRequestCount: "1" },
          output: {
            inlinedResponses: {
              inlinedResponses: [
                { metadata: { key: "job-a" }, response: { candidates: [{ finishReason: "SAFETY" }] } },
              ],
            },
          },
        },
      }),
    ],
  ]);
  const status = await gemini(fn).pollBatch({ handle: "batches/t", keys: ["job-a"], idempotencyKey: "i" });
  const item = status.items![0]!;
  expect(item.ok).toBe(false);
  if (!item.ok) expect(item.code).toBe("content_policy");
});
