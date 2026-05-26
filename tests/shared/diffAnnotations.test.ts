import { describe, expect, it } from "vitest";
import { buildDiffAnnotations } from "../../src/shared/diffAnnotations.js";
import type { RepositoryRef, ReviewThread, TourChapter } from "../../src/shared/schemas.js";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

describe("buildDiffAnnotations", () => {
  it("maps review threads and AI chapter anchors for the selected file", () => {
    const annotations = buildDiffAnnotations({
      filePath: "src/App.tsx",
      reviewThreads: [
        reviewThread({
          id: "thread-1",
          path: "src/App.tsx",
          line: 4,
          resolved: false,
          body: "Keep this path API-backed before checkout."
        }),
        reviewThread({
          id: "thread-2",
          path: "src/Other.ts",
          line: 1,
          resolved: true,
          body: "Different file."
        })
      ],
      tourChapters: [
        tourChapter({
          id: "chapter-1",
          title: "Workspace shell",
          summary: "Review state and editor state share the selected file.",
          diffAnchors: [{ path: "src/App.tsx", startLine: 12, endLine: 14, side: "right" }],
          files: ["src/App.tsx"],
          riskLevel: "medium"
        }),
        tourChapter({
          id: "chapter-2",
          title: "Other file",
          summary: "Not selected.",
          diffAnchors: [{ path: "src/Other.ts", side: "right" }],
          files: ["src/Other.ts"],
          riskLevel: "low"
        })
      ]
    });

    expect(annotations).toEqual([
      expect.objectContaining({
        id: "review:thread-1",
        kind: "review",
        line: 4,
        status: "open",
        body: "Keep this path API-backed before checkout."
      }),
      expect.objectContaining({
        id: "ai:chapter-1:12:0",
        kind: "ai",
        line: 12,
        endLine: 14,
        status: "medium",
        title: "AI: Workspace shell"
      })
    ]);
  });

  it("falls back to file-level AI notes when a chapter references a file without anchors", () => {
    const annotations = buildDiffAnnotations({
      filePath: "src/App.tsx",
      tourChapters: [
        tourChapter({
          id: "chapter-1",
          title: "File-level note",
          summary: "The chapter has file membership but no exact line.",
          diffAnchors: [],
          files: ["src/App.tsx"],
          riskLevel: "high"
        })
      ]
    });

    expect(annotations).toEqual([
      expect.objectContaining({
        id: "ai:chapter-1:file:0",
        kind: "ai",
        line: undefined,
        side: "right",
        status: "high"
      })
    ]);
  });
});

function reviewThread(overrides: {
  id: string;
  path: string;
  line: number;
  resolved: boolean;
  body: string;
}): ReviewThread {
  return {
    id: overrides.id,
    provider: "github",
    repository,
    pullNumber: 12,
    path: overrides.path,
    line: overrides.line,
    resolved: overrides.resolved,
    outdated: false,
    comments: [
      {
        id: `${overrides.id}-comment`,
        threadId: overrides.id,
        author: { login: "alex" },
        body: overrides.body,
        path: overrides.path,
        line: overrides.line,
        side: "right",
        createdAt: "2026-05-22T00:00:00.000Z",
        isBot: false,
        reactions: []
      }
    ]
  };
}

function tourChapter(overrides: Pick<TourChapter, "id" | "title" | "summary" | "diffAnchors" | "files" | "riskLevel">): TourChapter {
  return {
    ...overrides,
    changeStats: { additions: 1, deletions: 0, files: overrides.files.length },
    riskReasons: [],
    reviewChecklist: [],
    dependencies: [],
    generatedAt: "2026-05-22T00:00:00.000Z",
    model: "test",
    headSha: "abc123"
  };
}
