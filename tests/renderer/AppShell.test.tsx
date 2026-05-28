import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../src/renderer/components/AppShell.js";
import { useUiStore } from "../../src/renderer/store/uiStore.js";
import type {
  ManagedWorktree,
  PullRequestBundle,
} from "../../src/shared/schemas.js";

const originalListManagedWorktrees = window.krt.repos.listManagedWorktrees;
const originalOpenPullRequest = window.krt.pullRequests.open;
const originalFilePatch = window.krt.pullRequests.filePatch;
const originalStartLsp = window.krt.lsp.startForWorktree;
const originalStopLsp = window.krt.lsp.stopForWorktree;
const originalOnCloseSubTab = window.krt.app.onCloseSubTab;
const originalScrollTo = HTMLElement.prototype.scrollTo;

afterEach(() => {
  window.krt.app.onCloseSubTab = originalOnCloseSubTab;
  window.krt.repos.listManagedWorktrees = originalListManagedWorktrees;
  window.krt.pullRequests.open = originalOpenPullRequest;
  window.krt.pullRequests.filePatch = originalFilePatch;
  window.krt.lsp.startForWorktree = originalStartLsp;
  window.krt.lsp.stopForWorktree = originalStopLsp;
  HTMLElement.prototype.scrollTo = originalScrollTo;
  useUiStore.setState({
    activeView: "search",
    modal: null,
    tabs: [],
    activeTabKey: null,
    selectedSearchResult: null,
  });
});

describe("AppShell", () => {
  it("renders the review workspace shell at the search surface", async () => {
    render(<AppShell />);

    expect(screen.getByLabelText("Current workspace")).toHaveTextContent("KRT");
    expect(screen.getByLabelText("Pull request search")).toBeInTheDocument();
    expect(
      await screen.findByLabelText("Pull request results"),
    ).toBeInTheDocument();
  });

  it("applies persisted appearance settings to the document root", async () => {
    render(<AppShell />);

    await waitFor(() => {
      expect(document.documentElement).toHaveAttribute("data-theme", "light");
      expect(document.documentElement).toHaveAttribute(
        "data-density",
        "compact",
      );
    });
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe(
      "#4f46e5",
    );
  });

  it("opens tabs for checked out branches on startup", async () => {
    const first = worktreeFixture({
      number: 12,
      headSha: "abc123def456",
      title: "Add branch list",
    });
    const second = worktreeFixture({
      number: 13,
      headSha: "def456abc123",
      headRef: "feature/other",
      title: "Other branch",
    });
    window.krt.repos.listManagedWorktrees = vi.fn(async () => [first, second]);
    window.krt.pullRequests.open = vi.fn(async (input: { number: number }) =>
      input.number === first.number
        ? bundleFixture(first)
        : bundleFixture(second),
    );

    render(<AppShell />);

    await waitFor(() => {
      expect(window.krt.pullRequests.open).toHaveBeenCalledTimes(2);
    });
    expect(window.krt.pullRequests.open).toHaveBeenCalledWith({
      repository: first.repository,
      number: first.number,
      preferredMode: "managed",
    });
    expect(window.krt.pullRequests.open).toHaveBeenCalledWith({
      repository: second.repository,
      number: second.number,
      preferredMode: "managed",
    });

    await waitFor(() => {
      expect(useUiStore.getState().tabs.map((tab) => tab.number)).toEqual([
        12, 13,
      ]);
    });
    expect(
      screen.getByRole("tab", { name: /#12Add branch list/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("tab", { name: /#13Other branch/i }),
    ).toBeInTheDocument();
    expect(useUiStore.getState().activeTabKey).toBe("kol/repo#12");
  });

  it("closes only the active editor file sub-tab with Cmd+W", () => {
    const worktree = worktreeFixture({
      number: 15,
      headSha: "close123",
      title: "Close file tabs",
    });
    const bundle = bundleFixture(worktree);
    bundle.changedFiles = [
      bundle.changedFiles[0],
      { ...bundle.changedFiles[0], path: "src/main.rs" },
    ];
    const key = "kol/repo#15";
    useUiStore.getState().openPrTab(bundle);
    useUiStore.getState().openFileInTab(key, "src/lib.rs");
    useUiStore.getState().openFileInTab(key, "src/main.rs");
    useUiStore.getState().setTabViewMode(key, "editor");

    render(<AppShell />);

    fireEvent.keyDown(window, { key: "w", metaKey: true });

    expect(
      useUiStore.getState().tabs.find((tab) => tab.key === key),
    ).toMatchObject({
      selectedFilePath: "src/lib.rs",
      openFilePaths: ["src/lib.rs"],
    });

    fireEvent.keyDown(window, { key: "w", metaKey: true });

    expect(
      useUiStore.getState().tabs.find((tab) => tab.key === key),
    ).toMatchObject({
      selectedFilePath: null,
      openFilePaths: [],
    });

    fireEvent.keyDown(window, { key: "w", metaKey: true });

    expect(
      useUiStore.getState().tabs.find((tab) => tab.key === key),
    ).toMatchObject({
      selectedFilePath: null,
      openFilePaths: [],
    });
  });

  it("ignores Cmd+W when the active PR tab is not in a file sub-tab", () => {
    const worktree = worktreeFixture({
      number: 16,
      headSha: "review123",
      title: "Keep review open",
    });
    const bundle = bundleFixture(worktree);
    const key = "kol/repo#16";
    HTMLElement.prototype.scrollTo = vi.fn();
    window.krt.pullRequests.filePatch = vi.fn(async () => ({
      provider: "github" as const,
      repository: worktree.repository,
      pullNumber: worktree.number,
      path: "src/lib.rs",
      patch: "@@ -1,1 +1,1 @@\n-old\n+new",
      headSha: worktree.headSha,
      isLarge: false,
    }));
    useUiStore.getState().openPrTab(bundle);
    useUiStore.getState().openFileInTab(key, "src/lib.rs");
    useUiStore.getState().setTabViewMode(key, "review");

    render(<AppShell />);
    fireEvent.keyDown(window, { key: "w", metaKey: true });

    expect(
      useUiStore.getState().tabs.find((tab) => tab.key === key),
    ).toMatchObject({
      selectedFilePath: "src/lib.rs",
      openFilePaths: ["src/lib.rs"],
      viewMode: "review",
    });
  });

  it("keeps a managed tab language server running across review submodes", async () => {
    const worktree = worktreeFixture({
      number: 14,
      headSha: "lsp123",
      title: "Keep LSP warm",
    });
    const bundle = bundleFixture(worktree);
    HTMLElement.prototype.scrollTo = vi.fn();
    window.krt.pullRequests.filePatch = vi.fn(async () => ({
      provider: "github" as const,
      repository: worktree.repository,
      pullNumber: worktree.number,
      path: "src/lib.rs",
      patch: "@@ -1,1 +1,1 @@\n-old\n+new",
      headSha: worktree.headSha,
      isLarge: false,
    }));
    window.krt.lsp.startForWorktree = vi.fn(async () => ({
      id: "lsp-session",
      repository: worktree.repository,
      headSha: worktree.headSha,
      worktreePath: worktree.worktreePath,
      status: "ready" as const,
      activeExtensions: [],
      unavailableExtensions: [],
      capabilities: ["hover" as const, "definition" as const],
      startedAt: "2026-05-22T00:00:00.000Z",
    }));
    window.krt.lsp.stopForWorktree = vi.fn(async () => null);
    useUiStore.getState().openPrTab(bundle);
    useUiStore.getState().setTabViewMode("kol/repo#14", "review");

    render(<AppShell />);

    await waitFor(() => {
      expect(window.krt.lsp.startForWorktree).toHaveBeenCalledWith({
        repository: worktree.repository,
        headSha: worktree.headSha,
        paths: ["src/lib.rs"],
      });
    });

    await act(async () => {
      useUiStore.getState().setReviewSubMode("kol/repo#14", "tour");
      await Promise.resolve();
      useUiStore.getState().setReviewSubMode("kol/repo#14", "storyboard");
      await Promise.resolve();
    });

    expect(window.krt.lsp.stopForWorktree).not.toHaveBeenCalled();

    await act(async () => {
      useUiStore.getState().closeTab("kol/repo#14");
      await Promise.resolve();
    });

    expect(window.krt.lsp.stopForWorktree).toHaveBeenCalledWith({
      repository: worktree.repository,
      headSha: worktree.headSha,
    });
  });
});

function worktreeFixture(
  overrides: Partial<ManagedWorktree> = {},
): ManagedWorktree {
  return {
    repository: {
      provider: "github",
      owner: "kol",
      name: "repo",
      fullName: "kol/repo",
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
    ...overrides,
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
      isFromFork: false,
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
        diagnostics: 0,
      },
    ],
    timeline: [],
    reviewThreads: [],
    checks: [],
  };
}
