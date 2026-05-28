// @vitest-environment node
import { describe, expect, it } from "vitest";
import { cropPatchToFocusRanges } from "../../src/renderer/components/diffs/cropPatch.js";

const patch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  " import a;",
  "+import b;",
  " import c;",
  " end-of-first",
  "@@ -40,2 +41,5 @@",
  " ctx",
  "+added-1",
  "+added-2",
  "+added-3",
  " tail",
  "@@ -200,2 +210,3 @@",
  " z",
  "+added-late",
  " zz"
].join("\n");

function header(lines: string): string[] {
  return lines.split("\n").filter((line) => line.startsWith("@@"));
}

describe("cropPatchToFocusRanges", () => {
  it("keeps only hunks overlapping the focus range and preserves the file header", () => {
    const cropped = cropPatchToFocusRanges(patch, [{ start: 41, end: 45, side: "right" }]);
    expect(cropped.startsWith("diff --git a/src/app.ts b/src/app.ts")).toBe(true);
    expect(header(cropped)).toEqual(["@@ -40,2 +41,5 @@"]);
    expect(cropped).toContain("added-2");
    expect(cropped).not.toContain("import b;");
    expect(cropped).not.toContain("added-late");
  });

  it("keeps multiple hunks when several ranges match", () => {
    const cropped = cropPatchToFocusRanges(patch, [
      { start: 2, end: 2, side: "right" },
      { start: 210, end: 212, side: "right" }
    ]);
    expect(header(cropped)).toEqual(["@@ -1,3 +1,4 @@", "@@ -200,2 +210,3 @@"]);
  });

  it("matches against the old side when the anchor side is left", () => {
    const cropped = cropPatchToFocusRanges(patch, [{ start: 40, end: 41, side: "left" }]);
    expect(header(cropped)).toEqual(["@@ -40,2 +41,5 @@"]);
  });

  it("returns the full patch when no range overlaps (never empty)", () => {
    const cropped = cropPatchToFocusRanges(patch, [{ start: 9000, end: 9001, side: "right" }]);
    expect(cropped).toBe(patch);
  });

  it("returns the patch unchanged when there are no ranges", () => {
    expect(cropPatchToFocusRanges(patch, [])).toBe(patch);
  });
});
