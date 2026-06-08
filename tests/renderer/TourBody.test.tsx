import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TourBody } from "../../src/renderer/components/review/TourBody.js";
import { tabKey, useUiStore } from "../../src/renderer/store/uiStore.js";
import type { ChangedFile, PullRequestBundle, RepositoryRef, ReviewTour } from "../../src/shared/schemas.js";

vi.mock("../../src/renderer/components/diffs/DiffPanel.js", async () => {
  const React = await import("react");
  return {
    DiffPanel: ({ file }: { file: { path: string } | null }) =>
      React.createElement("div", { "data-testid": "diff-panel" }, file?.path ?? "")
  };
});

vi.mock("../../src/renderer/components/diffs/DiffSearchBar.js", async () => {
  const React = await import("react");
  return {
    DiffSearchBar: () => React.createElement("div", { role: "search", "aria-label": "Find in diff" })
  };
});

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

afterEach(() => {
  useUiStore.setState({ activeView: "search", modal: null, tabs: [], activeTabKey: null, selectedSearchResult: null });
});

describe("TourBody", () => {
  it("keeps reviewed chapters checked after the tour view remounts", () => {
    const bundle = createBundle();
    const key = tabKey(repository.fullName, bundle.detail.number);
    useUiStore.getState().openPrTab(bundle);
    useUiStore.getState().setTour(key, createTour(bundle));

    const firstRender = renderWithClient(<TourProbe tabKey={key} />);
    fireEvent.click(screen.getAllByRole("checkbox")[0]);

    expect(useUiStore.getState().tabs.find((tab) => tab.key === key)?.reviewedTourChapterIds).toEqual(["chapter-1"]);

    firstRender.unmount();
    renderWithClient(<TourProbe tabKey={key} />);

    expect(screen.getAllByRole("checkbox")[0]).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("1/2 reviewed")).toBeInTheDocument();
  });
});

function TourProbe({ tabKey: key }: { tabKey: string }): React.JSX.Element | null {
  const tab = useUiStore((state) => state.tabs.find((candidate) => candidate.key === key) ?? null);
  return tab ? <TourBody tab={tab} layout="inline" /> : null;
}

function renderWithClient(ui: React.ReactElement): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false }
    }
  });
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

function createTour(bundle: PullRequestBundle): ReviewTour {
  return {
    id: "tour-1",
    provider: "github",
    repository,
    pullNumber: bundle.detail.number,
    headSha: bundle.detail.headSha,
    generatedAt: "2026-06-08T00:00:00.000Z",
    model: "test",
    chapters: [
      chapter("chapter-1", "First chapter", "src/lib.rs", bundle.detail.headSha),
      chapter("chapter-2", "Second chapter", "src/main.rs", bundle.detail.headSha)
    ],
    graph: {
      nodes: [
        { id: "chapter-1", label: "First chapter", riskLevel: "medium", files: ["src/lib.rs"] },
        { id: "chapter-2", label: "Second chapter", riskLevel: "low", files: ["src/main.rs"] }
      ],
      edges: []
    },
    riskSignals: []
  };
}

function chapter(id: string, title: string, path: string, headSha: string): ReviewTour["chapters"][number] {
  return {
    id,
    title,
    summary: `${title} summary.`,
    files: [path],
    diffAnchors: [{ path, side: "right", startLine: 1, endLine: 1 }],
    changeStats: { additions: 1, deletions: 0, files: 1 },
    riskLevel: id === "chapter-1" ? "medium" : "low",
    riskReasons: [],
    reviewChecklist: [`Review ${path}`],
    dependencies: [],
    generatedAt: "2026-06-08T00:00:00.000Z",
    model: "test",
    headSha
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
      title: "Persist tour review checks",
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
      updatedAt: "2026-06-08T00:00:00.000Z",
      createdAt: "2026-06-08T00:00:00.000Z",
      body: "",
      isFromFork: false
    },
    changedFiles: [changedFile("src/lib.rs"), changedFile("src/main.rs")],
    timeline: [],
    reviewThreads: [],
    checks: []
  };
}

function changedFile(path: string): ChangedFile {
  return {
    path,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    isLarge: false,
    isGenerated: false,
    reviewStatus: "unreviewed",
    annotations: 0,
    diagnostics: 0
  };
}
