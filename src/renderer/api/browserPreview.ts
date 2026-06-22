import type { KrtApi } from "../../preload/index.js";
import { krtUpdateFeedUrl } from "../../shared/releases.js";
import type { AppSettings, PullRequestBundle, PullRequestDetail, PullRequestSummary, ReviewTour } from "../../shared/schemas.js";

const repository = {
  provider: "github" as const,
  owner: "kol",
  name: "review-tool",
  fullName: "kol/review-tool",
  defaultBranch: "main",
  url: "https://github.com/kol/review-tool"
};
const previewUpdateFeedUrl = krtUpdateFeedUrl("darwin", "arm64", "0.1.0");

const pullRequest: PullRequestDetail = {
  provider: "github",
  id: "preview-pr",
  number: 128,
  repository,
  title: "Implement review workspace architecture",
  state: "open",
  draft: false,
  url: "https://github.com/kol/review-tool/pull/128",
  author: { login: "kol" },
  labels: ["desktop", "review"],
  reviewers: [{ login: "reviewer" }],
  baseRef: "main",
  headRef: "architecture-plan",
  headSha: "abc123def456",
  baseSha: "def456abc123",
  additions: 412,
  deletions: 73,
  changedFileCount: 4,
  commentCount: 3,
  updatedAt: "2026-05-22T14:30:00.000Z",
  createdAt: "2026-05-22T13:00:00.000Z",
  body: "Adds the Electron shell, provider abstraction, typed IPC, review workspace, AI tour, and local cache foundations.",
  isFromFork: false
};

const bundle: PullRequestBundle = {
  detail: pullRequest,
  mode: "light",
  changedFiles: [
    {
      path: "src/main/ipcHandlers.ts",
      status: "added",
      additions: 137,
      deletions: 0,
      changes: 137,
      patch: "@@ -0,0 +1,4 @@\n+export function registerIpcHandlers() {\n+  // typed IPC registration\n+  return true;\n+}",
      language: "typescript",
      isLarge: false,
      isGenerated: false,
      reviewStatus: "unreviewed",
      annotations: 1,
      diagnostics: 0
    },
    {
      path: "src/renderer/components/ReviewWorkspace.tsx",
      status: "added",
      additions: 92,
      deletions: 0,
      changes: 92,
      patch: "@@ -0,0 +1,4 @@\n+export function ReviewWorkspace() {\n+  return <main />;\n+}",
      language: "tsx",
      isLarge: false,
      isGenerated: false,
      reviewStatus: "commented",
      annotations: 2,
      diagnostics: 0
    },
    {
      path: "src/shared/schemas.ts",
      status: "modified",
      additions: 121,
      deletions: 18,
      changes: 139,
      patch: "@@ -1,3 +1,4 @@\n import { z } from \"zod\";\n+export const pullRequestSchema = z.object({});",
      language: "typescript",
      isLarge: false,
      isGenerated: false,
      reviewStatus: "unreviewed",
      annotations: 0,
      diagnostics: 1
    },
    {
      path: "package-lock.json",
      status: "modified",
      additions: 62,
      deletions: 55,
      changes: 117,
      language: "json",
      isLarge: true,
      isGenerated: true,
      reviewStatus: "viewed",
      annotations: 0,
      diagnostics: 0
    }
  ],
  timeline: [
    {
      id: "activity-1",
      kind: "comment",
      actor: { login: "reviewer" },
      title: "Initial pass",
      body: "The process split is clear. The next review should focus on checkout failure paths and AI provider configuration.",
      createdAt: "2026-05-22T14:32:00.000Z",
      severity: "info",
      reactions: []
    }
  ],
  reviewThreads: [
    {
      id: "thread-1",
      provider: "github",
      repository,
      pullNumber: 128,
      path: "src/main/ipcHandlers.ts",
      line: 42,
      resolved: false,
      outdated: false,
      comments: [
        {
          id: "comment-1",
          threadId: "thread-1",
          author: { login: "reviewer" },
          body: "Validate both request and response payloads here.",
          createdAt: "2026-05-22T14:33:00.000Z",
          isBot: false,
          viewerCanUpdate: false,
          viewerCanDelete: false,
          reactions: []
        }
      ]
    }
  ],
  checks: [
    {
      id: "check-1",
      provider: "github",
      name: "typecheck",
      status: "completed",
      conclusion: "success",
      startedAt: "2026-05-22T14:34:00.000Z",
      completedAt: "2026-05-22T14:35:00.000Z"
    }
  ]
};

const tour: ReviewTour = {
  id: "preview-tour",
  provider: "github",
  repository,
  pullNumber: pullRequest.number,
  headSha: pullRequest.headSha,
  generatedAt: "2026-05-22T14:36:00.000Z",
  model: "browser-preview",
  chapters: [
    {
      id: "chapter-1",
      title: "Trusted desktop boundary",
      summary: "Main, preload, and renderer responsibilities are separated with typed IPC.",
      files: ["src/main/ipcHandlers.ts", "src/shared/schemas.ts"],
      diffAnchors: [{ path: "src/main/ipcHandlers.ts", side: "right" }],
      changeStats: { additions: 258, deletions: 18, files: 2 },
      riskLevel: "medium",
      riskReasons: ["IPC contract changes affect every renderer call."],
      reviewChecklist: ["Check every handler validates renderer input.", "Confirm errors remain typed and user-facing."],
      dependencies: [],
      generatedAt: "2026-05-22T14:36:00.000Z",
      model: "browser-preview",
      headSha: pullRequest.headSha
    },
    {
      id: "chapter-2",
      title: "Review workspace surfaces",
      summary: "Diff, tree, overview, tour, storyboard, editor, settings, and extensions views are wired.",
      files: ["src/renderer/components/ReviewWorkspace.tsx"],
      diffAnchors: [{ path: "src/renderer/components/ReviewWorkspace.tsx", side: "right" }],
      changeStats: { additions: 92, deletions: 0, files: 1 },
      riskLevel: "low",
      riskReasons: [],
      reviewChecklist: ["Open a PR from search.", "Switch between overview, review, tour, storyboard, and editor modes."],
      dependencies: ["chapter-1"],
      generatedAt: "2026-05-22T14:36:00.000Z",
      model: "browser-preview",
      headSha: pullRequest.headSha
    }
  ],
  graph: {
    nodes: [
      { id: "chapter-1", label: "Trusted desktop boundary", riskLevel: "medium", files: ["src/main/ipcHandlers.ts"] },
      { id: "chapter-2", label: "Review workspace surfaces", riskLevel: "low", files: ["src/renderer/components/ReviewWorkspace.tsx"] }
    ],
    edges: [{ id: "edge-1", from: "chapter-1", to: "chapter-2", relation: "dependency", confidence: 0.7, source: "deterministic" }]
  },
  riskSignals: [
    {
      id: "risk-1",
      level: "medium",
      title: "IPC boundary",
      files: ["src/main/ipcHandlers.ts"],
      reason: "Renderer access depends on this validation layer."
    }
  ]
};

export function createBrowserPreviewApi(): KrtApi {
  const settings: AppSettings = {
    appearance: { accentColor: "#4f46e5", density: "compact" },
    data: { preferredMode: "auto", managedRepoStorage: null, worktreeCacheSizeGb: 20, localRepos: [] },
    ai: {
      enabled: false,
      provider: "disabled",
      model: "",
      keyProvider: "keychain",
      keyCommand: "",
      thinkingEnabled: true,
      maxOutputTokens: 16_000,
      thinkingBudgetTokens: 8_000
    },
    github: { configured: false, login: null, tokenProvider: "keychain" },
    updates: { enabled: false, channel: "stable", feedUrl: null },
    extensions: {},
    pinnedRepos: []
  };
  let previewAiKeyConfigured = false;

  const copySettings = (): AppSettings => ({
    appearance: { ...settings.appearance },
    data: { ...settings.data },
    ai: { ...settings.ai },
    github: { ...settings.github },
    updates: { ...settings.updates },
    extensions: { ...settings.extensions },
    pinnedRepos: [...settings.pinnedRepos]
  });

  return {
    app: {
      onCloseSubTab: () => () => undefined,
      onOpenPreferences: () => () => undefined
    },
    auth: {
      getStatus: async () => ({
        github: settings.github.configured && settings.github.login ? { provider: "github", id: settings.github.login, login: settings.github.login, configured: true, scopes: [] } : null,
        ai: {
          configured:
            settings.ai.keyProvider === "keychain"
              ? previewAiKeyConfigured
              : Boolean(settings.ai.keyCommand) || settings.ai.keyProvider === "environment"
        }
      }),
      saveGitHubToken: async () => {
        settings.github = { configured: true, login: "preview", tokenProvider: "keychain" };
        return { provider: "github", id: "preview", login: "preview", configured: true, scopes: [] };
      },
      clearGitHubToken: async () => {
        settings.github = { configured: false, login: null, tokenProvider: "keychain" };
        return { cleared: true };
      },
      saveAiKey: async () => {
        settings.ai = { ...settings.ai, keyProvider: "keychain" };
        previewAiKeyConfigured = true;
        return { configured: true };
      },
      clearAiKey: async () => {
        previewAiKeyConfigured = false;
        return { cleared: true };
      }
    },
    settings: {
      get: async () => copySettings(),
      update: async (input) => {
        settings.appearance = { ...settings.appearance, ...input.appearance };
        settings.data = { ...settings.data, ...input.data };
        settings.ai = { ...settings.ai, ...input.ai };
        settings.github = { ...settings.github, ...input.github };
        settings.updates = { ...settings.updates, ...input.updates };
        settings.extensions = { ...settings.extensions, ...input.extensions };
        if (input.pinnedRepos) {
          settings.pinnedRepos = [...input.pinnedRepos];
        }
        return copySettings();
      }
    },
    updates: {
      getStatus: async () => ({
        enabled: false,
        configured: true,
        channel: "stable",
        state: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        feedUrl: previewUpdateFeedUrl,
        message: "Update available."
      }),
      check: async () => ({
        enabled: false,
        configured: true,
        channel: "stable",
        state: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        feedUrl: previewUpdateFeedUrl,
        message: "Update available."
      }),
      installDownloaded: async () => ({
        enabled: false,
        configured: true,
        channel: "stable",
        state: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        feedUrl: previewUpdateFeedUrl,
        message: "Update available."
      })
    },
    cache: {
      getStats: async () => ({
        prCache: { entryCount: 1, totalBytes: 1024, oldestUpdatedAt: pullRequest.updatedAt, newestUpdatedAt: pullRequest.updatedAt },
        providerResponses: { entryCount: 4, totalBytes: 4096, oldestUpdatedAt: pullRequest.updatedAt, newestUpdatedAt: pullRequest.updatedAt },
        aiTours: { entryCount: 1, totalBytes: 2048, oldestUpdatedAt: tour.generatedAt, newestUpdatedAt: tour.generatedAt },
        performanceMeasurements: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null }
      }),
      cleanup: async (input) => ({
        dryRun: input.dryRun ?? false,
        prCache: { deletedCount: 0, freedBytes: 0 },
        providerResponses: { deletedCount: 0, freedBytes: 0 },
        aiTours: { deletedCount: 0, freedBytes: 0 },
        performanceMeasurements: { deletedCount: 0, freedBytes: 0 }
      })
    },
    diagnostics: {
      getSnapshot: async () => ({
        generatedAt: "2026-05-22T14:38:00.000Z",
        appVersion: "0.1.0",
        platform: "browser-preview",
        paths: {
          root: "/preview",
          cache: "/preview/cache",
          logs: "/preview/logs",
          indexes: "/preview/indexes"
        },
        settings: {
          appearance: settings.appearance,
          data: settings.data,
          ai: {
            enabled: settings.ai.enabled,
            provider: settings.ai.provider,
            model: settings.ai.model,
            baseUrlConfigured: Boolean(settings.ai.baseUrl),
            keyProvider: settings.ai.keyProvider,
            keyCommandConfigured: Boolean(settings.ai.keyCommand)
          },
          github: settings.github,
          updates: settings.updates,
          enabledExtensionCount: 1
        },
        cache: {
          prCache: { entryCount: 1, totalBytes: 1024, oldestUpdatedAt: pullRequest.updatedAt, newestUpdatedAt: pullRequest.updatedAt },
          providerResponses: { entryCount: 4, totalBytes: 4096, oldestUpdatedAt: pullRequest.updatedAt, newestUpdatedAt: pullRequest.updatedAt },
          aiTours: { entryCount: 1, totalBytes: 2048, oldestUpdatedAt: tour.generatedAt, newestUpdatedAt: tour.generatedAt },
          performanceMeasurements: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null }
        },
        worktrees: { count: 0, activeCount: 0, totalBytes: 0 },
        recentPerformance: [],
        operations: [],
        updates: {
          enabled: false,
          configured: true,
          channel: "stable",
          state: "available",
          currentVersion: "0.1.0",
          availableVersion: "0.2.0",
          feedUrl: previewUpdateFeedUrl,
          message: "Update available."
        }
      })
    },
    providers: {
      fetchUser: async () => ({ provider: "github", id: "preview", login: "preview", configured: true, scopes: [] })
    },
    repos: {
      getCloneInfo: async (input) => ({
        repository: input.repository,
        htmlUrl: input.repository.url ?? `https://github.com/${input.repository.fullName}`,
        cloneUrl: `https://github.com/${input.repository.fullName}.git`,
        sshUrl: `git@github.com:${input.repository.fullName}.git`,
        defaultBranch: input.repository.defaultBranch ?? "main"
      }),
      selectMode: async () => ({ mode: "light", reason: "Browser preview uses Light/API mode." }),
      checkoutPullRequest: async () => ({ operationId: "preview-operation", mode: "managed", worktreePath: "/preview/worktree" }),
      releaseWorktree: async () => ({ released: true }),
      deleteWorktree: async () => ({ deleted: true, worktree: null }),
      listManagedWorktrees: async () => [],
      cleanupWorktrees: async (input) => ({
        deleted: [],
        retained: [],
        deletedCount: 0,
        retainedCount: 0,
        freedBytes: 0,
        dryRun: input.dryRun ?? false
      }),
      onWorkspaceFileChange: () => () => undefined,
      searchRepositories: async () => []
    },
    ui: {
      browseDirectory: async () => ({ path: null }),
      listDirectory: async () => [],
      detectLocalRepo: async () => ({ fullName: null })
    },
    pullRequests: {
      search: async () => [summaryFromBundle(bundle)],
      open: async () => bundle,
      startOpen: async () => ({ operationId: "preview-open-operation" }),
      openResult: async () => bundle,
      refresh: async () => bundle,
      startRefresh: async () => ({ operationId: "preview-refresh-operation" }),
      refreshResult: async () => bundle,
      changedFiles: async () => bundle.changedFiles,
      filePatch: async (input) => ({
        provider: "github",
        repository: input.repository,
        pullNumber: input.number,
        path: input.path,
        patch: bundle.changedFiles.find((file) => file.path === input.path)?.patch ?? "",
        headSha: input.headSha,
        isLarge: Boolean(bundle.changedFiles.find((file) => file.path === input.path)?.isLarge)
      }),
      fileContent: async (input) => ({
        provider: "github",
        repository: input.repository,
        path: input.path,
        ref: input.ref,
        contents: `// ${input.path}\nexport const preview = true;\n`,
        encoding: "utf-8",
        isLarge: false
      }),
      timeline: async () => bundle.timeline,
      reviewThreads: async () => bundle.reviewThreads,
      checks: async () => bundle.checks
    },
    comments: {
      postIssueComment: async (input) => ({
        id: "preview-issue-comment",
        author: { login: "preview" },
        body: input.body,
        createdAt: new Date().toISOString(),
        isBot: false,
        viewerCanUpdate: true,
        viewerCanDelete: true,
        reactions: []
      }),
      replyToReviewThread: async (input) => ({
        id: "preview-thread-reply",
        threadId: input.threadId,
        author: { login: "preview" },
        body: input.body,
        createdAt: new Date().toISOString(),
        isBot: false,
        viewerCanUpdate: true,
        viewerCanDelete: true,
        reactions: []
      }),
      updateReviewComment: async (input) => ({
        id: input.commentId,
        threadId: input.threadId,
        author: { login: "preview" },
        body: input.body,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        isBot: false,
        viewerCanUpdate: true,
        viewerCanDelete: true,
        reactions: []
      }),
      deleteReviewComment: async (input) => ({
        threadId: input.threadId,
        commentId: input.commentId,
        deleted: true
      }),
      toggleReaction: async (input) => [
        { content: input.content, count: input.add ? 1 : 0, viewerHasReacted: input.add }
      ]
    },
    reviews: {
      resolveThread: async (input) => ({
        id: input.threadId,
        provider: "github",
        repository: input.repository,
        pullNumber: input.number,
        resolved: true,
        outdated: false,
        comments: []
      }),
      reopenThread: async (input) => ({
        id: input.threadId,
        provider: "github",
        repository: input.repository,
        pullNumber: input.number,
        resolved: false,
        outdated: false,
        comments: []
      }),
      submit: async (input) => ({
        id: "preview-review",
        provider: "github",
        repository: input.repository,
        pullNumber: input.pullNumber,
        event: input.event,
        body: input.body ?? "",
        submittedAt: new Date().toISOString()
      })
    },
    trees: {
      loadWorkspaceTree: async (input) => ({
        repository: input.repository,
        headSha: input.headSha,
        worktreePath: "/preview/worktree",
        paths: ["src/main/ipcHandlers.ts", "src/renderer/components/ReviewWorkspace.tsx", "src/shared/schemas.ts", "package-lock.json"]
      }),
      searchWorkspaceText: async (input) => ({
        repository: input.repository,
        headSha: input.headSha,
        query: input.query,
        searchedFiles: 3,
        skippedFiles: 0,
        truncated: false,
        results: input.query.trim()
          ? [
              {
                path: "src/renderer/components/ReviewWorkspace.tsx",
                matches: [{ lineNumber: 12, lineText: "export function ReviewWorkspace(): React.JSX.Element {" }]
              }
            ]
          : []
      })
    },
    lsp: {
      startForWorktree: async (input) => ({
        id: "preview-lsp",
        repository: input.repository,
        headSha: input.headSha,
        worktreePath: "/preview/worktree",
        status: "degraded",
        activeExtensions: [],
        unavailableExtensions: [{ id: "language-server", reason: "Browser preview does not run a language server process." }],
        capabilities: [],
        startedAt: new Date().toISOString()
      }),
      stopForWorktree: async (input) => ({
        id: "preview-lsp",
        repository: input.repository,
        headSha: input.headSha,
        worktreePath: "/preview/worktree",
        status: "stopped",
        activeExtensions: [],
        unavailableExtensions: [],
        capabilities: [],
        startedAt: new Date().toISOString()
      }),
      getSession: async () => null,
      getDiagnostics: async () => [],
      getHover: async () => null,
      getDocumentSymbols: async () => [],
      getDefinition: async () => null
    },
    ai: {
      getCachedTour: async () => tour,
      generateTour: async () => tour,
      startTourGeneration: async () => ({ operationId: "preview-ai-tour-operation", cachedTour: tour }),
      listModels: async (input) => ({ provider: input?.provider ?? settings.ai.provider, models: [] })
    },
    extensions: {
      list: async () => [
        {
          id: "review-tools",
          name: "Review Tools",
          enabled: true,
          description: "Built-in review commands and AI anchors.",
          activationGlobs: ["**/*"],
          capabilities: ["comments", "ai-anchors"]
        }
      ],
      logs: async () => [
        {
          id: "preview-log",
          extensionId: "review-tools",
          level: "info",
          message: "Browser preview API initialized.",
          createdAt: "2026-05-22T14:37:00.000Z"
        }
      ],
      setEnabled: async (input) => ({
        id: input.extensionId,
        name: input.extensionId,
        enabled: input.enabled,
        description: "Browser preview extension.",
        activationGlobs: ["**/*"],
        capabilities: ["preview"]
      })
    },
    perf: {
      record: async () => ({ stored: true })
    },
    operations: {
      progressSnapshot: async (input) =>
        input.operationId === "preview-open-operation"
          ? {
              operationId: input.operationId,
              phase: "complete",
              message: "Opened preview pull request",
              percent: 100,
              done: true,
              cancelled: false
            }
          : input.operationId === "preview-refresh-operation"
            ? {
                operationId: input.operationId,
                phase: "complete",
                message: "Refreshed preview pull request",
                percent: 100,
                done: true,
                cancelled: false
              }
          : null,
      cancel: async (input) => ({
        operationId: input.operationId,
        phase: "cancelled",
        message: "Preview operation cancelled",
        percent: null,
        done: true,
        cancelled: true
      }),
      onProgress: () => () => undefined
    }
  };
}

function summaryFromBundle(input: PullRequestBundle): PullRequestSummary {
  const { body: _body, mergeable: _mergeable, maintainerCanModify: _maintainerCanModify, isFromFork: _isFromFork, ...summary } = input.detail;
  return {
    ...summary
  };
}
