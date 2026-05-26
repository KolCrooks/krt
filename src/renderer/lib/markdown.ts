import DOMPurify from "dompurify";
import { marked } from "marked";

marked.use({
  async: false,
  gfm: true,
  breaks: true
});

export function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown || "", { async: false }) as string;
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ALLOWED_TAGS: [
      "a",
      "blockquote",
      "br",
      "code",
      "del",
      "details",
      "summary",
      "div",
      "em",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "hr",
      "img",
      "input",
      "kbd",
      "li",
      "ol",
      "p",
      "pre",
      "s",
      "span",
      "strong",
      "sub",
      "sup",
      "table",
      "tbody",
      "td",
      "th",
      "thead",
      "tr",
      "u",
      "ul"
    ],
    ALLOWED_ATTR: [
      "href",
      "title",
      "target",
      "rel",
      "alt",
      "src",
      "srcset",
      "width",
      "height",
      "class",
      "type",
      "checked",
      "disabled",
      "align",
      "colspan",
      "rowspan",
      "open"
    ]
  });
}
