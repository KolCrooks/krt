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
