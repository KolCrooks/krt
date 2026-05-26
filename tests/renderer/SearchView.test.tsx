import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchView } from "../../src/renderer/components/SearchView.js";
import { useUiStore } from "../../src/renderer/store/uiStore.js";
import type { ManagedWorktree, PullRequestBundle } from "../../src/shared/schemas.js";

const originalListManagedWorktrees = window.krt.repos.listManagedWorktrees;
const originalDeleteWorktree = window.krt.repos.deleteWorktree;
const originalStartOpen = window.krt.pullRequests.startOpen;
const originalOpenResult = window.krt.pullRequests.openResult;

afterEach(() => {
  window.krt.repos.listManagedWorktrees = originalListManagedWorktrees;
  window.krt.repos.deleteWorktree = originalDeleteWorktree;
  window.krt.pullRequests.startOpen = originalStartOpen;
  window.krt.pullRequests.openResult = originalOpenResult;
  useUiStore.setState({ activeView: "search", modal: null, tabs: [], activeTabKey: null, selectedSearchResult: null });
});

describe("SearchView", () => {
  it("renders checked out branches and deletes a managed worktree", async () => {
    const worktree = worktreeFixture();
    window.krt.repos.listManagedWorktrees = vi.fn(async () => [worktree]);
    window.krt.repos.deleteWorktree = vi.fn(async () => ({ deleted: true, worktree }));

    renderSearchView();

    expect(await screen.findByText("Checked out branches")).toBeInTheDocument();
    expect(await screen.findByText("feature/branch-list")).toBeInTheDocument();
    expect(screen.getByText("Add branch list")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    await waitFor(() => {
      expect(window.krt.repos.deleteWorktree).toHaveBeenCalledWith({
        repository: worktree.repository,
        number: 12,
        headSha: "abc123def456"
      });
    });
  });

  it("keeps delete loading state on each clicked branch", async () => {
    const first = worktreeFixture({ number: 12, headSha: "abc123def456", headRef: "feature/branch-list" });
    const second = worktreeFixture({ number: 13, headSha: "def456abc123", headRef: "feature/other-branch" });
    let resolveFirst: (() => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    window.krt.repos.listManagedWorktrees = vi.fn(async () => [first, second]);
    window.krt.repos.deleteWorktree = vi.fn(
      async (input: { number: number }) =>
        new Promise<{ deleted: boolean; worktree: ManagedWorktree | null }>((resolve) => {
          if (input.number === first.number) {
            resolveFirst = () => resolve({ deleted: true, worktree: first });
            return;
          }
          resolveSecond = () => resolve({ deleted: true, worktree: second });
        })
    );

    renderSearchView();

    const deleteButtons = await screen.findAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[0]);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Deleting" })).toHaveLength(1);
    });

    fireEvent.click(deleteButtons[1]);

    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: "Deleting" })).toHaveLength(2);
    });

    resolveFirst?.();
    resolveSecond?.();
  });

  it("opens the pull request for a checked out branch", async () => {
    const worktree = worktreeFixture();
    const bundle = bundleFixture(worktree);
    window.krt.repos.listManagedWorktrees = vi.fn(async () => [worktree]);
    window.krt.pullRequests.startOpen = vi.fn(async () => ({ operationId: "test-open-operation" }));
    window.krt.pullRequests.openResult = vi.fn(async () => bundle);

    renderSearchView();

    fireEvent.click(await screen.findByTitle("Open kol/repo#12"));

    await waitFor(() => {
      expect(window.krt.pullRequests.startOpen).toHaveBeenCalledWith({
        repository: worktree.repository,
        number: 12,
        preferredMode: "auto"
      });
    });
    await waitFor(() => {
      expect(useUiStore.getState().tabs).toHaveLength(1);
    });
    expect(useUiStore.getState().tabs[0]?.bundle).toEqual(bundle);
  });
});

function worktreeFixture(overrides: Partial<ManagedWorktree> = {}): ManagedWorktree {
  return {
    repository: {
      provider: "github",
      owner: "kol",
      name: "repo",
      fullName: "kol/repo"
    },
    number: 12,
    headSha: "abc123def456",
    worktreePath: "/tmp/krt-worktree",
    lastUsedAt: "2026-05-22T00:00:00.000Z",
    active: true,
    sizeBytes: 2048,
    title: "Add branch list",
    headRef: "feature/branch-list",
    baseRef: "main",
    ...overrides
  };
}

function bundleFixture(worktree: ManagedWorktree): PullRequestBundle {
  return {
    mode: "managed",
    detail: {
      provider: "github",
      id: `pr-${worktree.number}`,
      number: worktree.number,
      repository: worktree.repository,
      title: worktree.title ?? "Checked out branch",
      state: "open",
      draft: false,
      url: `https://github.com/${worktree.repository.fullName}/pull/${worktree.number}`,
      author: { login: "kol" },
      labels: [],
      reviewers: [],
      baseRef: worktree.baseRef ?? "main",
      headRef: worktree.headRef ?? "feature",
      headSha: worktree.headSha,
      baseSha: "base123",
      additions: 1,
      deletions: 0,
      changedFileCount: 1,
      commentCount: 0,
      updatedAt: "2026-05-22T00:00:00.000Z",
      createdAt: "2026-05-22T00:00:00.000Z",
      body: "",
      isFromFork: false
    },
    changedFiles: [
      {
        path: "src/lib.rs",
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
      }
    ],
    timeline: [],
    reviewThreads: [],
    checks: []
  };
}

function renderSearchView(): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  render(
    <QueryClientProvider client={queryClient}>
      <SearchView />
    </QueryClientProvider>
  );
}
