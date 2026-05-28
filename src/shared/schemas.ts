import { z } from "zod";

export const providerIdSchema = z.enum(["github"]);
export type ProviderId = z.infer<typeof providerIdSchema>;

export const dataModeSchema = z.enum(["light", "managed"]);
export type DataMode = z.infer<typeof dataModeSchema>;

export const preferredDataModeSchema = z.enum(["auto", "light", "managed"]);
export type PreferredDataMode = z.infer<typeof preferredDataModeSchema>;

export const actorSchema = z.object({
  login: z.string(),
  avatarUrl: z.string().url().optional(),
  url: z.string().url().optional(),
  type: z.string().optional()
});
export type Actor = z.infer<typeof actorSchema>;

export const repositoryRefSchema = z.object({
  provider: providerIdSchema,
  owner: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().min(1),
  defaultBranch: z.string().optional(),
  url: z.string().url().optional()
});
export type RepositoryRef = z.infer<typeof repositoryRefSchema>;

export const providerAccountSchema = z.object({
  provider: providerIdSchema,
  id: z.string(),
  login: z.string(),
  name: z.string().nullable().optional(),
  avatarUrl: z.string().url().optional(),
  scopes: z.array(z.string()).default([]),
  configured: z.boolean()
});
export type ProviderAccount = z.infer<typeof providerAccountSchema>;

export const pullRequestStateSchema = z.enum(["open", "closed", "merged"]);
export type PullRequestState = z.infer<typeof pullRequestStateSchema>;

export const pullRequestSummarySchema = z.object({
  provider: providerIdSchema,
  id: z.string(),
  number: z.number().int().positive(),
  repository: repositoryRefSchema,
  title: z.string(),
  state: pullRequestStateSchema,
  draft: z.boolean(),
  url: z.string().url(),
  author: actorSchema,
  labels: z.array(z.string()),
  reviewers: z.array(actorSchema),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  baseSha: z.string().nullable().optional(),
  additions: z.number().int().nonnegative().default(0),
  deletions: z.number().int().nonnegative().default(0),
  changedFileCount: z.number().int().nonnegative().default(0),
  commentCount: z.number().int().nonnegative().default(0),
  updatedAt: z.string(),
  createdAt: z.string()
});
export type PullRequestSummary = z.infer<typeof pullRequestSummarySchema>;

export const pullRequestDetailSchema = pullRequestSummarySchema.extend({
  body: z.string().default(""),
  mergeable: z.boolean().nullable().optional(),
  maintainerCanModify: z.boolean().optional(),
  isFromFork: z.boolean().default(false)
});
export type PullRequestDetail = z.infer<typeof pullRequestDetailSchema>;

export const changedFileStatusSchema = z.enum([
  "added",
  "modified",
  "removed",
  "renamed",
  "copied",
  "changed",
  "unchanged"
]);
export type ChangedFileStatus = z.infer<typeof changedFileStatusSchema>;

export const changedFileSchema = z.object({
  path: z.string().min(1),
  previousPath: z.string().optional(),
  status: changedFileStatusSchema,
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  changes: z.number().int().nonnegative(),
  patch: z.string().optional(),
  language: z.string().optional(),
  isLarge: z.boolean().default(false),
  isGenerated: z.boolean().default(false),
  reviewStatus: z.enum(["unreviewed", "viewed", "commented", "resolved"]).default("unreviewed"),
  annotations: z.number().int().nonnegative().default(0),
  diagnostics: z.number().int().nonnegative().default(0)
});
export type ChangedFile = z.infer<typeof changedFileSchema>;

export const filePatchSchema = z.object({
  provider: providerIdSchema,
  repository: repositoryRefSchema,
  pullNumber: z.number().int().positive(),
  path: z.string().min(1),
  patch: z.string(),
  headSha: z.string(),
  isLarge: z.boolean().default(false)
});
export type FilePatch = z.infer<typeof filePatchSchema>;

export const fileContentSchema = z.object({
  provider: providerIdSchema,
  repository: repositoryRefSchema,
  path: z.string().min(1),
  ref: z.string(),
  contents: z.string(),
  encoding: z.enum(["utf-8", "base64"]).default("utf-8"),
  size: z.number().int().nonnegative().optional(),
  isLarge: z.boolean().default(false)
});
export type FileContent = z.infer<typeof fileContentSchema>;

export const reactionContentSchema = z.enum([
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes"
]);
export type ReactionContent = z.infer<typeof reactionContentSchema>;

export const reactionGroupSchema = z.object({
  content: reactionContentSchema,
  count: z.number().int().nonnegative(),
  viewerHasReacted: z.boolean().default(false)
});
export type ReactionGroup = z.infer<typeof reactionGroupSchema>;

export const reactionSubjectSchema = z.object({
  nodeId: z.string().min(1)
});
export type ReactionSubject = z.infer<typeof reactionSubjectSchema>;

export const reviewCommentSchema = z.object({
  id: z.string(),
  threadId: z.string().optional(),
  author: actorSchema,
  body: z.string(),
  url: z.string().url().optional(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  side: z.enum(["left", "right"]).optional(),
  startLine: z.number().int().positive().optional(),
  startSide: z.enum(["left", "right"]).optional(),
  originalLine: z.number().int().positive().optional(),
  originalStartLine: z.number().int().positive().optional(),
  originalCommitId: z.string().optional(),
  diffHunk: z.string().optional(),
  outdated: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string().optional(),
  isBot: z.boolean().default(false),
  reactions: z.array(reactionGroupSchema).default([])
});
export type ReviewComment = z.infer<typeof reviewCommentSchema>;

export const reviewThreadSchema = z.object({
  id: z.string(),
  provider: providerIdSchema,
  repository: repositoryRefSchema,
  pullNumber: z.number().int().positive(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  side: z.enum(["left", "right"]).optional(),
  startLine: z.number().int().positive().optional(),
  startSide: z.enum(["left", "right"]).optional(),
  originalLine: z.number().int().positive().optional(),
  originalStartLine: z.number().int().positive().optional(),
  resolved: z.boolean(),
  outdated: z.boolean().default(false),
  comments: z.array(reviewCommentSchema)
});
export type ReviewThread = z.infer<typeof reviewThreadSchema>;

export const reviewEventSchema = z.enum(["comment", "approve", "request_changes"]);
export type ReviewEvent = z.infer<typeof reviewEventSchema>;

export const reviewDraftCommentSchema = z.object({
  path: z.string().min(1),
  body: z.string().min(1),
  line: z.number().int().positive().optional(),
  side: z.enum(["left", "right"]).default("right"),
  startLine: z.number().int().positive().optional(),
  startSide: z.enum(["left", "right"]).optional()
});
export type ReviewDraftComment = z.infer<typeof reviewDraftCommentSchema>;

export const reviewSubmissionSchema = z.object({
  repository: repositoryRefSchema,
  pullNumber: z.number().int().positive(),
  event: reviewEventSchema,
  body: z.string().default(""),
  commitSha: z.string().optional(),
  comments: z.array(reviewDraftCommentSchema).default([])
});
export type ReviewSubmission = z.infer<typeof reviewSubmissionSchema>;

export const reviewSubmissionResultSchema = z.object({
  id: z.string(),
  provider: providerIdSchema,
  repository: repositoryRefSchema,
  pullNumber: z.number().int().positive(),
  event: reviewEventSchema,
  body: z.string().default(""),
  url: z.string().url().optional(),
  submittedAt: z.string()
});
export type ReviewSubmissionResult = z.infer<typeof reviewSubmissionResultSchema>;

export const checkRunSchema = z.object({
  id: z.string(),
  name: z.string(),
  provider: providerIdSchema,
  status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending", "unknown"]),
  conclusion: z
    .enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "unknown"])
    .nullable(),
  url: z.string().url().optional(),
  startedAt: z.string().nullable().optional(),
  completedAt: z.string().nullable().optional(),
  summary: z.string().optional()
});
export type CheckRun = z.infer<typeof checkRunSchema>;

export const activityEventSchema = z.object({
  id: z.string(),
  kind: z.enum(["comment", "review", "bot", "check", "label", "commit", "automation"]),
  actor: actorSchema.optional(),
  title: z.string(),
  body: z.string().optional(),
  createdAt: z.string(),
  url: z.string().url().optional(),
  path: z.string().optional(),
  line: z.number().int().positive().optional(),
  side: z.enum(["left", "right"]).optional(),
  startLine: z.number().int().positive().optional(),
  startSide: z.enum(["left", "right"]).optional(),
  originalLine: z.number().int().positive().optional(),
  originalStartLine: z.number().int().positive().optional(),
  originalCommitId: z.string().optional(),
  diffHunk: z.string().optional(),
  outdated: z.boolean().optional(),
  severity: z.enum(["info", "success", "warning", "failure"]).default("info"),
  reactionSubject: reactionSubjectSchema.optional(),
  reactions: z.array(reactionGroupSchema).default([])
});
export type ActivityEvent = z.infer<typeof activityEventSchema>;

export const pullRequestBundleSchema = z.object({
  detail: pullRequestDetailSchema,
  mode: dataModeSchema,
  changedFiles: z.array(changedFileSchema),
  timeline: z.array(activityEventSchema),
  reviewThreads: z.array(reviewThreadSchema),
  checks: z.array(checkRunSchema)
});
export type PullRequestBundle = z.infer<typeof pullRequestBundleSchema>;

export const diffAnchorSchema = z.object({
  path: z.string(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  side: z.enum(["left", "right"]).default("right")
});
export type DiffAnchor = z.infer<typeof diffAnchorSchema>;

export const riskLevelSchema = z.enum(["low", "medium", "high"]);
export type RiskLevel = z.infer<typeof riskLevelSchema>;

export const tourChapterSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  files: z.array(z.string()),
  diffAnchors: z.array(diffAnchorSchema).default([]),
  changeStats: z.object({
    additions: z.number().int().nonnegative(),
    deletions: z.number().int().nonnegative(),
    files: z.number().int().nonnegative()
  }),
  riskLevel: riskLevelSchema,
  riskReasons: z.array(z.string()).default([]),
  reviewChecklist: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
  generatedAt: z.string(),
  model: z.string(),
  headSha: z.string()
});
export type TourChapter = z.infer<typeof tourChapterSchema>;

export const tourGraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      riskLevel: riskLevelSchema,
      files: z.array(z.string())
    })
  ),
  edges: z.array(
    z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      relation: z.enum(["dependency", "extension", "gating", "verification", "risk"]),
      confidence: z.number().min(0).max(1),
      source: z.enum(["ai", "local", "deterministic"])
    })
  )
});
export type TourGraph = z.infer<typeof tourGraphSchema>;

export const reviewTourSchema = z.object({
  id: z.string(),
  provider: providerIdSchema,
  repository: repositoryRefSchema,
  pullNumber: z.number().int().positive(),
  headSha: z.string(),
  generatedAt: z.string(),
  model: z.string(),
  chapters: z.array(tourChapterSchema),
  graph: tourGraphSchema,
  riskSignals: z.array(
    z.object({
      id: z.string(),
      level: riskLevelSchema,
      title: z.string(),
      files: z.array(z.string()),
      reason: z.string()
    })
  )
});
export type ReviewTour = z.infer<typeof reviewTourSchema>;

export const extensionKindSchema = z.enum(["language", "linter", "review", "ai", "diff", "command", "other"]);
export type ExtensionKind = z.infer<typeof extensionKindSchema>;

export const extensionCommandSchema = z.object({
  program: z.string().min(1),
  args: z.array(z.string()).default([])
});
export type ExtensionCommand = z.infer<typeof extensionCommandSchema>;

export const extensionLspFeatureSchema = z.enum(["diagnostics", "hover", "definition", "symbols"]);
export type ExtensionLspFeature = z.infer<typeof extensionLspFeatureSchema>;

export const extensionLspContributionSchema = z.object({
  command: extensionCommandSchema,
  transport: z.enum(["stdio"]).default("stdio"),
  languages: z.array(z.string()).default([]),
  features: z.array(extensionLspFeatureSchema).default(["diagnostics", "hover", "definition", "symbols"]),
  initializationOptions: z.unknown().optional(),
  settings: z.unknown().optional()
});
export type ExtensionLspContribution = z.infer<typeof extensionLspContributionSchema>;

export const extensionManifestSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  publisher: z.string().optional(),
  description: z.string().default(""),
  kind: z.array(extensionKindSchema).default(["other"]),
  activation: z
    .object({
      globs: z.array(z.string()).default([]),
      languages: z.array(z.string()).default([])
    })
    .default({ globs: [], languages: [] }),
  contributes: z
    .object({
      lsp: extensionLspContributionSchema.optional(),
      diagnostics: z
        .array(
          z.object({
            command: extensionCommandSchema,
            globs: z.array(z.string()).default([])
          })
        )
        .default([]),
      review: z
        .object({
          capabilities: z.array(z.string()).default([])
        })
        .optional(),
      commands: z
        .array(
          z.object({
            id: z.string().min(1),
            title: z.string().min(1)
          })
        )
        .default([])
    })
    .default({ diagnostics: [], commands: [] })
});
export type ExtensionManifest = z.infer<typeof extensionManifestSchema>;

export const extensionDescriptorSchema = z.object({
  id: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  description: z.string(),
  activationGlobs: z.array(z.string()),
  capabilities: z.array(z.string()),
  command: extensionCommandSchema.optional(),
  version: z.string().optional(),
  publisher: z.string().optional(),
  source: z.enum(["builtin", "local"]).optional(),
  kind: z.array(extensionKindSchema).optional(),
  contributes: extensionManifestSchema.shape.contributes.optional(),
  manifestPath: z.string().optional()
});
export type ExtensionDescriptor = z.infer<typeof extensionDescriptorSchema>;

export const extensionLogSchema = z.object({
  id: z.string(),
  extensionId: z.string(),
  level: z.enum(["debug", "info", "warning", "error"]),
  message: z.string(),
  createdAt: z.string()
});
export type ExtensionLog = z.infer<typeof extensionLogSchema>;

export const aiProviderSchema = z.enum([
  "disabled",
  "openai",
  "anthropic",
  "google",
  "azure-openai",
  "bedrock",
  "ollama"
]);
export type AiProvider = z.infer<typeof aiProviderSchema>;

export const aiKeyProviderSchema = z.enum(["keychain", "environment", "command"]);
export type AiKeyProvider = z.infer<typeof aiKeyProviderSchema>;

export const githubKeyProviderSchema = z.enum(["keychain", "environment", "gh-cli"]);
export type GitHubKeyProvider = z.infer<typeof githubKeyProviderSchema>;

export const updateChannelSchema = z.enum(["stable", "beta"]);
export type UpdateChannel = z.infer<typeof updateChannelSchema>;

export const updateStateSchema = z.enum([
  "disabled",
  "idle",
  "checking",
  "available",
  "not_available",
  "downloaded",
  "installing",
  "error"
]);
export type UpdateState = z.infer<typeof updateStateSchema>;

export const updateStatusSchema = z.object({
  enabled: z.boolean(),
  configured: z.boolean(),
  channel: updateChannelSchema,
  state: updateStateSchema,
  currentVersion: z.string(),
  feedUrl: z.string().url().nullable(),
  availableVersion: z.string().optional(),
  releaseDate: z.string().optional(),
  message: z.string().optional(),
  checkedAt: z.string().optional()
});
export type UpdateStatus = z.infer<typeof updateStatusSchema>;

export const appSettingsSchema = z.object({
  appearance: z.object({
    accentColor: z.string().default("#4f46e5"),
    density: z.enum(["compact", "comfortable"]).default("compact")
  }),
  data: z.object({
    preferredMode: preferredDataModeSchema.default("auto"),
    managedRepoStorage: z.string().nullable().default(null),
    worktreeCacheSizeGb: z.number().positive().default(20)
  }),
  ai: z.object({
    enabled: z.boolean().default(false),
    provider: aiProviderSchema.default("disabled"),
    model: z.string().default(""),
    baseUrl: z.string().url().optional(),
    keyProvider: aiKeyProviderSchema.default("keychain"),
    keyCommand: z.string().default(""),
    thinkingEnabled: z.boolean().default(true),
    maxOutputTokens: z.number().int().min(1_024).max(64_000).default(16_000),
    thinkingBudgetTokens: z.number().int().min(1_024).max(60_000).default(8_000)
  }),
  github: z.object({
    configured: z.boolean().default(false),
    login: z.string().nullable().default(null),
    tokenProvider: githubKeyProviderSchema.default("keychain")
  }),
  updates: z
    .object({
      enabled: z.boolean().default(false),
      channel: updateChannelSchema.default("stable"),
      feedUrl: z.string().url().nullable().default(null)
    })
    .default({ enabled: false, channel: "stable", feedUrl: null }),
  extensions: z.record(z.string(), z.boolean()).default({}),
  pinnedRepos: z.array(z.string()).default([])
});
export type AppSettings = z.infer<typeof appSettingsSchema>;

export const defaultAppSettings: AppSettings = appSettingsSchema.parse({
  appearance: {},
  data: {},
  ai: {},
  github: {},
  updates: {},
  extensions: {},
  pinnedRepos: []
});

export const operationProgressSchema = z.object({
  operationId: z.string(),
  phase: z.string(),
  message: z.string(),
  percent: z.number().min(0).max(100).nullable().optional(),
  done: z.boolean().default(false),
  cancelled: z.boolean().default(false),
  error: z.string().optional(),
  // Optional in-progress result preview. AI tour generation streams a partial
  // ReviewTour here (chapters filled in as they arrive) so the UI can render
  // the story as it is written, before the operation completes.
  tour: reviewTourSchema.optional()
});
export type OperationProgress = z.infer<typeof operationProgressSchema>;

export const typedErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean().default(false),
  details: z.unknown().optional()
});
export type TypedError = z.infer<typeof typedErrorSchema>;

export const repositoryCloneInfoSchema = z.object({
  repository: repositoryRefSchema,
  htmlUrl: z.string().url(),
  cloneUrl: z.string().url(),
  sshUrl: z.string(),
  defaultBranch: z.string()
});
export type RepositoryCloneInfo = z.infer<typeof repositoryCloneInfoSchema>;

export const workspaceTreeSchema = z.object({
  repository: repositoryRefSchema,
  headSha: z.string(),
  worktreePath: z.string(),
  paths: z.array(z.string())
});
export type WorkspaceTree = z.infer<typeof workspaceTreeSchema>;

export const workspaceTextSearchResultSchema = z.object({
  repository: repositoryRefSchema,
  headSha: z.string(),
  query: z.string(),
  searchedFiles: z.number().int().nonnegative(),
  skippedFiles: z.number().int().nonnegative(),
  truncated: z.boolean(),
  results: z.array(
    z.object({
      path: z.string(),
      matches: z.array(
        z.object({
          lineNumber: z.number().int().positive(),
          lineText: z.string()
        })
      )
    })
  )
});
export type WorkspaceTextSearchResult = z.infer<typeof workspaceTextSearchResultSchema>;

export const workspaceFileChangeSchema = z.object({
  repository: repositoryRefSchema,
  headSha: z.string(),
  worktreePath: z.string(),
  path: z.string().nullable(),
  eventType: z.enum(["change", "rename", "unknown"]),
  changedAt: z.string()
});
export type WorkspaceFileChange = z.infer<typeof workspaceFileChangeSchema>;

export const managedWorktreeSchema = z.object({
  repository: repositoryRefSchema,
  number: z.number().int().positive(),
  headSha: z.string(),
  worktreePath: z.string(),
  lastUsedAt: z.string(),
  active: z.boolean(),
  sizeBytes: z.number().int().nonnegative().default(0),
  title: z.string().optional(),
  headRef: z.string().optional(),
  baseRef: z.string().optional()
});
export type ManagedWorktree = z.infer<typeof managedWorktreeSchema>;

export const worktreeCleanupResultSchema = z.object({
  deleted: z.array(managedWorktreeSchema),
  retained: z.array(managedWorktreeSchema),
  deletedCount: z.number().int().nonnegative(),
  retainedCount: z.number().int().nonnegative(),
  freedBytes: z.number().int().nonnegative(),
  dryRun: z.boolean()
});
export type WorktreeCleanupResult = z.infer<typeof worktreeCleanupResultSchema>;

export const cacheTableStatsSchema = z.object({
  entryCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  oldestUpdatedAt: z.string().nullable(),
  newestUpdatedAt: z.string().nullable()
});
export type CacheTableStats = z.infer<typeof cacheTableStatsSchema>;

export const cacheStatsSchema = z.object({
  prCache: cacheTableStatsSchema,
  providerResponses: cacheTableStatsSchema,
  aiTours: cacheTableStatsSchema,
  performanceMeasurements: cacheTableStatsSchema
});
export type CacheStats = z.infer<typeof cacheStatsSchema>;

export const cacheCleanupPolicySchema = z.object({
  maxAgeDays: z.number().int().positive().default(30),
  maxEntriesPerTable: z.number().int().nonnegative().default(5_000),
  dryRun: z.boolean().default(false)
});
export type CacheCleanupPolicy = z.infer<typeof cacheCleanupPolicySchema>;

export const cacheCleanupTableResultSchema = z.object({
  deletedCount: z.number().int().nonnegative(),
  freedBytes: z.number().int().nonnegative()
});
export type CacheCleanupTableResult = z.infer<typeof cacheCleanupTableResultSchema>;

export const cacheCleanupResultSchema = z.object({
  dryRun: z.boolean(),
  prCache: cacheCleanupTableResultSchema,
  providerResponses: cacheCleanupTableResultSchema,
  aiTours: cacheCleanupTableResultSchema,
  performanceMeasurements: cacheCleanupTableResultSchema
});
export type CacheCleanupResult = z.infer<typeof cacheCleanupResultSchema>;

export const performanceMeasurementSchema = z.object({
  id: z.number().int().positive(),
  name: z.string(),
  durationMs: z.number().nonnegative(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string()
});
export type PerformanceMeasurement = z.infer<typeof performanceMeasurementSchema>;

export const diagnosticsSnapshotSchema = z.object({
  generatedAt: z.string(),
  appVersion: z.string(),
  platform: z.string(),
  paths: z.object({
    root: z.string(),
    cache: z.string(),
    logs: z.string(),
    indexes: z.string()
  }),
  settings: z.object({
    appearance: appSettingsSchema.shape.appearance,
    data: appSettingsSchema.shape.data,
    ai: z.object({
      enabled: z.boolean(),
      provider: aiProviderSchema,
      model: z.string(),
      baseUrlConfigured: z.boolean(),
      keyProvider: aiKeyProviderSchema,
      keyCommandConfigured: z.boolean()
    }),
    github: appSettingsSchema.shape.github,
    updates: appSettingsSchema.shape.updates,
    enabledExtensionCount: z.number().int().nonnegative()
  }),
  cache: cacheStatsSchema,
  worktrees: z.object({
    count: z.number().int().nonnegative(),
    activeCount: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative()
  }),
  recentPerformance: z.array(performanceMeasurementSchema),
  operations: z.array(operationProgressSchema),
  updates: updateStatusSchema
});
export type DiagnosticsSnapshot = z.infer<typeof diagnosticsSnapshotSchema>;

export const lspPositionSchema = z.object({
  line: z.number().int().nonnegative(),
  character: z.number().int().nonnegative()
});
export type LspPosition = z.infer<typeof lspPositionSchema>;

export const lspRangeSchema = z.object({
  start: lspPositionSchema,
  end: lspPositionSchema
});
export type LspRange = z.infer<typeof lspRangeSchema>;

export const lspDiagnosticSchema = z.object({
  id: z.string(),
  source: z.string(),
  severity: z.enum(["error", "warning", "info", "hint"]),
  message: z.string(),
  path: z.string(),
  range: lspRangeSchema,
  code: z.string().optional()
});
export type LspDiagnostic = z.infer<typeof lspDiagnosticSchema>;

export const lspHoverSchema = z.object({
  source: z.string(),
  path: z.string(),
  position: lspPositionSchema,
  contents: z.string(),
  range: lspRangeSchema.optional()
});
export type LspHover = z.infer<typeof lspHoverSchema>;

export const lspDefinitionSchema = z.object({
  source: z.string(),
  path: z.string(),
  range: lspRangeSchema
});
export type LspDefinition = z.infer<typeof lspDefinitionSchema>;

export const lspDocumentSymbolSchema = z.object({
  name: z.string(),
  kind: z.enum(["file", "module", "namespace", "package", "class", "method", "property", "field", "constructor", "enum", "interface", "function", "variable", "constant", "string", "number", "boolean", "array", "object", "key", "null", "enum_member", "struct", "event", "operator", "type_parameter"]),
  path: z.string(),
  range: lspRangeSchema,
  selectionRange: lspRangeSchema,
  detail: z.string().optional(),
  containerName: z.string().optional()
});
export type LspDocumentSymbol = z.infer<typeof lspDocumentSymbolSchema>;

export const lspServerActivitySchema = z.object({
  extensionId: z.string(),
  title: z.string(),
  message: z.string().optional(),
  percentage: z.number().min(0).max(100).optional(),
  updatedAt: z.string()
});
export type LspServerActivity = z.infer<typeof lspServerActivitySchema>;

export const lspServerStatusSchema = z.object({
  extensionId: z.string(),
  health: z.enum(["ok", "warning", "error"]),
  quiescent: z.boolean(),
  message: z.string().optional(),
  updatedAt: z.string()
});
export type LspServerStatus = z.infer<typeof lspServerStatusSchema>;

export const lspSessionSchema = z.object({
  id: z.string(),
  repository: repositoryRefSchema,
  headSha: z.string(),
  worktreePath: z.string(),
  status: z.enum(["starting", "ready", "degraded", "stopped", "error"]),
  activeExtensions: z.array(z.string()),
  unavailableExtensions: z.array(
    z.object({
      id: z.string(),
      reason: z.string()
    })
  ),
  capabilities: z.array(z.enum(["diagnostics", "hover", "definition", "symbols"])),
  startedAt: z.string(),
  activities: z.array(lspServerActivitySchema).optional(),
  activity: lspServerActivitySchema.optional(),
  serverStatuses: z.array(lspServerStatusSchema).optional(),
  serverStatus: lspServerStatusSchema.optional(),
  error: z.string().optional()
});
export type LspSession = z.infer<typeof lspSessionSchema>;
