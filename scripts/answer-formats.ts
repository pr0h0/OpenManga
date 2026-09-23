// Regenerates docs/ANSWER_FORMATS.md from the answer schemas and their field docs.
import { answerReferenceMarkdown } from "../packages/schemas/src/answer-reference.ts";

await Bun.write(new URL("../docs/ANSWER_FORMATS.md", import.meta.url), answerReferenceMarkdown());
console.log("wrote docs/ANSWER_FORMATS.md");
