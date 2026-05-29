import { randomUUID } from "node:crypto";
import type {
  ChangedFile,
  DiffAnchor,
  FileContent,
  FilePatch,
  ProviderId,
  RepositoryRef,
  ReviewTour,
  RiskLevel,
  TourChapter,
  WorkspaceTextSearchResult,
  WorkspaceTree
} from "../../../shared/schemas.js";
import type { ChapterKind, InlineCommentCategory, InlineCommentSeverity } from "../../../shared/schemas.js";
import { reviewTourSchema } from "../../../shared/schemas.js";
import { redactTextForAi } from "../redactionService.js";
import { blastRadiusForFiles, deterministicEdgesFromChangeMap, type ChangeMap } from "./changeMap.js";
import type { ToolCall, ToolDef } from "./types.js";

const MAX_FILE_CHARS = 60_000;
const MAX_DIFF_CHARS = 40_000;
const MAX_SEARCH_RESULTS = 30;
const MAX_LISTED_FILES = 200;

// The subset of RepoService the review tools need. Declared structurally so the
// toolset can be unit-tested with a lightweight stub.
export interface ReviewRepoAccess {
  getWorktreePath(repository: RepositoryRef, ref: string): string | null;
  getLocalFileContent(repository: RepositoryRef, path: string, ref: string): Promise<FileContent | null>;
  getLocalFilePatch(repository: RepositoryRef, number: number, path: string, headSha: string): Promise<FilePatch | null>;
  searchWorkspaceText(
    repository: RepositoryRef,
    headSha: string,
    query: string,
    options?: { maxResults?: number; maxFiles?: number; maxFileBytes?: number }
  ): Promise<WorkspaceTextSearchResult>;
  loadWorkspaceTree(repository: RepositoryRef, headSha: string): Promise<WorkspaceTree>;
}

export interface ReviewToolContext {
  repos: ReviewRepoAccess;
  repository: RepositoryRef;
  pullProvider: ProviderId;
  pullNumber: number;
  headSha: string;
  model: string;
  generatedAt: string;
  changedFiles: ChangedFile[];
  changeMap?: ChangeMap;
  onUpdate: (tour: ReviewTour) => void;
  signal?: AbortSignal;
}

export interface ToolOutcome {
  content: string;
  isError?: boolean;
}

export interface ReviewToolset {
  tools: ToolDef[];
  execute(call: ToolCall): Promise<ToolOutcome>;
  build(): ReviewTour;
  finishRequested: boolean;
  chapterCount: number;
}

interface WorkingChapter {
  id: string;
  title: string;
  summary: string;
  files: string[];
  kind?: ChapterKind;
  riskLevel: RiskLevel;
  riskReasons: string[];
  reviewChecklist: string[];
  dependencies: string[];
  anchors: DiffAnchor[];
}

interface WorkingEdge {
  id: string;
  from: string;
  to: string;
  relation: "dependency" | "extension" | "gating" | "verification" | "risk";
  confidence: number;
  reason?: string;
}

interface WorkingRiskSignal {
  id: string;
  level: RiskLevel;
  title: string;
  files: string[];
  reason: string;
}

export function createReviewToolset(ctx: ReviewToolContext): ReviewToolset {
  const chapters = new Map<string, WorkingChapter>();
  const chapterOrder: string[] = [];
  const edges: WorkingEdge[] = [];
  const riskSignals: WorkingRiskSignal[] = [];
  const tourId = randomUUID();
  const changedByPath = new Map(ctx.changedFiles.map((file) => [file.path, file]));
  let finished = false;
  let edgeCounter = 0;
  let riskCounter = 0;

  function buildTour(): ReviewTour {
    const rawChapters: TourChapter[] = chapterOrder.map((id) => finalizeChapter(chapters.get(id)!, ctx, changedByPath));
    const chapterIds = new Set(rawChapters.map((chapter) => chapter.id));
    // Drop dependency ids that don't correspond to a real chapter so the tour
    // never carries dangling references.
    const builtChapters = rawChapters.map((chapter) => ({
      ...chapter,
      dependencies: chapter.dependencies.filter((id) => id !== chapter.id && chapterIds.has(id))
    }));
    const builtEdges = edges
      .filter((edge) => edge.from !== edge.to && chapterIds.has(edge.from) && chapterIds.has(edge.to))
      .map((edge) => ({ id: edge.id, from: edge.from, to: edge.to, relation: edge.relation, confidence: edge.confidence, source: "ai" as const, ...(edge.reason ? { reason: edge.reason } : {}) }));
    // Add deterministic dependency edges grounded in real references, skipping any
    // chapter pair the agent already connected (the agent's chosen relation wins).
    // Ids are keyed by the chapter pair so they stay unique and stable across the
    // partial snapshots emitted while streaming.
    const connected = new Set(builtEdges.map((edge) => `${edge.from}->${edge.to}`));
    const deterministic = (ctx.changeMap ? deterministicEdgesFromChangeMap(ctx.changeMap, builtChapters) : [])
      .filter((edge) => !connected.has(`${edge.from}->${edge.to}`))
      .map((edge) => ({ id: `edge-det-${edge.from}-${edge.to}`, ...edge }));
    return reviewTourSchema.parse({
      id: tourId,
      provider: ctx.pullProvider,
      repository: ctx.repository,
      pullNumber: ctx.pullNumber,
      headSha: ctx.headSha,
      generatedAt: ctx.generatedAt,
      model: ctx.model,
      chapters: builtChapters,
      graph: {
        nodes: builtChapters.map((chapter) => ({ id: chapter.id, label: chapter.title, riskLevel: chapter.riskLevel, files: chapter.files })),
        edges: [...builtEdges, ...deterministic]
      },
      riskSignals
    });
  }

  function emitUpdate(): void {
    if (chapterOrder.length === 0) {
      return;
    }
    try {
      ctx.onUpdate(buildTour());
    } catch {
      // A partial tour that briefly fails validation is not worth surfacing;
      // the next emit will produce a valid snapshot.
    }
  }

  const execute = async (call: ToolCall): Promise<ToolOutcome> => {
    if (ctx.signal?.aborted) {
      return { content: "Generation was cancelled.", isError: true };
    }
    const args = (call.arguments && typeof call.arguments === "object" ? call.arguments : {}) as Record<string, unknown>;
    switch (call.name) {
      case "list_changed_files":
        return listChangedFiles(ctx.changedFiles);
      case "get_file_diff":
        return getFileDiff(ctx, args);
      case "read_file":
        return readFile(ctx, args);
      case "search_text":
        return searchText(ctx, args);
      case "list_files":
        return listFiles(ctx, args);
      case "get_blast_radius":
        return getBlastRadius(ctx, args);
      case "add_chapter":
        return addChapter(args);
      case "add_inline_comment":
        return addInlineComment(args);
      case "add_edge":
        return addEdge(args);
      case "add_risk_signal":
        return addRiskSignal(args);
      case "finish":
        finished = true;
        return { content: `Review tour finished with ${chapterOrder.length} chapter(s).` };
      default:
        return { content: `Unknown tool "${call.name}".`, isError: true };
    }
  };

  function addChapter(args: Record<string, unknown>): ToolOutcome {
    const id = asString(args.id);
    const title = asString(args.title);
    if (!id || !title) {
      return { content: "add_chapter requires a non-empty `id` and `title`.", isError: true };
    }
    const existing = chapters.get(id);
    const chapter: WorkingChapter = {
      id,
      title,
      summary: asString(args.summary) ?? existing?.summary ?? "",
      files: dedupe(asStringArray(args.files).length ? asStringArray(args.files) : existing?.files ?? []),
      kind: asChapterKind(args.kind) ?? existing?.kind,
      riskLevel: asRiskLevel(args.riskLevel) ?? existing?.riskLevel ?? "low",
      riskReasons: asStringArray(args.riskReasons).length ? asStringArray(args.riskReasons) : existing?.riskReasons ?? [],
      reviewChecklist: asStringArray(args.reviewChecklist).length ? asStringArray(args.reviewChecklist) : existing?.reviewChecklist ?? [],
      dependencies: dedupe(asStringArray(args.dependencies).length ? asStringArray(args.dependencies) : existing?.dependencies ?? []),
      anchors: existing?.anchors ?? []
    };
    chapters.set(id, chapter);
    if (!existing) {
      chapterOrder.push(id);
    }
    emitUpdate();
    return { content: `Chapter "${id}" recorded${existing ? " (updated)" : ""}.` };
  }

  function addInlineComment(args: Record<string, unknown>): ToolOutcome {
    const chapterId = asString(args.chapterId);
    const path = asString(args.path);
    const comment = asString(args.comment);
    if (!chapterId || !path || !comment) {
      return { content: "add_inline_comment requires `chapterId`, `path`, and `comment`.", isError: true };
    }
    const chapter = chapters.get(chapterId);
    if (!chapter) {
      return { content: `Unknown chapterId "${chapterId}". Call add_chapter first.`, isError: true };
    }
    const start = asPositiveInt(args.startLine);
    const end = asPositiveInt(args.endLine);
    const severity = asSeverity(args.severity);
    const category = asCategory(args.category);
    chapter.anchors.push({
      path,
      side: args.side === "left" ? "left" : "right",
      ...(start ? { startLine: start } : {}),
      ...(end ? { endLine: end } : {}),
      note: comment,
      ...(severity ? { severity } : {}),
      ...(category ? { category } : {})
    });
    if (!chapter.files.includes(path)) {
      chapter.files.push(path);
    }
    emitUpdate();
    return { content: `Inline comment added to ${path}${start ? `:${start}` : ""}.` };
  }

  function addEdge(args: Record<string, unknown>): ToolOutcome {
    const from = asString(args.from);
    const to = asString(args.to);
    const relation = asRelation(args.relation);
    if (!from || !to || !relation) {
      return { content: "add_edge requires `from`, `to`, and a `relation` of dependency|extension|gating|verification|risk.", isError: true };
    }
    if (from === to) {
      return { content: "An edge cannot connect a chapter to itself.", isError: true };
    }
    if (!chapters.has(from) || !chapters.has(to)) {
      return { content: `Both chapters must exist before linking them (from="${from}", to="${to}").`, isError: true };
    }
    if (edges.some((edge) => edge.from === from && edge.to === to)) {
      return { content: `Edge ${from} → ${to} already exists.` };
    }
    edges.push({
      id: `edge-${(edgeCounter += 1)}`,
      from,
      to,
      relation,
      confidence: clampConfidence(args.confidence),
      reason: asString(args.reason) ?? undefined
    });
    emitUpdate();
    return { content: `Edge ${from} → ${to} (${relation}) recorded.` };
  }

  function addRiskSignal(args: Record<string, unknown>): ToolOutcome {
    const level = asRiskLevel(args.level);
    const title = asString(args.title);
    const reason = asString(args.reason);
    if (!level || !title || !reason) {
      return { content: "add_risk_signal requires `level`, `title`, and `reason`.", isError: true };
    }
    riskSignals.push({ id: `risk-${(riskCounter += 1)}`, level, title, files: asStringArray(args.files), reason });
    emitUpdate();
    return { content: `Risk signal "${title}" recorded.` };
  }

  return {
    tools: REVIEW_TOOLS,
    execute,
    build: buildTour,
    get finishRequested() {
      return finished;
    },
    get chapterCount() {
      return chapterOrder.length;
    }
  };
}

function finalizeChapter(chapter: WorkingChapter, ctx: ReviewToolContext, changedByPath: Map<string, ChangedFile>): TourChapter {
  let additions = 0;
  let deletions = 0;
  for (const path of chapter.files) {
    const file = changedByPath.get(path);
    if (file) {
      additions += file.additions;
      deletions += file.deletions;
    }
  }
  const impact = ctx.changeMap ? blastRadiusForFiles(ctx.changeMap, chapter.files) : null;
  return {
    id: chapter.id,
    title: chapter.title,
    summary: chapter.summary,
    files: chapter.files,
    diffAnchors: chapter.anchors.length ? chapter.anchors : chapter.files[0] ? [{ path: chapter.files[0], side: "right" }] : [],
    changeStats: { additions, deletions, files: chapter.files.length },
    riskLevel: chapter.riskLevel,
    riskReasons: chapter.riskReasons,
    reviewChecklist: chapter.reviewChecklist,
    dependencies: chapter.dependencies,
    ...(chapter.kind ? { kind: chapter.kind } : {}),
    ...(impact && (impact.blastRadiusFiles.length > 0 || impact.touchedSymbols.length > 0) ? { impact } : {}),
    generatedAt: ctx.generatedAt,
    model: ctx.model,
    headSha: ctx.headSha
  };
}

// --- Explore tool executors -------------------------------------------------

function listChangedFiles(changedFiles: ChangedFile[]): ToolOutcome {
  if (changedFiles.length === 0) {
    return { content: "This pull request has no changed files." };
  }
  const lines = changedFiles.map((file) => {
    const flags = [file.isLarge ? "large" : "", file.isGenerated ? "generated" : ""].filter(Boolean).join(",");
    return `${file.path} [${file.status}, +${file.additions}/-${file.deletions}${file.language ? `, ${file.language}` : ""}${flags ? `, ${flags}` : ""}]`;
  });
  return { content: `Changed files (${changedFiles.length}):\n${lines.join("\n")}` };
}

async function getFileDiff(ctx: ReviewToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const path = asString(args.path);
  if (!path) {
    return { content: "get_file_diff requires a `path`.", isError: true };
  }
  const patch = await ctx.repos.getLocalFilePatch(ctx.repository, ctx.pullNumber, path, ctx.headSha);
  if (!patch || !patch.patch) {
    return { content: `No diff is available for ${path}.`, isError: true };
  }
  const redacted = redactTextForAi(patch.patch);
  return { content: truncate(redacted, MAX_DIFF_CHARS, `diff for ${path}`) };
}

async function readFile(ctx: ReviewToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const path = asString(args.path);
  if (!path) {
    return { content: "read_file requires a `path`.", isError: true };
  }
  let content: FileContent | null;
  try {
    content = await ctx.repos.getLocalFileContent(ctx.repository, path, ctx.headSha);
  } catch (error) {
    return { content: `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`, isError: true };
  }
  if (!content) {
    return { content: `${path} was not found in the checked-out worktree.`, isError: true };
  }
  const start = asPositiveInt(args.startLine);
  const end = asPositiveInt(args.endLine);
  const lines = content.contents.split("\n");
  const from = start ? Math.max(1, start) : 1;
  const to = end ? Math.min(lines.length, end) : lines.length;
  const slice = lines
    .slice(from - 1, to)
    .map((line, index) => `${from + index}\t${line}`)
    .join("\n");
  const redacted = redactTextForAi(slice);
  return { content: truncate(redacted, MAX_FILE_CHARS, path) };
}

async function searchText(ctx: ReviewToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const query = asString(args.query);
  if (!query) {
    return { content: "search_text requires a `query`.", isError: true };
  }
  const maxResults = Math.min(MAX_SEARCH_RESULTS, asPositiveInt(args.maxResults) ?? MAX_SEARCH_RESULTS);
  const result = await ctx.repos.searchWorkspaceText(ctx.repository, ctx.headSha, query, { maxResults });
  if (result.results.length === 0) {
    return { content: `No matches for "${query}".` };
  }
  const lines: string[] = [];
  for (const match of result.results) {
    for (const hit of match.matches) {
      lines.push(`${match.path}:${hit.lineNumber}: ${hit.lineText.trim()}`);
    }
  }
  const body = redactTextForAi(lines.join("\n"));
  return { content: `Matches for "${query}"${result.truncated ? " (truncated)" : ""}:\n${truncate(body, MAX_FILE_CHARS, "search results")}` };
}

async function listFiles(ctx: ReviewToolContext, args: Record<string, unknown>): Promise<ToolOutcome> {
  const directory = asString(args.directory);
  const tree = await ctx.repos.loadWorkspaceTree(ctx.repository, ctx.headSha);
  const prefix = directory ? `${directory.replace(/\/+$/, "")}/` : "";
  const matched = (prefix ? tree.paths.filter((path) => path.startsWith(prefix)) : tree.paths).slice(0, MAX_LISTED_FILES);
  if (matched.length === 0) {
    return { content: directory ? `No files under "${directory}".` : "No files in the worktree." };
  }
  const truncatedNote = tree.paths.length > matched.length ? `\n… (${tree.paths.length - matched.length} more not shown)` : "";
  return { content: `${matched.join("\n")}${truncatedNote}` };
}

function getBlastRadius(ctx: ReviewToolContext, args: Record<string, unknown>): ToolOutcome {
  const path = asString(args.path);
  if (!path) {
    return { content: "get_blast_radius requires a `path`.", isError: true };
  }
  if (!ctx.changeMap) {
    return { content: "No static blast-radius data is available; use search_text to find callers of changed symbols." };
  }
  const symbols = ctx.changeMap.symbols.filter((symbol) => symbol.definedIn === path);
  if (symbols.length === 0) {
    return { content: `No analyzed symbols are defined in changed regions of ${path}. Use search_text to find callers if needed.` };
  }
  const lines = symbols.map((symbol) => {
    if (symbol.referencedBy.length === 0) {
      return `\`${symbol.symbol}\` — no references found outside ${path}.`;
    }
    return `\`${symbol.symbol}\` is referenced by ${symbol.referencedBy.length} file(s): ${symbol.referencedBy.slice(0, 12).join(", ")}`;
  });
  return { content: `Blast radius for ${path}:\n${lines.join("\n")}` };
}

// --- Tool definitions -------------------------------------------------------

const RISK_ENUM = ["low", "medium", "high"];
const RELATION_ENUM = ["dependency", "extension", "gating", "verification", "risk"];
const SIDE_ENUM = ["left", "right"];
const KIND_ENUM = ["concept", "replacement", "behavior", "plumbing", "config", "verification", "cleanup"];
const SEVERITY_ENUM = ["info", "nit", "warning", "blocker"];
const CATEGORY_ENUM = ["correctness", "security", "performance", "style", "testing", "design", "docs"];

export const REVIEW_TOOLS: ToolDef[] = [
  {
    name: "list_changed_files",
    description: "List every file changed in this pull request with its status and added/removed line counts. Call this first to orient yourself.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "get_file_diff",
    description: "Get the unified diff (patch) for a single changed file so you can see exactly what changed and on which lines.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repository-relative path of the file." } }, required: ["path"], additionalProperties: false }
  },
  {
    name: "read_file",
    description: "Read the full current contents of any file in the checked-out repository (not just changed files), optionally a line range. Use this to understand surrounding code, follow imports, and judge how a change fits in.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Repository-relative path of the file." },
        startLine: { type: "integer", description: "Optional 1-based first line to read." },
        endLine: { type: "integer", description: "Optional 1-based last line to read." }
      },
      required: ["path"],
      additionalProperties: false
    }
  },
  {
    name: "search_text",
    description: "Search the whole repository for text (e.g. a symbol or function name) to find callers, definitions, and related code that the diff does not show. Returns path:line matches.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" }, maxResults: { type: "integer", description: "Optional cap on matches (default 30)." } },
      required: ["query"],
      additionalProperties: false
    }
  },
  {
    name: "list_files",
    description: "List files in the repository, optionally under a directory prefix, to discover structure and related modules.",
    parameters: { type: "object", properties: { directory: { type: "string", description: "Optional directory prefix to list under." } }, additionalProperties: false }
  },
  {
    name: "get_blast_radius",
    description:
      "Look up the static-analysis blast radius for a changed file: which symbols it defines in the changed regions and which other files reference them. Use this to judge risk and to connect chapters. Falls back to suggesting search_text when analysis is unavailable.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Repository-relative path of a changed file." } }, required: ["path"], additionalProperties: false }
  },
  {
    name: "add_chapter",
    description:
      "Record one chapter of the guided tour. A chapter is one coherent idea or unit of change (a new concept, a replacement, a behavior change, plumbing, a config gate, or verification) — NOT one-per-file. Split tests into their own chapter. Call this before adding inline comments or edges that reference the chapter.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "Stable id such as chapter-1." },
        title: { type: "string", description: "Name the chapter after its key construct and role, e.g. 'StreamPermit — the new backpressure primitive'." },
        summary: { type: "string", description: "One sentence on what the change is, then 2-4 short Markdown bullets on how it works and what to watch for. Use backticks for real identifiers from the code." },
        files: { type: "array", items: { type: "string" }, description: "Repository-relative paths this chapter covers." },
        kind: { type: "string", enum: ["concept", "replacement", "behavior", "plumbing", "config", "verification", "cleanup"], description: "Optional categorization of the chapter." },
        riskLevel: { type: "string", enum: RISK_ENUM, description: "Blast-radius-based risk: high = scrutinize before approving." },
        riskReasons: { type: "array", items: { type: "string" }, description: "Specific 'here is the hazard and what to verify' notes." },
        reviewChecklist: { type: "array", items: { type: "string" }, description: "Concrete, chapter-specific checks the reviewer can perform." },
        dependencies: { type: "array", items: { type: "string" }, description: "Ids of chapters this one builds on." }
      },
      required: ["id", "title", "summary", "files", "riskLevel"],
      additionalProperties: false
    }
  },
  {
    name: "add_inline_comment",
    description:
      "Drop a short, plain-language inline comment on a specific changed region, the way you would walk a colleague through the diff line by line. Be generous: comment most meaningful changed regions so the diff reads like a guided walkthrough. Roughly 3-15 words, no trailing period needed.",
    parameters: {
      type: "object",
      properties: {
        chapterId: { type: "string", description: "Id of the chapter this comment belongs to." },
        path: { type: "string", description: "Repository-relative path of the file." },
        startLine: { type: "integer", description: "1-based first line of the region (from the diff's new side unless side=left)." },
        endLine: { type: "integer", description: "Optional 1-based last line for a multi-line region." },
        side: { type: "string", enum: SIDE_ENUM, description: "Diff side; defaults to right (new code)." },
        comment: { type: "string", description: "The inline comment text (may use Markdown)." },
        severity: { type: "string", enum: SEVERITY_ENUM, description: "Optional: info (default) for primers, nit/warning/blocker for issues." },
        category: { type: "string", enum: CATEGORY_ENUM, description: "Optional topic, e.g. correctness, security, performance, testing, design." }
      },
      required: ["chapterId", "path", "comment"],
      additionalProperties: false
    }
  },
  {
    name: "add_edge",
    description:
      "Connect two chapters in the dependency storyboard. Point from the prerequisite/foundation chapter (from) to the chapter that builds on it (to). Choose the relation that best fits the link.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Id of the prerequisite/foundation chapter." },
        to: { type: "string", description: "Id of the chapter that builds on it." },
        relation: { type: "string", enum: RELATION_ENUM, description: "dependency (uses), extension (specializes), gating (config/flag guards it), verification (tests exercise it), risk (cross-cutting hazard)." },
        confidence: { type: "number", description: "0..1 confidence in the link (default 0.7)." },
        reason: { type: "string", description: "Optional one-line justification for the link." }
      },
      required: ["from", "to", "relation"],
      additionalProperties: false
    }
  },
  {
    name: "add_risk_signal",
    description: "Record a top-level, cross-cutting risk that spans the change. Only surface the few most important hazards; do not duplicate every chapter.",
    parameters: {
      type: "object",
      properties: {
        level: { type: "string", enum: RISK_ENUM },
        title: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        reason: { type: "string", description: "Name the exact failure mode and the property to verify." }
      },
      required: ["level", "title", "reason"],
      additionalProperties: false
    }
  },
  {
    name: "finish",
    description: "Call this once the tour is complete: every meaningful change is covered by a chapter, inline comments guide the diff, the storyboard edges connect the chapters, and risks are recorded.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  }
];

// A short, human-readable description of a tool call for the live activity feed.
export function describeToolCall(call: ToolCall): string {
  const args = (call.arguments && typeof call.arguments === "object" ? call.arguments : {}) as Record<string, unknown>;
  const str = (key: string): string => (typeof args[key] === "string" ? (args[key] as string) : "");
  switch (call.name) {
    case "list_changed_files":
      return "Reviewing the changed files";
    case "get_file_diff":
      return `Reading the diff for ${str("path") || "a file"}`;
    case "read_file":
      return `Reading ${str("path") || "a file"}`;
    case "search_text":
      return `Searching for "${str("query")}"`;
    case "list_files":
      return str("directory") ? `Listing ${str("directory")}` : "Exploring the file tree";
    case "get_blast_radius":
      return `Checking the blast radius of ${str("path") || "a change"}`;
    case "add_chapter":
      return `Drafting chapter — ${str("title") || str("id") || "a chapter"}`;
    case "add_inline_comment":
      return `Commenting on ${str("path") || "the diff"}`;
    case "add_edge":
      return `Linking ${str("from") || "a chapter"} → ${str("to") || "another"}`;
    case "add_risk_signal":
      return `Flagging a risk — ${str("title") || "a hazard"}`;
    case "finish":
      return "Wrapping up the tour";
    default:
      return `Running ${call.name}`;
  }
}

// --- Coercion helpers -------------------------------------------------------

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  return typeof value === "string" && value.trim().length > 0 ? [value] : [];
}

function asPositiveInt(value: unknown): number | null {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : null;
}

function asRiskLevel(value: unknown): RiskLevel | null {
  const text = String(value ?? "").toLowerCase();
  if (text.includes("high") || text.includes("crit") || text.includes("sev")) {
    return "high";
  }
  if (text.includes("med") || text.includes("mod")) {
    return "medium";
  }
  if (text.includes("low")) {
    return "low";
  }
  return null;
}

function asRelation(value: unknown): WorkingEdge["relation"] | null {
  const text = String(value ?? "").toLowerCase().trim();
  if (RELATION_ENUM.includes(text)) {
    return text as WorkingEdge["relation"];
  }
  if (text.startsWith("depend") || text === "uses" || text === "requires") {
    return "dependency";
  }
  if (text.startsWith("extend")) {
    return "extension";
  }
  if (text.startsWith("gat")) {
    return "gating";
  }
  if (text.startsWith("verif") || text === "tests") {
    return "verification";
  }
  if (text.startsWith("risk")) {
    return "risk";
  }
  return null;
}

function asChapterKind(value: unknown): ChapterKind | null {
  const text = String(value ?? "").toLowerCase().trim();
  return (KIND_ENUM as string[]).includes(text) ? (text as ChapterKind) : null;
}

function asSeverity(value: unknown): InlineCommentSeverity | null {
  const text = String(value ?? "").toLowerCase().trim();
  return (SEVERITY_ENUM as string[]).includes(text) ? (text as InlineCommentSeverity) : null;
}

function asCategory(value: unknown): InlineCommentCategory | null {
  const text = String(value ?? "").toLowerCase().trim();
  return (CATEGORY_ENUM as string[]).includes(text) ? (text as InlineCommentCategory) : null;
}

function clampConfidence(value: unknown): number {
  let confidence = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(confidence)) {
    return 0.7;
  }
  if (confidence > 1) {
    confidence = confidence / 100;
  }
  return Math.max(0, Math.min(1, confidence));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function truncate(text: string, maxChars: number, label: string): string {
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}\n… [${label} truncated at ${maxChars} characters]`;
}
