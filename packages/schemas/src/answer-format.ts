/**
 * Renders an answer's JSON Schema as a commented TypeScript interface — what a person answering a prompt by hand
 * needs in order to know what goes in every field.
 *
 * It works from the JSON Schema rather than from the Zod schema because that is what the prompt carries: rendering
 * from the prompt's own copy is exact for the question being asked, including anything decided at run time (the
 * panel ids a narration answer may use). The explanations come from `ANSWER_FIELD_DOCS`, keyed by field path; the
 * types, allowed values, bounds and optionality come from the schema itself, so they cannot drift.
 */

/** The subset of JSON Schema that `z.toJSONSchema` produces for the answer schemas. */
export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  pattern?: string;
  additionalProperties?: JsonSchema | boolean;
};

/**
 * Every field path in a schema, in the form the docs are keyed by: `characters[].bible.hair`. `[]` marks a step
 * into an array's items, so a field of the objects in a list is written once, not per element.
 */
export function fieldPaths(schema: JsonSchema, prefix = ""): string[] {
  const out: string[] = [];
  const visit = (s: JsonSchema, at: string) => {
    if (s.properties)
      for (const [k, v] of Object.entries(s.properties)) {
        const p = at ? `${at}.${k}` : k;
        out.push(p);
        visit(v, p);
      }
    if (s.items) visit(s.items, `${at}[]`);
    for (const alt of s.anyOf ?? []) visit(alt, at);
  };
  visit(schema, prefix);
  return out;
}

/**
 * What a field is for, and — for anything that holds a value rather than further fields — a realistic example of
 * it. Objects and lists of objects take no example: their own fields carry them.
 */
export type FieldDoc = string | readonly [description: string, example: unknown];
export type FieldDocs = Record<string, FieldDoc>;

const describe = (d: FieldDoc | undefined) => (d === undefined ? undefined : typeof d === "string" ? d : d[0]);
const exampleOf = (d: FieldDoc | undefined) => (d === undefined || typeof d === "string" ? undefined : d[1]);

/** Whether a field holds further fields (and so takes its example from them) rather than a value. */
const holdsFields = (s: JsonSchema): boolean =>
  Boolean(s.properties) || (Boolean(s.items) && holdsFields(s.items!)) || (s.anyOf ?? []).some(holdsFields);

const literal = (v: unknown) => JSON.stringify(v);

function typeOf(s: JsonSchema, path: string, docs: FieldDocs, indent: string): string {
  if (s.const !== undefined) return literal(s.const);
  if (s.enum) return s.enum.map(literal).join(" | ");
  if (s.anyOf) return [...new Set(s.anyOf.map((a) => typeOf(a, path, docs, indent)))].join(" | ");
  const types = Array.isArray(s.type) ? s.type : [s.type];
  const rendered = types.map((t) => {
    switch (t) {
      case "string":
        return "string";
      case "integer":
      case "number":
        return "number";
      case "boolean":
        return "boolean";
      case "null":
        return "null";
      case "array": {
        const inner = s.items ? typeOf(s.items, `${path}[]`, docs, indent) : "unknown";
        return inner.includes(" | ") && !inner.startsWith("{") ? `(${inner})[]` : `${inner}[]`;
      }
      case "object":
        if (s.properties) return objectBody(s, path, docs, indent);
        if (s.additionalProperties && typeof s.additionalProperties === "object")
          return `Record<string, ${typeOf(s.additionalProperties, path, docs, indent)}>`;
        return "Record<string, unknown>";
      default:
        return "unknown";
    }
  });
  return rendered.join(" | ");
}

/** The rules a field's type does not already say: bounds, a pattern, and whether it can be left out. */
function constraints(s: JsonSchema, optional: boolean): string[] {
  const out: string[] = [];
  const range = (lo?: number, hi?: number, unit = "") =>
    lo !== undefined && hi !== undefined
      ? `Between ${lo} and ${hi}${unit}.`
      : lo !== undefined
        ? `At least ${lo}${unit}.`
        : hi !== undefined
          ? `At most ${hi}${unit}.`
          : null;
  const r =
    range(s.minimum, s.maximum) ??
    range(s.minLength, s.maxLength, " characters") ??
    range(s.minItems, s.maxItems, " items");
  if (r) out.push(r);
  if (s.pattern) out.push(`Must match /${s.pattern}/.`);
  if (s.default !== undefined) out.push(`Optional — defaults to ${literal(s.default)} when left out.`);
  else if (optional) out.push("Optional — may be left out.");
  return out;
}

function exampleLine(s: JsonSchema, value: unknown): string | null {
  if (value === undefined || holdsFields(s)) return null;
  return literal(value);
}

function objectBody(s: JsonSchema, path: string, docs: FieldDocs, indent: string): string {
  const inner = `${indent}  `;
  const required = new Set(s.required ?? []);
  const lines: string[] = ["{"];
  for (const [key, field] of Object.entries(s.properties ?? {})) {
    const p = path ? `${path}.${key}` : key;
    const optional = !required.has(key);
    const comment = [describe(docs[p]) ?? "(no description)", ...constraints(field, optional)];
    const ex = exampleLine(field, exampleOf(docs[p]));
    lines.push(`${inner}/**`);
    for (const c of comment) lines.push(`${inner} * ${c}`);
    if (ex) lines.push(`${inner} * @example ${ex}`);
    lines.push(`${inner} */`);
    lines.push(`${inner}${key}${optional ? "?" : ""}: ${typeOf(field, p, docs, inner)};`);
  }
  lines.push(`${indent}}`);
  return lines.join("\n");
}

/** `interface Name { ... }` with every field explained, typed exactly, and given its example value. */
export function renderInterface(name: string, schema: JsonSchema, docs: FieldDocs): string {
  const head = describe(docs[""]) ? `/** ${describe(docs[""])} */\n` : "";
  return `${head}interface ${name} ${objectBody(schema, "", docs, "")}`;
}

/**
 * A complete answer built from the documented examples: every field that has one, lists holding one element. The
 * tests validate it against the real schema, which is what makes the documented examples trustworthy — each is
 * checked in the company of all the others, the way an answer is.
 */
export function assembleExample(schema: JsonSchema, docs: FieldDocs, path = ""): unknown {
  if (!holdsFields(schema)) return exampleOf(docs[path]);
  if (schema.properties) {
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.properties)) {
      const p = path ? `${path}.${key}` : key;
      const value = assembleExample(field, docs, p);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }
  if (schema.items) return [assembleExample(schema.items, docs, `${path}[]`)];
  const alt = (schema.anyOf ?? []).find(holdsFields);
  return alt ? assembleExample(alt, docs, path) : undefined;
}

/**
 * The schema a prompt asks its answer to match, as the prompt states it: every text prompt ends with
 * "matching the <Name> JSON schema:" and the schema on the next line.
 */
export function schemaFromPrompt(prompt: string): { name: string; schema: JsonSchema } | null {
  const m = prompt.match(/matching the (\w+) JSON schema:\n(\{.*\})/);
  if (!m) return null;
  try {
    return { name: m[1]!, schema: JSON.parse(m[2]!) as JsonSchema };
  } catch {
    return null;
  }
}
