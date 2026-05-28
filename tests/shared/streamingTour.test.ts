// @vitest-environment node
import { describe, expect, it } from "vitest";
import { extractStreamedChapters } from "../../src/shared/streamingTour.js";

const chapterOne = '{"id":"chapter-1","title":"First","summary":"a"}';
const chapterTwo = '{"id":"chapter-2","title":"Second { with brace }","summary":"b"}';
const fullTour = `{"chapters":[${chapterOne},${chapterTwo}],"graph":{"nodes":[],"edges":[]}}`;

describe("extractStreamedChapters", () => {
  it("returns only chapters whose closing brace has arrived", () => {
    // Stream truncated partway through the second chapter.
    const partial = `{"chapters":[${chapterOne},{"id":"chapter-2","title":"Sec`;
    expect(extractStreamedChapters(partial)).toEqual([{ id: "chapter-1", title: "First", summary: "a" }]);
  });

  it("extracts every complete chapter once the array is fully streamed", () => {
    expect(extractStreamedChapters(fullTour)).toEqual([
      { id: "chapter-1", title: "First", summary: "a" },
      { id: "chapter-2", title: "Second { with brace }", summary: "b" }
    ]);
  });

  it("is not confused by braces or brackets inside string values", () => {
    const tricky = '{"chapters":[{"id":"chapter-1","title":"a]}{ ","summary":"]"}]}';
    expect(extractStreamedChapters(tricky)).toEqual([{ id: "chapter-1", title: "a]}{ ", summary: "]" }]);
  });

  it("returns nothing before the chapters array begins", () => {
    expect(extractStreamedChapters('{"generatedAt":"2026"')).toEqual([]);
    expect(extractStreamedChapters("")).toEqual([]);
  });

  it("grows monotonically as more text arrives", () => {
    const prefix = `{"chapters":[${chapterOne}`;
    expect(extractStreamedChapters(prefix)).toHaveLength(1);
    expect(extractStreamedChapters(`${prefix},${chapterTwo}`)).toHaveLength(2);
  });
});
