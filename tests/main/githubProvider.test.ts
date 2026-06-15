// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { openDatabase } from "../../src/main/services/database.js";
import { ProviderResponseCache } from "../../src/main/services/providerResponseCache.js";
import {
  GitHubProvider,
  githubChangedFilesCacheKey,
  githubChecksCacheKey,
  githubCloneInfoCacheKey
} from "../../src/main/providers/githubProvider.js";
import { changedFileSchema, repositoryCloneInfoSchema } from "../../src/shared/schemas.js";
import type { RepositoryRef, ReviewSubmission } from "../../src/shared/schemas.js";
import { z } from "zod";

const repository: RepositoryRef = {
  provider: "github",
  owner: "kol",
  name: "repo",
  fullName: "kol/repo"
};

describe("GitHubProvider response caching", () => {
  it("caches normalized changed files and falls back to them on transient failures", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const provider = providerWithOctokit(cache, {
      paginate: vi
        .fn()
        .mockResolvedValueOnce([
          {
            filename: "src/app.ts",
            status: "modified",
            additions: 4,
            deletions: 1,
            changes: 5,
            patch: "@@ -1 +1 @@"
          }
        ])
        .mockRejectedValueOnce(new Error("offline")),
      pulls: { listFiles: vi.fn() }
    });

    const first = await provider.getChangedFiles(repository, 12);
    const second = await provider.getChangedFiles(repository, 12);

    expect(first).toEqual(second);
    expect(first[0]).toMatchObject({
      path: "src/app.ts",
      language: "typescript",
      reviewStatus: "unreviewed"
    });
    expect(cache.get(githubChangedFilesCacheKey(repository, 12), z.array(changedFileSchema))).not.toBeNull();
  });

  it("uses conditional requests for checks and returns cached checks on 304", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    cache.put({
      key: githubChecksCacheKey(repository, "head-sha"),
      provider: "github",
      scope: "repo:kol/repo:checks:head-sha",
      etag: "\"checks-etag\"",
      headSha: "head-sha",
      payload: [
        {
          id: "1",
          name: "CI",
          provider: "github",
          status: "completed",
          conclusion: "success"
        }
      ]
    });
    const listForRef = vi.fn().mockRejectedValue({ status: 304 });
    const provider = providerWithOctokit(cache, {
      checks: { listForRef }
    });

    const checks = await provider.getChecks(repository, "head-sha");

    expect(checks).toHaveLength(1);
    expect(checks[0]?.name).toBe("CI");
    expect(listForRef).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "kol",
        repo: "repo",
        ref: "head-sha",
        headers: { "if-none-match": "\"checks-etag\"" }
      })
    );
  });

  it("caches clone info with ETag revalidation", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const reposGet = vi
      .fn()
      .mockResolvedValueOnce({
        data: {
          owner: { login: "kol" },
          name: "repo",
          full_name: "kol/repo",
          default_branch: "main",
          html_url: "https://github.com/kol/repo",
          clone_url: "https://github.com/kol/repo.git",
          ssh_url: "git@github.com:kol/repo.git"
        },
        headers: { etag: "\"repo-etag\"" }
      })
      .mockRejectedValueOnce({ status: 304 });
    const provider = providerWithOctokit(cache, {
      repos: { get: reposGet }
    });

    const first = await provider.getCloneInfo(repository);
    const second = await provider.getCloneInfo(repository);

    expect(first).toEqual(second);
    expect(cache.get(githubCloneInfoCacheKey(repository), repositoryCloneInfoSchema)?.etag).toBe("\"repo-etag\"");
    expect(reposGet).toHaveBeenLastCalledWith(
      expect.objectContaining({
        headers: { "if-none-match": "\"repo-etag\"" }
      })
    );
  });

  it("hydrates issue-search pull requests with branch metadata", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const issuesAndPullRequests = vi.fn(async () => ({
      data: {
        items: [
          {
            id: 12,
            number: 12,
            title: "Add branch metadata",
            state: "open",
            html_url: "https://github.com/kol/repo/pull/12",
            user: { login: "kol" },
            labels: [],
            comments: 0,
            updated_at: "2026-05-22T00:00:00.000Z",
            created_at: "2026-05-22T00:00:00.000Z",
            repository_url: "https://api.github.com/repos/kol/repo",
            pull_request: { url: "https://api.github.com/repos/kol/repo/pulls/12" }
          }
        ]
      }
    }));
    const pullsGet = vi.fn(async () => ({
      data: {
        id: 12,
        number: 12,
        title: "Add branch metadata",
        state: "open",
        draft: false,
        html_url: "https://github.com/kol/repo/pull/12",
        user: { login: "kol" },
        labels: [],
        requested_reviewers: [],
        base: {
          ref: "main",
          sha: "base-sha",
          repo: {
            owner: { login: "kol" },
            name: "repo",
            full_name: "kol/repo",
            default_branch: "main",
            html_url: "https://github.com/kol/repo"
          }
        },
        head: {
          ref: "feature/search-branches",
          sha: "head-sha",
          repo: {
            full_name: "kol/repo"
          }
        },
        additions: 4,
        deletions: 1,
        changed_files: 2,
        comments: 0,
        review_comments: 0,
        updated_at: "2026-05-22T00:00:00.000Z",
        created_at: "2026-05-22T00:00:00.000Z",
        body: "",
        mergeable: true,
        maintainer_can_modify: true
      },
      headers: {}
    }));
    const provider = providerWithOctokit(
      cache,
      {
        search: { issuesAndPullRequests },
        pulls: { get: pullsGet }
      },
      "token"
    );

    const results = await provider.listPullRequests({ query: "is:open sort:updated-desc", limit: 10 });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      number: 12,
      repository: { fullName: "kol/repo" },
      baseRef: "main",
      headRef: "feature/search-branches",
      headSha: "head-sha"
    });
    expect(issuesAndPullRequests).toHaveBeenCalledWith({
      q: "is:open sort:updated-desc is:pr",
      per_page: 10
    });
    expect(pullsGet).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "kol",
        repo: "repo",
        pull_number: 12
      })
    );
  });

  it("maps historical diff hunk metadata from review comments", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const listComments = vi.fn(async () => ({ data: [] }));
    const listReviews = vi.fn(async () => ({ data: [] }));
    const listReviewComments = vi.fn(async () => ({
      data: [
        {
          id: 1234,
          node_id: "PRRC_kwDO123",
          body: "This was on the previous revision.",
          html_url: "https://github.com/kol/repo/pull/12#discussion_r1234",
          path: "src/app.ts",
          line: null,
          original_line: 13,
          side: "RIGHT",
          start_line: null,
          original_start_line: 12,
          start_side: "RIGHT",
          original_commit_id: "abc123",
          diff_hunk: "@@ -10,5 +10,6 @@\n context\n+old generated line\n",
          outdated: true,
          created_at: "2026-05-22T00:00:00.000Z",
          user: { login: "alex", type: "User" },
          reactions: {
            "+1": 2,
            "-1": 0,
            laugh: 0,
            hooray: 0,
            confused: 0,
            heart: 0,
            rocket: 0,
            eyes: 1
          }
        }
      ]
    }));
    const provider = providerWithOctokit(cache, {
      issues: { listComments },
      pulls: {
        listReviews,
        listReviewComments
      }
    });

    const events = await provider.getPullRequestTimeline(repository, 12);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "review-comment:1234",
      path: "src/app.ts",
      line: 13,
      startLine: 12,
      originalLine: 13,
      originalStartLine: 12,
      originalCommitId: "abc123",
      diffHunk: "@@ -10,5 +10,6 @@\n context\n+old generated line\n",
      outdated: true,
      reactionSubject: { nodeId: "PRRC_kwDO123" },
      reactions: [
        { content: "+1", count: 2, viewerHasReacted: false },
        { content: "eyes", count: 1, viewerHasReacted: false }
      ]
    });
  });

  it("maps GitHub issue comments and pull request review submissions", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const createComment = vi.fn(async () => ({
      data: {
        id: 123,
        body: "Looks good.",
        html_url: "https://github.com/kol/repo/pull/12#issuecomment-123",
        created_at: "2026-05-22T00:00:00.000Z",
        updated_at: "2026-05-22T00:00:01.000Z",
        user: {
          login: "kol",
          avatar_url: "https://github.com/kol.png",
          html_url: "https://github.com/kol",
          type: "User"
        }
      }
    }));
    const createReview = vi.fn(async () => ({
      data: {
        id: 456,
        body: "Please adjust the edge case.",
        html_url: "https://github.com/kol/repo/pull/12#pullrequestreview-456",
        submitted_at: "2026-05-22T00:01:00.000Z"
      }
    }));
    const provider = providerWithOctokit(
      cache,
      {
        issues: { createComment },
        pulls: { createReview }
      },
      "token"
    );

    const comment = await provider.postIssueComment(repository, 12, "Looks good.");
    const reviewInput: ReviewSubmission = {
      repository,
      pullNumber: 12,
      event: "request_changes",
      body: "Please adjust the edge case.",
      commitSha: "abc123",
      comments: [
        {
          path: "src/app.ts",
          body: "Check this branch.",
          line: 42,
          side: "right",
          startLine: 40,
          startSide: "right"
        }
      ]
    };
    const review = await provider.submitReview(reviewInput);

    expect(comment).toMatchObject({
      id: "123",
      body: "Looks good.",
      author: { login: "kol" },
      isBot: false
    });
    expect(createComment).toHaveBeenCalledWith({
      owner: "kol",
      repo: "repo",
      issue_number: 12,
      body: "Looks good."
    });
    expect(review).toMatchObject({
      id: "456",
      event: "request_changes",
      body: "Please adjust the edge case."
    });
    expect(createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "kol",
        repo: "repo",
        pull_number: 12,
        commit_id: "abc123",
        event: "REQUEST_CHANGES",
        comments: [
          {
            path: "src/app.ts",
            body: "Check this branch.",
            line: 42,
            side: "RIGHT",
            start_line: 40,
            start_side: "RIGHT"
          }
        ]
      })
    );
  });

  it("maps GitHub review thread replies and resolution mutations", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        addPullRequestReviewThreadReply: {
          comment: {
            id: "reply-id",
            body: "Thanks, fixed.",
            url: "https://github.com/kol/repo/pull/12#discussion_r1",
            path: "src/app.ts",
            line: 42,
            createdAt: "2026-05-22T00:00:00.000Z",
            updatedAt: "2026-05-22T00:00:00.000Z",
            author: {
              login: "kol",
              avatarUrl: "https://github.com/kol.png",
              url: "https://github.com/kol"
            }
          }
        }
      })
      .mockResolvedValueOnce({
        resolveReviewThread: {
          thread: graphqlThread({ isResolved: true })
        }
      })
      .mockResolvedValueOnce({
        unresolveReviewThread: {
          thread: graphqlThread({ isResolved: false })
        }
      });
    const provider = providerWithGraphql(cache, graphql, "token");

    const reply = await provider.replyToReviewThread(repository, "thread-id", "Thanks, fixed.");
    const resolved = await provider.resolveReviewThread(repository, 12, "thread-id");
    const reopened = await provider.reopenReviewThread(repository, 12, "thread-id");

    expect(reply).toMatchObject({
      id: "reply-id",
      threadId: "thread-id",
      body: "Thanks, fixed.",
      path: "src/app.ts",
      line: 42
    });
    expect(resolved).toMatchObject({ id: "thread-id", resolved: true });
    expect(reopened).toMatchObject({ id: "thread-id", resolved: false });
    expect(resolved.comments[0]).toMatchObject({
      originalLine: 13,
      originalStartLine: 12,
      originalCommitId: "abc123",
      diffHunk: "@@ -10,5 +10,6 @@\n context\n+old generated line\n",
      outdated: true
    });
    expect(graphql).toHaveBeenCalledTimes(3);
  });

  it("updates and deletes GitHub review comments through GraphQL", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const graphql = vi
      .fn()
      .mockResolvedValueOnce({
        updatePullRequestReviewComment: {
          pullRequestReviewComment: {
            id: "comment-id",
            body: "Edited review note.",
            url: "https://github.com/kol/repo/pull/12#discussion_r1",
            path: "src/app.ts",
            line: 42,
            originalLine: 42,
            originalStartLine: null,
            diffHunk: "@@ -40,3 +40,3 @@\n context\n",
            outdated: false,
            viewerCanUpdate: true,
            viewerCanDelete: true,
            originalCommit: { oid: "abc123" },
            createdAt: "2026-05-22T00:00:00.000Z",
            updatedAt: "2026-05-22T00:02:00.000Z",
            author: {
              login: "kol",
              avatarUrl: "https://github.com/kol.png",
              url: "https://github.com/kol"
            },
            reactionGroups: []
          }
        }
      })
      .mockResolvedValueOnce({
        deletePullRequestReviewComment: {
          pullRequestReviewComment: {
            id: "comment-id"
          }
        }
      });
    const provider = providerWithGraphql(cache, graphql, "token");

    const updated = await provider.updateReviewComment(repository, "comment-id", "Edited review note.");
    const deleted = await provider.deleteReviewComment(repository, "comment-id");

    expect(updated).toMatchObject({
      id: "comment-id",
      body: "Edited review note.",
      path: "src/app.ts",
      line: 42,
      viewerCanUpdate: true,
      viewerCanDelete: true
    });
    expect(deleted).toEqual({ commentId: "comment-id", deleted: true });
    expect(graphql).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining("updatePullRequestReviewComment"),
      { commentId: "comment-id", body: "Edited review note." }
    );
    expect(graphql).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("deletePullRequestReviewComment"),
      { commentId: "comment-id" }
    );
  });
});

describe("GitHubProvider.searchRepositories", () => {
  it("returns an empty array when no token is configured", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const provider = providerWithOctokit(cache, {
      repos: { listForAuthenticatedUser: vi.fn().mockResolvedValue({ data: [] }) },
      search: { repos: vi.fn() },
    }, null);

    const results = await provider.searchRepositories("kol");
    expect(results).toEqual([]);
  });

  it("filters repos by query substring case-insensitively and caps at 10", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const repos = Array.from({ length: 20 }, (_, i) => ({ full_name: `kol/kol-repo-${i}` }));
    const provider = providerWithOctokit(cache, {
      repos: { listForAuthenticatedUser: vi.fn().mockResolvedValue({ data: repos }) },
      search: { repos: vi.fn().mockResolvedValue({ data: { items: [] } }) },
    }, "token");

    const results = await provider.searchRepositories("kol-repo");
    expect(results).toHaveLength(10);
    expect(results.every((r) => r.fullName.includes("kol-repo"))).toBe(true);
  });

  it("falls back to search.repos when list yields fewer than 3 matches", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const listRepos = [{ full_name: "kol/recent-match" }];
    const searchRepos = [
      { full_name: "kol/recent-match" }, // duplicate — should be deduped
      { full_name: "kol/old-match" },
    ];
    const provider = providerWithOctokit(cache, {
      repos: { listForAuthenticatedUser: vi.fn().mockResolvedValue({ data: listRepos }) },
      search: { repos: vi.fn().mockResolvedValue({ data: { items: searchRepos } }) },
    }, "token");

    const results = await provider.searchRepositories("match");
    expect(results.map((r) => r.fullName)).toEqual(["kol/recent-match", "kol/old-match"]);
  });

  it("re-throws 401 authentication errors instead of swallowing them", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const authError = Object.assign(new Error("Bad credentials"), { status: 401 });
    const provider = providerWithOctokit(cache, {
      repos: { listForAuthenticatedUser: vi.fn().mockRejectedValue(authError) },
      search: { repos: vi.fn() },
    }, "token");

    await expect(provider.searchRepositories("kol")).rejects.toThrow("Bad credentials");
  });

  it("re-throws 403 forbidden errors instead of swallowing them", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const forbiddenError = Object.assign(new Error("Forbidden"), { status: 403 });
    const provider = providerWithOctokit(cache, {
      repos: { listForAuthenticatedUser: vi.fn().mockRejectedValue(forbiddenError) },
      search: { repos: vi.fn() },
    }, "token");

    await expect(provider.searchRepositories("kol")).rejects.toThrow("Forbidden");
  });

  it("returns empty array and logs for non-auth network failures", async () => {
    const cache = new ProviderResponseCache(openDatabase(":memory:"));
    const networkError = new Error("Network timeout");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const provider = providerWithOctokit(cache, {
      repos: { listForAuthenticatedUser: vi.fn().mockRejectedValue(networkError) },
      search: { repos: vi.fn() },
    }, "token");

    const results = await provider.searchRepositories("kol");
    expect(results).toEqual([]);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("searchRepositories failed"),
      expect.any(Error)
    );
    consoleSpy.mockRestore();
  });
});

function providerWithOctokit(cache: ProviderResponseCache, octokit: object, token: string | null = null): GitHubProvider {
  const provider = new GitHubProvider(token, cache);
  Object.defineProperty(provider, "octokit", { value: octokit });
  return provider;
}

function providerWithGraphql(
  cache: ProviderResponseCache,
  graphql: (...args: unknown[]) => Promise<unknown>,
  token: string | null = null
): GitHubProvider {
  const provider = new GitHubProvider(token, cache);
  Object.defineProperty(provider, "graphql", { value: graphql });
  return provider;
}

function graphqlThread({ isResolved }: { isResolved: boolean }) {
  return {
    id: "thread-id",
    isResolved,
    isOutdated: false,
    path: "src/app.ts",
    line: 42,
    diffSide: "RIGHT",
    startLine: 40,
    startDiffSide: "RIGHT",
    originalLine: 13,
    originalStartLine: 12,
    comments: {
      nodes: [
        {
          id: "comment-id",
          body: "Please check this.",
          url: "https://github.com/kol/repo/pull/12#discussion_r0",
          path: "src/app.ts",
          line: 42,
          originalLine: 13,
          originalStartLine: 12,
          diffHunk: "@@ -10,5 +10,6 @@\n context\n+old generated line\n",
          outdated: true,
          originalCommit: { oid: "abc123" },
          createdAt: "2026-05-22T00:00:00.000Z",
          updatedAt: "2026-05-22T00:00:00.000Z",
          author: {
            login: "alex",
            avatarUrl: "https://github.com/alex.png",
            url: "https://github.com/alex"
          }
        }
      ]
    }
  };
}
