import { describe, expect, it } from "vitest";
import { findDiffSearchMatches } from "../../src/renderer/components/diffs/DiffSearchBar.js";
import type { ChangedFile } from "../../src/shared/schemas.js";

describe("findDiffSearchMatches", () => {
  it("finds path and patch matches with diff-side line targets", () => {
    const file = changedFile("src/lib.rs");
    const matches = findDiffSearchMatches(
      [file],
      new Map([
        [
          file.path,
          [
            "diff --git a/src/lib.rs b/src/lib.rs",
            "--- a/src/lib.rs",
            "+++ b/src/lib.rs",
            "@@ -10,3 +10,4 @@",
            " context needle",
            "-old needle",
            "+new needle",
            "+other",
            ""
          ].join("\n")
        ]
      ]),
      "needle"
    );

    expect(matches).toEqual([
      expect.objectContaining({
        path: "src/lib.rs",
        lineNumber: 11,
        side: "left",
        preview: "old needle",
        matchStart: 4,
        matchLength: 6
      }),
      expect.objectContaining({
        path: "src/lib.rs",
        lineNumber: 11,
        side: "right",
        preview: "new needle",
        matchStart: 4,
        matchLength: 6
      })
    ]);

    expect(findDiffSearchMatches([file], new Map(), "lib.rs")).toEqual([
      expect.objectContaining({
        id: "src/lib.rs:path",
        path: "src/lib.rs",
        lineNumber: null,
        side: "right"
      })
    ]);
  });
});

function changedFile(path: string): ChangedFile {
  return {
    path,
    status: "modified",
    additions: 2,
    deletions: 1,
    changes: 3,
    isLarge: false,
    isGenerated: false,
    reviewStatus: "unreviewed",
    annotations: 0,
    diagnostics: 0
  };
}
