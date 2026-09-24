import { Fragment, type ReactNode } from "react";

/**
 * Renders the Markdown chat models write (headings, emphasis, code, lists, quotes, links, rules and tables) as React
 * elements. It never builds HTML from the text, so nothing a model writes can inject markup; anything it does not
 * recognise is shown as the text it is. Built for replies, which may be half-written while they stream in.
 */
export function Markdown({ text }: { text: string }) {
  return <div className="space-y-2 break-words leading-relaxed">{blocks(text)}</div>;
}

const LINK = /^https?:\/\//i;

/** Inline spans: `code`, **bold**, *italic* / _italic_, and [links](https://...). */
function inline(text: string, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  const re =
    /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\s][^*\n]*\*|\b_[^_\s][^_\n]*_\b)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let n = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    const k = `${key}-${n++}`;
    if (m[1])
      out.push(
        <code key={k} className="rounded bg-[var(--panel-2)] px-1 py-0.5 font-mono text-[0.85em]">
          {t.slice(1, -1)}
        </code>,
      );
    else if (m[2]) out.push(<strong key={k}>{inline(t.slice(2, -2), k)}</strong>);
    else if (m[3]) out.push(<em key={k}>{inline(t.slice(1, -1), k)}</em>);
    else {
      const label = t.slice(1, t.indexOf("]("));
      const href = t.slice(t.indexOf("](") + 2, -1);
      out.push(
        LINK.test(href) ? (
          <a key={k} href={href} target="_blank" rel="noreferrer noopener" className="text-accent-500 underline">
            {label}
          </a>
        ) : (
          t
        ),
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** One paragraph's lines, keeping the model's line breaks. */
const lines = (text: string, key: string) =>
  text.split("\n").map((l, i) => (
    <Fragment key={`${key}-${i}`}>
      {i > 0 && <br />}
      {inline(l, `${key}-${i}`)}
    </Fragment>
  ));

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^(\s*)[-*+]\s+(.*)$/;
const NUMBERED = /^(\s*)(\d+)[.)]\s+(.*)$/;
const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const cells = (row: string) =>
  row
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

function blocks(text: string): ReactNode[] {
  const src = text.replace(/\r\n/g, "\n").split("\n");
  const out: ReactNode[] = [];
  let i = 0;
  const key = () => `b${out.length}`;
  while (i < src.length) {
    const l = src[i]!;
    if (!l.trim()) {
      i++;
      continue;
    }
    // Fenced code: everything up to the closing fence (or the end, while a reply is still streaming in).
    if (l.trimStart().startsWith("```")) {
      const body: string[] = [];
      i++;
      while (i < src.length && !src[i]!.trimStart().startsWith("```")) body.push(src[i++]!);
      i++;
      out.push(
        <pre key={key()} className="overflow-x-auto rounded-lg bg-[var(--panel-2)] p-3 font-mono text-xs">
          {body.join("\n")}
        </pre>,
      );
      continue;
    }
    const h = HEADING.exec(l);
    if (h) {
      const level = h[1]!.length;
      const cls =
        level <= 1 ? "text-base font-semibold" : level === 2 ? "text-[0.95rem] font-semibold" : "font-semibold";
      // Shifted down: a reply's "#" sits inside a chat, below the page's own headings.
      const Tag = (["h3", "h4", "h5", "h6", "h6", "h6"] as const)[level - 1]!;
      out.push(
        <Tag key={key()} className={`${cls} pt-1`}>
          {inline(h[2]!, key())}
        </Tag>,
      );
      i++;
      continue;
    }
    if (RULE.test(l)) {
      out.push(<hr key={key()} className="border-[var(--border)]" />);
      i++;
      continue;
    }
    if (TABLE_ROW.test(l) && i + 1 < src.length && TABLE_DIVIDER.test(src[i + 1]!)) {
      const head = cells(l);
      const rows: string[][] = [];
      i += 2;
      while (i < src.length && TABLE_ROW.test(src[i]!)) rows.push(cells(src[i++]!));
      const k = key();
      out.push(
        <div key={k} className="overflow-x-auto">
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr>
                {head.map((c, j) => (
                  <th key={j} className="border-b border-[var(--border)] px-2 py-1 font-semibold">
                    {inline(c, `${k}-h${j}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {head.map((_, j) => (
                    <td key={j} className="border-b border-[var(--border)] px-2 py-1 align-top">
                      {inline(r[j] ?? "", `${k}-${ri}-${j}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    if (l.trimStart().startsWith(">")) {
      const body: string[] = [];
      while (i < src.length && src[i]!.trimStart().startsWith(">"))
        body.push(src[i++]!.trimStart().replace(/^>\s?/, ""));
      out.push(
        <blockquote key={key()} className="border-l-2 border-[var(--border)] pl-3 muted">
          {blocks(body.join("\n"))}
        </blockquote>,
      );
      continue;
    }
    if (BULLET.test(l) || NUMBERED.test(l)) {
      const ordered = !BULLET.test(l);
      const items: string[] = [];
      while (i < src.length) {
        const m = ordered ? NUMBERED.exec(src[i]!) : BULLET.exec(src[i]!);
        if (m) {
          items.push(ordered ? m[3]! : m[2]!);
          i++;
        } else if (src[i]!.trim() && /^\s{2,}/.test(src[i]!) && items.length) {
          // An indented line continues the item above it.
          items[items.length - 1] += `\n${src[i++]!.trim()}`;
        } else break;
      }
      const k = key();
      const cls = ordered ? "list-decimal space-y-1 pl-5" : "list-disc space-y-1 pl-5";
      const children = items.map((it, j) => <li key={j}>{lines(it, `${k}-${j}`)}</li>);
      out.push(
        ordered ? (
          <ol key={k} className={cls}>
            {children}
          </ol>
        ) : (
          <ul key={k} className={cls}>
            {children}
          </ul>
        ),
      );
      continue;
    }
    // A paragraph: consecutive lines until a blank line or the start of another block.
    const para: string[] = [];
    while (
      i < src.length &&
      src[i]!.trim() &&
      !HEADING.test(src[i]!) &&
      !src[i]!.trimStart().startsWith("```") &&
      !BULLET.test(src[i]!) &&
      !NUMBERED.test(src[i]!) &&
      !src[i]!.trimStart().startsWith(">") &&
      !RULE.test(src[i]!)
    )
      para.push(src[i++]!);
    const k = key();
    out.push(<p key={k}>{lines(para.join("\n"), k)}</p>);
  }
  return out;
}
