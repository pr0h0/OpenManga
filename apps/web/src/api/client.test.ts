import { expect, test } from "bun:test";
import { api } from "./client.ts";

/**
 * `api()` serialises the body. A caller that also stringifies produces a JSON string, which the server parses
 * back to a string and rejects with "expected object, received string" — far from its cause. This is the guard
 * that turns that into an obvious error at the call site; it shipped once, in the image-describe apply actions.
 */
test("a pre-stringified body is refused rather than double-encoded", async () => {
  await expect(api("/characters/x/versions", { method: "POST", body: JSON.stringify({ a: 1 }) })).rejects.toThrow(
    /pass the object to api/,
  );
});
