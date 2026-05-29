import { contextBridge, ipcRenderer } from "electron";
import {
  closeSubTabEvent,
  openPreferencesEvent,
  operationProgressEvent,
  workspaceFileChangeEvent,
  type IpcChannel,
  type IpcInput,
  type IpcOutput
} from "../shared/ipc.js";
import {
  type OperationProgress,
  type TypedError,
  type WorkspaceFileChange
} from "../shared/schemas.js";

type IpcResponse<TChannel extends IpcChannel> =
  | { ok: true; data: IpcOutput<TChannel> }
  | { ok: false; error: TypedError };

async function invoke<TChannel extends IpcChannel>(
  channel: TChannel,
  ...args: undefined extends IpcInput<TChannel> ? [input?: IpcInput<TChannel>] : [input: IpcInput<TChannel>]
): Promise<IpcOutput<TChannel>> {
  const response = (await ipcRenderer.invoke(channel, args[0])) as IpcResponse<TChannel>;
  if (!response.ok) {
    throw response.error;
  }
  return response.data as IpcOutput<TChannel>;
}

const api = {
  app: {
    onCloseSubTab: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on(closeSubTabEvent, handler);
      return () => {
        ipcRenderer.off(closeSubTabEvent, handler);
      };
    },
    onOpenPreferences: (listener: () => void) => {
      const handler = () => listener();
      ipcRenderer.on(openPreferencesEvent, handler);
      return () => {
        ipcRenderer.off(openPreferencesEvent, handler);
      };
    }
  },
  auth: {
    getStatus: () => invoke("auth:getStatus"),
    saveGitHubToken: (token: string) => invoke("auth:saveGitHubToken", { token }),
    clearGitHubToken: () => invoke("auth:clearGitHubToken"),
    saveAiKey: (key: string) => invoke("auth:saveAiKey", { key }),
    clearAiKey: () => invoke("auth:clearAiKey")
  },
  settings: {
    get: () => invoke("settings:get"),
    update: (input: IpcInput<"settings:update">) => invoke("settings:update", input)
  },
  updates: {
    getStatus: () => invoke("updates:getStatus"),
    check: () => invoke("updates:check"),
    installDownloaded: () => invoke("updates:installDownloaded")
  },
  cache: {
    getStats: () => invoke("cache:getStats"),
    cleanup: (input: IpcInput<"cache:cleanup">) => invoke("cache:cleanup", input)
  },
  diagnostics: {
    getSnapshot: () => invoke("diagnostics:getSnapshot")
  },
  providers: {
    fetchUser: (input: IpcInput<"providers:fetchUser">) => invoke("providers:fetchUser", input)
  },
  repos: {
    getCloneInfo: (input: IpcInput<"repos:getCloneInfo">) => invoke("repos:getCloneInfo", input),
    selectMode: (input: IpcInput<"repos:selectMode">) => invoke("repos:selectMode", input),
    checkoutPullRequest: (input: IpcInput<"repos:checkoutPullRequest">) => invoke("repos:checkoutPullRequest", input),
    releaseWorktree: (input: IpcInput<"repos:releaseWorktree">) => invoke("repos:releaseWorktree", input),
    deleteWorktree: (input: IpcInput<"repos:deleteWorktree">) => invoke("repos:deleteWorktree", input),
    listManagedWorktrees: (input?: IpcInput<"repos:listManagedWorktrees">) => invoke("repos:listManagedWorktrees", input),
    cleanupWorktrees: (input: IpcInput<"repos:cleanupWorktrees">) => invoke("repos:cleanupWorktrees", input),
    onWorkspaceFileChange: (listener: (change: WorkspaceFileChange) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, rawChange: WorkspaceFileChange) =>
        listener(rawChange);
      ipcRenderer.on(workspaceFileChangeEvent, handler);
      return () => {
        ipcRenderer.off(workspaceFileChangeEvent, handler);
      };
    }
  },
  pullRequests: {
    search: (input: IpcInput<"pullRequests:search">) => invoke("pullRequests:search", input),
    open: (input: IpcInput<"pullRequests:open">) => invoke("pullRequests:open", input),
    startOpen: (input: IpcInput<"pullRequests:startOpen">) => invoke("pullRequests:startOpen", input),
    openResult: (input: IpcInput<"pullRequests:openResult">) => invoke("pullRequests:openResult", input),
    refresh: (input: IpcInput<"pullRequests:refresh">) => invoke("pullRequests:refresh", input),
    startRefresh: (input: IpcInput<"pullRequests:startRefresh">) => invoke("pullRequests:startRefresh", input),
    refreshResult: (input: IpcInput<"pullRequests:refreshResult">) => invoke("pullRequests:refreshResult", input),
    changedFiles: (input: IpcInput<"pullRequests:changedFiles">) => invoke("pullRequests:changedFiles", input),
    filePatch: (input: IpcInput<"pullRequests:filePatch">) => invoke("pullRequests:filePatch", input),
    fileContent: (input: IpcInput<"pullRequests:fileContent">) => invoke("pullRequests:fileContent", input),
    timeline: (input: IpcInput<"pullRequests:timeline">) => invoke("pullRequests:timeline", input),
    reviewThreads: (input: IpcInput<"pullRequests:reviewThreads">) => invoke("pullRequests:reviewThreads", input),
    checks: (input: IpcInput<"pullRequests:checks">) => invoke("pullRequests:checks", input)
  },
  comments: {
    postIssueComment: (input: IpcInput<"comments:postIssueComment">) => invoke("comments:postIssueComment", input),
    replyToReviewThread: (input: IpcInput<"comments:replyToReviewThread">) => invoke("comments:replyToReviewThread", input),
    updateReviewComment: (input: IpcInput<"comments:updateReviewComment">) => invoke("comments:updateReviewComment", input),
    deleteReviewComment: (input: IpcInput<"comments:deleteReviewComment">) => invoke("comments:deleteReviewComment", input),
    toggleReaction: (input: IpcInput<"comments:toggleReaction">) => invoke("comments:toggleReaction", input)
  },
  reviews: {
    resolveThread: (input: IpcInput<"reviews:resolveThread">) => invoke("reviews:resolveThread", input),
    reopenThread: (input: IpcInput<"reviews:reopenThread">) => invoke("reviews:reopenThread", input),
    submit: (input: IpcInput<"reviews:submit">) => invoke("reviews:submit", input)
  },
  trees: {
    loadWorkspaceTree: (input: IpcInput<"trees:loadWorkspaceTree">) => invoke("trees:loadWorkspaceTree", input),
    searchWorkspaceText: (input: IpcInput<"trees:searchWorkspaceText">) => invoke("trees:searchWorkspaceText", input)
  },
  lsp: {
    startForWorktree: (input: IpcInput<"lsp:startForWorktree">) => invoke("lsp:startForWorktree", input),
    stopForWorktree: (input: IpcInput<"lsp:stopForWorktree">) => invoke("lsp:stopForWorktree", input),
    getSession: (input: IpcInput<"lsp:getSession">) => invoke("lsp:getSession", input),
    getDiagnostics: (input: IpcInput<"lsp:getDiagnostics">) => invoke("lsp:getDiagnostics", input),
    getHover: (input: IpcInput<"lsp:getHover">) => invoke("lsp:getHover", input),
    getDocumentSymbols: (input: IpcInput<"lsp:getDocumentSymbols">) => invoke("lsp:getDocumentSymbols", input),
    getDefinition: (input: IpcInput<"lsp:getDefinition">) => invoke("lsp:getDefinition", input)
  },
  ai: {
    getCachedTour: (input: IpcInput<"ai:getCachedTour">) => invoke("ai:getCachedTour", input),
    generateTour: (input: IpcInput<"ai:generateTour">) => invoke("ai:generateTour", input),
    startTourGeneration: (input: IpcInput<"ai:startTourGeneration">) => invoke("ai:startTourGeneration", input)
  },
  extensions: {
    list: () => invoke("extensions:list"),
    logs: (input?: IpcInput<"extensions:logs">) => invoke("extensions:logs", input),
    setEnabled: (input: IpcInput<"extensions:setEnabled">) => invoke("extensions:setEnabled", input)
  },
  perf: {
    record: (input: IpcInput<"perf:record">) => invoke("perf:record", input)
  },
  operations: {
    progressSnapshot: (input: IpcInput<"operations:progressSnapshot">) => invoke("operations:progressSnapshot", input),
    cancel: (input: IpcInput<"operations:cancel">) => invoke("operations:cancel", input),
    onProgress: (listener: (progress: OperationProgress) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, progress: OperationProgress) => listener(progress);
      ipcRenderer.on(operationProgressEvent, handler);
      return () => {
        ipcRenderer.off(operationProgressEvent, handler);
      };
    }
  }
};

contextBridge.exposeInMainWorld("krt", api);

export type KrtApi = typeof api;
