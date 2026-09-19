import { ProviderError, type ProviderErrorCode } from "@openmanga/domain/browser";
import { z } from "zod";

/** Images are only supported by vision-capable providers/models; others reject the request clearly. */
export type ChatImage = { mime: string; data: Uint8Array };
export type ChatMessage = { role: "system" | "user" | "assistant"; content: string; images?: ChatImage[] };

export type TextCallRecord = {
  provider: string;
  model: string;
  requestId: string | null;
  purpose: "primary" | "repair";
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  latencyMs: number;
  rawUsage: Record<string, unknown>;
  success: boolean;
  errorCode?: ProviderErrorCode;
};

export type TextRequest = {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  signal?: AbortSignal;
};

export type TextResult = { text: string; finishReason: string | null; call: TextCallRecord };

export type StructuredRequest<T> = Omit<TextRequest, "json"> & {
  schema: z.ZodType<T>;
  schemaName: string;
  /** Messages for the repair attempt (built by the json-repair template). */
  buildRepairMessages?: (args: { raw: string; error: string; schemaText: string }) => ChatMessage[];
};

export type StructuredResult<T> = { data: T; repaired: boolean; calls: TextCallRecord[]; rawText: string };

export interface TextAIProvider {
  readonly provider: string;
  readonly model: string;
  generateText(req: TextRequest): Promise<TextResult>;
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResult<T>>;
}

/** Error that carries the call records made before failing (for usage accounting). */
export class StructuredOutputError extends ProviderError {
  constructor(
    provider: string,
    message: string,
    readonly calls: TextCallRecord[],
    readonly rawText: string,
  ) {
    super(provider, "invalid_json", message);
  }
}

/** Trailing commas before a closer: common in long generated JSON and illegal in JSON.parse. */
const dropTrailingCommas = (s: string) => s.replace(/,(\s*[}\]])/g, "$1");

/**
 * The first JSON value in `text`, scanned with string/escape awareness so text around it (prose, reasoning,
 * fences, a second object) is ignored. When the value never closes — a cut-off response — the open strings and
 * containers are closed so the partial object can still be validated.
 */
export function scanJsonValue(text: string): string | null {
  const start = text.search(/[[{]/);
  if (start < 0) return null;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") {
      if (stack.pop() !== c) return text.slice(start, i);
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  // Unclosed (cut-off response): close what is open. Two shapes are tried — keep the dangling string, or drop
  // the trailing partial entry — and whichever parses wins.
  const closers = stack.reverse().join("");
  const body = text.slice(start);
  const candidates = [`${inString ? `${body}"` : body}${closers}`, `${body.replace(/,?\s*("[^"]*)?$/, "")}${closers}`];
  for (const c of candidates) {
    try {
      JSON.parse(dropTrailingCommas(c));
      return c;
    } catch {}
  }
  return candidates[0]!;
}

export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const scanned = scanJsonValue(fence ?? trimmed);
  for (const candidate of [trimmed, fence, scanned]) {
    if (!candidate) continue;
    for (const variant of [candidate, dropTrailingCommas(candidate)]) {
      try {
        return JSON.parse(variant);
      } catch {}
    }
  }
  throw new SyntaxError("No parseable JSON found");
}

const formatZodError = (e: z.ZodError) =>
  e.issues
    .slice(0, 12)
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");

/** Shared structured-output pipeline: extract -> validate -> one repair -> fail clearly. */
export async function runStructured<T>(p: TextAIProvider, req: StructuredRequest<T>): Promise<StructuredResult<T>> {
  const calls: TextCallRecord[] = [];
  const first = await p.generateText({ ...req, json: true });
  calls.push(first.call);

  const sample = (text: string) =>
    text.length > 500 ? `${text.slice(0, 250)} …[${text.length} chars]… ${text.slice(-250)}` : text;
  const attempt = (text: string): { ok: true; data: T } | { ok: false; error: string } => {
    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch {
      return { ok: false, error: "response was not valid JSON" };
    }
    const r = req.schema.safeParse(parsed);
    return r.success ? { ok: true, data: r.data } : { ok: false, error: formatZodError(r.error) };
  };

  const r1 = attempt(first.text);
  if (r1.ok) return { data: r1.data, repaired: false, calls, rawText: first.text };
  if (!req.buildRepairMessages)
    throw new StructuredOutputError(p.provider, `Invalid ${req.schemaName}: ${r1.error}`, calls, first.text);

  const schemaText = JSON.stringify(z.toJSONSchema(req.schema, { io: "input", unrepresentable: "any" }));
  let repair: TextResult;
  try {
    repair = await p.generateText({
      messages: req.buildRepairMessages({ raw: first.text, error: r1.error, schemaText }),
      json: true,
      maxTokens: req.maxTokens,
      // No temperature: reasoning models (GPT-5, Muse Spark) reject anything but their default and answer 400,
      // which failed every repair and took the whole job down with it. Providers pick their own JSON default.
      signal: req.signal,
    });
  } catch (e) {
    if (e instanceof ProviderError)
      throw new StructuredOutputError(p.provider, `Repair request failed: ${e.message}`, calls, first.text);
    throw e;
  }
  calls.push({ ...repair.call, purpose: "repair" });
  const r2 = attempt(repair.text);
  if (r2.ok) return { data: r2.data, repaired: true, calls, rawText: repair.text };
  throw new StructuredOutputError(
    p.provider,
    `Invalid ${req.schemaName} after repair: ${r2.error} (model returned: ${sample(repair.text)})`,
    calls,
    repair.text,
  );
}

export { AnthropicTextProvider } from "./anthropic.ts";
export * from "./batch.ts";
export { DeepSeekTextProvider } from "./deepseek.ts";
export { FakeTextAIProvider } from "./fake.ts";
export { MetaMuseTextProvider, type OpenAIChatOptions, OpenAIChatTextProvider } from "./meta.ts";
