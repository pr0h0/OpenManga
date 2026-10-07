/** A line that opens a chapter: "Chapter 3", "CHAPTER IV: The Gate", "Ch. 2", "Part One", "Episode 5", "# Title". */
const HEADING =
  /^\s*(?:(?:chapter|ch\.|part|episode|ep\.|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b(?:\s*[:.\-–—].*)?|#{1,3}\s+\S.*)$/i;

/** A story cut at its chapter headings: each chapter's title (its heading line) and full text. */
export function storyChapters(text: string) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: { title: string; text: string }[] = [];
  const pre: string[] = [];
  for (const line of lines) {
    if (HEADING.test(line) && line.trim().length <= 120)
      out.push({ title: line.trim().replace(/^#+\s*/, ""), text: line });
    else if (out.length) out[out.length - 1]!.text += `\n${line}`;
    else pre.push(line);
  }
  // Text before the first heading (a prologue or a title page) opens the first chapter.
  if (out.length && pre.join("").trim()) out[0]!.text = `${pre.join("\n")}\n${out[0]!.text}`;
  return out.map((c) => ({ ...c, text: c.text.trim() }));
}

/**
 * A long story split into episodes of `perEpisode` chapters each, cut at its chapter headings. A story without
 * headings is cut at paragraph breaks into parts of about `charsPerEpisode`. Episode titles name their chapters.
 */
export function splitEpisodes(text: string, opts: { perEpisode?: number; charsPerEpisode?: number } = {}) {
  const per = Math.max(1, opts.perEpisode ?? 3);
  const chs = storyChapters(text);
  if (chs.length >= 2) {
    const eps: { title: string; text: string; chapters: number }[] = [];
    for (let i = 0; i < chs.length; i += per) {
      const group = chs.slice(i, i + per);
      eps.push({
        title: group.length === 1 ? group[0]!.title : `${group[0]!.title} – ${group.at(-1)!.title}`,
        text: group.map((c) => c.text).join("\n\n"),
        chapters: group.length,
      });
    }
    return eps;
  }
  const size = Math.max(2000, opts.charsPerEpisode ?? 20_000);
  const paras = text.trim().split(/\n\s*\n/);
  const eps: { title: string; text: string; chapters: number }[] = [];
  let cur: string[] = [];
  let len = 0;
  for (const p of paras) {
    if (len && len + p.length > size) {
      eps.push({ title: `Part ${eps.length + 1}`, text: cur.join("\n\n"), chapters: 0 });
      cur = [];
      len = 0;
    }
    cur.push(p);
    len += p.length;
  }
  if (cur.length) eps.push({ title: `Part ${eps.length + 1}`, text: cur.join("\n\n"), chapters: 0 });
  return eps;
}
