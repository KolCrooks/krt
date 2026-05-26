// @vitest-environment node
import { describe, expect, it } from "vitest";
import { buildPathIndex, buildPathIndexAsync } from "../../src/shared/pathIndex.js";
import type { ChangedFile } from "../../src/shared/schemas.js";

const files: ChangedFile[] = [
  {
    path: "src/review/App.tsx",
    status: "modified",
    additions: 12,
    deletions: 3,
    changes: 15,
    isLarge: false,
    isGenerated: false,
    reviewStatus: "commented",
    annotations: 1,
    diagnostics: 0
  },
  {
    path: "src/review/App.tsx",
    status: "modified",
    additions: 12,
    deletions: 3,
    changes: 15,
    isLarge: false,
    isGenerated: false,
    reviewStatus: "commented",
    annotations: 1,
    diagnostics: 0
  },
  {
    path: "tests/review/App.test.tsx",
    status: "added",
    additions: 20,
    deletions: 0,
    changes: 20,
    isLarge: false,
    isGenerated: false,
    reviewStatus: "unreviewed",
    annotations: 0,
    diagnostics: 2
  }
];

describe("buildPathIndex", () => {
  it("deduplicates and sorts path input while counting directories", () => {
    const index = buildPathIndex({
      paths: ["z/file.ts", "src/app.ts", "src/app.ts", "src/lib/util.ts"]
    });

    expect(index.paths).toEqual(["src/app.ts", "src/lib/util.ts", "z/file.ts"]);
    expect(index.totalFiles).toBe(3);
    expect(index.totalDirectories).toBe(3);
  });

  it("preserves review metadata for changed files", () => {
    const index = buildPathIndex({ changedFiles: files, openEditorPaths: ["src/review/App.tsx"] });

    expect(index.paths).toEqual(["src/review/App.tsx", "tests/review/App.test.tsx"]);
    expect(index.metadata).toContainEqual(
      expect.objectContaining({
        path: "src/review/App.tsx",
        isOpenInEditor: true,
        annotations: 1
      })
    );
  });

  it("prepares bounded path search results", () => {
    const index = buildPathIndex({
      paths: ["src/review/App.tsx", "src/review/Tour.tsx", "tests/review/App.test.tsx"],
      query: "review app",
      maxResults: 1
    });

    expect(index.searchResults).toEqual(["src/review/App.tsx"]);
    expect(index.truncated).toBe(true);
  });

  it("indexes a synthetic 250k-path workspace with bounded search results", () => {
    const paths = Array.from({ length: 250_000 }, (_value, index) => {
      const packageId = String(index % 500).padStart(3, "0");
      const fileId = String(index).padStart(6, "0");
      return `packages/pkg-${packageId}/src/file-${fileId}.ts`;
    });

    const index = buildPathIndex({
      paths,
      query: "pkg-249 src",
      maxResults: 10
    });

    expect(index.totalFiles).toBe(250_000);
    expect(index.totalDirectories).toBe(1_001);
    expect(index.searchResults).toHaveLength(10);
    expect(index.truncated).toBe(true);
  });

  it("reports async indexing progress for large path sets", async () => {
    const progress: string[] = [];
    const index = await buildPathIndexAsync(
      {
        paths: Array.from({ length: 5_000 }, (_value, fileIndex) => `packages/pkg-${fileIndex % 50}/src/file-${fileIndex}.ts`),
        query: "pkg-10 src",
        maxResults: 5
      },
      {
        yieldEvery: 500,
        onProgress: (nextProgress) => progress.push(nextProgress.phase)
      }
    );

    expect(index.totalFiles).toBe(5_000);
    expect(index.searchResults).toHaveLength(5);
    expect(progress).toContain("directories");
    expect(progress).toContain("search");
    expect(progress.at(-1)).toBe("complete");
  });

  it("cancels async indexing through an abort signal", async () => {
    const controller = new AbortController();
    const promise = buildPathIndexAsync(
      {
        paths: Array.from({ length: 20_000 }, (_value, fileIndex) => `packages/pkg-${fileIndex % 100}/src/file-${fileIndex}.ts`)
      },
      {
        yieldEvery: 100,
        signal: controller.signal,
        onProgress: (nextProgress) => {
          if (nextProgress.phase === "directories" && nextProgress.processed >= 100) {
            controller.abort();
          }
        }
      }
    );

    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
  });
});
