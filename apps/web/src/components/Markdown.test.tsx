import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "./Markdown.tsx";

const html = (text: string) => renderToStaticMarkup(<Markdown text={text} />);

test("renders the Markdown a model writes", () => {
  const out = html(
    [
      "## Concepts",
      "",
      "**Concept A**: the *hero* on the rocks, with `LUCK -99` on a panel.",
      "",
      "- one",
      "- two",
      "",
      "1. first",
      "2. second",
      "",
      "> a quote",
      "",
      "---",
      "",
      "| Idea | Hook |",
      "| --- | --- |",
      "| A | strong |",
      "",
      "```",
      "IMAGE PROMPT: raw",
      "```",
      "[docs](https://example.com)",
    ].join("\n"),
  );
  expect(out).toContain("<h4");
  expect(out).toContain("<strong>Concept A</strong>");
  expect(out).toContain("<em>hero</em>");
  expect(out).toContain("LUCK -99</code>");
  expect(out).toContain("<ul");
  expect(out).toContain("<li>two</li>");
  expect(out).toContain("<ol");
  expect(out).toContain("<blockquote");
  expect(out).toContain("<hr");
  expect(out).toContain("<th");
  expect(out).toContain(">strong</td>");
  expect(out).toContain("IMAGE PROMPT: raw</pre>");
  expect(out).toContain('href="https://example.com"');
});

test("never lets a reply inject markup or scripts", () => {
  const out = html('<img src=x onerror="alert(1)"> [x](javascript:alert(1)) <b>bold</b>');
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<b>");
  expect(out).not.toContain('href="javascript');
  expect(out).toContain("&lt;img");
});

test("a reply still arriving renders what is there: an open code fence, a half list", () => {
  expect(html("Intro\n\n```\npartial code")).toContain("partial code</pre>");
  expect(html("- a\n- b")).toContain("<li>b</li>");
  expect(html("2 * 3 * 4 is not emphasis")).not.toContain("<em>");
});
