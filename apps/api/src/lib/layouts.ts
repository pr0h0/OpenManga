import { clampFrame, customLayoutFrames, templateFrames } from "@openmanga/domain";
import type { CustomLayout, Frame, ProjectSettings, UserSettings } from "@openmanga/schemas";

/** A saved layout by its page key (`custom:<id>`): the project's copy first, else the caller's own. */
export function findCustomLayout(
  key: string,
  project: { settings: ProjectSettings },
  me: { settings: UserSettings },
): CustomLayout | null {
  if (!key.startsWith("custom:")) return null;
  const id = key.slice("custom:".length);
  return project.settings.layouts?.find((l) => l.id === id) ?? me.settings.layouts?.find((l) => l.id === id) ?? null;
}

/**
 * The frames a page layout key gives a page: a built-in template with the project's margin and gutter, or a saved
 * layout as it was arranged (mirrored for the other reading direction). Null for a key that is neither.
 */
export function layoutFrames(
  key: string,
  project: { settings: ProjectSettings },
  me: { settings: UserSettings },
  dir: "ltr" | "rtl" | "vertical",
): Frame[] | null {
  const custom = findCustomLayout(key, project, me);
  if (custom) return customLayoutFrames(custom, dir).map(clampFrame);
  try {
    return templateFrames(key, {
      margin: project.settings.pageMargin,
      gutter: project.settings.pageGutter,
      readingDirection: dir,
    });
  } catch {
    return null;
  }
}

/**
 * Existing panels (in their order) onto a layout's frames: each takes the frame at its place; a panel beyond the
 * layout's frames gets a strip along the bottom (as a template swap does), and frames beyond the panels are returned
 * as `extra`, for new empty panels.
 */
export function fitPanels(count: number, frames: Frame[], margin: number) {
  const fitted = Array.from(
    { length: count },
    (_, i) => frames[i] ?? clampFrame({ x: margin, y: 1 - margin - 0.1, width: 1 - margin * 2, height: 0.1 }),
  );
  return { fitted, extra: frames.slice(count) };
}
