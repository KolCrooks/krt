import { isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dialog } from "electron";
import { ZodError } from "zod";
import { ipcContract, type IpcChannel, type IpcOutput, type IpcParsedInput } from "../shared/ipc.js";
import type { ProviderRegistry } from "./providers/providerRegistry.js";
import type { SettingsStore } from "./services/settingsStore.js";
import type { RepoService } from "./services/repoService.js";
import type { AiService } from "./services/aiService.js";
import type { ExtensionService } from "./services/extensionService.js";
import type { PerfService } from "./services/perfService.js";
import type { OperationService } from "./services/operationService.js";
import type { Keychain } from "./services/keychain.js";
import type { LspService } from "./services/lspService.js";
import type { PrCacheService } from "./services/prCacheService.js";
import type { ProviderResponseCache } from "./services/providerResponseCache.js";
import type { UpdateService } from "./services/updateService.js";
import type { MaintenanceService } from "./services/maintenanceService.js";
import type { DiagnosticsService } from "./services/diagnosticsService.js";
import { githubPullScope } from "./providers/githubProvider.js";
import { AppError, toErrorPayload } from "./errors.js";
import { stripChangedFilePatches } from "./services/prCacheService.js";

export interface IpcHandlerContext {
  providers: ProviderRegistry;
  settings: SettingsStore;
  repos: RepoService;
  ai: AiService;
  extensions: ExtensionService;
  perf: PerfService;
  operations: OperationService;
  keychain: Keychain;
  lsp: LspService;
  prCache: PrCacheService;
  providerCache: ProviderResponseCache;
  updates: UpdateService;
  maintenance: MaintenanceService;
  diagnostics: DiagnosticsService;
}

type Handler<TChannel extends IpcChannel> = (
  input: IpcParsedInput<TChannel>,
  event: unknown
) => Promise<IpcOutput<TChannel>> | IpcOutput<TChannel>;

type HandlerMap = { [TChannel in IpcChannel]: Handler<TChannel> };
type IpcErrorPayload = ReturnType<typeof toErrorPayload>;

export type IpcResult<TChannel extends IpcChannel = IpcChannel> =
  | { ok: true; data: IpcOutput<TChannel> }
  | { ok: false; error: IpcErrorPayload };

export type IpcExecutor = <TChannel extends IpcChannel>(
  channel: TChannel,
  event: unknown,
  rawInput: unknown
) => Promise<IpcResult<TChannel>>;

export function createIpcExecutor(context: IpcHandlerContext): IpcExecutor {
  const handlers = createIpcHandlers(context);
  return (channel, event, rawInput) => executeIpcHandler(handlers, channel, event, rawInput);
}

async function executeIpcHandler<TChannel extends IpcChannel>(
  handlers: HandlerMap,
  channel: TChannel,
  event: unknown,
  rawInput: unknown
): Promise<IpcResult<TChannel>> {
  try {
    const contract = ipcContract[channel];
    const input = contract.input.parse(rawInput) as IpcParsedInput<TChannel>;
    const output = await handlers[channel](input, event);
    return { ok: true, data: contract.output.parse(output) as IpcOutput<TChannel> };
  } catch (error) {
    const payload =
      error instanceof ZodError
        ? {
            code: "validation_error",
            message: "Invalid IPC payload.",
            retryable: false,
            details: error.issues
          }
        : toErrorPayload(error);
    return { ok: false, error: payload };
  }
}

function createIpcHandlers(context: IpcHandlerContext): HandlerMap {
  const pullRequestOperationResults = new Map<string, IpcOutput<"pullRequests:open">>();

  return {
    "auth:getStatus": async () => {
      const settings = context.settings.get();
      const githubToken = await context.providers.getGitHubToken();
      let github: IpcOutput<"auth:getStatus">["github"] = null;
      if (githubToken) {
        try {
          const provider = await context.providers.get("github");
          github = await provider.fetchUser();
          context.settings.update({ github: { configured: true, login: github.login } });
        } catch {
          github =
            settings.github.configured && settings.github.login
              ? {
                  provider: "github",
                  id: settings.github.login,
                  login: settings.github.login,
                  configured: true,
                  scopes: []
                }
              : null;
        }
      }

      return {
        github,
        ai: {
          configured: await context.ai.hasConfiguredApiKey()
        }
      };
    },

    "auth:saveGitHubToken": async (input) => {
      await context.keychain.setSecret("GITHUB_TOKEN", input.token);
      context.settings.update({ github: { tokenProvider: "keychain" } });
      const provider = await context.providers.get("github");
      const account = await provider.fetchUser();
      context.settings.update({ github: { configured: true, login: account.login, tokenProvider: "keychain" } });
      return account;
    },

    "auth:clearGitHubToken": async () => {
      await context.keychain.deleteSecret("GITHUB_TOKEN");
      context.settings.update({ github: { configured: false, login: null, tokenProvider: "keychain" } });
      return { cleared: true };
    },

    "auth:saveAiKey": async (input) => {
      await context.keychain.setSecret("AI_API_KEY", input.key);
      context.settings.update({ ai: { keyProvider: "keychain" } });
      return { configured: true };
    },

    "auth:clearAiKey": async () => {
      await context.keychain.deleteSecret("AI_API_KEY");
      return { cleared: true };
    },

    "settings:get": () => context.settings.get(),
    "settings:update": (input) => {
      const updated = context.settings.update(input);
      if (input.updates?.enabled) {
        void context.updates.checkForUpdates().catch(() => {
          // Saving the setting should not fail just because the updater cannot check immediately.
        });
      }
      return updated;
    },
    "updates:getStatus": () => context.updates.getStatus(),
    "updates:check": () => context.updates.checkForUpdates(),
    "updates:installDownloaded": () => context.updates.installDownloadedUpdate(),
    "cache:getStats": () => context.maintenance.getCacheStats(),
    "cache:cleanup": (input) => context.maintenance.cleanupCaches(input),
    "diagnostics:getSnapshot": () => context.diagnostics.getSnapshot(),

    "providers:fetchUser": async (input) => {
      const provider = await context.providers.get(input.provider);
      return provider.fetchUser();
    },

    "repos:getCloneInfo": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      return provider.getCloneInfo(input.repository);
    },

    "pullRequests:search": async (input) => {
      const provider = await context.providers.get(input.provider);
      return provider.listPullRequests(input);
    },

    "pullRequests:open": (input) =>
      measureHandler(
        context,
        "pullRequests.open",
        { repository: repositoryKey(input.repository), number: input.number, preferredMode: input.preferredMode },
        () => loadPullRequestBundle(context, input),
        pullRequestBundleMetadata
      ),

    "pullRequests:startOpen": (input) => {
      const operationId = context.operations.create("pullRequests.open", "Opening pull request");
      const startedAt = performance.now();
      void (async () => {
        try {
          const bundle = await loadPullRequestBundle(context, input, operationId);
          const current = context.operations.get(operationId);
          if (current?.cancelled) {
            context.operations.markFailed(operationId, "Pull request open was cancelled");
            recordPerformance(context, "pullRequests.open", startedAt, {
              repository: repositoryKey(input.repository),
              number: input.number,
              preferredMode: input.preferredMode,
              cancelled: true
            });
            return;
          }

          pullRequestOperationResults.set(operationId, bundle);
          context.operations.update({
            operationId,
            phase: "complete",
            message: `Opened ${bundle.detail.repository.fullName} #${bundle.detail.number}`,
            percent: 100,
            done: true,
            cancelled: false
          });
          recordPerformance(context, "pullRequests.open", startedAt, {
            repository: repositoryKey(input.repository),
            number: input.number,
            preferredMode: input.preferredMode,
            ...pullRequestBundleMetadata(bundle)
          });
        } catch (error) {
          context.operations.markFailed(
            operationId,
            context.operations.get(operationId)?.cancelled ? "Pull request open was cancelled" : "Pull request open failed",
            error instanceof Error ? error.message : String(error)
          );
          recordPerformance(context, "pullRequests.open", startedAt, {
            repository: repositoryKey(input.repository),
            number: input.number,
            preferredMode: input.preferredMode,
            failed: true,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })();
      return { operationId };
    },

    "pullRequests:openResult": (input) => {
      const bundle = pullRequestOperationResults.get(input.operationId) ?? null;
      if (bundle) {
        pullRequestOperationResults.delete(input.operationId);
      }
      return bundle;
    },

    "pullRequests:refresh": (input) =>
      measureHandler(
        context,
        "pullRequests.refresh",
        { repository: repositoryKey(input.repository), number: input.number, mode: input.mode },
        () => refreshPullRequestBundle(context, input),
        pullRequestBundleMetadata
      ),

    "pullRequests:startRefresh": (input) => {
      const operationId = context.operations.create("pullRequests.refresh", "Refreshing pull request");
      const startedAt = performance.now();
      void (async () => {
        try {
          const bundle = await refreshPullRequestBundle(context, input, operationId);
          const current = context.operations.get(operationId);
          if (current?.cancelled) {
            context.operations.markFailed(operationId, "Pull request refresh was cancelled");
            recordPerformance(context, "pullRequests.refresh", startedAt, {
              repository: repositoryKey(input.repository),
              number: input.number,
              mode: input.mode,
              cancelled: true
            });
            return;
          }

          pullRequestOperationResults.set(operationId, bundle);
          context.operations.update({
            operationId,
            phase: "complete",
            message: `Refreshed ${bundle.detail.repository.fullName} #${bundle.detail.number}`,
            percent: 100,
            done: true,
            cancelled: false
          });
          recordPerformance(context, "pullRequests.refresh", startedAt, {
            repository: repositoryKey(input.repository),
            number: input.number,
            mode: input.mode,
            ...pullRequestBundleMetadata(bundle)
          });
        } catch (error) {
          context.operations.markFailed(
            operationId,
            context.operations.get(operationId)?.cancelled ? "Pull request refresh was cancelled" : "Pull request refresh failed",
            error instanceof Error ? error.message : String(error)
          );
          recordPerformance(context, "pullRequests.refresh", startedAt, {
            repository: repositoryKey(input.repository),
            number: input.number,
            mode: input.mode,
            failed: true,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })();
      return { operationId };
    },

    "pullRequests:refreshResult": (input) => {
      const bundle = pullRequestOperationResults.get(input.operationId) ?? null;
      if (bundle) {
        pullRequestOperationResults.delete(input.operationId);
      }
      return bundle;
    },

    "pullRequests:changedFiles": (input) =>
      measureHandler(
        context,
        "pullRequests.changedFiles",
        { repository: repositoryKey(input.repository), number: input.number },
        async () => {
          const provider = await context.providers.get(input.repository.provider);
          return stripChangedFilePatches(await provider.getChangedFiles(input.repository, input.number));
        },
        (files) => ({
          changedFileCount: files.length,
          largeFileCount: files.filter((file) => file.isLarge).length
        })
      ),

    "pullRequests:filePatch": async (input) => {
      const measured = await measureHandler(
        context,
        "pullRequests.filePatch",
        { repository: repositoryKey(input.repository), number: input.number, headSha: input.headSha, path: input.path },
        async () => {
          const localPatch = await context.repos.getLocalFilePatch(input.repository, input.number, input.path, input.headSha);
          if (localPatch?.patch) {
            return { patch: localPatch, source: "local" };
          }

          const cachedPatch = context.prCache.getFilePatch(input.repository, input.number, input.path, input.headSha);
          if (cachedPatch) {
            return { patch: cachedPatch, source: "cache" };
          }

          const provider = await context.providers.get(input.repository.provider);
          return { patch: await provider.getPatch(input.repository, input.number, input.path, input.headSha), source: "provider" };
        },
        ({ patch, source }) => ({
          source,
          isLarge: patch.isLarge,
          patchBytes: patch.patch.length
        })
      );
      return measured.patch;
    },

    "pullRequests:fileContent": async (input) => {
      const measured = await measureHandler(
        context,
        "pullRequests.fileContent",
        { repository: repositoryKey(input.repository), ref: input.ref, path: input.path },
        async () => {
          const localContent = await context.repos.getLocalFileContent(input.repository, input.path, input.ref);
          if (localContent) {
            return { content: localContent, source: "local" };
          }
          if (isAbsolute(input.path)) {
            throw new AppError("local_file_not_found", "The requested local definition file is not available.");
          }

          const provider = await context.providers.get(input.repository.provider);
          return { content: await provider.getFileContent(input.repository, input.path, input.ref), source: "provider" };
        },
        ({ content, source }) => ({
          source,
          isLarge: content.isLarge,
          contentBytes: content.contents.length
        })
      );
      return measured.content;
    },

    "trees:loadWorkspaceTree": (input) =>
      measureHandler(
        context,
        "trees.loadWorkspaceTree",
        { repository: repositoryKey(input.repository), headSha: input.headSha },
        () => context.repos.loadWorkspaceTree(input.repository, input.headSha),
        (tree) => ({
          pathCount: tree.paths.length,
          worktreePath: tree.worktreePath
        })
      ),

    "trees:searchWorkspaceText": (input) =>
      measureHandler(
        context,
        "trees.searchWorkspaceText",
        { repository: repositoryKey(input.repository), headSha: input.headSha, query: input.query.trim().length > 0 },
        () =>
          context.repos.searchWorkspaceText(input.repository, input.headSha, input.query, {
            maxResults: input.maxResults,
            maxFiles: input.maxFiles,
            maxFileBytes: input.maxFileBytes
          }),
        (result) => ({
          searchedFiles: result.searchedFiles,
          skippedFiles: result.skippedFiles,
          resultCount: result.results.length,
          truncated: result.truncated
        })
      ),

    "lsp:startForWorktree": (input) => context.lsp.startForWorktree(input.repository, input.headSha, input.paths),
    "lsp:stopForWorktree": (input) => context.lsp.stopForWorktree(input.repository, input.headSha),
    "lsp:getSession": (input) => context.lsp.getSession(input.repository, input.headSha),
    "lsp:getDiagnostics": (input) => context.lsp.getDiagnostics(input.repository, input.headSha, input.path),
    "lsp:getHover": (input) => context.lsp.getHover(input.repository, input.headSha, input.path, input.position),
    "lsp:getDocumentSymbols": (input) => context.lsp.getDocumentSymbols(input.repository, input.headSha, input.path),
    "lsp:getDefinition": (input) =>
      context.lsp.getDefinition(input.repository, input.headSha, input.path, input.position),

    "pullRequests:timeline": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      return provider.getPullRequestTimeline(input.repository, input.number);
    },

    "pullRequests:reviewThreads": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      return provider.getReviewThreads(input.repository, input.number);
    },

    "pullRequests:checks": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      return provider.getChecks(input.repository, input.ref);
    },

    "comments:postIssueComment": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      const comment = await provider.postIssueComment(input.repository, input.number, input.body);
      context.prCache.invalidate(input.repository, input.number);
      context.providerCache.invalidatePrefix(input.repository.provider, githubPullScope(input.repository, input.number));
      return comment;
    },

    "comments:replyToReviewThread": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      const comment = await provider.replyToReviewThread(input.repository, input.threadId, input.body);
      context.prCache.invalidate(input.repository, input.number);
      context.providerCache.invalidatePrefix(input.repository.provider, githubPullScope(input.repository, input.number));
      return comment;
    },

    "comments:updateReviewComment": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      const comment = await provider.updateReviewComment(input.repository, input.commentId, input.body);
      context.prCache.invalidate(input.repository, input.number);
      context.providerCache.invalidatePrefix(input.repository.provider, githubPullScope(input.repository, input.number));
      return { ...comment, threadId: comment.threadId ?? input.threadId };
    },

    "comments:deleteReviewComment": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      const result = await provider.deleteReviewComment(input.repository, input.commentId);
      context.prCache.invalidate(input.repository, input.number);
      context.providerCache.invalidatePrefix(input.repository.provider, githubPullScope(input.repository, input.number));
      return { threadId: input.threadId, commentId: result.commentId, deleted: result.deleted };
    },

    "comments:toggleReaction": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      const reactions = await provider.toggleReaction(input.subjectNodeId, input.content, input.add);
      context.prCache.invalidate(input.repository, input.number);
      context.providerCache.invalidatePrefix(input.repository.provider, githubPullScope(input.repository, input.number));
      return reactions;
    },

    "reviews:resolveThread": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      const thread = await provider.resolveReviewThread(input.repository, input.number, input.threadId);
      context.prCache.invalidate(input.repository, input.number);
      context.providerCache.invalidatePrefix(input.repository.provider, githubPullScope(input.repository, input.number));
      return thread;
    },

    "reviews:reopenThread": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      const thread = await provider.reopenReviewThread(input.repository, input.number, input.threadId);
      context.prCache.invalidate(input.repository, input.number);
      context.providerCache.invalidatePrefix(input.repository.provider, githubPullScope(input.repository, input.number));
      return thread;
    },

    "reviews:submit": async (input) => {
      const provider = await context.providers.get(input.repository.provider);
      const result = await provider.submitReview(input);
      context.prCache.invalidate(input.repository, input.pullNumber);
      context.providerCache.invalidatePrefix(input.repository.provider, githubPullScope(input.repository, input.pullNumber));
      return result;
    },

    "repos:selectMode": (input) => {
      const selection = context.repos.selectMode(input.repository, input.preferredMode, input.headSha);
      return selection;
    },
    "repos:checkoutPullRequest": (input) => context.repos.checkoutPullRequest(input),
    "repos:releaseWorktree": (input) => context.repos.releaseWorktree(input.repository, input.headSha),
    "repos:deleteWorktree": async (input) => {
      try {
        await Promise.resolve(context.lsp.stopForWorktree(input.repository, input.headSha));
      } catch {
        // Worktree deletion should proceed even if a degraded language server is already gone.
      }
      return context.repos.deleteWorktree(input);
    },
    "repos:listManagedWorktrees": (input) => context.repos.listManagedWorktrees(input?.repository),
    "repos:cleanupWorktrees": (input) => context.repos.cleanupWorktrees(input),

    "ai:listModels": async (input) => {
      const provider = input?.provider ?? context.settings.get().ai.provider;
      return { provider, models: await context.ai.listModels(provider) };
    },
    "ai:getCachedTour": (input) => context.ai.getCachedTour(input.repository, input.number, input.headSha),
    "ai:generateTour": (input) =>
      measureHandler(
        context,
        "ai.generateTour",
        {
          repository: repositoryKey(input.pullRequest.repository),
          number: input.pullRequest.number,
          headSha: input.pullRequest.headSha,
          changedFileCount: input.changedFiles.length
        },
        () =>
          context.ai.generateTour({
            ...input,
            changedFiles: context.prCache.hydrateChangedFilePatches(
              input.pullRequest.repository,
              input.pullRequest.number,
              input.pullRequest.headSha,
              input.changedFiles
            )
          }),
        (tour) => ({
          model: tour.model,
          chapterCount: tour.chapters.length,
          riskSignalCount: tour.riskSignals.length
        })
      ),
    "ai:startTourGeneration": (input) => {
      const operationId = context.operations.create("ai-tour", "Preparing AI tour generation");
      const cachedTour = input.force
        ? null
        : context.ai.getCachedTour(
            input.pullRequest.repository,
            input.pullRequest.number,
            input.pullRequest.headSha
          );

      if (cachedTour) {
        context.operations.update({
          operationId,
          phase: "complete",
          message: "AI tour loaded from cache",
          percent: 100,
          done: true,
          cancelled: false
        });
        return { operationId, cachedTour };
      }

      const hydratedInput = {
        ...input,
        changedFiles: context.prCache.hydrateChangedFilePatches(
          input.pullRequest.repository,
          input.pullRequest.number,
          input.pullRequest.headSha,
          input.changedFiles
        )
      };

      const startedAt = performance.now();
      void (async () => {
        const runStats: { turns?: number; outputTokens?: number; stoppedReason?: string } = {};
        try {
          const tour = await context.ai.generateTour(hydratedInput, {
            signal: context.operations.signal(operationId),
            onStats: (stats) => {
              runStats.turns = stats.turns;
              runStats.outputTokens = stats.outputTokens;
              runStats.stoppedReason = stats.stoppedReason;
            },
            onProgress: (progress) =>
              context.operations.update({
                operationId,
                phase: progress.phase,
                message: progress.message,
                percent: progress.percent,
                done: false,
                cancelled: context.operations.get(operationId)?.cancelled ?? false,
                tour: progress.tour,
                activity: progress.activity
              })
          });
          const current = context.operations.get(operationId);
          if (current?.cancelled) {
            context.operations.markFailed(operationId, "AI tour generation was cancelled");
            recordPerformance(context, "ai.generateTour", startedAt, {
              repository: repositoryKey(input.pullRequest.repository),
              number: input.pullRequest.number,
              headSha: input.pullRequest.headSha,
              changedFileCount: input.changedFiles.length,
              cancelled: true
            });
            return;
          }
          context.operations.update({
            operationId,
            phase: "complete",
            message: `AI tour generated with ${tour.chapters.length} chapters`,
            percent: 100,
            done: true,
            cancelled: false
          });
          recordPerformance(context, "ai.generateTour", startedAt, {
            repository: repositoryKey(input.pullRequest.repository),
            number: input.pullRequest.number,
            headSha: input.pullRequest.headSha,
            changedFileCount: input.changedFiles.length,
            model: tour.model,
            chapterCount: tour.chapters.length,
            riskSignalCount: tour.riskSignals.length,
            inlineCommentCount: tour.chapters.reduce((sum, chapter) => sum + chapter.diffAnchors.filter((anchor) => anchor.note).length, 0),
            edgeCount: tour.graph.edges.length,
            deterministicEdgeCount: tour.graph.edges.filter((edge) => edge.source === "deterministic").length,
            ...(runStats.turns !== undefined
              ? { agentTurns: runStats.turns, agentOutputTokens: runStats.outputTokens, agentStop: runStats.stoppedReason }
              : {})
          });
        } catch (error) {
          const cancelled = context.operations.get(operationId)?.cancelled ?? false;
          const failureMessage = cancelled
            ? "AI tour generation was cancelled"
            : error instanceof AppError
              ? error.message
              : "AI tour generation failed";
          context.operations.markFailed(
            operationId,
            failureMessage,
            error instanceof Error ? error.message : String(error)
          );
          recordPerformance(context, "ai.generateTour", startedAt, {
            repository: repositoryKey(input.pullRequest.repository),
            number: input.pullRequest.number,
            headSha: input.pullRequest.headSha,
            changedFileCount: input.changedFiles.length,
            failed: true,
            error: error instanceof Error ? error.message : String(error)
          });
        }
      })();

      return { operationId, cachedTour: null };
    },

    "extensions:list": () => context.extensions.list(),
    "extensions:logs": (input) => context.extensions.getLogs(input?.extensionId),
    "extensions:setEnabled": async (input) => {
      const extension = context.extensions.setEnabled(input.extensionId, input.enabled);
      if (extension.contributes?.lsp) {
        await context.lsp.restartActiveSessionsForExtension(extension.id);
      }
      return extension;
    },
    "perf:record": (input) => context.perf.record(input),
    "operations:progressSnapshot": (input) => context.operations.get(input.operationId),
    "operations:cancel": (input) => context.operations.cancel(input.operationId),

    "ui:browseDirectory": async (input) => {
      const result = await dialog.showOpenDialog({
        properties: ["openDirectory"],
        ...(input?.defaultPath ? { defaultPath: input.defaultPath } : {})
      });
      return { path: result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0] };
    },

    "repos:searchRepositories": async (input) => {
      const token = await context.providers.getGitHubToken();
      if (!token) return [];
      const provider = await context.providers.get("github");
      return provider.searchRepositories(input.query);
    },

    "ui:detectLocalRepo": async (input) => {
      try {
        const p = input.path.replace(/^~/, homedir());
        for (const configPath of [join(p, ".git", "config"), join(p, "config")]) {
          if (!existsSync(configPath)) continue;
          const text = await readFile(configPath, "utf8");
          const match = text.match(/url\s*=\s*(?:https?:\/\/github\.com\/|git@github\.com:)([^/\s]+\/[^/\s]+?)(?:\.git)?\s*$/m);
          if (match) return { fullName: match[1] };
        }
      } catch { /* ignore */ }
      return { fullName: null };
    },

    "ui:listDirectory": async (input) => {
      const partialPath = input.path.replace(/^~/, homedir());
      const lastSlash = partialPath.lastIndexOf("/");
      const dir = lastSlash > 0 ? partialPath.slice(0, lastSlash) : lastSlash === 0 ? "/" : ".";
      const prefix = lastSlash >= 0 ? partialPath.slice(lastSlash + 1) : partialPath;
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        const candidates = entries.filter(
          (e) => (e.isDirectory() || e.isSymbolicLink()) && (prefix === "" || e.name.startsWith(prefix))
        );
        const results: string[] = [];
        for (const e of candidates) {
          if (results.length >= 12) break;
          if (e.isDirectory()) {
            results.push(join(dir, e.name));
          } else {
            try {
              const s = await stat(join(dir, e.name));
              if (s.isDirectory()) results.push(join(dir, e.name));
            } catch { /* broken symlink */ }
          }
        }
        return results;
      } catch {
        return [];
      }
    }
  };
}

async function loadPullRequestBundle(
  context: IpcHandlerContext,
  input: IpcParsedInput<"pullRequests:open">,
  operationId?: string
): Promise<IpcOutput<"pullRequests:open">> {
  updateOperationProgress(context, operationId, "prepare", "Preparing pull request open", 5);
  assertOperationNotCancelled(context, operationId);
  const provider = await context.providers.get(input.repository.provider);

  updateOperationProgress(context, operationId, "detail", "Loading pull request metadata", 20);
  assertOperationNotCancelled(context, operationId);
  const detail = await provider.getPullRequest(input.repository, input.number);
  assertOperationNotCancelled(context, operationId);
  const selection = context.repos.selectMode(input.repository, input.preferredMode, detail.headSha);

  updateOperationProgress(context, operationId, "cache", "Checking local pull request cache", 40);
  const cached = context.prCache.get(input.repository, input.number, detail.headSha);
  if (cached) {
    return { ...cached, detail, mode: selection.mode };
  }

  updateOperationProgress(context, operationId, "fetch", "Loading pull request review data", 55);
  const bundle = await provider.openPullRequest(input.repository, input.number, selection.mode);
  assertOperationNotCancelled(context, operationId);

  updateOperationProgress(context, operationId, "cache", "Persisting pull request cache", 85);
  return context.prCache.put({ ...bundle, detail, mode: selection.mode });
}

async function refreshPullRequestBundle(
  context: IpcHandlerContext,
  input: IpcParsedInput<"pullRequests:refresh">,
  operationId?: string
): Promise<IpcOutput<"pullRequests:refresh">> {
  updateOperationProgress(context, operationId, "fetch", "Refreshing pull request review data", 20);
  assertOperationNotCancelled(context, operationId);
  const provider = await context.providers.get(input.repository.provider);
  const bundle = await provider.openPullRequest(input.repository, input.number, input.mode);
  assertOperationNotCancelled(context, operationId);
  const mode = context.repos.hasManagedWorktree(input.repository, bundle.detail.headSha) ? "managed" : "light";

  updateOperationProgress(context, operationId, "cache", "Persisting refreshed pull request", 85);
  return context.prCache.put({ ...bundle, mode });
}

function assertOperationNotCancelled(context: IpcHandlerContext, operationId: string | undefined): void {
  if (operationId) {
    context.operations.assertNotCancelled(operationId);
  }
}

function updateOperationProgress(
  context: IpcHandlerContext,
  operationId: string | undefined,
  phase: string,
  message: string,
  percent: number
): void {
  if (!operationId) {
    return;
  }

  context.operations.update({
    operationId,
    phase,
    message,
    percent,
    done: false,
    cancelled: context.operations.get(operationId)?.cancelled ?? false
  });
}

function pullRequestBundleMetadata(bundle: IpcOutput<"pullRequests:open">): Record<string, unknown> {
  return {
    mode: bundle.mode,
    headSha: bundle.detail.headSha,
    changedFileCount: bundle.changedFiles.length,
    timelineCount: bundle.timeline.length,
    reviewThreadCount: bundle.reviewThreads.length,
    checkCount: bundle.checks.length
  };
}

async function measureHandler<TOutput>(
  context: IpcHandlerContext,
  name: string,
  metadata: Record<string, unknown>,
  action: () => Promise<TOutput> | TOutput,
  successMetadata: (output: TOutput) => Record<string, unknown> = () => ({})
): Promise<TOutput> {
  const startedAt = performance.now();
  try {
    const output = await action();
    recordPerformance(context, name, startedAt, {
      ...metadata,
      ...successMetadata(output)
    });
    return output;
  } catch (error) {
    recordPerformance(context, name, startedAt, {
      ...metadata,
      failed: true,
      error: error instanceof Error ? error.message : String(error)
    });
    throw error;
  }
}

function recordPerformance(
  context: IpcHandlerContext,
  name: string,
  startedAt: number,
  metadata: Record<string, unknown>
): void {
  try {
    context.perf?.record({
      name,
      durationMs: Math.max(0, performance.now() - startedAt),
      metadata
    });
  } catch {
    // Performance telemetry must never change user-visible command behavior.
  }
}

function repositoryKey(repository: { provider: string; fullName: string }): string {
  return `${repository.provider}:${repository.fullName}`;
}
