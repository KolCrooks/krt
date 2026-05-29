import { describe, expect, it } from "vitest";
import { tabKey, useUiStore } from "../../src/renderer/store/uiStore.js";
import type { PullRequestBundle, ReviewThread, ReviewTour } from "../../src/shared/schemas.js";

const bundle = createBundle();
const key = tabKey(bundle.detail.repository.fullName, bundle.detail.number);

describe("uiStore review thread updates", () => {
  it("tracks line targets when opening files from definitions", () => {
    useUiStore.setState({
      activeView: "search",
      tabs: [],
      activeTabKey: null,
      selectedSearchResult: null
    });
    useUiStore.getState().openPrTab(bundle);

    useUiStore.getState().openFileInTab(key, "src/main.rs", 42);
    const openedTab = useUiStore.getState().tabs.find((candidate) => candidate.key === key);

    expect(openedTab).toMatchObject({
      selectedFilePath: "src/main.rs",
      openFilePaths: ["src/main.rs"],
      editorNavigationTarget: {
        path: "src/main.rs",
        line: 42
      }
    });

    useUiStore.getState().openFileInTab(key, "src/lib.rs");
    expect(useUiStore.getState().tabs.find((candidate) => candidate.key === key)?.editorNavigationTarget).toBeNull();
  });

  it("updates resolved state and appends replies without replacing the PR tab", () => {
    useUiStore.setState({
      activeView: "search",
      tabs: [],
      activeTabKey: null,
      selectedSearchResult: null
    });
    useUiStore.getState().openPrTab(bundle);

    const resolvedThread: ReviewThread = {
      id: bundle.reviewThreads[0].id,
      provider: "github",
      repository: bundle.reviewThreads[0].repository,
      pullNumber: bundle.reviewThreads[0].pullNumber,
      resolved: true,
      outdated: false,
      comments: []
    };
    useUiStore.getState().updateReviewThread(key, resolvedThread);
    useUiStore.getState().appendReviewThreadComment(key, resolvedThread.id, {
      id: "reply-1",
      author: { login: "kol" },
      body: "Following up after resolving this.",
      createdAt: "2026-05-22T00:05:00.000Z",
      isBot: false,
      viewerCanUpdate: false,
      viewerCanDelete: false,
      reactions: []
    });

    const tab = useUiStore.getState().tabs.find((candidate) => candidate.key === key);

    expect(tab?.bundle.reviewThreads[0]).toMatchObject({
      id: "thread-1",
      resolved: true,
      path: "src/App.tsx",
      line: 1
    });
    expect(tab?.bundle.reviewThreads[0]?.comments.at(-1)).toMatchObject({
      id: "reply-1",
      threadId: "thread-1",
      path: "src/App.tsx",
      line: 1,
      body: "Following up after resolving this."
    });
  });

  it("accumulates a deduped, bounded agent activity feed and resets it on a fresh run", () => {
    useUiStore.setState({ activeView: "search", tabs: [], activeTabKey: null, selectedSearchResult: null });
    const store = useUiStore.getState();
    store.openPrTab(bundle);

    store.appendTourActivity(key, { kind: "tool", text: "Reading src/App.tsx" });
    store.appendTourActivity(key, { kind: "tool", text: "Reading src/App.tsx" }); // consecutive dup ignored
    store.appendTourActivity(key, { kind: "say", text: "" }); // blank ignored
    store.appendTourActivity(key, { kind: "think", text: "Reading src/App.tsx" }); // same text, different kind: kept
    store.appendTourActivity(key, { kind: "tool", text: "Drafting chapter — Foundation" });
    expect(useUiStore.getState().tabs.find((t) => t.key === key)?.tourActivity).toEqual([
      { kind: "tool", text: "Reading src/App.tsx" },
      { kind: "think", text: "Reading src/App.tsx" },
      { kind: "tool", text: "Drafting chapter — Foundation" }
    ]);

    // A fresh generation (progress reset to null) clears the feed.
    store.setTourProgress(key, null);
    expect(useUiStore.getState().tabs.find((t) => t.key === key)?.tourActivity).toEqual([]);

    for (let index = 0; index < 90; index += 1) {
      store.appendTourActivity(key, { kind: "tool", text: `step ${index}` });
    }
    const feed = useUiStore.getState().tabs.find((t) => t.key === key)?.tourActivity ?? [];
    expect(feed).toHaveLength(80);
    expect(feed.at(-1)).toEqual({ kind: "tool", text: "step 89" });
  });

  it("keeps reviewed tour chapters with the PR tab and clears them for a new head", () => {
    useUiStore.setState({ activeView: "search", tabs: [], activeTabKey: null, selectedSearchResult: null });
    const store = useUiStore.getState();
    store.openPrTab(bundle);
    store.setTour(key, createTour(bundle));

    store.toggleTourChapterReviewed(key, "chapter-1");
    expect(useUiStore.getState().tabs.find((tab) => tab.key === key)?.reviewedTourChapterIds).toEqual(["chapter-1"]);

    store.openPrTab(bundle);
    expect(useUiStore.getState().tabs.find((tab) => tab.key === key)?.reviewedTourChapterIds).toEqual(["chapter-1"]);

    store.updatePrTab({
      ...bundle,
      detail: { ...bundle.detail, headSha: "new-head-sha" }
    });
    expect(useUiStore.getState().tabs.find((tab) => tab.key === key)?.reviewedTourChapterIds).toEqual([]);
  });

  it("updates and deletes review thread comments in place", () => {
    useUiStore.setState({
      activeView: "search",
      tabs: [],
      activeTabKey: null,
      selectedSearchResult: null
    });
    useUiStore.getState().openPrTab(createBundle());

    useUiStore.getState().updateReviewThreadComment(key, "thread-1", {
      id: "comment-1",
      threadId: "thread-1",
      author: { login: "alex" },
      body: "Updated review note.",
      updatedAt: "2026-05-22T00:10:00.000Z",
      createdAt: "2026-05-22T00:00:00.000Z",
      isBot: false,
      viewerCanUpdate: true,
      viewerCanDelete: true,
      reactions: []
    });

    expect(useUiStore.getState().tabs.find((candidate) => candidate.key === key)?.bundle.reviewThreads[0].comments[0]).toMatchObject({
      id: "comment-1",
      path: "src/App.tsx",
      line: 1,
      body: "Updated review note.",
      viewerCanUpdate: true,
      viewerCanDelete: true
    });

    useUiStore.getState().deleteReviewThreadComment(key, "thread-1", "comment-1");

    expect(useUiStore.getState().tabs.find((candidate) => candidate.key === key)?.bundle.reviewThreads).toEqual([]);
  });
});

function createBundle(): PullRequestBundle {
  return {
    mode: "light",
    detail: {
      provider: "github",
      id: "1",
      number: 12,
      repository: {
        provider: "github",
        owner: "kol",
        name: "repo",
        fullName: "kol/repo"
      },
      title: "Review thread flow",
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
      updatedAt: "2026-05-22T00:00:00.000Z",
      createdAt: "2026-05-22T00:00:00.000Z",
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
        isLarge: false,
        isGenerated: false,
        reviewStatus: "unreviewed",
        annotations: 0,
        diagnostics: 0
      }
    ],
    timeline: [],
    reviewThreads: [
      {
        id: "thread-1",
        provider: "github",
        repository: {
          provider: "github",
          owner: "kol",
          name: "repo",
          fullName: "kol/repo"
        },
        pullNumber: 12,
        path: "src/App.tsx",
        line: 1,
        resolved: false,
        outdated: false,
        comments: [
          {
            id: "comment-1",
            threadId: "thread-1",
            author: { login: "alex" },
            body: "Please check this render path.",
            path: "src/App.tsx",
            line: 1,
            createdAt: "2026-05-22T00:00:00.000Z",
            isBot: false,
            viewerCanUpdate: false,
            viewerCanDelete: false,
            reactions: []
          }
        ]
      }
    ],
    checks: []
  };
}

function createTour(sourceBundle: PullRequestBundle): ReviewTour {
  return {
    id: "tour-1",
    provider: "github",
    repository: sourceBundle.detail.repository,
    pullNumber: sourceBundle.detail.number,
    headSha: sourceBundle.detail.headSha,
    generatedAt: "2026-06-08T00:00:00.000Z",
    model: "test",
    chapters: [
      {
        id: "chapter-1",
        title: "First chapter",
        summary: "Review the first changed area.",
        files: ["src/App.tsx"],
        diffAnchors: [{ path: "src/App.tsx", side: "right", startLine: 1, endLine: 1 }],
        changeStats: { additions: 1, deletions: 0, files: 1 },
        riskLevel: "medium",
        riskReasons: [],
        reviewChecklist: ["Check the render path."],
        dependencies: [],
        generatedAt: "2026-06-08T00:00:00.000Z",
        model: "test",
        headSha: sourceBundle.detail.headSha
      }
    ],
    graph: {
      nodes: [{ id: "chapter-1", label: "First chapter", riskLevel: "medium", files: ["src/App.tsx"] }],
      edges: []
    },
    riskSignals: []
  };
}
