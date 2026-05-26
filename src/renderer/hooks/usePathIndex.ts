import { useEffect, useMemo, useState } from "react";
import { buildPathIndex, type PathIndexProgress, type PathIndexRequest, type PathIndexResult } from "../../shared/pathIndex.js";
import { krtClient } from "../api/client.js";

interface UsePathIndexOptions {
  workerThreshold?: number;
}

interface PathIndexHookResult extends PathIndexResult {
  isIndexing: boolean;
  indexingProgress: PathIndexProgress | null;
  usedWorker: boolean;
}

interface WorkerResponse {
  id: number;
  progress?: PathIndexProgress;
  result?: PathIndexResult;
  cancelled?: boolean;
  error?: string;
}

const emptyIndex: PathIndexResult = {
  paths: [],
  metadata: [],
  searchResults: [],
  totalFiles: 0,
  totalDirectories: 0,
  truncated: false
};

let requestId = 0;

export function usePathIndex(input: PathIndexRequest, options: UsePathIndexOptions = {}): PathIndexHookResult {
  const sourceCount = input.changedFiles?.length ?? input.paths?.length ?? 0;
  const workerThreshold = options.workerThreshold ?? 1_000;
  const shouldUseWorker = sourceCount >= workerThreshold && typeof Worker !== "undefined";
  const [workerResult, setWorkerResult] = useState<PathIndexResult | null>(null);
  const [indexingProgress, setIndexingProgress] = useState<PathIndexProgress | null>(null);

  const syncResult = useMemo(
    () => (shouldUseWorker ? null : buildPathIndex(input)),
    [input, shouldUseWorker]
  );

  useEffect(() => {
    if (!shouldUseWorker) {
      setWorkerResult(null);
      setIndexingProgress(null);
      return undefined;
    }

    const worker = createPathIndexWorker();
    if (!worker) {
      setWorkerResult(buildPathIndex(input));
      setIndexingProgress(null);
      return undefined;
    }

    const id = requestId + 1;
    requestId = id;
    let active = true;
    const startedAt = performance.now();
    setWorkerResult(null);
    setIndexingProgress(null);
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      if (!active || event.data.id !== id) {
        return;
      }
      if (event.data.progress) {
        setIndexingProgress(event.data.progress);
        return;
      }
      if (event.data.cancelled) {
        worker.terminate();
        return;
      }
      const result = event.data.result ?? buildPathIndex(input);
      setWorkerResult(result);
      setIndexingProgress(null);
      recordPathIndexPerformance(startedAt, input, result, true);
      worker.terminate();
    };
    worker.onerror = () => {
      if (!active) {
        return;
      }
      const result = buildPathIndex(input);
      setWorkerResult(result);
      setIndexingProgress(null);
      recordPathIndexPerformance(startedAt, input, result, false);
      worker.terminate();
    };
    worker.postMessage({ type: "index", id, input });

    return () => {
      active = false;
      setIndexingProgress(null);
      worker.postMessage({ type: "cancel", id });
      worker.terminate();
    };
  }, [input, shouldUseWorker]);

  const result = syncResult ?? workerResult ?? emptyIndex;
  return {
    ...result,
    isIndexing: shouldUseWorker && !workerResult,
    indexingProgress: shouldUseWorker ? indexingProgress : null,
    usedWorker: shouldUseWorker
  };
}

function recordPathIndexPerformance(
  startedAt: number,
  input: PathIndexRequest,
  result: PathIndexResult,
  usedWorker: boolean
): void {
  void krtClient.perf
    .record({
      name: "path.index",
      durationMs: Math.max(0, performance.now() - startedAt),
      metadata: {
        source: input.changedFiles ? "changedFiles" : "paths",
        sourceCount: input.changedFiles?.length ?? input.paths?.length ?? 0,
        totalFiles: result.totalFiles,
        totalDirectories: result.totalDirectories,
        searchResultCount: result.searchResults.length,
        truncated: result.truncated,
        usedWorker,
        query: Boolean(input.query)
      }
    })
    .catch(() => undefined);
}

function createPathIndexWorker(): Worker | null {
  try {
    return new Worker(new URL("../workers/pathIndex.worker.ts", import.meta.url), { type: "module" });
  } catch {
    return null;
  }
}
