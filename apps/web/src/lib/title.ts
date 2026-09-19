/**
 * Tab title for a matched route. The project name is appended so two tabs open on different projects are told
 * apart, and film projects get the same wording the sidebar uses.
 */
export function documentTitle(label: string | undefined, project?: { title: string; film: boolean } | null) {
  const page =
    project?.film && label === "Pages" ? "Shots" : project?.film && label === "Page editor" ? "Shot editor" : label;
  return [page, project?.title, "OpenManga"].filter(Boolean).join(" · ");
}
