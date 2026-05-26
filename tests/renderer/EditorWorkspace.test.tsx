import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorWorkspace } from "../../src/renderer/components/EditorWorkspace.js";
import type { PrTab } from "../../src/renderer/store/uiStore.js";
import type { LspSession, PullRequestBundle, RepositoryRef } from "../../src/shared/schemas.js";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

const originalStartForWorktree = window.krt.lsp.startForWorktree;
const originalGetSession = window.krt.lsp.getSession;
const originalGetDocumentSymbols = window.krt.lsp.getDocumentSymbols;
const originalLoadWorkspaceTree = window.krt.trees.loadWorkspaceTree;
const originalFileContent = window.krt.pullRequests.fileContent;

afterEach(() => {
  window.krt.lsp.startForWorktree = originalStartForWorktree;
  window.krt.lsp.getSession = originalGetSession;
  window.krt.lsp.getDocumentSymbols = originalGetDocumentSymbols;
  window.krt.trees.loadWorkspaceTree = originalLoadWorkspaceTree;
  window.krt.pullRequests.fileContent = originalFileContent;
});

describe("EditorWorkspace LSP startup", () => {
  it("uses the full workspace file tree instead of the review file tree", async () => {
    const session: LspSession = {
      id: "lsp-session",
      repository,
      headSha: "abc123",
      worktreePath: "/tmp/worktree",
      status: "ready",
      activeExtensions: [],
      unavailableExtensions: [],
      capabilities: [],
      startedAt: "2026-05-26T00:00:00.000Z"
    };
    window.krt.lsp.getSession = vi.fn(async () => null);
    window.krt.lsp.startForWorktree = vi.fn(async () => session);
    window.krt.lsp.getDocumentSymbols = vi.fn(async () => []);
    window.krt.trees.loadWorkspaceTree = async () => ({
      repository,
      headSha: "abc123",
      worktreePath: "/tmp/worktree",
      paths: ["Cargo.toml", "src/App.tsx", "src/lib.rs"]
    });
    window.krt.pullRequests.fileContent = async () => ({
      provider: "github",
      repository,
      path: "src/App.tsx",
      ref: "abc123",
      contents: "export const app = true;\n",
      encoding: "utf-8",
      isLarge: false
    });

    renderWithQuery(<EditorWorkspace tab={createTab()} />);

    expect(await screen.findByText("Workspace files")).toBeInTheDocument();
    expect(await screen.findByText("3")).toBeInTheDocument();
    expect(screen.queryByText("Changed files")).not.toBeInTheDocument();
  });

  it("starts the language server automatically for managed tabs", async () => {
    let started = false;
    const readySession = (input: { repository: RepositoryRef; headSha: string }) => ({
      id: "lsp-session",
      repository: input.repository,
      headSha: input.headSha,
      worktreePath: "/tmp/worktree",
      status: "ready" as const,
      activeExtensions: ["typescript-language-server"],
      unavailableExtensions: [],
      capabilities: ["diagnostics" as const, "hover" as const, "definition" as const, "symbols" as const],
      startedAt: "2026-05-26T00:00:00.000Z"
    });
    const startForWorktree = vi.fn(async (input: { repository: RepositoryRef; headSha: string }) => {
      started = true;
      return readySession(input);
    });
    window.krt.lsp.getSession = vi.fn(async (input: { repository: RepositoryRef; headSha: string }) =>
      started ? readySession(input) : null
    );
    window.krt.lsp.startForWorktree = startForWorktree;
    window.krt.lsp.getDocumentSymbols = vi.fn(async () => []);
    window.krt.trees.loadWorkspaceTree = async () => ({
      repository,
      headSha: "abc123",
      worktreePath: "/tmp/worktree",
      paths: ["src/App.tsx"]
    });
    window.krt.pullRequests.fileContent = async () => ({
      provider: "github",
      repository,
      path: "src/App.tsx",
      ref: "abc123",
      contents: "export const app = true;\n",
      encoding: "utf-8",
      isLarge: false
    });

    renderWithQuery(<EditorWorkspace tab={createTab()} />);

    await waitFor(() => {
      expect(startForWorktree).toHaveBeenCalledWith({ repository, headSha: "abc123", paths: ["src/App.tsx"] });
    });
    expect(screen.queryByRole("button", { name: /start lsp/i })).not.toBeInTheDocument();
    expect(await screen.findByText(/Language server ready/i)).toBeInTheDocument();
    expect(screen.queryByText("Outline")).not.toBeInTheDocument();
    expect(window.krt.lsp.getDocumentSymbols).not.toHaveBeenCalled();
  });

  it("shows current language server activity in the workspace tab bar", async () => {
    const session: LspSession = {
      id: "lsp-session",
      repository,
      headSha: "abc123",
      worktreePath: "/tmp/worktree",
      status: "ready",
      activeExtensions: ["rust-analyzer"],
      unavailableExtensions: [],
      capabilities: ["hover", "definition", "symbols"],
      startedAt: "2026-05-26T00:00:00.000Z",
      activity: {
        extensionId: "rust-analyzer",
        title: "loading workspace",
        message: "cargo metadata",
        percentage: 42,
        updatedAt: "2026-05-26T00:00:01.000Z"
      },
      serverStatus: {
        extensionId: "rust-analyzer",
        health: "ok",
        quiescent: false,
        message: "loading workspace",
        updatedAt: "2026-05-26T00:00:01.000Z"
      }
    };
    window.krt.lsp.getSession = vi.fn(async () => session);
    window.krt.lsp.startForWorktree = vi.fn(async () => session);
    window.krt.lsp.getDocumentSymbols = vi.fn(async () => []);
    window.krt.trees.loadWorkspaceTree = async () => ({
      repository,
      headSha: "abc123",
      worktreePath: "/tmp/worktree",
      paths: ["src/App.tsx"]
    });
    window.krt.pullRequests.fileContent = async () => ({
      provider: "github",
      repository,
      path: "src/App.tsx",
      ref: "abc123",
      contents: "export const app = true;\n",
      encoding: "utf-8",
      isLarge: false
    });

    renderWithQuery(<EditorWorkspace tab={createTab()} />);

    expect(await screen.findByText("rust-analyzer loading workspace cargo metadata 42%")).toBeInTheDocument();
    expect(await screen.findByText("rust-analyzer")).toBeInTheDocument();
    expect(await screen.findByText(/Working - loading workspace cargo metadata 42%/i)).toBeInTheDocument();
    expect(await screen.findByText(/Language server loading workspace cargo metadata 42%/i)).toBeInTheDocument();
  });

  it("summarizes multiple active language servers in the workspace tab bar", async () => {
    const session: LspSession = {
      id: "lsp-session",
      repository,
      headSha: "abc123",
      worktreePath: "/tmp/worktree",
      status: "ready",
      activeExtensions: ["rust-analyzer", "gopls"],
      unavailableExtensions: [],
      capabilities: ["hover", "definition", "symbols"],
      startedAt: "2026-05-26T00:00:00.000Z"
    };
    window.krt.lsp.getSession = vi.fn(async () => session);
    window.krt.lsp.startForWorktree = vi.fn(async () => session);
    window.krt.lsp.getDocumentSymbols = vi.fn(async () => []);
    window.krt.trees.loadWorkspaceTree = async () => ({
      repository,
      headSha: "abc123",
      worktreePath: "/tmp/worktree",
      paths: ["src/App.tsx"]
    });
    window.krt.pullRequests.fileContent = async () => ({
      provider: "github",
      repository,
      path: "src/App.tsx",
      ref: "abc123",
      contents: "export const app = true;\n",
      encoding: "utf-8",
      isLarge: false
    });

    renderWithQuery(<EditorWorkspace tab={createTab()} />);

    expect(await screen.findByText("2 LSPs ready")).toBeInTheDocument();
    expect(await screen.findByText("rust-analyzer")).toBeInTheDocument();
    expect(await screen.findByText("gopls")).toBeInTheDocument();
    expect(await screen.findByText(/Language server 2 LSPs ready/i)).toBeInTheDocument();
  });

  it("only mounts the selected file view when multiple file tabs are open", async () => {
    const session: LspSession = {
      id: "lsp-session",
      repository,
      headSha: "abc123",
      worktreePath: "/tmp/worktree",
      status: "ready",
      activeExtensions: ["rust-analyzer"],
      unavailableExtensions: [],
      capabilities: ["hover", "definition", "symbols"],
      startedAt: "2026-05-26T00:00:00.000Z"
    };
    window.krt.lsp.getSession = vi.fn(async () => session);
    window.krt.lsp.startForWorktree = vi.fn(async () => session);
    window.krt.lsp.getDocumentSymbols = vi.fn(async () => []);
    window.krt.trees.loadWorkspaceTree = async () => ({
      repository,
      headSha: "abc123",
      worktreePath: "/tmp/worktree",
      paths: ["Cargo.lock", "src/App.tsx", "src/lib.rs"]
    });
    window.krt.pullRequests.fileContent = vi.fn(async (input) => ({
      provider: "github" as const,
      repository,
      path: input.path,
      ref: "abc123",
      contents: `${input.path}\n`,
      encoding: "utf-8" as const,
      isLarge: false
    }));

    renderWithQuery(
      <EditorWorkspace
        tab={{
          ...createTab(),
          selectedFilePath: "src/lib.rs",
          openFilePaths: ["src/App.tsx", "src/lib.rs", "Cargo.lock"]
        }}
      />
    );

    await waitFor(() => {
      expect(window.krt.pullRequests.fileContent).toHaveBeenCalledTimes(1);
    });
    expect(window.krt.pullRequests.fileContent).toHaveBeenCalledWith(
      expect.objectContaining({ path: "src/lib.rs" })
    );
  });
});

function renderWithQuery(element: React.ReactElement): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
  render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

function createTab(): PrTab {
  const bundle = createBundle();
  return {
    key: "kol/repo#12",
    title: bundle.detail.title,
    repository: repository.fullName,
    number: bundle.detail.number,
    mode: "managed",
    bundle,
    selectedFilePath: "src/App.tsx",
    openFilePaths: ["src/App.tsx"],
    tour: null,
    viewMode: "editor",
    reviewSubMode: "diff",
    checkout: { state: "checked", dismissed: false, message: null, percent: null, operationId: null },
    finish: { open: false, body: "", comments: [] }
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
      title: "Managed editor",
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
