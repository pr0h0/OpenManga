/** Runs that read as repetitive: the same shot size this many panels in a row, or the same framing (size and angle). */
export const SHOT_VARIETY = { sizeRun: 4, framingRun: 3 } as const;

export type ShotRun = {
  /** "framing": the same size and angle; "size": the same size, from changing angles. */
  kind: "size" | "framing";
  shotType: string;
  /** The angle every panel of a framing run shares (no angle set reads as eye level). */
  cameraAngle: string | null;
  panelIds: string[];
};

type Shot = { id: string; shotType: string; cameraAngle: string | null };

/**
 * Runs of panels, in reading order, that repeat a shot: the same size four or more times in a row, or the same size
 * and angle three or more times. A run of one size is reported once, as framing when its angle never changes.
 */
export function repeatedShots(panels: Shot[]): ShotRun[] {
  const angle = (p: Shot) => p.cameraAngle || "eye-level";
  const out: ShotRun[] = [];
  let i = 0;
  while (i < panels.length) {
    let j = i + 1;
    while (j < panels.length && panels[j]!.shotType === panels[i]!.shotType) j++;
    const run = panels.slice(i, j);
    const sameAngle = run.every((p) => angle(p) === angle(run[0]!));
    if (run.length >= SHOT_VARIETY.sizeRun || (sameAngle && run.length >= SHOT_VARIETY.framingRun))
      out.push({
        kind: sameAngle ? "framing" : "size",
        shotType: run[0]!.shotType,
        cameraAngle: sameAngle ? angle(run[0]!) : null,
        panelIds: run.map((p) => p.id),
      });
    i = j;
  }
  return out;
}

/** "4 medium shots in a row" / "3 close shots in a row from the same low angle". */
export const describeShotRun = (r: ShotRun) =>
  `${r.panelIds.length} ${r.shotType} shots in a row${r.kind === "framing" ? ` from the same ${r.cameraAngle} angle` : ""}`;
