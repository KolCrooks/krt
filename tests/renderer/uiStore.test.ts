import { describe, expect, it } from "vitest";
import { tabKey, useUiStore } from "../../src/renderer/store/uiStore.js";
import type { PullRequestBundle, ReviewThread } from "../../src/shared/schemas.js";

const bundle = createBundle();
const key = tabKey(bundle.detail.repository.fullName, bundle.detail.number);

describe("uiStore review thread updates", () => {
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
      isBot: false
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
            isBot: false
          }
        ]
      }
    ],
    checks: []
  };
}
