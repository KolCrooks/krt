import { useQuery } from "@tanstack/react-query";
import { File, FileDiff as DiffFileView, useWorkerPool } from "@pierre/diffs/react";
import { processFile } from "@pierre/diffs";
import type { DiffLineAnnotation, FileContents, FileDiffMetadata, SelectedLineRange } from "@pierre/diffs";
import { AlertTriangle, ChevronDown, ChevronUp, FileCode2, MessageSquare, Pencil, Search, Sparkles, Trash2, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { krtClient } from "../../api/client.js";
import { useLspCodeInteractions } from "../../hooks/useLspCodeInteractions.js";
import { renderInlineMarkdown, renderMarkdown } from "../../lib/markdown.js";
import { buildDiffAnnotations, type DiffAnnotation } from "../../../shared/diffAnnotations.js";
import type { ChangedFile, ChangedFileStatus, PullRequestDetail, ReviewDraftComment, ReviewThread, TourChapter } from "../../../shared/schemas.js";
import { ThreadCard, threadItemFromReviewThread } from "../PullRequestOverview.js";
import { useUiStore } from "../../store/uiStore.js";

interface DiffSearchTarget extends SelectedLineRange {
  matchId?: string | null;
  matchStart?: number | null;
  matchLength?: number | null;
}

interface DiffPanelProps {
  pullRequest: PullRequestDetail;
  file: ChangedFile | null;
  layout?: "inline" | "split";
  reviewThreads?: ReviewThread[];
  tourChapters?: TourChapter[];
  searchTarget?: DiffSearchTarget | null;
  headerless?: boolean;
  enableLsp?: boolean;
  tabKey?: string;
  onOpenDefinition?: (path: string, line: number) => void;
}

const EMPTY_DRAFT_COMMENTS: [] = [];
const SEARCH_SCROLL_RETRY_FRAMES = 8;

interface DraftComposerAnnotation {
  id: "draft-composer";
  kind: "draft-composer";
  title: string;
  body: string;
  path: string;
  line: number;
  side: "left" | "right";
  status: "pending";
  range: SelectedLineRange;
}

type RenderableDiffAnnotation = DiffAnnotation | DraftComposerAnnotation;

export const DiffPanel = memo(function DiffPanel({
  pullRequest,
  file,
  layout = "inline",
  reviewThreads = [],
  tourChapters = [],
  searchTarget = null,
  headerless = false,
  enableLsp = false,
  tabKey,
  onOpenDefinition
}: DiffPanelProps): React.JSX.Element {
  const [largeLoadPath, setLargeLoadPath] = useState<string | null>(null);
  const [selectionTarget, setSelectionTarget] = useState<SelectedLineRange | null>(null);
  const [draftTarget, setDraftTarget] = useState<SelectedLineRange | null>(null);
  const [draftBody, setDraftBody] = useState("");
  const lastScrolledSearchTarget = useRef<string | null>(null);
  const diffContainerRef = useRef<HTMLElement | null>(null);
  const latestSearchScrollKey = useRef<string | null>(null);
  const addDraftReviewComment = useUiStore((state) => state.addDraftReviewComment);
  const draftComments = useUiStore((state) =>
    tabKey ? state.tabs.find((tab) => tab.key === tabKey)?.finish.comments ?? EMPTY_DRAFT_COMMENTS : EMPTY_DRAFT_COMMENTS
  );
  const shouldLoadLargeFile = Boolean(file && file.isLarge && largeLoadPath === file.path);
  const annotations = useMemo(
    () => (file ? buildDiffAnnotations({ filePath: file.path, reviewThreads, tourChapters, draftComments }) : []),
    [draftComments, file, reviewThreads, tourChapters]
  );
  const patchQuery = useQuery({
    queryKey: ["file-patch", pullRequest.repository.fullName, pullRequest.number, pullRequest.headSha, file?.path],
    enabled: Boolean(file && (!file.isLarge || shouldLoadLargeFile)),
    queryFn: () =>
      krtClient.pullRequests.filePatch({
        repository: pullRequest.repository,
        number: pullRequest.number,
        path: file?.path ?? "",
        headSha: pullRequest.headSha
      })
  });
  const lspInteractions = useLspCodeInteractions({
    enabled: Boolean(enableLsp && file && !file.isLarge),
    repository: pullRequest.repository,
    headSha: pullRequest.headSha,
    path: file?.path ?? null,
    onOpenDefinition
  });
  const fullContextQuery = useQuery({
    queryKey: [
      "file-diff-context",
      pullRequest.repository.fullName,
      pullRequest.number,
      pullRequest.baseSha ?? pullRequest.baseRef,
      pullRequest.headSha,
      file?.path,
      file?.previousPath,
      file?.status
    ],
    // Load full file context eagerly (for non-large files) so the diff library
    // can collapse unchanged regions into natively-expandable separators rather
    // than leaving gaps the user cannot open.
    enabled: Boolean(file && !file.isLarge),
    queryFn: () => loadFullDiffContext(pullRequest, file)
  });
  useEffect(() => {
    setSelectionTarget(null);
    setDraftTarget(null);
    setDraftBody("");
  }, [file?.path, pullRequest.headSha]);
  const patch = patchQuery.data?.patch ?? file?.patch ?? "";
  const renderablePatch = useMemo(() => (file && patch ? buildRenderablePatch(file, patch) : ""), [file, patch]);
  const patchDiffCacheKey = useMemo(
    () => (file && patch ? makePatchDiffCacheKey(pullRequest, file, patch) : ""),
    [
      file,
      patch,
      pullRequest.baseRef,
      pullRequest.baseSha,
      pullRequest.headSha,
      pullRequest.number,
      pullRequest.repository.fullName
    ]
  );
  const partialFileDiff = useMemo<FileDiffMetadata | null>(() => {
    if (!file || !renderablePatch || !patchDiffCacheKey) {
      return null;
    }
    try {
      return processFile(renderablePatch, { cacheKey: patchDiffCacheKey }) ?? null;
    } catch {
      return null;
    }
  }, [file, patchDiffCacheKey, renderablePatch]);
  const fullContextFileDiff = useMemo<FileDiffMetadata | null>(() => {
    if (!file || !renderablePatch || !patchDiffCacheKey || !fullContextQuery.data) {
      return null;
    }
    try {
      const candidate = processFile(renderablePatch, {
        cacheKey: `${patchDiffCacheKey}:full:${fullContextQuery.data.oldFile.cacheKey ?? ""}:${fullContextQuery.data.newFile.cacheKey ?? ""}`,
        oldFile: fullContextQuery.data.oldFile,
        newFile: fullContextQuery.data.newFile
      }) ?? null;
      return candidate && isRenderableFullContextDiff(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }, [file, fullContextQuery.data, patchDiffCacheKey, renderablePatch]);
  const activeFileDiff = fullContextFileDiff ?? partialFileDiff;
  const diffRenderVersion = useWorkerCacheRenderVersion("diff", activeFileDiff);
  const normalizeDraftRange = useCallback(
    (range: SelectedLineRange | null): SelectedLineRange | null => {
      if (!activeFileDiff) {
        return null;
      }
      if (!range) {
        return null;
      }
      return normalizeSelectedLineRange(activeFileDiff, range, layout);
    },
    [activeFileDiff, layout]
  );
  const handleDraftRange = useCallback(
    (range: SelectedLineRange | null, options?: { resetBody?: boolean }) => {
      const normalizedRange = normalizeDraftRange(range);
      setSelectionTarget(null);
      setDraftTarget(normalizedRange);
      if (options?.resetBody) {
        setDraftBody("");
      }
    },
    [normalizeDraftRange]
  );
  const handleSelectionStart = useCallback(
    (range: SelectedLineRange | null) => {
      setDraftTarget(null);
      setDraftBody("");
      setSelectionTarget(normalizeDraftRange(range));
    },
    [normalizeDraftRange]
  );
  const handleSelectionChange = useCallback(
    (range: SelectedLineRange | null) => {
      setSelectionTarget(normalizeDraftRange(range));
    },
    [normalizeDraftRange]
  );
  const handleSelectionEnd = useCallback(
    (range: SelectedLineRange | null) => {
      const normalizedRange = normalizeDraftRange(range);
      setSelectionTarget(null);
      setDraftTarget(normalizedRange);
    },
    [normalizeDraftRange]
  );
  const submitDraftComment = useCallback(() => {
    if (!tabKey || !file || !draftTarget || !draftBody.trim()) {
      return;
    }
    addDraftReviewComment(tabKey, reviewCommentFromSelectedRange(file.path, draftBody.trim(), draftTarget));
    setSelectionTarget(null);
    setDraftTarget(null);
    setDraftBody("");
  }, [addDraftReviewComment, draftBody, draftTarget, file, tabKey]);
  const renderAnnotation = useCallback(
    (annotation: DiffLineAnnotation<RenderableDiffAnnotation>) => {
      if (annotation.metadata.kind === "draft-composer") {
        return (
          <DraftReviewCommentComposer
            body={draftBody}
            path={annotation.metadata.path}
            range={annotation.metadata.range}
            onBodyChange={setDraftBody}
            onCancel={() => {
              setDraftTarget(null);
              setDraftBody("");
            }}
            onSubmit={submitDraftComment}
          />
        );
      }
      return (
        <InlineAnnotation
          annotation={annotation.metadata}
          tabKey={tabKey}
          pullRequest={pullRequest}
        />
      );
    },
    [draftBody, pullRequest, submitDraftComment, tabKey]
  );
  const lineAnnotations = useMemo<DiffLineAnnotation<RenderableDiffAnnotation>[]>(() => {
    const sourceAnnotations = annotations.flatMap((annotation) => toDiffLineAnnotation(annotation, activeFileDiff));
    const composerAnnotation = file && draftTarget
      ? toDiffLineAnnotation(makeDraftComposerAnnotation(file.path, draftBody, draftTarget), activeFileDiff)
      : [];
    return [...sourceAnnotations, ...composerAnnotation];
  }, [activeFileDiff, annotations, draftBody, draftTarget, file]);
  const searchScrollKey = searchTarget && file
    ? `${file.path}:${searchTarget.side ?? "additions"}:${searchTarget.start}:${searchTarget.end}:${searchTarget.matchId ?? ""}:${searchTarget.matchStart ?? ""}:${searchTarget.matchLength ?? ""}`
    : null;
  latestSearchScrollKey.current = searchScrollKey;
  const applySearchTarget = useCallback(
    (node: HTMLElement): boolean => {
      clearSearchTextHighlights(node);
      if (!searchTarget?.start || !searchScrollKey) {
        lastScrolledSearchTarget.current = null;
        return true;
      }
      highlightSearchTextMatch(node, searchTarget);
      if (lastScrolledSearchTarget.current === searchScrollKey) {
        return true;
      }
      if (scrollFileLineIntoView(node, searchTarget.start, searchTarget.side)) {
        lastScrolledSearchTarget.current = searchScrollKey;
        return true;
      }
      return false;
    },
    [searchScrollKey, searchTarget]
  );
  const scheduleSearchTargetApplication = useCallback(
    (node: HTMLElement, expectedKey: string | null, attempt = 0): void => {
      const scheduler = attempt === 0 ? scheduleAfterParentScroll : scheduleAfterRender;
      scheduler(() => {
        if (latestSearchScrollKey.current !== expectedKey) {
          return;
        }
        const applied = applySearchTarget(node);
        if (!applied && expectedKey && attempt < SEARCH_SCROLL_RETRY_FRAMES) {
          scheduleSearchTargetApplication(node, expectedKey, attempt + 1);
        }
      });
    },
    [applySearchTarget]
  );
  useEffect(() => {
    const node = diffContainerRef.current;
    if (!node) {
      return;
    }
    scheduleSearchTargetApplication(node, searchScrollKey);
  }, [scheduleSearchTargetApplication, searchScrollKey]);
  const patchView = useMemo(() => {
    if (!file || !patch) {
      return null;
    }
    const fileDiff = activeFileDiff;
    if (!fileDiff) {
      return null;
    }
    const activeSelectedLines = draftTarget ?? selectionTarget ?? searchTarget;
    const handlePostRender = (node: HTMLElement): void => {
      diffContainerRef.current = node;
      scheduleSearchTargetApplication(node, searchScrollKey);
    };
    const viewKey = `${fileDiff.cacheKey ?? file.path}:${diffRenderVersion}`;
    const commonOptions = {
      diffStyle: layout === "split" ? "split" as const : "unified" as const,
      overflow: "scroll" as const,
      tokenizeMaxLineLength: 600,
      tokenizeMaxLength: file.isLarge ? 0 : 250_000,
      unsafeCSS: headerless ? HEADERLESS_CSS : undefined,
      enableGutterUtility: Boolean(tabKey),
      enableLineSelection: Boolean(tabKey),
      lineHoverHighlight: "number" as const,
      onGutterUtilityClick: tabKey ? (range: SelectedLineRange) => handleDraftRange(range, { resetBody: true }) : undefined,
      onLineSelectionStart: tabKey ? handleSelectionStart : undefined,
      onLineSelectionChange: tabKey ? handleSelectionChange : undefined,
      onLineSelectionEnd: tabKey ? handleSelectionEnd : undefined,
      onPostRender: handlePostRender,
      ...lspInteractions.options
    };
    // Collapse unchanged regions into the library's native, expandable
    // "line-info" separators. When the full file context has loaded the gaps can
    // be opened; until then the patch's own context shows.
    return (
      <DiffFileView<RenderableDiffAnnotation>
        key={viewKey}
        fileDiff={fileDiff}
        disableWorkerPool={false}
        lineAnnotations={lineAnnotations}
        selectedLines={activeSelectedLines}
        renderAnnotation={renderAnnotation}
        renderHeaderPrefix={() => <StatusBadge status={file.status} />}
        renderHeaderMetadata={() => <ChangeCounts additions={file.additions} deletions={file.deletions} />}
        options={{
          ...commonOptions,
          expandUnchanged: false,
          hunkSeparators: "line-info"
        }}
      />
    );
  }, [
    activeFileDiff,
    diffRenderVersion,
    draftTarget,
    file,
    headerless,
    layout,
    lineAnnotations,
    lspInteractions.options,
    patch,
    scheduleSearchTargetApplication,
    searchScrollKey,
    searchTarget,
    selectionTarget,
    handleDraftRange,
    handleSelectionChange,
    handleSelectionEnd,
    handleSelectionStart,
    renderAnnotation
  ]);

  if (!file) {
    return <EmptyDiff />;
  }

  if (file.isLarge && !shouldLoadLargeFile) {
    return (
      <Fallback path={file.path} note={`Large file summary: ${file.additions} additions, ${file.deletions} deletions.`}>
        <button type="button" className="secondary-button" onClick={() => setLargeLoadPath(file.path)}>
          Load full diff
        </button>
      </Fallback>
    );
  }

  if (patchQuery.isLoading) {
    return <DiffSkeleton />;
  }
  if (patchQuery.isError || !patch) {
    return <Fallback path={file.path} note="Patch data is not available for this file." />;
  }
  if (!partialFileDiff) {
    return <Fallback path={file.path} note="Patch data could not be rendered for this file." />;
  }

  return (
    <div
      className="diff-surface"
      aria-label={annotations.length > 0 ? `Diff annotations for ${file.path}` : undefined}
      {...lspInteractions.surfaceProps}
    >
      {patchView}
      {lspInteractions.hoverCard}
    </div>
  );
});

function DraftReviewCommentComposer({
  body,
  path,
  range,
  onBodyChange,
  onCancel,
  onSubmit
}: {
  body: string;
  path: string;
  range: SelectedLineRange;
  onBodyChange: (body: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}): React.JSX.Element {
  return (
    <div className="draft-review-composer" role="dialog" aria-label="Draft review comment">
      <div className="draft-review-composer-head">
        <MessageSquare size={13} aria-hidden="true" />
        <span className="mono">{formatSelectedRange(path, range)}</span>
      </div>
      <textarea
        value={body}
        rows={4}
        autoFocus
        placeholder="Add a comment to this review..."
        aria-label="Review comment"
        onChange={(event) => onBodyChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            onSubmit();
          }
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <div className="draft-review-composer-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="primary-button" disabled={!body.trim()} onClick={onSubmit}>
          Add to review
        </button>
      </div>
    </div>
  );
}

interface CodeFilePanelProps {
  pullRequest: PullRequestDetail;
  path: string | null;
  active?: boolean;
  enableLsp?: boolean;
  targetLine?: number | null;
  navigationKey?: number | null;
  onOpenDefinition?: (path: string, line: number) => void;
}

const FILE_CONTENT_GC_TIME_MS = 60_000;

export const CodeFilePanel = memo(function CodeFilePanel({
  pullRequest,
  path,
  active = true,
  enableLsp = false,
  targetLine = null,
  navigationKey = null,
  onOpenDefinition
}: CodeFilePanelProps): React.JSX.Element {
  const lastScrolledTarget = useRef<string | null>(null);
  const fileContainerRef = useRef<HTMLElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [activeFindIndex, setActiveFindIndex] = useState(0);
  const fileQuery = useQuery({
    queryKey: ["file-content", pullRequest.repository.fullName, pullRequest.headSha, path],
    enabled: Boolean(path),
    queryFn: () =>
      krtClient.pullRequests.fileContent({
        repository: pullRequest.repository,
        path: path ?? "",
        ref: pullRequest.headSha
      }),
    gcTime: FILE_CONTENT_GC_TIME_MS
  });
  const codeFile = useMemo<FileContents | null>(() => {
    if (!path || !fileQuery.data) {
      return null;
    }
    return makeDiffFile(path, fileQuery.data.contents, pullRequest.headSha, undefined);
  }, [fileQuery.data, path, pullRequest.headSha]);
  const fileRenderVersion = useWorkerCacheRenderVersion("file", codeFile);
  const lspInteractions = useLspCodeInteractions({
    enabled: Boolean(active && enableLsp && path && !fileQuery.data?.isLarge),
    repository: pullRequest.repository,
    headSha: pullRequest.headSha,
    path,
    onOpenDefinition
  });
  const findMatches = useMemo(
    () => findFileMatches(fileQuery.data?.contents ?? "", findQuery),
    [fileQuery.data?.contents, findQuery]
  );
  const activeFindOrdinal = findMatches.length === 0 ? 0 : Math.min(activeFindIndex, findMatches.length - 1) + 1;
  const activeFindMatch = findOpen ? findMatches[activeFindIndex] ?? null : null;
  const activeLine = activeFindMatch?.lineNumber ?? normalizeTargetLine(targetLine);
  const activeScrollKey = activeFindMatch
    ? `${path ?? ""}:find:${findQuery}:${activeFindIndex}`
    : activeLine == null || !path
      ? null
      : `${path}:${activeLine}:${navigationKey ?? "current"}`;
  const selectedLines = useMemo<SelectedLineRange | null>(() => {
    return activeLine == null ? null : { start: activeLine, end: activeLine };
  }, [activeLine]);
  const scrollToActiveLine = useCallback(() => {
    if (activeLine == null || !activeScrollKey || !fileContainerRef.current) {
      lastScrolledTarget.current = null;
      return;
    }
    if (lastScrolledTarget.current === activeScrollKey) {
      return;
    }
    const node = fileContainerRef.current;
    scheduleAfterRender(() => {
      if (scrollFileLineIntoView(node, activeLine)) {
        lastScrolledTarget.current = activeScrollKey;
      }
    });
  }, [activeLine, activeScrollKey]);
  const handlePostRender = useCallback(
    (node: HTMLElement) => {
      fileContainerRef.current = node;
      scrollToActiveLine();
    },
    [scrollToActiveLine]
  );
  const openFind = useCallback(() => {
    setFindOpen(true);
    scheduleAfterRender(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    });
  }, []);
  const goToFindMatch = useCallback(
    (direction: 1 | -1) => {
      if (findMatches.length === 0) {
        return;
      }
      setActiveFindIndex((index) => (index + direction + findMatches.length) % findMatches.length);
    },
    [findMatches.length]
  );
  const onFindKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        event.preventDefault();
        goToFindMatch(event.shiftKey ? -1 : 1);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setFindOpen(false);
      }
    },
    [goToFindMatch]
  );
  useEffect(() => {
    setActiveFindIndex(0);
  }, [findQuery, path]);
  useEffect(() => {
    setActiveFindIndex((index) => (findMatches.length === 0 ? 0 : Math.min(index, findMatches.length - 1)));
  }, [findMatches.length]);
  useEffect(() => {
    if (findOpen) {
      scheduleAfterRender(() => findInputRef.current?.focus());
    }
  }, [findOpen]);
  useEffect(() => {
    scrollToActiveLine();
  }, [scrollToActiveLine]);
  useEffect(() => {
    if (!active || !path || !fileQuery.data) {
      return undefined;
    }
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        event.stopPropagation();
        openFind();
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [active, fileQuery.data, openFind, path]);
  const fileView = useMemo(() => {
    if (!codeFile || !path || !fileQuery.data) {
      return null;
    }
    return (
      <File
        key={`${codeFile.cacheKey ?? path}:${fileRenderVersion}`}
        file={codeFile}
        selectedLines={selectedLines}
        options={{
          overflow: "scroll",
          tokenizeMaxLineLength: 600,
          tokenizeMaxLength: fileQuery.data.isLarge ? 0 : 250_000,
          ...lspInteractions.options,
          onPostRender: handlePostRender
        }}
        disableWorkerPool={false}
      />
    );
  }, [codeFile, fileQuery.data, fileRenderVersion, handlePostRender, lspInteractions.options, path, selectedLines]);

  if (!path) {
    return <EmptyDiff />;
  }
  if (fileQuery.isLoading) {
    return <DiffSkeleton />;
  }
  if (fileQuery.isError || !fileQuery.data) {
    return <Fallback path={path} note="File content is unavailable in the current data mode." />;
  }

  return (
    <div className={findOpen ? "diff-surface has-file-find" : "diff-surface"} {...lspInteractions.surfaceProps}>
      {findOpen ? (
        <div className="file-find-bar" role="search" aria-label="Find in file">
          <Search size={13} aria-hidden="true" />
          <input
            ref={findInputRef}
            aria-label="Find in file"
            value={findQuery}
            onChange={(event) => setFindQuery(event.target.value)}
            onKeyDown={onFindKeyDown}
            placeholder="Find"
          />
          <span className="file-find-count mono">
            {findQuery ? `${activeFindOrdinal}/${findMatches.length}` : "0/0"}
          </span>
          <button type="button" className="icon-button file-find-button" aria-label="Previous match" onClick={() => goToFindMatch(-1)}>
            <ChevronUp size={13} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button file-find-button" aria-label="Next match" onClick={() => goToFindMatch(1)}>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
          <button type="button" className="icon-button file-find-button" aria-label="Close find" onClick={() => setFindOpen(false)}>
            <X size={13} aria-hidden="true" />
          </button>
        </div>
      ) : null}
      {fileView}
      {lspInteractions.hoverCard}
    </div>
  );
});

function EmptyDiff(): React.JSX.Element {
  return (
    <div className="diff-empty">
      <FileCode2 size={22} aria-hidden="true" />
      <span>No file selected</span>
    </div>
  );
}

interface FallbackProps {
  path: string;
  note: string;
  children?: React.ReactNode;
}

function Fallback({ path, note, children }: FallbackProps): React.JSX.Element {
  return (
    <div className="diff-fallback">
      <AlertTriangle size={18} aria-hidden="true" />
      <div>
        <strong>{path}</strong>
        <span>{note}</span>
      </div>
      {children}
    </div>
  );
}

function DiffSkeleton(): React.JSX.Element {
  return (
    <div className="diff-skeleton" aria-label="Loading diff">
      {Array.from({ length: 12 }).map((_, index) => (
        <div className="diff-skeleton-row" key={index}>
          <div className="skeleton diff-skeleton-gutter" />
          <div className={`skeleton diff-skeleton-line diff-skeleton-line-${index % 4}`} />
        </div>
      ))}
    </div>
  );
}

function normalizeTargetLine(line: number | null | undefined): number | null {
  if (line == null || !Number.isFinite(line) || line < 1) {
    return null;
  }
  return Math.floor(line);
}

function scheduleAfterRender(callback: () => void): void {
  if (typeof window.requestAnimationFrame === "function") {
    window.requestAnimationFrame(callback);
    return;
  }
  window.setTimeout(callback, 0);
}

function scheduleAfterParentScroll(callback: () => void): void {
  scheduleAfterRender(() => scheduleAfterRender(callback));
}

function scrollFileLineIntoView(container: HTMLElement, line: number, side?: "deletions" | "additions"): boolean {
  const lineElement = getDiffLineElement(container, line, side);
  if (!(lineElement instanceof HTMLElement)) {
    return false;
  }
  if (typeof lineElement.scrollIntoView !== "function") {
    return false;
  }
  lineElement.scrollIntoView({ block: "center", inline: "nearest", behavior: "auto" });
  return true;
}

function highlightSearchTextMatch(container: HTMLElement, target: DiffSearchTarget): boolean {
  const matchStart = normalizeMatchOffset(target.matchStart);
  const matchLength = normalizeMatchLength(target.matchLength);
  if (matchStart === null || matchLength === null) {
    return false;
  }
  const lineElement = getDiffLineElement(container, target.start, target.side);
  if (!(lineElement instanceof HTMLElement)) {
    return false;
  }
  return wrapTextRange(lineElement, matchStart, matchLength);
}

function getDiffLineElement(
  container: HTMLElement,
  line: number,
  side?: "deletions" | "additions"
): HTMLElement | null {
  const root = container.shadowRoot;
  if (!root) {
    return null;
  }
  const lineType = side === "deletions" ? "change-deletion" : side === "additions" ? "change-addition" : null;
  const selector = lineType ? `[data-line="${line}"][data-line-type="${lineType}"]` : `[data-line="${line}"]`;
  const sideMatch = root.querySelector(selector);
  if (sideMatch instanceof HTMLElement) {
    return sideMatch;
  }
  const fallback = root.querySelector(`[data-line="${line}"]`);
  return fallback instanceof HTMLElement ? fallback : null;
}

function clearSearchTextHighlights(container: HTMLElement): void {
  const root = container.shadowRoot;
  if (!root) {
    return;
  }
  const parents = new Set<ParentNode>();
  for (const mark of Array.from(root.querySelectorAll("mark[data-diff-search-text-match]"))) {
    const parent = mark.parentNode;
    if (!parent) {
      continue;
    }
    parents.add(parent);
    while (mark.firstChild) {
      parent.insertBefore(mark.firstChild, mark);
    }
    mark.remove();
  }
  for (const parent of parents) {
    parent.normalize();
  }
}

function wrapTextRange(container: HTMLElement, start: number, length: number): boolean {
  const end = start + length;
  const ranges: Array<{ node: Text; start: number; end: number }> = [];
  let offset = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.textContent) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (!parent || parent.closest("mark[data-diff-search-text-match]")) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    }
  });

  while (true) {
    const node = walker.nextNode();
    if (!(node instanceof Text)) {
      break;
    }
    const nodeLength = node.data.length;
    const nodeStart = offset;
    const nodeEnd = offset + nodeLength;
    const overlapStart = Math.max(start, nodeStart);
    const overlapEnd = Math.min(end, nodeEnd);
    if (overlapStart < overlapEnd) {
      ranges.push({
        node,
        start: overlapStart - nodeStart,
        end: overlapEnd - nodeStart
      });
    }
    offset = nodeEnd;
    if (offset >= end) {
      break;
    }
  }

  for (const range of ranges.reverse()) {
    wrapTextNodeRange(range.node, range.start, range.end);
  }
  return ranges.length > 0;
}

function wrapTextNodeRange(node: Text, start: number, end: number): void {
  const parent = node.parentNode;
  if (!parent || start >= end) {
    return;
  }
  const range = document.createRange();
  range.setStart(node, start);
  range.setEnd(node, end);
  const mark = document.createElement("mark");
  mark.setAttribute("data-diff-search-text-match", "");
  mark.style.background = "color-mix(in srgb, #facc15 70%, transparent)";
  mark.style.borderRadius = "2px";
  mark.style.boxShadow = "0 0 0 1px color-mix(in srgb, #b45309 35%, transparent)";
  mark.style.color = "inherit";
  mark.style.padding = "0 1px";
  range.surroundContents(mark);
  range.detach();
}

function normalizeMatchOffset(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return Math.floor(value);
}

function normalizeMatchLength(value: number | null | undefined): number | null {
  if (value == null || !Number.isFinite(value) || value < 1) {
    return null;
  }
  return Math.floor(value);
}

function buildRenderablePatch(file: ChangedFile, patch: string): string {
  if (patch.startsWith("diff --git")) {
    return patch;
  }
  const fromPath = file.previousPath ?? file.path;
  const oldHeader = file.status === "added" ? "/dev/null" : `a/${fromPath}`;
  const newHeader = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
  return [`diff --git a/${fromPath} b/${file.path}`, `--- ${oldHeader}`, `+++ ${newHeader}`, patch].join("\n");
}

function makePatchDiffCacheKey(pullRequest: PullRequestDetail, file: ChangedFile, patch: string): string {
  return [
    "patch",
    pullRequest.repository.fullName,
    pullRequest.number,
    pullRequest.baseSha ?? pullRequest.baseRef,
    pullRequest.headSha,
    file.previousPath ?? "",
    file.path,
    file.status,
    patch.length
  ].join(":");
}

interface FullDiffContext {
  oldFile: FileContents;
  newFile: FileContents;
}

async function loadFullDiffContext(pullRequest: PullRequestDetail, file: ChangedFile | null): Promise<FullDiffContext> {
  if (!file) {
    throw new Error("Cannot load diff context without a file.");
  }
  const oldPath = file.previousPath ?? file.path;
  const newPath = file.path;
  const language = file.language;
  const baseRef = pullRequest.baseSha ?? pullRequest.baseRef;
  const [oldContents, newContents] = await Promise.all([
    file.status === "added"
      ? Promise.resolve("")
      : krtClient.pullRequests
          .fileContent({
            repository: pullRequest.repository,
            path: oldPath,
            ref: baseRef
          })
          .then((content) => content.contents),
    file.status === "removed"
      ? Promise.resolve("")
      : krtClient.pullRequests
          .fileContent({
            repository: pullRequest.repository,
            path: newPath,
            ref: pullRequest.headSha
          })
          .then((content) => content.contents)
  ]);

  return {
    oldFile: makeDiffFile(oldPath, oldContents, baseRef, language),
    newFile: makeDiffFile(newPath, newContents, pullRequest.headSha, language)
  };
}

function makeDiffFile(name: string, contents: string, ref: string, language: string | undefined): FileContents {
  return {
    name,
    contents,
    lang: language,
    cacheKey: `${ref}:${name}:${contents.length}`
  };
}

function isRenderableFullContextDiff(fileDiff: FileDiffMetadata): boolean {
  if (fileDiff.isPartial) {
    return true;
  }

  let previousDeletionEnd = 0;
  let previousAdditionEnd = 0;

  for (const hunk of fileDiff.hunks) {
    if (
      hunk.deletionLineIndex < 0 ||
      hunk.additionLineIndex < 0 ||
      hunk.deletionLineIndex + hunk.deletionCount > fileDiff.deletionLines.length ||
      hunk.additionLineIndex + hunk.additionCount > fileDiff.additionLines.length
    ) {
      return false;
    }

    const deletionContextBefore = hunk.deletionLineIndex - previousDeletionEnd;
    const additionContextBefore = hunk.additionLineIndex - previousAdditionEnd;
    if (deletionContextBefore !== additionContextBefore) {
      return false;
    }

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        if (
          content.deletionLineIndex < 0 ||
          content.additionLineIndex < 0 ||
          content.deletionLineIndex + content.lines > fileDiff.deletionLines.length ||
          content.additionLineIndex + content.lines > fileDiff.additionLines.length
        ) {
          return false;
        }
        for (let index = 0; index < content.lines; index += 1) {
          if (fileDiff.deletionLines[content.deletionLineIndex + index] !== fileDiff.additionLines[content.additionLineIndex + index]) {
            return false;
          }
        }
      } else if (
        content.deletionLineIndex < 0 ||
        content.additionLineIndex < 0 ||
        content.deletionLineIndex + content.deletions > fileDiff.deletionLines.length ||
        content.additionLineIndex + content.additions > fileDiff.additionLines.length
      ) {
        return false;
      }
    }

    previousDeletionEnd = hunk.deletionLineIndex + hunk.deletionCount;
    previousAdditionEnd = hunk.additionLineIndex + hunk.additionCount;
  }

  return fileDiff.deletionLines.length - previousDeletionEnd === fileDiff.additionLines.length - previousAdditionEnd;
}

type WorkerCacheKind = "file" | "diff";

function useWorkerCacheRenderVersion(kind: WorkerCacheKind, target: FileContents | FileDiffMetadata | null): number {
  const workerPool = useWorkerPool();
  const [renderVersion, setRenderVersion] = useState(0);
  const appliedCacheKeyRef = useRef<string | null>(null);
  const cacheKey = target?.cacheKey ?? null;

  useEffect(() => {
    appliedCacheKeyRef.current = null;
  }, [cacheKey, kind]);

  useEffect(() => {
    if (!workerPool || !target || !cacheKey) {
      return undefined;
    }
    const renderKey = `${kind}:${cacheKey}`;
    const hasHighlightedCache = (): boolean => {
      if (kind === "file") {
        return workerPool.getFileResultCache(target as FileContents) != null;
      }
      return workerPool.getDiffResultCache(target as FileDiffMetadata) != null;
    };
    const applyHighlightedCache = (): void => {
      if (appliedCacheKeyRef.current === renderKey || !hasHighlightedCache()) {
        return;
      }
      appliedCacheKeyRef.current = renderKey;
      setRenderVersion((version) => version + 1);
    };

    applyHighlightedCache();
    return workerPool.subscribeToStatChanges(applyHighlightedCache);
  }, [cacheKey, kind, target, workerPool]);

  return renderVersion;
}

interface FileFindMatch {
  lineNumber: number;
  start: number;
  end: number;
}

function findFileMatches(contents: string, query: string): FileFindMatch[] {
  if (!query) {
    return [];
  }
  const needle = query.toLocaleLowerCase();
  const matches: FileFindMatch[] = [];
  const lines = contents.split(/\r\n|\r|\n/);
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const haystack = lines[lineIndex].toLocaleLowerCase();
    let start = haystack.indexOf(needle);
    while (start !== -1) {
      matches.push({ lineNumber: lineIndex + 1, start, end: start + query.length });
      start = haystack.indexOf(needle, start + Math.max(needle.length, 1));
    }
  }
  return matches;
}

function normalizeSelectedLineRange(
  fileDiff: FileDiffMetadata,
  range: SelectedLineRange,
  layout: "inline" | "split"
): SelectedLineRange | null {
  const startSide = normalizeSelectionSide(range.side);
  const endSide = normalizeSelectionSide(range.endSide ?? range.side);
  const startIndex = lineIndexForSelectionPoint(fileDiff, range.start, startSide, layout);
  const endIndex = lineIndexForSelectionPoint(fileDiff, range.end, endSide, layout);
  if (startIndex == null || endIndex == null) {
    return null;
  }
  if (startIndex <= endIndex) {
    return makeSelectedLineRange(range.start, startSide, range.end, endSide);
  }
  return makeSelectedLineRange(range.end, endSide, range.start, startSide);
}

function reviewCommentFromSelectedRange(path: string, body: string, range: SelectedLineRange): ReviewDraftComment {
  const startSide = selectionSideToReviewSide(normalizeSelectionSide(range.side));
  const endSide = selectionSideToReviewSide(normalizeSelectionSide(range.endSide ?? range.side));
  return {
    path,
    body,
    line: range.end,
    side: endSide,
    ...(range.start !== range.end || startSide !== endSide
      ? {
          startLine: range.start,
          startSide
        }
      : {})
  };
}

function makeSelectedLineRange(
  start: number,
  side: "additions" | "deletions",
  end: number,
  endSide: "additions" | "deletions"
): SelectedLineRange {
  return {
    start,
    end,
    side,
    ...(side !== endSide ? { endSide } : {})
  };
}

function normalizeSelectionSide(side: SelectedLineRange["side"]): "additions" | "deletions" {
  return side === "deletions" ? "deletions" : "additions";
}

function selectionSideToReviewSide(side: "additions" | "deletions"): "left" | "right" {
  return side === "deletions" ? "left" : "right";
}

function formatSelectedRange(path: string, range: SelectedLineRange): string {
  if (range.start === range.end) {
    return `${path}:${range.end}`;
  }
  return `${path}:${range.start}-${range.end}`;
}

function makeDraftComposerAnnotation(
  path: string,
  body: string,
  range: SelectedLineRange
): DraftComposerAnnotation {
  const endSide = selectionSideToReviewSide(normalizeSelectionSide(range.endSide ?? range.side));
  return {
    id: "draft-composer",
    kind: "draft-composer",
    title: "Draft review comment",
    body,
    path,
    line: range.end,
    side: endSide,
    status: "pending",
    range
  };
}

function lineIndexForSelectionPoint(
  fileDiff: FileDiffMetadata,
  lineNumber: number,
  side: "additions" | "deletions",
  layout: "inline" | "split"
): number | null {
  let targetUnifiedIndex: number | undefined;
  let targetSplitIndex: number | undefined;

  hunkIterator: for (const hunk of fileDiff.hunks) {
    let currentLineNumber = side === "deletions" ? hunk.deletionStart : hunk.additionStart;
    const hunkCount = side === "deletions" ? hunk.deletionCount : hunk.additionCount;
    let splitIndex = hunk.splitLineStart;
    let unifiedIndex = hunk.unifiedLineStart;

    if (lineNumber < currentLineNumber) {
      break hunkIterator;
    }

    if (lineNumber >= currentLineNumber + hunkCount) {
      continue;
    }

    for (const content of hunk.hunkContent) {
      if (content.type === "context") {
        if (lineNumber < currentLineNumber + content.lines) {
          const difference = lineNumber - currentLineNumber;
          targetUnifiedIndex = unifiedIndex + difference;
          targetSplitIndex = splitIndex + difference;
          break hunkIterator;
        }
        currentLineNumber += content.lines;
        splitIndex += content.lines;
        unifiedIndex += content.lines;
        continue;
      }

      const sideCount = side === "deletions" ? content.deletions : content.additions;
      if (lineNumber < currentLineNumber + sideCount) {
        const indexDifference = lineNumber - currentLineNumber;
        targetUnifiedIndex = unifiedIndex + (side === "additions" ? content.deletions : 0) + indexDifference;
        targetSplitIndex = splitIndex + indexDifference;
        break hunkIterator;
      }
      currentLineNumber += sideCount;
      splitIndex += Math.max(content.deletions, content.additions);
      unifiedIndex += content.deletions + content.additions;
    }
    break hunkIterator;
  }

  if (targetUnifiedIndex == null || targetSplitIndex == null) {
    return null;
  }
  return layout === "split" ? targetSplitIndex : targetUnifiedIndex;
}

function toDiffLineAnnotation<TAnnotation extends RenderableDiffAnnotation>(
  annotation: TAnnotation,
  fileDiff: FileDiffMetadata | null
): DiffLineAnnotation<TAnnotation>[] {
  const isAi = "kind" in annotation && annotation.kind === "ai";
  const side = annotation.side === "left" ? "deletions" : "additions";
  let line = annotation.line;

  // AI primer comments are model-anchored, so their line can be slightly off or
  // land on a line outside the rendered hunks. Rather than silently dropping
  // them (which makes the guided comments disappear), snap to the nearest
  // changed line in the diff so the comment still shows next to its region.
  if (!line) {
    if (!isAi || !fileDiff) {
      return [];
    }
    const snapped = nearestDiffLine(fileDiff, 1, side);
    if (snapped == null) {
      return [];
    }
    line = snapped;
  } else if (fileDiff && lineIndexForSelectionPoint(fileDiff, line, side, "inline") == null) {
    const snapped = isAi ? nearestDiffLine(fileDiff, line, side) : null;
    if (snapped == null) {
      return [];
    }
    line = snapped;
  }

  return [{ side, lineNumber: line, metadata: annotation } as unknown as DiffLineAnnotation<TAnnotation>];
}

// The closest line on the given side that actually appears in the diff, found
// by clamping into the nearest hunk's covered range. Returns null when the diff
// has no lines on that side.
function nearestDiffLine(fileDiff: FileDiffMetadata, line: number, side: "additions" | "deletions"): number | null {
  let best: number | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const hunk of fileDiff.hunks) {
    const start = side === "deletions" ? hunk.deletionStart : hunk.additionStart;
    const count = side === "deletions" ? hunk.deletionCount : hunk.additionCount;
    if (count <= 0) {
      continue;
    }
    const end = start + count - 1;
    const candidate = line < start ? start : line > end ? end : line;
    const distance = Math.abs(candidate - line);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best;
}

interface InlineAnnotationProps {
  annotation: DiffAnnotation;
  tabKey?: string;
  pullRequest: PullRequestDetail;
}

function InlineAnnotation({ annotation, tabKey, pullRequest }: InlineAnnotationProps): React.JSX.Element {
  const removeDraftReviewComment = useUiStore((state) => state.removeDraftReviewComment);
  const updateDraftReviewComment = useUiStore((state) => state.updateDraftReviewComment);
  const [isEditingDraft, setIsEditingDraft] = useState(false);
  const [editBody, setEditBody] = useState(annotation.body);
  if (annotation.kind === "review" && annotation.thread && tabKey) {
    const item = threadItemFromReviewThread(annotation.thread);
    if (item) {
      return (
        <div className="diff-anno diff-anno-review-thread">
          <ThreadCard tabKey={tabKey} pullRequest={pullRequest} item={item} />
        </div>
      );
    }
  }
  if (annotation.kind === "ai") {
    // Terse inline comment — reads like a code comment, color-coded by severity.
    const severity = annotation.severity && annotation.severity !== "info" ? annotation.severity : null;
    const range = annotation.line && annotation.endLine && annotation.endLine > annotation.line ? ` · lines ${annotation.line}–${annotation.endLine}` : "";
    return (
      <div className={`diff-anno diff-anno-ai diff-anno-note${severity ? ` diff-anno-sev-${severity}` : ""}`} title={`${annotation.title}${range}`}>
        <Sparkles size={11} aria-hidden="true" />
        <span className="diff-anno-note-text" dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(annotation.body) }} />
        {annotation.category ? <span className="diff-anno-cat">{annotation.category}</span> : null}
      </div>
    );
  }
  if (annotation.kind === "draft" && annotation.draftCommentId && tabKey && isEditingDraft) {
    const body = editBody.trim();
    return (
      <div className="diff-anno diff-anno-draft">
        <div className="diff-anno-head">
          <MessageSquare size={11} aria-hidden="true" />
          <strong>{annotation.title}</strong>
          <span className="diff-anno-status">{annotation.status}</span>
        </div>
        <textarea
          className="diff-anno-edit"
          value={editBody}
          rows={3}
          autoFocus
          aria-label="Draft review comment"
          onChange={(event) => setEditBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && body) {
              event.preventDefault();
              updateDraftReviewComment(tabKey, annotation.draftCommentId!, { body });
              setIsEditingDraft(false);
            }
            if (event.key === "Escape") {
              event.preventDefault();
              setEditBody(annotation.body);
              setIsEditingDraft(false);
            }
          }}
        />
        <div className="diff-anno-edit-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setEditBody(annotation.body);
              setIsEditingDraft(false);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={!body}
            onClick={() => {
              if (!annotation.draftCommentId || !body) {
                return;
              }
              updateDraftReviewComment(tabKey, annotation.draftCommentId, { body });
              setIsEditingDraft(false);
            }}
          >
            Save
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={`diff-anno diff-anno-${annotation.kind}`}>
      <div className="diff-anno-head">
        <MessageSquare size={11} aria-hidden="true" />
        <strong>{annotation.title}</strong>
        <span className="diff-anno-status">{annotation.status}</span>
        {annotation.kind === "draft" && annotation.draftCommentId && tabKey ? (
          <>
            <button
              type="button"
              className="icon-button diff-anno-action"
              aria-label="Edit draft comment"
              onClick={() => {
                setEditBody(annotation.body);
                setIsEditingDraft(true);
              }}
            >
              <Pencil size={11} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="icon-button diff-anno-action"
              aria-label="Delete draft comment"
              onClick={() => {
                if (annotation.draftCommentId) {
                  removeDraftReviewComment(tabKey, annotation.draftCommentId);
                }
              }}
            >
              <Trash2 size={11} aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
      <div className="markdown compact" dangerouslySetInnerHTML={{ __html: renderMarkdown(annotation.body) }} />
    </div>
  );
}

interface StatusBadgeProps {
  status: ChangedFileStatus;
}

function StatusBadge({ status }: StatusBadgeProps): React.JSX.Element {
  return <span className={`diff-status diff-status-${status}`}>{status}</span>;
}

interface ChangeCountsProps {
  additions: number;
  deletions: number;
}

function ChangeCounts({ additions, deletions }: ChangeCountsProps): React.JSX.Element {
  return (
    <span className="diff-counts">
      {additions > 0 ? <span className="diff-counts-add">+{additions}</span> : null}
      {deletions > 0 ? <span className="diff-counts-del">−{deletions}</span> : null}
    </span>
  );
}

export { StatusBadge as DiffStatusBadge, ChangeCounts as DiffChangeCounts };

const HEADERLESS_CSS = `[data-diffs-header] { display: none !important; }`;
