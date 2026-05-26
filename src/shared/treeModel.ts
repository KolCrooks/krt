import type { ChangedFile } from "./schemas.js";

export interface ReviewTreeMetadata {
  path: string;
  gitStatus: ChangedFile["status"];
  reviewStatus: ChangedFile["reviewStatus"];
  annotations: number;
  diagnostics: number;
  isChangedInPr: true;
  isOpenInEditor: boolean;
}

export function changedFilesToTreePaths(files: readonly ChangedFile[]): string[] {
  return [...new Set(files.map((file) => file.path))].sort((left, right) => left.localeCompare(right));
}

export function orderChangedFilesDepthFirst(files: readonly ChangedFile[]): ChangedFile[] {
  return [...files].sort((left, right) => compareTreePathsDepthFirst(left.path, right.path));
}

export function changedFilesToMetadata(files: readonly ChangedFile[], openEditorPaths: readonly string[] = []): ReviewTreeMetadata[] {
  const openPaths = new Set(openEditorPaths);
  return files.map((file) => ({
    path: file.path,
    gitStatus: file.status,
    reviewStatus: file.reviewStatus,
    annotations: file.annotations,
    diagnostics: file.diagnostics,
    isChangedInPr: true,
    isOpenInEditor: openPaths.has(file.path)
  }));
}

function compareTreePathsDepthFirst(left: string, right: string): number {
  const leftSegments = splitPath(left);
  const rightSegments = splitPath(right);
  const maxLength = Math.max(leftSegments.length, rightSegments.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftSegment = leftSegments[index];
    const rightSegment = rightSegments[index];

    if (leftSegment == null) {
      return -1;
    }
    if (rightSegment == null) {
      return 1;
    }
    if (leftSegment === rightSegment) {
      continue;
    }

    const leftIsDirectory = index < leftSegments.length - 1;
    const rightIsDirectory = index < rightSegments.length - 1;
    if (leftIsDirectory !== rightIsDirectory) {
      return leftIsDirectory ? -1 : 1;
    }

    return leftSegment.localeCompare(rightSegment);
  }

  return left.localeCompare(right);
}

function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}
