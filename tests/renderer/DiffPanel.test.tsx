import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffPanel } from "../../src/renderer/components/diffs/DiffPanel.js";
import { tabKey, useUiStore, type PrTab } from "../../src/renderer/store/uiStore.js";
import type { ChangedFile, PullRequestBundle, PullRequestDetail, RepositoryRef } from "../../src/shared/schemas.js";

vi.mock("@pierre/diffs", () => ({
  processFile: vi.fn((patch: string, options?: { cacheKey?: string }) => ({
    cacheKey: options?.cacheKey ?? "diff",
    name: "src/lib.rs",
    type: "change",
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    splitLineCount: 4,
    unifiedLineCount: 4,
    hunks: [
      {
        collapsedBefore: 0,
        deletionStart: 1,
        deletionCount: 4,
        deletionLines: 0,
        deletionLineIndex: 0,
        additionStart: 1,
        additionCount: 4,
        additionLines: 4,
        additionLineIndex: 0,
        hunkContent: [{ type: "context", lines: 4 }],
        splitLineStart: 0,
        splitLineCount: 4,
        unifiedLineStart: 0,
        unifiedLineCount: 4,
        noEOFCRDeletions: false,
        noEOFCRAdditions: false
      }
    ],
    previewText: patch
  }))
}));

vi.mock("@pierre/diffs/react", async () => {
  const React = await import("react");
  return {
    File: () => React.createElement("div"),
    FileDiff: ({
      lineAnnotations,
      options,
      renderAnnotation
    }: {
      lineAnnotations?: unknown[];
      options?: {
        onGutterUtilityClick?: (range: unknown) => void;
        onLineSelectionStart?: (range: unknown) => void;
        onLineSelectionChange?: (range: unknown) => void;
        onLineSelectionEnd?: (range: unknown) => void;
        onLineSelected?: (range: unknown) => void;
      };
      renderAnnotation?: (annotation: unknown) => React.ReactNode;
    }) =>
      React.createElement(
        "div",
        null,
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
      ),
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

afterEach(() => {
  window.krt.pullRequests.filePatch = originalFilePatch;
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
