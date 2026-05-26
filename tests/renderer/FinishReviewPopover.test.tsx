import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FinishReviewPopover } from "../../src/renderer/components/FinishReviewPopover.js";
import { tabKey, useUiStore, type PrTab } from "../../src/renderer/store/uiStore.js";
import type { PullRequestBundle, PullRequestDetail, RepositoryRef } from "../../src/shared/schemas.js";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

const originalSubmit = window.krt.reviews.submit;

afterEach(() => {
  window.krt.reviews.submit = originalSubmit;
  useUiStore.setState({ activeView: "search", modal: null, tabs: [], activeTabKey: null, selectedSearchResult: null });
});

describe("FinishReviewPopover", () => {
  it("submits pending diff comments with the active review", async () => {
    const tab = createTab();
    window.krt.reviews.submit = vi.fn(async (input) => ({
      id: "review-1",
      provider: "github" as const,
      repository: input.repository,
      pullNumber: input.pullNumber,
      event: input.event,
      body: input.body,
      submittedAt: "2026-05-28T00:00:00.000Z"
    }));
    useUiStore.setState({
      activeView: "review",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    renderWithClient(<FinishReviewPopover tab={tab} onClose={() => undefined} />);

    expect(screen.getByText("1 pending diff comment")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      expect(window.krt.reviews.submit).toHaveBeenCalledWith({
        repository,
        pullNumber: 12,
        event: "comment",
        body: "Summary",
        commitSha: "abc123",
        comments: [
          {
            path: "src/lib.rs",
            body: "Please tighten this branch.",
            line: 3,
            side: "right",
            startLine: 2,
            startSide: "right"
          }
        ]
      });
    });
    expect(useUiStore.getState().tabs.find((candidate) => candidate.key === tab.key)?.finish.comments).toEqual([]);
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
    finish: {
      open: true,
      body: "Summary",
      comments: [
        {
          id: "draft-1",
          path: "src/lib.rs",
          body: "Please tighten this branch.",
          line: 3,
          side: "right",
          startLine: 2,
          startSide: "right"
        }
      ]
    },
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
    changedFiles: [],
    timeline: [],
    reviewThreads: [],
    checks: []
  };
}
