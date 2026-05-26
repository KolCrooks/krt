import { useQuery } from "@tanstack/react-query";
import { File, PatchDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { AlertTriangle, FileCode2, MessageSquare, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { krtClient } from "../../api/client.js";
import { buildDiffAnnotations, type DiffAnnotation } from "../../../shared/diffAnnotations.js";
import type { ChangedFile, ChangedFileStatus, PullRequestDetail, ReviewThread, TourChapter } from "../../../shared/schemas.js";

interface DiffPanelProps {
  pullRequest: PullRequestDetail;
  file: ChangedFile | null;
  layout?: "inline" | "split";
  reviewThreads?: ReviewThread[];
  tourChapters?: TourChapter[];
  headerless?: boolean;
}

export function DiffPanel({
  pullRequest,
  file,
  layout = "inline",
  reviewThreads = [],
  tourChapters = [],
  headerless = false
}: DiffPanelProps): React.JSX.Element {
  const [largeLoadPath, setLargeLoadPath] = useState<string | null>(null);
  const shouldLoadLargeFile = Boolean(file && file.isLarge && largeLoadPath === file.path);
  const annotations = useMemo(
    () => (file ? buildDiffAnnotations({ filePath: file.path, reviewThreads, tourChapters }) : []),
    [file, reviewThreads, tourChapters]
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

  const patch = patchQuery.data?.patch ?? file.patch ?? "";
  if (patchQuery.isLoading) {
    return <DiffSkeleton />;
  }
  if (patchQuery.isError || !patch) {
    return <Fallback path={file.path} note="Patch data is not available for this file." />;
  }

  const lineAnnotations = annotations.flatMap(toDiffLineAnnotation);

  return (
    <div
      className="diff-surface"
      aria-label={annotations.length > 0 ? `Diff annotations for ${file.path}` : undefined}
    >
      <PatchDiff<DiffAnnotation>
        patch={buildRenderablePatch(file, patch)}
        disableWorkerPool={false}
        lineAnnotations={lineAnnotations}
        renderAnnotation={(annotation) => <InlineAnnotation annotation={annotation.metadata} />}
        renderHeaderPrefix={() => <StatusBadge status={file.status} />}
        renderHeaderMetadata={() => <ChangeCounts additions={file.additions} deletions={file.deletions} />}
        options={{
          diffStyle: layout === "split" ? "split" : "unified",
          overflow: "scroll",
          tokenizeMaxLineLength: 600,
          tokenizeMaxLength: file.isLarge ? 0 : 250_000,
          unsafeCSS: headerless ? HEADERLESS_CSS : undefined
        }}
      />
    </div>
  );
}

interface CodeFilePanelProps {
  pullRequest: PullRequestDetail;
  path: string | null;
}

export function CodeFilePanel({ pullRequest, path }: CodeFilePanelProps): React.JSX.Element {
  const fileQuery = useQuery({
    queryKey: ["file-content", pullRequest.repository.fullName, pullRequest.headSha, path],
    enabled: Boolean(path),
    queryFn: () =>
      krtClient.pullRequests.fileContent({
        repository: pullRequest.repository,
        path: path ?? "",
        ref: pullRequest.headSha
      })
  });

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
    <div className="diff-surface">
      <File
        file={{ contents: fileQuery.data.contents, name: path }}
        options={{
          overflow: "scroll",
          tokenizeMaxLineLength: 600,
          tokenizeMaxLength: fileQuery.data.isLarge ? 0 : 250_000
        }}
        disableWorkerPool={false}
      />
    </div>
  );
}

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

function buildRenderablePatch(file: ChangedFile, patch: string): string {
  if (patch.startsWith("diff --git")) {
    return patch;
  }
  const fromPath = file.previousPath ?? file.path;
  const oldHeader = file.status === "added" ? "/dev/null" : `a/${fromPath}`;
  const newHeader = file.status === "removed" ? "/dev/null" : `b/${file.path}`;
  return [`diff --git a/${fromPath} b/${file.path}`, `--- ${oldHeader}`, `+++ ${newHeader}`, patch].join("\n");
}

function toDiffLineAnnotation(annotation: DiffAnnotation): DiffLineAnnotation<DiffAnnotation>[] {
  if (!annotation.line) {
    return [];
  }
  const side = annotation.side === "left" ? "deletions" : "additions";
  return [{ side, lineNumber: annotation.line, metadata: annotation }];
}

interface InlineAnnotationProps {
  annotation: DiffAnnotation;
}

function InlineAnnotation({ annotation }: InlineAnnotationProps): React.JSX.Element {
  const Icon = annotation.kind === "ai" ? Sparkles : MessageSquare;
  return (
    <div className={`diff-anno diff-anno-${annotation.kind}`}>
      <div className="diff-anno-head">
        <Icon size={11} aria-hidden="true" />
        <strong>{annotation.title}</strong>
        <span className="diff-anno-status">{annotation.status}</span>
      </div>
      <p>{annotation.body}</p>
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
