import type { ChangedFile } from "./schemas.js";
import { changedFilesToMetadata, type ReviewTreeMetadata } from "./treeModel.js";

export interface PathIndexRequest {
  paths?: readonly string[];
  changedFiles?: readonly ChangedFile[];
  openEditorPaths?: readonly string[];
  query?: string;
  maxResults?: number;
}

export interface PathIndexResult {
  paths: string[];
  metadata: ReviewTreeMetadata[];
  searchResults: string[];
  totalFiles: number;
  totalDirectories: number;
  truncated: boolean;
}

export interface PathIndexProgress {
  phase: "canonicalize" | "metadata" | "directories" | "search" | "complete";
  processed: number;
  total: number;
  percent: number;
}

export interface PathIndexBuildOptions {
  signal?: AbortSignal;
  onProgress?: (progress: PathIndexProgress) => void;
  yieldEvery?: number;
}

export function buildPathIndex(input: PathIndexRequest): PathIndexResult {
  const paths = canonicalizePaths(input.changedFiles?.map((file) => file.path) ?? input.paths ?? []);
  const metadata = input.changedFiles ? changedFilesToMetadata(input.changedFiles, input.openEditorPaths) : [];
  const directories = new Set<string>();

  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    for (let index = 1; index < segments.length; index += 1) {
      directories.add(segments.slice(0, index).join("/"));
    }
  }

  const { results: searchResults, truncated } = searchPaths(paths, input.query ?? "", input.maxResults ?? 100);

  return {
    paths,
    metadata,
    searchResults,
    totalFiles: paths.length,
    totalDirectories: directories.size,
    truncated
  };
}

export async function buildPathIndexAsync(
  input: PathIndexRequest,
  options: PathIndexBuildOptions = {}
): Promise<PathIndexResult> {
  const yieldEvery = Math.max(1, options.yieldEvery ?? 5_000);
  assertIndexingNotCancelled(options.signal);
  options.onProgress?.({ phase: "canonicalize", processed: 0, total: 1, percent: 0 });
  const paths = canonicalizePaths(input.changedFiles?.map((file) => file.path) ?? input.paths ?? []);
  assertIndexingNotCancelled(options.signal);
  options.onProgress?.({ phase: "canonicalize", processed: 1, total: 1, percent: 18 });
  await yieldToEventLoop();

  assertIndexingNotCancelled(options.signal);
  options.onProgress?.({ phase: "metadata", processed: 0, total: input.changedFiles ? 1 : 0, percent: 20 });
  const metadata = input.changedFiles ? changedFilesToMetadata(input.changedFiles, input.openEditorPaths) : [];
  assertIndexingNotCancelled(options.signal);
  options.onProgress?.({ phase: "metadata", processed: input.changedFiles ? 1 : 0, total: input.changedFiles ? 1 : 0, percent: 25 });
  await yieldToEventLoop();

  const directories = new Set<string>();
  for (let index = 0; index < paths.length; index += 1) {
    assertIndexingNotCancelled(options.signal);
    addDirectorySegments(directories, paths[index] ?? "");
    if ((index + 1) % yieldEvery === 0 || index === paths.length - 1) {
      options.onProgress?.({
        phase: "directories",
        processed: index + 1,
        total: paths.length,
        percent: progressPercent(index + 1, paths.length, 25, 65)
      });
      await yieldToEventLoop();
    }
  }

  const search = await searchPathsAsync(paths, input.query ?? "", input.maxResults ?? 100, {
    signal: options.signal,
    yieldEvery,
    onProgress: (processed, total) =>
      options.onProgress?.({
        phase: "search",
        processed,
        total,
        percent: progressPercent(processed, total, 65, 98)
      })
  });

  assertIndexingNotCancelled(options.signal);
  const result = {
    paths,
    metadata,
    searchResults: search.results,
    totalFiles: paths.length,
    totalDirectories: directories.size,
    truncated: search.truncated
  };
  options.onProgress?.({ phase: "complete", processed: paths.length, total: paths.length, percent: 100 });
  return result;
}

function canonicalizePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function addDirectorySegments(directories: Set<string>, path: string): void {
  const segments = path.split("/").filter(Boolean);
  for (let index = 1; index < segments.length; index += 1) {
    directories.add(segments.slice(0, index).join("/"));
  }
}

function searchPaths(paths: readonly string[], query: string, maxResults: number): { results: string[]; truncated: boolean } {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0 || maxResults <= 0) {
    return { results: [], truncated: false };
  }

  const results: string[] = [];
  let truncated = false;
  for (const path of paths) {
    const searchable = path.toLowerCase();
    if (!terms.every((term) => searchable.includes(term))) {
      continue;
    }
    if (results.length >= maxResults) {
      truncated = true;
      break;
    }
    results.push(path);
  }

  return { results, truncated };
}

async function searchPathsAsync(
  paths: readonly string[],
  query: string,
  maxResults: number,
  options: {
    signal?: AbortSignal;
    yieldEvery: number;
    onProgress?: (processed: number, total: number) => void;
  }
): Promise<{ results: string[]; truncated: boolean }> {
  const terms = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);

  if (terms.length === 0 || maxResults <= 0) {
    options.onProgress?.(paths.length, paths.length);
    return { results: [], truncated: false };
  }

  const results: string[] = [];
  let truncated = false;
  for (let index = 0; index < paths.length; index += 1) {
    assertIndexingNotCancelled(options.signal);
    const path = paths[index] ?? "";
    const searchable = path.toLowerCase();
    if (terms.every((term) => searchable.includes(term))) {
      if (results.length >= maxResults) {
        truncated = true;
        options.onProgress?.(index + 1, paths.length);
        break;
      }
      results.push(path);
    }
    if ((index + 1) % options.yieldEvery === 0 || index === paths.length - 1) {
      options.onProgress?.(index + 1, paths.length);
      await yieldToEventLoop();
    }
  }

  return { results, truncated };
}

function progressPercent(processed: number, total: number, start: number, end: number): number {
  if (total <= 0) {
    return end;
  }
  return Math.min(end, Math.max(start, start + ((end - start) * processed) / total));
}

function assertIndexingNotCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Path indexing was cancelled.", "AbortError");
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
