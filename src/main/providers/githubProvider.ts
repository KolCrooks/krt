import { graphql as createGraphqlClient } from "@octokit/graphql";
import { Octokit } from "@octokit/rest";
import { z } from "zod";
import { AppError } from "../errors.js";
import type {
  ActivityEvent,
  Actor,
  ChangedFile,
  CheckRun,
  FileContent,
  FilePatch,
  ProviderAccount,
  PullRequestBundle,
  PullRequestDetail,
  PullRequestSummary,
  RepositoryCloneInfo,
  RepositoryRef,
  ReviewComment,
  ReviewSubmission,
  ReviewSubmissionResult,
  ReviewThread
} from "../../shared/schemas.js";
import {
  activityEventSchema,
  changedFileSchema,
  checkRunSchema,
  fileContentSchema,
  pullRequestDetailSchema,
  repositoryCloneInfoSchema,
  repositoryRefSchema
} from "../../shared/schemas.js";
import type { Provider, PullRequestSearchInput } from "./provider.js";
import type { ProviderResponseCache } from "../services/providerResponseCache.js";

type OctokitIssueSearchItem = {
  id: number;
  number: number;
  title: string;
  state: string;
  draft?: boolean;
  html_url: string;
  user?: { login?: string; avatar_url?: string; html_url?: string; type?: string } | null;
  labels?: Array<string | { name?: string | null }> | null;
  comments?: number;
  updated_at?: string;
  created_at?: string;
  repository_url?: string;
  pull_request?: { url?: string };
};

export class GitHubProvider implements Provider {
  readonly id = "github" as const;
  private readonly octokit: Octokit;
  private readonly graphql: ReturnType<typeof createGraphqlClient.defaults>;

  constructor(
    private readonly token: string | null,
    private readonly responseCache: ProviderResponseCache
  ) {
    this.octokit = new Octokit({
      auth: token ?? undefined,
      userAgent: "krt2/0.1.0"
    });
    this.graphql = createGraphqlClient.defaults({
      headers: token ? { authorization: `token ${token}` } : {}
    });
  }

  async fetchUser(): Promise<ProviderAccount> {
    this.requireToken("Fetching the GitHub user requires a token.");
    const { data } = await this.octokit.users.getAuthenticated();
    return {
      provider: "github",
      id: String(data.id),
      login: data.login,
      name: data.name,
      avatarUrl: data.avatar_url,
      scopes: [],
      configured: true
    };
  }

  async listPullRequests(input: PullRequestSearchInput): Promise<PullRequestSummary[]> {
    this.requireToken("Connect a GitHub token in Settings to search pull requests.");

    if (input.owner && input.repo) {
      const { data } = await this.octokit.pulls.list({
        owner: input.owner,
        repo: input.repo,
        state: "open",
        per_page: input.limit
      });
      return data.map((item) => this.mapPullListItem(item));
    }

    const query = input.query.includes("is:pr") ? input.query : `${input.query} is:pr`;
    const { data } = await this.octokit.search.issuesAndPullRequests({
      q: query,
      per_page: input.limit
    });

    return (data.items as OctokitIssueSearchItem[])
      .filter((item) => Boolean(item.pull_request))
      .map((item) => this.mapSearchItem(item));
  }

  async getPullRequest(repository: RepositoryRef, number: number): Promise<PullRequestDetail> {
    const cacheKey = githubPullDetailCacheKey(repository, number);
    const cached = this.responseCache.get(cacheKey, pullRequestDetailSchema);

    try {
      const { data, headers } = await this.octokit.pulls.get({
        owner: repository.owner,
        repo: repository.name,
        pull_number: number,
        headers: conditionalHeaders(cached?.etag)
      });

      const detail = {
        ...this.mapPullListItem(data),
        body: data.body ?? "",
        mergeable: data.mergeable ?? null,
        maintainerCanModify: data.maintainer_can_modify ?? false,
        isFromFork: data.head.repo?.full_name !== data.base.repo.full_name
      };
      this.responseCache.put({
        key: cacheKey,
        provider: "github",
        scope: githubPullScope(repository, number),
        etag: normalizeHeader(headers.etag),
        headSha: detail.headSha,
        payload: detail
      });
      return detail;
    } catch (error) {
      if (isNotModified(error) && cached) {
        return cached.payload;
      }
      throw error;
    }
  }

  async getPullRequestTimeline(repository: RepositoryRef, number: number): Promise<ActivityEvent[]> {
    const cacheKey = githubTimelineCacheKey(repository, number);
    const cached = this.responseCache.get(cacheKey, z.array(activityEventSchema));

    try {
      const [issueComments, reviews, reviewComments] = await Promise.all([
        this.octokit.issues.listComments({
          owner: repository.owner,
          repo: repository.name,
          issue_number: number,
          per_page: 100
        }),
        this.octokit.pulls.listReviews({
          owner: repository.owner,
          repo: repository.name,
          pull_number: number,
          per_page: 100
        }),
        this.octokit.pulls.listReviewComments({
          owner: repository.owner,
          repo: repository.name,
          pull_number: number,
          per_page: 100
        })
      ]);

      const events: ActivityEvent[] = [
        ...issueComments.data.map((comment) => ({
          id: `issue-comment:${comment.id}`,
          kind: this.isBot(comment.user) ? ("bot" as const) : ("comment" as const),
          actor: this.mapActor(comment.user),
          title: "Comment",
          body: comment.body ?? "",
          createdAt: comment.created_at,
          url: comment.html_url,
          severity: "info" as const
        })),
        ...reviews.data.map((review) => ({
          id: `review:${review.id}`,
          kind: "review" as const,
          actor: this.mapActor(review.user),
          title: `Review ${review.state.toLowerCase()}`,
          body: review.body ?? "",
          createdAt: review.submitted_at ?? new Date().toISOString(),
          url: review.html_url ?? undefined,
          severity: review.state === "CHANGES_REQUESTED" ? ("warning" as const) : ("info" as const)
        })),
        ...reviewComments.data.map((comment) => ({
          id: `review-comment:${comment.id}`,
          kind: this.isBot(comment.user) ? ("bot" as const) : ("comment" as const),
          actor: this.mapActor(comment.user),
          title: `Comment on ${comment.path}`,
          body: comment.body,
          createdAt: comment.created_at,
          url: comment.html_url,
          path: comment.path,
          severity: "info" as const
        }))
      ].sort((left, right) => left.createdAt.localeCompare(right.createdAt));

      this.responseCache.put({
        key: cacheKey,
        provider: "github",
        scope: githubPullScope(repository, number),
        payload: events
      });
      return events;
    } catch (error) {
      if (cached && isCacheFallbackError(error)) {
        return cached.payload;
      }
      throw error;
    }
  }

  async getReviewThreads(repository: RepositoryRef, number: number): Promise<ReviewThread[]> {
    this.requireToken("GitHub review threads require GraphQL access with a token.");

    const response = await this.graphql<{
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: Array<{
              id: string;
              isResolved: boolean;
              isOutdated: boolean;
              path?: string | null;
              line?: number | null;
              comments: {
                nodes: Array<{
                  id: string;
                  body: string;
                  url: string;
                  path?: string | null;
                  line?: number | null;
                  createdAt: string;
                  updatedAt: string;
                  author?: { login: string; avatarUrl?: string; url?: string } | null;
                }>;
              };
            }>;
          };
        };
      };
    }>(
      `query PullRequestThreads($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviewThreads(first: 100) {
              nodes {
                id
                isResolved
                isOutdated
                path
                line
                comments(first: 100) {
                  nodes {
                    id
                    body
                    url
                    path
                    line
                    createdAt
                    updatedAt
                    author {
                      login
                      avatarUrl
                      url
                    }
                  }
                }
              }
            }
          }
        }
      }`,
      { owner: repository.owner, repo: repository.name, number }
    );

    return response.repository.pullRequest.reviewThreads.nodes.map((thread) => ({
      id: thread.id,
      provider: "github",
      repository,
      pullNumber: number,
      path: thread.path ?? undefined,
      line: thread.line ?? undefined,
      resolved: thread.isResolved,
      outdated: thread.isOutdated,
      comments: thread.comments.nodes.map((comment) => ({
        id: comment.id,
        threadId: thread.id,
        author: comment.author
          ? {
              login: comment.author.login,
              avatarUrl: comment.author.avatarUrl,
              url: comment.author.url
            }
          : { login: "ghost" },
        body: comment.body,
        url: comment.url,
        path: comment.path ?? thread.path ?? undefined,
        line: comment.line ?? thread.line ?? undefined,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        isBot: false
      }))
    }));
  }

  async getChecks(repository: RepositoryRef, ref: string): Promise<CheckRun[]> {
    const cacheKey = githubChecksCacheKey(repository, ref);
    const cached = this.responseCache.get(cacheKey, z.array(checkRunSchema));

    try {
      const { data, headers } = await this.octokit.checks.listForRef({
        owner: repository.owner,
        repo: repository.name,
        ref,
        per_page: 100,
        headers: conditionalHeaders(cached?.etag)
      });

      const checks = data.check_runs.map((check) => ({
        id: String(check.id),
        name: check.name,
        provider: "github" as const,
        status: normalizeCheckStatus(check.status),
        conclusion: check.conclusion ? normalizeCheckConclusion(check.conclusion) : null,
        url: check.html_url ?? undefined,
        startedAt: check.started_at,
        completedAt: check.completed_at,
        summary: check.output.summary ?? undefined
      }));
      this.responseCache.put({
        key: cacheKey,
        provider: "github",
        scope: githubChecksScope(repository, ref),
        etag: normalizeHeader(headers.etag),
        headSha: ref,
        payload: checks
      });
      return checks;
    } catch (error) {
      if (isNotModified(error) && cached) {
        return cached.payload;
      }
      if (cached && isCacheFallbackError(error)) {
        return cached.payload;
      }
      throw error;
    }
  }

  async getChangedFiles(repository: RepositoryRef, number: number): Promise<ChangedFile[]> {
    const cacheKey = githubChangedFilesCacheKey(repository, number);
    const cached = this.responseCache.get(cacheKey, z.array(changedFileSchema));

    try {
      const files = await this.octokit.paginate(this.octokit.pulls.listFiles, {
        owner: repository.owner,
        repo: repository.name,
        pull_number: number,
        per_page: 100
      });

      const changedFiles = files.map((file) => {
        const changes = file.changes ?? file.additions + file.deletions;
        return {
          path: file.filename,
          previousPath: file.previous_filename,
          status: normalizeFileStatus(file.status),
          additions: file.additions,
          deletions: file.deletions,
          changes,
          patch: file.patch,
          language: languageFromPath(file.filename),
          isLarge: changes > 2_500 || (file.patch?.length ?? 0) > 250_000,
          isGenerated: isLikelyGenerated(file.filename),
          reviewStatus: "unreviewed" as const,
          annotations: 0,
          diagnostics: 0
        };
      });
      this.responseCache.put({
        key: cacheKey,
        provider: "github",
        scope: githubPullScope(repository, number),
        payload: changedFiles
      });
      return changedFiles;
    } catch (error) {
      if (cached && isCacheFallbackError(error)) {
        return cached.payload;
      }
      throw error;
    }
  }

  async getPatch(repository: RepositoryRef, number: number, path: string, headSha: string): Promise<FilePatch> {
    const changedFiles = await this.getChangedFiles(repository, number);
    const file = changedFiles.find((candidate) => candidate.path === path);
    if (!file) {
      throw new AppError("patch_not_found", `No changed file named ${path} exists on this pull request.`);
    }

    return {
      provider: "github",
      repository,
      pullNumber: number,
      path,
      patch: file.patch ?? "",
      headSha,
      isLarge: file.isLarge
    };
  }

  async getFileContent(repository: RepositoryRef, path: string, ref: string): Promise<FileContent> {
    const cacheKey = githubFileContentCacheKey(repository, path, ref);
    const cached = this.responseCache.get(cacheKey, fileContentSchema);

    try {
      const { data, headers } = await this.octokit.repos.getContent({
        owner: repository.owner,
        repo: repository.name,
        path,
        ref,
        headers: conditionalHeaders(cached?.etag)
      });

      if (Array.isArray(data) || data.type !== "file") {
        throw new AppError("file_content_not_file", `${path} is not a file.`);
      }

      const isBase64 = data.encoding === "base64";
      const content = {
        provider: "github" as const,
        repository,
        path,
        ref,
        contents: isBase64 ? Buffer.from(data.content, "base64").toString("utf8") : data.content,
        encoding: "utf-8" as const,
        size: data.size,
        isLarge: data.size > 500_000
      };
      this.responseCache.put({
        key: cacheKey,
        provider: "github",
        scope: githubFileContentScope(repository, ref),
        etag: normalizeHeader(headers.etag),
        headSha: ref,
        payload: content
      });
      return content;
    } catch (error) {
      if (isNotModified(error) && cached) {
        return cached.payload;
      }
      throw error;
    }
  }

  async postIssueComment(repository: RepositoryRef, number: number, body: string): Promise<ReviewComment> {
    this.requireToken("Posting a GitHub comment requires a token.");
    const { data } = await this.octokit.issues.createComment({
      owner: repository.owner,
      repo: repository.name,
      issue_number: number,
      body
    });

    return {
      id: String(data.id),
      author: this.mapActor(data.user),
      body: data.body ?? body,
      url: data.html_url,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      isBot: this.isBot(data.user)
    };
  }

  async replyToReviewThread(repository: RepositoryRef, threadId: string, body: string): Promise<ReviewComment> {
    this.requireToken("Replying to a review thread requires a token.");

    const response = await this.graphql<{
      addPullRequestReviewThreadReply: {
        comment: {
          id: string;
          body: string;
          url: string;
          path?: string | null;
          line?: number | null;
          createdAt: string;
          updatedAt: string;
          author?: { login: string; avatarUrl?: string; url?: string } | null;
        };
      };
    }>(
      `mutation ReplyToReviewThread($threadId: ID!, $body: String!) {
        addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $threadId, body: $body }) {
          comment {
            id
            body
            url
            path
            line
            createdAt
            updatedAt
            author {
              login
              avatarUrl
              url
            }
          }
        }
      }`,
      { threadId, body }
    );

    const comment = response.addPullRequestReviewThreadReply.comment;
    return {
      id: comment.id,
      threadId,
      author: mapGraphqlActor(comment.author),
      body: comment.body,
      url: comment.url,
      path: comment.path ?? undefined,
      line: comment.line ?? undefined,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      isBot: false
    };
  }

  async resolveReviewThread(repository: RepositoryRef, number: number, threadId: string): Promise<ReviewThread> {
    this.requireToken("Resolving a review thread requires a token.");
    const response = await this.graphql<ReviewThreadMutationResponse>(
      `mutation ResolveReviewThread($threadId: ID!) {
        resolveReviewThread(input: { threadId: $threadId }) {
          thread {
            id
            isResolved
            isOutdated
            path
            line
            comments(first: 100) {
              nodes {
                id
                body
                url
                path
                line
                createdAt
                updatedAt
                author {
                  login
                  avatarUrl
                  url
                }
              }
            }
          }
        }
      }`,
      { threadId }
    );

    return mapGraphqlThread(response.resolveReviewThread.thread, repository, number);
  }

  async reopenReviewThread(repository: RepositoryRef, number: number, threadId: string): Promise<ReviewThread> {
    this.requireToken("Reopening a review thread requires a token.");
    const response = await this.graphql<ReviewThreadMutationResponse>(
      `mutation ReopenReviewThread($threadId: ID!) {
        unresolveReviewThread(input: { threadId: $threadId }) {
          thread {
            id
            isResolved
            isOutdated
            path
            line
            comments(first: 100) {
              nodes {
                id
                body
                url
                path
                line
                createdAt
                updatedAt
                author {
                  login
                  avatarUrl
                  url
                }
              }
            }
          }
        }
      }`,
      { threadId }
    );

    return mapGraphqlThread(response.unresolveReviewThread.thread, repository, number);
  }

  async submitReview(submission: ReviewSubmission): Promise<ReviewSubmissionResult> {
    this.requireToken("Submitting a review requires a token.");
    const { data } = await this.octokit.pulls.createReview({
      owner: submission.repository.owner,
      repo: submission.repository.name,
      pull_number: submission.pullNumber,
      commit_id: submission.commitSha,
      body: submission.body,
      event: mapReviewEvent(submission.event),
      comments: submission.comments.map((comment) => ({
        path: comment.path,
        body: comment.body,
        line: comment.line,
        side: comment.side === "left" ? "LEFT" : "RIGHT",
        start_line: comment.startLine,
        start_side: comment.startSide === "left" ? "LEFT" : comment.startSide === "right" ? "RIGHT" : undefined
      }))
    });

    return {
      id: String(data.id),
      provider: "github",
      repository: submission.repository,
      pullNumber: submission.pullNumber,
      event: submission.event,
      body: data.body ?? submission.body,
      url: data.html_url ?? undefined,
      submittedAt: data.submitted_at ?? new Date().toISOString()
    };
  }

  async getRepository(repository: RepositoryRef): Promise<RepositoryRef> {
    const cacheKey = githubRepositoryCacheKey(repository);
    const cached = this.responseCache.get(cacheKey, repositoryRefSchema);

    try {
      const { data, headers } = await this.octokit.repos.get({
        owner: repository.owner,
        repo: repository.name,
        headers: conditionalHeaders(cached?.etag)
      });

      const normalized = {
        provider: "github" as const,
        owner: data.owner.login,
        name: data.name,
        fullName: data.full_name,
        defaultBranch: data.default_branch,
        url: data.html_url
      };
      this.responseCache.put({
        key: cacheKey,
        provider: "github",
        scope: githubRepositoryScope(repository),
        etag: normalizeHeader(headers.etag),
        payload: normalized
      });
      return normalized;
    } catch (error) {
      if (isNotModified(error) && cached) {
        return cached.payload;
      }
      if (cached && isCacheFallbackError(error)) {
        return cached.payload;
      }
      throw error;
    }
  }

  async getCloneInfo(repository: RepositoryRef): Promise<RepositoryCloneInfo> {
    const cacheKey = githubCloneInfoCacheKey(repository);
    const cached = this.responseCache.get(cacheKey, repositoryCloneInfoSchema);

    try {
      const { data, headers } = await this.octokit.repos.get({
        owner: repository.owner,
        repo: repository.name,
        headers: conditionalHeaders(cached?.etag)
      });

      const cloneInfo = {
        repository: {
          provider: "github" as const,
          owner: data.owner.login,
          name: data.name,
          fullName: data.full_name,
          defaultBranch: data.default_branch,
          url: data.html_url
        },
        htmlUrl: data.html_url,
        cloneUrl: data.clone_url,
        sshUrl: data.ssh_url,
        defaultBranch: data.default_branch
      };
      this.responseCache.put({
        key: cacheKey,
        provider: "github",
        scope: githubRepositoryScope(repository),
        etag: normalizeHeader(headers.etag),
        payload: cloneInfo
      });
      return cloneInfo;
    } catch (error) {
      if (isNotModified(error) && cached) {
        return cached.payload;
      }
      if (cached && isCacheFallbackError(error)) {
        return cached.payload;
      }
      throw error;
    }
  }

  async openPullRequest(repository: RepositoryRef, number: number, mode: "light" | "managed"): Promise<PullRequestBundle> {
    const detail = await this.getPullRequest(repository, number);
    const [changedFiles, timeline, reviewThreads, checks] = await Promise.all([
      this.getChangedFiles(repository, number),
      this.getPullRequestTimeline(repository, number),
      this.getReviewThreadsOrEmpty(repository, number),
      this.getChecksOrEmpty(repository, detail.headSha)
    ]);

    return {
      detail,
      mode,
      changedFiles,
      timeline,
      reviewThreads,
      checks
    };
  }

  private async getReviewThreadsOrEmpty(repository: RepositoryRef, number: number): Promise<ReviewThread[]> {
    try {
      return await this.getReviewThreads(repository, number);
    } catch (error) {
      if (error instanceof AppError && error.code === "missing_provider_token") {
        return [];
      }
      throw error;
    }
  }

  private async getChecksOrEmpty(repository: RepositoryRef, ref: string): Promise<CheckRun[]> {
    try {
      return await this.getChecks(repository, ref);
    } catch {
      return [];
    }
  }

  private mapPullListItem(item: {
    id: number;
    number: number;
    title: string;
    state: string;
    draft?: boolean | null;
    html_url: string;
    user: { login?: string; avatar_url?: string; html_url?: string; type?: string } | null;
    labels?: Array<string | { name?: string | null }> | null;
    requested_reviewers?: Array<{ login?: string; avatar_url?: string; html_url?: string; type?: string }> | null;
    base: { ref: string; sha: string; repo: { owner: { login: string }; name: string; full_name: string; default_branch?: string; html_url?: string } };
    head: { ref: string; sha: string };
    additions?: number | null;
    deletions?: number | null;
    changed_files?: number | null;
    comments?: number | null;
    review_comments?: number | null;
    updated_at: string;
    created_at: string;
    merged_at?: string | null;
  }): PullRequestSummary {
    const repository: RepositoryRef = {
      provider: "github",
      owner: item.base.repo.owner.login,
      name: item.base.repo.name,
      fullName: item.base.repo.full_name,
      defaultBranch: item.base.repo.default_branch,
      url: item.base.repo.html_url
    };

    return {
      provider: "github",
      id: String(item.id),
      number: item.number,
      repository,
      title: item.title,
      state: item.merged_at ? "merged" : normalizePrState(item.state),
      draft: item.draft ?? false,
      url: item.html_url,
      author: this.mapActor(item.user),
      labels: normalizeLabels(item.labels),
      reviewers: (item.requested_reviewers ?? []).map((reviewer) => this.mapActor(reviewer)),
      baseRef: item.base.ref,
      headRef: item.head.ref,
      headSha: item.head.sha,
      baseSha: item.base.sha,
      additions: item.additions ?? 0,
      deletions: item.deletions ?? 0,
      changedFileCount: item.changed_files ?? 0,
      commentCount: (item.comments ?? 0) + (item.review_comments ?? 0),
      updatedAt: item.updated_at,
      createdAt: item.created_at
    };
  }

  private mapSearchItem(item: OctokitIssueSearchItem): PullRequestSummary {
    const repository = repositoryFromSearchUrl(item.repository_url);
    return {
      provider: "github",
      id: String(item.id),
      number: item.number,
      repository,
      title: item.title,
      state: normalizePrState(item.state),
      draft: item.draft ?? false,
      url: item.html_url,
      author: this.mapActor(item.user),
      labels: normalizeLabels(item.labels),
      reviewers: [],
      baseRef: repository.defaultBranch ?? "main",
      headRef: "",
      headSha: "",
      baseSha: null,
      additions: 0,
      deletions: 0,
      changedFileCount: 0,
      commentCount: item.comments ?? 0,
      updatedAt: item.updated_at ?? new Date().toISOString(),
      createdAt: item.created_at ?? new Date().toISOString()
    };
  }

  private mapActor(user: { login?: string; avatar_url?: string; html_url?: string; type?: string } | null | undefined): Actor {
    return {
      login: user?.login ?? "unknown",
      avatarUrl: user?.avatar_url,
      url: user?.html_url,
      type: user?.type
    };
  }

  private isBot(user: { type?: string } | null | undefined): boolean {
    return user?.type === "Bot";
  }

  private requireToken(message: string): void {
    if (!this.token) {
      throw new AppError("missing_provider_token", message);
    }
  }
}

type GraphqlThread = {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path?: string | null;
  line?: number | null;
  comments: {
    nodes: Array<{
      id: string;
      body: string;
      url: string;
      path?: string | null;
      line?: number | null;
      createdAt: string;
      updatedAt: string;
      author?: { login: string; avatarUrl?: string; url?: string } | null;
    }>;
  };
};

type ReviewThreadMutationResponse = {
  resolveReviewThread: { thread: GraphqlThread };
  unresolveReviewThread: { thread: GraphqlThread };
};

function mapGraphqlThread(thread: GraphqlThread, repository: RepositoryRef, pullNumber: number): ReviewThread {
  return {
    id: thread.id,
    provider: "github",
    repository,
    pullNumber,
    path: thread.path ?? undefined,
    line: thread.line ?? undefined,
    resolved: thread.isResolved,
    outdated: thread.isOutdated,
    comments: thread.comments.nodes.map((comment) => ({
      id: comment.id,
      threadId: thread.id,
      author: mapGraphqlActor(comment.author),
      body: comment.body,
      url: comment.url,
      path: comment.path ?? thread.path ?? undefined,
      line: comment.line ?? thread.line ?? undefined,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      isBot: false
    }))
  };
}

function mapGraphqlActor(actor: { login: string; avatarUrl?: string; url?: string } | null | undefined) {
  return actor
    ? {
        login: actor.login,
        avatarUrl: actor.avatarUrl,
        url: actor.url
      }
    : { login: "ghost" };
}

export function githubPullScope(repository: RepositoryRef, number: number): string {
  return `repo:${repository.fullName}:pr:${number}`;
}

export function githubPullDetailCacheKey(repository: RepositoryRef, number: number): string {
  return `${githubPullScope(repository, number)}:detail`;
}

export function githubChangedFilesCacheKey(repository: RepositoryRef, number: number): string {
  return `${githubPullScope(repository, number)}:files`;
}

export function githubTimelineCacheKey(repository: RepositoryRef, number: number): string {
  return `${githubPullScope(repository, number)}:timeline`;
}

export function githubChecksScope(repository: RepositoryRef, ref: string): string {
  return `repo:${repository.fullName}:checks:${ref}`;
}

export function githubChecksCacheKey(repository: RepositoryRef, ref: string): string {
  return `${githubChecksScope(repository, ref)}:runs`;
}

export function githubRepositoryScope(repository: RepositoryRef): string {
  return `repo:${repository.fullName}`;
}

export function githubRepositoryCacheKey(repository: RepositoryRef): string {
  return `${githubRepositoryScope(repository)}:metadata`;
}

export function githubCloneInfoCacheKey(repository: RepositoryRef): string {
  return `${githubRepositoryScope(repository)}:clone`;
}

export function githubFileContentScope(repository: RepositoryRef, ref: string): string {
  return `repo:${repository.fullName}:contents:${ref}`;
}

export function githubFileContentCacheKey(repository: RepositoryRef, path: string, ref: string): string {
  return `${githubFileContentScope(repository, ref)}:${encodeURIComponent(path)}`;
}

function conditionalHeaders(etag?: string | null): Record<string, string> | undefined {
  return etag ? { "if-none-match": etag } : undefined;
}

function normalizeHeader(value: string | number | string[] | undefined): string | null {
  if (Array.isArray(value)) {
    return value[0] ?? null;
  }
  return value === undefined ? null : String(value);
}

function isNotModified(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && (error as { status?: number }).status === 304;
}

function isCacheFallbackError(error: unknown): boolean {
  if (isNotModified(error)) {
    return true;
  }
  if (typeof error !== "object" || error === null || !("status" in error)) {
    return error instanceof Error;
  }
  const status = (error as { status?: number }).status;
  return status === undefined || status === 0 || status === 403 || status >= 500;
}

function mapReviewEvent(event: ReviewSubmission["event"]): "APPROVE" | "REQUEST_CHANGES" | "COMMENT" {
  if (event === "approve") {
    return "APPROVE";
  }
  if (event === "request_changes") {
    return "REQUEST_CHANGES";
  }
  return "COMMENT";
}

function normalizeLabels(labels: Array<string | { name?: string | null }> | null | undefined): string[] {
  return (labels ?? []).map((label) => (typeof label === "string" ? label : label.name)).filter((label): label is string => Boolean(label));
}

function normalizePrState(state: string): "open" | "closed" | "merged" {
  return state === "open" ? "open" : "closed";
}

function normalizeFileStatus(status: string): ChangedFile["status"] {
  if (status === "added" || status === "modified" || status === "removed" || status === "renamed" || status === "copied" || status === "changed" || status === "unchanged") {
    return status;
  }
  return "modified";
}

function normalizeCheckStatus(status: string): CheckRun["status"] {
  if (status === "queued" || status === "in_progress" || status === "completed" || status === "waiting" || status === "requested" || status === "pending") {
    return status;
  }
  return "unknown";
}

function normalizeCheckConclusion(conclusion: string): NonNullable<CheckRun["conclusion"]> {
  if (
    conclusion === "success" ||
    conclusion === "failure" ||
    conclusion === "neutral" ||
    conclusion === "cancelled" ||
    conclusion === "skipped" ||
    conclusion === "timed_out" ||
    conclusion === "action_required"
  ) {
    return conclusion;
  }
  return "unknown";
}

function repositoryFromSearchUrl(repositoryUrl?: string): RepositoryRef {
  const parts = repositoryUrl?.split("/") ?? [];
  const owner = parts.at(-2) ?? "unknown";
  const name = parts.at(-1) ?? "unknown";
  return {
    provider: "github",
    owner,
    name,
    fullName: `${owner}/${name}`,
    defaultBranch: "main",
    url: `https://github.com/${owner}/${name}`
  };
}

function languageFromPath(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  const languages: Record<string, string> = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    py: "python",
    rs: "rust",
    go: "go",
    rb: "ruby",
    java: "java",
    kt: "kotlin",
    c: "c",
    h: "c",
    cpp: "cpp",
    hpp: "cpp",
    css: "css",
    html: "html",
    md: "markdown",
    json: "json",
    yml: "yaml",
    yaml: "yaml"
  };
  return extension ? languages[extension] : undefined;
}

function isLikelyGenerated(path: string): boolean {
  return /(^|\/)(dist|build|vendor|generated|__generated__)\//.test(path) || /\.(lock|min\.js|snap)$/.test(path);
}
