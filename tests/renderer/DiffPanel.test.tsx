import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffPanel } from "../../src/renderer/components/diffs/DiffPanel.js";
import { tabKey, useUiStore, type PrTab } from "../../src/renderer/store/uiStore.js";
import type { ChangedFile, PullRequestBundle, PullRequestDetail, RepositoryRef, TourChapter } from "../../src/shared/schemas.js";

const diffMockState = vi.hoisted(() => ({
  scrollIntoView: vi.fn(),
  processFile: vi.fn((
    patch: string,
    options?: {
      cacheKey?: string;
      oldFile?: { contents: string };
      newFile?: { contents: string };
    }
  ) => {
    const isPartial = !options?.oldFile || !options.newFile;
    const deletionLines = isPartial ? [] : splitTestLines(options.oldFile?.contents ?? "");
    const additionLines = isPartial ? [] : splitTestLines(options.newFile?.contents ?? "");
    return {
      cacheKey: options?.cacheKey ?? "diff",
      name: "src/lib.rs",
      type: "change",
      isPartial,
      deletionLines,
      additionLines,
      splitLineCount: 4,
      unifiedLineCount: 4,
      hunks: [
        {
          collapsedBefore: 0,
          deletionStart: 1,
          deletionCount: isPartial ? 4 : 1,
          deletionLines: 0,
          deletionLineIndex: 0,
          additionStart: 1,
          additionCount: isPartial ? 4 : 1,
          additionLines: 4,
          additionLineIndex: 0,
          hunkContent: isPartial ? [{ type: "context", lines: 4 }] : [{ type: "context", lines: 1, deletionLineIndex: 0, additionLineIndex: 0 }],
          splitLineStart: 0,
          splitLineCount: 4,
          unifiedLineStart: 0,
          unifiedLineCount: 4,
          noEOFCRDeletions: false,
          noEOFCRAdditions: false
        }
      ],
      previewText: patch
    };
  })
}));

vi.mock("@pierre/diffs", () => ({
  processFile: diffMockState.processFile
}));

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");
  return {
    File: () => React.createElement("div"),
    FileDiff: function MockFileDiff({
      fileDiff,
      lineAnnotations,
      options,
      renderAnnotation
    }: {
      fileDiff?: { isPartial?: boolean };
      lineAnnotations?: unknown[];
      options?: {
        onGutterUtilityClick?: (range: unknown) => void;
        onLineSelectionStart?: (range: unknown) => void;
        onLineSelectionChange?: (range: unknown) => void;
        onLineSelectionEnd?: (range: unknown) => void;
        onLineSelected?: (range: unknown) => void;
        onPostRender?: (node: HTMLElement) => void;
      };
      renderAnnotation?: (annotation: unknown) => React.ReactNode;
    }) {
      const hostRef = React.useRef<HTMLDivElement | null>(null);
      React.useEffect(() => {
        const host = hostRef.current;
        if (!host) {
          return;
        }
        const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
        shadow.innerHTML = [
          '<div data-line="3" data-line-type="change-addition"><span>let needle = true;</span></div>',
          '<div data-line="3" data-line-type="change-deletion"><span>let old_value = true;</span></div>'
        ].join("");
        for (const line of Array.from(shadow.querySelectorAll("[data-line]"))) {
          if (line instanceof HTMLElement) {
            line.scrollIntoView = diffMockState.scrollIntoView as Element["scrollIntoView"];
          }
        }
        options?.onPostRender?.(host);
      });
      return React.createElement(
        "div",
        { ref: hostRef, "data-testid": "diff-file-view-host" },
        React.createElement("span", { "data-testid": "diff-render-mode" }, fileDiff?.isPartial === false ? "full" : "partial"),
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => options?.onGutterUtilityClick?.({ start: 2, end: 3, side: "additions" })
          },
          "Add line comment"
        ),
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => options?.onLineSelectionStart?.({ start: 2, end: 2, side: "additions" })
          },
          "Press line comment"
        ),
        React.createElement(
          "button",
          {
            type: "button",
            onClick: () => {
              options?.onLineSelectionStart?.({ start: 2, end: 2, side: "additions" });
              options?.onLineSelectionChange?.({ start: 2, end: 4, side: "additions" });
              options?.onLineSelectionEnd?.({ start: 2, end: 4, side: "additions" });
            }
          },
          "Drag line comment"
        ),
        ...(lineAnnotations ?? []).map((annotation, index) =>
          React.createElement("div", { key: index, "data-testid": "diff-annotation" }, renderAnnotation?.(annotation))
        )
      );
    },
    useWorkerPool: () => undefined
  };
});

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

const originalFilePatch = window.krt.pullRequests.filePatch;
const originalFileContent = window.krt.pullRequests.fileContent;

afterEach(() => {
  window.krt.pullRequests.filePatch = originalFilePatch;
  window.krt.pullRequests.fileContent = originalFileContent;
  diffMockState.processFile.mockClear();
  diffMockState.scrollIntoView.mockReset();
  useUiStore.setState({ activeView: "search", modal: null, tabs: [], activeTabKey: null, selectedSearchResult: null });
});

describe("DiffPanel review comments", () => {
  it("adds gutter-selected ranges as draft review comments", async () => {
    const tab = createTab();
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: tab.bundle.changedFiles[0].patch ?? "",
      headSha: input.headSha,
      isLarge: false
    }));
    useUiStore.setState({
      activeView: "review",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    renderWithClient(
      <DiffPanel
        tabKey={tab.key}
        pullRequest={tab.bundle.detail}
        file={tab.bundle.changedFiles[0]}
        layout="inline"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add line comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), {
      target: { value: "Please tighten this branch." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }));

    expect(useUiStore.getState().tabs.find((candidate) => candidate.key === tab.key)?.finish.comments).toMatchObject([
      {
        path: "src/lib.rs",
        body: "Please tighten this branch.",
        line: 3,
        side: "right",
        startLine: 2,
        startSide: "right"
      }
    ]);
  });

  it("adds dragged line selections as draft review comments", async () => {
    const tab = createTab();
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: tab.bundle.changedFiles[0].patch ?? "",
      headSha: input.headSha,
      isLarge: false
    }));
    useUiStore.setState({
      activeView: "review",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    renderWithClient(
      <DiffPanel
        tabKey={tab.key}
        pullRequest={tab.bundle.detail}
        file={tab.bundle.changedFiles[0]}
        layout="inline"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Drag line comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Review comment" }), {
      target: { value: "This whole section needs a tighter explanation." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Add to review" }));

    expect(useUiStore.getState().tabs.find((candidate) => candidate.key === tab.key)?.finish.comments).toMatchObject([
      {
        path: "src/lib.rs",
        body: "This whole section needs a tighter explanation.",
        line: 4,
        side: "right",
        startLine: 2,
        startSide: "right"
      }
    ]);
  });

  it("does not show the draft editor until a line selection is released", async () => {
    const tab = createTab();
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: tab.bundle.changedFiles[0].patch ?? "",
      headSha: input.headSha,
      isLarge: false
    }));
    useUiStore.setState({
      activeView: "review",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    renderWithClient(
      <DiffPanel
        tabKey={tab.key}
        pullRequest={tab.bundle.detail}
        file={tab.bundle.changedFiles[0]}
        layout="inline"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Press line comment" }));

    expect(screen.queryByRole("textbox", { name: "Review comment" })).not.toBeInTheDocument();
  });

  it("highlights the active search text inside the selected diff line", async () => {
    const tab = createTab();
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: tab.bundle.changedFiles[0].patch ?? "",
      headSha: input.headSha,
      isLarge: false
    }));
    useUiStore.setState({
      activeView: "review",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    renderWithClient(
      <DiffPanel
        tabKey={tab.key}
        pullRequest={tab.bundle.detail}
        file={tab.bundle.changedFiles[0]}
        layout="inline"
        searchTarget={{ start: 3, end: 3, side: "additions", matchStart: 4, matchLength: 6 }}
      />
    );

    await waitFor(() => {
      const host = screen.getByTestId("diff-file-view-host");
      const mark = host.shadowRoot?.querySelector("mark[data-diff-search-text-match]");
      expect(mark).toHaveTextContent("needle");
      expect(diffMockState.scrollIntoView).toHaveBeenCalledWith({ block: "center", inline: "nearest", behavior: "auto" });
    });
  });

  it("removes pending draft review comments from inline annotations", async () => {
    const tab = createTab();
    tab.finish.comments = [
      {
        id: "draft-review-comment-1",
        path: "src/lib.rs",
        body: "This needs another pass.",
        line: 3,
        side: "right"
      }
    ];
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: tab.bundle.changedFiles[0].patch ?? "",
      headSha: input.headSha,
      isLarge: false
    }));
    useUiStore.setState({
      activeView: "review",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    renderWithClient(
      <DiffPanel
        tabKey={tab.key}
        pullRequest={tab.bundle.detail}
        file={tab.bundle.changedFiles[0]}
        layout="inline"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Delete draft comment" }));

    expect(useUiStore.getState().tabs.find((candidate) => candidate.key === tab.key)?.finish.comments).toEqual([]);
  });

  it("edits pending draft review comments from inline annotations", async () => {
    const tab = createTab();
    tab.finish.comments = [
      {
        id: "draft-review-comment-1",
        path: "src/lib.rs",
        body: "This needs another pass.",
        line: 3,
        side: "right"
      }
    ];
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: tab.bundle.changedFiles[0].patch ?? "",
      headSha: input.headSha,
      isLarge: false
    }));
    useUiStore.setState({
      activeView: "review",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    renderWithClient(
      <DiffPanel
        tabKey={tab.key}
        pullRequest={tab.bundle.detail}
        file={tab.bundle.changedFiles[0]}
        layout="inline"
      />
    );

    fireEvent.click(await screen.findByRole("button", { name: "Edit draft comment" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Draft review comment" }), {
      target: { value: "This has been tightened after a second pass." }
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(useUiStore.getState().tabs.find((candidate) => candidate.key === tab.key)?.finish.comments[0]).toMatchObject({
      id: "draft-review-comment-1",
      body: "This has been tightened after a second pass.",
      path: "src/lib.rs",
      line: 3
    });
  });

  it("falls back to the patch-only diff when full context has mismatched trailing lines", async () => {
    const tab = createTab();
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: tab.bundle.changedFiles[0].patch ?? "",
      headSha: input.headSha,
      isLarge: false
    }));
    window.krt.pullRequests.fileContent = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      path: input.path,
      ref: input.ref,
      contents: input.ref === "base123" ? "same\nstale trailing old line\n" : "same\n",
      encoding: "utf-8" as const,
      isLarge: false
    }));
    useUiStore.setState({
      activeView: "review",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    renderWithClient(
      <DiffPanel
        tabKey={tab.key}
        pullRequest={tab.bundle.detail}
        file={tab.bundle.changedFiles[0]}
        layout="inline"
      />
    );

    await waitFor(() => {
      expect(diffMockState.processFile.mock.calls.some(([, options]) => Boolean(options?.oldFile && options.newFile))).toBe(true);
    });
    expect(screen.getByTestId("diff-render-mode")).toHaveTextContent("partial");
  });

  it("snaps an out-of-range AI inline comment to the nearest changed line so it still appears", async () => {
    const tab = createTab();
    window.krt.pullRequests.filePatch = vi.fn(async (input) => ({
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.number,
      path: input.path,
      patch: tab.bundle.changedFiles[0].patch ?? "",
      headSha: input.headSha,
      isLarge: false
    }));
    useUiStore.setState({
      activeView: "review",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    const chapter: TourChapter = {
      id: "chapter-1",
      title: "Change",
      summary: "s",
      files: ["src/lib.rs"],
      // startLine 999 is far outside the diff hunks — without snapping the comment vanishes.
      diffAnchors: [{ path: "src/lib.rs", startLine: 999, side: "right", note: "primer about the change" }],
      changeStats: { additions: 1, deletions: 0, files: 1 },
      riskLevel: "low",
      riskReasons: [],
      reviewChecklist: [],
      dependencies: [],
      generatedAt: "2026-06-08T00:00:00.000Z",
      model: "m",
      headSha: "abc123"
    };

    renderWithClient(
      <DiffPanel
        tabKey={tab.key}
        pullRequest={tab.bundle.detail}
        file={tab.bundle.changedFiles[0]}
        layout="inline"
        tourChapters={[chapter]}
      />
    );

    expect(await screen.findByText(/primer about the change/)).toBeInTheDocument();
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

function createTab(): PrTab {
  const bundle = createBundle();
  return {
    key: tabKey(repository.fullName, bundle.detail.number),
    title: bundle.detail.title,
    repository: repository.fullName,
    number: bundle.detail.number,
    mode: "managed",
    bundle,
    selectedFilePath: "src/lib.rs",
    openFilePaths: [],
    tour: null,
    tourOperationId: null,
    tourProgress: null,
    viewMode: "review",
    reviewSubMode: "diff",
    checkout: { state: "checked", dismissed: false, message: null, percent: null, operationId: null },
    finish: { open: false, body: "", comments: [] },
    editorNavigationTarget: null
  };
}

function createBundle(): PullRequestBundle {
  const detail: PullRequestDetail = {
    provider: "github",
    id: "pr-12",
    number: 12,
    repository,
    title: "Diff comments",
    state: "open",
    draft: false,
    url: "https://github.com/kol/repo/pull/12",
    author: { login: "kol" },
    labels: [],
    reviewers: [],
    baseRef: "main",
    headRef: "feature",
    headSha: "abc123",
    baseSha: "base123",
    additions: 1,
    deletions: 0,
    changedFileCount: 1,
    commentCount: 0,
    updatedAt: "2026-05-28T00:00:00.000Z",
    createdAt: "2026-05-28T00:00:00.000Z",
    body: "",
    isFromFork: false
  };
  return {
    mode: "managed",
    detail,
    changedFiles: [changedFile()],
    timeline: [],
    reviewThreads: [],
    checks: []
  };
}

function changedFile(): ChangedFile {
  return {
    path: "src/lib.rs",
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: "@@ -1,4 +1,4 @@\n fn one() {}\n fn two() {}\n fn three() {}\n fn four() {}\n",
    language: "rust",
    isLarge: false,
    isGenerated: false,
    reviewStatus: "unreviewed",
    annotations: 0,
    diagnostics: 0
  };
}

function splitTestLines(contents: string): string[] {
  if (!contents) {
    return [];
  }
  return contents.match(/[^\n]*\n|[^\n]+/g) ?? [];
}
