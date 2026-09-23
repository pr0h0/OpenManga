import type { ChatMessage } from "./index.ts";

/**
 * A prompt as plain text, each message under its role: the form a job stores it in and a person copies into a chat.
 * An image a provider would have been sent is marked where it sits, since text cannot carry it.
 */
export const formatPrompt = (messages: ChatMessage[]) =>
  messages
    .map((m) => {
      const images = (m.images ?? []).map(
        (i, n) => `[attach image ${n + 1}${i.assetId ? `: asset ${i.assetId}` : ""}]`,
      );
      return [`### ${m.role}`, m.content, ...images].join("\n");
    })
    .join("\n\n")
    .slice(0, 200_000);

/** The inverse of `formatPrompt`, near enough to reconstruct the messages a stored prompt was built from. */
export const parsePrompt = (text: string): ChatMessage[] =>
  [
    ...text.matchAll(/^### (system|user|assistant)\n([\s\S]*?)(?=\n\n### (?:system|user|assistant)\n|$(?![\s\S]))/gm),
  ].map((m) => ({ role: m[1] as ChatMessage["role"], content: m[2]! }));
