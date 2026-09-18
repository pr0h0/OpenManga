import { expect, test } from "bun:test";
import {
  type BatchRequestSpec,
  chunkByBudget,
  estimateInputTokens,
  GeminiImageBatchProvider,
  OpenAIImageBatchProvider,
} from "./batch.ts";

const ref = (kb: number, id = "var-1") => ({
  id,
  data: new Uint8Array(kb * 1024),
  mime: "image/png",
  label: "character reference 1",
});
const spec = (key: string, refs = 3, prompt = "draw a panel"): BatchRequestSpec => ({
  key,
  prompt,
  aspectRatio: 1,
  quality: "low",
  references: Array.from({ length: refs }, (_, i) => ref(20, `${key}-var-${i + 1}`)),
});

/** Routes fake responses by URL substring, recording every call. */
function fakeFetch(routes: [string, (init: RequestInit) => unknown][]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL, init: RequestInit = {}) => {
    const u = String(url);
    calls.push({ url: u, init });
    const route = routes.find(([m]) => u.includes(m));
    if (!route) throw new Error(`no fake route for ${u}`);
    const body = route[1](init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const openai = (fetchFn: typeof fetch, maxEnqueuedTokens = 1_000_000) =>
  new OpenAIImageBatchProvider({
    apiKey: "k",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-image-2",
    timeoutMs: 1000,
    sizes: [{ width: 1024, height: 1024 }],
    maxEnqueuedTokens,
    fetch: fetchFn,
  });

test("chunkByBudget cuts on whichever budget binds first", () => {
  const items = [1, 1, 1, 1, 1];
  expect(chunkByBudget(items, [{ limit: 2, cost: () => 1 }])).toEqual([[1, 1], [1, 1], [1]]);
  // A single item over budget still goes out, alone, rather than being dropped.
  expect(chunkByBudget([5, 1], [{ limit: 2, cost: (n) => n }])).toEqual([[5], [1]]);
});

test("token estimate grows with references, so chunking is not a request count", () => {
  const bare = estimateInputTokens(spec("a", 0));
  const heavy = estimateInputTokens(spec("b", 8));
  expect(heavy).toBeGreaterThan(bare * 3);
  // Real gpt-image-2 calls measured 1,049 text + 295 image input tokens typically; the estimate stays the same
  // order of magnitude, deliberately erring high because overshooting the queue limit rejects a whole batch.
  expect(estimateInputTokens(spec("c", 4))).toBeGreaterThan(100);
});

test("an OpenAI batch is chunked to stay under the enqueued-token ceiling", () => {
  const reqs = Array.from({ length: 40 }, (_, i) => spec(`p${i}`));
  const perRequest = estimateInputTokens(reqs[0]!);
  // A ceiling that fits ~10 requests once the 20% headroom is applied.
  const provider = openai(fakeFetch([]).fn, Math.ceil((perRequest * 10) / 0.8));
  const chunks = provider.chunk(reqs);
  expect(chunks.length).toBe(4);
  for (const c of chunks)
    expect(c.reduce((s, r) => s + estimateInputTokens(r), 0)).toBeLessThanOrEqual(perRequest * 10);
  expect(chunks.flat().map((r) => r.key)).toEqual(reqs.map((r) => r.key));
});

test("a reference shared by many panels is uploaded once and reused", async () => {
  let n = 0;
  const { fn, calls } = fakeFetch([
    ["/files", () => ({ id: `file-${++n}` })],
    ["/batches", () => ({ id: "batch_1" })],
  ]);
  const shared = ref(20, "character-sheet-v1");
  const reqs = Array.from({ length: 5 }, (_, i) => ({ ...spec(`p${i}`, 0), references: [shared] }));
  const handle = await openai(fn).submitBatch(reqs, "idem-shared");
  // One reference upload plus the JSONL, not five uploads.
  expect(calls.filter((c) => c.url.endsWith("/files") && c.init.method === "POST")).toHaveLength(2);
  expect(handle.ownedFileIds).toHaveLength(2);
  const blob = (calls.filter((c) => c.url.endsWith("/files")).at(-1)!.init.body as FormData).get("file") as Blob;
  const lines = (await blob.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  for (const line of lines) expect(line.body.images).toEqual([{ file_id: "file-1" }]);
});

test("OpenAI submit uploads every reference and names it as images[{file_id}]", async () => {
  let n = 0;
  const { fn, calls } = fakeFetch([
    ["/files", () => ({ id: `file-${++n}` })],
    ["/batches", () => ({ id: "batch_1" })],
  ]);
  const handle = await openai(fn).submitBatch([spec("panel-a", 2), spec("panel-b", 1)], "idem-1");
  expect(handle.handle).toBe("batch_1");
  expect(handle.keys).toEqual(["panel-a", "panel-b"]);
  // 3 references + 1 JSONL file, all owned and therefore deletable after ingest.
  expect(handle.ownedFileIds).toHaveLength(4);

  const jsonlUpload = calls.filter((c) => c.url.endsWith("/files")).at(-1)!;
  const blob = (jsonlUpload.init.body as FormData).get("file") as Blob;
  const lines = (await blob.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines[0].custom_id).toBe("panel-a");
  expect(lines[0].url).toBe("/v1/images/edits");
  // The documented `input_reference` is rejected by the live API; `images: [{file_id}]` is what it accepts.
  expect(lines[0].body.images).toEqual([{ file_id: "file-1" }, { file_id: "file-2" }]);
  expect(lines[0].body).not.toHaveProperty("input_reference");
  expect(lines[1].body.images).toEqual([{ file_id: "file-3" }]);

  const create = JSON.parse(calls.find((c) => c.url.endsWith("/batches"))!.init.body as string);
  expect(create.endpoint).toBe("/v1/images/edits");
  expect(create.metadata.openmanga_batch).toBe("idem-1");
});

test("OpenAI submit deletes its uploads when creating the batch fails", async () => {
  let n = 0;
  const { fn, calls } = fakeFetch([
    ["/files", (init) => (init.method === "DELETE" ? {} : { id: `file-${++n}` })],
    ["/batches", () => new Response('{"error":{"message":"nope"}}', { status: 400 })],
  ]);
  await expect(openai(fn).submitBatch([spec("panel-a", 2)], "idem-2")).rejects.toThrow(/nope/);
  expect(calls.filter((c) => c.init.method === "DELETE")).toHaveLength(3);
});

test("a mixed batch is refused: one OpenAI batch names a single endpoint", async () => {
  const { fn } = fakeFetch([["/files", () => ({ id: "f" })]]);
  await expect(openai(fn).submitBatch([spec("a", 2), spec("b", 0)], "idem")).rejects.toThrow(/cannot mix/);
});

test("OpenAI poll maps output and error lines back to their keys", async () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAABjYyjCAAAAAXNSR0IArs4c6QAAAA1JREFUGFdj+M+ADwAAAP//AwAY/wH/AAAAAElFTkSuQmCC",
    "base64",
  ).toString("base64");
  const output = `${JSON.stringify({
    custom_id: "panel-a",
    response: {
      status_code: 200,
      body: {
        data: [{ b64_json: png }],
        usage: { input_tokens: 273, output_tokens: 196, input_tokens_details: { image_tokens: 256, text_tokens: 17 } },
      },
    },
  })}\n`;
  const errors = `${JSON.stringify({
    custom_id: "panel-b",
    response: {
      status_code: 400,
      body: { error: { message: "rejected by the safety system", code: "moderation_blocked" } },
    },
  })}\n`;
  const { fn } = fakeFetch([
    [
      "/batches/batch_1",
      () => ({
        status: "completed",
        request_counts: { total: 2, completed: 1, failed: 1 },
        output_file_id: "out",
        error_file_id: "err",
      }),
    ],
    ["/files/out/content", () => new Response(output, { status: 200 })],
    ["/files/err/content", () => new Response(errors, { status: 200 })],
  ]);
  const status = await openai(fn).pollBatch({ handle: "batch_1", keys: ["panel-a", "panel-b"], idempotencyKey: "i" });
  expect(status.state).toBe("partial");
  const a = status.items!.find((i) => i.key === "panel-a")!;
  expect(a.ok).toBe(true);
  if (a.ok) {
    expect(a.result.usage.imageInputTokens).toBe(256);
    expect(a.result.usage.imageOutputTokens).toBe(196);
    expect(a.result.provider).toBe("openai");
  }
  const b = status.items!.find((i) => i.key === "panel-b")!;
  expect(b.ok).toBe(false);
  if (!b.ok) {
    expect(b.code).toBe("moderation_blocked");
    // Billed-but-unusable still carries its usage so the run is charged honestly.
    expect(b.usage?.imageOutputTokens).toBe(0);
  }
});

test("a running OpenAI batch reports progress without fetching results", async () => {
  const { fn, calls } = fakeFetch([
    ["/batches/batch_1", () => ({ status: "in_progress", request_counts: { total: 9, completed: 4, failed: 0 } })],
  ]);
  const status = await openai(fn).pollBatch({ handle: "batch_1", keys: [], idempotencyKey: "i" });
  expect(status.state).toBe("running");
  expect(status.counts).toEqual({ total: 9, completed: 4, failed: 0 });
  expect(status.items).toBeUndefined();
  expect(calls).toHaveLength(1);
});

const gemini = (fetchFn: typeof fetch, imageSize = "1K") =>
  new GeminiImageBatchProvider({
    apiKey: "k",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-3.1-flash-image",
    imageSize,
    timeoutMs: 1000,
    fetch: fetchFn,
  });

test("Gemini submit inlines references and tags each request with its key", async () => {
  const { fn, calls } = fakeFetch([[":batchGenerateContent", () => ({ name: "batches/abc" })]]);
  const handle = await gemini(fn, "2K").submitBatch([spec("panel-a", 2)], "idem-3");
  expect(handle.handle).toBe("batches/abc");
  const body = JSON.parse(calls[0]!.init.body as string);
  expect(body.batch.display_name).toBe("idem-3");
  const entry = body.batch.input_config.requests.requests[0];
  expect(entry.metadata).toEqual({ key: "panel-a" });
  expect(entry.request.generationConfig.imageConfig.imageSize).toBe("2K");
  const parts = entry.request.contents[0].parts;
  // text, ref label + inline image, ref label + inline image
  expect(parts).toHaveLength(5);
  expect(parts[2].inline_data.mime_type).toBe("image/png");
  expect(typeof parts[2].inline_data.data).toBe("string");
});

test("Gemini chunks by payload bytes, since its ceiling is the 20MB inline cap", () => {
  const big: BatchRequestSpec = { ...spec("big", 0), references: [ref(6 * 1024, "shared")] };
  const chunks = gemini(fakeFetch([]).fn).chunk([big, { ...big, key: "b2" }, { ...big, key: "b3" }]);
  // Three 6MB references base64-inflate past 15MB, so they cannot share one batch.
  expect(chunks.length).toBeGreaterThan(1);
});

test("Gemini reports per-item failures even though the batch state is SUCCEEDED", async () => {
  // The live trap: a batch whose requests all failed still comes back BATCH_STATE_SUCCEEDED.
  const { fn } = fakeFetch([
    [
      "/batches/abc",
      () => ({
        metadata: {
          state: "BATCH_STATE_SUCCEEDED",
          batchStats: { requestCount: "1", failedRequestCount: "1" },
          output: {
            inlinedResponses: {
              inlinedResponses: [
                { metadata: { key: "panel-a" }, error: { code: 3, message: "Request contains an invalid argument." } },
              ],
            },
          },
        },
      }),
    ],
  ]);
  const status = await gemini(fn).pollBatch({ handle: "batches/abc", keys: ["panel-a"], idempotencyKey: "i" });
  expect(status.state).toBe("failed");
  expect(status.items![0]!.key).toBe("panel-a");
  expect(status.items![0]!.ok).toBe(false);
});
