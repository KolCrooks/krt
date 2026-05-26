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
    expect(graphql).toHaveBeenCalledTimes(3);
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
    comments: {
      nodes: [
        {
          id: "comment-id",
          body: "Please check this.",
          url: "https://github.com/kol/repo/pull/12#discussion_r0",
          path: "src/app.ts",
          line: 42,
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
