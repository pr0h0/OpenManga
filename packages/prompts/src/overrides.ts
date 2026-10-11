import { DATA_RULE } from "./text-templates.ts";

/**
 * A text template's system prompt in three parts: its header (`[template:name-vN]`, which logs and mocks route on),
 * the rules a project may rewrite in the prompt lab, and the locked tail — the rule that story content is data,
 * and the answer format — which no override can change, so a job's contract and its injection guard always hold.
 */
export function splitSystem(system: string) {
  const header = system.startsWith("[template:") ? system.slice(0, system.indexOf("]") + 1) : "";
  const at = system.indexOf(DATA_RULE);
  const end = at >= 0 ? at : system.length;
  return {
    header,
    rules: system.slice(header.length, end).trim(),
    locked: system.slice(end).trim(),
  };
}

/** The system prompt with the project's rules in place of the built-in ones. */
export function overrideSystem(system: string, rules: string) {
  const s = splitSystem(system);
  return [s.header, rules.trim(), s.locked].filter(Boolean).join("\n\n");
}

/** Project rules for the panel image prompt, after everything the template wrote. */
export const withProjectRules = (prompt: string, rules: string) =>
  rules.trim() ? `${prompt}\n\nPROJECT RULES:\n${rules.trim()}` : prompt;

/** A line diff (longest common subsequence): each line kept, added or removed, in order. */
export function lineDiff(a: string, b: string) {
  const x = a.split("\n");
  const y = b.split("\n");
  const m = x.length;
  const n = y.length;
  const lcs = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: { op: "same" | "add" | "remove"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) {
      out.push({ op: "same", line: x[i]! });
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) out.push({ op: "remove", line: x[i++]! });
    else out.push({ op: "add", line: y[j++]! });
  }
  while (i < m) out.push({ op: "remove", line: x[i++]! });
  while (j < n) out.push({ op: "add", line: y[j++]! });
  return out;
}

/** The prompts a project may rewrite in the prompt lab, and which project formats use them. */
export const OVERRIDABLE = [
  { name: "chapter-outline", label: "Chapter planning: scene outline", formats: ["comic"] },
  { name: "scene-pages", label: "Chapter planning: each scene's pages and panels", formats: ["comic"] },
  { name: "strip-outline", label: "Strip planning: scene outline", formats: ["vertical"] },
  { name: "scene-strip", label: "Strip planning: each scene's panels", formats: ["vertical"] },
  { name: "shot-outline", label: "Shot planning: scene outline", formats: ["film"] },
  { name: "scene-shots", label: "Shot planning: each scene's shots", formats: ["film"] },
  { name: "panel-prompts", label: "Panel prompts (the text model's sections)", formats: ["comic", "vertical", "film"] },
  { name: "narration", label: "Narration instructions", formats: ["comic", "vertical", "film"] },
  {
    name: "panel-generation",
    label: "Panel images: project rules and exclusions",
    formats: ["comic", "vertical", "film"],
    image: true,
  },
] as const;
export type OverridableName = (typeof OVERRIDABLE)[number]["name"];
