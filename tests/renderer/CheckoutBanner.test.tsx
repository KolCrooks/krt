import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckoutBanner } from "../../src/renderer/components/review/CheckoutBanner.js";
import { useUiStore } from "../../src/renderer/store/uiStore.js";
import type { PullRequestBundle, RepositoryRef } from "../../src/shared/schemas.js";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

const originalSelectMode = window.krt.repos.selectMode;
const originalCheckoutPullRequest = window.krt.repos.checkoutPullRequest;
const originalProgressSnapshot = window.krt.operations.progressSnapshot;
const originalOnProgress = window.krt.operations.onProgress;

afterEach(() => {
  window.krt.repos.selectMode = originalSelectMode;
  window.krt.repos.checkoutPullRequest = originalCheckoutPullRequest;
  window.krt.operations.progressSnapshot = originalProgressSnapshot;
  window.krt.operations.onProgress = originalOnProgress;
  useUiStore.setState({
    activeView: "search",
    modal: null,
    tabs: [],
    activeTabKey: null,
    selectedSearchResult: null
  });
  vi.restoreAllMocks();
});

describe("CheckoutBanner", () => {
  it("returns to a retryable state when the background checkout operation fails", async () => {
    window.krt.repos.selectMode = vi.fn(async () => ({
      mode: "light" as const,
      reason: "No managed checkout exists for this pull request."
    }));
    window.krt.repos.checkoutPullRequest = vi.fn(async () => ({
      operationId: "checkout-op",
      mode: "managed" as const,
      worktreePath: "/tmp/worktree"
    }));
    window.krt.operations.progressSnapshot = vi.fn(async () => ({
      operationId: "checkout-op",
      phase: "failed",
      message: "Managed checkout failed",
      percent: 70,
      done: true,
      cancelled: false,
      error: "Command failed: git clone\nfatal: could not read Username for 'https://github.com': terminal prompts disabled"
    }));

    useUiStore.getState().openPrTab(createBundle());
    renderWithQuery(<CheckoutHarness />);

    fireEvent.click(await screen.findByRole("button", { name: "Check out branch" }));

    expect(await screen.findByText(/Managed checkout failed: could not read Username/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check out branch" })).toBeEnabled();
    await waitFor(() => {
      expect(useUiStore.getState().tabs[0]?.checkout).toMatchObject({
        state: "idle",
        operationId: null,
        percent: null
      });
    });
  });
});

function CheckoutHarness(): React.JSX.Element | null {
  const tab = useUiStore((state) => state.tabs.find((candidate) => candidate.key === "kol/repo#12") ?? null);
  return tab ? <CheckoutBanner tab={tab} /> : null;
}

function renderWithQuery(element: React.ReactElement): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
  render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

function createBundle(): PullRequestBundle {
  return {
    mode: "light",
    detail: {
      provider: "github",
      id: "pr-12",
      number: 12,
      repository,
      title: "Checkout test",
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
      updatedAt: "2026-05-26T00:00:00.000Z",
      createdAt: "2026-05-26T00:00:00.000Z",
      body: "",
      isFromFork: false
    },
    changedFiles: [
      {
        path: "src/App.tsx",
        status: "modified",
        additions: 1,
        deletions: 0,
        changes: 1,
        language: "typescript",
        isLarge: false,
        isGenerated: false,
        reviewStatus: "unreviewed",
        annotations: 0,
        diagnostics: 0
      }
    ],
    timeline: [],
    reviewThreads: [],
    checks: []
  };
}
