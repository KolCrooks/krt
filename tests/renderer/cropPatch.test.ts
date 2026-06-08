import { describe, expect, it } from "vitest";
import { cropPatchToFocusRanges } from "../../src/renderer/components/diffs/cropPatch.js";

const patch = [
  "diff --git a/f b/f",
  "--- a/f",
  "+++ b/f",
  "@@ -1,3 +1,3 @@",
  " a",
  "-b",
  "+B",
  " c",
  "@@ -50,3 +50,3 @@",
  " x",
  "-y",
  "+Y",
  " z"
].join("\n");

describe("cropPatchToFocusRanges", () => {
  it("keeps only hunks overlapping a focus range and preserves the header", () => {
    const cropped = cropPatchToFocusRanges(patch, [{ start: 1, end: 3, side: "right" }]);
    expect(cropped).toContain("--- a/f");
    expect(cropped).toContain("@@ -1,3 +1,3 @@");
    expect(cropped).toContain("+B");
    // The far-away second hunk is dropped.
    expect(cropped).not.toContain("@@ -50,3 +50,3 @@");
    expect(cropped).not.toContain("+Y");
  });

  it("keeps a later hunk when the range targets it", () => {
    const cropped = cropPatchToFocusRanges(patch, [{ start: 51, end: 51, side: "right" }]);
    expect(cropped).toContain("@@ -50,3 +50,3 @@");
    expect(cropped).not.toContain("@@ -1,3 +1,3 @@");
  });

  it("falls back to the full patch when nothing overlaps or no ranges are given", () => {
    expect(cropPatchToFocusRanges(patch, [{ start: 999, end: 1000, side: "right" }])).toBe(patch);
    expect(cropPatchToFocusRanges(patch, [])).toBe(patch);
  });
});
