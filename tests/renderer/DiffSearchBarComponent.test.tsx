import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DiffSearchBar } from "../../src/renderer/components/diffs/DiffSearchBar.js";
import type { ChangedFile, PullRequestDetail, RepositoryRef } from "../../src/shared/schemas.js";

describe("DiffSearchBar", () => {
  it("opens a floating search popup on Cmd+F and closes on Escape", async () => {
    const onActiveMatch = vi.fn();

    renderDiffSearchBar(onActiveMatch);

    expect(screen.queryByRole("search", { name: "Find in diff" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f", metaKey: true });

    const input = await screen.findByRole("textbox", { name: "Find in diff" });
    expect(screen.getByRole("search", { name: "Find in diff" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "needle" } });

    await waitFor(() => {
      expect(onActiveMatch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          path: "src/lib.rs",
          lineNumber: 1,
          side: "right",
          preview: "new needle"
        })
      );
    });

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("search", { name: "Find in diff" })).not.toBeInTheDocument();
      expect(onActiveMatch).toHaveBeenLastCalledWith(null);
    });
  });
});

function renderDiffSearchBar(onActiveMatch: (match: unknown) => void): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });

  render(
    <QueryClientProvider client={queryClient}>
      <DiffSearchBar pullRequest={pullRequest()} files={[changedFile()]} onActiveMatch={onActiveMatch} />
    </QueryClientProvider>
  );
}

function pullRequest(): PullRequestDetail {
  return {
    provider: "github",
    id: "pr-12",
    number: 12,
    repository,
    title: "Searchable diff",
    state: "open",
    draft: false,
    url: "https://github.com/kol/repo/pull/12",
    author: { login: "kol" },
    labels: [],
    reviewers: [],
    baseRef: "main",
    headRef: "feature/search",
    headSha: "abc123",
    baseSha: "base123",
    additions: 1,
    deletions: 1,
    changedFileCount: 1,
    commentCount: 0,
    updatedAt: "2026-05-22T00:00:00.000Z",
    createdAt: "2026-05-22T00:00:00.000Z",
    body: "",
    isFromFork: false
  };
}

function changedFile(): ChangedFile {
  return {
    path: "src/lib.rs",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: ["@@ -1,1 +1,1 @@", "-old", "+new needle"].join("\n"),
    isLarge: false,
    isGenerated: false,
    reviewStatus: "unreviewed",
    annotations: 0,
    diagnostics: 0
  };
}

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};
