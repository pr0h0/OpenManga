import { ProviderError } from "@openmanga/domain/browser";
import { mockTextCompletion, scenarioFromText } from "@openmanga/testing";
import {
  runStructured,
  type StructuredRequest,
  type StructuredResult,
  type TextAIProvider,
  type TextRequest,
  type TextResult,
} from "./index.ts";

/** In-process fake. Only used when AI_MOCK_MODE=true or in tests. Supports [[mock:scenario]] markers. */
export class FakeTextAIProvider implements TextAIProvider {
  readonly provider = "mock";
  readonly model = "mock";
  calls = 0;

  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>> {
    return runStructured(this, req);
  }

  async generateText(req: TextRequest): Promise<TextResult> {
    this.calls++;
    const all = req.messages.map((m) => m.content).join("\n");
    const isRepair = all.includes("[template:json-repair-v1]");
    const scenario = scenarioFromText(all);
    const fail = (code: ConstructorParameters<typeof ProviderError>[1], msg: string) =>
      new ProviderError(this.provider, code, msg, { requestId: `mock-${this.calls}` });
    if (!isRepair) {
      if (scenario === "429") throw fail("rate_limited", "mock rate limit");
      if (scenario === "500" || scenario === "502" || scenario === "503")
        throw fail("server_error", "mock server error");
      if (scenario === "timeout") throw fail("timeout", "mock timeout");
      if (scenario === "reset") throw fail("network", "mock connection reset");
      if (scenario === "auth") throw fail("auth", "mock auth failure");
      if (scenario === "quota") throw fail("quota", "mock insufficient balance");
    }
    let text: string;
    const original = isRepair
      ? (this.original ?? { messages: req.messages, scenario: null })
      : { messages: req.messages, scenario };
    if (!isRepair) this.original = original;
    const result = mockTextCompletion(original.messages);
    const sc = original.scenario;
    if (sc === "invalid-json") text = "{ this is not json";
    else if (sc === "schema-invalid") text = JSON.stringify({ unexpected: true });
    else if (sc === "fenced-json" && !isRepair)
      text = `Here you go:\n\`\`\`json\n${JSON.stringify(result)}\n\`\`\`\nThanks!`;
    else if (sc === "repairable" && !isRepair) text = JSON.stringify({ unexpected: true });
    // A template that answers in prose (an expert chat) gets its text as is.
    else text = typeof result === "string" ? result : JSON.stringify(result);
    const inputTokens = Math.ceil(all.length / 4);
    return {
      text,
      finishReason: "stop",
      call: {
        provider: this.provider,
        model: this.model,
        requestId: `mock-${this.calls}`,
        purpose: "primary",
        inputTokens,
        outputTokens: Math.ceil(text.length / 4),
        cachedTokens: 0,
        latencyMs: 1,
        rawUsage: { prompt_tokens: inputTokens, completion_tokens: Math.ceil(text.length / 4), mock: true },
        success: true,
      },
    };
  }
  private original?: { messages: TextRequest["messages"]; scenario: ReturnType<typeof scenarioFromText> };
}
