import { useMutation, useQuery } from "@tanstack/react-query";
import { processFile } from "@pierre/diffs";
import { File as CodeFileView, FileDiff as DiffFileView, useWorkerPool } from "@pierre/diffs/react";
import type { FileContents, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Cog,
  ExternalLink,
  GitBranch,
  GitCommit,
  GitPullRequestArrow,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  RefreshCw,
  Smile,
  Sparkles,
  Tag
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { krtClient } from "../api/client.js";
import { formatCount, formatDate, statusClass } from "../lib/format.js";
import { renderMarkdown } from "../lib/markdown.js";
import type { PrTab } from "../store/uiStore.js";
import { useUiStore } from "../store/uiStore.js";
import type {
  Actor,
  ActivityEvent,
  ChangedFile,
  FileContent,
  OperationProgress,
  PullRequestDetail,
  ReactionContent,
  ReactionGroup,
  ReviewComment,
  ReviewThread
} from "../../shared/schemas.js";

interface PullRequestOverviewProps {
  tab: PrTab;
}

export function PullRequestOverview({ tab }: PullRequestOverviewProps): React.JSX.Element {
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const setReviewSubMode = useUiStore((state) => state.setReviewSubMode);
  const updatePrTab = useUiStore((state) => state.updatePrTab);
  const setTour = useUiStore((state) => state.setTour);
  const setTourOperation = useUiStore((state) => state.setTourOperation);
  const setTourProgress = useUiStore((state) => state.setTourProgress);
  const detail = tab.bundle.detail;
  const [refreshProgress, setRefreshProgress] = useState<OperationProgress | null>(null);
  const [refreshOperationId, setRefreshOperationId] = useState<string | null>(null);
  const [lastSync, setLastSync] = useState<string>("just now");
  const handledRefreshOp = useRef<string | null>(null);

  const refreshMutation = useMutation({
    onMutate: () => {
      setRefreshProgress(null);
      setRefreshOperationId(null);
    },
    mutationFn: () =>
      krtClient.pullRequests.startRefresh({
        repository: detail.repository,
        number: detail.number,
        mode: tab.mode
      }),
    onSuccess: (result) => {
      setRefreshOperationId(result.operationId);
      void krtClient.operations.progressSnapshot({ operationId: result.operationId }).then((progress) => {
        if (progress) {
          setRefreshProgress(progress);
        }
      });
    }
  });

  useEffect(() => {
    if (!refreshOperationId) {
      return undefined;
    }
    return krtClient.operations.onProgress((progress) => {
      if (progress.operationId === refreshOperationId) {
        setRefreshProgress(progress);
      }
    });
  }, [refreshOperationId]);

  useEffect(() => {
    if (!refreshOperationId || !refreshProgress?.done || refreshProgress.cancelled || refreshProgress.phase !== "complete") {
      return undefined;
    }
    // Handle each completed refresh exactly once. The refresh-state resets are
    // deferred to the `finally` below so they cannot flip `active` and cancel
    // the forced tour regeneration before it has been tracked.
    if (handledRefreshOp.current === refreshOperationId) {
      return undefined;
    }
    handledRefreshOp.current = refreshOperationId;
    let active = true;
    void (async () => {
      try {
        const bundle = await krtClient.pullRequests.refreshResult({ operationId: refreshOperationId });
        if (!active || !bundle) {
          return;
        }
        updatePrTab(bundle);
        setLastSync("just now");
        // Force-regenerate the tour for the refreshed bundle. Ownership of the
        // operation is handed to the store so the always-mounted
        // TourGenerationManager keeps streaming it even if this overview (or the
        // whole tab) is unmounted while it runs.
        setTour(tab.key, null);
        setTourProgress(tab.key, null);
        const result = await krtClient.ai.startTourGeneration({
          pullRequest: bundle.detail,
          changedFiles: bundle.changedFiles,
          timeline: bundle.timeline,
          reviewThreads: bundle.reviewThreads,
          checks: bundle.checks,
          force: true
        });
        if (result.cachedTour) {
          setTour(tab.key, result.cachedTour);
          setTourOperation(tab.key, null);
        } else {
          setTourOperation(tab.key, result.operationId);
          const progress = await krtClient.operations.progressSnapshot({ operationId: result.operationId });
          if (progress) {
            setTourProgress(tab.key, progress);
          }
        }
      } catch {
        // Leave the tour cleared; the user can retry from the tour view.
      } finally {
        if (active) {
          setRefreshOperationId(null);
          setRefreshProgress(null);
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [refreshOperationId, refreshProgress?.cancelled, refreshProgress?.done, refreshProgress?.phase, setTour, setTourOperation, setTourProgress, tab.key, updatePrTab]);

  const refreshActive =
    refreshMutation.isPending ||
    (Boolean(refreshOperationId) && (!refreshProgress || !refreshProgress.done)) ||
    Boolean(tab.tourOperationId);
  const totalFiles = tab.bundle.changedFiles.length || detail.changedFileCount;
  const stateChip = stateBadge(detail.state, detail.draft);
  const reviewerSummary = detail.reviewers.slice(0, 4);

  return (
    <main className="view overview-view">
      <div className="overview-scroll">
        <div className="overview-grid">
          <div className="overview-main">
            {/* link + state + refresh */}
            <div className="pr-toprow">
              <a
                className="pr-link mono"
                href={detail.url}
                target="_blank"
                rel="noopener noreferrer"
                title="Open on the source host"
              >
                <span>{detail.repository.fullName} #{detail.number}</span>
                <ExternalLink size={9} aria-hidden="true" />
              </a>
              {stateChip}
              <span className="pr-toprow-spacer" />
              <span className="pr-sync">Synced {lastSync}</span>
              <button
                type="button"
                className="icon-button pr-refresh"
                aria-label="Refresh PR and tour"
                title="Refresh PR and tour"
                disabled={refreshActive}
                onClick={() => refreshMutation.mutate()}
              >
                <RefreshCw className={refreshActive ? "spin" : undefined} size={13} aria-hidden="true" />
              </button>
            </div>

            {/* title */}
            <h1 className="pr-title">{detail.title}</h1>

            {/* author / branch / counts */}
            <div className="pr-meta">
              <Avatar login={detail.author.login} avatarUrl={detail.author.avatarUrl} />
              <span className="pr-meta-author">{detail.author.login}</span>
              <span className="pr-meta-branch mono">{detail.headRef || detail.headSha.slice(0, 7)}</span>
              <span className="pr-meta-arrow">→</span>
              <span className="pr-meta-branch mono">{detail.baseRef}</span>
              <span className="pr-meta-spacer" />
              <span className="mono pr-meta-stats">
                <span className="diff-counts-add">+{detail.additions}</span>{" "}
                <span className="diff-counts-del">−{detail.deletions}</span>
                {" · "}
                {totalFiles} files
              </span>
            </div>

            {/* description */}
            <section className="pr-card">
              <header className="pr-card-header">
                <span>Description</span>
                <button
                  type="button"
                  className="secondary-button pr-card-action"
                  onClick={() => {
                    setTabViewMode(tab.key, "review");
                    setReviewSubMode(tab.key, "tour");
                  }}
                >
                  <Bot size={11} aria-hidden="true" />
                  Open tour
                </button>
              </header>
              <div
                className="markdown pr-card-body"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(detail.body || "_No description provided._") }}
              />
            </section>

            <ActivitySection tab={tab} />
            <CommentComposer tab={tab} />
          </div>

          <aside className="overview-side">
            <SideCard title="Reviewers">
              {reviewerSummary.length === 0 ? <span className="muted">none requested</span> : null}
              {reviewerSummary.map((reviewer) => (
                <div className="overview-side-row" key={reviewer.login}>
                  <Avatar login={reviewer.login} avatarUrl={reviewer.avatarUrl} size="s" />
                  <span className="mono">{reviewer.login}</span>
                </div>
              ))}
            </SideCard>

            <SideCard title="Checks">
              {tab.bundle.checks.length === 0 ? <span className="muted">No check runs loaded</span> : null}
              {tab.bundle.checks.map((check) => (
                <a className="overview-check-row" href={check.url} target="_blank" rel="noreferrer" key={check.id}>
                  <CheckCircle2 size={13} aria-hidden="true" className={statusClass(check.conclusion ?? check.status)} />
                  <span className="mono">{check.name}</span>
                  <span className={`status-pill ${statusClass(check.conclusion ?? check.status)}`}>
                    {check.conclusion ?? check.status}
                  </span>
                </a>
              ))}
            </SideCard>

            <SideCard title="Labels">
              <div className="file-pills">
                {detail.labels.length === 0 ? <span>unlabeled</span> : null}
                {detail.labels.map((label) => (
                  <span key={label}>{label}</span>
                ))}
              </div>
            </SideCard>

            <SideCard title="Stats">
              <Stat label="Mode" value={tab.mode === "managed" ? "Managed" : "API"} />
              <Stat label="Files" value={formatCount(totalFiles)} />
              <Stat label="Lines added" value={`+${formatCount(detail.additions)}`} kind="add" />
              <Stat label="Lines removed" value={`−${formatCount(detail.deletions)}`} kind="del" />
              <Stat label="Threads" value={formatCount(tab.bundle.reviewThreads.length)} />
              <Stat label="Updated" value={formatDate(detail.updatedAt)} />
            </SideCard>

            <button
              type="button"
              className="primary-button overview-start-review"
              onClick={() => setTabViewMode(tab.key, "review")}
            >
              <GitPullRequestArrow size={13} aria-hidden="true" />
              Start review
            </button>
          </aside>
        </div>
      </div>
    </main>
  );
}

function stateBadge(state: string, draft: boolean): React.JSX.Element {
  if (draft) {
    return <span className="chip">Draft</span>;
  }
  if (state === "open") {
    return (
      <span className="chip add">
        <span className="dot" />
        Open
      </span>
    );
  }
  if (state === "merged") {
    return <span className="chip accent">Merged</span>;
  }
  return <span className="chip">{state}</span>;
}

interface AvatarProps {
  login: string;
  avatarUrl?: string;
  size?: "s" | "m";
}

function Avatar({ login, avatarUrl, size = "m" }: AvatarProps): React.JSX.Element {
  const initials = login
    .replace(/[^a-zA-Z0-9]/g, " ")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("") || "?";
  const url = avatarUrl ?? githubAvatarUrl(login);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [url]);
  const showImage = Boolean(url) && !errored;
  const showFallback = !showImage || !loaded;
  return (
    <span className={`avatar ${size === "s" ? "is-s" : ""}`} aria-label={login} title={login}>
      {showImage && url ? (
        <img
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      ) : null}
      {showFallback ? <span className="avatar-fallback" aria-hidden="true">{initials}</span> : null}
    </span>
  );
}

function githubAvatarUrl(login: string): string | null {
  if (!login) {
    return null;
  }
  if (login.includes("[bot]")) {
    return null;
  }
  return `https://github.com/${login}.png?size=64`;
}

interface SideCardProps {
  title: string;
  children: React.ReactNode;
}

function SideCard({ title, children }: SideCardProps): React.JSX.Element {
  return (
    <section className="overview-card">
      <header className="overview-card-header">{title}</header>
      <div className="overview-card-body">{children}</div>
    </section>
  );
}

interface StatProps {
  label: string;
  value: string;
  kind?: "add" | "del";
}

function Stat({ label, value, kind }: StatProps): React.JSX.Element {
  const valueClass = kind === "add" ? "diff-counts-add" : kind === "del" ? "diff-counts-del" : "";
  return (
    <div className="overview-stat">
      <span>{label}</span>
      <span className={`mono ${valueClass}`}>{value}</span>
    </div>
  );
}

interface CommentComposerProps {
  tab: PrTab;
}

function CommentComposer({ tab }: CommentComposerProps): React.JSX.Element {
  const [composerTab, setComposerTab] = useState<"write" | "preview">("write");
  const [body, setBody] = useState("");
  const composerMutation = useMutation({
    mutationFn: () =>
      krtClient.comments.postIssueComment({
        repository: tab.bundle.detail.repository,
        number: tab.bundle.detail.number,
        body
      }),
    onSuccess: () => setBody("")
  });
  const empty = !body.trim();
  return (
    <section className="comment-composer">
      <header className="comment-composer-tabs">
        <button
          type="button"
          className={composerTab === "write" ? "comment-composer-tab is-active" : "comment-composer-tab"}
          onClick={() => setComposerTab("write")}
        >
          Write
        </button>
        <button
          type="button"
          className={composerTab === "preview" ? "comment-composer-tab is-active" : "comment-composer-tab"}
          onClick={() => setComposerTab("preview")}
        >
          Preview
        </button>
      </header>
      {composerTab === "write" ? (
        <textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Leave a comment… (Markdown supported)"
          rows={4}
        />
      ) : (
        <div
          className="comment-composer-preview markdown"
          dangerouslySetInnerHTML={{
            __html: empty ? "<em>Nothing to preview yet.</em>" : renderMarkdown(body)
          }}
        />
      )}
      <footer className="comment-composer-footer">
        <span className="muted">Markdown · ⌘↵ to send</span>
        <button
          type="button"
          className="secondary-button"
          disabled={empty || composerMutation.isPending}
          onClick={() => composerMutation.mutate()}
        >
          <MessageSquare size={11} aria-hidden="true" />
          Comment
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={composerMutation.isPending}
          onClick={() => composerMutation.mutate()}
        >
          <Check size={11} aria-hidden="true" />
          Approve
        </button>
      </footer>
    </section>
  );
}

interface DiffCommentLocation {
  path?: string;
  line?: number;
  side?: "left" | "right";
  startLine?: number;
  startSide?: "left" | "right";
  originalLine?: number;
  originalStartLine?: number;
  originalCommitId?: string;
  diffHunk?: string;
  outdated?: boolean;
}

interface DiffPreviewData {
  path: string;
  line?: number;
  side: "left" | "right";
  fileDiff: FileDiffMetadata;
  selectedLines: SelectedLineRange | null;
  historical: boolean;
}

function DiffCommentPreview({
  file,
  location,
  pullRequest,
  onOpenFile
}: {
  file?: ChangedFile;
  location: DiffCommentLocation;
  pullRequest: PullRequestDetail;
  onOpenFile: (path: string, line?: number) => void;
}): React.JSX.Element | null {
  const patchPath = location.path;
  const fileLevelLocation = isFileLevelLocation(location);
  const filePreviewPath = patchPath ? fileCommentPreviewPath(file, patchPath) : null;
  const filePreviewRef = fileCommentPreviewRef(file, pullRequest);
  const patchQuery = useQuery({
    queryKey: [
      "overview-diff-preview-patch",
      pullRequest.repository.fullName,
      pullRequest.number,
      pullRequest.headSha,
      file?.path ?? patchPath
    ],
    enabled: Boolean(patchPath && file && !file.isLarge && !file.patch && !fileLevelLocation),
    queryFn: () =>
      krtClient.pullRequests.filePatch({
        repository: pullRequest.repository,
        number: pullRequest.number,
        path: file?.path ?? patchPath ?? "",
        headSha: pullRequest.headSha
    }),
    staleTime: 60_000
  });
  const filePreviewQuery = useQuery({
    queryKey: ["overview-file-comment-preview", pullRequest.repository.fullName, filePreviewRef, filePreviewPath],
    enabled: Boolean(fileLevelLocation && filePreviewPath && !file?.isLarge),
    queryFn: () =>
      krtClient.pullRequests.fileContent({
        repository: pullRequest.repository,
        path: filePreviewPath ?? "",
        ref: filePreviewRef
      }),
    staleTime: 60_000
  });
  const rawPatch = file?.patch ?? patchQuery.data?.patch;
  const preview = useMemo(() => buildDiffPreview(file, location, rawPatch), [file, location, rawPatch]);
  const diffRenderVersion = useDiffPreviewRenderVersion(preview?.fileDiff ?? null);
  if (!preview) {
    if (!patchPath) {
      return null;
    }
    if (fileLevelLocation) {
      return (
        <ThreadDiffPreviewShell
          file={file}
          historical={location.outdated}
          path={patchPath}
          onOpenFile={onOpenFile}
        >
          {filePreviewQuery.data && !filePreviewQuery.data.isLarge ? (
            <FileCommentPreview content={filePreviewQuery.data} language={file?.language} refName={filePreviewRef} />
          ) : (
            <div className="thread-diff-preview-empty">
              {filePreviewQuery.isLoading ? "Loading file preview" : "File preview unavailable"}
            </div>
          )}
        </ThreadDiffPreviewShell>
      );
    }
    if (!file && !location.diffHunk) {
      return null;
    }
    return (
      <ThreadDiffPreviewShell
        file={file}
        historical={location.outdated}
        line={displayLineForLocation(location)}
        path={patchPath}
        onOpenFile={onOpenFile}
      >
        <div className="thread-diff-preview-empty">
          {patchQuery.isLoading ? "Loading diff preview" : "Diff preview unavailable"}
        </div>
      </ThreadDiffPreviewShell>
    );
  }
  const viewKey = `${preview.fileDiff.cacheKey ?? preview.path}:${diffRenderVersion}`;

  return (
    <ThreadDiffPreviewShell
      file={file}
      historical={preview.historical}
      line={preview.line}
      path={preview.path}
      onOpenFile={onOpenFile}
    >
      <div className="thread-diff-preview-render">
        <DiffFileView
          key={viewKey}
          fileDiff={preview.fileDiff}
          disableWorkerPool={false}
          selectedLines={preview.selectedLines}
          options={{
            diffStyle: "unified",
            disableFileHeader: true,
            hunkSeparators: "simple",
            overflow: "scroll",
            tokenizeMaxLineLength: 360,
            tokenizeMaxLength: 80_000,
            unsafeCSS: THREAD_DIFF_PREVIEW_CSS,
            onPostRender: (node) => scrollPreviewLineIntoView(node, preview.line)
          }}
        />
      </div>
    </ThreadDiffPreviewShell>
  );
}

function FileCommentPreview({
  content,
  language,
  refName
}: {
  content: FileContent;
  language?: string;
  refName: string;
}): React.JSX.Element {
  const previewContents = firstFileLines(content.contents, FILE_COMMENT_PREVIEW_LINES);
  const codeFile = useMemo<FileContents>(
    () => ({
      name: content.path,
      contents: previewContents,
      lang: language,
      cacheKey: `${refName}:${content.path}:file-comment:${content.contents.length}:${FILE_COMMENT_PREVIEW_LINES}`
    }),
    [content.contents.length, content.path, language, previewContents, refName]
  );
  return (
    <div className="thread-diff-preview-render">
      <CodeFileView
        file={codeFile}
        disableWorkerPool
        options={{
          disableFileHeader: true,
          overflow: "scroll",
          tokenizeMaxLineLength: 360,
          tokenizeMaxLength: 20_000,
          unsafeCSS: THREAD_DIFF_PREVIEW_CSS
        }}
      />
    </div>
  );
}

function ThreadDiffPreviewShell({
  children,
  file,
  historical = false,
  line,
  path,
  onOpenFile
}: {
  children: React.ReactNode;
  file?: ChangedFile;
  historical?: boolean;
  line?: number;
  path: string;
  onOpenFile: (path: string, line?: number) => void;
}): React.JSX.Element {
  return (
    <div
      className="thread-diff-preview"
      aria-label={`Diff preview for ${path}${line ? ` line ${line}` : ""}`}
    >
      <button
        type="button"
        className="thread-diff-preview-head"
        title="Open in editor"
        aria-label={`Open ${path}${line ? ` line ${line}` : ""} in editor`}
        onClick={() => onOpenFile(path, line)}
      >
        <span className="mono">{path}</span>
        {line ? <span className="mono">:{line}</span> : null}
        {historical ? <span className="thread-diff-preview-badge">outdated</span> : null}
        {file ? (
          <span className="thread-diff-preview-counts mono">
            <span className="diff-counts-add">+{file.additions}</span>{" "}
            <span className="diff-counts-del">−{file.deletions}</span>
          </span>
        ) : null}
      </button>
      {children}
    </div>
  );
}

function mapChangedFilesByPath(files: ChangedFile[]): Map<string, ChangedFile> {
  const result = new Map<string, ChangedFile>();
  for (const file of files) {
    result.set(file.path, file);
    if (file.previousPath) {
      result.set(file.previousPath, file);
    }
  }
  return result;
}

function locationFromThread(thread: ReviewThread): DiffCommentLocation {
  const commentsNewestFirst = [...thread.comments].reverse();
  const latestLocatedComment =
    commentsNewestFirst.find((comment) => comment.diffHunk) ??
    commentsNewestFirst.find(
      (comment) =>
        comment.path ||
        comment.line ||
        comment.side ||
        comment.startLine ||
        comment.startSide ||
        comment.originalLine ||
        comment.originalStartLine
    );
  return {
    path: thread.path ?? latestLocatedComment?.path,
    line: thread.line ?? latestLocatedComment?.line,
    side: thread.side ?? latestLocatedComment?.side ?? "right",
    startLine: thread.startLine ?? latestLocatedComment?.startLine,
    startSide: thread.startSide ?? latestLocatedComment?.startSide,
    originalLine: thread.originalLine ?? latestLocatedComment?.originalLine,
    originalStartLine: thread.originalStartLine ?? latestLocatedComment?.originalStartLine,
    originalCommitId: latestLocatedComment?.originalCommitId,
    diffHunk: latestLocatedComment?.diffHunk,
    outdated: thread.outdated || latestLocatedComment?.outdated
  };
}

function locationFromActivityEvent(event: ActivityEvent): DiffCommentLocation {
  return {
    path: event.path,
    line: event.line,
    side: event.side ?? "right",
    startLine: event.startLine,
    startSide: event.startSide,
    originalLine: event.originalLine,
    originalStartLine: event.originalStartLine,
    originalCommitId: event.originalCommitId,
    diffHunk: event.diffHunk,
    outdated: event.outdated
  };
}

function buildDiffPreview(
  file: ChangedFile | undefined,
  location: DiffCommentLocation,
  rawPatch: string | undefined
): DiffPreviewData | null {
  if (!location.path) {
    return null;
  }
  const side = location.side ?? "right";
  if (file && rawPatch) {
    const renderablePatch = buildRenderablePreviewPatch(file, rawPatch);
    const scopedPreview = scopePatchToReviewLines(renderablePatch, location, DIFF_PREVIEW_CONTEXT_LINES);
    if (scopedPreview) {
      const preview = processPreviewPatch(scopedPreview.patch, {
        cacheKey: `overview-preview:${file.path}:${location.line ?? "file"}:${side}:${scopedPreview.patch.length}`,
        historical: false,
        line: location.line,
        location,
        path: location.path,
        selectedLines: scopedPreview.selectedLines,
        side
      });
      if (preview) {
        return preview;
      }
    }
  }

  const historicalPatch = buildHistoricalPreviewPatch(location.path, file, location.diffHunk);
  if (!historicalPatch) {
    return null;
  }
  const historicalLocation = originalLocationForPreview(location);
  const scopedHistoricalPreview = scopePatchToReviewLines(historicalPatch, historicalLocation, DIFF_PREVIEW_CONTEXT_LINES);
  const scopedHistoricalPatch = scopedHistoricalPreview?.patch ?? historicalPatch;
  return processPreviewPatch(scopedHistoricalPatch, {
    cacheKey: `overview-preview:historical:${location.path}:${historicalLocation.line ?? "file"}:${side}:${scopedHistoricalPatch.length}`,
    historical: true,
    line: historicalLocation.line,
    location: historicalLocation,
    path: location.path,
    selectedLines: scopedHistoricalPreview?.selectedLines ?? null,
    side
  });
}

function processPreviewPatch(
  patch: string,
  options: {
    cacheKey: string;
    historical: boolean;
    line?: number;
    location: DiffCommentLocation;
    path: string;
    selectedLines?: SelectedLineRange | null;
    side: "left" | "right";
  }
): DiffPreviewData | null {
  let fileDiff: FileDiffMetadata | null;
  try {
    fileDiff = processFile(patch, { cacheKey: options.cacheKey }) ?? null;
  } catch {
    return null;
  }
  if (!fileDiff) {
    return null;
  }
  const selectedLines = isPreviewSelectionRenderable(fileDiff, options.selectedLines ?? null)
    ? options.selectedLines ?? null
    : null;
  return {
    path: options.path,
    line: options.line,
    side: options.side,
    fileDiff,
    selectedLines,
    historical: options.historical
  };
}

function buildRenderablePreviewPatch(file: ChangedFile, patch: string): string {
  if (patch.startsWith("diff --git")) {
    return patch;
  }
  const fromPath = file.previousPath ?? file.path;
  const oldHeader = file.status === "added" ? "/dev/null" : `a/${fromPath}`;
  const newHeader = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
  return [`diff --git a/${fromPath} b/${file.path}`, `--- ${oldHeader}`, `+++ ${newHeader}`, patch].join("\n");
}

function buildHistoricalPreviewPatch(path: string, file: ChangedFile | undefined, diffHunk: string | undefined): string | null {
  const hunk = diffHunk?.trimEnd();
  if (!hunk) {
    return null;
  }
  if (hunk.startsWith("diff --git")) {
    return hunk;
  }
  const fromPath = file?.previousPath ?? path;
  const oldHeader = file?.status === "added" ? "/dev/null" : `a/${fromPath}`;
  const newHeader = file?.status === "removed" ? "/dev/null" : `b/${path}`;
  return [`diff --git a/${fromPath} b/${path}`, `--- ${oldHeader}`, `+++ ${newHeader}`, hunk].join("\n");
}

function originalLocationForPreview(location: DiffCommentLocation): DiffCommentLocation {
  return {
    ...location,
    line: location.originalLine ?? location.line,
    startLine: location.originalStartLine ?? location.startLine,
    outdated: true
  };
}

function displayLineForLocation(location: DiffCommentLocation): number | undefined {
  return location.line ?? location.originalLine;
}

function isFileLevelLocation(location: DiffCommentLocation): boolean {
  return !location.line && !location.originalLine && !location.startLine && !location.originalStartLine;
}

function fileCommentPreviewPath(file: ChangedFile | undefined, path: string): string {
  if (file?.status === "removed") {
    return file.previousPath ?? path;
  }
  return path;
}

function fileCommentPreviewRef(file: ChangedFile | undefined, pullRequest: PullRequestDetail): string {
  if (file?.status === "removed") {
    return pullRequest.baseSha ?? pullRequest.baseRef;
  }
  return pullRequest.headSha;
}

interface UnifiedHunk {
  startIndex: number;
  endIndex: number;
  oldStart: number;
  oldLength: number;
  newStart: number;
  newLength: number;
}

interface UnifiedDiffRow {
  raw: string;
  oldBefore: number;
  newBefore: number;
  oldLine?: number;
  newLine?: number;
}

interface ScopedPreviewPatch {
  patch: string;
  selectedLines: SelectedLineRange | null;
}

interface ReviewRowMatch {
  index: number;
  line: number;
  side: "left" | "right";
}

const DIFF_PREVIEW_CONTEXT_LINES = 2;
const FILE_COMMENT_PREVIEW_LINES = 2;

function firstFileLines(contents: string, lineCount: number): string {
  return contents.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").slice(0, lineCount).join("\n");
}

function scopePatchToReviewLines(
  patch: string,
  location: DiffCommentLocation,
  contextLines: number
): ScopedPreviewPatch | null {
  if (!location.line) {
    return null;
  }
  const lines = patch.split("\n");
  const hunks = parseUnifiedHunks(lines);
  if (hunks.length === 0) {
    return null;
  }
  const headerEndIndex = hunks[0]?.startIndex ?? 0;
  for (const hunk of hunks) {
    const rows = parseUnifiedRows(lines, hunk);
    const selection = selectReviewRowRange(rows, location);
    if (selection) {
      const startIndex = Math.max(0, selection.startIndex - contextLines);
      const endIndex = Math.min(rows.length - 1, selection.endIndex + contextLines);
      const scopedPatch = buildPatchFromRows(lines.slice(0, headerEndIndex), rows.slice(startIndex, endIndex + 1));
      if (!scopedPatch) {
        return null;
      }
      return {
        patch: scopedPatch,
        selectedLines: makePreviewSelection(
          selection.startLine,
          selection.endLine,
          selection.startSide,
          selection.endSide
        )
      };
    }
  }
  return null;
}

function buildPatchFromRows(headerLines: string[], rows: UnifiedDiffRow[]): string | null {
  if (rows.length === 0) {
    return null;
  }
  const oldLength = rows.filter((row) => row.oldLine !== undefined).length;
  const newLength = rows.filter((row) => row.newLine !== undefined).length;
  const oldStart = rows.find((row) => row.oldLine !== undefined)?.oldLine ?? Math.max(0, rows[0].oldBefore - 1);
  const newStart = rows.find((row) => row.newLine !== undefined)?.newLine ?? Math.max(0, rows[0].newBefore - 1);
  return [
    ...headerLines,
    `@@ -${formatHunkRange(oldStart, oldLength)} +${formatHunkRange(newStart, newLength)} @@`,
    ...rows.map((row) => row.raw)
  ].join("\n");
}

function selectReviewRowRange(
  rows: UnifiedDiffRow[],
  location: DiffCommentLocation
): {
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  startSide: "left" | "right";
  endSide: "left" | "right";
} | null {
  if (!location.line) {
    return null;
  }
  const endSide = location.side ?? "right";
  const startLine = location.startLine ?? location.line;
  const startSide = location.startSide ?? endSide;
  const startMatch = findReviewRowMatch(rows, startLine, startSide);
  const endMatch = findReviewRowMatch(rows, location.line, endSide);
  if (!startMatch || !endMatch) {
    return null;
  }
  return {
    startIndex: Math.min(startMatch.index, endMatch.index),
    endIndex: Math.max(startMatch.index, endMatch.index),
    startLine: startMatch.line,
    endLine: endMatch.line,
    startSide: startMatch.side,
    endSide: endMatch.side
  };
}

function findReviewRowMatch(rows: UnifiedDiffRow[], line: number, side: "left" | "right"): ReviewRowMatch | null {
  const exactIndex = rows.findIndex((row) => rowLineForSide(row, side) === line);
  if (exactIndex !== -1) {
    return { index: exactIndex, line, side };
  }
  const fallbackSide = side === "left" ? "right" : "left";
  const fallbackIndex = rows.findIndex((row) => rowLineForSide(row, fallbackSide) === line);
  if (fallbackIndex === -1) {
    return null;
  }
  return { index: fallbackIndex, line, side: fallbackSide };
}

function rowLineForSide(row: UnifiedDiffRow, side: "left" | "right"): number | undefined {
  return side === "left" ? row.oldLine : row.newLine;
}

function formatHunkRange(start: number, length: number): string {
  return length === 1 ? String(start) : `${start},${length}`;
}

function parseUnifiedRows(lines: string[], hunk: UnifiedHunk): UnifiedDiffRow[] {
  const rows: UnifiedDiffRow[] = [];
  let oldLine = hunk.oldStart;
  let newLine = hunk.newStart;
  for (let index = hunk.startIndex + 1; index < hunk.endIndex; index += 1) {
    const raw = lines[index] ?? "";
    if (raw.startsWith("\\ No newline")) {
      continue;
    }
    const marker = raw[0] ?? " ";
    const row: UnifiedDiffRow = {
      raw,
      oldBefore: oldLine,
      newBefore: newLine
    };
    if (marker === "+") {
      row.newLine = newLine;
      newLine += 1;
    } else if (marker === "-") {
      row.oldLine = oldLine;
      oldLine += 1;
    } else {
      row.oldLine = oldLine;
      row.newLine = newLine;
      oldLine += 1;
      newLine += 1;
    }
    rows.push(row);
  }
  return rows;
}

function parseUnifiedHunks(lines: string[]): UnifiedHunk[] {
  const hunks: UnifiedHunk[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index] ?? "");
    if (!match) {
      continue;
    }
    if (hunks.length > 0) {
      hunks[hunks.length - 1].endIndex = index;
    }
    hunks.push({
      startIndex: index,
      endIndex: lines.length,
      oldStart: Number(match[1]),
      oldLength: parseHunkLength(match[2]),
      newStart: Number(match[3]),
      newLength: parseHunkLength(match[4])
    });
  }
  return hunks;
}

function parseHunkLength(rawLength: string | undefined): number {
  if (rawLength === undefined) {
    return 1;
  }
  const parsed = Number(rawLength);
  return Number.isFinite(parsed) ? parsed : 0;
}

function makePreviewSelection(
  startLine: number | undefined,
  endLine: number | undefined,
  startSide: "left" | "right",
  endSide: "left" | "right"
): SelectedLineRange | null {
  if (!startLine || !endLine) {
    return null;
  }
  const selectionSide = startSide === "left" ? "deletions" : "additions";
  const selectionEndSide = endSide === "left" ? "deletions" : "additions";
  return { start: startLine, end: endLine, side: selectionSide, endSide: selectionEndSide };
}

function isPreviewSelectionRenderable(
  fileDiff: FileDiffMetadata,
  selection: SelectedLineRange | null
): selection is SelectedLineRange {
  if (!selection || fileDiff.hunks.length === 0) {
    return false;
  }
  return (
    isPreviewSelectionPointRenderable(fileDiff, selection.start, selection.side ?? "additions") &&
    isPreviewSelectionPointRenderable(fileDiff, selection.end, selection.endSide ?? selection.side ?? "additions")
  );
}

function isPreviewSelectionPointRenderable(
  fileDiff: FileDiffMetadata,
  line: number,
  side: "additions" | "deletions"
): boolean {
  for (const hunk of fileDiff.hunks) {
    let currentLine = side === "deletions" ? hunk.deletionStart : hunk.additionStart;
    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        if (line >= currentLine && line < currentLine + content.lines) {
          return true;
        }
        currentLine += content.lines;
      } else {
        const sideCount = side === "deletions" ? content.deletions : content.additions;
        if (line >= currentLine && line < currentLine + sideCount) {
          return true;
        }
        currentLine += sideCount;
      }
    }
  }
  return false;
}

function useDiffPreviewRenderVersion(target: FileDiffMetadata | null): number {
  const workerPool = useWorkerPool();
  const [renderVersion, setRenderVersion] = useState(0);
  const appliedCacheKeyRef = useRef<string | null>(null);
  const cacheKey = target?.cacheKey ?? null;

  useEffect(() => {
    appliedCacheKeyRef.current = null;
  }, [cacheKey]);

  useEffect(() => {
    if (!workerPool || !target || !cacheKey) {
      return undefined;
    }
    const hasHighlightedCache = (): boolean => workerPool.getDiffResultCache(target) != null;
    const applyHighlightedCache = (): void => {
      if (appliedCacheKeyRef.current === cacheKey || !hasHighlightedCache()) {
        return;
      }
      appliedCacheKeyRef.current = cacheKey;
      setRenderVersion((version) => version + 1);
    };

    applyHighlightedCache();
    return workerPool.subscribeToStatChanges(applyHighlightedCache);
  }, [cacheKey, target, workerPool]);

  return renderVersion;
}

function scrollPreviewLineIntoView(node: HTMLElement, line: number | undefined): void {
  if (!line) {
    return;
  }
  scheduleAfterRender(() => {
    const lineElement = node.shadowRoot?.querySelector(`[data-line="${line}"]`);
    if (lineElement instanceof HTMLElement) {
      lineElement.scrollIntoView({ block: "center", inline: "nearest" });
    }
  });
}

function scheduleAfterRender(callback: () => void): void {
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
    return;
  }
  window.setTimeout(callback, 0);
}

const THREAD_DIFF_PREVIEW_CSS = `
  [data-diffs-header] { display: none !important; }
  pre { font-size: 11.5px !important; line-height: 1.45 !important; }
`;

type ActivityTab = "discussion" | "bots" | "automation";

const ACTIVITY_TABS: Array<{ id: ActivityTab; label: string }> = [
  { id: "discussion", label: "Discussion" },
  { id: "bots", label: "Bot threads" },
  { id: "automation", label: "Automation" }
];

export interface ThreadItem {
  key: string;
  threadId?: string;
  /** Origin id used by the store to update reactions. Either a review comment id or a timeline event id. */
  reactionSourceId: string;
  reactionSourceKind: "review_comment" | "activity_event";
  reactionSubjectNodeId?: string;
  reactions: ReactionGroup[];
  author: Actor;
  isBot: boolean;
  createdAt: string;
  title?: string;
  body: string;
  codeLocation?: DiffCommentLocation;
  replies: ReviewComment[];
  resolved: boolean;
  resolvable: boolean;
}

export function threadItemFromReviewThread(
  thread: ReviewThread,
  options: { includeCodeLocation?: boolean } = {}
): ThreadItem | null {
  const first = thread.comments[0];
  if (!first) {
    return null;
  }
  return {
    key: `thread:${thread.id}`,
    threadId: thread.id,
    reactionSourceId: first.id,
    reactionSourceKind: "review_comment",
    reactionSubjectNodeId: first.id,
    reactions: first.reactions,
    author: first.author,
    isBot: first.isBot,
    createdAt: first.createdAt,
    body: first.body,
    codeLocation: options.includeCodeLocation ? locationFromThread(thread) : undefined,
    replies: thread.comments.slice(1),
    resolved: thread.resolved,
    resolvable: true
  };
}

function ActivitySection({ tab }: { tab: PrTab }): React.JSX.Element {
  const [activeTab, setActiveTab] = useState<ActivityTab>("discussion");
  const [hideResolved, setHideResolved] = useState(false);
  const openFileInTab = useUiStore((state) => state.openFileInTab);
  const setTabViewMode = useUiStore((state) => state.setTabViewMode);
  const changedFilesByPath = useMemo(
    () => mapChangedFilesByPath(tab.bundle.changedFiles),
    [tab.bundle.changedFiles]
  );
  const partitioned = useMemo(
    () => partitionActivity(tab.bundle.reviewThreads, tab.bundle.timeline),
    [tab.bundle.reviewThreads, tab.bundle.timeline]
  );
  const counts = {
    discussion: partitioned.discussion.length,
    bots: partitioned.bots.length,
    automation: partitioned.automation.length
  } as const;
  const openDiffLocation = useCallback(
    (path: string, line?: number) => {
      openFileInTab(tab.key, path, line);
      setTabViewMode(tab.key, "editor");
    },
    [openFileInTab, setTabViewMode, tab.key]
  );
  const currentThreads =
    activeTab === "discussion" ? partitioned.discussion : activeTab === "bots" ? partitioned.bots : [];
  const resolvedInTab = currentThreads.filter((item) => item.resolved).length;
  const showResolvedToggle = activeTab !== "automation" && resolvedInTab > 0;

  return (
    <section className="activity-section">
      <header className="activity-header">
        <span className="activity-label">Activity</span>
        <div className="activity-tabs" role="tablist" aria-label="Activity filters">
          {ACTIVITY_TABS.map((item) => (
            <ActivityTabBtn
              key={item.id}
              active={activeTab === item.id}
              onClick={() => setActiveTab(item.id)}
              icon={renderActivityTabIcon(item.id)}
              label={item.label}
              count={counts[item.id]}
            />
          ))}
        </div>
        <span className="activity-header-spacer" />
        {showResolvedToggle ? (
          <button
            type="button"
            className={hideResolved ? "activity-resolved-toggle is-on" : "activity-resolved-toggle"}
            onClick={() => setHideResolved((value) => !value)}
            title={hideResolved ? "Show resolved threads" : "Hide resolved threads"}
          >
            <span className="activity-resolved-box">
              {hideResolved ? <Check size={8} aria-hidden="true" /> : null}
            </span>
            <span>Hide resolved</span>
            <span className="activity-resolved-count">· {resolvedInTab}</span>
          </button>
        ) : null}
      </header>

      {activeTab === "automation" ? (
        <AutomationFeed events={partitioned.automation} />
      ) : (
        <ThreadList
          tabKey={tab.key}
          pullRequest={tab.bundle.detail}
          items={currentThreads}
          hideResolved={hideResolved}
          changedFilesByPath={changedFilesByPath}
          onOpenDiff={openDiffLocation}
          emptyMessage={
            activeTab === "discussion" ? "No discussion on this PR." : "No bot threads on this PR."
          }
        />
      )}
    </section>
  );
}

function renderActivityTabIcon(id: ActivityTab): React.JSX.Element {
  if (id === "discussion") return <MessageSquare size={11} aria-hidden="true" />;
  if (id === "bots") return <Bot size={11} aria-hidden="true" />;
  return <Cog size={11} aria-hidden="true" />;
}

interface ActivityTabBtnProps {
  active: boolean;
  onClick: () => void;
  icon: React.JSX.Element;
  label: string;
  count: number;
}

function ActivityTabBtn({ active, onClick, icon, label, count }: ActivityTabBtnProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={active ? "activity-tab is-active" : "activity-tab"}
      onClick={onClick}
    >
      {icon}
      <span className="activity-tab-label">{label}</span>
      <span className="activity-tab-count">{count}</span>
    </button>
  );
}

interface ThreadListProps {
  tabKey: string;
  pullRequest: PullRequestDetail;
  items: ThreadItem[];
  hideResolved: boolean;
  changedFilesByPath: Map<string, ChangedFile>;
  onOpenDiff: (path: string, line?: number) => void;
  emptyMessage: string;
}

function ThreadList({
  tabKey,
  pullRequest,
  items,
  hideResolved,
  changedFilesByPath,
  onOpenDiff,
  emptyMessage
}: ThreadListProps): React.JSX.Element {
  const visible = hideResolved ? items.filter((item) => !item.resolved) : items;
  if (items.length === 0) {
    return <div className="activity-empty">{emptyMessage}</div>;
  }
  if (visible.length === 0) {
    return <div className="activity-empty">All threads resolved.</div>;
  }
  return (
    <div className="thread-rail">
      <span className="thread-rail-line" aria-hidden="true" />
      {visible.map((item) => (
        <ThreadCard
          key={item.key}
          tabKey={tabKey}
          pullRequest={pullRequest}
          item={item}
          changedFilesByPath={changedFilesByPath}
          onOpenDiff={onOpenDiff}
        />
      ))}
    </div>
  );
}

export interface ThreadCardProps {
  tabKey: string;
  pullRequest: PullRequestDetail;
  item: ThreadItem;
  changedFilesByPath?: Map<string, ChangedFile>;
  onOpenDiff?: (path: string, line?: number) => void;
}

export function ThreadCard({
  tabKey,
  pullRequest,
  item,
  changedFilesByPath,
  onOpenDiff
}: ThreadCardProps): React.JSX.Element {
  const updateReviewThread = useUiStore((state) => state.updateReviewThread);
  const appendReviewThreadComment = useUiStore((state) => state.appendReviewThreadComment);
  const [collapsed, setCollapsed] = useState(item.resolved);
  const previousResolved = useRef(item.resolved);
  useEffect(() => {
    if (previousResolved.current !== item.resolved) {
      setCollapsed(item.resolved);
      previousResolved.current = item.resolved;
    }
  }, [item.resolved]);
  const [replyOpen, setReplyOpen] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");

  const resolveMutation = useMutation({
    mutationFn: () => {
      if (!item.threadId) {
        throw new Error("Thread is not resolvable");
      }
      const args = {
        repository: pullRequest.repository,
        number: pullRequest.number,
        threadId: item.threadId
      };
      return item.resolved ? krtClient.reviews.reopenThread(args) : krtClient.reviews.resolveThread(args);
    },
    onSuccess: (thread) => updateReviewThread(tabKey, thread)
  });
  const replyMutation = useMutation({
    mutationFn: () => {
      if (!item.threadId) {
        throw new Error("Thread is not resolvable");
      }
      return krtClient.comments.replyToReviewThread({
        repository: pullRequest.repository,
        number: pullRequest.number,
        threadId: item.threadId,
        body: replyDraft
      });
    },
    onSuccess: (comment) => {
      if (item.threadId) {
        appendReviewThreadComment(tabKey, item.threadId, comment);
      }
      setReplyDraft("");
      setReplyOpen(false);
    }
  });

  const submitReply = (): void => {
    if (!replyDraft.trim() || replyMutation.isPending) {
      return;
    }
    replyMutation.mutate();
  };

  const cardClass = `thread-card${item.isBot ? " is-bot" : ""}${
    collapsed ? " is-collapsed" : ""
  }${item.resolved ? " is-resolved" : ""}`;

  return (
    <article className={cardClass}>
      <ThreadAvatar author={item.author} isBot={item.isBot} />
      <div className="thread-card-body">
        <header className="thread-card-header">
          <button
            type="button"
            className="thread-collapse"
            onClick={() => setCollapsed((value) => !value)}
            aria-label={collapsed ? "Expand thread" : "Collapse thread"}
            title={collapsed ? "Expand" : "Collapse"}
          >
            {collapsed ? (
              <ChevronRight size={10} aria-hidden="true" />
            ) : (
              <ChevronDown size={10} aria-hidden="true" />
            )}
          </button>
          <span className="thread-author">{item.author.login}</span>
          {item.isBot ? <span className="thread-bot-tag mono">bot</span> : null}
          <span className="thread-action-text">
            {item.title ? item.title.toLowerCase() : "commented"}
          </span>
          <span className="thread-dot">·</span>
          <span className="thread-when">{formatDate(item.createdAt)}</span>
          {item.resolved ? (
            <span className="thread-resolved-chip">
              <Check size={8} aria-hidden="true" />
              <span>Resolved</span>
            </span>
          ) : null}
          {collapsed && !item.resolved && item.replies.length > 0 ? (
            <span className="thread-collapsed-meta">
              {item.replies.length} repl{item.replies.length === 1 ? "y" : "ies"}
            </span>
          ) : null}
          <span className="thread-header-spacer" />
          <ThreadMenu />
        </header>

        {collapsed ? null : (
          <>
            {item.codeLocation?.path && changedFilesByPath && onOpenDiff ? (
              <div className="thread-code-ref">
                <DiffCommentPreview
                  file={changedFilesByPath.get(item.codeLocation.path)}
                  location={item.codeLocation}
                  pullRequest={pullRequest}
                  onOpenFile={onOpenDiff}
                />
              </div>
            ) : null}
            {item.body ? (
              <div
                className="thread-body markdown"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(item.body) }}
              />
            ) : null}
            <ReactionBar
              tabKey={tabKey}
              pullRequest={pullRequest}
              sourceKind={item.reactionSourceKind}
              sourceId={item.reactionSourceId}
              subjectNodeId={item.reactionSubjectNodeId}
              reactions={item.reactions}
            />
            {item.replies.length > 0 ? (
              <ThreadReplies tabKey={tabKey} pullRequest={pullRequest} replies={item.replies} />
            ) : null}
            {item.resolvable ? (
              replyOpen ? (
                <div className="thread-reply-form">
                  <textarea
                    autoFocus
                    value={replyDraft}
                    placeholder={`Reply to ${item.author.login}…`}
                    onChange={(event) => setReplyDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                        event.preventDefault();
                        submitReply();
                      } else if (event.key === "Escape") {
                        setReplyOpen(false);
                        setReplyDraft("");
                      }
                    }}
                    rows={2}
                  />
                  <div className="thread-reply-form-row">
                    <span className="thread-reply-hint">Markdown · ⌘↵ to send · Esc to cancel</span>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setReplyOpen(false);
                        setReplyDraft("");
                      }}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!replyDraft.trim() || replyMutation.isPending}
                      onClick={submitReply}
                    >
                      Reply
                    </button>
                  </div>
                </div>
              ) : (
                <footer className="thread-card-footer">
                  <button
                    type="button"
                    className="thread-reply-trigger"
                    onClick={() => setReplyOpen(true)}
                  >
                    <MessageSquare size={12} aria-hidden="true" />
                    <span>Reply to this thread…</span>
                  </button>
                  <button
                    type="button"
                    className={
                      item.resolved ? "thread-resolve-btn" : "thread-resolve-btn is-resolve"
                    }
                    disabled={resolveMutation.isPending}
                    onClick={() => resolveMutation.mutate()}
                  >
                    {item.resolved ? "Reopen" : "Resolve"}
                  </button>
                </footer>
              )
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

function ThreadAvatar({ author, isBot }: { author: Actor; isBot: boolean }): React.JSX.Element {
  const initials = avatarInitials(author.login);
  const url = author.avatarUrl ?? githubAvatarUrl(author.login);
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);
  useEffect(() => {
    setLoaded(false);
    setErrored(false);
  }, [url]);
  const showImage = Boolean(url) && !errored;
  const showFallback = !showImage || !loaded;
  return (
    <span
      className={isBot ? "thread-avatar is-bot" : "thread-avatar"}
      aria-hidden="true"
      title={author.login}
    >
      {showImage && url ? (
        <img
          src={url}
          alt=""
          referrerPolicy="no-referrer"
          onLoad={() => setLoaded(true)}
          onError={() => setErrored(true)}
        />
      ) : null}
      {showFallback ? <span className="thread-avatar-fallback">{initials}</span> : null}
    </span>
  );
}

function ThreadReplies({
  tabKey,
  pullRequest,
  replies
}: {
  tabKey: string;
  pullRequest: PullRequestDetail;
  replies: ReviewComment[];
}): React.JSX.Element {
  return (
    <div className="thread-replies">
      {replies.map((reply) => (
        <div className="thread-reply" key={reply.id}>
          <ThreadAvatar author={reply.author} isBot={reply.isBot} />
          <div className="thread-reply-body">
            <div className="thread-reply-meta">
              <span className="thread-reply-author">{reply.author.login}</span>
              <span className="thread-reply-when">· {formatDate(reply.createdAt)}</span>
            </div>
            <div
              className="thread-reply-content markdown"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(reply.body) }}
            />
            <ReactionBar
              tabKey={tabKey}
              pullRequest={pullRequest}
              sourceKind="review_comment"
              sourceId={reply.id}
              subjectNodeId={reply.id}
              reactions={reply.reactions}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const REACTION_EMOJI: Record<ReactionContent, string> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀"
};

const REACTION_ORDER: ReactionContent[] = [
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes"
];

const REACTION_LABEL: Record<ReactionContent, string> = {
  "+1": "Thumbs up",
  "-1": "Thumbs down",
  laugh: "Laugh",
  hooray: "Hooray",
  confused: "Confused",
  heart: "Heart",
  rocket: "Rocket",
  eyes: "Eyes"
};

interface ReactionBarProps {
  tabKey: string;
  pullRequest: PullRequestDetail;
  sourceKind: "review_comment" | "activity_event";
  sourceId: string;
  subjectNodeId: string | undefined;
  reactions: ReactionGroup[];
}

function ReactionBar({
  tabKey,
  pullRequest,
  sourceKind,
  sourceId,
  subjectNodeId,
  reactions
}: ReactionBarProps): React.JSX.Element | null {
  const setReviewCommentReactions = useUiStore((state) => state.setReviewCommentReactions);
  const setActivityEventReactions = useUiStore((state) => state.setActivityEventReactions);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLSpanElement>(null);
  const canReact = Boolean(subjectNodeId);

  useEffect(() => {
    if (!pickerOpen) {
      return undefined;
    }
    const onDoc = (event: MouseEvent): void => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setPickerOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [pickerOpen]);

  const updateLocal = useCallback(
    (next: ReactionGroup[]) => {
      if (sourceKind === "review_comment") {
        setReviewCommentReactions(tabKey, sourceId, next);
      } else {
        setActivityEventReactions(tabKey, sourceId, next);
      }
    },
    [setReviewCommentReactions, setActivityEventReactions, sourceKind, sourceId, tabKey]
  );

  const mutation = useMutation({
    mutationFn: async (variables: { content: ReactionContent; add: boolean; previous: ReactionGroup[] }) => {
      if (!subjectNodeId) {
        throw new Error("Subject is not reactable.");
      }
      return krtClient.comments.toggleReaction({
        repository: pullRequest.repository,
        number: pullRequest.number,
        subjectNodeId,
        content: variables.content,
        add: variables.add
      });
    },
    onSuccess: (result) => updateLocal(result),
    onError: (_error, variables) => updateLocal(variables.previous)
  });

  const toggle = (content: ReactionContent): void => {
    if (!canReact || mutation.isPending) {
      return;
    }
    const existing = reactions.find((reaction) => reaction.content === content);
    const add = !existing?.viewerHasReacted;
    const previous = reactions;
    updateLocal(applyOptimisticReaction(reactions, content, add));
    mutation.mutate({ content, add, previous });
  };

  if (reactions.length === 0 && !canReact) {
    return null;
  }

  return (
    <div className="reactions-bar">
      {reactions.map((reaction) => (
        <button
          key={reaction.content}
          type="button"
          className={
            reaction.viewerHasReacted ? "reaction-chip is-active" : "reaction-chip"
          }
          onClick={() => toggle(reaction.content)}
          disabled={!canReact || mutation.isPending}
          title={
            reaction.viewerHasReacted
              ? `Remove your ${REACTION_LABEL[reaction.content].toLowerCase()} reaction`
              : `React with ${REACTION_LABEL[reaction.content].toLowerCase()}`
          }
        >
          <span className="reaction-emoji" aria-hidden="true">
            {REACTION_EMOJI[reaction.content]}
          </span>
          <span className="reaction-count">{reaction.count}</span>
        </button>
      ))}
      {canReact ? (
        <span className="reaction-picker-wrap" ref={pickerRef}>
          <button
            type="button"
            className={pickerOpen ? "reaction-add is-open" : "reaction-add"}
            onClick={() => setPickerOpen((value) => !value)}
            aria-label="Add reaction"
            title="Add reaction"
          >
            <Smile size={12} aria-hidden="true" />
            <Plus size={9} aria-hidden="true" className="reaction-add-plus" />
          </button>
          {pickerOpen ? (
            <div className="reaction-picker" role="menu" aria-label="Pick a reaction">
              {REACTION_ORDER.map((content) => (
                <button
                  key={content}
                  type="button"
                  className="reaction-picker-item"
                  onClick={() => {
                    setPickerOpen(false);
                    toggle(content);
                  }}
                  title={REACTION_LABEL[content]}
                  aria-label={REACTION_LABEL[content]}
                >
                  {REACTION_EMOJI[content]}
                </button>
              ))}
            </div>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function applyOptimisticReaction(
  current: ReactionGroup[],
  content: ReactionContent,
  add: boolean
): ReactionGroup[] {
  const existing = current.find((reaction) => reaction.content === content);
  if (existing) {
    if (add) {
      if (existing.viewerHasReacted) {
        return current;
      }
      return current.map((reaction) =>
        reaction.content === content
          ? { ...reaction, count: reaction.count + 1, viewerHasReacted: true }
          : reaction
      );
    }
    const nextCount = existing.count - 1;
    if (nextCount <= 0) {
      return current.filter((reaction) => reaction.content !== content);
    }
    return current.map((reaction) =>
      reaction.content === content
        ? { ...reaction, count: nextCount, viewerHasReacted: false }
        : reaction
    );
  }
  if (!add) {
    return current;
  }
  return [...current, { content, count: 1, viewerHasReacted: true }];
}

function ThreadMenu(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const onDoc = (event: MouseEvent): void => {
      if (!ref.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <span className="thread-menu" ref={ref}>
      <button
        type="button"
        className={open ? "thread-menu-trigger is-open" : "thread-menu-trigger"}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
        title="More"
        aria-label="More thread actions"
      >
        <MoreHorizontal size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="thread-menu-pop" role="menu">
          <button type="button" className="thread-menu-item" onClick={() => setOpen(false)}>
            <span>Copy link to thread</span>
            <span className="thread-menu-kbd mono">⌘L</span>
          </button>
          <button type="button" className="thread-menu-item" onClick={() => setOpen(false)}>
            <span>Quote reply</span>
          </button>
        </div>
      ) : null}
    </span>
  );
}

function AutomationFeed({ events }: { events: ActivityEvent[] }): React.JSX.Element {
  if (events.length === 0) {
    return <div className="activity-empty">No automation activity on this PR.</div>;
  }
  return (
    <div className="automation-feed">
      <span className="automation-feed-line" aria-hidden="true" />
      {events.map((event) => (
        <AutomationRow key={event.id} event={event} />
      ))}
    </div>
  );
}

function AutomationRow({ event }: { event: ActivityEvent }): React.JSX.Element {
  const meta = AUTOMATION_META[event.kind] ?? AUTOMATION_META.automation;
  const statusDot = automationStatusColor(event.severity);
  return (
    <div className={`automation-row automation-row-${event.kind}`}>
      <span className="automation-badge" style={{ color: meta.color }}>
        {meta.icon}
      </span>
      <div className="automation-card">
        {statusDot ? (
          <span
            className={
              event.severity === "warning" ? "automation-dot is-pulse" : "automation-dot"
            }
            style={{ background: statusDot }}
            aria-hidden="true"
          />
        ) : null}
        {event.actor ? <span className="automation-actor mono">{event.actor.login}</span> : null}
        <span className="automation-summary">{event.title}</span>
        {event.body ? (
          <span className="automation-detail" title={event.body}>
            {event.body}
          </span>
        ) : null}
        <span className="automation-when">{formatDate(event.createdAt)}</span>
      </div>
    </div>
  );
}

const AUTOMATION_META: Record<
  ActivityEvent["kind"],
  { color: string; icon: React.JSX.Element }
> = {
  check: { color: "var(--add)", icon: <Check size={11} aria-hidden="true" /> },
  bot: { color: "var(--accent)", icon: <Bot size={11} aria-hidden="true" /> },
  commit: { color: "var(--ink-3)", icon: <GitCommit size={11} aria-hidden="true" /> },
  label: { color: "var(--warn, oklch(0.7 0.15 75))", icon: <Tag size={11} aria-hidden="true" /> },
  automation: { color: "var(--accent-2)", icon: <Sparkles size={11} aria-hidden="true" /> },
  comment: { color: "var(--ink-3)", icon: <MessageSquare size={11} aria-hidden="true" /> },
  review: { color: "var(--ink-3)", icon: <Play size={11} aria-hidden="true" /> }
};

function automationStatusColor(severity: ActivityEvent["severity"]): string | null {
  if (severity === "success") return "var(--add)";
  if (severity === "warning") return "var(--warn, oklch(0.7 0.15 75))";
  if (severity === "failure") return "var(--del)";
  return null;
}

function partitionActivity(
  reviewThreads: ReviewThread[],
  timeline: ActivityEvent[]
): { discussion: ThreadItem[]; bots: ThreadItem[]; automation: ActivityEvent[] } {
  const discussion: ThreadItem[] = [];
  const bots: ThreadItem[] = [];
  const automation: ActivityEvent[] = [];

  for (const thread of reviewThreads) {
    const item = threadItemFromReviewThread(thread, { includeCodeLocation: true });
    if (!item) {
      continue;
    }
    if (item.isBot) {
      bots.push(item);
    } else {
      discussion.push(item);
    }
  }

  for (const event of timeline) {
    if (event.kind === "check" || event.kind === "commit" || event.kind === "label" || event.kind === "automation") {
      automation.push(event);
      continue;
    }
    if (event.id.startsWith("review-comment:")) {
      continue;
    }
    if (event.kind === "review" && !event.body?.trim()) {
      continue;
    }
    if (event.kind === "comment" || event.kind === "review" || event.kind === "bot") {
      const eventIsBot = event.kind === "bot" || isBotActor(event.actor);
      const item: ThreadItem = {
        key: `event:${event.id}`,
        reactionSourceId: event.id,
        reactionSourceKind: "activity_event",
        reactionSubjectNodeId: event.reactionSubject?.nodeId,
        reactions: event.reactions,
        author: event.actor ?? { login: "unknown" },
        isBot: eventIsBot,
        createdAt: event.createdAt,
        title: event.kind === "comment" ? undefined : event.title,
        body: event.body ?? event.title,
        codeLocation: event.path ? locationFromActivityEvent(event) : undefined,
        replies: [],
        resolved: false,
        resolvable: false
      };
      if (eventIsBot) {
        bots.push(item);
      } else {
        discussion.push(item);
      }
    }
  }

  discussion.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  bots.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  automation.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return { discussion, bots, automation };
}

function isBotActor(actor: Actor | undefined): boolean {
  if (!actor) {
    return false;
  }
  if (actor.type === "Bot") {
    return true;
  }
  return Boolean(actor.login && actor.login.endsWith("[bot]"));
}

function avatarInitials(login: string): string {
  const parts = login.replace(/[^a-zA-Z0-9]/g, " ").split(" ").filter(Boolean).slice(0, 2);
  if (parts.length === 0) {
    return "?";
  }
  return parts.map((part) => part[0]?.toUpperCase() ?? "").join("");
}
