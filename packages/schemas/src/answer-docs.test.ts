import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { ANSWER_FIELD_DOCS, ANSWER_SCHEMAS } from "./answer-docs.ts";
import { assembleExample, fieldPaths, type JsonSchema, renderInterface } from "./answer-format.ts";

// The reference a person reads before answering a prompt by hand. It is worth only as much as it is true, so it is
// held to the real schemas: every field explained, nothing explained that no longer exists, and every example valid.
for (const [name, schema] of Object.entries(ANSWER_SCHEMAS)) {
  const json = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as JsonSchema;
  const docs = ANSWER_FIELD_DOCS[name as keyof typeof ANSWER_FIELD_DOCS];
  const paths = fieldPaths(json);

  describe(name, () => {
    test("every field is explained, and nothing is explained that does not exist", () => {
      expect(paths.filter((p) => !(p in docs))).toEqual([]);
      expect(Object.keys(docs).filter((k) => k !== "" && !paths.includes(k))).toEqual([]);
      expect(docs[""]).toBeTruthy();
    });

    test("every value field has an example, and together the examples are a valid answer", () => {
      const assembled = assembleExample(json, docs);
      const parsed = schema.safeParse(assembled);
      expect(parsed.success ? [] : parsed.error.issues).toEqual([]);
    });

    test("renders as an interface with no field left undescribed", () => {
      const text = renderInterface(name, json, docs);
      expect(text.startsWith("/**")).toBe(true);
      expect(text).not.toContain("(no description)");
    });
  });
}

test("docs/ANSWER_FORMATS.md is up to date with the schemas", async () => {
  const { answerReferenceMarkdown } = await import("./answer-reference.ts");
  const committed = await Bun.file(new URL("../../../docs/ANSWER_FORMATS.md", import.meta.url)).text();
  // Regenerate with `bun scripts/answer-formats.ts` when this fails: a schema or its field docs changed.
  expect(committed).toBe(answerReferenceMarkdown());
});
