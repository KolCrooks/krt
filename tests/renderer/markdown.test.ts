import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/renderer/lib/markdown.js";

describe("renderMarkdown", () => {
  it("renders markdown images inside inline HTML tags", () => {
    const html = renderMarkdown("<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>");

    expect(html).toContain("<sub><sub><img");
    expect(html).toContain('src="https://img.shields.io/badge/P2-yellow?style=flat"');
    expect(html).toContain('alt="P2 Badge"');
  });

  it("allows raw HTML img elements with safe image attributes", () => {
    const html = renderMarkdown(
      '<img src="https://img.shields.io/badge/P2-yellow?style=flat" alt="P2 Badge" width="82" height="20">'
    );

    expect(html).toContain("<img");
    expect(html).toContain('src="https://img.shields.io/badge/P2-yellow?style=flat"');
    expect(html).toContain('alt="P2 Badge"');
    expect(html).toContain('width="82"');
    expect(html).toContain('height="20"');
  });

  it("strips unsafe attributes from raw HTML img elements", () => {
    const html = renderMarkdown(
      '<img src="https://img.shields.io/badge/P2-yellow?style=flat" alt="P2 Badge" onerror="alert(1)" style="width:999px">'
    );

    expect(html).toContain("<img");
    expect(html).not.toContain("onerror");
    expect(html).not.toContain(' style="');
  });
});
