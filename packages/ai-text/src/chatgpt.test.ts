import { expect, test } from "bun:test";
import { ChatgptTextProvider } from "./index.ts";

const sse = (events: object[]) =>
  new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

test("ChatGPT: streamed Responses call with store off, text and usage read from the events", async () => {
  let sent: Record<string, unknown> = {};
  const p = new ChatgptTextProvider({
    apiKey: "tok",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-6-luna",
    timeoutMs: 5000,
    maxConcurrency: 1,
    fetch: (async (_u: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body));
      return sse([
        { type: "response.output_text.delta", delta: '{"ok":' },
        { type: "response.output_text.delta", delta: "true}" },
        {
          type: "response.completed",
          response: { id: "r1", model: "gpt-6-luna", usage: { input_tokens: 9, output_tokens: 3 } },
        },
      ]);
    }) as unknown as typeof fetch,
  });
  const r = await p.generateText({
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ],
  });
  expect(sent).toMatchObject({ store: false, stream: true, instructions: "sys" });
  expect((sent.input as unknown[]).length).toBe(1);
  expect(r.text).toBe('{"ok":true}');
  expect(r.call).toMatchObject({ requestId: "r1", inputTokens: 9, outputTokens: 3 });
});
