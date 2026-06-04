import { z } from "zod";
import {
  activityEventSchema,
  aiKeyProviderSchema,
  aiProviderSchema,
  appSettingsSchema,
  cacheCleanupPolicySchema,
  cacheCleanupResultSchema,
  cacheStatsSchema,
  changedFileSchema,
  checkRunSchema,
  dataModeSchema,
  diagnosticsSnapshotSchema,
  extensionDescriptorSchema,
  extensionLogSchema,
  fileContentSchema,
  filePatchSchema,
  lspDefinitionSchema,
  lspDiagnosticSchema,
  lspDocumentSymbolSchema,
  lspHoverSchema,
  lspPositionSchema,
  lspSessionSchema,
  managedWorktreeSchema,
  operationProgressSchema,
  preferredDataModeSchema,
  providerAccountSchema,
  providerIdSchema,
  repositoryCloneInfoSchema,
  pullRequestBundleSchema,
  pullRequestDetailSchema,
  pullRequestSummarySchema,
  reactionContentSchema,
  reactionGroupSchema,
  repositoryRefSchema,
  reviewCommentSchema,
  reviewSubmissionResultSchema,
  reviewSubmissionSchema,
  reviewThreadSchema,
  reviewTourSchema,
  githubKeyProviderSchema,
  updateChannelSchema,
  updateStatusSchema,
  workspaceTextSearchResultSchema,
  worktreeCleanupResultSchema,
  workspaceTreeSchema
} from "./schemas.js";

const noInput = z.undefined();
const aiGenerateTourInput = z.object({
  pullRequest: pullRequestDetailSchema,
  changedFiles: z.array(changedFileSchema),
  timeline: z.array(activityEventSchema).default([]),
  reviewThreads: z.array(reviewThreadSchema).default([]),
  checks: z.array(checkRunSchema).default([]),
  force: z.boolean().default(false)
});
const pullRequestOpenInput = z.object({
  repository: repositoryRefSchema,
  number: z.number().int().positive(),
  preferredMode: z.enum(["auto", "light", "managed"]).default("auto")
});
const pullRequestRefreshInput = z.object({
  repository: repositoryRefSchema,
  number: z.number().int().positive(),
  mode: dataModeSchema
});
const settingsUpdateInput = z.object({
  appearance: z
    .object({
      accentColor: z.string(),
      density: z.enum(["compact", "comfortable"])
    })
    .partial()
    .optional(),
  data: z
    .object({
      preferredMode: preferredDataModeSchema,
      managedRepoStorage: z.string().nullable(),
      worktreeCacheSizeGb: z.number().positive()
    })
    .partial()
    .optional(),
  ai: z
    .object({
      enabled: z.boolean(),
      provider: aiProviderSchema,
      model: z.string(),
      baseUrl: z.string().url().optional(),
      keyProvider: aiKeyProviderSchema,
      keyCommand: z.string(),
      thinkingEnabled: z.boolean(),
      maxOutputTokens: z.number().int().min(1_024).max(64_000),
      thinkingBudgetTokens: z.number().int().min(1_024).max(60_000)
    })
    .partial()
    .optional(),
  github: z
    .object({
      configured: z.boolean(),
      login: z.string().nullable(),
      tokenProvider: githubKeyProviderSchema
    })
    .partial()
    .optional(),
  updates: z
    .object({
      enabled: z.boolean(),
      channel: updateChannelSchema,
      feedUrl: z.string().url().nullable()
    })
    .partial()
    .optional(),
  extensions: z.record(z.string(), z.boolean()).optional(),
  pinnedRepos: z.array(z.string()).optional()
});

export const ipcContract = {
  "auth:getStatus": {
    input: noInput,
    output: z.object({
      github: providerAccountSchema.nullable(),
      ai: z.object({ configured: z.boolean() })
    })
  },
  "auth:saveGitHubToken": {
    input: z.object({ token: z.string().min(1) }),
    output: providerAccountSchema
  },
  "auth:clearGitHubToken": {
    input: noInput,
    output: z.object({ cleared: z.boolean() })
  },
  "auth:saveAiKey": {
    input: z.object({ key: z.string().min(1) }),
    output: z.object({ configured: z.boolean() })
  },
  "auth:clearAiKey": {
    input: noInput,
    output: z.object({ cleared: z.boolean() })
  },
  "settings:get": {
    input: noInput,
    output: appSettingsSchema
  },
  "settings:update": {
    input: settingsUpdateInput,
    output: appSettingsSchema
  },
  "updates:getStatus": {
    input: noInput,
    output: updateStatusSchema
  },
  "updates:check": {
    input: noInput,
    output: updateStatusSchema
  },
  "updates:installDownloaded": {
    input: noInput,
    output: updateStatusSchema
  },
  "cache:getStats": {
    input: noInput,
    output: cacheStatsSchema
  },
  "cache:cleanup": {
    input: cacheCleanupPolicySchema,
    output: cacheCleanupResultSchema
  },
  "diagnostics:getSnapshot": {
    input: noInput,
    output: diagnosticsSnapshotSchema
  },
  "providers:fetchUser": {
    input: z.object({ provider: providerIdSchema }),
    output: providerAccountSchema
  },
  "repos:getCloneInfo": {
    input: z.object({ repository: repositoryRefSchema }),
    output: repositoryCloneInfoSchema
  },
  "pullRequests:search": {
    input: z.object({
      provider: providerIdSchema.default("github"),
      query: z.string().min(1),
      owner: z.string().optional(),
      repo: z.string().optional(),
      limit: z.number().int().min(1).max(50).default(20)
    }),
    output: z.array(pullRequestSummarySchema)
  },
  "pullRequests:open": {
    input: pullRequestOpenInput,
    output: pullRequestBundleSchema
  },
  "pullRequests:startOpen": {
    input: pullRequestOpenInput,
    output: z.object({ operationId: z.string() })
  },
  "pullRequests:openResult": {
    input: z.object({ operationId: z.string() }),
    output: pullRequestBundleSchema.nullable()
  },
  "pullRequests:refresh": {
    input: pullRequestRefreshInput,
    output: pullRequestBundleSchema
  },
  "pullRequests:startRefresh": {
    input: pullRequestRefreshInput,
    output: z.object({ operationId: z.string() })
  },
  "pullRequests:refreshResult": {
    input: z.object({ operationId: z.string() }),
    output: pullRequestBundleSchema.nullable()
  },
  "pullRequests:changedFiles": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive()
    }),
    output: z.array(changedFileSchema)
  },
  "pullRequests:filePatch": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive(),
      path: z.string().min(1),
      headSha: z.string()
    }),
    output: filePatchSchema
  },
  "pullRequests:fileContent": {
    input: z.object({
      repository: repositoryRefSchema,
      path: z.string().min(1),
      ref: z.string()
    }),
    output: fileContentSchema
  },
  "trees:loadWorkspaceTree": {
    input: z.object({
      repository: repositoryRefSchema,
      headSha: z.string()
    }),
    output: workspaceTreeSchema
  },
  "trees:searchWorkspaceText": {
    input: z.object({
      repository: repositoryRefSchema,
      headSha: z.string(),
      query: z.string().min(1),
      maxResults: z.number().int().min(1).max(100).default(25),
      maxFiles: z.number().int().min(1).max(10_000).default(2_000),
      maxFileBytes: z.number().int().min(1_024).max(1_000_000).default(200_000)
    }),
    output: workspaceTextSearchResultSchema
  },
  "lsp:startForWorktree": {
    input: z.object({
      repository: repositoryRefSchema,
      headSha: z.string(),
      paths: z.array(z.string().min(1)).optional()
    }),
    output: lspSessionSchema
  },
  "lsp:stopForWorktree": {
    input: z.object({
      repository: repositoryRefSchema,
      headSha: z.string()
    }),
    output: lspSessionSchema.nullable()
  },
  "lsp:getSession": {
    input: z.object({
      repository: repositoryRefSchema,
      headSha: z.string()
    }),
    output: lspSessionSchema.nullable()
  },
  "lsp:getDiagnostics": {
    input: z.object({
      repository: repositoryRefSchema,
      headSha: z.string(),
      path: z.string().optional()
    }),
    output: z.array(lspDiagnosticSchema)
  },
  "lsp:getHover": {
    input: z.object({
      repository: repositoryRefSchema,
      headSha: z.string(),
      path: z.string().min(1),
      position: lspPositionSchema
    }),
    output: lspHoverSchema.nullable()
  },
  "lsp:getDocumentSymbols": {
    input: z.object({
      repository: repositoryRefSchema,
      headSha: z.string(),
      path: z.string().min(1)
    }),
    output: z.array(lspDocumentSymbolSchema)
  },
  "lsp:getDefinition": {
    input: z.object({
      repository: repositoryRefSchema,
      headSha: z.string(),
      path: z.string().min(1),
      position: lspPositionSchema
    }),
    output: lspDefinitionSchema.nullable()
  },
  "pullRequests:timeline": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive()
    }),
    output: z.array(activityEventSchema)
  },
  "pullRequests:reviewThreads": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive()
    }),
    output: z.array(reviewThreadSchema)
  },
  "pullRequests:checks": {
    input: z.object({
      repository: repositoryRefSchema,
      ref: z.string()
    }),
    output: z.array(checkRunSchema)
  },
  "comments:postIssueComment": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive(),
      body: z.string().min(1)
    }),
    output: reviewCommentSchema
  },
  "comments:replyToReviewThread": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive(),
      threadId: z.string().min(1),
      body: z.string().min(1)
    }),
    output: reviewCommentSchema
  },
  "comments:toggleReaction": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive(),
      subjectNodeId: z.string().min(1),
      content: reactionContentSchema,
      add: z.boolean()
    }),
    output: z.array(reactionGroupSchema)
  },
  "reviews:resolveThread": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive(),
      threadId: z.string().min(1)
    }),
    output: reviewThreadSchema
  },
  "reviews:reopenThread": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive(),
      threadId: z.string().min(1)
    }),
    output: reviewThreadSchema
  },
  "reviews:submit": {
    input: reviewSubmissionSchema,
    output: reviewSubmissionResultSchema
  },
  "repos:selectMode": {
    input: z.object({
      repository: repositoryRefSchema,
      preferredMode: z.enum(["auto", "light", "managed"]).default("auto"),
      headSha: z.string().optional()
    }),
    output: z.object({ mode: dataModeSchema, reason: z.string() })
  },
  "repos:checkoutPullRequest": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive(),
      headRef: z.string(),
      baseRef: z.string(),
      headSha: z.string()
    }),
    output: z.object({
      operationId: z.string(),
      mode: dataModeSchema,
      worktreePath: z.string().nullable()
    })
  },
  "repos:releaseWorktree": {
    input: z.object({
      repository: repositoryRefSchema,
      headSha: z.string()
    }),
    output: z.object({ released: z.boolean() })
  },
  "repos:deleteWorktree": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive(),
      headSha: z.string()
    }),
    output: z.object({
      deleted: z.boolean(),
      worktree: managedWorktreeSchema.nullable()
    })
  },
  "repos:listManagedWorktrees": {
    input: z.object({ repository: repositoryRefSchema.optional() }).optional(),
    output: z.array(managedWorktreeSchema)
  },
  "repos:cleanupWorktrees": {
    input: z.object({
      repository: repositoryRefSchema.optional(),
      maxEntries: z.number().int().min(0).optional(),
      maxBytes: z.number().int().nonnegative().optional(),
      dryRun: z.boolean().default(false)
    }),
    output: worktreeCleanupResultSchema
  },
  "ai:getCachedTour": {
    input: z.object({
      repository: repositoryRefSchema,
      number: z.number().int().positive(),
      headSha: z.string()
    }),
    output: reviewTourSchema.nullable()
  },
  "ai:generateTour": {
    input: aiGenerateTourInput,
    output: reviewTourSchema
  },
  "ai:startTourGeneration": {
    input: aiGenerateTourInput,
    output: z.object({
      operationId: z.string(),
      cachedTour: reviewTourSchema.nullable()
    })
  },
  "extensions:list": {
    input: noInput,
    output: z.array(extensionDescriptorSchema)
  },
  "extensions:logs": {
    input: z.object({ extensionId: z.string().optional() }).optional(),
    output: z.array(extensionLogSchema)
  },
  "extensions:setEnabled": {
    input: z.object({
      extensionId: z.string().min(1),
      enabled: z.boolean()
    }),
    output: extensionDescriptorSchema
  },
  "perf:record": {
    input: z.object({
      name: z.string(),
      durationMs: z.number().nonnegative(),
      metadata: z.record(z.string(), z.unknown()).default({})
    }),
    output: z.object({ stored: z.boolean() })
  },
  "operations:progressSnapshot": {
    input: z.object({ operationId: z.string() }),
    output: operationProgressSchema.nullable()
  },
  "operations:cancel": {
    input: z.object({ operationId: z.string() }),
    output: operationProgressSchema.nullable()
  }
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<TChannel extends IpcChannel> = z.input<IpcContract[TChannel]["input"]>;
export type IpcParsedInput<TChannel extends IpcChannel> = z.output<IpcContract[TChannel]["input"]>;
export type IpcOutput<TChannel extends IpcChannel> = z.output<IpcContract[TChannel]["output"]>;

export const closeSubTabEvent = "app:closeSubTab";
export const openSettingsEvent = "app:openSettings";
export const operationProgressEvent = "operations:progress";
export const workspaceFileChangeEvent = "repos:workspaceFileChange";
