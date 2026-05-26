import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PullRequestOverview } from "../../src/renderer/components/PullRequestOverview.js";
import { tabKey, useUiStore } from "../../src/renderer/store/uiStore.js";
import type { PullRequestBundle } from "../../src/shared/schemas.js";

const fileDiffRenderSpy = vi.hoisted(() => vi.fn());

vi.mock("@pierre/diffs", () => {
  const parseMockHunks = (patch: string) => {
    const lines = patch.split("\n");
    const hunks = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index] ?? "");
      if (!match) {
        continue;
      }
      const deletionStart = Number(match[1]);
      const additionStart = Number(match[3]);
      const hunkContent: Array<
        { type: "context"; lines: number } | { type: "change"; deletions: number; additions: number }
      > = [];
      let deletionCount = 0;
      let additionCount = 0;
      let rowIndex = index + 1;
      let pendingChange: { type: "change"; deletions: number; additions: number } | null = null;
      const flushChange = () => {
        if (pendingChange) {
          hunkContent.push(pendingChange);
          pendingChange = null;
        }
      };
      while (rowIndex < lines.length && !/^@@ -/.test(lines[rowIndex] ?? "")) {
        const marker = lines[rowIndex]?.[0] ?? " ";
        if (marker === "+") {
          pendingChange ??= { type: "change", deletions: 0, additions: 0 };
          pendingChange.additions += 1;
          additionCount += 1;
        } else if (marker === "-") {
          pendingChange ??= { type: "change", deletions: 0, additions: 0 };
          pendingChange.deletions += 1;
          deletionCount += 1;
        } else if (!lines[rowIndex]?.startsWith("diff --git") && !lines[rowIndex]?.startsWith("---") && !lines[rowIndex]?.startsWith("+++")) {
          flushChange();
          const previous = hunkContent.at(-1);
          if (previous?.type === "context") {
            previous.lines += 1;
          } else {
            hunkContent.push({ type: "context", lines: 1 });
          }
          deletionCount += 1;
          additionCount += 1;
        }
        rowIndex += 1;
      }
      flushChange();
      hunks.push({
        collapsedBefore: 0,
        deletionStart,
        deletionCount,
        deletionLines: deletionCount,
        deletionLineIndex: 0,
        additionStart,
        additionCount,
        additionLines: additionCount,
        additionLineIndex: 0,
        hunkContent,
        splitLineStart: 0,
        splitLineCount: Math.max(deletionCount, additionCount),
        unifiedLineStart: 0,
        unifiedLineCount: deletionCount + additionCount,
        noEOFCRDeletions: false,
        noEOFCRAdditions: false
      });
    }
    return hunks;
  };
  return {
    processFile: vi.fn((patch: string, options?: { cacheKey?: string }) => {
      return {
        cacheKey: options?.cacheKey ?? "preview",
        name: "src/lib.rs",
        hunks: parseMockHunks(patch),
        previewText: patch
      };
    })
  };
});

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");
  return {
    File: ({ file }: { file: { contents?: string; name: string } }) =>
      React.createElement(
        "div",
        {
          "data-testid": "pierre-file-preview"
        },
        file.contents ?? ""
      ),
    FileDiff: ({
      fileDiff,
      selectedLines,
      options
    }: {
      fileDiff: { previewText?: string };
      selectedLines?: unknown;
      options?: { hunkSeparators?: unknown };
    }) => {
      fileDiffRenderSpy({ options, selectedLines });
      return React.createElement(
        "div",
        {
          "data-testid": "pierre-diff-preview"
        },
        fileDiff.previewText ?? ""
      );
    },
    useWorkerPool: () => null
  };
});

const originalFilePatch = window.krt.pullRequests.filePatch;
const originalFileContent = window.krt.pullRequests.fileContent;

afterEach(() => {
  window.krt.pullRequests.filePatch = originalFilePatch;
  window.krt.pullRequests.fileContent = originalFileContent;
  fileDiffRenderSpy.mockClear();
  useUiStore.setState({ activeView: "search", modal: null, tabs: [], activeTabKey: null, selectedSearchResult: null });
});

describe("PullRequestOverview", () => {
  it("renders review thread markdown as sanitized HTML", () => {
    const bundle = bundleFixture();
    bundle.reviewThreads[0].comments[0].body =
      "<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub>";
    const key = tabKey(bundle.detail.repository.fullName, bundle.detail.number);
    useUiStore.getState().openPrTab(bundle);
    const tab = useUiStore.getState().tabs.find((candidate) => candidate.key === key);
    if (!tab) {
      throw new Error("Expected PR tab to be open.");
    }

    renderWithClient(<PullRequestOverview tab={tab} />);

    const badge = screen.getByAltText("P2 Badge");
    expect(badge.tagName).toBe("IMG");
    expect(badge).toHaveAttribute("src", "https://img.shields.io/badge/P2-yellow?style=flat");
    expect(screen.queryByText(/!\[P2 Badge\]/)).not.toBeInTheDocument();
  });

  it("renders diff comment previews whose headers open the file in the editor", async () => {
    const bundle = bundleFixture();
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: "@@ -1,8 +1,9 @@\n fn before_far() {}\n fn before_near() {}\n pub fn add(a: i32, b: i32) -> i32 {\n+    let sum = a + b;\n+    sum\n-    a + b\n }\n fn after_near() {}\n fn after_far() {}\n fn after_hidden() {}\n@@ -20,3 +21,4 @@\n pub fn sub(a: i32, b: i32) -> i32 {\n+    let difference = a - b;\n     a - b\n }\n",
      headSha: input.headSha,
      isLarge: false
    }));
    const key = tabKey(bundle.detail.repository.fullName, bundle.detail.number);
    useUiStore.getState().openPrTab(bundle);
    const tab = useUiStore.getState().tabs.find((candidate) => candidate.key === key);
    if (!tab) {
      throw new Error("Expected PR tab to be open.");
    }

    renderWithClient(<PullRequestOverview tab={tab} />);

    expect(await screen.findAllByText(/let sum = a \+ b/)).toHaveLength(1);
    expect(screen.getAllByText(/fn before_near/)).toHaveLength(1);
    expect(screen.queryByText(/fn before_far/)).not.toBeInTheDocument();
    expect(screen.queryByText(/fn after_near/)).not.toBeInTheDocument();
    expect(screen.queryByText(/let difference = a - b/)).not.toBeInTheDocument();
    expect(fileDiffRenderSpy.mock.calls.some(([props]) => props.options?.hunkSeparators === "simple")).toBe(true);
    expect(window.krt.pullRequests.filePatch).toHaveBeenCalledWith({
      repository: bundle.detail.repository,
      number: 21,
      path: "src/lib.rs",
      headSha: "abc123"
    });
    const threadPreview = screen.getByLabelText("Diff preview for src/lib.rs line 4");
    const threadDiff = within(threadPreview).getByTestId("pierre-diff-preview");
    const threadHeader = within(threadPreview).getByRole("button", { name: "Open src/lib.rs line 4 in editor" });

    fireEvent.click(threadDiff);
    expect(useUiStore.getState().activeView).toBe("overview");

    fireEvent.click(threadHeader);

    const openedTab = useUiStore.getState().tabs.find((candidate) => candidate.key === key);
    expect(useUiStore.getState().activeView).toBe("editor");
    expect(openedTab).toMatchObject({
      selectedFilePath: "src/lib.rs",
      openFilePaths: ["src/lib.rs"],
      editorNavigationTarget: {
        path: "src/lib.rs",
        line: 4
      }
    });
  });

  it("falls back to historical GitHub hunks for outdated diff comments", async () => {
    const bundle = bundleFixture();
    bundle.timeline = [];
    bundle.reviewThreads = [
      {
        id: "thread-outdated",
        provider: "github",
        repository: bundle.detail.repository,
        pullNumber: 21,
        path: "src/lib.rs",
        resolved: false,
        outdated: true,
        originalLine: 13,
        comments: [
          {
            id: "comment-outdated",
            threadId: "thread-outdated",
            author: { login: "alex" },
            body: "This was on an older diff.",
            path: "src/lib.rs",
            originalLine: 13,
            side: "right",
            diffHunk:
              "@@ -10,6 +10,7 @@\n fn old_before_far() {}\n fn old_before_near() {}\n pub fn add(a: i32, b: i32) -> i32 {\n+    let legacy_sum = a + b;\n+    legacy_sum\n-    a + b\n }\n fn old_after_near() {}\n",
            outdated: true,
            createdAt: "2026-05-22T00:01:00.000Z",
            isBot: false,
            reactions: []
          }
        ]
      }
    ];
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: "@@ -1,2 +1,2 @@\n fn current_only() {}\n+fn unrelated() {}\n",
      headSha: input.headSha,
      isLarge: false
    }));
    const key = tabKey(bundle.detail.repository.fullName, bundle.detail.number);
    useUiStore.getState().openPrTab(bundle);
    const tab = useUiStore.getState().tabs.find((candidate) => candidate.key === key);
    if (!tab) {
      throw new Error("Expected PR tab to be open.");
    }

    renderWithClient(<PullRequestOverview tab={tab} />);

    expect(await screen.findByText(/legacy_sum/)).toBeInTheDocument();
    expect(screen.getByText("outdated")).toBeInTheDocument();
    expect(screen.queryByText("Diff preview unavailable")).not.toBeInTheDocument();
    expect(screen.queryByText(/current_only/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Open src/lib.rs line 13 in editor" }));

    expect(useUiStore.getState().tabs.find((candidate) => candidate.key === key)).toMatchObject({
      selectedFilePath: "src/lib.rs",
      editorNavigationTarget: {
        path: "src/lib.rs",
        line: 13
      }
    });
  });

  it("selects the rendered side when review metadata points at the opposite side", async () => {
    const bundle = bundleFixture();
    bundle.timeline = [];
    bundle.reviewThreads[0].line = 20;
    bundle.reviewThreads[0].side = "left";
    bundle.reviewThreads[0].comments[0].line = 20;
    bundle.reviewThreads[0].comments[0].side = "left";
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: "@@ -1,0 +20,1 @@\n+fn added_only() {}\n",
      headSha: input.headSha,
      isLarge: false
    }));
    const key = tabKey(bundle.detail.repository.fullName, bundle.detail.number);
    useUiStore.getState().openPrTab(bundle);
    const tab = useUiStore.getState().tabs.find((candidate) => candidate.key === key);
    if (!tab) {
      throw new Error("Expected PR tab to be open.");
    }

    renderWithClient(<PullRequestOverview tab={tab} />);

    expect(await screen.findByText(/fn added_only/)).toBeInTheDocument();
    expect(fileDiffRenderSpy.mock.calls.some(([props]) => props.selectedLines?.side === "additions")).toBe(true);
    expect(fileDiffRenderSpy.mock.calls.some(([props]) => props.selectedLines?.side === "deletions")).toBe(false);
  });

  it("renders file-level comments with the first lines from the file", async () => {
    const bundle = bundleFixture();
    bundle.timeline = [];
    bundle.reviewThreads = [
      {
        id: "thread-file",
        provider: "github",
        repository: bundle.detail.repository,
        pullNumber: 21,
        path: "src/lib.rs",
        resolved: false,
        outdated: false,
        comments: [
          {
            id: "comment-file",
            threadId: "thread-file",
            author: { login: "alex" },
            body: "This applies to the whole file.",
            path: "src/lib.rs",
            createdAt: "2026-05-22T00:01:00.000Z",
            isBot: false,
            reactions: []
          }
        ]
      }
    ];
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: "",
      headSha: input.headSha,
      isLarge: false
    }));
    window.krt.pullRequests.fileContent = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      path: input.path,
      ref: input.ref,
      contents: "first line\nsecond line\nthird line\n",
      encoding: "utf-8" as const,
      isLarge: false
    }));
    const key = tabKey(bundle.detail.repository.fullName, bundle.detail.number);
    useUiStore.getState().openPrTab(bundle);
    const tab = useUiStore.getState().tabs.find((candidate) => candidate.key === key);
    if (!tab) {
      throw new Error("Expected PR tab to be open.");
    }

    renderWithClient(<PullRequestOverview tab={tab} />);

    const filePreview = await screen.findByTestId("pierre-file-preview");
    expect(filePreview).toHaveTextContent("first line");
    expect(filePreview).toHaveTextContent("second line");
    expect(filePreview).not.toHaveTextContent("third line");
    expect(screen.queryByText("Diff preview unavailable")).not.toBeInTheDocument();
    expect(window.krt.pullRequests.filePatch).not.toHaveBeenCalled();
    expect(window.krt.pullRequests.fileContent).toHaveBeenCalledWith({
      repository: bundle.detail.repository,
      path: "src/lib.rs",
      ref: "abc123"
    });

    fireEvent.click(screen.getByRole("button", { name: "Open src/lib.rs in editor" }));

    expect(useUiStore.getState().activeView).toBe("editor");
    expect(useUiStore.getState().tabs.find((candidate) => candidate.key === key)).toMatchObject({
      selectedFilePath: "src/lib.rs",
      openFilePaths: ["src/lib.rs"],
      editorNavigationTarget: null
    });
  });
});

function renderWithClient(ui: React.ReactElement): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function bundleFixture(): PullRequestBundle {
  const repository = {
    provider: "github" as const,
    owner: "kol",
    name: "repo",
    fullName: "kol/repo"
  };
  return {
    mode: "managed",
    detail: {
      provider: "github",
      id: "pr-21",
      number: 21,
      repository,
      title: "Improve sum helper",
      state: "open",
      draft: false,
      url: "https://github.com/kol/repo/pull/21",
      author: { login: "kol" },
      labels: [],
      reviewers: [],
      baseRef: "main",
      headRef: "sum-helper",
      headSha: "abc123",
      baseSha: "base123",
      additions: 2,
      deletions: 1,
      changedFileCount: 1,
      commentCount: 1,
      updatedAt: "2026-05-22T00:00:00.000Z",
      createdAt: "2026-05-22T00:00:00.000Z",
      body: "",
      isFromFork: false
    },
    changedFiles: [
      {
        path: "src/lib.rs",
        status: "modified",
        additions: 2,
        deletions: 1,
        changes: 3,
        language: "rust",
        isLarge: false,
        isGenerated: false,
        reviewStatus: "commented",
        annotations: 1,
        diagnostics: 0
      }
    ],
    timeline: [
      {
        id: "review-comment:1",
        kind: "comment",
        actor: { login: "alex" },
        title: "Comment on src/lib.rs",
        body: "Can we keep this readable?",
        createdAt: "2026-05-22T00:01:00.000Z",
        path: "src/lib.rs",
        line: 4,
        side: "right",
        severity: "info",
        reactions: []
      }
    ],
    reviewThreads: [
      {
        id: "thread-1",
        provider: "github",
        repository,
        pullNumber: 21,
        path: "src/lib.rs",
        line: 4,
        resolved: false,
        outdated: false,
        comments: [
          {
            id: "comment-1",
            threadId: "thread-1",
            author: { login: "alex" },
            body: "Can we keep this readable?",
            path: "src/lib.rs",
            line: 4,
            side: "right",
            createdAt: "2026-05-22T00:01:00.000Z",
            isBot: false,
            reactions: []
          }
        ]
      }
    ],
    checks: []
  };
}
