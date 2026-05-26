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
    "Turn the PR context into a review path that helps the reviewer understand intent, inspect the highest-risk changes first, and know what to verify.",
  outputRequirements: [
    "Return exactly one JSON object and no markdown, prose wrapper, code fence, or comments.",
    "Match the ReviewTour shape. The caller will fill provider, repository, pullNumber, headSha, generatedAt, model, and id if omitted.",
    "Use stable ids such as chapter-1 and risk-1. Every dependency and graph edge endpoint must reference an existing chapter id.",
    "Only cite files present in the supplied clusters. Do not invent files, checks, threads, functions, APIs, or behavior.",
    "Prefer concise, reviewer-facing text. Avoid generic summaries like 'review the changes' unless paired with specific evidence."
  ],
  chapterGuidance: [
    "Create 3-8 chapters unless the PR is trivial. Each chapter should represent a coherent review stop, not just a directory name.",
    "Order chapters in the sequence a reviewer should follow: entry points and contracts first, risky behavior next, tests/config/generated artifacts last.",
    "Chapter summaries should explain what changed and why it matters for review.",
    "Set diffAnchors to the most useful files for that chapter, with side right unless the old side is specifically relevant.",
    "Make reviewChecklist items concrete checks the reviewer can perform against the supplied files or patch excerpts."
  ],
  graphGuidance: [
    "Build graph.nodes from chapters and include each chapter's primary files.",
    "Use edges only when there is a meaningful relationship: dependency, extension, gating, verification, or risk.",
    "Use confidence between 0.35 and 0.95. Mark source as ai."
  ],
  riskGuidance: [
    "Risk levels should reflect blast radius, broad changes, generated or large files, failing checks, diagnostics, unresolved threads, and sensitive contracts.",
    "High risk means a reviewer should inspect the chapter before approving. Medium risk means targeted verification is useful.",
    "riskSignals should summarize the most important cross-cutting risks, not duplicate every chapter."
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
      "ReviewTour JSON object with chapters, graph, and riskSignals. Required chapter fields: id, title, summary, files, diffAnchors, changeStats, riskLevel, riskReasons, reviewChecklist, dependencies. graph.nodes must correspond to chapters; graph.edges must reference chapter ids.",
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
    const key = clusterKey(file.path);
    const bucket = buckets.get(key) ?? [];
    bucket.push(file);
    buckets.set(key, bucket);
  }

  const clusters = [...buckets.entries()]
    .map(([key, bucketFiles]) => buildCluster(key, bucketFiles))
    .sort((left, right) => right.changes - left.changes || left.title.localeCompare(right.title));

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

function clusterKey(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return "root";
  }
  return segments[0];
}

function buildCluster(key: string, files: PreparedAiFile[]): Omit<PreparedAiCluster, "id"> {
  const additions = files.reduce((sum, file) => sum + file.additions, 0);
  const deletions = files.reduce((sum, file) => sum + file.deletions, 0);
  const changes = files.reduce((sum, file) => sum + file.changes, 0);
  const dependencies = [...new Set(files.flatMap((file) => file.imports))].slice(0, 20);

  return {
    title: key === "root" ? "Top-level changes" : `${key}/ changes`,
    files,
    additions,
    deletions,
    changes,
    riskHints: riskHintsForFiles(files),
    dependencies
  };
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
