// @vitest-environment node
import { setTimeout as delay } from "node:timers/promises";
import { ipcMain } from "electron";
import { describe, expect, it, vi } from "vitest";
import { ipcContract } from "../../src/shared/ipc.js";
import { krtUpdateFeedUrl } from "../../src/shared/releases.js";
import { defaultAppSettings, type ChangedFile, type PullRequestDetail, type ReviewTour } from "../../src/shared/schemas.js";
import { AppError } from "../../src/main/errors.js";
import { createIpcExecutor, type IpcHandlerContext } from "../../src/main/ipcExecutor.js";
import { registerIpcHandlers } from "../../src/main/ipcHandlers.js";
import { OperationService } from "../../src/main/services/operationService.js";
import { openDatabase } from "../../src/main/services/database.js";
import { PerfService } from "../../src/main/services/perfService.js";

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn()
  }
}));

function createContext(overrides: Partial<IpcHandlerContext> = {}): IpcHandlerContext {
  return {
    settings: {
      get: vi.fn(() => defaultAppSettings),
      update: vi.fn(() => defaultAppSettings)
    },
    keychain: {
      getSecret: vi.fn(async () => null),
      setSecret: vi.fn(async () => undefined),
      deleteSecret: vi.fn(async () => undefined)
    },
    ...overrides
  } as unknown as IpcHandlerContext;
}

describe("createIpcExecutor", () => {
  it("validates input before invoking a channel handler", async () => {
    const get = vi.fn(() => defaultAppSettings);
    const executor = createIpcExecutor(
      createContext({
        settings: { get, update: vi.fn(() => defaultAppSettings) } as unknown as IpcHandlerContext["settings"]
      })
    );

    const result = await executor("settings:get", undefined, {});

    expect(result.ok).toBe(false);
    expect(get).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "validation_error",
        retryable: false
      });
    }
  });

  it("validates output before returning successful data", async () => {
    const get = vi.fn(() => ({ broken: true }));
    const executor = createIpcExecutor(
      createContext({
        settings: { get, update: vi.fn() } as unknown as IpcHandlerContext["settings"]
      })
    );

    const result = await executor("settings:get", undefined, undefined);

    expect(result.ok).toBe(false);
    expect(get).toHaveBeenCalledOnce();
    if (!result.ok) {
      expect(result.error.code).toBe("validation_error");
    }
  });

  it("normalizes application errors", async () => {
    const get = vi.fn(() => {
      throw new AppError("settings_unavailable", "Settings are unavailable.", { retryable: true });
    });
    const executor = createIpcExecutor(
      createContext({
        settings: { get, update: vi.fn() } as unknown as IpcHandlerContext["settings"]
      })
    );

    const result = await executor("settings:get", undefined, undefined);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatchObject({
        code: "settings_unavailable",
        message: "Settings are unavailable.",
        retryable: true
      });
    }
  });

  it("accepts deep partial settings updates without resetting sibling values", async () => {
    const update = vi.fn((input) => ({
      ...defaultAppSettings,
      github: { ...defaultAppSettings.github, ...input.github }
    }));
    const executor = createIpcExecutor(
      createContext({
        settings: { get: vi.fn(() => defaultAppSettings), update } as unknown as IpcHandlerContext["settings"]
      })
    );

    const result = await executor("settings:update", undefined, { github: { tokenProvider: "gh-cli" } });

    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledWith({ github: { tokenProvider: "gh-cli" } });
    if (result.ok) {
      expect(result.data.github).toMatchObject({ configured: false, login: null, tokenProvider: "gh-cli" });
    }
  });

  it("starts an updater check when auto update is enabled", async () => {
    const update = vi.fn((input) => ({
      ...defaultAppSettings,
      updates: { ...defaultAppSettings.updates, ...input.updates }
    }));
    const checkForUpdates = vi.fn(async () => ({
      enabled: true,
      configured: true,
      channel: "stable" as const,
      state: "checking" as const,
      currentVersion: "0.1.0",
      feedUrl: krtUpdateFeedUrl("darwin", "arm64", "0.1.0")
    }));
    const executor = createIpcExecutor(
      createContext({
        settings: { get: vi.fn(() => defaultAppSettings), update } as unknown as IpcHandlerContext["settings"],
        updates: { checkForUpdates } as unknown as IpcHandlerContext["updates"]
      })
    );

    const result = await executor("settings:update", undefined, { updates: { enabled: true } });

    expect(result.ok).toBe(true);
    expect(update).toHaveBeenCalledWith({ updates: { enabled: true } });
    expect(checkForUpdates).toHaveBeenCalledOnce();
  });

  it("restarts active language server sessions when an LSP extension enablement changes", async () => {
    const restartActiveSessionsForExtension = vi.fn(async () => []);
    const setEnabled = vi.fn((extensionId: string, enabled: boolean) => ({
      id: extensionId,
      name: "Rust Analyzer",
      enabled,
      description: "Rust language server.",
      activationGlobs: ["**/*.rs"],
      capabilities: ["diagnostics", "hover", "definition", "symbols"],
      contributes: {
        lsp: {
          command: { program: "rust-analyzer", args: [] },
          transport: "stdio" as const,
          languages: ["rust"],
          features: ["diagnostics" as const, "hover" as const, "definition" as const, "symbols" as const]
        }
      }
    }));
    const executor = createIpcExecutor(
      createContext({
        extensions: { setEnabled } as unknown as IpcHandlerContext["extensions"],
        lsp: { restartActiveSessionsForExtension } as unknown as IpcHandlerContext["lsp"]
      })
    );

    const result = await executor("extensions:setEnabled", undefined, {
      extensionId: "rust-analyzer",
      enabled: false
    });

    expect(result.ok).toBe(true);
    expect(setEnabled).toHaveBeenCalledWith("rust-analyzer", false);
    expect(restartActiveSessionsForExtension).toHaveBeenCalledWith("rust-analyzer");
  });

  it("stops the language server before deleting a managed worktree", async () => {
    const repository = repositoryFixture();
    const stopForWorktree = vi.fn(async () => null);
    const deleteWorktree = vi.fn(async () => ({
      deleted: true,
      worktree: {
        repository,
        number: 12,
        headSha: "abc123",
        worktreePath: "/tmp/krt-worktree",
        lastUsedAt: "2026-05-22T00:00:00.000Z",
        active: true,
        sizeBytes: 12
      }
    }));
    const executor = createIpcExecutor(
      createContext({
        repos: { deleteWorktree } as unknown as IpcHandlerContext["repos"],
        lsp: { stopForWorktree } as unknown as IpcHandlerContext["lsp"]
      })
    );

    const result = await executor("repos:deleteWorktree", undefined, { repository, number: 12, headSha: "abc123" });

    expect(result.ok).toBe(true);
    expect(stopForWorktree).toHaveBeenCalledWith(repository, "abc123");
    expect(deleteWorktree).toHaveBeenCalledWith({ repository, number: 12, headSha: "abc123" });
    expect(stopForWorktree.mock.invocationCallOrder[0]).toBeLessThan(deleteWorktree.mock.invocationCallOrder[0]);
  });

  it("strips changed-file patches from renderer-facing changed file responses", async () => {
    const repository = repositoryFixture();
    const executor = createIpcExecutor(
      createContext({
        providers: {
          get: vi.fn(async () => ({
            getChangedFiles: vi.fn(async () => [
              {
                path: "src/App.tsx",
                status: "modified",
                additions: 1,
                deletions: 0,
                changes: 1,
                patch: "@@ -1 +1 @@\n-old\n+new",
                isLarge: false,
                isGenerated: false,
                reviewStatus: "unreviewed",
                annotations: 0,
                diagnostics: 0
              }
            ])
          }))
        } as unknown as IpcHandlerContext["providers"]
      })
    );

    const result = await executor("pullRequests:changedFiles", undefined, { repository, number: 12 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data[0]?.patch).toBeUndefined();
    }
  });

  it("rehydrates cached patches before AI tour generation", async () => {
    const pullRequest = pullRequestFixture();
    const tour = tourFixture(pullRequest);
    const generateTour = vi.fn(async () => tour);
    const executor = createIpcExecutor(
      createContext({
        prCache: {
          hydrateChangedFilePatches: vi.fn((_repository, _number, _headSha, files) =>
            (files as ChangedFile[]).map((file) => ({ ...file, patch: "@@ -1 +1 @@\n-old\n+new" }))
          )
        } as unknown as IpcHandlerContext["prCache"],
        ai: {
          generateTour
        } as unknown as IpcHandlerContext["ai"]
      })
    );

    const result = await executor("ai:generateTour", undefined, {
      pullRequest,
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
      reviewThreads: [],
      checks: []
    });

    expect(result.ok).toBe(true);
    expect(generateTour).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFiles: [expect.objectContaining({ patch: expect.stringContaining("+new") })]
      })
    );
  });

  it("starts AI tour generation as a cancellable operation", async () => {
    const pullRequest = pullRequestFixture();
    const tour = tourFixture(pullRequest);
    const operations = new OperationService();
    const generateTour = vi.fn(async () => {
      await delay(10);
      return tour;
    });
    const executor = createIpcExecutor(
      createContext({
        operations,
        prCache: {
          hydrateChangedFilePatches: vi.fn((_repository, _number, _headSha, files) =>
            (files as ChangedFile[]).map((file) => ({ ...file, patch: "@@ -1 +1 @@\n-old\n+new" }))
          )
        } as unknown as IpcHandlerContext["prCache"],
        ai: {
          getCachedTour: vi.fn(() => null),
          generateTour
        } as unknown as IpcHandlerContext["ai"]
      })
    );

    const result = await executor("ai:startTourGeneration", undefined, {
      pullRequest,
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
      reviewThreads: [],
      checks: []
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.cachedTour).toBeNull();
    expect(operations.get(result.data.operationId)).toMatchObject({
      phase: "ai-tour",
      done: false
    });

    await waitForOperationDone(operations, result.data.operationId);

    expect(generateTour).toHaveBeenCalledWith(
      expect.objectContaining({
        changedFiles: [expect.objectContaining({ patch: expect.stringContaining("+new") })]
      }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function)
      })
    );
    expect(operations.get(result.data.operationId)).toMatchObject({
      phase: "complete",
      done: true,
      cancelled: false
    });
  });

  it("forces AI tour generation instead of returning a cached tour", async () => {
    const pullRequest = pullRequestFixture();
    const cachedTour = tourFixture(pullRequest);
    const generatedTour = { ...cachedTour, id: "generated-tour" };
    const operations = new OperationService();
    const generateTour = vi.fn(async () => generatedTour);
    const getCachedTour = vi.fn(() => cachedTour);
    const executor = createIpcExecutor(
      createContext({
        operations,
        prCache: {
          hydrateChangedFilePatches: vi.fn(
            (_repository: unknown, _number: unknown, _headSha: unknown, files: ChangedFile[]) => files
          )
        } as unknown as IpcHandlerContext["prCache"],
        ai: {
          getCachedTour,
          generateTour
        } as unknown as IpcHandlerContext["ai"]
      })
    );

    const result = await executor("ai:startTourGeneration", undefined, {
      pullRequest,
      changedFiles: [],
      timeline: [],
      reviewThreads: [],
      checks: [],
      force: true
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.data.cachedTour).toBeNull();
    expect(getCachedTour).not.toHaveBeenCalled();

    await waitForOperationDone(operations, result.data.operationId);

    expect(generateTour).toHaveBeenCalledWith(
      expect.objectContaining({ force: true }),
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        onProgress: expect.any(Function)
      })
    );
    expect(operations.get(result.data.operationId)).toMatchObject({
      phase: "complete",
      done: true,
      cancelled: false
    });
  });

  it("marks AI tour generation operations cancelled when the operation is aborted", async () => {
    const pullRequest = pullRequestFixture();
    const operations = new OperationService();
    const generateTour = vi.fn(async (_input: unknown, options?: { signal?: AbortSignal }) => {
      await delay(10);
      if (options?.signal?.aborted) {
        throw new AppError("operation_cancelled", "AI tour generation was cancelled.", { retryable: true });
      }
      return tourFixture(pullRequest);
    });
    const executor = createIpcExecutor(
      createContext({
        operations,
        prCache: {
          hydrateChangedFilePatches: vi.fn(
            (_repository: unknown, _number: unknown, _headSha: unknown, files: ChangedFile[]) => files
          )
        } as unknown as IpcHandlerContext["prCache"],
        ai: {
          getCachedTour: vi.fn(() => null),
          generateTour
        } as unknown as IpcHandlerContext["ai"]
      })
    );

    const result = await executor("ai:startTourGeneration", undefined, {
      pullRequest,
      changedFiles: [],
      timeline: [],
      reviewThreads: [],
      checks: []
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    operations.cancel(result.data.operationId);
    await waitForOperationDone(operations, result.data.operationId);

    expect(operations.get(result.data.operationId)).toMatchObject({
      phase: "cancelled",
      done: true,
      cancelled: true
    });
  });

  it("opens pull requests as cancellable operations and stores the result", async () => {
    const pullRequest = pullRequestFixture();
    const bundle = bundleFixture(pullRequest);
    const operations = new OperationService();
    const selectMode = vi.fn(() => ({ mode: "light" as const, reason: "test" }));
    const executor = createIpcExecutor(
      createContext({
        operations,
        repos: {
          selectMode
        } as unknown as IpcHandlerContext["repos"],
        providers: {
          get: vi.fn(async () => ({
            getPullRequest: vi.fn(async () => pullRequest),
            openPullRequest: vi.fn(async () => bundle)
          }))
        } as unknown as IpcHandlerContext["providers"],
        prCache: {
          get: vi.fn(() => null),
          put: vi.fn((nextBundle) => nextBundle)
        } as unknown as IpcHandlerContext["prCache"]
      })
    );

    const started = await executor("pullRequests:startOpen", undefined, {
      repository: pullRequest.repository,
      number: pullRequest.number,
      preferredMode: "auto"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    await waitForOperationDone(operations, started.data.operationId);
    expect(operations.get(started.data.operationId)).toMatchObject({ phase: "complete", done: true });

    const opened = await executor("pullRequests:openResult", undefined, { operationId: started.data.operationId });

    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.data?.detail.title).toBe("Patch cache PR");
    }
    expect(selectMode).toHaveBeenCalledWith(pullRequest.repository, "auto", pullRequest.headSha);
  });

  it("marks pull request open operations cancelled before storing a result", async () => {
    const pullRequest = pullRequestFixture();
    const operations = new OperationService();
    const executor = createIpcExecutor(
      createContext({
        operations,
        repos: {
          selectMode: vi.fn(() => ({ mode: "light", reason: "test" }))
        } as unknown as IpcHandlerContext["repos"],
        providers: {
          get: vi.fn(async () => ({
            getPullRequest: vi.fn(async () => {
              await delay(10);
              return pullRequest;
            }),
            openPullRequest: vi.fn(async () => bundleFixture(pullRequest))
          }))
        } as unknown as IpcHandlerContext["providers"],
        prCache: {
          get: vi.fn(() => null),
          put: vi.fn((nextBundle) => nextBundle)
        } as unknown as IpcHandlerContext["prCache"]
      })
    );

    const started = await executor("pullRequests:startOpen", undefined, {
      repository: pullRequest.repository,
      number: pullRequest.number,
      preferredMode: "auto"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    operations.cancel(started.data.operationId);
    await waitForOperationDone(operations, started.data.operationId);

    expect(operations.get(started.data.operationId)).toMatchObject({
      phase: "cancelled",
      done: true,
      cancelled: true
    });

    const opened = await executor("pullRequests:openResult", undefined, { operationId: started.data.operationId });
    expect(opened.ok).toBe(true);
    if (opened.ok) {
      expect(opened.data).toBeNull();
    }
  });

  it("refreshes pull requests as cancellable operations and stores the result", async () => {
    const pullRequest = pullRequestFixture();
    const bundle = bundleFixture(pullRequest);
    const operations = new OperationService();
    const executor = createIpcExecutor(
      createContext({
        operations,
        repos: {
          hasManagedWorktree: vi.fn(() => false)
        } as unknown as IpcHandlerContext["repos"],
        providers: {
          get: vi.fn(async () => ({
            openPullRequest: vi.fn(async () => bundle)
          }))
        } as unknown as IpcHandlerContext["providers"],
        prCache: {
          put: vi.fn((nextBundle) => nextBundle)
        } as unknown as IpcHandlerContext["prCache"]
      })
    );

    const started = await executor("pullRequests:startRefresh", undefined, {
      repository: pullRequest.repository,
      number: pullRequest.number,
      mode: "light"
    });

    expect(started.ok).toBe(true);
    if (!started.ok) {
      return;
    }
    await waitForOperationDone(operations, started.data.operationId);
    expect(operations.get(started.data.operationId)).toMatchObject({ phase: "complete", done: true });

    const refreshed = await executor("pullRequests:refreshResult", undefined, { operationId: started.data.operationId });

    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) {
      expect(refreshed.data?.detail.headSha).toBe(pullRequest.headSha);
    }
  });

  it("persists performance measurements for workspace tree loads", async () => {
    const repository = repositoryFixture();
    const perf = new PerfService(openDatabase(":memory:"));
    const executor = createIpcExecutor(
      createContext({
        perf,
        repos: {
          loadWorkspaceTree: vi.fn(async () => ({
            repository,
            headSha: "abc123",
            worktreePath: "/tmp/worktree",
            paths: ["src/App.tsx", "src/main.tsx"]
          }))
        } as unknown as IpcHandlerContext["repos"]
      })
    );

    const result = await executor("trees:loadWorkspaceTree", undefined, { repository, headSha: "abc123" });

    expect(result.ok).toBe(true);
    expect(perf.listRecent(1)[0]).toMatchObject({
      name: "trees.loadWorkspaceTree",
      metadata: {
        repository: "github:kol/repo",
        headSha: "abc123",
        pathCount: 2,
        worktreePath: "/tmp/worktree"
      }
    });
  });

  it("persists performance measurements for workspace text search", async () => {
    const repository = repositoryFixture();
    const perf = new PerfService(openDatabase(":memory:"));
    const executor = createIpcExecutor(
      createContext({
        perf,
        repos: {
          searchWorkspaceText: vi.fn(async () => ({
            repository,
            headSha: "abc123",
            query: "workspace",
            searchedFiles: 3,
            skippedFiles: 1,
            truncated: false,
            results: [
              {
                path: "src/App.tsx",
                matches: [{ lineNumber: 1, lineText: "workspace" }]
              }
            ]
          }))
        } as unknown as IpcHandlerContext["repos"]
      })
    );

    const result = await executor("trees:searchWorkspaceText", undefined, {
      repository,
      headSha: "abc123",
      query: "workspace"
    });

    expect(result.ok).toBe(true);
    expect(perf.listRecent(1)[0]).toMatchObject({
      name: "trees.searchWorkspaceText",
      metadata: {
        repository: "github:kol/repo",
        headSha: "abc123",
        searchedFiles: 3,
        skippedFiles: 1,
        resultCount: 1,
        truncated: false
      }
    });
  });
});

describe("registerIpcHandlers", () => {
  it("registers each IPC channel once while allowing context replacement", () => {
    const handle = vi.mocked(ipcMain.handle);

    registerIpcHandlers(createContext());
    registerIpcHandlers(
      createContext({
        settings: {
          get: vi.fn(() => ({
            ...defaultAppSettings,
            github: { configured: true, login: "replacement" }
          })),
          update: vi.fn(() => defaultAppSettings)
        } as unknown as IpcHandlerContext["settings"]
      })
    );

    expect(handle).toHaveBeenCalledTimes(Object.keys(ipcContract).length);
  });
});

function repositoryFixture() {
  return {
    provider: "github" as const,
    owner: "kol",
    name: "repo",
    fullName: "kol/repo"
  };
}

function pullRequestFixture(): PullRequestDetail {
  const repository = repositoryFixture();
  return {
    provider: "github",
    id: "1",
    number: 12,
    repository,
    title: "Patch cache PR",
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
  };
}

function tourFixture(pullRequest: PullRequestDetail): ReviewTour {
  return {
    id: "tour",
    provider: "github",
    repository: pullRequest.repository,
    pullNumber: pullRequest.number,
    headSha: pullRequest.headSha,
    generatedAt: "2026-05-22T00:00:00.000Z",
    model: "test",
    chapters: [],
    graph: { nodes: [], edges: [] },
    riskSignals: []
  };
}

function bundleFixture(pullRequest: PullRequestDetail) {
  return {
    detail: pullRequest,
    mode: "light" as const,
    changedFiles: [
      {
        path: "src/App.tsx",
        status: "modified" as const,
        additions: 1,
        deletions: 0,
        changes: 1,
        isLarge: false,
        isGenerated: false,
        reviewStatus: "unreviewed" as const,
        annotations: 0,
        diagnostics: 0
      }
    ],
    timeline: [],
    reviewThreads: [],
    checks: []
  };
}

async function waitForOperationDone(operations: OperationService, operationId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (operations.get(operationId)?.done) {
      return;
    }
    await delay(10);
  }
  throw new Error(`Timed out waiting for ${operationId}`);
}
