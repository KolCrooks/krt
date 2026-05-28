import type { ActivityEvent, ChangedFile, CheckRun, PullRequestDetail, ReviewThread } from "./schemas.js";

export interface AiPromptInput {
  pullRequest: PullRequestDetail;
  changedFiles: ChangedFile[];
  timeline: ActivityEvent[];
  reviewThreads: ReviewThread[];
  checks: CheckRun[];
}

export interface AiPromptPrepOptions {
  maxFiles: number;
  maxClusters: number;
  maxPatchCharsPerFile: number;
  maxTotalPatchChars: number;
  maxImportsPerFile: number;
  maxTimelineEvents: number;
  maxReviewThreads: number;
  maxLongLineLength: number;
}

export interface PreparedAiFile {
  path: string;
  status: ChangedFile["status"];
  language?: string;
  additions: number;
  deletions: number;
  changes: number;
  isLarge: boolean;
  isGenerated: boolean;
  annotations: number;
  diagnostics: number;
  imports: string[];
  patchExcerpt?: string;
  patchTruncated: boolean;
}

export interface PreparedAiCluster {
  id: string;
  title: string;
  topic: string;
  reviewOrder: number;
  files: PreparedAiFile[];
  additions: number;
  deletions: number;
  changes: number;
  riskHints: string[];
  dependencies: string[];
}

export interface PreparedAiReviewContext {
  task: {
    role: string;
    objective: string;
    outputRequirements: readonly string[];
    chapterGuidance: readonly string[];
    graphGuidance: readonly string[];
    riskGuidance: readonly string[];
  };
  schema: string;
  limits: AiPromptPrepOptions;
  pullRequest: {
    title: string;
    body: string;
    author: string;
    baseRef: string;
    headRef: string;
    headSha: string;
  };
  summary: {
    totalFiles: number;
    includedFiles: number;
    omittedFiles: number;
    additions: number;
    deletions: number;
    changedLines: number;
    largeFiles: number;
    generatedFiles: number;
    failingChecks: number;
    unresolvedThreads: number;
  };
  clusters: PreparedAiCluster[];
  checks: Array<Pick<CheckRun, "name" | "status" | "conclusion" | "summary">>;
  reviewThreads: Array<{
    path?: string;
    line?: number;
    resolved: boolean;
    outdated: boolean;
    commentCount: number;
  }>;
  timeline: Array<Pick<ActivityEvent, "kind" | "title" | "severity">>;
}

export interface ReviewTopicInput {
  path: string;
  language?: string;
  imports?: readonly string[];
  patch?: string;
  patchExcerpt?: string;
}

export interface ReviewTopicMetadata {
  key: string;
  title: string;
  reviewOrder: number;
}

const defaultOptions: AiPromptPrepOptions = {
  maxFiles: 120,
  maxClusters: 12,
  maxPatchCharsPerFile: 1_600,
  maxTotalPatchChars: 60_000,
  maxImportsPerFile: 8,
  maxTimelineEvents: 24,
  maxReviewThreads: 40,
  maxLongLineLength: 320
};

const tourTask = {
  role: "You are a senior code reviewer creating a guided PR review tour for another reviewer.",
  objective:
    "Tell the story of this change as a guided walkthrough: introduce the key idea, then lead the reviewer through the pieces in the order that builds understanding, so they grasp the author's intent, see how the parts connect, and know exactly what to scrutinize before approving. The tour is a narrative, not a file listing.",
  outputRequirements: [
    "Return exactly one JSON object and no markdown, prose wrapper, code fence, or comments.",
    "Match the ReviewTour shape. The caller will fill provider, repository, pullNumber, headSha, generatedAt, model, and id if omitted.",
    "Use stable ids such as chapter-1 and risk-1. Every dependency and graph edge endpoint must reference an existing chapter id.",
    "Only cite files present in the supplied topic clusters. Do not invent files, checks, threads, functions, APIs, or behavior.",
    "Ground every claim in the supplied patch excerpts. When you name a type, function, field, flag, or constant, write it exactly as it appears in the diff and wrap it in backticks (for example `StreamPermit`, `reserve(n)`, `feature_flags.streaming_cache_v2`).",
    "Prefer concise, reviewer-facing prose. Avoid generic summaries like 'review the changes' or 'updated logic'; every sentence should carry a specific, verifiable detail drawn from the patch."
  ],
  chapterGuidance: [
    "Create 3-8 chapters unless the PR is trivial. Each chapter must represent one coherent idea: a new primitive or concept, a replacement, a behavior change, a plumbing/wiring step, a configuration gate, or verification.",
    "A chapter is a unit of change — typically one hunk or a few closely related hunks — not a whole file and not a file group. Organize chapters around what changed, not around where it lives.",
    "The same file may appear in multiple chapters, each scoped to a different region, and one chapter may pull related hunks from several files. Use the @@ hunk headers and line numbers in the patch excerpts to decide chapter boundaries.",
    "Do not create one chapter per file. Do not name chapters after individual files, directories, or supplied cluster titles unless that is truly the user-facing topic.",
    "Use the topic clusters as evidence groups, not as a required chapter outline. They group files for context only — do not let them dictate chapters. Combine hunks from different clusters when they implement the same change, and split one file or cluster into multiple chapters when it contains distinct changes.",
    "Name chapters after the key construct and its role, not the topic in the abstract. Prefer a name plus a short purpose clause, for example 'StreamPermit — the new backpressure primitive', 'RingCache replaces PerRequestBuffer', or 'Tiered eviction — protect long streams' — not 'SettingsView.tsx' or 'src/ changes', and not a bare cluster label.",
    "Order chapters as a narrative the reviewer should follow in sequence: introduce the foundational new concept the rest builds on first, then what it replaces, then the plumbing that wires it in, then extensions and special cases, then configuration and feature gates, and finally tests and observability. Later chapters should build on the understanding established by earlier ones.",
    "Always split test changes into their own dedicated chapter (or chapters) — never fold tests into the feature chapter they verify. Place these test chapters after the implementation they cover and link them with verification edges to the chapters they exercise.",
    "Keep summaries short and scannable — not verbose prose. Lead with a single sentence on what the change is, then 2-4 concise Markdown bullet points (each one line) covering how it works and what to watch for. Prefer bullets over paragraphs. Use backticks for code identifiers and reference the real symbols from the patch.",
    "Anchor each chapter to the specific changed region(s) it covers: set diffAnchors to the file path(s) and the startLine/endLine of the relevant hunk(s) from the patch, not just the whole file. Put the most instructive region first. Use side right unless the deleted (old) side is specifically what the reviewer must compare against. Set files to only the files the chapter's anchors actually touch.",
    "Make reviewChecklist items concrete, chapter-specific checks the reviewer can perform against the supplied files or patch excerpts (for example 'Confirm `reserve` cannot deadlock if a `pressure` notify is missed'), not generic reminders."
  ],
  graphGuidance: [
    "Build graph.nodes from chapters and include each chapter's primary files; keep node.label aligned with the chapter title.",
    "Connect the chapters into a single left-to-right build-order flow. Every edge points from the prerequisite/foundation chapter (from) to the chapter that builds on it (to), so foundations sit on the left and consumers, gates, and tests fall to the right.",
    "Set each chapter's dependencies array to the ids of the chapters it directly builds on, consistent with the incoming graph edges, so the storyboard and the tour agree on ordering.",
    "Choose the relation that best fits each link: dependency when one chapter uses another, extension when one specializes or adds a case to another, gating when a config or feature flag guards a chapter, verification when tests exercise a chapter, risk for a cross-cutting hazard link.",
    "Prefer a clean graph: connect chapters that have a real relationship (avoid isolated nodes when a relationship exists) but prune redundant transitive edges so the flow stays readable.",
    "Use confidence between 0.35 and 0.95. Mark source as ai."
  ],
  riskGuidance: [
    "Risk levels should reflect blast radius, broad changes, generated or large files, failing checks, diagnostics, unresolved threads, and sensitive contracts such as new concurrency primitives, eviction or cache policy, and anything on a hot path.",
    "High risk means a reviewer should rigorously inspect the chapter before approving; medium risk means targeted verification is useful.",
    "Write riskReasons as specific 'here is the hazard and here is what to verify' notes, not generic labels — name the exact failure mode and the property to check (for example 'New concurrency primitive on the hot path; verify drop semantics under panic and that `reserve` cannot deadlock when a notify is missed').",
    "When a chapter does two distinct things at once, call that out as a review concern so the reviewer can scrutinize each part separately.",
    "riskSignals should surface only the few most important cross-cutting risks, each tied to specific files, and must not simply duplicate every chapter."
  ]
} as const;

export function prepareAiReviewContext(input: AiPromptInput, options: Partial<AiPromptPrepOptions> = {}): PreparedAiReviewContext {
  const limits = { ...defaultOptions, ...options };
  const rankedFiles = [...input.changedFiles].sort(compareChangedFilesForPrompt);
  const selectedFiles = rankedFiles.slice(0, limits.maxFiles);
  let remainingPatchChars = limits.maxTotalPatchChars;
  const preparedFiles = selectedFiles.map((file) => {
    const patchBudget = Math.max(0, Math.min(limits.maxPatchCharsPerFile, remainingPatchChars));
    const patch = preparePatchExcerpt(file.patch, patchBudget, limits.maxLongLineLength);
    remainingPatchChars -= patch.excerpt.length;

    return {
      path: file.path,
      status: file.status,
      language: file.language,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
      isLarge: file.isLarge,
      isGenerated: file.isGenerated,
      annotations: file.annotations,
      diagnostics: file.diagnostics,
      imports: extractImportSignals(file.patch ?? "", limits.maxImportsPerFile),
      patchExcerpt: patch.excerpt || undefined,
      patchTruncated: patch.truncated
    };
  });

  const clusters = clusterPreparedFiles(preparedFiles, limits.maxClusters);
  const unresolvedThreads = input.reviewThreads.filter((thread) => !thread.resolved).length;

  return {
    task: tourTask,
    schema:
      "ReviewTour JSON object with chapters, graph, and riskSignals. Required chapter fields: id, title, summary, files, diffAnchors, changeStats, riskLevel, riskReasons, reviewChecklist, dependencies. graph.nodes must correspond to chapters; graph.edges must reference chapter ids and point from the prerequisite chapter (from) to the chapter that builds on it (to), with relation one of dependency, extension, gating, verification, or risk.",
    limits,
    pullRequest: {
      title: input.pullRequest.title,
      body: input.pullRequest.body,
      author: input.pullRequest.author.login,
      baseRef: input.pullRequest.baseRef,
      headRef: input.pullRequest.headRef,
      headSha: input.pullRequest.headSha
    },
    summary: {
      totalFiles: input.changedFiles.length,
      includedFiles: preparedFiles.length,
      omittedFiles: Math.max(0, input.changedFiles.length - preparedFiles.length),
      additions: input.changedFiles.reduce((sum, file) => sum + file.additions, 0),
      deletions: input.changedFiles.reduce((sum, file) => sum + file.deletions, 0),
      changedLines: input.changedFiles.reduce((sum, file) => sum + file.changes, 0),
      largeFiles: input.changedFiles.filter((file) => file.isLarge).length,
      generatedFiles: input.changedFiles.filter((file) => file.isGenerated).length,
      failingChecks: input.checks.filter((check) => check.conclusion === "failure" || check.conclusion === "timed_out").length,
      unresolvedThreads
    },
    clusters,
    checks: input.checks.map((check) => ({
      name: check.name,
      status: check.status,
      conclusion: check.conclusion,
      summary: check.summary
    })),
    reviewThreads: input.reviewThreads.slice(0, limits.maxReviewThreads).map((thread) => ({
      path: thread.path,
      line: thread.line,
      resolved: thread.resolved,
      outdated: thread.outdated,
      commentCount: thread.comments.length
    })),
    timeline: input.timeline.slice(-limits.maxTimelineEvents).map((event) => ({
      kind: event.kind,
      title: event.title,
      severity: event.severity
    }))
  };
}

export function buildAiReviewPrompt(input: AiPromptInput, options?: Partial<AiPromptPrepOptions>): string {
  return JSON.stringify(prepareAiReviewContext(input, options));
}

function compareChangedFilesForPrompt(left: ChangedFile, right: ChangedFile): number {
  const scoreDelta = scoreFileForPrompt(right) - scoreFileForPrompt(left);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }
  return left.path.localeCompare(right.path);
}

function scoreFileForPrompt(file: ChangedFile): number {
  return (
    file.changes +
    file.annotations * 50 +
    file.diagnostics * 50 +
    (file.isLarge ? 500 : 0) +
    (file.isGenerated ? -200 : 0) +
    (file.status === "removed" ? 120 : 0) +
    (file.status === "renamed" ? 80 : 0)
  );
}

function preparePatchExcerpt(
  patch: string | undefined,
  maxChars: number,
  maxLongLineLength: number
): { excerpt: string; truncated: boolean } {
  if (!patch || maxChars <= 0) {
    return { excerpt: "", truncated: Boolean(patch) };
  }

  const normalizedLines = patch.split("\n").map((line) => {
    if (line.length <= maxLongLineLength) {
      return line;
    }
    return `${line.slice(0, maxLongLineLength)} ... [line truncated]`;
  });
  const normalized = normalizedLines.join("\n");
  if (normalized.length <= maxChars) {
    return { excerpt: normalized, truncated: false };
  }

  return {
    excerpt: normalized.slice(0, maxChars),
    truncated: true
  };
}

function extractImportSignals(patch: string, maxImports: number): string[] {
  if (!patch || maxImports <= 0) {
    return [];
  }

  const imports = new Set<string>();
  for (const rawLine of patch.split("\n")) {
    const line = normalizePatchLine(rawLine);
    if (!line) {
      continue;
    }

    for (const signal of importSignalsFromLine(line)) {
      imports.add(signal);
      if (imports.size >= maxImports) {
        return [...imports];
      }
    }
  }

  return [...imports];
}

function normalizePatchLine(rawLine: string): string {
  if (rawLine.startsWith("+++") || rawLine.startsWith("---")) {
    return "";
  }
  if (rawLine.startsWith("+") || rawLine.startsWith("-") || rawLine.startsWith(" ")) {
    return rawLine.slice(1).trim();
  }
  return rawLine.trim();
}

function importSignalsFromLine(line: string): string[] {
  const signals: string[] = [];
  addMatch(signals, line.match(/\bimport(?:\s+type)?[\s\S]*?\bfrom\s+["']([^"']+)["']/));
  addMatch(signals, line.match(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/));
  addMatch(signals, line.match(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/));
  addMatch(signals, line.match(/\bfrom\s+([A-Za-z0-9_.]+)\s+import\b/));
  addMatch(signals, line.match(/\buse\s+([A-Za-z0-9_:]+)(?:::\{|\s*;)/));
  return signals;
}

function addMatch(signals: string[], match: RegExpMatchArray | null): void {
  const value = match?.[1]?.trim();
  if (value) {
    signals.push(value);
  }
}

function clusterPreparedFiles(files: PreparedAiFile[], maxClusters: number): PreparedAiCluster[] {
  const buckets = new Map<string, PreparedAiFile[]>();
  for (const file of files) {
    const key = reviewTopicKey(file);
    const bucket = buckets.get(key) ?? [];
    bucket.push(file);
    buckets.set(key, bucket);
  }

  const clusters = [...buckets.entries()]
    .map(([key, bucketFiles]) => buildCluster(key, bucketFiles))
    .sort((left, right) => left.reviewOrder - right.reviewOrder || right.changes - left.changes || left.title.localeCompare(right.title));

  if (clusters.length <= maxClusters) {
    return clusters.map((cluster, index) => ({ ...cluster, id: `cluster-${index + 1}` }));
  }

  const visible = clusters.slice(0, Math.max(1, maxClusters - 1));
  const merged = buildCluster(
    "additional",
    clusters.slice(visible.length).flatMap((cluster) => cluster.files)
  );
  return [...visible, { ...merged, title: "Additional changed areas" }].map((cluster, index) => ({
    ...cluster,
    id: `cluster-${index + 1}`
  }));
}

function buildCluster(key: string, files: PreparedAiFile[]): Omit<PreparedAiCluster, "id"> {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const changes = files.reduce((sum, file) => sum + file.changes, 0);
  const dependencies = [...new Set(files.flatMap((file) => file.imports))].slice(0, 20);

  return {
    title: topicTitle(key),
    topic: key,
    reviewOrder: topicReviewOrder(key),
    files,
    additions,
    deletions,
    changes,
    riskHints: riskHintsForFiles(files),
    dependencies
  };
}

export function inferReviewTopic(input: ReviewTopicInput): ReviewTopicMetadata {
  const path = input.path.toLowerCase();
  const evidence = [
    path,
    input.language ?? "",
    input.imports?.join("\n") ?? "",
    input.patchExcerpt ?? "",
    input.patch ?? ""
  ].join("\n").toLowerCase();

  let key = "source-behavior";
  if (isTestPath(path)) {
    key = "tests-validation";
  } else if (isDocsPath(path)) {
    key = "documentation";
  } else if (hasAny(evidence, ["settings", "preference", "keychain", "credential", "secret", "token", "auth", "providerregistry", "api_key", "github_token", "ai_api_key", "keyprovider", "tokenprovider"])) {
    key = "settings-credentials";
  } else if (hasAny(evidence, ["aiprompt", "aiservice", "redaction", "reviewtour", "ai tour", "tour generation", "prompt", "model"])) {
    key = "ai-review-generation";
  } else if (hasAny(evidence, ["schema", "ipc", "preload", "contract", "zod", "channel", "contextbridge", "ipcrenderer", "ipcmain"])) {
    key = "contracts-ipc";
  } else if (hasAny(evidence, ["database", "sqlite", "cache", "worktree", "repository", "migration", "storage", "persistence"])) {
    key = "persistence-workspace-data";
  } else if (hasAny(evidence, ["component", "renderer", "tsx", "css", "style", "view", "workspace", "diff", "editor", "storyboard", "tab", "rail", "titlebar", "select", "button"])) {
    key = "review-ui";
  } else if (hasAny(evidence, ["electron", "browserwindow", "auto-updater", "menu", "appmenu", "main/index"])) {
    key = "main-process-shell";
  } else if (isConfigPath(path)) {
    key = "build-config";
  }

  return {
    key,
    title: topicTitle(key),
    reviewOrder: topicReviewOrder(key)
  };
}

function reviewTopicKey(file: PreparedAiFile): string {
  return inferReviewTopic({
    path: file.path,
    language: file.language,
    imports: file.imports,
    patchExcerpt: file.patchExcerpt
  }).key;
}

function topicTitle(key: string): string {
  switch (key) {
    case "settings-credentials":
      return "Settings and credential provider flow";
    case "ai-review-generation":
      return "AI review tour generation";
    case "contracts-ipc":
      return "Shared contracts and IPC boundaries";
    case "persistence-workspace-data":
      return "Persistence and workspace data flow";
    case "review-ui":
      return "Review UI workflow";
    case "main-process-shell":
      return "Electron shell and main process behavior";
    case "tests-validation":
      return "Tests and validation";
    case "documentation":
      return "Documentation";
    case "build-config":
      return "Build and project configuration";
    case "source-behavior":
    default:
      return "Runtime behavior changes";
  }
}

function topicReviewOrder(key: string): number {
  switch (key) {
    case "contracts-ipc":
      return 10;
    case "settings-credentials":
      return 20;
    case "ai-review-generation":
      return 30;
    case "persistence-workspace-data":
      return 40;
    case "main-process-shell":
      return 50;
    case "review-ui":
      return 60;
    case "source-behavior":
      return 70;
    case "tests-validation":
      return 90;
    case "build-config":
      return 95;
    case "documentation":
      return 100;
    default:
      return 80;
  }
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests|__tests__)(\/|$)/.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

function isDocsPath(path: string): boolean {
  return /(^|\/)(docs?|readme)(\/|$)/.test(path) || /(^|\/)readme\./.test(path) || /\.mdx?$/.test(path);
}

function isConfigPath(path: string): boolean {
  return /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|tsconfig[^/]*\.json|vite\.config|vitest\.config|playwright\.config|eslint|prettier|electron-builder|dockerfile|makefile|\.github)(\/|$|\.)/.test(path);
}

function hasAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function riskHintsForFiles(files: PreparedAiFile[]): string[] {
  const hints = new Set<string>();
  if (files.some((file) => file.isLarge)) {
    hints.add("large-file");
  }
  if (files.some((file) => file.isGenerated)) {
    hints.add("generated-file");
  }
  if (files.some((file) => file.diagnostics > 0)) {
    hints.add("diagnostics");
  }
  if (files.reduce((sum, file) => sum + file.changes, 0) > 1_000) {
    hints.add("broad-change");
  }
  return [...hints];
}
