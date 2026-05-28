import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DiffReviewBody } from "../../src/renderer/components/review/DiffReviewBody.js";
import { tabKey, useUiStore, type PrTab } from "../../src/renderer/store/uiStore.js";
import type { PullRequestBundle, RepositoryRef } from "../../src/shared/schemas.js";

vi.mock("../../src/renderer/components/diffs/DiffPanel.js", async () => {
  const React = await import("react");
  return {
    DiffPanel: ({ file }: { file: { path: string } }) =>
      React.createElement("div", { "data-testid": "diff-panel" }, file.path),
    DiffChangeCounts: () => React.createElement("span", null),
    DiffStatusBadge: ({ status }: { status: string }) => React.createElement("span", null, status)
  };
});

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

const originalScrollTo = HTMLElement.prototype.scrollTo;

afterEach(() => {
  HTMLElement.prototype.scrollTo = originalScrollTo;
  useUiStore.setState({ activeView: "search", modal: null, tabs: [], activeTabKey: null, selectedSearchResult: null });
});

describe("DiffReviewBody", () => {
  it("does not reset editor definition targets from an inactive review pane", () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const tab = createTab("/rust/std/src/option.rs");
    useUiStore.setState({
      activeView: "editor",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    render(<DiffReviewBody tab={tab} layout="inline" active={false} />);
    fireEvent.scroll(screen.getByLabelText("Stacked diff"));

    const currentTab = useUiStore.getState().tabs.find((candidate) => candidate.key === tab.key);
    expect(currentTab?.selectedFilePath).toBe("/rust/std/src/option.rs");
    expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();
  });

  it("renders stacked diffs in depth-first tree order", () => {
    HTMLElement.prototype.scrollTo = vi.fn();
    const tab = createTab("src/App.tsx");
    tab.bundle.changedFiles = [
      changedFile("README.md"),
      changedFile("src/App.tsx"),
      changedFile("src/utils/date.ts"),
      changedFile("src/components/index.ts"),
      changedFile("src/components/forms/Input.tsx"),
      changedFile("src/components/Button.tsx"),
      changedFile("src/components/forms/Field.tsx")
    ];

    render(<DiffReviewBody tab={tab} layout="inline" />);

    expect(screen.getAllByTestId("diff-panel").map((panel) => panel.textContent)).toEqual([
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

function createTab(selectedFilePath: string): PrTab {
  const bundle = createBundle();
  return {
    key: tabKey(repository.fullName, bundle.detail.number),
    title: bundle.detail.title,
    repository: repository.fullName,
    number: bundle.detail.number,
    mode: "managed",
    bundle,
    selectedFilePath,
    openFilePaths: ["src/first.rs", selectedFilePath],
    tour: null,
    tourOperationId: null,
    tourProgress: null,
    viewMode: "editor",
    reviewSubMode: "diff",
    checkout: { state: "checked", dismissed: false, message: null, percent: null, operationId: null },
    finish: { open: false, body: "", comments: [] },
    editorNavigationTarget: { path: selectedFilePath, line: 12, requestId: 1 }
  };
}

function createBundle(): PullRequestBundle {
  return {
    mode: "managed",
    detail: {
      provider: "github",
      id: "pr-12",
      number: 12,
      repository,
      title: "Definition selection",
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
      additions: 2,
      deletions: 0,
      changedFileCount: 2,
      commentCount: 0,
      updatedAt: "2026-05-28T00:00:00.000Z",
      createdAt: "2026-05-28T00:00:00.000Z",
      body: "",
      isFromFork: false
    },
    changedFiles: [changedFile("src/first.rs"), changedFile("src/second.rs")],
    timeline: [],
    reviewThreads: [],
    checks: []
  };
}

function changedFile(path: string): PullRequestBundle["changedFiles"][number] {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    language: "rust",
    isLarge: false,
    isGenerated: false,
    reviewStatus: "unreviewed",
    annotations: 0,
    diagnostics: 0
  };
}
