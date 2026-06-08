// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createReviewToolset, describeToolCall, type ReviewRepoAccess, type ReviewToolContext } from "../../../src/main/services/ai/reviewTools.js";
import type { ChangeMap } from "../../../src/main/services/ai/changeMap.js";
import type { ChangedFile, ReviewTour } from "../../../src/shared/schemas.js";

const repository = { provider: "github" as const, owner: "kol", name: "repo", fullName: "kol/repo" };

const changedFiles: ChangedFile[] = [
  { path: "src/App.tsx", status: "modified", additions: 10, deletions: 2, changes: 12, isLarge: false, isGenerated: false, reviewStatus: "unreviewed", annotations: 0, diagnostics: 0 },
  { path: "src/main.tsx", status: "modified", additions: 4, deletions: 0, changes: 4, isLarge: false, isGenerated: false, reviewStatus: "unreviewed", annotations: 0, diagnostics: 0 }
];

function makeToolset(onUpdate: (tour: ReviewTour) => void = () => {}, changeMap?: ChangeMap) {
  const repos = {
    getWorktreePath: () => "/tmp/wt",
    getLocalFileContent: vi.fn(),
    getLocalFilePatch: vi.fn(),
    searchWorkspaceText: vi.fn(),
    loadWorkspaceTree: vi.fn()
  } as unknown as ReviewRepoAccess;
  const ctx: ReviewToolContext = {
    repos,
    repository,
    pullProvider: "github",
    pullNumber: 42,
    headSha: "abc",
    model: "test-model",
    generatedAt: "2026-06-08T00:00:00.000Z",
    changedFiles,
    changeMap,
    onUpdate
  };
  return createReviewToolset(ctx);
}

describe("review toolset accumulator", () => {
  it("derives chapter changeStats from the changed-file metadata", async () => {
    const toolset = makeToolset();
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "Shell", summary: "x", files: ["src/App.tsx", "src/main.tsx"], riskLevel: "low" } });
    const tour = toolset.build();
    expect(tour.chapters[0]?.changeStats).toEqual({ additions: 14, deletions: 2, files: 2 });
  });

  it("rejects an inline comment for an unknown chapter so the model can recover", async () => {
    const toolset = makeToolset();
    const outcome = await toolset.execute({ id: "1", name: "add_inline_comment", arguments: { chapterId: "missing", path: "src/App.tsx", comment: "hi" } });
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("missing");
  });

  it("rejects an edge between chapters that do not exist", async () => {
    const toolset = makeToolset();
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "A", summary: "x", files: ["src/App.tsx"], riskLevel: "low" } });
    const outcome = await toolset.execute({ id: "2", name: "add_edge", arguments: { from: "chapter-1", to: "chapter-9", relation: "dependency" } });
    expect(outcome.isError).toBe(true);
    expect(toolset.build().graph.edges).toEqual([]);
  });

  it("attaches inline comments to the chapter as diff anchors and streams updates", async () => {
    const updates: number[] = [];
    const toolset = makeToolset((tour) => updates.push(tour.chapters.length));
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "A", summary: "x", files: ["src/App.tsx"], riskLevel: "high" } });
    await toolset.execute({ id: "2", name: "add_inline_comment", arguments: { chapterId: "chapter-1", path: "src/App.tsx", startLine: 5, endLine: 8, comment: "guards the write" } });
    const tour = toolset.build();
    const anchor = tour.chapters[0]?.diffAnchors.find((entry) => entry.note === "guards the write");
    expect(anchor).toMatchObject({ path: "src/App.tsx", startLine: 5, endLine: 8, side: "right" });
    expect(updates).toContain(1); // streamed after add_chapter
  });

  it("grounds chapter impact and adds deterministic edges from the change map", async () => {
    const changeMap: ChangeMap = {
      symbols: [{ symbol: "reserve", definedIn: "src/App.tsx", line: 3, referencedBy: ["src/main.tsx", "src/other.ts"] }]
    };
    const toolset = makeToolset(() => {}, changeMap);
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "Primitive", summary: "x", files: ["src/App.tsx"], riskLevel: "low" } });
    await toolset.execute({ id: "2", name: "add_chapter", arguments: { id: "chapter-2", title: "Consumer", summary: "y", files: ["src/main.tsx"], riskLevel: "low" } });
    const tour = toolset.build();

    // chapter-1's impact reflects the external blast radius (src/main.tsx, src/other.ts).
    expect(tour.chapters[0]?.impact?.touchedSymbols).toEqual(["reserve"]);
    expect(tour.chapters[0]?.impact?.blastRadiusFiles.sort()).toEqual(["src/main.tsx", "src/other.ts"]);

    // A deterministic edge connects chapter-1 → chapter-2 because src/main.tsx references reserve.
    const edge = tour.graph.edges.find((entry) => entry.from === "chapter-1" && entry.to === "chapter-2");
    expect(edge).toMatchObject({ source: "deterministic", relation: "dependency" });
  });

  it("answers get_blast_radius from the change map", async () => {
    const changeMap: ChangeMap = {
      symbols: [{ symbol: "reserve", definedIn: "src/App.tsx", line: 3, referencedBy: ["src/main.tsx"] }]
    };
    const toolset = makeToolset(() => {}, changeMap);
    const outcome = await toolset.execute({ id: "1", name: "get_blast_radius", arguments: { path: "src/App.tsx" } });
    expect(outcome.isError).toBeUndefined();
    expect(outcome.content).toContain("reserve");
    expect(outcome.content).toContain("src/main.tsx");
  });

  it("stores inline comment severity and category", async () => {
    const toolset = makeToolset();
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "A", summary: "x", files: ["src/App.tsx"], riskLevel: "low" } });
    await toolset.execute({ id: "2", name: "add_inline_comment", arguments: { chapterId: "chapter-1", path: "src/App.tsx", startLine: 2, comment: "missing null check", severity: "warning", category: "correctness" } });
    const anchor = toolset.build().chapters[0]?.diffAnchors.find((entry) => entry.note === "missing null check");
    expect(anchor).toMatchObject({ severity: "warning", category: "correctness" });
  });

  it("drops dependency ids that do not reference a real chapter", async () => {
    const toolset = makeToolset();
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "A", summary: "x", files: ["src/App.tsx"], riskLevel: "low", dependencies: ["chapter-1", "ghost", "chapter-2"] } });
    await toolset.execute({ id: "2", name: "add_chapter", arguments: { id: "chapter-2", title: "B", summary: "y", files: ["src/main.tsx"], riskLevel: "low" } });
    const tour = toolset.build();
    // Self-reference and unknown "ghost" are removed; the real dependency stays.
    expect(tour.chapters[0]?.dependencies).toEqual(["chapter-2"]);
  });

  it("describes tool calls for the live activity feed", () => {
    expect(describeToolCall({ id: "1", name: "read_file", arguments: { path: "src/App.tsx" } })).toBe("Reading src/App.tsx");
    expect(describeToolCall({ id: "2", name: "search_text", arguments: { query: "reserve" } })).toBe('Searching for "reserve"');
    expect(describeToolCall({ id: "3", name: "add_chapter", arguments: { title: "Foundation" } })).toContain("Foundation");
    expect(describeToolCall({ id: "4", name: "finish", arguments: {} })).toBe("Wrapping up the tour");
  });

  it("marks finish and counts chapters when all files are covered", async () => {
    const toolset = makeToolset();
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "A", summary: "x", files: ["src/App.tsx", "src/main.tsx"], riskLevel: "low" } });
    expect(toolset.chapterCount).toBe(1);
    expect(toolset.finishRequested).toBe(false);
    const result = await toolset.execute({ id: "2", name: "finish", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(toolset.finishRequested).toBe(true);
  });

  it("rejects finish when changed files are not covered by any chapter", async () => {
    const toolset = makeToolset();
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "A", summary: "x", files: ["src/App.tsx"], riskLevel: "low" } });
    const result = await toolset.execute({ id: "2", name: "finish", arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toContain("src/main.tsx");
    expect(toolset.finishRequested).toBe(false);
  });

  it("buildTour auto-assigns uncovered non-generated files to the best-matching chapter", async () => {
    const toolset = makeToolset();
    // chapter-1 only covers App.tsx; main.tsx is left uncovered
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "A", summary: "x", files: ["src/App.tsx"], riskLevel: "low" } });
    const tour = toolset.build();
    // main.tsx shares the "src/" prefix — should be folded into chapter-1
    expect(tour.chapters[0]?.files).toContain("src/main.tsx");
  });

  it("buildTour prefers the chapter with the longest shared directory prefix", async () => {
    const deepChangedFiles: ChangedFile[] = [
      { path: "src/utils/math.ts", status: "modified", additions: 5, deletions: 0, changes: 5, isLarge: false, isGenerated: false, reviewStatus: "unreviewed", annotations: 0, diagnostics: 0 },
      { path: "src/utils/string.ts", status: "modified", additions: 3, deletions: 0, changes: 3, isLarge: false, isGenerated: false, reviewStatus: "unreviewed", annotations: 0, diagnostics: 0 },
      { path: "src/api/routes.ts", status: "modified", additions: 8, deletions: 0, changes: 8, isLarge: false, isGenerated: false, reviewStatus: "unreviewed", annotations: 0, diagnostics: 0 }
    ];
    const repos = { getWorktreePath: () => "/tmp/wt", getLocalFileContent: vi.fn(), getLocalFilePatch: vi.fn(), searchWorkspaceText: vi.fn(), loadWorkspaceTree: vi.fn() } as unknown as ReviewRepoAccess;
    const ctx: ReviewToolContext = { repos, repository, pullProvider: "github", pullNumber: 42, headSha: "abc", model: "test-model", generatedAt: "2026-06-08T00:00:00.000Z", changedFiles: deepChangedFiles, onUpdate: () => {} };
    const toolset = createReviewToolset(ctx);
    // chapter-1 covers utils/math.ts; chapter-2 covers api/routes.ts; utils/string.ts is uncovered
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "Utils", summary: "x", files: ["src/utils/math.ts"], riskLevel: "low" } });
    await toolset.execute({ id: "2", name: "add_chapter", arguments: { id: "chapter-2", title: "API", summary: "y", files: ["src/api/routes.ts"], riskLevel: "low" } });
    const tour = toolset.build();
    // utils/string.ts shares "src/utils" with chapter-1, which is longer than "src" shared with chapter-2
    const utilsChapter = tour.chapters.find((ch) => ch.id === "chapter-1");
    expect(utilsChapter?.files).toContain("src/utils/string.ts");
    const apiChapter = tour.chapters.find((ch) => ch.id === "chapter-2");
    expect(apiChapter?.files).not.toContain("src/utils/string.ts");
  });

  it("allows finish when uncovered files are generated", async () => {
    const generatedChangedFiles: ChangedFile[] = [
      { path: "src/App.tsx", status: "modified", additions: 10, deletions: 2, changes: 12, isLarge: false, isGenerated: false, reviewStatus: "unreviewed", annotations: 0, diagnostics: 0 },
      { path: "src/generated/schema.ts", status: "modified", additions: 50, deletions: 0, changes: 50, isLarge: false, isGenerated: true, reviewStatus: "unreviewed", annotations: 0, diagnostics: 0 }
    ];
    const repos = { getWorktreePath: () => "/tmp/wt", getLocalFileContent: vi.fn(), getLocalFilePatch: vi.fn(), searchWorkspaceText: vi.fn(), loadWorkspaceTree: vi.fn() } as unknown as ReviewRepoAccess;
    const ctx: ReviewToolContext = { repos, repository, pullProvider: "github", pullNumber: 42, headSha: "abc", model: "test-model", generatedAt: "2026-06-08T00:00:00.000Z", changedFiles: generatedChangedFiles, onUpdate: () => {} };
    const toolset = createReviewToolset(ctx);
    await toolset.execute({ id: "1", name: "add_chapter", arguments: { id: "chapter-1", title: "A", summary: "x", files: ["src/App.tsx"], riskLevel: "low" } });
    const result = await toolset.execute({ id: "2", name: "finish", arguments: {} });
    expect(result.isError).toBeFalsy();
    expect(toolset.finishRequested).toBe(true);
  });
});
