import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoTour } from "../../src/renderer/hooks/useAutoTour.js";
import { tabKey, useUiStore, type PrTab } from "../../src/renderer/store/uiStore.js";
import type { PullRequestBundle, RepositoryRef, ReviewTour } from "../../src/shared/schemas.js";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

const originalStartTourGeneration = window.krt.ai.startTourGeneration;

afterEach(() => {
  cleanup();
  window.krt.ai.startTourGeneration = originalStartTourGeneration;
  useUiStore.setState({ activeView: "search", modal: null, tabs: [], activeTabKey: null, selectedSearchResult: null });
});

describe("useAutoTour", () => {
  it("stops reporting generation when progress has failed", () => {
    renderWithClient(<AutoTourProbe tab={createTab()} />);

    expect(screen.getByTestId("auto-tour-state")).toHaveTextContent("failed");
  });

  it("defers generation and asks for checkout when the PR is not checked out", async () => {
    const tab: PrTab = {
      ...createIdleTab(),
      mode: "light",
      checkout: { state: "idle", dismissed: false, message: null, percent: null, operationId: null }
    };
    const startSpy = vi.fn(async () => ({ operationId: "should-not-run", cachedTour: null }));
    window.krt.ai.startTourGeneration = startSpy;
    useUiStore.setState({ activeView: "review", modal: null, tabs: [tab], activeTabKey: tab.key, selectedSearchResult: null });

    renderWithClient(<CheckoutProbe tabKey={tab.key} />);

    await waitFor(() => {
      expect(screen.getByTestId("auto-tour-needs-checkout")).toHaveTextContent("yes");
    });
    expect(screen.getByTestId("auto-tour-state")).toHaveTextContent("idle");
    expect(startSpy).not.toHaveBeenCalled();
  });

  it("stops reporting generation after a cached tour is loaded", async () => {
    const tab = createIdleTab();
    window.krt.ai.startTourGeneration = vi.fn(async () => ({
      operationId: "cached-tour-op",
      cachedTour: createTour(tab.bundle)
    }));
    useUiStore.setState({
      activeView: "review",
      modal: null,
      tabs: [tab],
      activeTabKey: tab.key,
      selectedSearchResult: null
    });

    renderWithClient(<StoreAutoTourProbe tabKey={tab.key} />);

    await waitFor(() => {
      expect(screen.getByTestId("auto-tour-tab")).toHaveTextContent("cached-tour");
      expect(screen.getByTestId("auto-tour-state")).toHaveTextContent("idle");
    });
  });
});

function AutoTourProbe({ tab }: { tab: PrTab }): React.JSX.Element {
  const auto = useAutoTour(tab);
  return <span data-testid="auto-tour-state">{auto.isGenerating ? "spinning" : auto.hasFailed ? "failed" : "idle"}</span>;
}

function StoreAutoTourProbe({ tabKey: key }: { tabKey: string }): React.JSX.Element | null {
  const tab = useUiStore((state) => state.tabs.find((candidate) => candidate.key === key) ?? null);
  if (!tab) {
    return null;
  }
  const auto = useAutoTour(tab);
  return (
    <>
      <span data-testid="auto-tour-state">{auto.isGenerating ? "spinning" : auto.hasFailed ? "failed" : "idle"}</span>
      <span data-testid="auto-tour-tab">{tab.tour?.id ?? "no-tour"}</span>
    </>
  );
}

function CheckoutProbe({ tabKey: key }: { tabKey: string }): React.JSX.Element | null {
  const tab = useUiStore((state) => state.tabs.find((candidate) => candidate.key === key) ?? null);
  if (!tab) {
    return null;
  }
  const auto = useAutoTour(tab);
  return (
    <>
      <span data-testid="auto-tour-state">{auto.isGenerating ? "spinning" : auto.hasFailed ? "failed" : "idle"}</span>
      <span data-testid="auto-tour-needs-checkout">{auto.needsCheckout ? "yes" : "no"}</span>
    </>
  );
}

function renderWithClient(element: React.ReactElement): void {
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
    key: tabKey(repository.fullName, bundle.detail.number),
    title: bundle.detail.title,
    repository: repository.fullName,
    number: bundle.detail.number,
    mode: "managed",
    bundle,
    selectedFilePath: null,
    openFilePaths: [],
    tour: null,
    tourOperationId: "tour-op-1",
    tourProgress: {
      operationId: "tour-op-1",
      phase: "failed",
      message: "Storyboard generation failed.",
      percent: 42,
      done: true,
      cancelled: false
    },
    viewMode: "review",
    reviewSubMode: "storyboard",
    checkout: { state: "checked", dismissed: false, message: null, percent: null, operationId: null },
    finish: { open: false, body: "", comments: [] },
    editorNavigationTarget: null
  };
}

function createIdleTab(): PrTab {
  const bundle = createBundle();
  return {
    key: tabKey(repository.fullName, bundle.detail.number),
    title: bundle.detail.title,
    repository: repository.fullName,
    number: bundle.detail.number,
    mode: "managed",
    bundle,
    selectedFilePath: null,
    openFilePaths: [],
    tour: null,
    tourOperationId: null,
    tourProgress: null,
    viewMode: "review",
    reviewSubMode: "tour",
    checkout: { state: "checked", dismissed: false, message: null, percent: null, operationId: null },
    finish: { open: false, body: "", comments: [] },
    editorNavigationTarget: null
  };
}

function createTour(bundle: PullRequestBundle): ReviewTour {
  return {
    id: "cached-tour",
    provider: "github",
    repository,
    pullNumber: bundle.detail.number,
    headSha: bundle.detail.headSha,
    generatedAt: "2026-06-08T00:00:00.000Z",
    model: "test",
    chapters: [
      {
        id: "chapter-1",
        title: "Cached chapter",
        summary: "Cached tour chapter.",
        files: [],
        diffAnchors: [],
        changeStats: { additions: 1, deletions: 0, files: 1 },
        riskLevel: "low",
        riskReasons: [],
        reviewChecklist: [],
        dependencies: [],
        generatedAt: "2026-06-08T00:00:00.000Z",
        model: "test",
        headSha: bundle.detail.headSha
      }
    ],
    graph: {
      nodes: [{ id: "chapter-1", label: "Cached chapter", riskLevel: "low", files: [] }],
      edges: []
    },
    riskSignals: []
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
      title: "Storyboard failure",
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
    },
    changedFiles: [],
    timeline: [],
    reviewThreads: [],
    checks: []
  };
}
