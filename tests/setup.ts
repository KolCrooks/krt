import "@testing-library/jest-dom/vitest";
import { krtUpdateFeedUrl } from "../src/shared/releases.js";

const emptyAsync = async () => undefined;
const testUpdateFeedUrl = krtUpdateFeedUrl("darwin", "arm64", "0.1.0");

if (typeof window !== "undefined") {
  Object.defineProperty(window, "krt", {
  value: {
    app: {
      onCloseSubTab: () => () => undefined,
      onOpenPreferences: () => () => undefined
    },
    auth: {
      getStatus: async () => ({ github: null, ai: { configured: false } }),
      saveGitHubToken: emptyAsync,
      clearGitHubToken: async () => ({ cleared: true }),
      saveAiKey: async () => ({ configured: true }),
      clearAiKey: async () => ({ cleared: true })
    },
    settings: {
      get: async () => ({
        appearance: { accentColor: "#4f46e5", density: "compact" },
        data: { preferredMode: "auto", managedRepoStorage: null, worktreeCacheSizeGb: 20 },
        ai: { enabled: false, provider: "disabled", model: "", keyProvider: "keychain", keyCommand: "" },
        github: { configured: false, login: null, tokenProvider: "keychain" },
        updates: { enabled: false, channel: "stable", feedUrl: null },
        extensions: {}
      }),
      update: emptyAsync
    },
    updates: {
      getStatus: async () => ({
        enabled: false,
        configured: true,
        channel: "stable",
        state: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        feedUrl: testUpdateFeedUrl,
        message: "Update available."
      }),
      check: async () => ({
        enabled: false,
        configured: true,
        channel: "stable",
        state: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        feedUrl: testUpdateFeedUrl,
        message: "Update available."
      }),
      installDownloaded: async () => ({
        enabled: false,
        configured: true,
        channel: "stable",
        state: "available",
        currentVersion: "0.1.0",
        availableVersion: "0.2.0",
        feedUrl: testUpdateFeedUrl,
        message: "Update available."
      })
    },
    cache: {
      getStats: async () => ({
        prCache: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
        providerResponses: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
        aiTours: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
        performanceMeasurements: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null }
      }),
      cleanup: async (input: { dryRun?: boolean }) => ({
        dryRun: input.dryRun ?? false,
        prCache: { deletedCount: 0, freedBytes: 0 },
        providerResponses: { deletedCount: 0, freedBytes: 0 },
        aiTours: { deletedCount: 0, freedBytes: 0 },
        performanceMeasurements: { deletedCount: 0, freedBytes: 0 }
      })
    },
    diagnostics: {
      getSnapshot: async () => ({
        generatedAt: "2026-05-22T00:00:00.000Z",
        appVersion: "0.1.0",
        platform: "test",
        paths: { root: "/test", cache: "/test/cache", logs: "/test/logs", indexes: "/test/indexes" },
        settings: {
          appearance: { accentColor: "#4f46e5", density: "compact" },
          data: { preferredMode: "auto", managedRepoStorage: null, worktreeCacheSizeGb: 20 },
          ai: { enabled: false, provider: "disabled", model: "", baseUrlConfigured: false, keyProvider: "keychain", keyCommandConfigured: false },
          github: { configured: false, login: null, tokenProvider: "keychain" },
          updates: { enabled: false, channel: "stable", feedUrl: null },
          enabledExtensionCount: 0
        },
        cache: {
          prCache: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
          providerResponses: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
          aiTours: { entryCount: 0, totalBytes: 0, oldestUpdatedAt: null, newestUpdatedAt: null },
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
          feedUrl: testUpdateFeedUrl,
          message: "Update available."
        }
      })
    },
    providers: {
      fetchUser: emptyAsync
    },
    repos: {
      getCloneInfo: emptyAsync,
      selectMode: async () => ({ mode: "light", reason: "test" }),
      checkoutPullRequest: emptyAsync,
      releaseWorktree: async () => ({ released: true }),
      deleteWorktree: async () => ({ deleted: true, worktree: null }),
      listManagedWorktrees: async () => [],
      cleanupWorktrees: async (input: { dryRun?: boolean }) => ({
        deleted: [],
        retained: [],
        deletedCount: 0,
        retainedCount: 0,
        freedBytes: 0,
        dryRun: input.dryRun ?? false
      }),
      onWorkspaceFileChange: () => () => undefined
    },
    pullRequests: {
      search: async () => [],
      open: emptyAsync,
      startOpen: async () => ({ operationId: "test-open-operation" }),
      openResult: emptyAsync,
      refresh: emptyAsync,
      startRefresh: async () => ({ operationId: "test-refresh-operation" }),
      refreshResult: emptyAsync,
      changedFiles: async () => [],
      filePatch: emptyAsync,
      fileContent: emptyAsync,
      timeline: async () => [],
      reviewThreads: async () => [],
      checks: async () => []
    },
    comments: {
      postIssueComment: emptyAsync,
      replyToReviewThread: emptyAsync,
      updateReviewComment: emptyAsync,
      deleteReviewComment: emptyAsync,
      toggleReaction: async () => []
    },
    reviews: {
      resolveThread: emptyAsync,
      reopenThread: emptyAsync,
      submit: emptyAsync
    },
    trees: {
      loadWorkspaceTree: emptyAsync,
      searchWorkspaceText: emptyAsync
    },
    lsp: {
      startForWorktree: emptyAsync,
      stopForWorktree: async () => null,
      getSession: async () => null,
      getDiagnostics: async () => [],
      getHover: async () => null,
      getDocumentSymbols: async () => [],
      getDefinition: async () => null
    },
    ai: {
      getCachedTour: async () => null,
      generateTour: emptyAsync,
      startTourGeneration: async () => ({ operationId: "test-ai-tour-operation", cachedTour: null })
    },
    extensions: {
      list: async () => [],
      logs: async () => [],
      setEnabled: async (input: { extensionId: string; enabled: boolean }) => ({
        id: input.extensionId,
        name: input.extensionId,
        enabled: input.enabled,
        description: "Test extension",
        activationGlobs: ["**/*"],
        capabilities: []
      })
    },
    perf: {
      record: async () => ({ stored: true })
    },
    operations: {
      progressSnapshot: async (input: { operationId: string }) =>
        input.operationId === "test-open-operation"
          ? {
              operationId: input.operationId,
              phase: "complete",
              message: "Opened test pull request",
              percent: 100,
              done: true,
              cancelled: false
            }
          : input.operationId === "test-refresh-operation"
            ? {
                operationId: input.operationId,
                phase: "complete",
                message: "Refreshed test pull request",
                percent: 100,
                done: true,
                cancelled: false
              }
          : null,
      cancel: async () => null,
      onProgress: () => () => undefined
    }
  },
  writable: true
  });
}
