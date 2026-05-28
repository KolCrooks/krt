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

// Render a single line of Markdown without wrapping block elements (no <p>),
// suitable for titles and other inline contexts.
export function renderInlineMarkdown(markdown: string): string {
  const html = marked.parseInline(markdown || "", { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: ["a", "br", "code", "del", "em", "kbd", "s", "span", "strong", "sub", "sup", "u"],
    ALLOWED_ATTR: ["href", "title", "target", "rel", "class"]
  });
}

// Flatten Markdown to plain text, for places where HTML cannot be embedded
// (e.g. concatenated captions or tooltips).
export function stripMarkdown(markdown: string): string {
  return (markdown || "")
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/\*\*?([^*]+)\*\*?/g, "$1")
    .replace(/__?([^_]+)__?/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*[>\-*+]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}
