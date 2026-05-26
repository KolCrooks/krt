// @vitest-environment node
import { describe, expect, it } from "vitest";
import { changedFilesToMetadata, changedFilesToTreePaths, orderChangedFilesDepthFirst } from "../../src/shared/treeModel.js";
import type { ChangedFile } from "../../src/shared/schemas.js";

const files: ChangedFile[] = [
  {
    path: "src/b.ts",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    isLarge: false,
    isGenerated: false,
    reviewStatus: "commented",
    annotations: 2,
    diagnostics: 0
  },
  {
    path: "src/a.ts",
    status: "added",
    additions: 4,
    deletions: 0,
    changes: 4,
    isLarge: false,
    isGenerated: false,
    reviewStatus: "unreviewed",
    annotations: 0,
    diagnostics: 1
  }
];

describe("tree model helpers", () => {
  it("uses canonical paths as sorted public tree ids", () => {
    expect(changedFilesToTreePaths(files)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("preserves review metadata keyed by path", () => {
    expect(changedFilesToMetadata(files, ["src/b.ts"])).toContainEqual({
      path: "src/b.ts",
      gitStatus: "modified",
      reviewStatus: "commented",
      annotations: 2,
      diagnostics: 0,
      isChangedInPr: true,
      isOpenInEditor: true
    });
  });

  it("orders changed files depth-first by tree position", () => {
    const unorderedFiles = [
      changedFile("README.md"),
      changedFile("src/App.tsx"),
      changedFile("src/utils/date.ts"),
      changedFile("src/components/index.ts"),
      changedFile("src/components/forms/Input.tsx"),
      changedFile("src/components/Button.tsx"),
      changedFile("src/components/forms/Field.tsx")
    ];

    expect(orderChangedFilesDepthFirst(unorderedFiles).map((file) => file.path)).toEqual([
      "src/components/forms/Field.tsx",
      "src/components/forms/Input.tsx",
      "src/components/Button.tsx",
      "src/components/index.ts",
      "src/utils/date.ts",
      "src/App.tsx",
      "README.md"
    ]);
  });
});

function changedFile(path: string): ChangedFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    isLarge: false,
    isGenerated: false,
    reviewStatus: "unreviewed",
    annotations: 0,
    diagnostics: 0
  };
}
