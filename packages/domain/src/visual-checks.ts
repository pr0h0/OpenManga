import { VISUAL_CHECK_DEFAULTS, type VisualCheck, type VisualCheckMode } from "@openmanga/schemas";

/** A panel is re-rolled at most this many times in a row by its checks, whatever the budget left. */
export const MAX_AUTO_REGENERATIONS = 3;

/** Covered faces is fixed by moving the lettering, not by drawing again: it can only be flagged. */
const FLAG_ONLY = new Set<VisualCheck>(["covered_faces"]);

export const visualCheckModes = (checks: Partial<Record<VisualCheck, VisualCheckMode>> | undefined) => ({
  ...VISUAL_CHECK_DEFAULTS,
  ...checks,
});

/**
 * Whether a failed check re-rolls the panel. `attempt` is how many automatic re-rolls led to the checked artwork;
 * `spentUsd` is what the project's automatic re-rolls have cost so far. Regenerate once allows one; regenerate to a
 * budget allows up to MAX_AUTO_REGENERATIONS while the spend is under the budget. Anything else is flagged.
 */
export function autoFixDecision(i: {
  failed: VisualCheck[];
  modes: Record<VisualCheck, VisualCheckMode>;
  attempt: number;
  spentUsd: number;
  budgetUsd: number;
}): { regenerate: boolean; reason: string } {
  const modes = new Set(i.failed.filter((c) => !FLAG_ONLY.has(c)).map((c) => i.modes[c]));
  if (modes.has("regenerate_budget")) {
    if (i.attempt >= MAX_AUTO_REGENERATIONS)
      return { regenerate: false, reason: `still failing after ${i.attempt} automatic re-rolls` };
    if (i.spentUsd >= i.budgetUsd)
      return { regenerate: false, reason: `the automatic re-roll budget ($${i.budgetUsd.toFixed(2)}) is spent` };
    return { regenerate: true, reason: "regenerating within the budget" };
  }
  if (modes.has("regenerate_once")) {
    if (i.attempt >= 1) return { regenerate: false, reason: "still failing after its one automatic re-roll" };
    return { regenerate: true, reason: "regenerating once" };
  }
  return { regenerate: false, reason: "" };
}
