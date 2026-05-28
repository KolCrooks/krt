import { useQuery } from "@tanstack/react-query";
import { File, FileDiff as DiffFileView, useWorkerPool } from "@pierre/diffs/react";
import { processFile } from "@pierre/diffs";
import type { DiffLineAnnotation, FileContents, FileDiffMetadata, HunkData, SelectedLineRange } from "@pierre/diffs";
import { AlertTriangle, ChevronDown, ChevronUp, FileCode2, MessageSquare, Search, Sparkles, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { krtClient } from "../../api/client.js";
import { useLspCodeInteractions } from "../../hooks/useLspCodeInteractions.js";
import { renderMarkdown } from "../../lib/markdown.js";
import { cropPatchToFocusRanges, type FocusRange } from "./cropPatch.js";
import { buildDiffAnnotations, type DiffAnnotation } from "../../../shared/diffAnnotations.js";
import type { ChangedFile, ChangedFileStatus, PullRequestDetail, ReviewDraftComment, ReviewThread, TourChapter } from "../../../shared/schemas.js";
import { ThreadCard, threadItemFromReviewThread } from "../PullRequestOverview.js";
import { useUiStore } from "../../store/uiStore.js";

interface DiffPanelProps {
  pullRequest: PullRequestDetail;
  file: ChangedFile | null;
  layout?: "inline" | "split";
  reviewThreads?: ReviewThread[];
  tourChapters?: TourChapter[];
  headerless?: boolean;
  enableLsp?: boolean;
  tabKey?: string;
  onOpenDefinition?: (path: string, line: number) => void;
  /** Crop the diff to only the hunks covered by tourChapters' diffAnchors for this file. */
  cropToChapters?: boolean;
}

const EMPTY_DRAFT_COMMENTS: [] = [];

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
  headerless = false,
  enableLsp = false,
  tabKey,
  onOpenDefinition,
  cropToChapters = false
}: DiffPanelProps): React.JSX.Element {
  const [largeLoadPath, setLargeLoadPath] = useState<string | null>(null);
  const [fullContextRequested, setFullContextRequested] = useState(false);
  const [selectionTarget, setSelectionTarget] = useState<SelectedLineRange | null>(null);
  const [draftTarget, setDraftTarget] = useState<SelectedLineRange | null>(null);
  const [draftBody, setDraftBody] = useState("");
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
    enabled: Boolean(file && fullContextRequested && !file.isLarge),
    queryFn: () => loadFullDiffContext(pullRequest, file)
  });
  useEffect(() => {
    setFullContextRequested(false);
  }, [file?.path, pullRequest.headSha]);
  useEffect(() => {
    setSelectionTarget(null);
    setDraftTarget(null);
    setDraftBody("");
  }, [file?.path, pullRequest.headSha]);
  const patch = patchQuery.data?.patch ?? file?.patch ?? "";
  const focusRanges = useMemo<FocusRange[]>(() => {
    if (!cropToChapters || !file) {
      return [];
    }
    const ranges: FocusRange[] = [];
    for (const chapter of tourChapters) {
      for (const anchor of chapter.diffAnchors) {
        if (anchor.path === file.path && anchor.startLine) {
          ranges.push({ start: anchor.startLine, end: anchor.endLine ?? anchor.startLine, side: anchor.side });
        }
      }
    }
    return ranges;
  }, [cropToChapters, file, tourChapters]);
  const focusKey = useMemo(() => focusRanges.map((range) => `${range.side}${range.start}-${range.end}`).join("|"), [focusRanges]);
  const renderablePatch = useMemo(() => {
    if (!file || !patch) {
      return "";
    }
    const base = buildRenderablePatch(file, patch);
    return focusRanges.length > 0 ? cropPatchToFocusRanges(base, focusRanges) : base;
  }, [file, patch, focusRanges]);
  const patchDiffCacheKey = useMemo(
    () => (file && patch ? `${makePatchDiffCacheKey(pullRequest, file, patch)}:focus:${focusKey}` : ""),
    [
      file,
      patch,
      focusKey,
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
      return processFile(renderablePatch, {
        cacheKey: `${patchDiffCacheKey}:full:${fullContextQuery.data.oldFile.cacheKey ?? ""}:${fullContextQuery.data.newFile.cacheKey ?? ""}`,
        oldFile: fullContextQuery.data.oldFile,
        newFile: fullContextQuery.data.newFile
      }) ?? null;
    } catch {
      return null;
    }
  }, [file, fullContextQuery.data, patchDiffCacheKey, renderablePatch]);
  const activeFileDiff = fullContextFileDiff ?? partialFileDiff;
  const diffRenderVersion = useWorkerCacheRenderVersion("diff", activeFileDiff);
  const renderPartialHunkSeparator = useCallback(
    (hunk: HunkData) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "diff-context-expander";
      button.disabled = fullContextQuery.isLoading;
      button.textContent = fullContextQuery.isLoading
        ? "Loading context"
        : fullContextQuery.isError
          ? "Retry context"
          : `Show ${hunk.lines} unchanged lines`;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setFullContextRequested(true);
        if (fullContextRequested && fullContextQuery.isError) {
          void fullContextQuery.refetch();
        }
      });
      return button;
    },
    [fullContextQuery.isError, fullContextQuery.isLoading, fullContextQuery.refetch, fullContextRequested]
  );
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
  const patchView = useMemo(() => {
    if (!file || !patch) {
      return null;
    }
    const fileDiff = activeFileDiff;
    if (!fileDiff) {
      return null;
    }
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
      ...lspInteractions.options
    };
    if (fullContextFileDiff) {
      return (
        <DiffFileView<RenderableDiffAnnotation>
          key={viewKey}
          fileDiff={fileDiff}
          disableWorkerPool={false}
          lineAnnotations={lineAnnotations}
          selectedLines={draftTarget ?? selectionTarget}
          renderAnnotation={renderAnnotation}
          renderHeaderPrefix={() => <StatusBadge status={file.status} />}
          renderHeaderMetadata={() => <ChangeCounts additions={file.additions} deletions={file.deletions} />}
          options={{
            ...commonOptions,
            expandUnchanged: true,
            hunkSeparators: "line-info"
          }}
        />
      );
    }
    return (
      <DiffFileView<RenderableDiffAnnotation>
        key={viewKey}
        fileDiff={fileDiff}
        disableWorkerPool={false}
        lineAnnotations={lineAnnotations}
        selectedLines={draftTarget ?? selectionTarget}
        renderAnnotation={renderAnnotation}
        renderHeaderPrefix={() => <StatusBadge status={file.status} />}
        renderHeaderMetadata={() => <ChangeCounts additions={file.additions} deletions={file.deletions} />}
        options={{
          ...commonOptions,
          hunkSeparators: renderPartialHunkSeparator
        }}
      />
    );
  }, [
    activeFileDiff,
    diffRenderVersion,
    draftTarget,
    file,
    fullContextFileDiff,
    headerless,
    layout,
    lineAnnotations,
    lspInteractions.options,
    patch,
    selectionTarget,
    handleDraftRange,
    handleSelectionChange,
    handleSelectionEnd,
    handleSelectionStart,
    renderPartialHunkSeparator,
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

function scrollFileLineIntoView(container: HTMLElement, line: number): boolean {
  const lineElement = container.shadowRoot?.querySelector(`[data-line="${line}"]`);
  if (!(lineElement instanceof HTMLElement)) {
    return false;
  }
  lineElement.scrollIntoView({ block: "center", inline: "nearest" });
  return true;
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
  if (!annotation.line) {
    return [];
  }
  const side = annotation.side === "left" ? "deletions" : "additions";
  if (fileDiff && lineIndexForSelectionPoint(fileDiff, annotation.line, side, "inline") == null) {
    return [];
  }
  return [{ side, lineNumber: annotation.line, metadata: annotation } as unknown as DiffLineAnnotation<TAnnotation>];
}

interface InlineAnnotationProps {
  annotation: DiffAnnotation;
  tabKey?: string;
  pullRequest: PullRequestDetail;
}

function InlineAnnotation({ annotation, tabKey, pullRequest }: InlineAnnotationProps): React.JSX.Element {
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
  const Icon = annotation.kind === "ai" ? Sparkles : MessageSquare;
  return (
    <div className={`diff-anno diff-anno-${annotation.kind}`}>
      <div className="diff-anno-head">
        <Icon size={11} aria-hidden="true" />
        <strong>{annotation.title}</strong>
        <span className="diff-anno-status">{annotation.status}</span>
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
